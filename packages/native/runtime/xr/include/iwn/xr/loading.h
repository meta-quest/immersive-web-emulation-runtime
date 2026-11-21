// The loading screen: what the runtime shows from its first OpenXR frame until the app's first WebXR frame, and
// again whenever the page has no WebXR content (a reload, between sessions). docs/spec/08 XR-IDLE-1 (the idle
// presentation's optional loading image). V8-free and OpenXR-call-free, so it is unit-tested on the host; the XR
// thread owns the swapchains and builds the composition layers (src/android/xr_loading.cc).
//
// What the user sees: the app's splash image (assets/vr_splash.png, the same file Horizon OS shows as the system
// splash while the process starts) on a quad layer at Horizon OS's splash distance and size, an animated spinner
// below it, and a background behind them (LoadingBackground). The quads are world-locked: on the horizon ahead while
// the head is roughly level (where the system splash is), along the gaze when it is not (lying down, looking at the
// floor), and they glide back in front when the gaze moves away (LoadingPlacement). When the app's first projection
// layer is submitted, the loading layers fade out over it while it comes in (AppFade).
//
// The background. What a headset shows behind a frame without an opaque layer is up to the system (Horizon OS can
// show passthrough there), so the loading screen always submits a background of its own: an opaque projection layer
// in the configured colour (black by default), or for a contextual background a passthrough layer that the runtime
// submits itself (XR_FB_passthrough, which Horizon OS offers only to apps whose manifest declares
// com.oculus.feature.PASSTHROUGH; the packer makes "contextual" the default for those apps and declares the system
// splash's `com.oculus.ossplash.background` "passthrough-contextual" with it) when the user comes from passthrough:
// at launch when the system recommends passthrough (XR_META_passthrough_preferences: the user's home is passthrough),
// after a reload or the end of a session when the session that ended showed passthrough (loading_background()). A
// VR app's frames between a resume and its next frame get the opaque layer too (plan_frame_layers()): no frame of the
// app is left without a layer that fills the view.
//
// Config: the `xr.loading` section of assets/iwn/config.json (written by the packer from native.splash):
//   "loading": { "enabled": true, "image": "vr_splash.png", "background": "black", "distance": 6,
//                "heightDeg": 20, "maxWidthDeg": 80, "spinner": true, "fadeMs": 250, "followDeg": 35 }
// "background": "black" | "#rrggbb" (an opaque colour, never passthrough) | "contextual" (absent: contextual, which
// for an app without passthrough is black).
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

struct LoadingConfig {
  bool enabled = true;
  // Asset path (relative to assets/) of the image shown on the card; "" for none (spinner only).
  std::string image = "vr_splash.png";
  // Background colour, display (sRGB-encoded) values 0..1, of the opaque background layer.
  float background[3] = {0, 0, 0};
  // Contextual background: passthrough instead of the colour for a user who comes from passthrough, when the runtime
  // can submit a passthrough layer (loading_background()).
  bool contextual = true;
  // Horizon OS's system splash: 6 m ahead, the image scaled to fit 80 x 20 degrees (wider images are limited by the
  // width). Matching it lets the system splash turn into the runtime's loading screen without a jump.
  double distance_m = 6.0;
  double height_deg = 20.0;
  double max_width_deg = 80.0;
  bool spinner = true;
  double fade_ms = 250;    // hand-over cross-fade (0: switch in one frame)
  double follow_deg = 35;  // the card glides back in front once the gaze is further away from it than this
};

// Reads `xr.loading` (absent: the defaults). Unknown keys and wrong types become warnings.
LoadingConfig parse_loading_config(const Json& root, std::vector<std::string>* warnings);
// "#rgb" or "#rrggbb" -> 0..1 components; false when malformed.
bool parse_hex_color(std::string_view text, float out[3]);
bool is_black(const float rgb[3]);
// sRGB-encoded 0..1 -> linear 0..1 (IEC 61966-2-1), for colour biases the compositor applies in linear space.
float srgb_to_linear(float c);

// What the loading screen shows behind the card and the spinner.
enum class LoadingBackground {
  kColour,       // an opaque projection layer in the configured colour (black by default)
  kPassthrough,  // a passthrough layer (XR_FB_passthrough) that the runtime submits behind the quads
};
const char* loading_background_name(LoadingBackground background);

// Where the user comes from when the loading screen comes up (loading_background()).
struct LoadingOrigin {
  // False: the app's launch; true: the page lost WebXR content it had shown (a reload, the end of its session).
  bool after_content = false;
  // At launch: whether the system recommends passthrough (XR_META_passthrough_preferences'
  // XR_PASSTHROUGH_PREFERENCE_DEFAULT_TO_ACTIVE_BIT_META: the user's home is passthrough): 1 yes, 0 no, -1 unknown
  // (the extension is missing or the query failed).
  int recommended = -1;
  // After content: the session that ended showed passthrough (immersive-ar with its passthrough layer visible).
  bool content_passthrough = false;
};
// Passthrough only for a contextual config, when the runtime can submit a passthrough layer (`passthrough_available`:
// XR_FB_passthrough and the system's passthrough capability) and the user comes from passthrough: at launch with the
// system's recommendation, after content when the session that ended showed passthrough (a VR session: black). The
// opaque colour (black) otherwise, also for an unknown recommendation: never the room by chance.
LoadingBackground loading_background(const LoadingConfig& config, const LoadingOrigin& origin,
                                     bool passthrough_available);

enum class LoadingPhase {
  kOff,       // disabled by config
  kLoading,   // no app content: the loading layers are submitted
  kHandover,  // the app's first frames: app layer fading in, loading layers fading out over it
  kApp,       // the app's own layers only
};
const char* loading_phase_name(LoadingPhase phase);

// When the loading layers are submitted and how opaque they are. The XR thread calls frame() once per OpenXR frame
// it submits (shouldRender true), after it knows whether that frame carries the app's projection layer. A loading
// period shorter than the fade (the page ended its session and entered the next one at once) hands over in one
// frame: fading the app in from black would stretch a blink of a few frames into a quarter of a second.
class LoadingPolicy {
 public:
  explicit LoadingPolicy(bool enabled = true, double fade_ms = 250);

  struct Frame {
    bool loading = false;      // submit the loading layers
    float loading_alpha = 0;   // their opacity (a premultiplied colour scale)
    float app_scale = 1;       // colour scale of the app's projection layer (fade-in from black)
    bool first_loading = false;  // the first frame since start that shows the loading layers
    bool handover = false;       // the app's first frame after a loading period
    bool handover_done = false;  // the last frame of the hand-over (the next one shows only the app)
  };
  // `app_layer`: this frame submits the app's projection layer.
  Frame frame(double now_ms, bool app_layer);
  // The page's WebXR content is gone (its session ended, the page reloaded): the loading screen comes back. A pause
  // (the session hidden while OpenXR is stopped) is not a loss: the app shows its own frames again on resume.
  void content_lost(double now_ms);
  // 0 when the runtime cannot fade layers (no XR_KHR_composition_layer_color_scale_bias): a one-frame switch.
  void set_fade_ms(double ms) { fade_ms_ = ms > 0 ? ms : 0; }

  LoadingPhase phase() const { return phase_; }
  // When the current or latest loading period started and how long it lasted until its hand-over (-1: none yet).
  double loading_since_ms() const { return loading_since_ms_; }
  double last_loading_duration_ms() const { return last_duration_ms_; }
  uint64_t handovers() const { return handovers_; }

 private:
  LoadingPhase phase_;
  double fade_ms_;
  double handover_fade_ms_ = 0;  // the current hand-over's fade: fade_ms_, or 0 after a short loading period
  double handover_ms_ = 0;
  double loading_since_ms_ = -1;
  double last_duration_ms_ = -1;
  bool shown_ = false;
  uint64_t handovers_ = 0;
};

// How the app's projection layer comes in during the hand-over (s = LoadingPolicy::Frame::app_scale, 0 -> 1).
enum class AppFade {
  kNone,        // at full strength: no hand-over, or an opaque (immersive-vr) frame replacing a passthrough background
                // (fading it in from black would dim the view through black between the room and the app)
  kFromColour,  // colour * s + background colour * bias (1 - s while the opaque background was behind the quads)
  kAlpha,       // colour and alpha * s (premultiplied): an immersive-ar frame blending in over passthrough
};
const char* app_fade_name(AppFade fade);

// What one frame submits, back to front: passthrough, the opaque background ("cover"), the app's projection layer,
// the loading card and spinner. Pure, so the XR thread's choice of layers is unit-tested; the XR thread only turns
// the plan into OpenXR structs.
struct FrameLayerInput {
  bool render = false;             // xrWaitFrame's shouldRender (false: the frame has no layers)
  bool webxr_active = false;       // the page has a WebXR session
  bool session_ar = false;         // ... immersive-ar: its projection layer blends over its passthrough
  bool app_frame = false;          // a finished app frame, with a live swapchain, to submit
  bool loading_ready = false;      // the loading layers exist
  bool cover_ready = false;        // the opaque background layer exists
  bool passthrough_ready = false;  // the passthrough layer exists and runs (not hidden by the page)
  LoadingBackground background = LoadingBackground::kColour;  // the loading screen's
};
struct FrameLayerPlan {
  bool passthrough = false;
  bool cover = false;
  bool projection = false;
  bool quads = false;
  float quad_alpha = 0;  // the quads' opacity (premultiplied colour scale)
  AppFade app_fade = AppFade::kNone;
  float app_scale = 1;  // s
  float app_bias = 0;   // weight of the background colour in kFromColour
};
// `lf`: this frame's LoadingPolicy::frame(), called with app_layer = render && webxr_active && app_frame. The rules:
//   - the app's projection layer whenever there is an app frame;
//   - the loading quads while the policy shows them;
//   - passthrough under an immersive-ar session's frames, and behind the quads for a passthrough background until
//     the app's first frame;
//   - the opaque background behind the quads otherwise (a passthrough background that is not running falls back to
//     it), and for a session's frames that have no app frame yet (a resume, a frame without a head pose) unless the
//     session shows passthrough: such a frame is never empty, so nothing the system puts behind the app shows.
FrameLayerPlan plan_frame_layers(const FrameLayerInput& in, const LoadingPolicy::Frame& lf);

// The head pitch (up or down, degrees) up to which the loading screen sits on the horizon, where Horizon OS draws its
// splash. The system splash is 20 degrees tall at eye height, so with the head pitched further than this it, and a
// card in its place, leave the view (and the spinner below the card first).
constexpr double kLoadingHorizonPitchDeg = 30;

// The anchor of the loading layers: the head's position and an orientation that stays put (world-locked). Where the
// card goes for a head orientation (target()):
//   - head within kLoadingHorizonPitchDeg of level: on the horizon straight ahead, upright (turned about the
//     vertical only), as Horizon OS's system splash, so the system splash turns into the card without a jump;
//   - head pitched further (lying down, reclined, looking at the floor, a headset lying face up): the system splash
//     is out of view there, so the card goes where the head looks, as the head is turned: centred on the gaze and
//     upright for the viewer, also looking straight up or down (no heading needed).
// The card is placed there on the first update (and after reset()), then stays put while the gaze stays within
// `follow_deg` of it (the whole angle, in any direction); past that it glides to where it goes for the current head.
class LoadingPlacement {
 public:
  explicit LoadingPlacement(double follow_deg = 35) : follow_rad_(follow_deg * 3.14159265358979323846 / 180.0) {}
  // `head`: the viewer pose (valid) in the layers' space (+Y up, gravity-aligned).
  XrPosef update(const XrPosef& head, double now_ms);
  void reset() {
    have_ = false;
    gliding_ = false;
  }
  bool placed() const { return have_; }
  bool gliding() const { return gliding_; }
  // The card is on the horizon (or gliding there), not along a pitched gaze.
  bool on_horizon() const { return horizon_; }
  XrQuaternionf orientation() const;
  double yaw() const;    // the card's heading (heading_of), radians about +Y, 0 = facing -Z
  double pitch() const;  // the card's direction above the horizon, radians

  // Where the card goes for `head`; `horizon` (optional) tells which of the two cases above it is.
  static XrQuaternionf target(const XrQuaternionf& head, bool* horizon);

 private:
  double follow_rad_;
  bool have_ = false;
  bool gliding_ = false;
  bool horizon_ = true;
  double q_[4] = {0, 0, 0, 1};  // x, y, z, w; doubles, as the glide accumulates small steps
  double last_ms_ = 0;
};

// Sizes (metres) and offsets from the anchor (in the anchor's frame: -Z ahead, +Y up) of the card and the spinner.
struct LoadingLayout {
  bool card = false;
  float card_w = 0, card_h = 0;
  XrVector3f card_center{0, 0, 0};
  float spinner_size = 0;
  XrVector3f spinner_center{0, 0, 0};
};
LoadingLayout loading_layout(const LoadingConfig& config, int image_w, int image_h);

// Small pose helpers (OpenXR conventions: right-handed, +Y up, -Z forward; quaternions x, y, z, w).
double yaw_of(const XrQuaternionf& q, bool* ok);  // the gaze's heading about +Y, 0 = facing -Z; ok false near vertical
double pitch_of(const XrQuaternionf& q);          // the gaze's angle above the horizon (negative: below)
// The heading of an orientation for any gaze, straight up and down included: its turn about the vertical (the twist
// of a swing-twist split about +Y). With no roll it is the gaze's heading; looking straight up or down it is the way
// the top of the head points (down) or the opposite way (up). Undefined only upside down: the gaze's heading then (0
// if that is undefined too).
double heading_of(const XrQuaternionf& q);
XrQuaternionf yaw_quat(double yaw);
double angle_between(const XrVector3f& a, const XrVector3f& b);  // radians, for unit vectors
double angle_between(const XrQuaternionf& a, const XrQuaternionf& b);  // the rotation from one to the other, radians
XrQuaternionf mul(const XrQuaternionf& a, const XrQuaternionf& b);
XrVector3f rotate(const XrQuaternionf& q, const XrVector3f& v);
XrPosef compose(const XrPosef& parent, const XrPosef& child);  // child expressed in parent -> base space
// The spinner turns clockwise (seen from the front) once per `period_ms`: its rotation about the quad's normal.
XrQuaternionf spinner_roll(double now_ms, double period_ms = 1100);

// Images for the quads, premultiplied RGBA8, top row first.
// A ring arc whose opacity grows towards its head (white): the spinner. `size` x `size` pixels.
std::vector<uint8_t> spinner_image(int size);
// Straight alpha -> premultiplied, in place.
void premultiply_rgba(uint8_t* rgba, size_t pixel_count);

}  // namespace iwn::xr
