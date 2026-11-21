/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CDP-3, CDP-4, GAP-5: case-insensitive handshake, token lists, accept key (RFC 6455 §1.3 example), framing.
#include <string>
#include <vector>

#include "iwn/core/websocket.h"
#include "iwn_test.h"

using namespace iwn::ws;

IWN_TEST(WebSocket, AcceptKeyRfcExample) {
  IWN_CHECK_EQ(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), std::string("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
}

IWN_TEST(WebSocket, ParsesRequestHead) {
  HttpRequest req;
  size_t consumed = 0;
  std::string raw = "GET /json/list?x=1 HTTP/1.1\r\nhost: localhost:9229\r\nX-A:  b  \r\n\r\nextra";
  IWN_CHECK(parse_http_request(raw, req, &consumed) == ParseResult::kOk);
  IWN_CHECK_EQ(req.method, std::string("GET"));
  IWN_CHECK_EQ(req.path(), std::string("/json/list"));
  IWN_CHECK_EQ(std::string(*req.header("HOST")), std::string("localhost:9229"));
  IWN_CHECK_EQ(std::string(*req.header("x-a")), std::string("b"));
  IWN_CHECK_EQ(consumed, raw.size() - 5);
  IWN_CHECK(parse_http_request("GET / HTTP/1.1\r\nHost: x", req, &consumed) == ParseResult::kIncomplete);
  IWN_CHECK(parse_http_request("garbage\r\n\r\n", req, &consumed) == ParseResult::kBad);
}

namespace {
HttpRequest make(const std::vector<std::pair<std::string, std::string>>& headers, const char* method = "GET") {
  HttpRequest r;
  r.method = method;
  r.target = "/devtools/page/1";
  r.version = "HTTP/1.1";
  r.headers = headers;
  return r;
}
}  // namespace

IWN_TEST(WebSocket, UpgradeIsCaseInsensitive) {
  // Node 24's global WebSocket sends lowercase names; a hand-written client may shout.
  auto lower = make({{"host", "127.0.0.1:9229"}, {"connection", "Upgrade"}, {"upgrade", "websocket"},
                     {"sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="}, {"sec-websocket-version", "13"}});
  IWN_CHECK(check_upgrade(lower).ok);
  auto shout = make({{"HOST", "localhost"}, {"CONNECTION", "keep-alive, Upgrade"}, {"UPGRADE", "WebSocket"},
                     {"SEC-WEBSOCKET-KEY", "x"}, {"SEC-WEBSOCKET-VERSION", "13"}});
  IWN_CHECK(check_upgrade(shout).ok);
  auto mixed = make({{"Connection", "upgrade"}, {"Upgrade", "WEBSOCKET"}, {"Sec-WebSocket-Key", "x"},
                     {"Sec-WebSocket-Version", "13"}});
  IWN_CHECK(check_upgrade(mixed).ok);
}

IWN_TEST(WebSocket, UpgradeRejections) {
  auto plain = make({{"Host", "localhost"}});
  IWN_CHECK(!check_upgrade(plain).is_upgrade);
  auto no_conn = make({{"Upgrade", "websocket"}, {"Sec-WebSocket-Key", "x"}, {"Sec-WebSocket-Version", "13"}});
  IWN_CHECK(check_upgrade(no_conn).is_upgrade && !check_upgrade(no_conn).ok);
  auto bad_ver = make({{"Connection", "Upgrade"}, {"Upgrade", "websocket"}, {"Sec-WebSocket-Key", "x"},
                       {"Sec-WebSocket-Version", "8"}});
  IWN_CHECK_EQ(check_upgrade(bad_ver).status, 426);
  auto post = make({{"Connection", "Upgrade"}, {"Upgrade", "websocket"}, {"Sec-WebSocket-Key", "x"},
                    {"Sec-WebSocket-Version", "13"}},
                   "POST");
  IWN_CHECK_EQ(check_upgrade(post).status, 405);
}

IWN_TEST(WebSocket, UpgradeOriginPolicy) {
  auto with_origin = [](const char* origin) {
    std::vector<std::pair<std::string, std::string>> h = {{"Connection", "Upgrade"},
                                                          {"Upgrade", "websocket"},
                                                          {"Sec-WebSocket-Key", "x"},
                                                          {"Sec-WebSocket-Version", "13"}};
    if (origin) h.push_back({"Origin", origin});
    return h;
  };
  IWN_CHECK(check_upgrade(make(with_origin(nullptr))).ok);  // tools
  IWN_CHECK(check_upgrade(make(with_origin("devtools://devtools"))).ok);
  IWN_CHECK(check_upgrade(make(with_origin("DevTools://DevTools"))).ok);
  auto page = check_upgrade(make(with_origin("https://evil.example")));
  IWN_CHECK(page.is_upgrade && !page.ok);
  IWN_CHECK_EQ(page.status, 403);
  IWN_CHECK(!check_upgrade(make(with_origin("http://127.0.0.1:8080"))).ok);
  IWN_CHECK(!check_upgrade(make(with_origin("null"))).ok);
}

IWN_TEST(WebSocket, LoopbackHost) {
  IWN_CHECK(is_loopback_host(std::nullopt));
  IWN_CHECK(is_loopback_host(std::string_view("localhost:9229")));
  IWN_CHECK(is_loopback_host(std::string_view("LOCALHOST")));
  IWN_CHECK(is_loopback_host(std::string_view("127.0.0.1:1")));
  IWN_CHECK(is_loopback_host(std::string_view("[::1]:9229")));
  IWN_CHECK(!is_loopback_host(std::string_view("evil.example")));
  IWN_CHECK(!is_loopback_host(std::string_view("localhost.evil.example:9229")));
  IWN_CHECK(!is_loopback_host(std::string_view("127.0.0.2")));
}

IWN_TEST(WebSocket, FrameRoundTripAllSizes) {
  for (size_t n : {size_t(0), size_t(125), size_t(126), size_t(65535), size_t(65536), size_t(3u << 20)}) {
    std::string payload(n, 'x');
    for (size_t i = 0; i < n; ++i) payload[i] = static_cast<char>('a' + i % 26);
    std::string frame = encode_frame(kText, payload, /*mask=*/true);
    FrameParser p(true);
    std::vector<std::string> got;
    FrameParser::Handlers h;
    h.message = [&](Opcode op, std::string&& s) {
      IWN_CHECK(op == kText);
      got.push_back(std::move(s));
    };
    // Feed in uneven pieces.
    size_t pos = 0, step = 7;
    while (pos < frame.size()) {
      size_t len = std::min(step, frame.size() - pos);
      IWN_CHECK(p.feed(std::string_view(frame).substr(pos, len), h));
      pos += len;
      step = step * 3 + 1;
    }
    IWN_CHECK_EQ(got.size(), size_t(1));
    IWN_CHECK(got[0] == payload);
  }
}

IWN_TEST(WebSocket, ServerFramesAreSingleUnfragmented) {
  std::string big(5u << 20, 'z');
  std::string f = encode_frame(kText, big);
  IWN_CHECK((static_cast<uint8_t>(f[0]) & 0x80) != 0);  // FIN
  IWN_CHECK((static_cast<uint8_t>(f[0]) & 0x0F) == kText);
  IWN_CHECK((static_cast<uint8_t>(f[1]) & 0x80) == 0);  // unmasked
  IWN_CHECK_EQ(f.size(), big.size() + 10);
}

IWN_TEST(WebSocket, FragmentsPingCloseAndErrors) {
  FrameParser p(true);
  std::vector<std::string> msgs, pings;
  uint16_t close_code = 0, err_code = 0;
  FrameParser::Handlers h;
  h.message = [&](Opcode, std::string&& s) { msgs.push_back(s); };
  h.ping = [&](std::string&& s) { pings.push_back(s); };
  h.close = [&](uint16_t c, std::string&&) { close_code = c; };
  h.error = [&](uint16_t c, const char*) { err_code = c; };
  // Fragmented text "hello world" with a ping in the middle.
  auto frag = [](uint8_t first, std::string_view payload) {
    std::string f = encode_frame(static_cast<Opcode>(first & 0x0F), payload, true);
    f[0] = static_cast<char>(first);
    return f;
  };
  std::string stream = frag(0x01, "hello ") + encode_frame(kPing, "p", true) + frag(0x80, "world");
  IWN_CHECK(p.feed(stream, h));
  IWN_CHECK_EQ(msgs.size(), size_t(1));
  IWN_CHECK_EQ(msgs[0], std::string("hello world"));
  IWN_CHECK_EQ(pings.size(), size_t(1));
  std::string close_payload = "\x03\xE8";
  IWN_CHECK(p.feed(encode_frame(kClose, close_payload, true), h));
  IWN_CHECK_EQ(close_code, uint16_t(1000));
  // Unmasked client frame -> protocol error 1002.
  FrameParser q(true);
  IWN_CHECK(!q.feed(encode_frame(kText, "x", false), h));
  IWN_CHECK_EQ(err_code, uint16_t(1002));
}
