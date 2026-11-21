// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// A loopback TCP server for host tests: each accepted connection is handed
// to a handler on its own thread.

#ifndef IWN_NET_TEST_SERVER_H_
#define IWN_NET_TEST_SERVER_H_

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

class TestServer {
 public:
  using Handler = std::function<void(int fd)>;
  explicit TestServer(Handler handler) : handler_(std::move(handler)) {
    fd_ = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof addr);
    socklen_t len = sizeof addr;
    getsockname(fd_, reinterpret_cast<sockaddr*>(&addr), &len);
    port_ = ntohs(addr.sin_port);
    listen(fd_, 16);
    thread_ = std::thread([this] {
      while (!stop_) {
        pollfd p{fd_, POLLIN, 0};
        if (poll(&p, 1, 50) <= 0) continue;
        int c = accept(fd_, nullptr, nullptr);
        if (c < 0) continue;
        ++accepted_;
        conns_.emplace_back([this, c] {
          handler_(c);
          close(c);
        });
      }
    });
  }
  ~TestServer() {
    stop_ = true;
    thread_.join();
    for (auto& t : conns_) t.join();
    close(fd_);
  }
  int port() const { return port_; }
  int accepted() const { return accepted_; }
  std::string url(const std::string& scheme, const std::string& path) const {
    return scheme + "://127.0.0.1:" + std::to_string(port_) + path;
  }

  // Reads until "\r\n\r\n"; returns the head ("" on EOF).
  static std::string ReadHead(int fd, std::string* extra = nullptr) {
    std::string buf;
    char c[4096];
    for (;;) {
      size_t end = buf.find("\r\n\r\n");
      if (end != std::string::npos) {
        if (extra) *extra = buf.substr(end + 4);
        return buf.substr(0, end + 4);
      }
      ssize_t n = recv(fd, c, sizeof c, 0);
      if (n <= 0) return "";
      buf.append(c, static_cast<size_t>(n));
    }
  }
  static void Send(int fd, const std::string& s) {
    size_t done = 0;
    while (done < s.size()) {
      ssize_t n = send(fd, s.data() + done, s.size() - done, MSG_NOSIGNAL);
      if (n <= 0) return;
      done += static_cast<size_t>(n);
    }
  }

 private:
  Handler handler_;
  int fd_ = -1;
  int port_ = 0;
  std::atomic<bool> stop_{false};
  std::atomic<int> accepted_{0};
  std::thread thread_;
  std::vector<std::thread> conns_;
};

#endif  // IWN_NET_TEST_SERVER_H_
