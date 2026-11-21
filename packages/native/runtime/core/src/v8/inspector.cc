// The V8 inspector served over the loopback server: CDP discovery (/json*), one page target, sessions, pause loop,
// --inspect-brk, Page-domain stand-ins (CDP-1..10). Written from v8-inspector.h and the Chrome DevTools Protocol
// documentation (discovery endpoints, Runtime/Debugger/Page domains).
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "iwn/core/text.h"
#include "iwn/core/url.h"
#include "v8/runtime_impl.h"
#include "v8/v8_util.h"

#ifndef IWN_RUNTIME_VERSION
#define IWN_RUNTIME_VERSION "0.0.0"
#endif
#define IWN_RUNTIME_VERSION_STR IWN_RUNTIME_VERSION

namespace iwn {
namespace {

using v8_inspector::StringBuffer;
using v8_inspector::StringView;

StringView view8(const std::string& s) { return StringView(reinterpret_cast<const uint8_t*>(s.data()), s.size()); }

void append_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

std::string to_utf8(const StringView& v) {
  std::string out;
  out.reserve(v.length());
  if (v.is8Bit()) {
    const uint8_t* p = v.characters8();
    for (size_t i = 0; i < v.length(); ++i) append_utf8(out, p[i]);  // Latin-1
    return out;
  }
  const uint16_t* p = v.characters16();
  for (size_t i = 0; i < v.length(); ++i) {
    uint32_t c = p[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length() && p[i + 1] >= 0xDC00 && p[i + 1] <= 0xDFFF) {
      c = 0x10000 + ((c - 0xD800) << 10) + (p[i + 1] - 0xDC00);
      ++i;
    } else if (c >= 0xD800 && c <= 0xDFFF) {
      c = 0xFFFD;
    }
    append_utf8(out, c);
  }
  return out;
}

std::u16string to_utf16(const std::string& s) {
  std::u16string out;
  out.reserve(s.size());
  size_t i = 0;
  while (i < s.size()) {
    uint8_t c = static_cast<uint8_t>(s[i]);
    uint32_t cp;
    int extra;
    if (c < 0x80) {
      cp = c;
      extra = 0;
    } else if ((c & 0xE0) == 0xC0) {
      cp = c & 0x1F;
      extra = 1;
    } else if ((c & 0xF0) == 0xE0) {
      cp = c & 0x0F;
      extra = 2;
    } else if ((c & 0xF8) == 0xF0) {
      cp = c & 0x07;
      extra = 3;
    } else {
      out.push_back(0xFFFD);
      ++i;
      continue;
    }
    bool bad = false;
    for (int k = 1; k <= extra; ++k) {
      if (i + k >= s.size() || (static_cast<uint8_t>(s[i + k]) & 0xC0) != 0x80) {
        bad = true;
        break;
      }
      cp = (cp << 6) | (static_cast<uint8_t>(s[i + k]) & 0x3F);
    }
    if (bad) {
      out.push_back(0xFFFD);
      ++i;
      continue;
    }
    i += extra + 1;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<char16_t>(cp));
    }
  }
  return out;
}

// Methods dispatched from a V8 interrupt while page JS (or a long Runtime.evaluate) runs. Runtime.terminateExecution
// is among them so DevTools can stop a runaway script; other Runtime.* methods may run page JS and wait for the loop.
bool cdp_safe_in_interrupt(const std::string& method) {
  return method.rfind("Debugger.", 0) == 0 || method.rfind("Profiler.", 0) == 0 ||
         method.rfind("HeapProfiler.", 0) == 0 || method == "Runtime.terminateExecution";
}

std::string random_id() {
  static const char hex[] = "0123456789ABCDEF";
  std::string s;
  uint64_t seed = static_cast<uint64_t>(monotonic_ns()) ^ (static_cast<uint64_t>(getpid()) << 32);
  for (int i = 0; i < 32; ++i) {
    seed = seed * 6364136223846793005ull + 1442695040888963407ull;
    s.push_back(hex[(seed >> 59) & 15]);
  }
  return s;
}

}  // namespace

struct DevTools::Session : public v8_inspector::V8Inspector::Channel {
  DevTools* owner = nullptr;
  uint64_t conn = 0;
  // From connectShared: V8 may keep its own reference while a dispatch is on the stack (v8-inspector.h). This
  // Session is the session's Channel, so it is only destroyed once V8 holds no other reference (reap).
  std::shared_ptr<v8_inspector::V8InspectorSession> session;
  void sendResponse(int, std::unique_ptr<StringBuffer> message) override { send(message->string()); }
  void sendNotification(std::unique_ptr<StringBuffer> message) override { send(message->string()); }
  void flushProtocolNotifications() override {}
  void send(const StringView& v) { owner->server_->send_text(conn, to_utf8(v)); }
};

DevTools::DevTools(RuntimeImpl& rt) : rt_(rt), server_(std::make_shared<LoopbackServer>()), target_id_(random_id()) {}

DevTools::~DevTools() {
  stop_server();
  closing_.clear();
  sessions_.clear();
  inspector_.reset();
}

void DevTools::create_inspector(v8::Isolate* isolate) { inspector_ = v8_inspector::V8Inspector::create(isolate, this); }

void DevTools::set_title(std::string title) {
  std::lock_guard<std::mutex> lock(mu_);
  title_ = std::move(title);
}

bool DevTools::start_server() {
  const RuntimeConfig& c = rt_.config();
  std::vector<int> ports;
  cdp_port_ = 0;
  if (c.inspector_enabled) {
    ports.push_back(c.inspector_port);
    cdp_port_ = c.inspector_port;
  }
  if (c.debug_enabled) {
    if (c.debug_port > 0 && c.debug_port != c.inspector_port) {
      ports.push_back(c.debug_port);
    } else if (!c.inspector_enabled) {
      ports.push_back(c.inspector_port);  // /host only
    }
  }
  if (ports.empty()) {
    log(LogLevel::kInfo, "inspector and debug endpoint disabled (CDP-1)");
    return true;
  }
#if defined(__ANDROID__)
  // CDP-1: an abstract Unix socket per port, served only to adb (shell), root and this app; a loopback TCP port
  // would let any app on the headset drive the page. Reached with `adb forward tcp:<p> localabstract:<name>`.
  const std::string& pkg = rt_.options().package_name;
  socket_base_ = (pkg.empty() ? std::string("iwn") : pkg) + "_devtools";
  server_->set_abstract_name(socket_base_);
#endif
  LoopbackServer::Callbacks cb;
  cb.http = [this](const ws::HttpRequest& req, int port) { return http_response(req, port); };
  cb.accept_ws = [this](const std::string& path, int port) -> std::optional<int> {
    bool cdp_port = cdp_port_ != 0 && port == cdp_port_;
    if (cdp_port && path == "/devtools/page/" + target_id_) return 0;
    if (path == "/host" && rt_.config().debug_enabled) return 1;
    return std::nullopt;
  };
  cb.on_open = [this](uint64_t conn, int kind, const std::string&) {
    on_server_inbound({Inbound::Kind::kOpen, conn, kind, {}, true});
  };
  cb.on_message = [this](uint64_t conn, std::string&& text) {
    int channel;
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = channels_.find(conn);
      channel = it == channels_.end() ? 0 : it->second;
    }
    bool safe = false;
    if (channel == 0) {
      // Peek at the method: Debugger/Profiler messages may be dispatched from an interrupt while JS runs.
      size_t m = text.find("\"method\"");
      if (m != std::string::npos) {
        size_t q1 = text.find('"', text.find(':', m) + 1);
        size_t q2 = q1 == std::string::npos ? q1 : text.find('"', q1 + 1);
        if (q2 != std::string::npos) safe = cdp_safe_in_interrupt(text.substr(q1 + 1, q2 - q1 - 1));
      }
    }
    on_server_inbound({Inbound::Kind::kMessage, conn, channel, std::move(text), safe});
  };
  cb.on_close = [this](uint64_t conn) { on_server_inbound({Inbound::Kind::kClose, conn, 0, {}, true}); };
  // Logged when each port is actually listening: at once, or later from the server thread when a port held by a
  // previous instance in this process (same-process relaunch, PROC-7) is released.
  cb.on_listening = [this](int p) {
    bool cdp = cdp_port_ != 0 && p == cdp_port_;
    const std::string where = socket_base_.empty() ? "127.0.0.1:" + std::to_string(p) : "@" + socket_base_ + "_" + std::to_string(p);
    const std::string forward = socket_base_.empty() ? "tcp:" + std::to_string(p)
                                                     : "localabstract:" + socket_base_ + "_" + std::to_string(p);
    log(LogLevel::kInfo, "%s listening on %s (adb forward tcp:%d %s)%s",
        cdp ? "inspector (CDP + /host)" : "debug endpoint (/host)", where.c_str(), p, forward.c_str(),
        cdp ? (" target ws://127.0.0.1:" + std::to_string(p) + "/devtools/page/" + target_id_).c_str() : "");
  };
  std::string err;
  // A busy port is retried in the background for 30 s (well past the old instance's 3 s quit watchdog), so a
  // relaunch neither blocks the page's boot nor loses its endpoints.
  if (!server_->start(ports, cb, &err, 30000)) {
    log(LogLevel::kError, "inspector/debug server failed to start: %s", err.c_str());
    return false;
  }
  return true;
}

void DevTools::stop_server() { server_->stop(); }

void DevTools::on_server_inbound(Inbound in) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (in.kind == Inbound::Kind::kOpen) channels_[in.conn] = in.channel;
    if (in.kind == Inbound::Kind::kClose) {
      auto it = channels_.find(in.conn);
      if (it != channels_.end()) {
        in.channel = it->second;
        channels_.erase(it);
      }
    }
    inbound_.push_back(std::move(in));
  }
  cv_.notify_all();
  if (!drain_posted_.exchange(true)) {
    rt_.loop().post([this] {
      drain_posted_ = false;
      drain(false, false);
    });
  }
  if (v8::Isolate* isolate = rt_.isolate()) isolate->RequestInterrupt(&DevTools::interrupt_callback, this);
}

void DevTools::interrupt_callback(v8::Isolate* isolate, void* data) {
  auto* self = static_cast<DevTools*>(data);
  if (self->paused_ || self->in_interrupt_) return;
  self->in_interrupt_ = true;
  self->drain(true, true);
  self->in_interrupt_ = false;
}

void DevTools::reap_closed_sessions() {
  if (paused_ || in_interrupt_) return;
  closing_.erase(std::remove_if(closing_.begin(), closing_.end(),
                                [](const std::unique_ptr<Session>& s) { return !s->session || s->session.use_count() == 1; }),
                 closing_.end());
}

void DevTools::drain(bool cdp_only, bool safe_only) {
  drain_items(cdp_only, safe_only);
  if (!safe_only) reap_closed_sessions();
}

void DevTools::drain_items(bool cdp_only, bool safe_only) {
  v8::Isolate* isolate = rt_.isolate();
  v8::HandleScope hs(isolate);
  v8::Local<v8::Context> ctx = rt_.context();
  std::optional<v8::Context::Scope> cs;
  if (!ctx.IsEmpty()) cs.emplace(ctx);
  for (;;) {
    Inbound item;
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = inbound_.begin();
      for (; it != inbound_.end(); ++it) {
        if (it->channel == 1 && cdp_only) continue;  // debug requests wait for the normal loop
        break;
      }
      if (it == inbound_.end()) return;
      if (safe_only && !it->safe_in_interrupt) return;  // keep CDP order: stop at the first unsafe message
      item = std::move(*it);
      inbound_.erase(it);
    }
    if (item.kind == Inbound::Kind::kOpen) {
      if (item.channel == 0) {
        auto s = std::make_unique<Session>();
        s->owner = this;
        s->conn = item.conn;
        s->session = inspector_->connectShared(1, s.get(), StringView(), v8_inspector::V8Inspector::kFullyTrusted,
                                               waiting_for_debugger_ ? v8_inspector::V8Inspector::kWaitingForDebugger
                                                                     : v8_inspector::V8Inspector::kNotWaitingForDebugger);
        sessions_[item.conn] = std::move(s);
        log(LogLevel::kInfo, "DevTools session attached (%zu open)", sessions_.size());
      }
    } else if (item.kind == Inbound::Kind::kClose) {
      auto it = sessions_.find(item.conn);
      if (it != sessions_.end()) {
        std::unique_ptr<Session> s = std::move(it->second);
        sessions_.erase(it);
        log(LogLevel::kInfo, "DevTools session closed (%zu open)", sessions_.size());
        // v8-inspector.h: sessions must not be destroyed inside the nested pause loop, and this may run from an
        // interrupt with page JS (or a dispatch) on the stack. Park it; reap_closed_sessions() frees it at a safe
        // point. If it was the last session and we are paused, resume: nobody is left to do it.
        // stop() disables this session's debugger agent as destroying it would (a pause held only by it ends, as
        // when a DevTools window closes in Chrome).
        s->session->stop();
        if (paused_ && sessions_.empty()) s->session->resume();
        closing_.push_back(std::move(s));
      }
    } else if (item.channel == 0) {
      handle_cdp(item.conn, item.text);
    } else {
      handle_debug(item.conn, item.text);
    }
  }
}

void DevTools::handle_cdp(uint64_t conn, const std::string& text) {
  auto it = sessions_.find(conn);
  if (it == sessions_.end()) return;
  auto msg = Json::parse(text);
  std::string method = msg ? (*msg)["method"].string_or("") : "";
  Json id = msg ? (*msg)["id"] : Json();
  if (!msg || method.empty()) {
    // Let V8 produce the protocol error for malformed input.
    std::u16string u16 = to_utf16(text);
    it->second->session->dispatchProtocolMessage(
        StringView(reinterpret_cast<const uint16_t*>(u16.data()), u16.size()));
    return;
  }
  if (v8_inspector::V8InspectorSession::canDispatchMethod(view8(method))) {
    std::u16string u16 = to_utf16(text);
    it->second->session->dispatchProtocolMessage(
        StringView(reinterpret_cast<const uint16_t*>(u16.data()), u16.size()));
    return;
  }
  // Page-target stand-ins (CDP-9).
  Json reply = Json::object();
  reply.set("id", id);
  auto starts = [&](const char* prefix) { return method.rfind(prefix, 0) == 0; };
  static const char* kNoops[] = {"Page.enable",
                                 "Page.disable",
                                 "Page.setLifecycleEventsEnabled",
                                 "Page.setAdBlockingEnabled",
                                 "Page.setBypassCSP",
                                 "Page.stopLoading",
                                 "Network.enable",
                                 "Network.disable",
                                 "Network.setCacheDisabled",
                                 "Network.setAttachDebugStack",
                                 "Network.clearAcceptedEncodingsOverride",
                                 "Log.enable",
                                 "Log.disable",
                                 "Log.startViolationsReport",
                                 "Inspector.enable",
                                 "Inspector.disable",
                                 "Target.setAutoAttach",
                                 "Target.setDiscoverTargets",
                                 "Target.setRemoteLocations"};
  bool noop = starts("Emulation.") || starts("Overlay.");
  for (const char* n : kNoops) noop = noop || method == n;
  if (noop) {
    reply.set("result", Json::object());
  } else if (method == "Page.getResourceTree" || method == "Page.getFrameTree") {
    std::string url = rt_.document_url().href();
    Json frame = Json::object();
    frame.set("id", "main");
    frame.set("loaderId", "main");
    frame.set("url", url);
    frame.set("domainAndRegistry", "");
    frame.set("securityOrigin", rt_.app_origin().origin());
    frame.set("mimeType", "text/html");
    frame.set("secureContextType", "Secure");
    frame.set("crossOriginIsolatedContextType", "NotIsolated");
    frame.set("gatedAPIFeatures", Json::array());
    Json tree = Json::object();
    tree.set("frame", frame);
    if (method == "Page.getResourceTree") tree.set("resources", Json::array());
    Json result = Json::object();
    result.set("frameTree", tree);
    reply.set("result", result);
  } else if (method == "Network.loadNetworkResource") {
    // CDP-5: DevTools loads source maps (and their sources) for page targets through the target. Serve the app's
    // dist (same-origin URLs), the runtime's own assets (iwn-runtime:///, e.g. prelude maps) and data: URLs. blob:
    // is not served here because resolving it runs page JS, which must not happen while paused.
    std::string url = (*msg)["params"]["url"].string_or("");
    std::string body, mime;
    Json resource = Json::object();
    if (load_resource(url, &body, &mime)) {
      std::string handle = "iwn-io-" + std::to_string(++next_stream_);
      io_streams_[handle] = std::move(body);
      Json headers = Json::object();
      headers.set("Content-Type", mime);
      resource.set("success", true);
      resource.set("httpStatusCode", 200);
      resource.set("stream", handle);
      resource.set("headers", headers);
    } else {
      resource.set("success", false);
      resource.set("netError", -6);
      resource.set("netErrorName", "net::ERR_FILE_NOT_FOUND");
      resource.set("httpStatusCode", 404);
    }
    Json result = Json::object();
    result.set("resource", resource);
    reply.set("result", result);
  } else if (method == "IO.read") {
    std::string handle = (*msg)["params"]["handle"].string_or("");
    auto s = io_streams_.find(handle);
    if (s == io_streams_.end()) {
      Json err = Json::object();
      err.set("code", -32000);
      err.set("message", "Invalid stream handle");
      reply.set("error", err);
    } else {
      size_t& pos = io_offsets_[handle];
      const Json& params = (*msg)["params"];
      if (params.has("offset")) pos = static_cast<size_t>(std::max(0.0, params["offset"].as_number(0)));
      size_t want = params.has("size") ? static_cast<size_t>(std::max(1.0, params["size"].as_number(1))) : (1u << 20);
      want = std::min<size_t>(want, 4u << 20);
      const std::string& data = s->second;
      size_t start = std::min(pos, data.size());
      size_t n = std::min(want, data.size() - start);
      pos = start + n;
      Json result = Json::object();
      result.set("base64Encoded", true);  // binary-safe; avoids splitting UTF-8 sequences across reads
      result.set("data", base64_encode(data.data() + start, n));
      result.set("eof", pos >= data.size());
      reply.set("result", result);
    }
  } else if (method == "IO.close") {
    std::string handle = (*msg)["params"]["handle"].string_or("");
    io_streams_.erase(handle);
    io_offsets_.erase(handle);
    reply.set("result", Json::object());
  } else if (method == "Page.reload") {
    reply.set("result", Json::object());
    server_->send_text(conn, reply.dump());
    rt_.request_reload();  // PROC-8
    return;
  } else {
    Json err = Json::object();
    err.set("code", -32601);
    err.set("message", "'" + method + "' wasn't found");
    reply.set("error", err);
  }
  server_->send_text(conn, reply.dump());
}

bool DevTools::load_resource(const std::string& url, std::string* body, std::string* mime) {
  auto u = parse_url(url);
  if (!u) return false;
  if (u->scheme == "data") {
    auto d = decode_data_url(url);
    if (!d) return false;
    body->assign(d->body.begin(), d->body.end());
    *mime = d->mime_type;
    return true;
  }
  const std::string kRuntime = "iwn-runtime:///";
  if (url.rfind(kRuntime, 0) == 0) {
    std::string path = url.substr(kRuntime.size());
    size_t cut = path.find_first_of("?#");
    if (cut != std::string::npos) path.resize(cut);
    if (path.empty() || path.find("..") != std::string::npos || path[0] == '/') return false;
    auto bytes = rt_.assets().read(path);
    if (!bytes) return false;
    body->assign(bytes->view());
    *mime = std::string(mime_type_for_path(path));
    return true;
  }
  if (u->origin() != rt_.app_origin().origin()) return false;
  auto path = app_asset_path(*u, rt_.app_origin());
  if (!path) return false;
  auto bytes = rt_.read_app_file(*path);
  if (!bytes) return false;
  body->assign(bytes->view());
  *mime = std::string(mime_type_for_path(*path));
  return true;
}

void DevTools::context_created(v8::Local<v8::Context> ctx) {
  if (!inspector_) return;
  std::string name = "top";
  std::string origin = rt_.app_origin().origin();
  std::string aux = R"({"isDefault":true,"type":"default","frameId":"main"})";
  v8_inspector::V8ContextInfo info(ctx, 1, view8(name));
  info.origin = view8(origin);
  info.auxData = view8(aux);
  inspector_->contextCreated(info);
  context_alive_ = true;
}

void DevTools::context_destroyed(v8::Local<v8::Context> ctx) {
  if (!inspector_ || !context_alive_) return;
  inspector_->contextDestroyed(ctx);
  context_alive_ = false;
}

void DevTools::exception_thrown(v8::Local<v8::Context> ctx, v8::Local<v8::Value> exception,
                                v8::Local<v8::Message> message, const std::string& text) {
  if (!inspector_ || !context_alive_) return;
  std::unique_ptr<v8_inspector::V8StackTrace> trace;
  std::string url, detail;
  unsigned line = 0, col = 0;
  int script_id = 0;
  if (!message.IsEmpty()) {
    v8::Isolate* isolate = rt_.isolate();
    url = v8u::to_utf8(isolate, message->GetScriptResourceName());
    line = static_cast<unsigned>(message->GetLineNumber(ctx).FromMaybe(0));
    col = static_cast<unsigned>(message->GetStartColumn(ctx).FromMaybe(0) + 1);
    script_id = message->GetScriptOrigin().ScriptId();
    detail = v8u::to_utf8(isolate, message->Get());
    v8::Local<v8::StackTrace> st = message->GetStackTrace();
    if (!st.IsEmpty() && st->GetFrameCount() > 0) trace = inspector_->createStackTrace(st);
  }
  inspector_->exceptionThrown(ctx, view8(text), exception, view8(detail), view8(url), line, col, std::move(trace),
                              script_id);
}

void DevTools::wait_for_debugger() {
  waiting_for_debugger_ = true;
  log(LogLevel::kInfo, "waiting for a debugger before running the entry (CDP-8): attach DevTools to 127.0.0.1:%d",
      rt_.config().inspector_port);
  // An exit request (activity finishing or relaunched) ends the wait at once; the quit task runs next.
  while (waiting_for_debugger_ && !rt_.loop().quit_requested() && !rt_.exit_requested_.load()) {
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait_for(lock, std::chrono::milliseconds(250), [this] {
        for (auto& i : inbound_) {
          if (i.channel == 0) return true;
        }
        return false;
      });
    }
    drain(true, false);
  }
  waiting_for_debugger_ = false;
  if (rt_.exit_requested_.load()) {
    log(LogLevel::kInfo, "exit requested while waiting for a debugger: not running the page");
    return;
  }
  for (auto& kv : sessions_) {
    std::string reason = "Break on start";
    kv.second->session->schedulePauseOnNextStatement(view8(reason), view8(std::string("{}")));
  }
}

// V8InspectorClient ----------------------------------------------------------------------------------------------

void DevTools::runMessageLoopOnPause(int) {
  if (paused_) return;
  if (rt_.exit_requested_.load() || rt_.loop().quit_requested()) {
    for (auto& kv : sessions_) {
      kv.second->session->setSkipAllPauses(true);
      kv.second->session->resume();
    }
    return;
  }
  paused_ = true;
  log(LogLevel::kInfo, "paused in the debugger (JS thread services only inspector messages)");
  while (paused_) {
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait_for(lock, std::chrono::milliseconds(250), [this] {
        for (auto& i : inbound_) {
          if (i.channel == 0) return true;
        }
        return false;
      });
    }
    drain(true, false);
    if (sessions_.empty()) paused_ = false;  // the last session went away (it was resumed when it closed)
    if (paused_ && (rt_.exit_requested_.load() || rt_.loop().quit_requested())) {
      // The activity is finishing: stop honouring breakpoints and resume, so the quit task (pagehide, PROC-7)
      // and teardown can run and the ports are released before a relaunch in the same process.
      log(LogLevel::kInfo, "exit requested while paused in the debugger: resuming");
      for (auto& kv : sessions_) {
        kv.second->session->setSkipAllPauses(true);
        kv.second->session->resume();
      }
      paused_ = false;
    }
  }
  // Sessions closed while paused are freed by a later loop task, outside runMessageLoopOnPause (v8-inspector.h).
  if (!closing_.empty()) rt_.loop().post([this] { reap_closed_sessions(); });
  log(LogLevel::kInfo, "resumed from the debugger");
}

void DevTools::quitMessageLoopOnPause() { paused_ = false; }

void DevTools::runIfWaitingForDebugger(int) { waiting_for_debugger_ = false; }

v8::Local<v8::Context> DevTools::ensureDefaultContextInGroup(int) { return rt_.context(); }

double DevTools::currentTimeMS() { return time_origin_ms() + now_ms(); }

// HTTP discovery (CDP-2) -----------------------------------------------------------------------------------------

std::string DevTools::target_json(const std::string& host) const {
  std::string title;
  {
    std::lock_guard<std::mutex> lock(mu_);
    title = title_;
  }
  const RuntimeConfig& c = rt_.config();
  if (title.empty()) title = c.package_id.empty() ? "iwer-native app" : c.package_id;
  std::string ws = host + "/devtools/page/" + target_id_;
  Json t = Json::object();
  t.set("description", "iwer-native page");
  t.set("devtoolsFrontendUrl", "devtools://devtools/bundled/inspector.html?ws=" + ws);
  t.set("devtoolsFrontendUrlCompat", "devtools://devtools/bundled/inspector.html?ws=" + ws);
  t.set("faviconUrl", "");
  t.set("id", target_id_);
  t.set("title", title);
  t.set("type", "page");
  t.set("url", c.origin + "/");
  t.set("webSocketDebuggerUrl", "ws://" + ws);
  return t.dump();
}

std::string DevTools::http_response(const ws::HttpRequest& req, int local_port) {
  std::string path = req.path();
  while (path.size() > 1 && path.back() == '/') path.pop_back();
  bool cdp_port = cdp_port_ != 0 && local_port == cdp_port_;
  std::string host = "127.0.0.1:" + std::to_string(local_port);
  if (auto h = req.header("Host"); h && ws::is_loopback_host(h)) host = std::string(trim(*h));
  const char* kJson = "application/json; charset=UTF-8";
  if (cdp_port && (path == "/json" || path == "/json/list")) {
    return ws::http_response(200, "OK", kJson, "[" + target_json(host) + "]");
  }
  if (cdp_port && path == "/json/version") {
    Json v = Json::object();
    v.set("Browser", std::string("iwer-native/") + IWN_RUNTIME_VERSION_STR);
    v.set("Protocol-Version", "1.3");
    v.set("User-Agent", std::string("iwer-native/") + IWN_RUNTIME_VERSION_STR + " (Android)");
    v.set("V8-Version", v8::V8::GetVersion());
    v.set("WebKit-Version", "");
    v.set("webSocketDebuggerUrl", "ws://" + host + "/devtools/page/" + target_id_);
    return ws::http_response(200, "OK", kJson, v.dump());
  }
  if (cdp_port && path.rfind("/json/activate/", 0) == 0) {
    return ws::http_response(200, "OK", "text/plain", "Target activated");
  }
  return ws::http_response(404, "Not Found", "text/plain", "not found: " + path + "\n");
}

void DevTools::add_method(std::string name, Runtime::DebugMethod method) { methods_[std::move(name)] = std::move(method); }

}  // namespace iwn
