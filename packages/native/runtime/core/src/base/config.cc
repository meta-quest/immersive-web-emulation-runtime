#include "iwn/core/config.h"

#include "iwn/core/url.h"

namespace iwn {
namespace {

void get_string(const Json& j, const char* key, std::string& out, const std::string& where,
                std::vector<std::string>* w) {
  if (!j.has(key)) return;
  if (j[key].is_string()) {
    out = j[key].as_string();
  } else if (w) {
    w->push_back(where + key + " must be a string");
  }
}
void get_bool(const Json& j, const char* key, bool& out, const std::string& where, std::vector<std::string>* w) {
  if (!j.has(key)) return;
  if (j[key].is_bool()) {
    out = j[key].as_bool();
  } else if (w) {
    w->push_back(where + key + " must be a boolean");
  }
}
template <typename T>
void get_number(const Json& j, const char* key, T& out, const std::string& where, std::vector<std::string>* w,
                double min, double max) {
  if (!j.has(key)) return;
  double v = j[key].as_number(-1e300);
  if (j[key].is_number() && v >= min && v <= max) {
    out = static_cast<T>(v);
  } else if (w) {
    w->push_back(where + key + " must be a number in [" + std::to_string(min) + ", " + std::to_string(max) + "]");
  }
}

}  // namespace

RuntimeConfig parse_runtime_config(const Json& j, std::vector<std::string>* w, RuntimeConfig base) {
  RuntimeConfig c = std::move(base);
  if (!j.is_object()) {
    if (w && !j.is_null()) w->push_back("config root must be an object");
    return c;
  }
  get_string(j, "origin", c.origin, "", w);
  if (auto u = parse_url(c.origin); !u || u->origin() == "null") {
    if (w) w->push_back("origin must be an http(s) origin; using https://app.local");
    c.origin = "https://app.local";
  } else {
    c.origin = u->origin();
  }
  get_string(j, "appRoot", c.app_root, "", w);
  while (!c.app_root.empty() && c.app_root.back() == '/') c.app_root.pop_back();
  get_string(j, "index", c.index, "", w);
  if (j.has("preludes")) {
    if (j["preludes"].is_array()) {
      for (const auto& p : j["preludes"].items()) {
        if (p.is_string()) c.preludes.push_back(p.as_string());
      }
    } else if (w) {
      w->push_back("preludes must be an array of asset paths");
    }
  }
  const Json& insp = j["inspector"];
  get_bool(insp, "enabled", c.inspector_enabled, "inspector.", w);
  get_number(insp, "port", c.inspector_port, "inspector.", w, 1, 65535);
  get_bool(insp, "waitForDebugger", c.wait_for_debugger, "inspector.", w);
  const Json& dbg = j["debug"];
  get_bool(dbg, "enabled", c.debug_enabled, "debug.", w);
  get_number(dbg, "port", c.debug_port, "debug.", w, 0, 65535);
  get_string(j, "v8Flags", c.v8_flags, "", w);
  const Json& cc = j["codeCache"];
  get_bool(cc, "enabled", c.code_cache_enabled, "codeCache.", w);
  get_number(cc, "maxBytes", c.code_cache_max_bytes, "codeCache.", w, 0, 4e9);
  get_number(cc, "delayMs", c.code_cache_delay_ms, "codeCache.", w, 0, 3.6e6);
  get_number(j["stats"], "logIntervalMs", c.stats_log_interval_ms, "stats.", w, 0, 3.6e6);
  const Json& app = j["app"];
  get_string(app, "packageId", c.package_id, "app.", w);
  get_string(app, "versionName", c.version_name, "app.", w);
  get_number(app, "versionCode", c.version_code, "app.", w, 0, 2.1e9);
  if (j.has("glue")) c.glue = j["glue"];
  return c;
}

}  // namespace iwn
