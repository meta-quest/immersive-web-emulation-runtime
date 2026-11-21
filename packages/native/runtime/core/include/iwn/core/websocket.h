/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// HTTP/1.1 request parsing and the WebSocket protocol (RFC 6455) for the inspector and the debug endpoint, V8-free.
// Header names are matched case-insensitively and Upgrade/Connection are token lists (RFC 9110, CDP-3, GAP-5).
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace iwn::ws {

struct HttpRequest {
  std::string method;
  std::string target;  // request-target as sent ("/json/list?x")
  std::string version;
  std::vector<std::pair<std::string, std::string>> headers;
  // First header with this name (case-insensitive).
  std::optional<std::string_view> header(std::string_view name) const;
  // Path without query.
  std::string path() const;
};

enum class ParseResult { kIncomplete, kOk, kBad };
// Parses a request head from buf (which may hold more bytes). On kOk, *consumed is the head length incl. CRLFCRLF.
ParseResult parse_http_request(std::string_view buf, HttpRequest& out, size_t* consumed, size_t max_head = 16384);

// Sec-WebSocket-Accept for a client key (RFC 6455 §4.2.2).
std::string accept_key(std::string_view client_key);

struct UpgradeCheck {
  bool is_upgrade = false;  // the request asks for a WebSocket upgrade at all
  bool ok = false;          // and is acceptable
  int status = 400;
  std::string reason;
};
// Also refuses (403) upgrades whose Origin is a web page: browsers allow cross-origin WebSockets, so without this
// any page in a browser on the headset (or on a desktop with adb forward active) could drive /host eval. Tools send
// no Origin; the DevTools frontend sends devtools://devtools.
UpgradeCheck check_upgrade(const HttpRequest& req);
bool is_allowed_ws_origin(std::optional<std::string_view> origin_header);

// DNS-rebinding defence (CDP-10): a missing Host is accepted (HTTP/1.0 clients); otherwise its host part must be
// localhost, 127.0.0.1 or [::1] (any port).
bool is_loopback_host(std::optional<std::string_view> host_header);

std::string http_response(int status, std::string_view reason, std::string_view content_type, std::string_view body,
                          std::string_view extra_headers = {});
std::string handshake_response(std::string_view accept);

enum Opcode : uint8_t { kContinuation = 0, kText = 1, kBinary = 2, kClose = 8, kPing = 9, kPong = 10 };

// One unfragmented frame (FIN set). Servers send unmasked frames; `mask` is for test clients.
std::string encode_frame(Opcode opcode, std::string_view payload, bool mask = false, uint32_t mask_key = 0x12345678);
std::string encode_close(uint16_t code, std::string_view reason = {});

class FrameParser {
 public:
  struct Handlers {
    std::function<void(Opcode opcode, std::string&& payload)> message;  // complete text/binary message
    std::function<void(std::string&& payload)> ping;
    std::function<void(std::string&& payload)> pong;
    std::function<void(uint16_t code, std::string&& reason)> close;
    std::function<void(uint16_t code, const char* why)> error;  // protocol error: send close(code), drop
  };
  explicit FrameParser(bool require_mask = true, size_t max_message = 256u << 20)
      : require_mask_(require_mask), max_message_(max_message) {}
  // Feeds bytes; calls handlers for each complete frame/message. Returns false after a protocol error.
  bool feed(std::string_view data, const Handlers& h);

 private:
  std::string buf_;
  std::string message_;
  Opcode message_opcode_ = kText;
  bool in_message_ = false;
  bool failed_ = false;
  bool require_mask_;
  size_t max_message_;
};

}  // namespace iwn::ws
