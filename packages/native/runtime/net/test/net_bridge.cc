// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// iwn_net_bridge: the net natives contract (net_binding.cc) over stdio, so the
// JS layer (web/net) can be tested in Node against the real C++ core: asset
// reads, the HTTP/1.1 client, the allowlist and the WebSocket client.
//
//   iwn_net_bridge --assets <dir> [--allow <origin,...>] [--debug]
//
// One command per stdin line, one event per stdout line; strings are base64.
//   A id path                         → a id status mime data|-
//   H id url method redirect timeout headers body|-
//                                     → h id status text headers url flags | d id data | e id | x id kind msg
//   K id bytes   X id                 (ack, abort)
//   W id url protocols                → o id proto ext | m id t|b data | s id bytes | w id kind msg | c id code reason clean
//   S id t|b data   C id code reason
// headers/protocols: NUL-separated lists.
//
//   iwn_net_bridge ... --once   blocking mode (httpSync/readAssetSync, NET-11):
//   reads one "H id url method redirect timeout headers body total" or "A id path"
//   line, runs it on this thread (FetchBlocking), prints the same events and exits.

#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <unistd.h>
#include <string>
#include <vector>

#include "iwn/net/assets.h"
#include "iwn/net/http.h"
#include "iwn/net/util.h"
#include "iwn/net/websocket.h"

using namespace iwn::net;

namespace {

std::mutex g_out_mu;
void Emit(const std::string& line) {
  std::lock_guard<std::mutex> l(g_out_mu);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

std::string B64(const std::string& s) { return s.empty() ? "-" : Base64Encode(s); }
std::string B64(const std::vector<uint8_t>& v) { return v.empty() ? "-" : Base64Encode(v.data(), v.size()); }

std::string Unb64(const std::string& in) {
  if (in == "-") return std::string();
  static int table[256];
  static bool init = false;
  if (!init) {
    for (int& t : table) t = -1;
    const char* a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; ++i) table[static_cast<unsigned char>(a[i])] = i;
    init = true;
  }
  std::string out;
  int buf = 0, bits = 0;
  for (unsigned char c : in) {
    if (c == '=') break;
    int v = table[c];
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((buf >> bits) & 0xFF));
    }
  }
  return out;
}

std::vector<std::string> SplitNul(const std::string& s) {
  std::vector<std::string> out;
  if (s.empty()) return out;
  size_t start = 0;
  for (;;) {
    size_t z = s.find('\0', start);
    out.push_back(s.substr(start, z == std::string::npos ? std::string::npos : z - start));
    if (z == std::string::npos) break;
    start = z + 1;
  }
  return out;
}

std::string JoinNul(const HeaderList& h) {
  std::string out;
  for (size_t i = 0; i < h.size(); ++i) {
    if (i) out.push_back('\0');
    out += h[i].first;
    out.push_back('\0');
    out += h[i].second;
  }
  return out;
}

class BridgeHttpListener : public HttpListener {
 public:
  explicit BridgeHttpListener(std::string id) : id_(std::move(id)) {}
  void OnHead(HttpResponseHead h) override {
    int flags = (h.redirected ? 1 : 0) | (h.opaque_redirect ? 2 : 0);
    Emit("h " + id_ + " " + std::to_string(h.status) + " " + B64(h.status_text) + " " + B64(JoinNul(h.headers)) + " " +
         B64(h.url) + " " + std::to_string(flags));
  }
  void OnData(std::vector<uint8_t> chunk) override { Emit("d " + id_ + " " + B64(chunk)); }
  void OnEnd() override { Emit("e " + id_); }
  void OnError(NetError e) override { Emit("x " + id_ + " " + NetErrorName(e.kind) + " " + B64(e.message)); }

 private:
  std::string id_;
};

class BridgeWsListener : public WsListener {
 public:
  explicit BridgeWsListener(std::string id) : id_(std::move(id)) {}
  void OnOpen(std::string p, std::string e) override { Emit("o " + id_ + " " + B64(p) + " " + B64(e)); }
  void OnMessage(bool text, std::vector<uint8_t> d) override {
    Emit("m " + id_ + " " + (text ? "t " : "b ") + B64(d));
  }
  void OnSent(size_t n) override { Emit("s " + id_ + " " + std::to_string(n)); }
  void OnError(NetError e) override { Emit("w " + id_ + " " + NetErrorName(e.kind) + " " + B64(e.message)); }
  void OnClose(int code, std::string reason, bool clean) override {
    Emit("c " + id_ + " " + std::to_string(code) + " " + B64(reason) + " " + (clean ? "1" : "0"));
  }

 private:
  std::string id_;
};

}  // namespace

int main(int argc, char** argv) {
  std::string assets_dir = ".";
  std::vector<std::string> allow;
  bool debug = false;
  bool once = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--assets" && i + 1 < argc) assets_dir = argv[++i];
    else if (a == "--debug") debug = true;
    else if (a == "--once") once = true;
    else if (a == "--allow" && i + 1 < argc) {
      std::stringstream ss(argv[++i]);
      std::string item;
      while (std::getline(ss, item, ',')) {
        if (!item.empty()) allow.push_back(item);
      }
    }
  }
  OriginAllowlist list;
  list.Set(allow);
  list.SetDebugBuild(debug);
  std::shared_ptr<Connector> connector(MakePosixConnector());
  HttpClient client(connector);
  client.SetAllowlist(list);
  DirAssetSource assets(assets_dir);
  std::map<std::string, std::shared_ptr<HttpJob>> jobs;
  std::map<std::string, std::shared_ptr<WsConnection>> sockets;
  if (once) {
    std::string line, cmd, id;
    std::getline(std::cin, line);
    std::istringstream in(line);
    in >> cmd >> id;
    if (cmd == "A") {
      std::string path;
      in >> path;
      path = Unb64(path);
      std::string rel;
      int status = 404;
      std::unique_ptr<AssetBlob> blob;
      if (AssetPathFromUrlPath(path, &rel)) {
        AssetStatus st = assets.Open(rel, &blob);
        status = st == AssetStatus::kOk ? 200 : st == AssetStatus::kNotFound ? 404 : 500;
      }
      std::string data = blob ? std::string(reinterpret_cast<char*>(blob->data()), blob->size()) : std::string();
      Emit("a " + id + " " + std::to_string(status) + " " + B64(std::string(MimeTypeForPath(rel))) + " " +
           (status == 200 ? B64(data) : std::string("-")) + " 0");
    } else if (cmd == "H") {
      std::string url, method, headers, body;
      int redirect = 0, timeout = 0, total = 0;
      in >> url >> method >> redirect >> timeout >> headers >> body >> total;
      HttpRequest req;
      req.url = Unb64(url);
      req.method = Unb64(method);
      req.redirect = redirect == 1 ? RedirectMode::kError : redirect == 2 ? RedirectMode::kManual : RedirectMode::kFollow;
      if (timeout > 0) req.timeout_ms = timeout;
      std::vector<std::string> flat = SplitNul(Unb64(headers));
      for (size_t i = 0; i + 1 < flat.size(); i += 2) req.headers.emplace_back(flat[i], flat[i + 1]);
      std::string b = Unb64(body);
      if (body != "-") req.body = std::make_shared<std::vector<uint8_t>>(b.begin(), b.end());
      BlockingResult r = FetchBlocking(client, std::move(req), total);
      if (r.error) {
        Emit("x " + id + " " + NetErrorName(r.error.kind) + " " + B64(r.error.message));
      } else {
        BridgeHttpListener out(id);
        out.OnHead(r.head);
        if (!r.body.empty()) out.OnData(std::move(r.body));
        out.OnEnd();
      }
    }
    std::fflush(stdout);
    _exit(0);
  }
  Emit("ready");

  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream in(line);
    std::string cmd, id;
    in >> cmd >> id;
    if (cmd == "A") {
      std::string path;
      in >> path;
      path = Unb64(path);
      std::thread([id, path, &assets] {
        std::string rel;
        int status = 404;
        std::unique_ptr<AssetBlob> blob;
        if (AssetPathFromUrlPath(path, &rel)) {
          AssetStatus s = assets.Open(rel, &blob);
          status = s == AssetStatus::kOk ? 200 : s == AssetStatus::kNotFound ? 404 : 500;
        }
        std::string data = blob ? std::string(reinterpret_cast<char*>(blob->data()), blob->size()) : std::string();
        Emit("a " + id + " " + std::to_string(status) + " " + B64(std::string(MimeTypeForPath(rel))) + " " +
             (status == 200 ? B64(data) : std::string("-")) + (blob && blob->mapped() ? " 1" : " 0"));
      }).detach();
    } else if (cmd == "H") {
      std::string url, method, headers, body;
      int redirect = 0, timeout = 0;
      in >> url >> method >> redirect >> timeout >> headers >> body;
      HttpRequest req;
      req.url = Unb64(url);
      req.method = Unb64(method);
      req.redirect = redirect == 1 ? RedirectMode::kError : redirect == 2 ? RedirectMode::kManual : RedirectMode::kFollow;
      if (timeout > 0) req.timeout_ms = timeout;
      std::vector<std::string> flat = SplitNul(Unb64(headers));
      for (size_t i = 0; i + 1 < flat.size(); i += 2) req.headers.emplace_back(flat[i], flat[i + 1]);
      std::string b = Unb64(body);
      if (body != "-") req.body = std::make_shared<std::vector<uint8_t>>(b.begin(), b.end());
      jobs[id] = client.Start(std::move(req), std::make_shared<BridgeHttpListener>(id));
    } else if (cmd == "K") {
      size_t bytes = 0;
      in >> bytes;
      auto it = jobs.find(id);
      if (it != jobs.end()) it->second->Ack(bytes);
    } else if (cmd == "X") {
      auto it = jobs.find(id);
      if (it != jobs.end()) it->second->Abort();
    } else if (cmd == "W") {
      std::string url, protocols;
      in >> url >> protocols;
      WsOptions opts;
      sockets[id] = WsConnection::Start(connector, list, Unb64(url), SplitNul(Unb64(protocols)),
                                        std::make_shared<BridgeWsListener>(id), opts);
    } else if (cmd == "S") {
      std::string kind, data;
      in >> kind >> data;
      std::string d = Unb64(data);
      auto it = sockets.find(id);
      if (it != sockets.end()) it->second->Send(kind == "t", std::vector<uint8_t>(d.begin(), d.end()));
    } else if (cmd == "C") {
      int code = 0;
      std::string reason;
      in >> code >> reason;
      auto it = sockets.find(id);
      if (it != sockets.end()) it->second->Close(code, Unb64(reason));
    } else if (cmd == "Q") {
      break;
    }
  }
  client.AbortAll();
  for (auto& [id, s] : sockets) s->Abort();
  std::fflush(stdout);
  _exit(0);
}
