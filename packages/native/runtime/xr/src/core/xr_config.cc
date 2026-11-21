#include "iwn/xr/xr_config.h"

#include <cmath>

namespace iwn::xr {

FoveationLevel foveation_level_for(double v) {
  if (!(v > 0)) return FoveationLevel::kNone;
  if (v >= 1) return FoveationLevel::kHigh;
  return static_cast<FoveationLevel>(static_cast<int>(std::lround(v * 3.0)));
}

double foveation_value_for(FoveationLevel level) { return static_cast<int>(level) / 3.0; }

const char* foveation_level_name(FoveationLevel level) {
  switch (level) {
    case FoveationLevel::kNone: return "none";
    case FoveationLevel::kLow: return "low";
    case FoveationLevel::kMedium: return "medium";
    case FoveationLevel::kHigh: return "high";
  }
  return "?";
}

FoveationParams foveation_params_for(FoveationLevel level) {
  switch (level) {
    case FoveationLevel::kNone: return {0.0f, 0.0f, 1.0f};
    case FoveationLevel::kLow: return {2.0f, 0.0f, 0.5f};
    case FoveationLevel::kMedium: return {3.0f, 0.0f, 0.25f};
    case FoveationLevel::kHigh: return {4.0f, 0.0f, 0.25f};
  }
  return {};
}

void foveation_focal_point(float angle_left, float angle_right, float angle_up, float angle_down, float* x, float* y) {
  // NDC x = (2 tx - (tanR + tanL)) / (tanR - tanL) for a direction with x/-z = tx; the forward direction has tx = 0.
  const double l = std::tan(angle_left), r = std::tan(angle_right), u = std::tan(angle_up), d = std::tan(angle_down);
  const double fx = (r - l) > 1e-6 ? -(r + l) / (r - l) : 0.0;
  const double fy = (u - d) > 1e-6 ? -(u + d) / (u - d) : 0.0;
  *x = static_cast<float>(std::fmin(1.0, std::fmax(-1.0, fx)));
  *y = static_cast<float>(std::fmin(1.0, std::fmax(-1.0, fy)));
}

bool parse_foveation_level(std::string_view t, FoveationLevel* out) {
  if (t == "none") *out = FoveationLevel::kNone;
  else if (t == "low") *out = FoveationLevel::kLow;
  else if (t == "medium") *out = FoveationLevel::kMedium;
  else if (t == "high") *out = FoveationLevel::kHigh;
  else return false;
  return true;
}

namespace {

void warn(std::vector<std::string>* w, std::string msg) {
  if (w) w->push_back(std::move(msg));
}

double number(const Json& obj, const char* key, double def, std::vector<std::string>* w, const char* path) {
  const Json& v = obj[key];
  if (v.is_null()) return def;
  if (!v.is_number()) {
    warn(w, std::string(path) + "." + key + " must be a number");
    return def;
  }
  return v.as_number();
}

PerfLevel level(const Json& obj, const char* key, PerfLevel def, std::vector<std::string>* w) {
  const Json& v = obj[key];
  if (v.is_null()) return def;
  if (!v.is_string()) {
    warn(w, std::string("xr.perf.") + key + " must be a string");
    return def;
  }
  PerfLevel l = parse_perf_level(v.as_string(), static_cast<PerfLevel>(-2));
  if (static_cast<int>(l) == -2) {
    warn(w, std::string("xr.perf.") + key + ": unknown level '" + v.as_string() + "'");
    return def;
  }
  return l;
}

}  // namespace

XrConfig parse_xr_config(const Json& root, std::vector<std::string>* w) {
  XrConfig c;
  const Json& stats = root["stats"];
  if (stats.is_object()) c.stats_interval_ms = number(stats, "logIntervalMs", 0, w, "stats");
  const Json& xr = root["xr"];
  if (xr.is_null()) return c;
  if (!xr.is_object()) {
    warn(w, "xr must be an object");
    return c;
  }
  // "features" is the packer's record of the manifest features it declared (packager/src/runtime-config.ts); the
  // runtime reads capabilities from OpenXR instead, so it is accepted and not used.
  static const char* kKnown[] = {"frameRate", "foveation", "grant", "endGraceMs", "neverOffered", "perf",
                                 "eyeBufferScale", "colorSpace", "frameDeadlinePeriods", "disableExtensions",
                                 "features", "immersiveAr", "loading"};
  for (const auto& [key, value] : xr.members()) {
    bool known = false;
    for (const char* k : kKnown) known = known || key == k;
    if (!known) warn(w, "xr." + key + " is not a known key (ignored)");
  }
  c.frame_rate = number(xr, "frameRate", 0, w, "xr");
  if (c.frame_rate < 0) c.frame_rate = 0;
  c.immersive_ar = xr["immersiveAr"].as_bool(false);

  const Json& fov = xr["foveation"];
  if (fov.is_number()) {
    c.foveation = std::fmin(1.0, std::fmax(0.0, fov.as_number()));
  } else if (fov.is_string() || fov.is_object()) {
    const Json& lv = fov.is_object() ? fov["level"] : fov;
    FoveationLevel l;
    if (lv.is_string() && parse_foveation_level(lv.as_string(), &l)) {
      c.foveation = foveation_value_for(l);
    } else if (lv.is_number()) {
      c.foveation = std::fmin(1.0, std::fmax(0.0, lv.as_number()));
    } else if (!lv.is_null()) {
      warn(w, "xr.foveation: expected none|low|medium|high or 0..1");
    }
    if (fov.is_object()) c.foveation_dynamic = fov["dynamic"].as_bool(false);
  } else if (!fov.is_null()) {
    warn(w, "xr.foveation: expected a level name, a number or an object");
  }

  const Json& grant = xr["grant"];
  if (grant.is_string()) {
    if (grant.as_string() == "explicit") c.explicit_grant = true;
    else if (grant.as_string() != "auto") warn(w, "xr.grant must be 'auto' or 'explicit'");
  }
  c.life.end_grace_ms = number(xr, "endGraceMs", c.life.end_grace_ms, w, "xr");
  const Json& never = xr["neverOffered"];
  if (never.is_object()) {
    c.life.never_offered_error_ms = number(never, "errorMs", c.life.never_offered_error_ms, w, "xr.neverOffered");
    c.life.never_offered_exit_ms = number(never, "exitMs", c.life.never_offered_exit_ms, w, "xr.neverOffered");
  }
  const Json& perf = xr["perf"];
  if (perf.is_object()) {
    c.perf.cpu_start = level(perf, "cpu", c.perf.cpu_start, w);
    c.perf.gpu_start = level(perf, "gpu", c.perf.gpu_start, w);
    c.perf.cpu_max = level(perf, "cpuMax", c.perf.cpu_max, w);
    c.perf.gpu_max = level(perf, "gpuMax", c.perf.gpu_max, w);
    c.perf.adaptive = perf["adaptive"].as_bool(c.perf.adaptive);
  }
  c.eye_buffer_scale = number(xr, "eyeBufferScale", 1.0, w, "xr");
  if (!(c.eye_buffer_scale > 0.1) || c.eye_buffer_scale > 2.0) {
    warn(w, "xr.eyeBufferScale must be in (0.1, 2]; using 1");
    c.eye_buffer_scale = 1.0;
  }
  const Json& cs = xr["colorSpace"];
  if (cs.is_string()) c.color_space = cs.as_string();
  c.frame_deadline_periods = number(xr, "frameDeadlinePeriods", 1.0, w, "xr");
  if (!(c.frame_deadline_periods >= 0.25) || c.frame_deadline_periods > 8) c.frame_deadline_periods = 1.0;
  const Json& dis = xr["disableExtensions"];
  if (dis.is_array()) {
    for (const Json& e : dis.items()) {
      if (e.is_string()) c.disabled_extensions.push_back(e.as_string());
    }
  }
  c.loading = parse_loading_config(root, w);
  return c;
}

}  // namespace iwn::xr
