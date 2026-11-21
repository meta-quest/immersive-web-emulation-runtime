// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>

#include "iwn/net/stream.h"
#include "iwn/net/util.h"

namespace iwn::net {

const char* NetErrorName(NetErrorKind kind) {
  switch (kind) {
    case NetErrorKind::kNone: return "none";
    case NetErrorKind::kDns: return "dns";
    case NetErrorKind::kConnect: return "connect";
    case NetErrorKind::kTls: return "tls";
    case NetErrorKind::kTimeout: return "timeout";
    case NetErrorKind::kAborted: return "aborted";
    case NetErrorKind::kClosed: return "closed";
    case NetErrorKind::kProtocol: return "protocol";
    case NetErrorKind::kBlocked: return "blocked";
    case NetErrorKind::kUnsupported: return "unsupported";
    case NetErrorKind::kTooLarge: return "too-large";
    case NetErrorKind::kIo: return "io";
  }
  return "unknown";
}

bool ConnectCancel::Arm(std::function<void()> interrupt) {
  std::lock_guard<std::mutex> lock(mu_);
  if (cancelled_) return false;
  interrupt_ = std::move(interrupt);
  return true;
}

void ConnectCancel::Disarm() {
  std::lock_guard<std::mutex> lock(mu_);
  interrupt_ = nullptr;
}

void ConnectCancel::Cancel() {
  // The interrupt runs under the lock so Disarm() cannot return while it runs
  // (the connector may free what the interrupt touches right after Disarm).
  std::lock_guard<std::mutex> lock(mu_);
  if (cancelled_) return;
  cancelled_ = true;
  if (interrupt_) interrupt_();
  interrupt_ = nullptr;
}

bool ConnectCancel::cancelled() const {
  std::lock_guard<std::mutex> lock(mu_);
  return cancelled_;
}

namespace {

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

class PosixStream : public Stream {
 public:
  PosixStream(int fd, int abort_fd) : fd_(fd), abort_fd_(abort_fd) {}
  ~PosixStream() override {
    close(fd_);
    close(abort_fd_);
  }

  // Waits for `events` on the socket or the abort eventfd.
  // Returns 1 ready, 0 timeout, -1 aborted/error.
  int Wait(short events, int timeout_ms, NetError* err) {
    pollfd fds[2] = {{fd_, events, 0}, {abort_fd_, POLLIN, 0}};
    int64_t deadline = NowMs() + timeout_ms;
    for (;;) {
      if (aborted_.load()) {
        err->kind = NetErrorKind::kAborted;
        err->message = "aborted";
        return -1;
      }
      int remaining = static_cast<int>(deadline - NowMs());
      if (remaining < 0) remaining = 0;
      int r = poll(fds, 2, remaining);
      if (r < 0 && errno == EINTR) continue;
      if (r < 0) {
        err->kind = NetErrorKind::kIo;
        err->message = std::strerror(errno);
        return -1;
      }
      if (fds[1].revents) {
        err->kind = NetErrorKind::kAborted;
        err->message = "aborted";
        return -1;
      }
      if (r == 0) {
        err->kind = NetErrorKind::kTimeout;
        err->message = "timed out";
        return 0;
      }
      return 1;
    }
  }

  long Read(uint8_t* buf, size_t len, int timeout_ms, NetError* err) override {
    for (;;) {
      ssize_t n = recv(fd_, buf, len, 0);
      if (n >= 0) return static_cast<long>(n);
      if (errno == EINTR) continue;
      if (errno != EAGAIN && errno != EWOULDBLOCK) {
        err->kind = errno == ECONNRESET ? NetErrorKind::kClosed : NetErrorKind::kIo;
        err->message = std::strerror(errno);
        return -1;
      }
      if (Wait(POLLIN, timeout_ms, err) <= 0) return -1;
    }
  }

  bool WriteAll(const uint8_t* buf, size_t len, int timeout_ms, NetError* err) override {
    size_t done = 0;
    while (done < len) {
      ssize_t n = send(fd_, buf + done, len - done, MSG_NOSIGNAL);
      if (n >= 0) {
        done += static_cast<size_t>(n);
        continue;
      }
      if (errno == EINTR) continue;
      if (errno != EAGAIN && errno != EWOULDBLOCK) {
        err->kind = (errno == EPIPE || errno == ECONNRESET) ? NetErrorKind::kClosed : NetErrorKind::kIo;
        err->message = std::strerror(errno);
        return false;
      }
      if (Wait(POLLOUT, timeout_ms, err) <= 0) return false;
    }
    return true;
  }

  void Abort() override {
    if (aborted_.exchange(true)) return;
    uint64_t one = 1;
    ssize_t ignored = write(abort_fd_, &one, sizeof one);
    (void)ignored;
  }

  bool secure() const override { return false; }

 private:
  int fd_;
  int abort_fd_;
  std::atomic<bool> aborted_{false};
};

class PosixConnector : public Connector {
 public:
  std::unique_ptr<Stream> Connect(const ConnectTarget& target, int timeout_ms, NetError* err,
                                  ConnectCancel* cancel) override {
    if (target.tls) {
      err->kind = NetErrorKind::kUnsupported;
      err->message = "TLS is not available in the host build (plain TCP only)";
      return nullptr;
    }
    std::string host = target.host;
    if (host.size() > 2 && host.front() == '[') host = host.substr(1, host.size() - 2);
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    std::string port = std::to_string(target.port);
    int gai = getaddrinfo(host.c_str(), port.c_str(), &hints, &res);
    if (gai != 0 || !res) {
      err->kind = NetErrorKind::kDns;
      err->message = std::string("cannot resolve ") + host + ": " + gai_strerror(gai);
      return nullptr;
    }
    int64_t deadline = NowMs() + timeout_ms;
    std::string last_error = "no address";
    for (addrinfo* ai = res; ai; ai = ai->ai_next) {
      int fd = socket(ai->ai_family, ai->ai_socktype | SOCK_CLOEXEC | SOCK_NONBLOCK, ai->ai_protocol);
      if (fd < 0) continue;
      int abort_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
      if (abort_fd < 0) {
        close(fd);
        continue;
      }
      auto stream = std::make_unique<PosixStream>(fd, abort_fd);
      PosixStream* raw = stream.get();
      if (cancel && !cancel->Arm([raw] { raw->Abort(); })) {
        freeaddrinfo(res);
        *err = {NetErrorKind::kAborted, "aborted"};
        return nullptr;
      }
      struct DisarmGuard {
        ConnectCancel* c;
        ~DisarmGuard() {
          if (c) c->Disarm();
        }
      } disarm_guard{cancel};
      int one = 1;
      setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
      int r = connect(fd, ai->ai_addr, ai->ai_addrlen);
      if (r != 0 && errno != EINPROGRESS) {
        last_error = std::strerror(errno);
        continue;
      }
      if (r != 0) {
        NetError werr;
        int remaining = static_cast<int>(deadline - NowMs());
        if (remaining <= 0 || stream->Wait(POLLOUT, remaining, &werr) <= 0) {
          last_error = werr.message.empty() ? "connect timed out" : werr.message;
          if (werr.kind == NetErrorKind::kAborted) {
            freeaddrinfo(res);
            *err = werr;
            return nullptr;
          }
          if (werr.kind == NetErrorKind::kTimeout || remaining <= 0) {
            freeaddrinfo(res);
            err->kind = NetErrorKind::kTimeout;
            err->message = "connect to " + host + " timed out";
            return nullptr;
          }
          continue;
        }
        int so_error = 0;
        socklen_t sl = sizeof so_error;
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_error, &sl);
        if (so_error != 0) {
          last_error = std::strerror(so_error);
          continue;
        }
      }
      freeaddrinfo(res);
      return stream;
    }
    freeaddrinfo(res);
    err->kind = NetErrorKind::kConnect;
    err->message = "cannot connect to " + host + ":" + port + ": " + last_error;
    return nullptr;
  }
};

}  // namespace

std::unique_ptr<Connector> MakePosixConnector() { return std::make_unique<PosixConnector>(); }

bool ProxyConnectTunnel(Stream* stream, const std::string& host, int port, int timeout_ms, NetError* err) {
  std::string authority = host + ":" + std::to_string(port);
  std::string req = "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n";
  if (!stream->WriteAll(reinterpret_cast<const uint8_t*>(req.data()), req.size(), timeout_ms, err)) return false;
  // Read byte-wise up to the end of the reply head so no tunnelled bytes are
  // consumed (the proxy sends nothing after its head until we speak).
  std::string head;
  uint8_t c;
  while (head.size() < 8192) {
    long n = stream->Read(&c, 1, timeout_ms, err);
    if (n <= 0) {
      if (n == 0) {
        err->kind = NetErrorKind::kConnect;
        err->message = "proxy closed the connection";
      }
      return false;
    }
    head.push_back(static_cast<char>(c));
    if (head.size() >= 4 && head.compare(head.size() - 4, 4, "\r\n\r\n") == 0) break;
  }
  // "HTTP/1.x 200 ..."
  if (head.size() < 12 || head.compare(0, 5, "HTTP/") != 0 || head.compare(9, 3, "200") != 0) {
    err->kind = NetErrorKind::kConnect;
    err->message = "proxy refused CONNECT: " + head.substr(0, head.find('\r'));
    return false;
  }
  return true;
}

}  // namespace iwn::net
