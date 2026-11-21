// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Byte-stream transport under the HTTP/1.1 and WebSocket cores.
//
// Transport decision (see runtime/net/README.md): TLS, certificate
// validation against the system trust store, SNI, hostname verification and
// the system proxy come from the Android platform's own TLS stack
// (javax.net.ssl / Conscrypt) through JNI (JniConnector, android only). The
// host build has PosixConnector (plain TCP, used by tests and the headless
// runner's loopback servers). The protocol cores never see the difference.

#ifndef IWN_NET_STREAM_H_
#define IWN_NET_STREAM_H_

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

namespace iwn::net {

enum class NetErrorKind {
  kNone = 0,
  kDns,           // host not found
  kConnect,       // refused / unreachable
  kTls,           // handshake or certificate failure (NET-6)
  kTimeout,
  kAborted,       // Abort() called
  kClosed,        // peer closed before the message was complete
  kProtocol,      // malformed HTTP / WebSocket data
  kBlocked,       // allowlist (NET-5)
  kUnsupported,   // e.g. TLS on the host build
  kTooLarge,
  kIo,
};

const char* NetErrorName(NetErrorKind kind);

struct NetError {
  NetErrorKind kind = NetErrorKind::kNone;
  std::string message;
  explicit operator bool() const { return kind != NetErrorKind::kNone; }
};

class Stream {
 public:
  virtual ~Stream() = default;
  // Reads up to `len` bytes. Returns >0 bytes read, 0 on orderly EOF, -1 on
  // error (sets *err). Waits at most `timeout_ms` (kTimeout).
  virtual long Read(uint8_t* buf, size_t len, int timeout_ms, NetError* err) = 0;
  virtual bool WriteAll(const uint8_t* buf, size_t len, int timeout_ms, NetError* err) = 0;
  // Thread-safe: unblocks pending Read/WriteAll on other threads, which then
  // fail with kAborted. Idempotent.
  virtual void Abort() = 0;
  virtual bool secure() const = 0;
};

struct ConnectTarget {
  std::string host;  // as in the URL (IPv6 with brackets)
  int port = 0;
  bool tls = false;
  // Origin used for proxy selection ("https://host:port").
  std::string proxy_lookup_url;
};

// Lets another thread interrupt a Connect() in progress (fetch abort,
// WebSocket close() while CONNECTING). The connector arms it with a function
// that unblocks its current step (closing the socket); Cancel() runs that
// function. Cancellation is sticky. Thread-safe.
class ConnectCancel {
 public:
  // Installs `interrupt`; returns false (and does not install it) when
  // Cancel() already happened, in which case the connector must give up.
  bool Arm(std::function<void()> interrupt);
  // Removes the function; after Disarm returns, it is not running and will
  // not run.
  void Disarm();
  void Cancel();
  bool cancelled() const;

 private:
  mutable std::mutex mu_;
  std::function<void()> interrupt_;
  bool cancelled_ = false;
};

class Connector {
 public:
  virtual ~Connector() = default;
  // Blocking; background threads only. Performs DNS, TCP connect, an HTTP
  // proxy CONNECT tunnel when the system has a proxy for the target, and the
  // TLS handshake with certificate + hostname verification when target.tls.
  // `timeout_ms` bounds the whole sequence (connect + tunnel + handshake);
  // DNS is bounded by the system resolver's own timeouts. `cancel` (may be
  // null) interrupts it: the call then fails with kAborted.
  virtual std::unique_ptr<Stream> Connect(const ConnectTarget& target, int timeout_ms, NetError* err,
                                          ConnectCancel* cancel = nullptr) = 0;
};

// Plain TCP via BSD sockets. TLS targets fail with kUnsupported.
std::unique_ptr<Connector> MakePosixConnector();

// Shared helper: send "CONNECT host:port" over `stream` and read the proxy's
// reply. Used by connectors that tunnel through an HTTP proxy.
bool ProxyConnectTunnel(Stream* stream, const std::string& host, int port, int timeout_ms, NetError* err);

}  // namespace iwn::net

#endif  // IWN_NET_STREAM_H_
