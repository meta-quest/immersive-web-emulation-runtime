// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/net/websocket.h"

#include <chrono>
#include <cstring>
#include <system_error>
#include <thread>

#include "iwn/net/watchdog.h"

namespace iwn::net {

namespace {
const char kWsGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
}  // namespace

std::vector<uint8_t> WsEncodeFrame(uint8_t opcode, bool fin, const uint8_t* payload, size_t len, bool mask) {
  std::vector<uint8_t> f;
  f.reserve(len + 14);
  f.push_back(static_cast<uint8_t>((fin ? 0x80 : 0) | (opcode & 0x0F)));
  uint8_t mask_bit = mask ? 0x80 : 0;
  if (len < 126) {
    f.push_back(static_cast<uint8_t>(mask_bit | len));
  } else if (len <= 0xFFFF) {
    f.push_back(mask_bit | 126);
    f.push_back(static_cast<uint8_t>(len >> 8));
    f.push_back(static_cast<uint8_t>(len));
  } else {
    f.push_back(mask_bit | 127);
    for (int i = 7; i >= 0; --i) f.push_back(static_cast<uint8_t>(static_cast<uint64_t>(len) >> (8 * i)));
  }
  uint8_t key[4] = {0, 0, 0, 0};
  if (mask) {
    SecureRandom(key, 4);
    f.insert(f.end(), key, key + 4);
  }
  size_t start = f.size();
  f.resize(start + len);
  for (size_t i = 0; i < len; ++i) f[start + i] = payload[i] ^ key[i & 3];
  return f;
}

std::string WsAcceptKey(const std::string& client_key) {
  std::string s = client_key + kWsGuid;
  uint8_t digest[20];
  Sha1(reinterpret_cast<const uint8_t*>(s.data()), s.size(), digest);
  return Base64Encode(digest, 20);
}

bool WsIsValidCloseCode(int code) {
  if (code >= 3000 && code <= 4999) return true;
  switch (code) {
    case 1000: case 1001: case 1002: case 1003: case 1007: case 1008:
    case 1009: case 1010: case 1011: case 1012: case 1013: case 1014:
      return true;
    default:
      return false;
  }
}

void WsFrameDecoder::Fail(std::vector<Event>* events, int code, const char* why) {
  failed_ = true;
  Event e(Event::kError);
  e.close_code = code;
  e.error = why;
  events->push_back(std::move(e));
}

void WsFrameDecoder::Feed(const uint8_t* data, size_t len, std::vector<Event>* events) {
  if (failed_) return;
  buf_.insert(buf_.end(), data, data + len);
  size_t pos = 0;
  while (!failed_) {
    size_t avail = buf_.size() - pos;
    if (avail < 2) break;
    const uint8_t* p = buf_.data() + pos;
    bool fin = p[0] & 0x80;
    uint8_t rsv = p[0] & 0x70;
    uint8_t opcode = p[0] & 0x0F;
    bool masked = p[1] & 0x80;
    uint64_t plen = p[1] & 0x7F;
    size_t hdr = 2;
    if (plen == 126) {
      if (avail < 4) break;
      plen = (uint64_t(p[2]) << 8) | p[3];
      hdr = 4;
      if (plen < 126) return Fail(events, 1002, "non-minimal frame length");
    } else if (plen == 127) {
      if (avail < 10) break;
      plen = 0;
      for (int i = 0; i < 8; ++i) plen = (plen << 8) | p[2 + i];
      hdr = 10;
      if (plen >> 63) return Fail(events, 1002, "frame length has the high bit set");
      if (plen <= 0xFFFF) return Fail(events, 1002, "non-minimal frame length");
    }
    if (rsv) return Fail(events, 1002, "reserved bits set without a negotiated extension");
    if (masked) return Fail(events, 1002, "server frames must not be masked");
    bool control = opcode & 0x08;
    if (control) {
      if (opcode != kWsClose && opcode != kWsPing && opcode != kWsPong) return Fail(events, 1002, "unknown control opcode");
      if (!fin) return Fail(events, 1002, "fragmented control frame");
      if (plen > 125) return Fail(events, 1002, "control frame payload over 125 bytes");
    } else {
      if (opcode != kWsContinuation && opcode != kWsText && opcode != kWsBinary) return Fail(events, 1002, "unknown data opcode");
      if (opcode == kWsContinuation && !in_message_) return Fail(events, 1002, "continuation without a message");
      if (opcode != kWsContinuation && in_message_) return Fail(events, 1002, "new message inside a fragmented message");
      if (message_.size() + plen > max_message_) return Fail(events, 1009, "message too big");
    }
    if (avail - hdr < plen) break;
    const uint8_t* payload = p + hdr;
    size_t n = static_cast<size_t>(plen);
    pos += hdr + n;
    if (control) {
      Event e(opcode == kWsClose ? Event::kClose : opcode == kWsPing ? Event::kPing : Event::kPong);
      if (opcode == kWsClose) {
        if (n == 1) return Fail(events, 1002, "close frame with a 1-byte payload");
        if (n >= 2) {
          e.close_code = (payload[0] << 8) | payload[1];
          if (!WsIsValidCloseCode(e.close_code)) return Fail(events, 1002, "invalid close code");
          Utf8Validator v;
          if (!v.Feed(payload + 2, n - 2) || !v.Complete()) return Fail(events, 1007, "close reason is not UTF-8");
          e.payload.assign(payload + 2, payload + n);
        } else {
          e.close_code = 1005;
        }
      } else {
        e.payload.assign(payload, payload + n);
      }
      events->push_back(std::move(e));
      continue;
    }
    if (opcode != kWsContinuation) {
      in_message_ = true;
      message_text_ = opcode == kWsText;
      message_.clear();
      utf8_.Reset();
    }
    if (message_text_ && !utf8_.Feed(payload, n)) return Fail(events, 1007, "text message is not UTF-8");
    message_.insert(message_.end(), payload, payload + n);
    if (fin) {
      if (message_text_ && !utf8_.Complete()) return Fail(events, 1007, "text message ends mid code point");
      Event e(Event::kMessage);
      e.text = message_text_;
      e.payload.swap(message_);
      events->push_back(std::move(e));
      in_message_ = false;
      message_.clear();
    }
  }
  buf_.erase(buf_.begin(), buf_.begin() + static_cast<long>(pos));
}

WsConnection::WsConnection(std::shared_ptr<Connector> connector, std::shared_ptr<WsListener> listener,
                           WsOptions options)
    : connector_(std::move(connector)), listener_(std::move(listener)), options_(std::move(options)) {}

WsConnection::~WsConnection() = default;

std::shared_ptr<WsConnection> WsConnection::Start(std::shared_ptr<Connector> connector, const OriginAllowlist& allowlist,
                                                  std::string url, std::vector<std::string> protocols,
                                                  std::shared_ptr<WsListener> listener, WsOptions options) {
  auto conn = std::make_shared<WsConnection>(std::move(connector), std::move(listener), std::move(options));
  try {
    std::thread([conn, allowlist, url, protocols]() mutable {
      conn->ReaderMain(std::move(allowlist), std::move(url), std::move(protocols));
    }).detach();
  } catch (const std::system_error&) {
    conn->FinishFailed({NetErrorKind::kIo, "cannot start a WebSocket thread"});
  }
  return conn;
}

void WsConnection::Enqueue(std::vector<uint8_t> frame, size_t app_bytes, bool is_close) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (close_sent_ || stopping_) return;
    if (is_close) close_sent_ = true;
    queue_.push_back({std::move(frame), app_bytes, is_close});
  }
  cv_.notify_all();
}

void WsConnection::Send(bool text, std::vector<uint8_t> data) {
  size_t n = data.size();
  Enqueue(WsEncodeFrame(text ? kWsText : kWsBinary, true, data.data(), n), n, false);
}

void WsConnection::Close(int code, std::string reason) {
  std::vector<uint8_t> payload;
  if (code) {
    payload.push_back(static_cast<uint8_t>(code >> 8));
    payload.push_back(static_cast<uint8_t>(code));
    payload.insert(payload.end(), reason.begin(), reason.end());
  }
  bool connecting;
  {
    std::lock_guard<std::mutex> lock(mu_);
    connecting = !open_;
  }
  if (connecting) {
    Abort();
    return;
  }
  Enqueue(WsEncodeFrame(kWsClose, true, payload.data(), payload.size()), 0, true);
}

void WsConnection::Abort() {
  std::shared_ptr<Stream> s;
  {
    std::lock_guard<std::mutex> lock(mu_);
    abort_requested_ = true;
    s = stream_;
  }
  connect_cancel_->Cancel();
  if (s) s->Abort();
  cv_.notify_all();
}

void WsConnection::WriterMain() {
  std::shared_ptr<Stream> stream;
  {
    std::lock_guard<std::mutex> lock(mu_);
    stream = stream_;
  }
  for (;;) {
    Outgoing out;
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait(lock, [&] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) break;
      out = std::move(queue_.front());
      queue_.pop_front();
    }
    NetError err;
    bool ok;
    {
      // Bounded even on transports without a write timeout (JNI).
      WatchdogScope deadline(30000, [stream] { stream->Abort(); });
      ok = stream->WriteAll(out.frame.data(), out.frame.size(), 30000, &err);
      if (deadline.Disarm()) ok = false;
    }
    if (!ok) {
      stream->Abort();  // the reader reports the failure
      break;
    }
    if (out.app_bytes) listener_->OnSent(out.app_bytes);
    if (out.is_close) break;
  }
  {
    std::lock_guard<std::mutex> lock(mu_);
    writer_done_ = true;
  }
  cv_.notify_all();
}

void WsConnection::FinishFailed(NetError err) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stopping_ = true;
    if (stream_) stream_->Abort();
  }
  cv_.notify_all();
  listener_->OnError(std::move(err));
  listener_->OnClose(1006, "", false);
}

void WsConnection::ReaderMain(OriginAllowlist allowlist, std::string url_str, std::vector<std::string> protocols) {
  SetCurrentThreadName("iwn-ws");
  ParsedUrl url;
  std::string why;
  if (!ParseUrl(url_str, &url, &why) || (url.scheme != "ws" && url.scheme != "wss")) {
    return FinishFailed({NetErrorKind::kProtocol, "invalid WebSocket URL: " + why});
  }
  if (allowlist.Check(url) != OriginAllowlist::Verdict::kAllowed) {
    return FinishFailed({NetErrorKind::kBlocked, url.HttpOrigin() + " is not in native.network.allow"});
  }
  NetError err;
  ConnectTarget target{url.host, url.port, url.secure(), url.HttpOrigin()};
  std::shared_ptr<Stream> stream;
  bool timed_out;
  {
    auto cancel = connect_cancel_;
    WatchdogScope deadline(options_.connect_timeout_ms, [cancel] { cancel->Cancel(); });
    stream = connector_->Connect(target, options_.connect_timeout_ms, &err, cancel.get());
    timed_out = deadline.Disarm();
  }
  if (!stream) {
    bool aborted;
    {
      std::lock_guard<std::mutex> lock(mu_);
      aborted = abort_requested_;
    }
    if (aborted) return FinishFailed({NetErrorKind::kAborted, "aborted"});
    if (timed_out) {
      return FinishFailed({NetErrorKind::kTimeout, "connecting took longer than " +
                                                        std::to_string(options_.connect_timeout_ms) + " ms"});
    }
    return FinishFailed(err);
  }
  {
    std::lock_guard<std::mutex> lock(mu_);
    stream_ = stream;
    if (abort_requested_) stream->Abort();
  }
  uint8_t key_bytes[16];
  SecureRandom(key_bytes, sizeof key_bytes);
  std::string key = Base64Encode(key_bytes, sizeof key_bytes);
  std::string req = "GET " + url.path_query + " HTTP/1.1\r\nHost: " + url.HostHeader() +
                    "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                    "\r\nSec-WebSocket-Version: 13\r\nOrigin: " + options_.origin + "\r\nUser-Agent: " +
                    options_.user_agent + "\r\n";
  if (!protocols.empty()) {
    req += "Sec-WebSocket-Protocol: ";
    for (size_t i = 0; i < protocols.size(); ++i) req += (i ? ", " : "") + protocols[i];
    req += "\r\n";
  }
  req += "\r\n";
  {
    WatchdogScope deadline(options_.connect_timeout_ms, [stream] { stream->Abort(); });
    bool ok = stream->WriteAll(reinterpret_cast<const uint8_t*>(req.data()), req.size(), options_.connect_timeout_ms, &err);
    if (deadline.Disarm()) return FinishFailed({NetErrorKind::kTimeout, "opening handshake timed out"});
    if (!ok) return FinishFailed(err);
  }
  HttpResponseParser parser;
  parser.Reset(false);
  std::vector<uint8_t> buf(64 * 1024), unused;
  std::vector<uint8_t> leftover;
  int64_t deadline = NowMs() + options_.connect_timeout_ms;
  while (parser.state() == HttpResponseParser::State::kHead) {
    int remaining = static_cast<int>(deadline - NowMs());
    if (remaining <= 0) return FinishFailed({NetErrorKind::kTimeout, "opening handshake timed out"});
    long n = stream->Read(buf.data(), buf.size(), remaining, &err);
    if (n < 0) return FinishFailed(err);
    if (n == 0) return FinishFailed({NetErrorKind::kClosed, "connection closed during the opening handshake"});
    size_t used = parser.Feed(buf.data(), static_cast<size_t>(n), &unused, true);
    if (parser.state() != HttpResponseParser::State::kHead) leftover.assign(buf.begin() + static_cast<long>(used), buf.begin() + n);
  }
  if (parser.state() == HttpResponseParser::State::kError) return FinishFailed({NetErrorKind::kProtocol, parser.error()});
  // RFC 6455 §4.1, client requirements 1-6 for the server's response.
  if (parser.status() != 101) {
    return FinishFailed({NetErrorKind::kProtocol, "expected 101 Switching Protocols, got " + std::to_string(parser.status())});
  }
  const std::string* upgrade = parser.Find("upgrade");
  const std::string* connection = parser.Find("connection");
  const std::string* accept = parser.Find("sec-websocket-accept");
  const std::string* extensions = parser.Find("sec-websocket-extensions");
  const std::string* protocol = parser.Find("sec-websocket-protocol");
  if (!upgrade || !HeaderHasToken(*upgrade, "websocket")) return FinishFailed({NetErrorKind::kProtocol, "missing Upgrade: websocket"});
  if (!connection || !HeaderHasToken(*connection, "upgrade")) return FinishFailed({NetErrorKind::kProtocol, "missing Connection: Upgrade"});
  if (!accept || TrimHttpWhitespace(*accept) != WsAcceptKey(key)) return FinishFailed({NetErrorKind::kProtocol, "bad Sec-WebSocket-Accept"});
  if (extensions && !TrimHttpWhitespace(*extensions).empty()) {
    return FinishFailed({NetErrorKind::kProtocol, "server selected an extension that was not offered"});
  }
  std::string selected;
  if (protocol) {
    selected = std::string(TrimHttpWhitespace(*protocol));
    bool offered = false;
    for (const auto& p : protocols) offered = offered || p == selected;
    if (!offered) return FinishFailed({NetErrorKind::kProtocol, "server selected a subprotocol that was not offered"});
  }
  {
    std::lock_guard<std::mutex> lock(mu_);
    open_ = true;
  }
  auto self = shared_from_this();
  try {
    std::thread([self] {
      SetCurrentThreadName("iwn-ws-write");
      self->WriterMain();
    }).detach();
  } catch (const std::system_error&) {
    return FinishFailed({NetErrorKind::kIo, "cannot start the WebSocket writer thread"});
  }
  listener_->OnOpen(selected, "");

  WsFrameDecoder decoder(options_.max_message);
  std::vector<WsFrameDecoder::Event> events;
  bool close_received = false;
  int close_code = 1005;
  std::string close_reason;
  int64_t close_deadline = 0;
  auto feed = [&](const uint8_t* p, size_t n) -> bool {
    events.clear();
    decoder.Feed(p, n, &events);
    for (auto& e : events) {
      switch (e.type) {
        case WsFrameDecoder::Event::kMessage:
          if (!close_received) listener_->OnMessage(e.text, std::move(e.payload));
          break;
        case WsFrameDecoder::Event::kPing:
          Enqueue(WsEncodeFrame(kWsPong, true, e.payload.data(), e.payload.size()), 0, false);
          break;
        case WsFrameDecoder::Event::kPong:
          break;
        case WsFrameDecoder::Event::kClose: {
          close_received = true;
          close_code = e.close_code;
          close_reason.assign(e.payload.begin(), e.payload.end());
          // Echo the status code (§5.5.1) unless we already sent a Close.
          std::vector<uint8_t> echo;
          if (close_code != 1005) {
            echo.push_back(static_cast<uint8_t>(close_code >> 8));
            echo.push_back(static_cast<uint8_t>(close_code));
          }
          Enqueue(WsEncodeFrame(kWsClose, true, echo.data(), echo.size()), 0, true);
          if (!close_deadline) close_deadline = NowMs() + options_.close_timeout_ms;
          return false;
        }
        case WsFrameDecoder::Event::kError: {
          std::vector<uint8_t> payload = {static_cast<uint8_t>(e.close_code >> 8), static_cast<uint8_t>(e.close_code)};
          Enqueue(WsEncodeFrame(kWsClose, true, payload.data(), payload.size()), 0, true);
          // Give the writer a moment to send the Close, then drop the connection.
          {
            std::unique_lock<std::mutex> lock(mu_);
            cv_.wait_for(lock, std::chrono::milliseconds(500), [&] { return writer_done_; });
          }
          FinishFailed({NetErrorKind::kProtocol, e.error});
          return false;
        }
      }
    }
    return true;
  };
  bool failed = false;
  if (!leftover.empty() && !feed(leftover.data(), leftover.size()) && !close_received) failed = true;
  while (!failed && !close_received) {
    bool sent;
    {
      std::lock_guard<std::mutex> lock(mu_);
      sent = close_sent_;
    }
    if (sent && !close_deadline) close_deadline = NowMs() + options_.close_timeout_ms;
    int timeout = close_deadline ? static_cast<int>(close_deadline - NowMs()) : 60 * 60 * 1000;
    if (timeout <= 0) break;  // the server never answered our Close
    long n = stream->Read(buf.data(), buf.size(), timeout, &err);
    if (n < 0 && err.kind == NetErrorKind::kTimeout && !close_deadline) continue;
    if (n <= 0) break;
    if (!feed(buf.data(), static_cast<size_t>(n)) && !close_received) failed = true;
  }
  if (failed) return;  // FinishFailed already reported
  if (close_received) {
    // Wait for our echo to go out, then for the server to close TCP (§7.1.1).
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait_for(lock, std::chrono::milliseconds(options_.close_timeout_ms), [&] { return writer_done_; });
    }
    while (true) {
      int timeout = static_cast<int>(close_deadline - NowMs());
      if (timeout <= 0) break;
      long n = stream->Read(buf.data(), buf.size(), timeout, &err);
      if (n <= 0) break;
    }
    {
      std::lock_guard<std::mutex> lock(mu_);
      stopping_ = true;
    }
    cv_.notify_all();
    stream->Abort();
    listener_->OnClose(close_code, std::move(close_reason), true);
    return;
  }
  bool aborted;
  {
    std::lock_guard<std::mutex> lock(mu_);
    aborted = abort_requested_;
  }
  FinishFailed({aborted ? NetErrorKind::kAborted : NetErrorKind::kClosed,
                aborted ? "aborted" : "connection closed without a closing handshake"});
}

}  // namespace iwn::net
