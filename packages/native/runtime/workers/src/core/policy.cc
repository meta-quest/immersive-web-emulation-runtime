/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Worker policy: see policy.h. HTML §10.2.6 (Worker constructor: URL parsing, same-origin rule, data:/blob:),
// §10.3.4 (importScripts), Fetch "data: URL processor", MIME Sniffing "JavaScript MIME type".
#include "iwn/workers/policy.h"

#include <algorithm>
#include <cmath>

#include "iwn/core/text.h"

namespace iwn::workers {

namespace {

bool number_in(const Json& v, double lo, double hi, double* out) {
  if (!v.is_number()) return false;
  double d = v.as_number();
  if (!std::isfinite(d) || d < lo || d > hi) return false;
  *out = d;
  return true;
}

}  // namespace

WorkersConfig parse_workers_config(const Json& section, std::vector<std::string>* warnings) {
  WorkersConfig c;
  if (!section.is_object()) {
    if (!section.is_null() && warnings) warnings->push_back("workers: not an object; using defaults");
    return c;
  }
  auto warn = [&](const std::string& m) {
    if (warnings) warnings->push_back("workers." + m);
  };
  double d = 0;
  for (const auto& [key, v] : section.members()) {
    if (key == "maxWorkers") {
      if (number_in(v, 1, 1024, &d)) c.max_workers = static_cast<int>(d);
      else warn("maxWorkers must be a number in 1..1024");
    } else if (key == "heapLimitMB") {
      if (number_in(v, 16, 4096, &d)) c.heap_limit_bytes = static_cast<uint64_t>(d) << 20;
      else warn("heapLimitMB must be a number in 16..4096");
    } else if (key == "stackKB") {
      if (number_in(v, 512, 65536, &d)) c.stack_bytes = static_cast<size_t>(d) << 10;
      else warn("stackKB must be a number in 512..65536");
    } else if (key == "nice") {
      if (number_in(v, 0, 19, &d)) c.nice = static_cast<int>(d);
      else warn("nice must be a number in 0..19");
    } else if (key == "crossOriginIsolated") {
      if (v.is_bool()) c.cross_origin_isolated = v.as_bool();
      else warn("crossOriginIsolated must be a boolean");
    } else if (key == "hardwareConcurrency") {
      if (number_in(v, 1, 256, &d)) c.hardware_concurrency = static_cast<int>(d);
      else warn("hardwareConcurrency must be a number in 1..256");
    } else if (key == "preludes") {
      if (v.is_array()) {
        std::vector<std::string> list;
        bool ok = true;
        for (const auto& item : v.items()) {
          if (!item.is_string()) ok = false;
          else list.push_back(item.as_string());
        }
        if (ok) c.preludes = std::move(list);
        else warn("preludes must be an array of strings");
      } else {
        warn("preludes must be an array of strings");
      }
    } else if (key == "excludeModules") {
      if (v.is_array()) {
        std::vector<std::string> list;
        bool ok = true;
        for (const auto& item : v.items()) {
          if (!item.is_string()) ok = false;
          else list.push_back(item.as_string());
        }
        if (ok) c.exclude_modules = std::move(list);
        else warn("excludeModules must be an array of strings");
      } else {
        warn("excludeModules must be an array of strings");
      }
    } else if (key == "messageLog") {
      if (number_in(v, -1, 100000, &d)) c.message_log = static_cast<int>(d);
      else warn("messageLog must be a number in -1..100000");
    } else if (key == "joinTimeoutMs") {
      if (number_in(v, 0, 60000, &d)) c.join_timeout_ms = d;
      else warn("joinTimeoutMs must be a number in 0..60000");
    } else if (key == "codeCacheMB") {
      if (number_in(v, 0, 1024, &d)) c.code_cache_bytes = static_cast<size_t>(d) << 20;
      else warn("codeCacheMB must be a number in 0..1024");
    } else {
      warn(key + ": unknown key (ignored)");
    }
  }
  return c;
}

int capped_concurrency(int cores, int cap) {
  if (cores < 1) cores = 1;
  if (cap < 1) cap = 1;
  return std::min(cores, cap);
}

bool WorkerLimiter::try_acquire() {
  int cur = live_.load();
  while (true) {
    if (cur >= max_.load()) return false;
    if (live_.compare_exchange_weak(cur, cur + 1)) break;
  }
  created_++;
  return true;
}

void WorkerLimiter::release() {
  int cur = live_.load();
  while (cur > 0 && !live_.compare_exchange_weak(cur, cur - 1)) {
  }
}

WorkerUrlCheck check_worker_url(const Url& url, const std::string& creator_origin) {
  if (url.scheme == "data" || url.scheme == "blob") return WorkerUrlCheck::kOk;
  if (url.scheme != "http" && url.scheme != "https") return WorkerUrlCheck::kUnsupportedScheme;
  return url.origin() == creator_origin ? WorkerUrlCheck::kOk : WorkerUrlCheck::kCrossOrigin;
}

FetchedScript fetch_script(const std::string& url_text, const ScriptSource& from, bool require_js_mime) {
  FetchedScript r;
  auto url = parse_url(url_text);
  if (!url) {
    r.error = "invalid URL " + url_text;
    return r;
  }
  if (url->scheme == "data") {
    auto d = decode_data_url(url_text);
    if (!d) {
      r.error = "malformed data: URL";
      return r;
    }
    r.mime = d->mime_type;
    r.source.assign(reinterpret_cast<const char*>(d->body.data()), d->body.size());
  } else if (url->scheme == "http" || url->scheme == "https") {
    auto path = app_asset_path(*url, from.app_origin);
    if (!path) {
      if (url->origin() != from.app_origin.origin()) {
        r.error = "cross-origin script " + url_text + " (only same-origin, data: and blob: URLs load here)";
      } else {
        r.error = "not found: " + url_text;
      }
      return r;
    }
    if (!from.assets) {
      r.error = "no asset source";
      return r;
    }
    std::string asset = from.app_root.empty() ? *path : from.app_root + "/" + *path;
    auto bytes = from.assets->read(asset);
    if (!bytes) {
      r.error = "not found (404): " + url_text;
      return r;
    }
    r.source.assign(bytes->view());
    r.mime = std::string(mime_type_for_path(*path));
  } else {
    r.error = "unsupported URL scheme \"" + url->scheme + ":\" for a script: " + url_text;
    return r;
  }
  if (require_js_mime && !r.mime.empty() && !is_javascript_mime(r.mime)) {
    r.error = "MIME type \"" + r.mime + "\" of " + url_text + " is not JavaScript";
    r.source.clear();
    return r;
  }
  r.ok = true;
  return r;
}

std::string worker_thread_name(uint64_t id, const std::string& name) {
  std::string out = "iwn-w" + std::to_string(id);
  if (!name.empty() && out.size() < 14) {
    out += '-';
    for (char c : name) {
      if (out.size() >= 15) break;
      bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' ||
                c == '-';
      out += ok ? c : '_';
    }
  }
  if (out.size() > 15) out.resize(15);
  return out;
}

std::string worker_label(uint64_t id, const std::string& name, const std::string& url) {
  std::string label = "worker " + std::to_string(id);
  if (!name.empty()) return label + " '" + name + "'";
  if (url.empty()) return label;
  // Keep data:/blob: URLs short in logs.
  std::string u = url.size() > 80 ? url.substr(0, 77) + "..." : url;
  return label + " " + u;
}

}  // namespace iwn::workers
