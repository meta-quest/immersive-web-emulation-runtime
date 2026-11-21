/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The loading screen's policy, placement, layout and images (see iwn/xr/loading.h). Sources: OpenXR 1.1 §12
// (composition layers: quad layer pose and size, premultiplied alpha, XR_KHR_composition_layer_color_scale_bias),
// XR_FB_passthrough (passthrough layers) and XR_META_passthrough_preferences (the system's passthrough
// recommendation), Meta's public "Add a Splash Screen" / "Splash screen best practices" / "Passthrough Loading
// Screen" documentation (the system splash's behaviour: world-locked, re-centred when the head turns away, gone on
// the app's first frame; its black or contextual-passthrough background; an app that shows passthrough while it
// loads starts its own passthrough layer and follows the system's recommendation), and Horizon OS's observed splash
// placement (6 m, fitted to 80 x 20 degrees).
#include "iwn/xr/loading.h"

#include <algorithm>
#include <cmath>

namespace iwn::xr {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;

void warn(std::vector<std::string>* w, std::string msg) {
  if (w) w->push_back(std::move(msg));
}

double number_in(const Json& obj, const char* key, double def, double lo, double hi, std::vector<std::string>* w) {
  const Json& v = obj[key];
  if (v.is_null()) return def;
  if (!v.is_number() || !std::isfinite(v.as_number())) {
    warn(w, std::string("xr.loading.") + key + " must be a number");
    return def;
  }
  const double n = v.as_number();
  if (n < lo || n > hi) {
    warn(w, std::string("xr.loading.") + key + " must be within [" + std::to_string(lo) + ", " + std::to_string(hi) +
                "]");
    return def;
  }
  return n;
}

bool boolean(const Json& obj, const char* key, bool def, std::vector<std::string>* w) {
  const Json& v = obj[key];
  if (v.is_null()) return def;
  if (!v.is_bool()) {
    warn(w, std::string("xr.loading.") + key + " must be true or false");
    return def;
  }
  return v.as_bool();
}

int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

double wrap_angle(double a) {
  a = std::fmod(a + kPi, 2 * kPi);
  if (a < 0) a += 2 * kPi;
  return a - kPi;
}

float smoothstep01(double t) {
  t = std::clamp(t, 0.0, 1.0);
  return static_cast<float>(t * t * (3 - 2 * t));
}

}  // namespace

bool parse_hex_color(std::string_view t, float out[3]) {
  if (t.empty() || t[0] != '#') return false;
  t.remove_prefix(1);
  int v[6];
  if (t.size() == 3) {
    for (int i = 0; i < 3; ++i) {
      const int d = hex_digit(t[static_cast<size_t>(i)]);
      if (d < 0) return false;
      v[2 * i] = v[2 * i + 1] = d;
    }
  } else if (t.size() == 6) {
    for (int i = 0; i < 6; ++i) {
      v[i] = hex_digit(t[static_cast<size_t>(i)]);
      if (v[i] < 0) return false;
    }
  } else {
    return false;
  }
  for (int i = 0; i < 3; ++i) out[i] = static_cast<float>(v[2 * i] * 16 + v[2 * i + 1]) / 255.0f;
  return true;
}

bool is_black(const float rgb[3]) { return rgb[0] <= 0.0f && rgb[1] <= 0.0f && rgb[2] <= 0.0f; }

float srgb_to_linear(float c) {
  c = std::clamp(c, 0.0f, 1.0f);
  return c <= 0.04045f ? c / 12.92f : static_cast<float>(std::pow((c + 0.055) / 1.055, 2.4));
}

LoadingConfig parse_loading_config(const Json& root, std::vector<std::string>* w) {
  LoadingConfig c;
  const Json& xr = root["xr"];
  if (!xr.is_object()) return c;
  const Json& l = xr["loading"];
  if (l.is_null()) return c;
  if (l.is_bool()) {  // "loading": false turns it off, true keeps the defaults
    c.enabled = l.as_bool();
    return c;
  }
  if (!l.is_object()) {
    warn(w, "xr.loading must be an object or a boolean");
    return c;
  }
  static const char* kKnown[] = {"enabled", "image", "background", "distance", "heightDeg", "maxWidthDeg",
                                 "spinner", "fadeMs",  "followDeg"};
  for (const auto& [key, value] : l.members()) {
    bool known = false;
    for (const char* k : kKnown) known = known || key == k;
    if (!known) warn(w, "xr.loading." + key + " is not a known key (ignored)");
  }
  c.enabled = boolean(l, "enabled", c.enabled, w);
  const Json& image = l["image"];
  if (image.is_string()) {
    c.image = image.as_string();
  } else if (image.is_null() && l.has("image")) {
    c.image.clear();  // "image": null: no card, spinner only
  } else if (!image.is_null()) {
    warn(w, "xr.loading.image must be an asset path or null");
  }
  const Json& bg = l["background"];
  constexpr const char* kBackgroundValues = "xr.loading.background must be \"contextual\", \"black\" or a colour like "
                                            "\"#000000\"";
  if (bg.is_string()) {
    float rgb[3];
    if (bg.as_string() == "contextual") {
      c.contextual = true;  // the default colour (black) when passthrough is not recommended
    } else if (bg.as_string() == "black") {
      c.contextual = false;
    } else if (parse_hex_color(bg.as_string(), rgb)) {
      c.contextual = false;
      for (int i = 0; i < 3; ++i) c.background[i] = rgb[i];
    } else {
      warn(w, kBackgroundValues);
    }
  } else if (!bg.is_null()) {
    warn(w, kBackgroundValues);
  }
  c.distance_m = number_in(l, "distance", c.distance_m, 0.5, 50, w);
  c.height_deg = number_in(l, "heightDeg", c.height_deg, 2, 90, w);
  c.max_width_deg = number_in(l, "maxWidthDeg", c.max_width_deg, 2, 150, w);
  c.spinner = boolean(l, "spinner", c.spinner, w);
  c.fade_ms = number_in(l, "fadeMs", c.fade_ms, 0, 5000, w);
  c.follow_deg = number_in(l, "followDeg", c.follow_deg, 0, 180, w);
  return c;
}

const char* loading_background_name(LoadingBackground b) {
  switch (b) {
    case LoadingBackground::kColour: return "colour";
    case LoadingBackground::kPassthrough: return "passthrough";
  }
  return "?";
}

LoadingBackground loading_background(const LoadingConfig& config, const LoadingOrigin& origin,
                                     bool passthrough_available) {
  if (!config.contextual || !passthrough_available) return LoadingBackground::kColour;
  const bool from_passthrough = origin.after_content ? origin.content_passthrough : origin.recommended == 1;
  return from_passthrough ? LoadingBackground::kPassthrough : LoadingBackground::kColour;
}

const char* app_fade_name(AppFade f) {
  switch (f) {
    case AppFade::kNone: return "none";
    case AppFade::kFromColour: return "from-colour";
    case AppFade::kAlpha: return "alpha";
  }
  return "?";
}

FrameLayerPlan plan_frame_layers(const FrameLayerInput& in, const LoadingPolicy::Frame& lf) {
  FrameLayerPlan p;
  if (!in.render) return p;
  p.projection = in.webxr_active && in.app_frame;
  p.quads = lf.loading && in.loading_ready;
  p.quad_alpha = p.quads ? std::clamp(lf.loading_alpha, 0.0f, 1.0f) : 0.0f;
  // The loading screen's passthrough shows only behind the quads, before the app has a frame under them; a session's
  // passthrough (immersive-ar) under all its frames.
  const bool loading_passthrough = in.background == LoadingBackground::kPassthrough && in.passthrough_ready;
  const bool session_passthrough = in.webxr_active && in.session_ar && in.passthrough_ready;
  // The opaque background where nothing else fills the view: behind the quads without passthrough (this is what the
  // user sees from a virtual home, and when passthrough is wanted but not running), and a session's frames without an
  // app frame (resumed, no head pose yet) unless the session shows passthrough.
  p.cover = in.cover_ready && !p.projection &&
            (p.quads ? !loading_passthrough : in.webxr_active && !session_passthrough);
  p.passthrough = !p.cover && (session_passthrough || (p.quads && loading_passthrough && !p.projection));
  if (p.projection && lf.app_scale < 1.0f) {
    const float s = std::clamp(lf.app_scale, 0.0f, 1.0f);
    if (session_passthrough) {
      p.app_fade = AppFade::kAlpha;  // immersive-ar content blends in over the room
      p.app_scale = s;
    } else if (loading_passthrough) {
      p.app_fade = AppFade::kNone;  // the room was behind the card: an opaque frame replaces it at once
    } else {
      p.app_fade = AppFade::kFromColour;  // from the background colour the user saw behind the card (or black)
      p.app_scale = s;
      p.app_bias = in.cover_ready ? 1.0f - s : 0.0f;
    }
  }
  return p;
}

const char* loading_phase_name(LoadingPhase p) {
  switch (p) {
    case LoadingPhase::kOff: return "off";
    case LoadingPhase::kLoading: return "loading";
    case LoadingPhase::kHandover: return "handover";
    case LoadingPhase::kApp: return "app";
  }
  return "?";
}

// --- policy ----------------------------------------------------------------------------------------------------------

LoadingPolicy::LoadingPolicy(bool enabled, double fade_ms)
    : phase_(enabled ? LoadingPhase::kLoading : LoadingPhase::kOff), fade_ms_(fade_ms > 0 ? fade_ms : 0) {}

LoadingPolicy::Frame LoadingPolicy::frame(double now, bool app_layer) {
  Frame f;
  switch (phase_) {
    case LoadingPhase::kOff:
    case LoadingPhase::kApp:
      return f;  // the app's layers only (or nothing yet)
    case LoadingPhase::kLoading:
      if (loading_since_ms_ < 0) loading_since_ms_ = now;
      if (!app_layer) {
        f.loading = true;
        f.loading_alpha = 1;
        if (!shown_) {
          shown_ = true;
          f.first_loading = true;
        }
        return f;
      }
      // The app's first projection layer: the hand-over starts with this frame. After a loading period shorter than
      // the fade (an immediate session restart: the loading screen was up for a frame or two) the app is back in
      // one frame instead of fading in from black.
      phase_ = LoadingPhase::kHandover;
      handover_ms_ = now;
      last_duration_ms_ = now - loading_since_ms_;
      handover_fade_ms_ = last_duration_ms_ < fade_ms_ ? 0 : fade_ms_;
      ++handovers_;
      f.handover = true;
      [[fallthrough]];
    case LoadingPhase::kHandover: {
      const double t = handover_fade_ms_ > 0 ? (now - handover_ms_) / handover_fade_ms_ : 1.0;
      if (t >= 1.0) {
        phase_ = LoadingPhase::kApp;
        f.handover_done = true;
        return f;
      }
      const float e = smoothstep01(t);
      f.loading = true;
      f.loading_alpha = 1.0f - e;
      f.app_scale = e;
      return f;
    }
  }
  return f;
}

void LoadingPolicy::content_lost(double now) {
  if (phase_ == LoadingPhase::kOff) return;
  if (phase_ != LoadingPhase::kLoading) loading_since_ms_ = now;
  phase_ = LoadingPhase::kLoading;
}

// --- placement and layout ------------------------------------------------------------------------------------------

XrQuaternionf mul(const XrQuaternionf& a, const XrQuaternionf& b) {
  return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
          a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}

XrVector3f rotate(const XrQuaternionf& q, const XrVector3f& v) {
  // v' = v + 2w (u x v) + 2 u x (u x v), u = (x, y, z)
  const float tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz),
          v.z + q.w * tz + (q.x * ty - q.y * tx)};
}

XrPosef compose(const XrPosef& parent, const XrPosef& child) {
  XrPosef out;
  const XrVector3f p = rotate(parent.orientation, child.position);
  out.position = {parent.position.x + p.x, parent.position.y + p.y, parent.position.z + p.z};
  out.orientation = mul(parent.orientation, child.orientation);
  return out;
}

double yaw_of(const XrQuaternionf& q, bool* ok) {
  const XrVector3f f = rotate(q, {0, 0, -1});
  const double h = std::hypot(f.x, f.z);
  if (!(h > 0.2)) {  // within ~78 degrees of straight up or down: no usable heading
    if (ok) *ok = false;
    return 0;
  }
  if (ok) *ok = true;
  return std::atan2(-f.x, -f.z);
}

double pitch_of(const XrQuaternionf& q) {
  const XrVector3f f = rotate(q, {0, 0, -1});
  const double n = std::sqrt(static_cast<double>(f.x) * f.x + static_cast<double>(f.y) * f.y +
                             static_cast<double>(f.z) * f.z);
  return n > 0 ? std::asin(std::clamp(f.y / n, -1.0, 1.0)) : 0.0;
}

double heading_of(const XrQuaternionf& q) {
  // q = twist(about +Y) * swing(about a horizontal axis), in either order: q.y and q.w are the twist's, scaled by the
  // cosine of half the swing angle, so the twist is 2 atan2(q.y, q.w). Continuous everywhere except where the swing
  // is a half turn (a head upside down).
  const double n = std::hypot(static_cast<double>(q.y), static_cast<double>(q.w));
  if (n > 1e-3) return wrap_angle(2 * std::atan2(static_cast<double>(q.y), static_cast<double>(q.w)));
  bool ok = false;
  const double gaze = yaw_of(q, &ok);
  return ok ? gaze : 0.0;
}

XrQuaternionf yaw_quat(double yaw) {
  return {0, static_cast<float>(std::sin(yaw / 2)), 0, static_cast<float>(std::cos(yaw / 2))};
}

double angle_between(const XrVector3f& a, const XrVector3f& b) {
  // atan2(|a x b|, a . b): accurate for small angles too (acos of the dot product is not)
  const double cx = static_cast<double>(a.y) * b.z - static_cast<double>(a.z) * b.y;
  const double cy = static_cast<double>(a.z) * b.x - static_cast<double>(a.x) * b.z;
  const double cz = static_cast<double>(a.x) * b.y - static_cast<double>(a.y) * b.x;
  const double dot = static_cast<double>(a.x) * b.x + static_cast<double>(a.y) * b.y + static_cast<double>(a.z) * b.z;
  return std::atan2(std::sqrt(cx * cx + cy * cy + cz * cz), dot);
}

double angle_between(const XrQuaternionf& a, const XrQuaternionf& b) {
  // The relative rotation's angle: 2 atan2(|vector part|, |scalar part|) of conj(a) * b, sign-independent.
  const XrQuaternionf r = mul({-a.x, -a.y, -a.z, a.w}, b);
  const double v = std::sqrt(static_cast<double>(r.x) * r.x + static_cast<double>(r.y) * r.y +
                             static_cast<double>(r.z) * r.z);
  return 2 * std::atan2(v, std::fabs(static_cast<double>(r.w)));
}

XrQuaternionf spinner_roll(double now_ms, double period_ms) {
  if (!(period_ms > 0)) period_ms = 1100;
  double phase = std::fmod(now_ms, period_ms) / period_ms;
  if (phase < 0) phase += 1;
  const double a = -2 * kPi * phase;  // negative about +Z: clockwise seen from the quad's front (+Z)
  return {0, 0, static_cast<float>(std::sin(a / 2)), static_cast<float>(std::cos(a / 2))};
}

XrQuaternionf LoadingPlacement::target(const XrQuaternionf& head, bool* horizon) {
  if (std::fabs(pitch_of(head)) <= kLoadingHorizonPitchDeg * kDeg) {
    // On the horizon straight ahead of the gaze, upright, as the system splash (the gaze has a heading up to ~78
    // degrees of pitch, so always here).
    if (horizon) *horizon = true;
    return yaw_quat(yaw_of(head, nullptr));
  }
  // The system splash is out of view at this pitch: where the head looks, as the head is turned.
  if (horizon) *horizon = false;
  const double n = std::sqrt(static_cast<double>(head.x) * head.x + static_cast<double>(head.y) * head.y +
                             static_cast<double>(head.z) * head.z + static_cast<double>(head.w) * head.w);
  if (!(n > 0)) return {0, 0, 0, 1};
  return {static_cast<float>(head.x / n), static_cast<float>(head.y / n), static_cast<float>(head.z / n),
          static_cast<float>(head.w / n)};
}

XrQuaternionf LoadingPlacement::orientation() const {
  return {static_cast<float>(q_[0]), static_cast<float>(q_[1]), static_cast<float>(q_[2]), static_cast<float>(q_[3])};
}

double LoadingPlacement::yaw() const { return heading_of(orientation()); }

double LoadingPlacement::pitch() const { return pitch_of(orientation()); }

XrPosef LoadingPlacement::update(const XrPosef& head, double now) {
  bool horizon = true;
  const XrQuaternionf to = target(head.orientation, &horizon);
  if (!have_) {
    q_[0] = to.x;
    q_[1] = to.y;
    q_[2] = to.z;
    q_[3] = to.w;
    have_ = true;
    gliding_ = false;
    horizon_ = horizon;
  } else {
    if (!gliding_ && angle_between(orientation(), to) > kDeg) {
      // Glide once the gaze, in any direction, is further than follow_deg from the card's centre (unless the card is
      // already where it would glide to: with a small follow_deg the horizon itself can be further than that).
      const XrVector3f gaze = rotate(head.orientation, {0, 0, -1});
      if (angle_between(gaze, rotate(orientation(), {0, 0, -1})) > follow_rad_) gliding_ = true;
    }
    if (gliding_) {
      // Exponential approach along the shortest rotation (time constant 140 ms), frame-rate independent; done within
      // ~1 degree. Between two upright orientations (on the horizon) it only turns about the vertical.
      horizon_ = horizon;
      const double dt = std::clamp(now - last_ms_, 0.0, 100.0);
      const double k = 1.0 - std::exp(-dt / 140.0);
      double b[4] = {to.x, to.y, to.z, to.w};
      double dot = q_[0] * b[0] + q_[1] * b[1] + q_[2] * b[2] + q_[3] * b[3];
      if (dot < 0) {
        for (double& c : b) c = -c;
        dot = -dot;
      }
      double s0 = 1 - k, s1 = k;
      if (dot < 0.9995) {
        const double theta = std::acos(std::clamp(dot, -1.0, 1.0));
        s0 = std::sin((1 - k) * theta) / std::sin(theta);
        s1 = std::sin(k * theta) / std::sin(theta);
      }
      double len = 0;
      for (int i = 0; i < 4; ++i) {
        q_[i] = s0 * q_[i] + s1 * b[i];
        len += q_[i] * q_[i];
      }
      len = std::sqrt(len);
      for (double& c : q_) c /= len;
      if (angle_between(orientation(), to) < kDeg) gliding_ = false;
    }
  }
  last_ms_ = now;
  XrPosef out;
  out.position = head.position;
  out.orientation = orientation();
  return out;
}

LoadingLayout loading_layout(const LoadingConfig& c, int w, int h) {
  LoadingLayout l;
  const double d = c.distance_m > 0.3 ? c.distance_m : 6.0;
  float card_h = 0;
  if (w > 0 && h > 0) {
    // The largest rectangle with the image's aspect that fits the box (Horizon OS sizes its splash the same way).
    const double box_h = 2 * d * std::tan(std::clamp(c.height_deg, 1.0, 120.0) * kDeg / 2);
    const double box_w = 2 * d * std::tan(std::clamp(c.max_width_deg, 1.0, 150.0) * kDeg / 2);
    const double s = std::min(box_w / w, box_h / h);
    l.card = true;
    l.card_w = static_cast<float>(w * s);
    l.card_h = card_h = static_cast<float>(h * s);
    l.card_center = {0, 0, static_cast<float>(-d)};
  }
  if (c.spinner) {
    const double size = 2 * d * std::tan(3.2 * kDeg / 2);
    const double gap = 2 * d * std::tan(1.6 * kDeg / 2);
    l.spinner_size = static_cast<float>(size);
    const double y = l.card ? -(card_h / 2 + gap + size / 2) : 0.0;
    l.spinner_center = {0, static_cast<float>(y), static_cast<float>(-d)};
  }
  return l;
}

// --- images ----------------------------------------------------------------------------------------------------------

std::vector<uint8_t> spinner_image(int size) {
  size = std::clamp(size, 16, 2048);
  std::vector<uint8_t> px(static_cast<size_t>(size) * size * 4, 0);
  const double c = size / 2.0;
  const double r_out = size * 0.46, r_in = size * 0.36;
  const double mid = (r_out + r_in) / 2, half = (r_out - r_in) / 2;
  const double span = 300 * kDeg;      // the tail
  const double head = 90 * kDeg;       // where the head sits in the image (display orientation: up)
  const double head_x = c + mid * std::cos(head), head_y = c - mid * std::sin(head);
  for (int y = 0; y < size; ++y) {
    for (int x = 0; x < size; ++x) {
      const double dx = x + 0.5 - c, dy = c - (y + 0.5);  // display orientation: +y up
      const double r = std::hypot(dx, dy);
      const double radial = std::clamp(std::min(r - r_in, r_out - r) + 0.5, 0.0, 1.0);
      // How far behind the head (counter-clockwise from it: the spinner turns clockwise) this pixel is.
      double behind = std::atan2(dy, dx) - head;
      behind = std::fmod(behind, 2 * kPi);
      if (behind < 0) behind += 2 * kPi;
      const double tail = behind <= span ? std::pow(1.0 - behind / span, 1.6) : 0.0;
      const double cap = std::clamp(half - std::hypot(x + 0.5 - head_x, y + 0.5 - head_y) + 0.5, 0.0, 1.0);
      const double a = std::max(radial * tail, cap);
      const auto v = static_cast<uint8_t>(std::lround(std::clamp(a, 0.0, 1.0) * 255.0));
      uint8_t* p = &px[(static_cast<size_t>(y) * size + x) * 4];
      p[0] = p[1] = p[2] = p[3] = v;  // premultiplied white
    }
  }
  return px;
}

void premultiply_rgba(uint8_t* p, size_t n) {
  for (size_t i = 0; i < n; ++i, p += 4) {
    const unsigned a = p[3];
    if (a == 255) continue;
    p[0] = static_cast<uint8_t>((p[0] * a + 127) / 255);
    p[1] = static_cast<uint8_t>((p[1] * a + 127) / 255);
    p[2] = static_cast<uint8_t>((p[2] * a + 127) / 255);
  }
}

}  // namespace iwn::xr
