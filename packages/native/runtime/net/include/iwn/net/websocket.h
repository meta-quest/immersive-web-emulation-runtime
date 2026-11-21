// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// RFC 6455 WebSocket client core: opening handshake (§4.1/§4.2.2 checks),
// framing (§5: client masking, fragmentation, control frames, RSV bits,
// 64-bit lengths), UTF-8 validation of text messages (§8.1), ping/pong,
// the closing handshake (§7) and status codes (§7.4). No extensions are
// offered (no permessage-deflate). Used by the JS WebSocket class
// (WHATWG WebSockets Standard) through the net module binding.

#ifndef IWN_NET_WEBSOCKET_H_
#define IWN_NET_WEBSOCKET_H_

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "iwn/net/http.h"
#include "iwn/net/stream.h"
#include "iwn/net/url.h"
#include "iwn/net/util.h"

namespace iwn::net {

enum WsOpcode : uint8_t {
  kWsContinuation = 0x0,
  kWsText = 0x1,
  kWsBinary = 0x2,
  kWsClose = 0x8,
  kWsPing = 0x9,
  kWsPong = 0xA,
};

// Encodes one frame. Client frames are masked with a fresh random key.
std::vector<uint8_t> WsEncodeFrame(uint8_t opcode, bool fin, const uint8_t* payload, size_t len, bool mask = true);

// base64(SHA-1(key + GUID)), RFC 6455 §1.3.
std::string WsAcceptKey(const std::string& client_key);

// Incremental decoder for frames sent by a server.
class WsFrameDecoder {
 public:
  struct Event {
    enum Type { kMessage, kPing, kPong, kClose, kError };
    explicit Event(Type t) : type(t) {}
    Type type;
    bool text = false;
    std::vector<uint8_t> payload;  // message data / ping data / close reason (UTF-8)
    int close_code = 0;            // kClose: 1005 when absent; kError: the code to fail with
    std::string error;
  };
  explicit WsFrameDecoder(size_t max_message = 64u << 20) : max_message_(max_message) {}
  // Appends decoded events to *events. After a kError event the decoder stops.
  void Feed(const uint8_t* data, size_t len, std::vector<Event>* events);

 private:
  void Fail(std::vector<Event>* events, int code, const char* why);
  size_t max_message_;
  std::vector<uint8_t> buf_;
  std::vector<uint8_t> message_;
  bool in_message_ = false;
  bool message_text_ = false;
  Utf8Validator utf8_;
  bool failed_ = false;
};

// True for a status code an endpoint may send in a Close frame (§7.4).
bool WsIsValidCloseCode(int code);

class WsListener {
 public:
  virtual ~WsListener() = default;
  virtual void OnOpen(std::string protocol, std::string extensions) = 0;
  virtual void OnMessage(bool text, std::vector<uint8_t> data) = 0;
  // `bytes` of application data handed to the transport (bufferedAmount).
  virtual void OnSent(size_t bytes) = 0;
  // Failure ("fail the WebSocket connection"): followed by OnClose(1006, "", false).
  virtual void OnError(NetError error) = 0;
  virtual void OnClose(int code, std::string reason, bool was_clean) = 0;
};

struct WsOptions {
  std::string origin = "https://app.local";
  std::string user_agent = "iwer-native";
  int connect_timeout_ms = 30000;
  int close_timeout_ms = 5000;
  size_t max_message = 64u << 20;
};

// One connection. Callbacks run on the connection's reader thread.
class WsConnection : public std::enable_shared_from_this<WsConnection> {
 public:
  static std::shared_ptr<WsConnection> Start(std::shared_ptr<Connector> connector, const OriginAllowlist& allowlist,
                                             std::string url, std::vector<std::string> protocols,
                                             std::shared_ptr<WsListener> listener, WsOptions options);
  ~WsConnection();
  // Queue a message (thread-safe). Ignored once closing.
  void Send(bool text, std::vector<uint8_t> data);
  // Start the closing handshake (code 0 = no code). Thread-safe.
  void Close(int code, std::string reason);
  // Drop the connection now (no closing handshake); OnClose(1006) follows.
  void Abort();

  WsConnection(std::shared_ptr<Connector> connector, std::shared_ptr<WsListener> listener, WsOptions options);

 private:
  void ReaderMain(OriginAllowlist allowlist, std::string url, std::vector<std::string> protocols);
  void WriterMain();
  void Enqueue(std::vector<uint8_t> frame, size_t app_bytes, bool is_close);
  void FinishFailed(NetError err);

  std::shared_ptr<Connector> connector_;
  std::shared_ptr<WsListener> listener_;
  WsOptions options_;
  std::mutex mu_;
  std::condition_variable cv_;
  struct Outgoing {
    std::vector<uint8_t> frame;
    size_t app_bytes;
    bool is_close;
  };
  std::deque<Outgoing> queue_;
  std::shared_ptr<Stream> stream_;
  // Interrupts the connect (DNS/TCP/proxy/TLS) when Abort() or close() runs
  // while CONNECTING; the connect is also bounded by connect_timeout_ms.
  std::shared_ptr<ConnectCancel> connect_cancel_ = std::make_shared<ConnectCancel>();
  bool open_ = false;
  bool close_sent_ = false;
  bool writer_done_ = false;
  bool stopping_ = false;
  bool abort_requested_ = false;
};

}  // namespace iwn::net

#endif  // IWN_NET_WEBSOCKET_H_
