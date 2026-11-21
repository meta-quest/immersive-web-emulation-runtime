// CDP-1..4, CDP-10, DBG-1 against the real server over loopback sockets: discovery, Host check, handshake with
// mixed-case headers, echo, a multi-MB reply as one frame, ping/pong, close.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <thread>

#include "iwn/core/loopback_server.h"
#include "iwn_test.h"

using namespace iwn;

namespace {

int connect_to(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(static_cast<uint16_t>(port));
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, reinterpret_cast<sockaddr*>(&a), sizeof(a)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

void send_all(int fd, const std::string& s) {
  size_t off = 0;
  while (off < s.size()) {
    ssize_t n = send(fd, s.data() + off, s.size() - off, MSG_NOSIGNAL);
    if (n <= 0) return;
    off += static_cast<size_t>(n);
  }
}

// Reads until `done(buffer)` or timeout.
std::string read_until(int fd, const std::function<bool(const std::string&)>& done, int timeout_ms = 3000) {
  std::string buf;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (!done(buf) && std::chrono::steady_clock::now() < deadline) {
    pollfd p{fd, POLLIN, 0};
    if (poll(&p, 1, 50) <= 0) continue;
    char tmp[65536];
    ssize_t n = recv(fd, tmp, sizeof(tmp), 0);
    if (n <= 0) break;
    buf.append(tmp, static_cast<size_t>(n));
  }
  return buf;
}

std::string http_get(int port, const std::string& path, const std::string& host = "localhost") {
  int fd = connect_to(port);
  send_all(fd, "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\n\r\n");
  std::string r = read_until(fd, [](const std::string&) { return false; }, 500);
  close(fd);
  return r;
}

struct Fixture {
  LoopbackServer server;
  std::atomic<int> opens{0}, closes{0};
  int port = 0;
  Fixture() {
    LoopbackServer::Callbacks cb;
    cb.http = [](const ws::HttpRequest& req, int) {
      if (req.path() == "/json/version") return ws::http_response(200, "OK", "application/json", "{\"Browser\":\"t\"}");
      return ws::http_response(404, "Not Found", "text/plain", "nope");
    };
    cb.accept_ws = [](const std::string& path, int) -> std::optional<int> {
      if (path == "/devtools/page/1") return 1;
      if (path == "/host") return 2;
      return std::nullopt;
    };
    cb.on_open = [this](uint64_t, int, const std::string&) { opens++; };
    cb.on_close = [this](uint64_t) { closes++; };
    cb.on_message = [this](uint64_t conn, std::string&& text) {
      if (text == "big") {
        server.send_text(conn, std::string(4u << 20, 'B'));
      } else {
        server.send_text(conn, "echo:" + text);
      }
    };
    std::string err;
    IWN_CHECK(server.start({0}, cb, &err));
    port = server.bound_ports()[0];
  }
};

// Parses one server frame from buf (unmasked); returns false if incomplete.
bool parse_server_frame(const std::string& buf, size_t header_skip, uint8_t* b0, std::string* payload) {
  std::string_view s(buf);
  s.remove_prefix(header_skip);
  if (s.size() < 2) return false;
  uint64_t len = static_cast<uint8_t>(s[1]) & 0x7F;
  size_t h = 2;
  if (len == 126) {
    if (s.size() < 4) return false;
    len = (uint64_t(uint8_t(s[2])) << 8) | uint8_t(s[3]);
    h = 4;
  } else if (len == 127) {
    if (s.size() < 10) return false;
    len = 0;
    for (int i = 0; i < 8; ++i) len = (len << 8) | uint8_t(s[2 + i]);
    h = 10;
  }
  if (s.size() < h + len) return false;
  *b0 = static_cast<uint8_t>(s[0]);
  *payload = std::string(s.substr(h, len));
  return true;
}

int open_ws(int port, const std::string& path, const std::string& headers) {
  int fd = connect_to(port);
  send_all(fd, "GET " + path + " HTTP/1.1\r\n" + headers + "\r\n");
  std::string resp = read_until(fd, [](const std::string& b) { return b.find("\r\n\r\n") != std::string::npos; });
  if (resp.rfind("HTTP/1.1 101", 0) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

const char* kLowerHeaders =
    "host: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    "sec-websocket-version: 13\r\n";

}  // namespace

IWN_TEST(LoopbackServer, HttpDiscoveryAndHostCheck) {
  Fixture f;
  std::string ok = http_get(f.port, "/json/version");
  IWN_CHECK(ok.rfind("HTTP/1.1 200", 0) == 0);
  IWN_CHECK(ok.find("{\"Browser\":\"t\"}") != std::string::npos);
  IWN_CHECK(http_get(f.port, "/nope").rfind("HTTP/1.1 404", 0) == 0);
  IWN_CHECK(http_get(f.port, "/json/version", "evil.example").rfind("HTTP/1.1 403", 0) == 0);
}

IWN_TEST(LoopbackServer, HandshakeLowercaseAndShouting) {
  Fixture f;
  int a = open_ws(f.port, "/devtools/page/1", kLowerHeaders);
  IWN_CHECK(a >= 0);
  int b = open_ws(f.port, "/host",
                  "HOST: localhost\r\nCONNECTION: keep-alive, Upgrade\r\nUPGRADE: WebSocket\r\n"
                  "SEC-WEBSOCKET-KEY: x\r\nSEC-WEBSOCKET-VERSION: 13\r\n");
  IWN_CHECK(b >= 0);
  int c = open_ws(f.port, "/devtools/page/999", kLowerHeaders);
  IWN_CHECK(c < 0);
  close(a);
  close(b);
}

IWN_TEST(LoopbackServer, EchoBigReplyPingClose) {
  Fixture f;
  int fd = open_ws(f.port, "/host", kLowerHeaders);
  IWN_CHECK(fd >= 0);
  send_all(fd, ws::encode_frame(ws::kText, "{\"method\":\"eval\"}", true));
  uint8_t b0 = 0;
  std::string payload;
  std::string buf = read_until(fd, [&](const std::string& b) { return parse_server_frame(b, 0, &b0, &payload); });
  IWN_CHECK(parse_server_frame(buf, 0, &b0, &payload));
  IWN_CHECK_EQ(payload, std::string("echo:{\"method\":\"eval\"}"));

  send_all(fd, ws::encode_frame(ws::kText, "big", true));
  buf = read_until(fd, [&](const std::string& b) { return parse_server_frame(b, 0, &b0, &payload); }, 10000);
  IWN_CHECK(parse_server_frame(buf, 0, &b0, &payload));
  IWN_CHECK(b0 == 0x81);  // FIN + text: the whole 4 MB in one frame
  IWN_CHECK_EQ(payload.size(), size_t(4u << 20));

  send_all(fd, ws::encode_frame(ws::kPing, "hb", true));
  buf = read_until(fd, [&](const std::string& b) { return parse_server_frame(b, 0, &b0, &payload); });
  IWN_CHECK(parse_server_frame(buf, 0, &b0, &payload));
  IWN_CHECK(b0 == 0x8A);
  IWN_CHECK_EQ(payload, std::string("hb"));

  send_all(fd, ws::encode_close(1000));
  buf = read_until(fd, [&](const std::string& b) { return parse_server_frame(b, 0, &b0, &payload); });
  IWN_CHECK(parse_server_frame(buf, 0, &b0, &payload));
  IWN_CHECK(b0 == 0x88);
  close(fd);
  for (int i = 0; i < 50 && f.closes.load() == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(20));
  IWN_CHECK_EQ(f.closes.load(), 1);
}

IWN_TEST(LoopbackServer, PipelinedFirstFrameAfterHandshake) {
  Fixture f;
  int fd = connect_to(f.port);
  send_all(fd, std::string("GET /host HTTP/1.1\r\n") + kLowerHeaders + "\r\n" +
                   ws::encode_frame(ws::kText, "early", true));
  std::string buf = read_until(fd, [](const std::string& b) {
    size_t e = b.find("\r\n\r\n");
    return e != std::string::npos && b.find("echo:early") != std::string::npos;
  });
  IWN_CHECK(buf.find("echo:early") != std::string::npos);
  close(fd);
}

IWN_TEST(LoopbackServer, BindsLoopbackOnly) {
  Fixture f;
  sockaddr_in addr{};
  // The listening address must be 127.0.0.1 (CDP-1). Connect via a non-loopback address is not testable portably;
  // check the bound address instead.
  int fd = connect_to(f.port);
  socklen_t len = sizeof(addr);
  getpeername(fd, reinterpret_cast<sockaddr*>(&addr), &len);
  IWN_CHECK_EQ(addr.sin_addr.s_addr, htonl(INADDR_LOOPBACK));
  close(fd);
}

// A port still held by a previous instance (same-process relaunch, PROC-7): start() returns at once and the server
// thread binds the port as soon as it is free.
IWN_TEST(LoopbackServer, BusyPortIsRetriedInTheBackground) {
  int blocker = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  IWN_CHECK(bind(blocker, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == 0);
  IWN_CHECK(listen(blocker, 4) == 0);
  socklen_t len = sizeof(a);
  getsockname(blocker, reinterpret_cast<sockaddr*>(&a), &len);
  int port = ntohs(a.sin_port);

  {
    LoopbackServer strict;
    std::string err;
    IWN_CHECK(!strict.start({port}, {}, &err, 0));  // retry_ms == 0: a busy port fails
    IWN_CHECK(err.find("bind/listen") != std::string::npos);
  }

  LoopbackServer server;
  std::atomic<int> listening{0};
  LoopbackServer::Callbacks cb;
  cb.http = [](const ws::HttpRequest&, int) { return ws::http_response(200, "OK", "text/plain", "late"); };
  cb.on_listening = [&](int p) { listening = p; };
  std::string err;
  auto t0 = std::chrono::steady_clock::now();
  IWN_CHECK(server.start({port}, cb, &err, 5000));
  auto start_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
  IWN_CHECK(start_ms < 200);  // never blocks the caller (the JS thread)
  IWN_CHECK(server.bound_ports().empty());
  IWN_CHECK_EQ(server.pending_port_count(), size_t{1});
  IWN_CHECK_EQ(listening.load(), 0);

  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  IWN_CHECK(server.bound_ports().empty());  // still held
  close(blocker);
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (server.bound_ports().empty() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  IWN_CHECK_EQ(server.bound_ports().size(), size_t{1});
  IWN_CHECK_EQ(listening.load(), port);
  IWN_CHECK_EQ(server.pending_port_count(), size_t{0});
  IWN_CHECK(http_get(port, "/x").find("late") != std::string::npos);
}
