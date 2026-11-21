#include "iwn/core/loopback_server.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <chrono>
#include <cstddef>
#include <cstring>

#include "iwn/core/log.h"

namespace iwn {

struct LoopbackServer::Conn {
  uint64_t id = 0;
  int fd = -1;
  int local_port = 0;
  enum class State { kHttp, kWebSocket, kClosing } state = State::kHttp;
  int kind = -1;
  std::string in;
  std::string out;  // bytes being written
  size_t out_off = 0;
  std::deque<std::string> queue;  // moved from pending_ on the server thread
  ws::FrameParser parser{true};
  bool close_after_flush = false;
  bool opened = false;
};

namespace {
void set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
}  // namespace

LoopbackServer::LoopbackServer() = default;
LoopbackServer::~LoopbackServer() { stop(); }

namespace {
// One bind attempt to 127.0.0.1:port (never a non-loopback interface, CDP-1). Returns 0 or errno.
int bind_loopback(int fd, int port) {
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  return bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0 ? 0 : errno;
}
}  // namespace

int LoopbackServer::open_socket() const {
  int fd = socket(abstract_base_.empty() ? AF_INET : AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd >= 0 && abstract_base_.empty()) {
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  }
  return fd;
}

int LoopbackServer::bind_endpoint(int fd, int port) const {
  if (abstract_base_.empty()) return bind_loopback(fd, port);
  const std::string name = abstract_base_ + "_" + std::to_string(port);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  if (name.size() + 1 > sizeof(addr.sun_path)) return ENAMETOOLONG;
  std::memcpy(addr.sun_path + 1, name.data(), name.size());  // sun_path[0] == 0: the abstract namespace
  const socklen_t len = static_cast<socklen_t>(offsetof(sockaddr_un, sun_path) + 1 + name.size());
  return bind(fd, reinterpret_cast<sockaddr*>(&addr), len) == 0 ? 0 : errno;
}

std::string LoopbackServer::endpoint(int port) const {
  if (abstract_base_.empty()) return "127.0.0.1:" + std::to_string(port);
  return "@" + abstract_base_ + "_" + std::to_string(port);
}

bool LoopbackServer::peer_allowed(int fd) const {
  if (abstract_base_.empty()) return true;
#if defined(SO_PEERCRED)
  ucred cred{};
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) return false;
  constexpr uid_t kShellUid = 2000;  // AID_SHELL: adbd, so `adb forward` connections
  return cred.uid == 0 || cred.uid == kShellUid || cred.uid == getuid();
#else
  (void)fd;
  return false;
#endif
}

bool LoopbackServer::add_listener(int fd, int port) {
  if (listen(fd, 16) != 0) {
    close(fd);
    return false;
  }
  int bound = port;
  if (abstract_base_.empty()) {
    sockaddr_in addr{};
    socklen_t len = sizeof(addr);
    getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &len);
    bound = ntohs(addr.sin_port);
  }
  set_nonblocking(fd);
  listen_fds_.push_back(fd);
  {
    std::lock_guard<std::mutex> lock(mu_);
    bound_ports_.push_back(bound);
  }
  (void)port;
  if (cb_.on_listening) cb_.on_listening(bound);
  return true;
}

bool LoopbackServer::start(const std::vector<int>& ports, Callbacks callbacks, std::string* error, int retry_ms) {
  if (running_) return true;
  cb_ = std::move(callbacks);
  for (int port : ports) {
    int fd = open_socket();
    if (fd < 0) {
      if (error) *error = std::string("socket: ") + strerror(errno);
      stop();
      return false;
    }
    int err = bind_endpoint(fd, port);
    if (err == EADDRINUSE && retry_ms > 0 && port != 0) {
      log(LogLevel::kWarn,
          "%s is still in use (a previous instance shutting down?); retrying in the background for %d s",
          endpoint(port).c_str(), retry_ms / 1000);
      pending_binds_.push_back({fd, port, std::chrono::steady_clock::now() + std::chrono::milliseconds(retry_ms)});
      continue;
    }
    if (err != 0 || !add_listener(fd, port)) {
      if (error) *error = "bind/listen " + endpoint(port) + ": " + strerror(err ? err : errno);
      if (err != 0) close(fd);
      stop();
      return false;
    }
  }
  pending_count_ = pending_binds_.size();
  int p[2];
  if (pipe2(p, O_CLOEXEC | O_NONBLOCK) != 0) {
    if (error) *error = "pipe2 failed";
    stop();
    return false;
  }
  wake_r_ = p[0];
  wake_w_ = p[1];
  stopping_ = false;
  running_ = true;
  thread_ = std::thread([this] { loop(); });
  return true;
}

void LoopbackServer::retry_pending_binds() {
  auto now = std::chrono::steady_clock::now();
  for (auto it = pending_binds_.begin(); it != pending_binds_.end();) {
    int err = bind_endpoint(it->fd, it->port);
    if (err == 0) {
      if (add_listener(it->fd, it->port)) {
        log(LogLevel::kInfo, "%s released by its previous holder; now listening", endpoint(it->port).c_str());
      } else {
        log(LogLevel::kError, "listen %s failed: %s", endpoint(it->port).c_str(), strerror(errno));
      }
      it = pending_binds_.erase(it);
    } else if (err != EADDRINUSE || now >= it->deadline) {
      log(LogLevel::kError, "%s: %s; giving up (restart the app to get this endpoint back)",
          endpoint(it->port).c_str(), err == EADDRINUSE ? "still in use" : strerror(err));
      close(it->fd);
      it = pending_binds_.erase(it);
    } else {
      ++it;
    }
  }
  pending_count_ = pending_binds_.size();
}

std::vector<int> LoopbackServer::bound_ports() const {
  std::lock_guard<std::mutex> lock(mu_);
  return bound_ports_;
}

size_t LoopbackServer::pending_port_count() const { return pending_count_.load(); }

void LoopbackServer::stop() {
  if (running_) {
    stopping_ = true;
    wake();
    if (thread_.joinable()) thread_.join();
    running_ = false;
  }
  for (int fd : listen_fds_) close(fd);
  listen_fds_.clear();
  for (auto& pb : pending_binds_) close(pb.fd);
  pending_binds_.clear();
  pending_count_ = 0;
  {
    std::lock_guard<std::mutex> lock(mu_);
    bound_ports_.clear();
    for (auto& kv : conns_) {
      if (kv.second->fd >= 0) close(kv.second->fd);
    }
    conns_.clear();
    pending_.clear();
    close_requests_.clear();
  }
  if (wake_r_ >= 0) close(wake_r_);
  if (wake_w_ >= 0) close(wake_w_);
  wake_r_ = wake_w_ = -1;
}

void LoopbackServer::wake() {
  if (wake_w_ >= 0) {
    char b = 1;
    ssize_t n = write(wake_w_, &b, 1);
    (void)n;
  }
}

bool LoopbackServer::send_text(uint64_t conn, std::string_view text) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (!conns_.count(conn)) return false;
    pending_[conn].push_back(ws::encode_frame(ws::kText, text));
  }
  wake();
  return true;
}

void LoopbackServer::close_connection(uint64_t conn) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    close_requests_.push_back(conn);
  }
  wake();
}

size_t LoopbackServer::connection_count() const {
  std::lock_guard<std::mutex> lock(mu_);
  return conns_.size();
}

void LoopbackServer::drop(uint64_t id) {
  std::unique_ptr<Conn> c;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = conns_.find(id);
    if (it == conns_.end()) return;
    c = std::move(it->second);
    conns_.erase(it);
    pending_.erase(id);
  }
  if (c->fd >= 0) close(c->fd);
  if (c->opened && cb_.on_close) cb_.on_close(id);
}

void LoopbackServer::flush(Conn& c) {
  for (;;) {
    if (c.out_off >= c.out.size()) {
      c.out.clear();
      c.out_off = 0;
      if (c.queue.empty()) break;
      c.out = std::move(c.queue.front());
      c.queue.pop_front();
    }
    ssize_t n = send(c.fd, c.out.data() + c.out_off, c.out.size() - c.out_off, MSG_NOSIGNAL);
    if (n > 0) {
      c.out_off += static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    if (n < 0 && errno == EINTR) continue;
    c.close_after_flush = true;  // broken pipe: drop
    c.out.clear();
    c.queue.clear();
    c.out_off = 0;
    c.state = Conn::State::kClosing;
    return;
  }
}

void LoopbackServer::handle_http(Conn& c) {
  ws::HttpRequest req;
  size_t consumed = 0;
  ws::ParseResult r = ws::parse_http_request(c.in, req, &consumed);
  if (r == ws::ParseResult::kIncomplete) return;
  if (r == ws::ParseResult::kBad) {
    c.queue.push_back(ws::http_response(400, "Bad Request", "text/plain", "bad request\n"));
    c.close_after_flush = true;
    c.state = Conn::State::kClosing;
    return;
  }
  c.in.erase(0, consumed);
  if (!ws::is_loopback_host(req.header("Host"))) {
    c.queue.push_back(ws::http_response(403, "Forbidden", "text/plain", "Host header must name localhost\n"));
    c.close_after_flush = true;
    c.state = Conn::State::kClosing;
    return;
  }
  ws::UpgradeCheck up = ws::check_upgrade(req);
  if (up.is_upgrade) {
    if (!up.ok) {
      std::string extra = up.status == 426 ? "Sec-WebSocket-Version: 13\r\n" : "";
      const char* reason = up.status == 426   ? "Upgrade Required"
                           : up.status == 403 ? "Forbidden"
                           : up.status == 405 ? "Method Not Allowed"
                                              : "Bad Request";
      c.queue.push_back(ws::http_response(up.status, reason,
                                          "text/plain", up.reason + "\n", extra));
      c.close_after_flush = true;
      c.state = Conn::State::kClosing;
      return;
    }
    std::optional<int> kind = cb_.accept_ws ? cb_.accept_ws(req.path(), c.local_port) : std::nullopt;
    if (!kind) {
      c.queue.push_back(ws::http_response(404, "Not Found", "text/plain", "no such target\n"));
      c.close_after_flush = true;
      c.state = Conn::State::kClosing;
      return;
    }
    c.queue.push_back(ws::handshake_response(ws::accept_key(*req.header("Sec-WebSocket-Key"))));
    c.state = Conn::State::kWebSocket;
    c.kind = *kind;
    c.opened = true;
    if (cb_.on_open) cb_.on_open(c.id, c.kind, req.path());
    return;
  }
  std::string resp = cb_.http ? cb_.http(req, c.local_port)
                              : ws::http_response(404, "Not Found", "text/plain", "not found\n");
  c.queue.push_back(std::move(resp));
  c.close_after_flush = true;
  c.state = Conn::State::kClosing;
}

void LoopbackServer::feed_ws(Conn& c, std::string_view data) {
  uint64_t id = c.id;
  ws::FrameParser::Handlers h;
  h.message = [this, id](ws::Opcode, std::string&& payload) {
    if (cb_.on_message) cb_.on_message(id, std::move(payload));
  };
  h.ping = [&c](std::string&& payload) { c.queue.push_back(ws::encode_frame(ws::kPong, payload)); };
  h.close = [&c](uint16_t code, std::string&&) {
    c.queue.push_back(ws::encode_close(code == 1005 ? 1000 : code));
    c.close_after_flush = true;
    c.state = Conn::State::kClosing;
  };
  h.error = [&c](uint16_t code, const char*) {
    c.queue.push_back(ws::encode_close(code));
    c.close_after_flush = true;
    c.state = Conn::State::kClosing;
  };
  c.parser.feed(data, h);
}

void LoopbackServer::handle_readable(Conn& c) {
  char buf[65536];
  auto hard_close = [&c] {
    c.close_after_flush = true;
    c.out.clear();
    c.queue.clear();
    c.out_off = 0;
    c.state = Conn::State::kClosing;
  };
  for (;;) {
    ssize_t n = recv(c.fd, buf, sizeof(buf), 0);
    if (n > 0) {
      if (c.state == Conn::State::kHttp) {
        c.in.append(buf, static_cast<size_t>(n));
        handle_http(c);
        // Bytes after the handshake (a client that pipelines its first frame) belong to the WebSocket.
        if (c.state == Conn::State::kWebSocket && !c.in.empty()) {
          std::string rest;
          rest.swap(c.in);
          feed_ws(c, rest);
        }
      } else if (c.state == Conn::State::kWebSocket) {
        feed_ws(c, std::string_view(buf, static_cast<size_t>(n)));
      }
      continue;
    }
    if (n == 0) {
      hard_close();
      return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) return;
    if (errno == EINTR) continue;
    hard_close();
    return;
  }
}

void LoopbackServer::loop() {
  pthread_setname_np(pthread_self(), "iwn-inspector");
  std::vector<pollfd> fds;
  std::vector<uint64_t> ids;
  while (!stopping_) {
    if (!pending_binds_.empty()) retry_pending_binds();
    // Move queued frames and close requests to their connections.
    std::vector<uint64_t> closes;
    {
      std::lock_guard<std::mutex> lock(mu_);
      for (auto& kv : pending_) {
        auto it = conns_.find(kv.first);
        if (it == conns_.end()) continue;
        for (auto& f : kv.second) it->second->queue.push_back(std::move(f));
      }
      pending_.clear();
      closes.swap(close_requests_);
    }
    for (uint64_t id : closes) {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = conns_.find(id);
      if (it == conns_.end()) continue;
      it->second->queue.push_back(ws::encode_close(1000));
      it->second->close_after_flush = true;
      it->second->state = Conn::State::kClosing;
    }

    fds.clear();
    ids.clear();
    fds.push_back({wake_r_, POLLIN, 0});
    ids.push_back(0);
    for (int lfd : listen_fds_) {
      fds.push_back({lfd, POLLIN, 0});
      ids.push_back(0);
    }
    std::vector<Conn*> conns;
    {
      std::lock_guard<std::mutex> lock(mu_);
      for (auto& kv : conns_) conns.push_back(kv.second.get());
    }
    for (Conn* c : conns) {
      // Try writing first; drop finished closing connections.
      flush(*c);
      bool has_out = c->out_off < c->out.size() || !c->queue.empty();
      if (c->close_after_flush && !has_out) {
        drop(c->id);
        continue;
      }
      short ev = POLLIN;
      if (has_out) ev |= POLLOUT;
      fds.push_back({c->fd, ev, 0});
      ids.push_back(c->id);
    }
    int rc = poll(fds.data(), fds.size(), pending_binds_.empty() ? 1000 : 100);
    if (rc < 0) {
      if (errno == EINTR) continue;
      log(LogLevel::kError, "inspector server: poll failed: %s", strerror(errno));
      break;
    }
    if (fds[0].revents & POLLIN) {
      char drain[64];
      while (read(wake_r_, drain, sizeof(drain)) > 0) {
      }
    }
    for (size_t i = 0; i < listen_fds_.size(); ++i) {
      if (!(fds[1 + i].revents & POLLIN)) continue;
      for (;;) {
        sockaddr_storage peer{};
        socklen_t len = sizeof(peer);
        int fd = accept4(listen_fds_[i], reinterpret_cast<sockaddr*>(&peer), &len, SOCK_CLOEXEC | SOCK_NONBLOCK);
        if (fd < 0) break;
        if (!peer_allowed(fd)) {
          log(LogLevel::kWarn, "refused a connection to the debug socket from another app (only adb and this app)");
          close(fd);
          continue;
        }
        if (abstract_base_.empty()) {
          int one = 1;
          setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
        }
        auto c = std::make_unique<Conn>();
        c->fd = fd;
        std::lock_guard<std::mutex> lock(mu_);
        c->local_port = bound_ports_[i];
        c->id = next_id_++;
        conns_[c->id] = std::move(c);
      }
    }
    for (size_t i = 1 + listen_fds_.size(); i < fds.size(); ++i) {
      Conn* c = nullptr;
      {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = conns_.find(ids[i]);
        if (it != conns_.end()) c = it->second.get();
      }
      if (!c) continue;
      if (fds[i].revents & (POLLERR | POLLNVAL)) {
        drop(c->id);
        continue;
      }
      if (fds[i].revents & (POLLIN | POLLHUP)) handle_readable(*c);
      if (fds[i].revents & POLLOUT) flush(*c);
    }
  }
  // Close all connections on stop.
  std::vector<uint64_t> all;
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (auto& kv : conns_) all.push_back(kv.first);
  }
  for (uint64_t id : all) drop(id);
}

}  // namespace iwn
