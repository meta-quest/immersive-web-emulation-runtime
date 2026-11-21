/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host test server: the real LoopbackServer with an echo backend. Prints "PORT <n>" once listening.
//   /json/version, /json/list  -> JSON like the device (one page target)
//   ws /devtools/page/1        -> echoes {"id":N,...} as {"id":N,"result":{"echo":<text>}}
//   ws /host                   -> {"method":"eval",...} -> {"id":..,"result":2}; "big" -> 3 MB reply
#include <csignal>
#include <cstdio>
#include <string>
#include <thread>

#include "iwn/core/json.h"
#include "iwn/core/loopback_server.h"

using namespace iwn;

int main(int argc, char** argv) {
  int port = argc > 1 ? std::atoi(argv[1]) : 0;
  LoopbackServer server;
  LoopbackServer::Callbacks cb;
  cb.http = [&](const ws::HttpRequest& req, int local_port) {
    std::string p = req.path();
    std::string ws_url = "127.0.0.1:" + std::to_string(local_port) + "/devtools/page/1";
    if (p == "/json" || p == "/json/list") {
      Json t = Json::object();
      t.set("id", "1");
      t.set("type", "page");
      t.set("title", "echo");
      t.set("url", "https://app.local/");
      t.set("webSocketDebuggerUrl", "ws://" + ws_url);
      Json arr = Json::array();
      arr.push(t);
      return ws::http_response(200, "OK", "application/json; charset=UTF-8", arr.dump());
    }
    if (p == "/json/version") {
      Json v = Json::object();
      v.set("Browser", "iwer-native-echo/0");
      v.set("Protocol-Version", "1.3");
      return ws::http_response(200, "OK", "application/json; charset=UTF-8", v.dump());
    }
    return ws::http_response(404, "Not Found", "text/plain", "not found\n");
  };
  cb.accept_ws = [](const std::string& path, int) -> std::optional<int> {
    if (path == "/devtools/page/1") return 0;
    if (path == "/host") return 1;
    return std::nullopt;
  };
  cb.on_message = [&](uint64_t conn, std::string&& text) {
    auto j = Json::parse(text);
    Json reply = Json::object();
    if (j && j->has("id")) reply.set("id", (*j)["id"]);
    if (j && (*j)["method"].as_string() == "big") {
      reply.set("result", std::string(3u << 20, 'x'));
    } else if (j && (*j)["method"].as_string() == "eval") {
      reply.set("result", 2);
    } else {
      Json r = Json::object();
      r.set("echo", text);
      reply.set("result", r);
    }
    server.send_text(conn, reply.dump());
  };
  std::string err;
  if (!server.start({port}, cb, &err)) {
    fprintf(stderr, "start failed: %s\n", err.c_str());
    return 1;
  }
  printf("PORT %d\n", server.bound_ports()[0]);
  fflush(stdout);
  // Run until stdin closes (the Node test owns our lifetime).
  char buf[64];
  while (fread(buf, 1, sizeof(buf), stdin) > 0) {
  }
  server.stop();
  return 0;
}
