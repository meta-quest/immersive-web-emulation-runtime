/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Loopback-only HTTP + WebSocket server on its own thread (CDP-1..4, CDP-10, DBG-1, DBG-7), V8-free.
// Serves one or more ports bound to 127.0.0.1. Socket I/O and frame parsing never run on the JS thread; complete
// messages are handed to callbacks on the server thread (the V8 layer posts them to the JS thread). Every outgoing
// message is one unfragmented text frame; writes are non-blocking and queued, so multi-MB replies never block the
// sender.
#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "iwn/core/websocket.h"

namespace iwn {

class LoopbackServer {
 public:
  struct Callbacks {
    // A plain HTTP request (not an upgrade). Returns the complete response bytes. Server thread.
    std::function<std::string(const ws::HttpRequest& req, int local_port)> http;
    // A WebSocket upgrade for `path`: return a channel kind (>= 0) to accept, or nullopt to answer 404.
    std::function<std::optional<int>(const std::string& path, int local_port)> accept_ws;
    std::function<void(uint64_t conn, int kind, const std::string& path)> on_open;
    std::function<void(uint64_t conn, std::string&& text)> on_message;
    std::function<void(uint64_t conn)> on_close;
    // A port is listening (from start() for ports bound at once, from the server thread for retried ones).
    std::function<void(int port)> on_listening;
  };

  LoopbackServer();
  ~LoopbackServer();

  // Binds 127.0.0.1:<port> for every port (0 = ephemeral, for tests) and starts the thread. A port still held by a
  // previous instance (EADDRINUSE, e.g. an old activity whose page is stuck until its quit watchdog fires) is
  // retried on the server thread every 100 ms for up to retry_ms, so start() never blocks the caller; with
  // retry_ms == 0 a busy port fails start(). Other bind errors fail start().
  bool start(const std::vector<int>& ports, Callbacks callbacks, std::string* error, int retry_ms = 30000);
  // Before start(): listen on abstract Unix sockets named "<base>_<port>" instead of 127.0.0.1:<port> (Android,
  // CDP-1). Any app on the device can reach a loopback TCP port; a Unix socket tells who connects, and only root,
  // the shell (adb forward ... localabstract:<base>_<port>) and this app's own uid are served.
  void set_abstract_name(std::string base) { abstract_base_ = std::move(base); }
  void stop();
  bool running() const { return running_.load(); }
  std::vector<int> bound_ports() const;
  // Ports still waiting for a previous holder to release them.
  size_t pending_port_count() const;

  // Thread-safe. Queues one text frame. Returns false if the connection is gone.
  bool send_text(uint64_t conn, std::string_view text);
  // Thread-safe. Sends a close frame after queued data and closes the socket.
  void close_connection(uint64_t conn);
  size_t connection_count() const;

 private:
  struct Conn;
  void loop();
  void wake();
  void handle_readable(Conn& c);
  void feed_ws(Conn& c, std::string_view data);
  void handle_http(Conn& c);
  void flush(Conn& c);
  void drop(uint64_t id);
  void retry_pending_binds();
  bool add_listener(int fd, int port);  // listen + register; closes fd and returns false on failure
  int open_socket() const;                // a socket for one endpoint (TCP or abstract Unix), or -1
  int bind_endpoint(int fd, int port) const;  // 0 or errno
  std::string endpoint(int port) const;   // "127.0.0.1:9229" or "@<base>_9229", for logs
  bool peer_allowed(int fd) const;        // abstract sockets: root, shell or our own uid

  struct PendingBind {
    int fd = -1;
    int port = 0;
    std::chrono::steady_clock::time_point deadline;
  };

  Callbacks cb_;
  std::string abstract_base_;
  std::vector<int> listen_fds_;   // appended by the server thread for retried ports (only it reads them then)
  std::vector<int> bound_ports_;  // guarded by mu_ (read from other threads)
  std::vector<PendingBind> pending_binds_;  // server thread once started
  std::atomic<size_t> pending_count_{0};
  int wake_r_ = -1, wake_w_ = -1;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<bool> stopping_{false};

  mutable std::mutex mu_;  // guards pending_ and closing_ and conns_ membership
  std::map<uint64_t, std::unique_ptr<Conn>> conns_;
  std::map<uint64_t, std::deque<std::string>> pending_;
  std::vector<uint64_t> close_requests_;
  uint64_t next_id_ = 1;
};

}  // namespace iwn
