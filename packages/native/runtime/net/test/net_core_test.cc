// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Host tests for the net core: helpers, URLs + allowlist (NET-5), asset
// paths/MIME/reads (NET-1..4), the HTTP/1.1 client (NET-6) against loopback
// servers, and the RFC 6455 client (framing, handshake, close).

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <zlib.h>

#include <chrono>
#include <condition_variable>
#include <cstring>
#include <fstream>
#include <mutex>
#include <thread>

#include "iwn/net/assets.h"
#include "iwn/net/http.h"
#include "iwn/net/url.h"
#include "iwn/net/util.h"
#include "iwn/net/watchdog.h"
#include "iwn/net/websocket.h"
#include "iwn/net/zip_index.h"
#include "iwn_test.h"
#include "test_server.h"

using namespace iwn::net;

static std::string Hex(const uint8_t* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; ++i) {
    s.push_back(d[p[i] >> 4]);
    s.push_back(d[p[i] & 15]);
  }
  return s;
}

TEST(Sha1Vectors) {
  uint8_t out[20];
  Sha1(reinterpret_cast<const uint8_t*>("abc"), 3, out);
  CHECK_EQ(Hex(out, 20), std::string("a9993e364706816aba3e25717850c26c9cd0d89d"));
  Sha1(nullptr, 0, out);
  CHECK_EQ(Hex(out, 20), std::string("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
  std::string m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  Sha1(reinterpret_cast<const uint8_t*>(m.data()), m.size(), out);
  CHECK_EQ(Hex(out, 20), std::string("84983e441c3bd26ebaae4aa1f95129e5e54670f1"));
}

TEST(Base64AndAcceptKey) {
  CHECK_EQ(Base64Encode(""), std::string(""));
  CHECK_EQ(Base64Encode("f"), std::string("Zg=="));
  CHECK_EQ(Base64Encode("fo"), std::string("Zm8="));
  CHECK_EQ(Base64Encode("foobar"), std::string("Zm9vYmFy"));
  // RFC 6455 §1.3 example.
  CHECK_EQ(WsAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), std::string("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
}

TEST(Utf8Validation) {
  auto ok = [](const std::string& s) {
    Utf8Validator v;
    return v.Feed(reinterpret_cast<const uint8_t*>(s.data()), s.size()) && v.Complete();
  };
  CHECK(ok("hello"));
  CHECK(ok("\xC3\xBC"));
  CHECK(ok("\xF0\x9F\x98\x80"));
  CHECK(!ok("\xC0\xAF"));          // overlong
  CHECK(!ok("\xED\xA0\x80"));      // surrogate
  CHECK(!ok("\xF4\x90\x80\x80"));  // > U+10FFFF
  CHECK(!ok("\xC3"));              // truncated
  Utf8Validator split;
  CHECK(split.Feed(reinterpret_cast<const uint8_t*>("\xF0\x9F"), 2));
  CHECK(!split.Complete());
  CHECK(split.Feed(reinterpret_cast<const uint8_t*>("\x98\x80"), 2));
  CHECK(split.Complete());
}

TEST(UrlParse) {
  ParsedUrl u;
  CHECK(ParseUrl("https://cdn.jsdelivr.net/npm/x@1/a.glb?v=2#frag", &u));
  CHECK_EQ(u.scheme, std::string("https"));
  CHECK_EQ(u.host, std::string("cdn.jsdelivr.net"));
  CHECK_EQ(u.port, 443);
  CHECK_EQ(u.path_query, std::string("/npm/x@1/a.glb?v=2"));
  CHECK_EQ(u.HttpOrigin(), std::string("https://cdn.jsdelivr.net"));
  CHECK(ParseUrl("http://[::1]:8080", &u));
  CHECK_EQ(u.host, std::string("[::1]"));
  CHECK_EQ(u.port, 8080);
  CHECK_EQ(u.path_query, std::string("/"));
  CHECK(u.IsLoopback());
  CHECK(ParseUrl("wss://echo.example.com:443/s", &u));
  CHECK_EQ(u.HttpOrigin(), std::string("https://echo.example.com"));
  CHECK(ParseUrl("https://user:pw@x.com/", &u) && u.has_userinfo);
  CHECK(!ParseUrl("ftp://x.com/", &u));
  CHECK(!ParseUrl("https://x.com:0/", &u));
  CHECK(!ParseUrl("https://x .com/", &u));
}

TEST(RedirectResolution) {
  ParsedUrl base;
  ParseUrl("https://a.com/dir/page?q=1", &base);
  std::string out;
  CHECK(ResolveRedirect(base, "/x/../y", &out) && out == "https://a.com/y");
  CHECK(ResolveRedirect(base, "other", &out) && out == "https://a.com/dir/other");
  CHECK(ResolveRedirect(base, "../up?z", &out) && out == "https://a.com/up?z");
  CHECK(ResolveRedirect(base, "?only", &out) && out == "https://a.com/dir/page?only");
  CHECK(ResolveRedirect(base, "//b.com/p", &out) && out == "https://b.com/p");
  CHECK(ResolveRedirect(base, "http://c.com:81/p#f", &out) && out == "http://c.com:81/p");
  CHECK(!ResolveRedirect(base, "javascript:alert(1)", &out));
}

TEST(AllowlistMatching) {
  OriginAllowlist list;
  std::vector<std::string> rejected;
  list.Set({"https://cdn.jsdelivr.net", "https://*.example.com", "https://api.x.org:8443", "http://localhost:5173",
            "https://bad.com/path", "*", "https://*.com"},
           &rejected);
  CHECK_EQ(rejected.size(), size_t(3));
  auto verdict = [&](const char* url) {
    ParsedUrl u;
    ParseUrl(url, &u);
    return list.Check(u);
  };
  using V = OriginAllowlist::Verdict;
  CHECK(verdict("https://cdn.jsdelivr.net/x") == V::kAllowed);
  CHECK(verdict("https://cdn.jsdelivr.net:8443/x") == V::kNotListed);
  CHECK(verdict("https://a.example.com/") == V::kAllowed);
  CHECK(verdict("https://a.b.example.com/") == V::kAllowed);
  CHECK(verdict("https://example.com/") == V::kNotListed);
  CHECK(verdict("https://evilexample.com/") == V::kNotListed);
  CHECK(verdict("https://api.x.org:8443/") == V::kAllowed);
  CHECK(verdict("wss://a.example.com/socket") == V::kAllowed);
  // Cleartext: blocked in release builds, loopback-only in debug builds.
  CHECK(verdict("http://localhost:5173/") == V::kCleartextBlocked);
  list.SetDebugBuild(true);
  CHECK(verdict("http://localhost:5173/") == V::kAllowed);
  CHECK(verdict("ws://localhost:5173/") == V::kAllowed);
  CHECK(verdict("http://localhost:9999/") == V::kNotListed);
}

TEST(AssetPaths) {
  std::string rel;
  CHECK(AssetPathFromUrlPath("/", &rel) && rel == "index.html");
  CHECK(AssetPathFromUrlPath("/assets/a.js?v=1", &rel) && rel == "assets/a.js");
  CHECK(AssetPathFromUrlPath("/_app/x.js", &rel) && rel == "_app/x.js");
  CHECK(AssetPathFromUrlPath("/.well-known/y.json", &rel) && rel == ".well-known/y.json");
  CHECK(AssetPathFromUrlPath("/%C3%BC.txt", &rel) && rel == "\xC3\xBC.txt");
  CHECK(AssetPathFromUrlPath("/docs/", &rel) && rel == "docs/index.html");
  CHECK(!AssetPathFromUrlPath("/a/%2e%2e/b", &rel));
  CHECK(!AssetPathFromUrlPath("/a/%2Fetc", &rel));
  CHECK(!AssetPathFromUrlPath("/a/%00", &rel));
  CHECK(!AssetPathFromUrlPath("/a/%zz", &rel));
  CHECK(!AssetPathFromUrlPath("/../x", &rel));
}

TEST(MimeTable) {
  struct {
    const char* path;
    const char* type;
  } cases[] = {{"a.html", "text/html"}, {"a.js", "text/javascript"}, {"a.mjs", "text/javascript"},
               {"a.css", "text/css"}, {"a.json", "application/json"}, {"a.wasm", "application/wasm"},
               {"a.png", "image/png"}, {"a.JPG", "image/jpeg"}, {"a.jpeg", "image/jpeg"},
               {"a.webp", "image/webp"}, {"a.gif", "image/gif"}, {"a.svg", "image/svg+xml"},
               {"a.ktx2", "image/ktx2"}, {"a.basis", "application/octet-stream"},
               {"a.glb", "model/gltf-binary"}, {"a.gltf", "model/gltf+json"},
               {"a.bin", "application/octet-stream"}, {"a.hdr", "image/vnd.radiance"},
               {"a.exr", "image/x-exr"}, {"a.mp3", "audio/mpeg"}, {"a.ogg", "audio/ogg"},
               {"a.wav", "audio/wav"}, {"a.m4a", "audio/mp4"}, {"a.ttf", "font/ttf"},
               {"a.otf", "font/otf"}, {"a.woff2", "font/woff2"}, {"a.txt", "text/plain"},
               {"a.xyz", "application/octet-stream"}, {"noext", "application/octet-stream"}};
  for (auto& c : cases) CHECK_EQ(std::string(MimeTypeForPath(c.path)), std::string(c.type));
}

static std::string MakeTempDir() {
  char tmpl[] = "/tmp/iwn-net-test-XXXXXX";
  return mkdtemp(tmpl);
}

TEST(DirAssetSourceReads) {
  std::string root = MakeTempDir();
  mkdir((root + "/_app").c_str(), 0700);
  std::ofstream(root + "/_app/x.js") << "export default 1;";
  std::string big(3 * 1024 * 1024 + 7, '\0');
  for (size_t i = 0; i < big.size(); ++i) big[i] = static_cast<char>(i * 31);
  std::ofstream(root + "/big.bin", std::ios::binary).write(big.data(), static_cast<long>(big.size()));
  DirAssetSource src(root);
  std::unique_ptr<AssetBlob> blob;
  CHECK(src.Open("_app/x.js", &blob) == AssetStatus::kOk);
  CHECK_EQ(std::string(reinterpret_cast<char*>(blob->data()), blob->size()), std::string("export default 1;"));
  CHECK(!blob->mapped());
  CHECK(src.Open("big.bin", &blob) == AssetStatus::kOk);
  CHECK(blob->mapped());
  CHECK_EQ(blob->size(), big.size());
  CHECK(std::memcmp(blob->data(), big.data(), big.size()) == 0);
  blob->data()[0] ^= 0xFF;  // copy-on-write: must not crash or reach the file
  std::unique_ptr<AssetBlob> again;
  src.Open("big.bin", &again);
  CHECK(again->data()[0] == static_cast<uint8_t>(big[0]));
  CHECK(src.Open("missing.txt", &blob) == AssetStatus::kNotFound);
  CHECK(src.Open("_app", &blob) == AssetStatus::kNotFound);
  uint64_t size = 0;
  CHECK(src.Stat("big.bin", &size) == AssetStatus::kOk && size == big.size());
}

TEST(ResponseParserChunked) {
  HttpResponseParser p;
  p.Reset(false);
  std::string msg =
      "HTTP/1.1 100 Continue\r\n\r\n"
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-A: 1\r\nx-a: 2\r\n\r\n"
      "5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nTrailer: x\r\n\r\n";
  std::vector<uint8_t> body;
  // Feed one byte at a time to exercise every state boundary.
  for (char c : msg) p.Feed(reinterpret_cast<const uint8_t*>(&c), 1, &body);
  CHECK(p.state() == HttpResponseParser::State::kDone);
  CHECK_EQ(p.status(), 200);
  CHECK_EQ(std::string(body.begin(), body.end()), std::string("hello world"));
  CHECK_EQ(p.headers().size(), size_t(3));
  CHECK(p.keep_alive());
}

TEST(ResponseParserErrors) {
  auto parse = [](const std::string& msg, bool head = false) {
    HttpResponseParser p;
    p.Reset(head);
    std::vector<uint8_t> body;
    p.Feed(reinterpret_cast<const uint8_t*>(msg.data()), msg.size(), &body);
    return p;
  };
  CHECK(parse("HTTP/1.1 200 OK\r\nContent-Length: 3, 4\r\n\r\nabc").state() == HttpResponseParser::State::kError);
  CHECK(parse("HTTX/1.1 200 OK\r\n\r\n").state() == HttpResponseParser::State::kError);
  CHECK(parse("HTTP/1.1 200 OK\r\nBad Header: x\r\n\r\n").state() == HttpResponseParser::State::kError);
  CHECK(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").state() == HttpResponseParser::State::kError);
  auto p = parse("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc", true);
  CHECK(p.state() == HttpResponseParser::State::kDone);  // HEAD: no body
  auto q = parse("HTTP/1.0 200 OK\r\n\r\nuntil close");
  CHECK(q.state() == HttpResponseParser::State::kBody);
  CHECK(!q.keep_alive());
  q.OnEof();
  CHECK(q.state() == HttpResponseParser::State::kDone);
  auto r = parse("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc");
  r.OnEof();
  CHECK(r.state() == HttpResponseParser::State::kError);
}

// Collects listener calls; Wait() blocks until end or error.
struct Collector : HttpListener {
  std::mutex mu;
  std::condition_variable cv;
  HttpResponseHead head;
  bool got_head = false, ended = false;
  NetError error;
  std::string body;
  std::shared_ptr<HttpJob> job;  // for auto-ack
  bool auto_ack = true;
  size_t unacked = 0;  // data that arrived before `job` was set
  void OnHead(HttpResponseHead h) override {
    std::lock_guard<std::mutex> l(mu);
    head = std::move(h);
    got_head = true;
  }
  void OnData(std::vector<uint8_t> c) override {
    std::shared_ptr<HttpJob> j;
    {
      std::lock_guard<std::mutex> l(mu);
      body.append(c.begin(), c.end());
      j = job;
      if (!j) unacked += c.size();
    }
    if (auto_ack && j) j->Ack(c.size());
  }
  void OnEnd() override {
    std::lock_guard<std::mutex> l(mu);
    ended = true;
    cv.notify_all();
  }
  void OnError(NetError e) override {
    std::lock_guard<std::mutex> l(mu);
    error = std::move(e);
    cv.notify_all();
  }
  bool Wait(int ms = 5000) {
    std::unique_lock<std::mutex> l(mu);
    return cv.wait_for(l, std::chrono::milliseconds(ms), [&] { return ended || bool(error); });
  }
};

static std::shared_ptr<Collector> Fetch(HttpClient& client, HttpRequest req) {
  auto c = std::make_shared<Collector>();
  auto job = client.Start(std::move(req), c);  // may call back synchronously
  size_t pending;
  {
    std::lock_guard<std::mutex> l(c->mu);
    c->job = job;
    pending = c->unacked;
  }
  if (pending) job->Ack(pending);
  return c;
}

static std::unique_ptr<HttpClient> MakeClient(int port_allowed) {
  auto client = std::make_unique<HttpClient>(std::shared_ptr<Connector>(MakePosixConnector()));
  OriginAllowlist list;
  list.Set({"http://127.0.0.1:" + std::to_string(port_allowed)});
  list.SetDebugBuild(true);
  client->SetAllowlist(list);
  return client;
}

TEST(HttpGetKeepAliveAndHeaders) {
  std::mutex mu;
  std::vector<std::string> heads;
  TestServer server([&](int fd) {
    for (int i = 0; i < 2; ++i) {
      std::string head = TestServer::ReadHead(fd);
      if (head.empty()) return;
      {
        std::lock_guard<std::mutex> l(mu);
        heads.push_back(head);
      }
      TestServer::Send(fd, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=b\r\nContent-Length: 5\r\n\r\nhello");
    }
  });
  HttpClient client{std::shared_ptr<Connector>(MakePosixConnector())};
  OriginAllowlist list;
  list.Set({"http://127.0.0.1:" + std::to_string(server.port())});
  list.SetDebugBuild(true);
  client.SetAllowlist(list);
  for (int i = 0; i < 2; ++i) {
    HttpRequest req;
    req.url = server.url("http", "/a?x=1");
    req.headers = {{"X-Test", "1"}, {"Host", "evil"}, {"Cookie", "c=d"}};
    auto c = Fetch(client, req);
    CHECK(c->Wait());
    CHECK(!c->error);
    CHECK_EQ(c->head.status, 200);
    CHECK_EQ(c->body, std::string("hello"));
    bool has_cookie = false;
    for (auto& h : c->head.headers) has_cookie = has_cookie || h.first == "set-cookie";
    CHECK(!has_cookie);
    CHECK_EQ(c->head.headers[0].first, std::string("content-type"));
  }
  CHECK_EQ(server.accepted(), 1);  // second request reused the connection
  std::lock_guard<std::mutex> l(mu);
  CHECK_EQ(heads.size(), size_t(2));
  CHECK(heads[0].find("GET /a?x=1 HTTP/1.1\r\n") == 0);
  CHECK(heads[0].find("X-Test: 1\r\n") != std::string::npos);
  CHECK(heads[0].find("Host: 127.0.0.1:") != std::string::npos);
  CHECK(heads[0].find("evil") == std::string::npos);
  CHECK(heads[0].find("c=d") == std::string::npos);
  CHECK(heads[0].find("Accept-Encoding: gzip, deflate\r\n") != std::string::npos);
}

TEST(HttpBlockedOrigin) {
  HttpClient client{std::shared_ptr<Connector>(MakePosixConnector())};
  HttpRequest req;
  req.url = "https://not-listed.example/x";
  auto c = Fetch(client, req);
  CHECK(c->Wait());
  CHECK(c->error.kind == NetErrorKind::kBlocked);
  CHECK(c->error.message.find("native.network.allow") != std::string::npos);
}

TEST(HttpRedirects) {
  TestServer server([&](int fd) {
    for (;;) {
      std::string extra;
      std::string head = TestServer::ReadHead(fd, &extra);
      if (head.empty()) return;
      // Consume the request body so the next request on this connection parses cleanly.
      size_t cl_pos = head.find("Content-Length: ");
      size_t body_len = cl_pos == std::string::npos ? 0 : std::strtoul(head.c_str() + cl_pos + 16, nullptr, 10);
      while (extra.size() < body_len) {
        char c[16];
        ssize_t n = recv(fd, c, sizeof c, 0);
        if (n <= 0) return;
        extra.append(c, static_cast<size_t>(n));
      }
      if (head.find(" /post ") != std::string::npos) {
        TestServer::Send(fd, "HTTP/1.1 303 See Other\r\nLocation: /final\r\nContent-Length: 0\r\n\r\n");
      } else if (head.find(" /r307 ") != std::string::npos) {
        TestServer::Send(fd, "HTTP/1.1 307 Temporary\r\nLocation: final\r\nContent-Length: 3\r\n\r\nabc");
      } else if (head.find(" /loop ") != std::string::npos) {
        TestServer::Send(fd, "HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\n\r\n");
      } else if (head.find(" /away ") != std::string::npos) {
        TestServer::Send(fd, "HTTP/1.1 302 Found\r\nLocation: https://blocked.example/\r\nContent-Length: 0\r\n\r\n");
      } else {
        std::string method = head.substr(0, head.find(' '));
        bool has_body_header = head.find("Content-Type") != std::string::npos;
        std::string body = method + (has_body_header ? "+ct" : "");
        TestServer::Send(fd, "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
      }
    }
  });
  auto client_ptr = MakeClient(server.port());
  HttpClient& client = *client_ptr;
  {
    HttpRequest req;
    req.url = server.url("http", "/post");
    req.method = "POST";
    req.headers = {{"Content-Type", "text/plain"}};
    req.body = std::make_shared<std::vector<uint8_t>>(std::vector<uint8_t>{'d', 'a', 't', 'a'});
    auto c = Fetch(client, req);
    CHECK(c->Wait());
    CHECK(!c->error);
    CHECK_EQ(c->body, std::string("GET"));  // 303 → GET, body headers dropped
    CHECK(c->head.redirected);
    CHECK_EQ(c->head.url, server.url("http", "/final"));
  }
  {
    HttpRequest req;
    req.url = server.url("http", "/r307");
    req.method = "PUT";
    req.headers = {{"Content-Type", "text/plain"}};
    req.body = std::make_shared<std::vector<uint8_t>>(std::vector<uint8_t>{'x'});
    auto c = Fetch(client, req);
    CHECK(c->Wait());
    CHECK_EQ(c->body, std::string("PUT+ct"));  // 307 keeps method and body
  }
  {
    HttpRequest req;
    req.url = server.url("http", "/loop");
    auto c = Fetch(client, req);
    CHECK(c->Wait());
    CHECK(c->error.kind == NetErrorKind::kProtocol);
    CHECK(c->error.message.find("too many redirects") != std::string::npos);
  }
  {
    HttpRequest req;
    req.url = server.url("http", "/away");
    auto c = Fetch(client, req);
    CHECK(c->Wait());
    CHECK(c->error.kind == NetErrorKind::kBlocked);  // allowlist checked per hop
  }
  {
    HttpRequest req;
    req.url = server.url("http", "/loop");
    req.redirect = RedirectMode::kManual;
    auto c = Fetch(client, req);
    CHECK(c->Wait());
    CHECK(!c->error);
    CHECK(c->head.opaque_redirect);
  }
  {
    HttpRequest req;
    req.url = server.url("http", "/loop");
    req.redirect = RedirectMode::kError;
    auto c = Fetch(client, req);
    CHECK(c->Wait());
    CHECK(c->error.kind == NetErrorKind::kProtocol);
  }
}

TEST(HttpGzipChunkedAndFlowControl) {
  // 3 MB of gzip-compressed data sent chunked; the consumer acks slowly.
  std::string plain(3 << 20, 'z');
  for (size_t i = 0; i < plain.size(); i += 4096) plain[i] = static_cast<char>('a' + (i / 4096) % 26);
  // Compress with zlib's gzip wrapper.
  z_stream zs{};
  deflateInit2(&zs, 6, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY);
  std::string gz(deflateBound(&zs, plain.size()), '\0');
  zs.next_in = reinterpret_cast<Bytef*>(plain.data());
  zs.avail_in = static_cast<uInt>(plain.size());
  zs.next_out = reinterpret_cast<Bytef*>(gz.data());
  zs.avail_out = static_cast<uInt>(gz.size());
  deflate(&zs, Z_FINISH);
  gz.resize(zs.total_out);
  deflateEnd(&zs);
  TestServer server([&](int fd) {
    if (TestServer::ReadHead(fd).empty()) return;
    std::string out = "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n";
    for (size_t i = 0; i < gz.size(); i += 1000) {
      size_t n = std::min<size_t>(1000, gz.size() - i);
      char hex[16];
      snprintf(hex, sizeof hex, "%zx\r\n", n);
      out += hex + gz.substr(i, n) + "\r\n";
    }
    out += "0\r\n\r\n";
    TestServer::Send(fd, out);
  });
  auto client_ptr = MakeClient(server.port());
  HttpClient& client = *client_ptr;
  HttpRequest req;
  req.url = server.url("http", "/big");
  auto c = Fetch(client, req);
  CHECK(c->Wait(10000));
  CHECK(!c->error);
  CHECK_EQ(c->body.size(), plain.size());
  CHECK(c->body == plain);
}

TEST(HttpAbortAndTimeout) {
  TestServer server([&](int fd) {
    TestServer::ReadHead(fd);
    std::this_thread::sleep_for(std::chrono::milliseconds(800));
  });
  auto client_ptr = MakeClient(server.port());
  HttpClient& client = *client_ptr;
  {
    HttpRequest req;
    req.url = server.url("http", "/slow");
    auto c = Fetch(client, req);
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    c->job->Abort();
    CHECK(c->Wait(2000));
    CHECK(c->error.kind == NetErrorKind::kAborted);
  }
  {
    HttpRequest req;
    req.url = server.url("http", "/slow");
    req.timeout_ms = 200;
    auto c = Fetch(client, req);
    CHECK(c->Wait(2000));
    CHECK(c->error.kind == NetErrorKind::kTimeout);
  }
}

TEST(HttpConnectionRefusedAndTls) {
  int port;
  {
    TestServer s([](int) {});
    port = s.port();
  }
  auto client_ptr = MakeClient(port);
  HttpClient& client = *client_ptr;
  HttpRequest req;
  req.url = "http://127.0.0.1:" + std::to_string(port) + "/";
  auto c = Fetch(client, req);
  CHECK(c->Wait());
  CHECK(c->error.kind == NetErrorKind::kConnect);
  OriginAllowlist list;
  list.Set({"https://127.0.0.1:" + std::to_string(port)});
  client.SetAllowlist(list);
  req.url = "https://127.0.0.1:" + std::to_string(port) + "/";
  auto t = Fetch(client, req);
  CHECK(t->Wait());
  CHECK(t->error.kind == NetErrorKind::kUnsupported);  // no TLS in the host connector
}

TEST(HttpForbiddenMethod) {
  HttpClient client{std::shared_ptr<Connector>(MakePosixConnector())};
  HttpRequest req;
  req.url = "http://127.0.0.1:1/";
  req.method = "TRACE";
  auto c = Fetch(client, req);
  CHECK(c->Wait());
  CHECK(c->error.kind == NetErrorKind::kProtocol);
}

// --- WebSocket -----------------------------------------------------------

TEST(WsFrameEncodeDecode) {
  std::string payload(70000, 'x');
  auto frame = WsEncodeFrame(kWsBinary, true, reinterpret_cast<const uint8_t*>(payload.data()), payload.size(), false);
  CHECK_EQ(frame[1], uint8_t(127));
  WsFrameDecoder d;
  std::vector<WsFrameDecoder::Event> ev;
  d.Feed(frame.data(), frame.size(), &ev);
  CHECK_EQ(ev.size(), size_t(1));
  CHECK(ev[0].type == WsFrameDecoder::Event::kMessage && !ev[0].text && ev[0].payload.size() == 70000);
  // Masked frames from a server are a protocol error.
  auto masked = WsEncodeFrame(kWsText, true, reinterpret_cast<const uint8_t*>("hi"), 2, true);
  WsFrameDecoder d2;
  ev.clear();
  d2.Feed(masked.data(), masked.size(), &ev);
  CHECK(ev.size() == 1 && ev[0].type == WsFrameDecoder::Event::kError && ev[0].close_code == 1002);
  // Fragmented text split inside a code point, with an interleaved ping.
  std::vector<uint8_t> stream;
  auto a = WsEncodeFrame(kWsText, false, reinterpret_cast<const uint8_t*>("h\xF0\x9F"), 3, false);
  auto p = WsEncodeFrame(kWsPing, true, reinterpret_cast<const uint8_t*>("p"), 1, false);
  auto b = WsEncodeFrame(kWsContinuation, true, reinterpret_cast<const uint8_t*>("\x98\x80"), 2, false);
  stream.insert(stream.end(), a.begin(), a.end());
  stream.insert(stream.end(), p.begin(), p.end());
  stream.insert(stream.end(), b.begin(), b.end());
  WsFrameDecoder d3;
  ev.clear();
  for (uint8_t byte : stream) d3.Feed(&byte, 1, &ev);
  CHECK_EQ(ev.size(), size_t(2));
  CHECK(ev[0].type == WsFrameDecoder::Event::kPing);
  CHECK(ev[1].type == WsFrameDecoder::Event::kMessage && ev[1].text);
  CHECK_EQ(std::string(ev[1].payload.begin(), ev[1].payload.end()), std::string("h\xF0\x9F\x98\x80"));
  // Invalid UTF-8, bad close code, oversized control frame.
  auto bad = WsEncodeFrame(kWsText, true, reinterpret_cast<const uint8_t*>("\xC0\xAF"), 2, false);
  WsFrameDecoder d4;
  ev.clear();
  d4.Feed(bad.data(), bad.size(), &ev);
  CHECK(ev.size() == 1 && ev[0].close_code == 1007);
  uint8_t close_payload[] = {0x03, 0xEC};  // 1004 is reserved
  auto bc = WsEncodeFrame(kWsClose, true, close_payload, 2, false);
  WsFrameDecoder d5;
  ev.clear();
  d5.Feed(bc.data(), bc.size(), &ev);
  CHECK(ev.size() == 1 && ev[0].type == WsFrameDecoder::Event::kError);
  std::string big_ping(126, 'p');
  auto bp = WsEncodeFrame(kWsPing, true, reinterpret_cast<const uint8_t*>(big_ping.data()), big_ping.size(), false);
  WsFrameDecoder d6;
  ev.clear();
  d6.Feed(bp.data(), bp.size(), &ev);
  CHECK(ev.size() == 1 && ev[0].type == WsFrameDecoder::Event::kError);
}

// Minimal RFC 6455 server for the client tests: echo, server ping, close.
static void WsServe(int fd, const std::string& protocol_reply) {
  std::string extra;
  std::string head = TestServer::ReadHead(fd, &extra);
  size_t k = head.find("Sec-WebSocket-Key: ");
  if (k == std::string::npos) return;
  std::string key = head.substr(k + 19, head.find("\r\n", k) - k - 19);
  std::string resp = "HTTP/1.1 101 Switching Protocols\r\nupgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\n"
                     "Sec-WebSocket-Accept: " + WsAcceptKey(key) + "\r\n" + protocol_reply + "\r\n";
  // A ping right behind the head (same packet) exercises leftover handling.
  auto ping = WsEncodeFrame(kWsPing, true, reinterpret_cast<const uint8_t*>("hb"), 2, false);
  resp.append(ping.begin(), ping.end());
  TestServer::Send(fd, resp);
  std::vector<uint8_t> buf(extra.begin(), extra.end());
  for (;;) {
    // Parse client frames (masked).
    while (buf.size() >= 2) {
      uint8_t op = buf[0] & 0x0F;
      uint64_t len = buf[1] & 0x7F;
      size_t hdr = 2;
      if (len == 126) {
        if (buf.size() < 4) break;
        len = (buf[2] << 8) | buf[3];
        hdr = 4;
      } else if (len == 127) {
        if (buf.size() < 10) break;
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | buf[2 + i];
        hdr = 10;
      }
      if (!(buf[1] & 0x80)) return;  // client frames must be masked
      if (buf.size() < hdr + 4 + len) break;
      uint8_t* mask = &buf[hdr];
      std::vector<uint8_t> payload(len);
      for (size_t i = 0; i < len; ++i) payload[i] = buf[hdr + 4 + i] ^ mask[i & 3];
      buf.erase(buf.begin(), buf.begin() + static_cast<long>(hdr + 4 + len));
      if (op == kWsClose) {
        auto f = WsEncodeFrame(kWsClose, true, payload.data(), payload.size(), false);
        TestServer::Send(fd, std::string(f.begin(), f.end()));
        return;  // closing the TCP connection after the handshake
      }
      if (op == kWsPong) {
        auto f = WsEncodeFrame(kWsText, true, reinterpret_cast<const uint8_t*>("got-pong"), 8, false);
        TestServer::Send(fd, std::string(f.begin(), f.end()));
        continue;
      }
      std::string text(payload.begin(), payload.end());
      if (op == kWsText && text == "please-close") {
        uint8_t cp[] = {0x0F, 0xA0, 'b', 'y', 'e'};  // 4000 "bye"
        auto f = WsEncodeFrame(kWsClose, true, cp, sizeof cp, false);
        TestServer::Send(fd, std::string(f.begin(), f.end()));
        continue;
      }
      if (op == kWsText && text == "drop") return;
      auto f = WsEncodeFrame(op, true, payload.data(), payload.size(), false);
      TestServer::Send(fd, std::string(f.begin(), f.end()));
    }
    uint8_t tmp[65536];
    ssize_t n = recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return;
    buf.insert(buf.end(), tmp, tmp + n);
  }
}

struct WsCollector : WsListener {
  std::mutex mu;
  std::condition_variable cv;
  bool opened = false, closed = false, errored = false;
  std::string protocol;
  std::vector<std::pair<bool, std::string>> messages;
  size_t sent = 0;
  int code = 0;
  std::string reason;
  bool clean = false;
  void OnOpen(std::string p, std::string) override {
    std::lock_guard<std::mutex> l(mu);
    opened = true;
    protocol = p;
    cv.notify_all();
  }
  void OnMessage(bool text, std::vector<uint8_t> d) override {
    std::lock_guard<std::mutex> l(mu);
    messages.emplace_back(text, std::string(d.begin(), d.end()));
    cv.notify_all();
  }
  void OnSent(size_t n) override {
    std::lock_guard<std::mutex> l(mu);
    sent += n;
  }
  void OnError(NetError) override {
    std::lock_guard<std::mutex> l(mu);
    errored = true;
  }
  void OnClose(int c, std::string r, bool w) override {
    std::lock_guard<std::mutex> l(mu);
    closed = true;
    code = c;
    reason = r;
    clean = w;
    cv.notify_all();
  }
  template <typename Pred>
  bool WaitFor(Pred pred, int ms = 5000) {
    std::unique_lock<std::mutex> l(mu);
    return cv.wait_for(l, std::chrono::milliseconds(ms), pred);
  }
};

static OriginAllowlist LoopbackList(int port) {
  OriginAllowlist list;
  list.Set({"http://127.0.0.1:" + std::to_string(port)});
  list.SetDebugBuild(true);
  return list;
}

TEST(WsEchoPingAndClientClose) {
  TestServer server([](int fd) { WsServe(fd, "Sec-WebSocket-Protocol: chat\r\n"); });
  auto col = std::make_shared<WsCollector>();
  auto conn = WsConnection::Start(std::shared_ptr<Connector>(MakePosixConnector()), LoopbackList(server.port()),
                                  server.url("ws", "/s"), {"superchat", "chat"}, col, WsOptions{});
  CHECK(col->WaitFor([&] { return col->opened; }));
  CHECK_EQ(col->protocol, std::string("chat"));
  conn->Send(true, {'h', 'i'});
  std::string big(200000, 'b');
  conn->Send(false, std::vector<uint8_t>(big.begin(), big.end()));
  CHECK(col->WaitFor([&] { return col->messages.size() >= 3; }));
  {
    std::lock_guard<std::mutex> l(col->mu);
    // got-pong (auto pong to the server's ping), then the two echoes.
    bool saw_pong = false, saw_hi = false, saw_big = false;
    for (auto& m : col->messages) {
      saw_pong = saw_pong || (m.first && m.second == "got-pong");
      saw_hi = saw_hi || (m.first && m.second == "hi");
      saw_big = saw_big || (!m.first && m.second == big);
    }
    CHECK(saw_pong && saw_hi && saw_big);
    CHECK_EQ(col->sent, size_t(2 + 200000));
  }
  conn->Close(1000, "done");
  CHECK(col->WaitFor([&] { return col->closed; }));
  CHECK_EQ(col->code, 1000);
  CHECK_EQ(col->reason, std::string("done"));
  CHECK(col->clean);
  CHECK(!col->errored);
}

TEST(WsServerCloseAndDrop) {
  TestServer server([](int fd) { WsServe(fd, ""); });
  {
    auto col = std::make_shared<WsCollector>();
    auto conn = WsConnection::Start(std::shared_ptr<Connector>(MakePosixConnector()), LoopbackList(server.port()),
                                    server.url("ws", "/"), {}, col, WsOptions{});
    CHECK(col->WaitFor([&] { return col->opened; }));
    conn->Send(true, {'p', 'l', 'e', 'a', 's', 'e', '-', 'c', 'l', 'o', 's', 'e'});
    CHECK(col->WaitFor([&] { return col->closed; }));
    CHECK_EQ(col->code, 4000);
    CHECK_EQ(col->reason, std::string("bye"));
    CHECK(col->clean);
  }
  {
    auto col = std::make_shared<WsCollector>();
    auto conn = WsConnection::Start(std::shared_ptr<Connector>(MakePosixConnector()), LoopbackList(server.port()),
                                    server.url("ws", "/"), {}, col, WsOptions{});
    CHECK(col->WaitFor([&] { return col->opened; }));
    conn->Send(true, {'d', 'r', 'o', 'p'});
    CHECK(col->WaitFor([&] { return col->closed; }));
    CHECK_EQ(col->code, 1006);
    CHECK(!col->clean);
    CHECK(col->errored);
  }
}

TEST(WsHandshakeFailures) {
  // Wrong accept key.
  TestServer bad_accept([](int fd) {
    TestServer::ReadHead(fd);
    TestServer::Send(fd, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         "Sec-WebSocket-Accept: AAAA\r\n\r\n");
  });
  auto col = std::make_shared<WsCollector>();
  auto conn = WsConnection::Start(std::shared_ptr<Connector>(MakePosixConnector()), LoopbackList(bad_accept.port()),
                                  bad_accept.url("ws", "/"), {}, col, WsOptions{});
  CHECK(col->WaitFor([&] { return col->closed; }));
  CHECK(!col->opened && col->errored && col->code == 1006);
  // Subprotocol not offered.
  TestServer bad_proto([](int fd) { WsServe(fd, "Sec-WebSocket-Protocol: other\r\n"); });
  auto col2 = std::make_shared<WsCollector>();
  auto conn2 = WsConnection::Start(std::shared_ptr<Connector>(MakePosixConnector()), LoopbackList(bad_proto.port()),
                                   bad_proto.url("ws", "/"), {"chat"}, col2, WsOptions{});
  CHECK(col2->WaitFor([&] { return col2->closed; }));
  CHECK(!col2->opened && col2->errored);
  // Not allowlisted.
  auto col3 = std::make_shared<WsCollector>();
  auto conn3 = WsConnection::Start(std::shared_ptr<Connector>(MakePosixConnector()), OriginAllowlist{},
                                   "wss://example.com/", {}, col3, WsOptions{});
  CHECK(col3->WaitFor([&] { return col3->closed; }));
  CHECK(col3->errored && col3->code == 1006);
}

TEST(WsCloseWhileConnecting) {
  TestServer slow([](int fd) {
    TestServer::ReadHead(fd);
    std::this_thread::sleep_for(std::chrono::milliseconds(600));
  });
  auto col = std::make_shared<WsCollector>();
  auto conn = WsConnection::Start(std::shared_ptr<Connector>(MakePosixConnector()), LoopbackList(slow.port()),
                                  slow.url("ws", "/"), {}, col, WsOptions{});
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  conn->Close(1000, "");
  CHECK(col->WaitFor([&] { return col->closed; }, 2000));
  CHECK(!col->opened && col->code == 1006);
}

// --- revision 2: timeouts/abort during connect, pools, bounded decoding ----

// A connector whose Connect() hangs (like a TLS handshake to a silent peer on
// a transport without timeouts) until its ConnectCancel fires. It ignores
// timeout_ms on purpose: the client must bound the step itself.
class HangingConnector : public Connector {
 public:
  std::unique_ptr<Stream> Connect(const ConnectTarget&, int, NetError* err, ConnectCancel* cancel) override {
    ++started;
    std::mutex mu;
    std::condition_variable cv;
    bool interrupted = false;
    if (!cancel || !cancel->Arm([&] {
          std::lock_guard<std::mutex> l(mu);
          interrupted = true;
          cv.notify_all();
        })) {
      *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    {
      std::unique_lock<std::mutex> l(mu);
      cv.wait_for(l, std::chrono::seconds(30), [&] { return interrupted; });
    }
    cancel->Disarm();
    ++finished;
    *err = {NetErrorKind::kTls, "handshake interrupted"};
    return nullptr;
  }
  std::atomic<int> started{0};
  std::atomic<int> finished{0};
};

static int64_t MsSince(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
}

TEST(HttpConnectIsBoundedAndAbortable) {
  auto hang = std::make_shared<HangingConnector>();
  HttpClient client{hang};
  OriginAllowlist list;
  list.Set({"https://silent.example"});
  client.SetAllowlist(list);
  {
    HttpRequest req;
    req.url = "https://silent.example/";
    req.timeout_ms = 300;
    auto t0 = std::chrono::steady_clock::now();
    auto c = Fetch(client, req);
    CHECK(c->Wait(3000));
    CHECK(c->error.kind == NetErrorKind::kTimeout);
    int64_t ms = MsSince(t0);
    CHECK(ms >= 250 && ms < 2000);
  }
  // 20 hung connects (more than the 6-per-origin limit), each aborted:
  // every one fails with kAborted and frees its slot.
  std::vector<std::shared_ptr<Collector>> hung;
  for (int i = 0; i < 20; ++i) {
    HttpRequest req;
    req.url = "https://silent.example/x" + std::to_string(i);
    hung.push_back(Fetch(client, req));
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  CHECK_EQ(client.stats().running, 6);
  CHECK_EQ(client.stats().queued, 14);
  CHECK_EQ(hang->started.load(), 1 + 6);  // the timeout case + 6 running; queued jobs have not connected
  auto t0 = std::chrono::steady_clock::now();
  for (auto& c : hung) c->job->Abort();
  for (auto& c : hung) {
    CHECK(c->Wait(2000));
    CHECK(c->error.kind == NetErrorKind::kAborted);
  }
  CHECK(MsSince(t0) < 1500);
  for (int i = 0; i < 50 && client.stats().running > 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  CHECK_EQ(client.stats().running, 0);
  CHECK_EQ(client.stats().queued, 0);
}

// A burst of Start() calls while one pool thread is idle: every request that
// can start must get a thread right away. Notifying the idle thread once per
// Start() is not enough: until it takes the lock, all the Start() calls see it
// as idle, so it would end up running the whole burst one request at a time
// (behind a stalled connect, for up to the 60 s timeout). And requests that
// wait for the per-origin limit must not get threads of their own.
TEST(HttpBurstGetsOneThreadPerRunnableRequest) {
  auto hang = std::make_shared<HangingConnector>();
  HttpClient client{hang};
  OriginAllowlist list;
  list.Set({"https://silent.example"});
  client.SetAllowlist(list);
  {
    HttpRequest req;
    req.url = "https://silent.example/warm";
    req.timeout_ms = 100;
    auto c = Fetch(client, req);
    CHECK(c->Wait(3000));
  }
  // The worker drops `running` and starts waiting in the same critical section,
  // so once running is 0 the pool has exactly one idle thread.
  for (int i = 0; i < 200 && client.stats().running > 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  CHECK_EQ(client.stats().running, 0);
  CHECK_EQ(client.stats().threads, 1);
  std::vector<std::shared_ptr<Collector>> burst;
  for (int i = 0; i < 8; ++i) {  // back to back, faster than the idle thread wakes up
    HttpRequest req;
    req.url = "https://silent.example/b" + std::to_string(i);
    burst.push_back(Fetch(client, req));
  }
  for (int i = 0; i < 400 && hang->started.load() < 1 + 6; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  CHECK_EQ(hang->started.load(), 1 + 6);  // the warm-up + 6 in parallel (the per-origin limit)
  CHECK_EQ(client.stats().running, 6);
  CHECK_EQ(client.stats().queued, 2);
  CHECK_EQ(client.stats().threads, 6);  // the idle thread + 5 new ones; none for the 2 queued requests
  for (auto& c : burst) c->job->Abort();
  for (auto& c : burst) {
    CHECK(c->Wait(2000));
    CHECK(c->error.kind == NetErrorKind::kAborted);
  }
}

TEST(WsConnectHangCloseAndTimeout) {
  auto hang = std::make_shared<HangingConnector>();
  OriginAllowlist list;
  list.Set({"https://silent.example"});
  {
    auto col = std::make_shared<WsCollector>();
    auto conn = WsConnection::Start(hang, list, "wss://silent.example/s", {}, col, WsOptions{});
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    auto t0 = std::chrono::steady_clock::now();
    conn->Close(1000, "");
    CHECK(col->WaitFor([&] { return col->closed; }, 2000));
    CHECK(MsSince(t0) < 1000);
    CHECK(!col->opened && col->code == 1006);
  }
  {
    WsOptions opts;
    opts.connect_timeout_ms = 300;
    auto col = std::make_shared<WsCollector>();
    auto conn = WsConnection::Start(hang, list, "wss://silent.example/t", {}, col, opts);
    CHECK(col->WaitFor([&] { return col->closed; }, 3000));
    CHECK(col->errored && col->code == 1006);
  }
}

static std::string BigBodyServerReply(size_t n) {
  return "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(n) + "\r\n\r\n" + std::string(n, 'b');
}

TEST(HttpPerOriginLimitQueueAndThreads) {
  auto serve = [](int fd) {
    for (;;) {
      std::string head = TestServer::ReadHead(fd);
      if (head.empty()) return;
      if (head.find(" /big") != std::string::npos) TestServer::Send(fd, BigBodyServerReply(4 << 20));
      else TestServer::Send(fd, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    }
  };
  TestServer a(serve), b(serve);
  HttpClient client{std::shared_ptr<Connector>(MakePosixConnector())};
  OriginAllowlist list;
  list.Set({"http://127.0.0.1:" + std::to_string(a.port()), "http://127.0.0.1:" + std::to_string(b.port())});
  list.SetDebugBuild(true);
  client.SetAllowlist(list);
  // Six 4 MiB bodies nobody reads hold origin A's six slots...
  std::vector<std::shared_ptr<Collector>> big;
  for (int i = 0; i < 6; ++i) {
    auto c = std::make_shared<Collector>();
    c->auto_ack = false;
    HttpRequest req;
    req.url = a.url("http", "/big");
    auto job = client.Start(req, c);
    {
      std::lock_guard<std::mutex> l(c->mu);
      c->job = job;
    }
    big.push_back(c);
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  // ...so a seventh request to A waits in the queue (without a thread)...
  HttpRequest small_a;
  small_a.url = a.url("http", "/small");
  auto queued = Fetch(client, small_a);
  CHECK(!queued->Wait(300));
  CHECK_EQ(client.stats().queued, 1);
  CHECK_EQ(client.stats().threads, 6);  // no thread was started for it
  // ...while origin B is unaffected.
  HttpRequest small_b;
  small_b.url = b.url("http", "/small");
  auto other = Fetch(client, small_b);
  CHECK(other->Wait(2000));
  CHECK_EQ(other->body, std::string("ok"));
  // Releasing one A slot lets the queued request run.
  big[0]->job->Abort();
  CHECK(queued->Wait(2000));
  CHECK_EQ(queued->body, std::string("ok"));
  for (auto& c : big) c->job->Abort();
  // A burst of 200 requests runs on a bounded pool, not 200 threads.
  std::vector<std::shared_ptr<Collector>> burst;
  int max_threads_seen = 0;
  for (int i = 0; i < 200; ++i) {
    HttpRequest req;
    req.url = (i % 2 ? a : b).url("http", "/small?" + std::to_string(i));
    burst.push_back(Fetch(client, req));
    max_threads_seen = std::max(max_threads_seen, client.stats().threads);
  }
  int ok = 0;
  for (auto& c : burst) {
    if (c->Wait(5000) && !c->error) ++ok;
    max_threads_seen = std::max(max_threads_seen, client.stats().threads);
  }
  CHECK_EQ(ok, 200);
  CHECK(max_threads_seen <= 32);
}

TEST(HttpGzipOutputIsBoundedByTheWindow) {
  // 64 MiB of zeros gzip to ~64 KB; nobody acks. The decoder must stop at the
  // flow window instead of inflating everything into one chunk.
  std::string plain(64 << 20, '\0');
  z_stream zs{};
  deflateInit2(&zs, 9, Z_DEFLATED, 15 + 16, 9, Z_DEFAULT_STRATEGY);
  std::string gz(deflateBound(&zs, plain.size()), '\0');
  zs.next_in = reinterpret_cast<Bytef*>(plain.data());
  zs.avail_in = static_cast<uInt>(plain.size());
  zs.next_out = reinterpret_cast<Bytef*>(gz.data());
  zs.avail_out = static_cast<uInt>(gz.size());
  deflate(&zs, Z_FINISH);
  gz.resize(zs.total_out);
  deflateEnd(&zs);
  plain.clear();
  plain.shrink_to_fit();
  TestServer server([&](int fd) {
    if (TestServer::ReadHead(fd).empty()) return;
    TestServer::Send(fd, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: " + std::to_string(gz.size()) +
                             "\r\n\r\n" + gz);
  });
  struct Sizes : Collector {
    std::atomic<size_t> largest{0}, total{0};
    void OnData(std::vector<uint8_t> c) override {
      largest = std::max(largest.load(), c.size());
      total += c.size();
    }
  };
  auto client_ptr = MakeClient(server.port());
  auto c = std::make_shared<Sizes>();
  HttpRequest req;
  req.url = server.url("http", "/bomb");
  auto job = client_ptr->Start(req, c);
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  CHECK(c->largest.load() <= 256 * 1024);
  CHECK(c->total.load() <= (1 << 20) + 256 * 1024);
  CHECK(c->total.load() > 0);
  job->Abort();
  CHECK(c->Wait(2000));
}

TEST(ResponseParserAcceptsBareLf) {
  HttpResponseParser p;
  p.Reset(false);
  std::vector<uint8_t> body;
  std::string msg = "HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: 2\n\nhi";
  p.Feed(reinterpret_cast<const uint8_t*>(msg.data()), msg.size(), &body);
  CHECK(p.state() == HttpResponseParser::State::kDone);
  CHECK_EQ(std::string(body.begin(), body.end()), std::string("hi"));
  CHECK(p.Find("content-type") && *p.Find("content-type") == "text/plain");
  // Split across feeds, mixed terminators.
  HttpResponseParser q;
  q.Reset(false);
  body.clear();
  std::string m2 = "HTTP/1.1 204 No Content\r\nX-A: 1\n\r\n";
  for (char ch : m2) q.Feed(reinterpret_cast<const uint8_t*>(&ch), 1, &body);
  CHECK(q.state() == HttpResponseParser::State::kDone);
  CHECK_EQ(q.status(), 204);
}

TEST(RedirectLocationIsPercentEncoded) {
  ParsedUrl base;
  CHECK(ParseUrl("https://h.example/dir/page", &base));
  std::string out;
  CHECK(ResolveRedirect(base, "/a b/\xC3\xBC?x=1 2", &out));
  CHECK_EQ(out, std::string("https://h.example/a%20b/%C3%BC?x=1%202"));
  CHECK(ResolveRedirect(base, "already%20ok", &out));
  CHECK_EQ(out, std::string("https://h.example/dir/already%20ok"));
}

TEST(WatchdogFiresOnceAndDisarms) {
  std::atomic<int> fired{0};
  {
    WatchdogScope w(50, [&] { ++fired; });
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    CHECK(w.Disarm());
  }
  CHECK_EQ(fired.load(), 1);
  {
    WatchdogScope w(5000, [&] { ++fired; });
    CHECK(!w.Disarm());
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK_EQ(fired.load(), 1);
}

// Writes a ZIP (PKWARE APPNOTE 4.3) with the given entries; method 0 entries
// are stored, method 8 entries are written as stored bytes but flagged
// deflated (the index only reads headers).
static void WriteZip(const std::string& path, const std::vector<std::tuple<std::string, std::string, uint16_t>>& entries) {
  std::string out, cd;
  auto u16 = [](std::string* s, uint16_t v) {
    s->push_back(static_cast<char>(v & 0xFF));
    s->push_back(static_cast<char>(v >> 8));
  };
  auto u32 = [&](std::string* s, uint32_t v) {
    u16(s, static_cast<uint16_t>(v & 0xFFFF));
    u16(s, static_cast<uint16_t>(v >> 16));
  };
  for (const auto& [name, data, method] : entries) {
    uint32_t offset = static_cast<uint32_t>(out.size());
    uint32_t crc = static_cast<uint32_t>(crc32(0, reinterpret_cast<const Bytef*>(data.data()), static_cast<uInt>(data.size())));
    uint32_t compressed = method == 8 ? static_cast<uint32_t>(data.size() / 2) : static_cast<uint32_t>(data.size());
    std::string extra(3, 'x');  // odd-length local extra field (alignment padding as zipalign adds)
    u32(&out, 0x04034b50); u16(&out, 20); u16(&out, 0); u16(&out, method); u16(&out, 0); u16(&out, 0);
    u32(&out, crc); u32(&out, compressed); u32(&out, static_cast<uint32_t>(data.size()));
    u16(&out, static_cast<uint16_t>(name.size())); u16(&out, static_cast<uint16_t>(extra.size()));
    out += name + extra;
    out += data.substr(0, compressed);
    u32(&cd, 0x02014b50); u16(&cd, 20); u16(&cd, 20); u16(&cd, 0); u16(&cd, method); u16(&cd, 0); u16(&cd, 0);
    u32(&cd, crc); u32(&cd, compressed); u32(&cd, static_cast<uint32_t>(data.size()));
    u16(&cd, static_cast<uint16_t>(name.size())); u16(&cd, 0); u16(&cd, 0); u16(&cd, 0); u16(&cd, 0); u32(&cd, 0);
    u32(&cd, offset);
    cd += name;
  }
  uint32_t cd_offset = static_cast<uint32_t>(out.size());
  out += cd;
  u32(&out, 0x06054b50); u16(&out, 0); u16(&out, 0);
  u16(&out, static_cast<uint16_t>(entries.size())); u16(&out, static_cast<uint16_t>(entries.size()));
  u32(&out, static_cast<uint32_t>(cd.size())); u32(&out, cd_offset); u16(&out, 0);
  std::ofstream(path, std::ios::binary) << out;
}

TEST(ZipIndexMapsStoredEntries) {
  std::string dir = MakeTempDir();
  std::string big(200 * 1024 + 7, '\0');
  for (size_t i = 0; i < big.size(); ++i) big[i] = static_cast<char>((i * 131) & 0xFF);
  WriteZip(dir + "/app.apk", {{"AndroidManifest.xml", "<m/>", 0},
                              {"assets/dist/model.glb", big, 0},
                              {"assets/dist/script.js", std::string(1000, 's'), 8},
                              {"assets/dist/", "", 0}});
  std::string err;
  auto zip = ZipIndex::Open(dir + "/app.apk", "assets/", &err);
  CHECK(zip != nullptr);
  if (!zip) return;
  CHECK_EQ(zip->entry_count(), size_t(2));  // prefix filter, directories skipped
  ZipIndex::Entry e;
  CHECK(zip->Find("assets/dist/model.glb", &e));
  CHECK(e.stored && e.size == big.size());
  auto blob = MapFileRange(zip->fd(), e.data_offset, static_cast<size_t>(e.size));
  CHECK(blob && blob->mapped());
  CHECK(blob && std::memcmp(blob->data(), big.data(), big.size()) == 0);
  CHECK(zip->Find("assets/dist/script.js", &e));
  CHECK(!e.stored);
  CHECK(!zip->Find("AndroidManifest.xml", &e));
  CHECK(!zip->Find("assets/dist/missing", &e));
  std::ofstream(dir + "/not.zip") << "hello";
  CHECK(ZipIndex::Open(dir + "/not.zip", "", &err) == nullptr);
}

TEST(FetchBlockingBuffersWithoutAcksAndTimesOut) {
  TestServer server([](int fd) {
    std::string head = TestServer::ReadHead(fd);
    if (head.find(" /hang") != std::string::npos) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1500));
      return;
    }
    TestServer::Send(fd, BigBodyServerReply(3 << 20));  // > the 1 MiB window
  });
  auto client_ptr = MakeClient(server.port());
  HttpRequest req;
  req.url = server.url("http", "/big");
  BlockingResult r = FetchBlocking(*client_ptr, req, 0);
  CHECK(!r.error);
  CHECK_EQ(r.head.status, 200);
  CHECK_EQ(r.body.size(), size_t(3 << 20));
  req.url = server.url("http", "/hang");
  auto t0 = std::chrono::steady_clock::now();
  BlockingResult t = FetchBlocking(*client_ptr, req, 200);
  CHECK(t.timed_out && t.error.kind == NetErrorKind::kTimeout);
  CHECK(MsSince(t0) < 1000);
}

TEST_MAIN()
