// iwn_register_workers: the module's entry point (NATIVE MODULE CONTRACT). Called once per page context by the core
// and once per worker context by WorkerRuntime::boot (the worker walks the same module table).
//
// Page side: builds the process-wide WorkerEnv from the runtime (assets, origin, preludes, the glue config and the
// "workers" config section), replaces the previous page's binding on location.reload() (its workers are terminated,
// HTML: a document's workers end with it, PROC-8), and on the first registration per Runtime adds
//   * a shutdown hook (PROC-7): terminate every worker and join their threads (bounded by workers.joinTimeoutMs),
//   * a "workers" stats section and a "workers" debug-endpoint method (WRK-10: live workers, port stats, and the
//     message log in debuggable builds).
#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "v8/internal.h"

#ifndef IWN_RUNTIME_VERSION
#define IWN_RUNTIME_VERSION "0.0.0"
#endif

namespace iwn::workers {
namespace {

class MainHost final : public JsHost {
 public:
  explicit MainHost(Runtime* rt) : rt_(rt) {}
  v8::MaybeLocal<v8::Value> call(v8::Local<v8::Function> fn, v8::Local<v8::Value> recv, int argc,
                                 v8::Local<v8::Value> argv[]) override {
    return rt_->call_function(fn, recv, argc, argv);
  }

 private:
  Runtime* rt_;
};

Json read_workers_section(Runtime* rt) {
  // The core parses only its own keys; the "workers" section is read from the same generated config file.
  auto bytes = rt->assets().read("iwn/config.json");
  if (!bytes) return Json();
  auto j = Json::parse(bytes->view());
  if (!j || !j->is_object()) return Json();
  return (*j)["workers"];
}

Json workers_json(bool with_log) {
  Json j = Json::object();
  j.set("live", worker_limiter().live());
  j.set("max", worker_limiter().max());
  j.set("created", worker_limiter().created());
  Json list = Json::array();
  for (auto& h : live_workers()) {
    Json w = Json::object();
    w.set("id", h->id);
    w.set("name", h->name);
    w.set("url", h->url.size() > 200 ? h->url.substr(0, 200) + "..." : h->url);
    w.set("type", h->module ? "module" : "classic");
    w.set("terminating", h->terminate_requested());
    list.push(w);
  }
  j.set("workers", list);
  PortHubStats s = PortHub::shared().stats();
  Json ports = Json::object();
  ports.set("live", static_cast<uint64_t>(s.live_ports));
  ports.set("queued", static_cast<uint64_t>(s.queued_messages));
  ports.set("posted", s.posted);
  ports.set("delivered", s.delivered);
  ports.set("dropped", s.dropped);
  ports.set("bytesPosted", s.bytes_posted);
  j.set("messages", ports);
  auto c = ScriptCache::shared().stats();
  Json cache = Json::object();
  cache.set("hits", c.hits);
  cache.set("misses", c.misses);
  cache.set("rejected", c.rejected);
  cache.set("entries", static_cast<uint64_t>(c.entries));
  cache.set("bytes", static_cast<uint64_t>(c.bytes));
  j.set("codeCache", cache);
  if (with_log) {
    Json log = Json::array();
    for (const auto& e : PortHub::shared().log_snapshot()) {
      Json m = Json::object();
      m.set("t", e.time_ms);
      m.set("from", e.from);
      m.set("to", e.to);
      m.set("bytes", static_cast<uint64_t>(e.bytes));
      log.push(m);
    }
    j.set("log", log);
  }
  return j;
}

std::mutex g_hooked_mu;
Runtime* g_hooked_runtime = nullptr;

void register_page(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives, Runtime* rt) {
  // Environment (refreshed on every page registration: the config does not change, the asset source might).
  auto env = std::make_shared<WorkerEnv>();
  const RuntimeConfig& rc = rt->config();
  env->source.app_origin = rt->app_origin();
  env->source.app_root = rc.app_root;
  env->source.assets = &rt->assets();
  env->origin = rt->app_origin().origin();
  env->preludes = rc.preludes;
  env->glue = rc.glue.is_object() ? rc.glue : Json::object();
  env->debuggable = rc.debug_enabled || rc.inspector_enabled;
  env->runtime_version = IWN_RUNTIME_VERSION;
  std::vector<std::string> warnings;
  env->config = parse_workers_config(read_workers_section(rt), &warnings);
  for (const auto& w : warnings) log(LogLevel::kWarn, "config: %s", w.c_str());
  worker_limiter().set_max(env->config.max_workers);
  ScriptCache::shared().set_limit(env->config.code_cache_bytes);
  int log_capacity = env->config.message_log < 0 ? (env->debuggable ? 256 : 0) : env->config.message_log;
  PortHub::shared().set_log_capacity(static_cast<size_t>(log_capacity));
  double join_ms = env->config.join_timeout_ms;
  set_worker_env(env);

  // A new context in the same isolate (location.reload()): the old page's workers and ports end now.
  if (auto old = take_binding_for(isolate)) old->shutdown();

  auto binding = std::make_shared<IsolateBinding>(isolate, ctx, nullptr, nullptr);
  binding->own_host(std::make_unique<MainHost>(rt));
  auto owner = std::make_shared<BindingOwner>(
      [rt](std::function<void()> fn) {
        rt->post_task(std::move(fn));
        return true;
      },
      "main");
  binding->set_owner(owner);
  owner->set_binding(binding);
  set_binding_for(isolate, binding);
  install_workers_natives(*binding, ctx, natives);

  std::lock_guard<std::mutex> lock(g_hooked_mu);
  if (g_hooked_runtime != rt) {
    g_hooked_runtime = rt;
    rt->add_shutdown_hook([isolate, join_ms] {
      // PROC-7: workers stop before the page context and isolate go; their threads are joined (bounded).
      double t0 = now_ms();
      size_t n = 0;
      if (auto b = take_binding_for(isolate)) {
        n = b->children().size();
        b->shutdown();
        b->join_children(join_ms);
      }
      if (n) log(LogLevel::kInfo, "workers: %zu stopped in %.1f ms", n, now_ms() - t0);
      std::lock_guard<std::mutex> lock(g_hooked_mu);
      g_hooked_runtime = nullptr;
    });
    rt->add_stats_provider("workerStats", [] { return workers_json(false); });
    bool with_log = log_capacity > 0;
    rt->add_debug_method("workers", [with_log](const Json&, Runtime::DebugReply reply) { reply(workers_json(with_log)); });
  }
}

}  // namespace
}  // namespace iwn::workers

void iwn_register_workers(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  using namespace iwn::workers;
  if (WorkerRuntime* w = WorkerRuntime::current(); w && w->isolate() == isolate) {
    if (auto b = binding_for(isolate)) install_workers_natives(*b, ctx, natives);
    return;
  }
  if (iwn::Runtime* rt = iwn::Runtime::From(isolate)) register_page(isolate, ctx, natives, rt);
}
