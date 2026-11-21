#include "iwn/core/websocket.h"

#include <cctype>

#include "iwn/core/text.h"

namespace iwn::ws {

std::optional<std::string_view> HttpRequest::header(std::string_view name) const {
  for (const auto& kv : headers) {
    if (iequals(kv.first, name)) return std::string_view(kv.second);
  }
  return std::nullopt;
}

std::string HttpRequest::path() const {
  size_t q = target.find('?');
  return q == std::string::npos ? target : target.substr(0, q);
}

ParseResult parse_http_request(std::string_view buf, HttpRequest& out, size_t* consumed, size_t max_head) {
  size_t end = buf.find("\r\n\r\n");
  size_t term = 4;
  if (end == std::string_view::npos) {
    // Tolerate bare LF line endings from hand-written clients.
    end = buf.find("\n\n");
    term = 2;
  }
  if (end == std::string_view::npos) {
    return buf.size() > max_head ? ParseResult::kBad : ParseResult::kIncomplete;
  }
  std::string_view head = buf.substr(0, end);
  out = HttpRequest{};
  size_t line_end = head.find('\n');
  std::string_view request_line = head.substr(0, line_end);
  if (!request_line.empty() && request_line.back() == '\r') request_line.remove_suffix(1);
  size_t sp1 = request_line.find(' ');
  size_t sp2 = request_line.rfind(' ');
  if (sp1 == std::string_view::npos || sp2 == sp1) return ParseResult::kBad;
  out.method = std::string(request_line.substr(0, sp1));
  out.target = std::string(request_line.substr(sp1 + 1, sp2 - sp1 - 1));
  out.version = std::string(request_line.substr(sp2 + 1));
  if (out.version.rfind("HTTP/", 0) != 0) return ParseResult::kBad;
  size_t pos = line_end == std::string_view::npos ? head.size() : line_end + 1;
  while (pos < head.size()) {
    size_t le = head.find('\n', pos);
    if (le == std::string_view::npos) le = head.size();
    std::string_view line = head.substr(pos, le - pos);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    pos = le + 1;
    if (line.empty()) continue;
    size_t colon = line.find(':');
    if (colon == std::string_view::npos || colon == 0) return ParseResult::kBad;
    out.headers.emplace_back(std::string(trim(line.substr(0, colon))), std::string(trim(line.substr(colon + 1))));
  }
  if (consumed) *consumed = end + term;
  return ParseResult::kOk;
}

std::string accept_key(std::string_view client_key) {
  std::string s(trim(client_key));
  s += "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  auto digest = sha1(s.data(), s.size());
  return base64_encode(digest.data(), digest.size());
}

UpgradeCheck check_upgrade(const HttpRequest& req) {
  UpgradeCheck r;
  auto upgrade = req.header("Upgrade");
  if (!upgrade || !header_has_token(*upgrade, "websocket")) return r;  // a plain HTTP request
  r.is_upgrade = true;
  if (req.method != "GET") {
    r.status = 405;
    r.reason = "WebSocket upgrade requires GET";
    return r;
  }
  auto connection = req.header("Connection");
  if (!connection || !header_has_token(*connection, "upgrade")) {
    r.status = 400;
    r.reason = "Connection header must contain the upgrade token";
    return r;
  }
  auto key = req.header("Sec-WebSocket-Key");
  if (!key || trim(*key).empty()) {
    r.status = 400;
    r.reason = "missing Sec-WebSocket-Key";
    return r;
  }
  auto version = req.header("Sec-WebSocket-Version");
  if (!version || trim(*version) != "13") {
    r.status = 426;
    r.reason = "unsupported Sec-WebSocket-Version (13 required)";
    return r;
  }
  if (!is_allowed_ws_origin(req.header("Origin"))) {
    r.status = 403;
    r.reason = "WebSocket upgrades from web pages are refused (Origin must be absent or devtools://devtools)";
    return r;
  }
  r.ok = true;
  r.status = 101;
  return r;
}

bool is_allowed_ws_origin(std::optional<std::string_view> origin_header) {
  if (!origin_header) return true;  // Node, ws, Puppeteer, websocat: no Origin
  std::string_view o = trim(*origin_header);
  return iequals(o, "devtools://devtools") || iequals(o, "chrome-devtools://devtools");
}

bool is_loopback_host(std::optional<std::string_view> host_header) {
  if (!host_header) return true;
  std::string_view h = trim(*host_header);
  std::string_view host = h;
  if (!h.empty() && h[0] == '[') {
    size_t close = h.find(']');
    if (close == std::string_view::npos) return false;
    host = h.substr(0, close + 1);
  } else {
    size_t colon = h.find(':');
    if (colon != std::string_view::npos) host = h.substr(0, colon);
  }
  return iequals(host, "localhost") || host == "127.0.0.1" || host == "[::1]";
}

std::string http_response(int status, std::string_view reason, std::string_view content_type, std::string_view body,
                          std::string_view extra_headers) {
  std::string out = "HTTP/1.1 " + std::to_string(status) + " " + std::string(reason) + "\r\n";
  if (!content_type.empty()) out += "Content-Type: " + std::string(content_type) + "\r\n";
  out += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  out += "Cache-Control: no-cache\r\nConnection: close\r\n";
  out += extra_headers;
  out += "\r\n";
  out += body;
  return out;
}

std::string handshake_response(std::string_view accept) {
  return "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
         std::string(accept) + "\r\n\r\n";
}

std::string encode_frame(Opcode opcode, std::string_view payload, bool mask, uint32_t mask_key) {
  std::string out;
  out.reserve(payload.size() + 14);
  out.push_back(static_cast<char>(0x80 | opcode));
  uint8_t mask_bit = mask ? 0x80 : 0;
  size_t n = payload.size();
  if (n < 126) {
    out.push_back(static_cast<char>(mask_bit | n));
  } else if (n <= 0xFFFF) {
    out.push_back(static_cast<char>(mask_bit | 126));
    out.push_back(static_cast<char>(n >> 8));
    out.push_back(static_cast<char>(n & 0xFF));
  } else {
    out.push_back(static_cast<char>(mask_bit | 127));
    for (int i = 7; i >= 0; --i) out.push_back(static_cast<char>((static_cast<uint64_t>(n) >> (i * 8)) & 0xFF));
  }
  if (mask) {
    uint8_t k[4] = {static_cast<uint8_t>(mask_key >> 24), static_cast<uint8_t>(mask_key >> 16),
                    static_cast<uint8_t>(mask_key >> 8), static_cast<uint8_t>(mask_key)};
    out.append(reinterpret_cast<const char*>(k), 4);
    for (size_t i = 0; i < n; ++i) out.push_back(static_cast<char>(payload[i] ^ k[i & 3]));
  } else {
    out.append(payload.data(), n);
  }
  return out;
}

std::string encode_close(uint16_t code, std::string_view reason) {
  std::string payload;
  payload.push_back(static_cast<char>(code >> 8));
  payload.push_back(static_cast<char>(code & 0xFF));
  payload.append(reason.substr(0, 123));
  return encode_frame(kClose, payload);
}

bool FrameParser::feed(std::string_view data, const Handlers& h) {
  if (failed_) return false;
  buf_.append(data.data(), data.size());
  size_t pos = 0;
  auto fail = [&](uint16_t code, const char* why) {
    failed_ = true;
    buf_.clear();
    if (h.error) h.error(code, why);
    return false;
  };
  for (;;) {
    size_t avail = buf_.size() - pos;
    if (avail < 2) break;
    const uint8_t* p = reinterpret_cast<const uint8_t*>(buf_.data() + pos);
    bool fin = p[0] & 0x80;
    if (p[0] & 0x70) return fail(1002, "reserved bits set");
    Opcode op = static_cast<Opcode>(p[0] & 0x0F);
    bool masked = p[1] & 0x80;
    uint64_t len = p[1] & 0x7F;
    size_t header = 2;
    if (len == 126) {
      if (avail < 4) break;
      len = (uint64_t(p[2]) << 8) | p[3];
      header = 4;
    } else if (len == 127) {
      if (avail < 10) break;
      len = 0;
      for (int i = 0; i < 8; ++i) len = (len << 8) | p[2 + i];
      header = 10;
    }
    if (require_mask_ && !masked) return fail(1002, "client frames must be masked");
    if (len > max_message_) return fail(1009, "message too big");
    size_t mask_len = masked ? 4 : 0;
    if (avail < header + mask_len + len) break;
    std::string payload(reinterpret_cast<const char*>(p + header + mask_len), static_cast<size_t>(len));
    if (masked) {
      const uint8_t* k = p + header;
      for (size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<char>(payload[i] ^ k[i & 3]);
    }
    pos += header + mask_len + static_cast<size_t>(len);

    bool control = op & 0x08;
    if (control) {
      if (!fin || len > 125) return fail(1002, "bad control frame");
      if (op == kPing) {
        if (h.ping) h.ping(std::move(payload));
      } else if (op == kPong) {
        if (h.pong) h.pong(std::move(payload));
      } else if (op == kClose) {
        uint16_t code = 1005;
        std::string reason;
        if (payload.size() >= 2) {
          code = static_cast<uint16_t>((uint8_t(payload[0]) << 8) | uint8_t(payload[1]));
          reason = payload.substr(2);
        }
        if (h.close) h.close(code, std::move(reason));
      } else {
        return fail(1002, "unknown control opcode");
      }
      continue;
    }
    if (op == kContinuation) {
      if (!in_message_) return fail(1002, "continuation without a message");
      if (message_.size() + payload.size() > max_message_) return fail(1009, "message too big");
      message_ += payload;
    } else if (op == kText || op == kBinary) {
      if (in_message_) return fail(1002, "new message inside a fragmented one");
      message_ = std::move(payload);
      message_opcode_ = op;
      in_message_ = true;
    } else {
      return fail(1002, "unknown data opcode");
    }
    if (fin) {
      in_message_ = false;
      std::string msg;
      msg.swap(message_);
      if (h.message) h.message(message_opcode_, std::move(msg));
    }
  }
  buf_.erase(0, pos);
  return true;
}

}  // namespace iwn::ws
