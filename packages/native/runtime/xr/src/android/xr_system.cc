// The XR thread and its OpenXR objects. Written from the OpenXR 1.1 specification (session lifecycle §10, frame
// submission §10.5, swapchains §9, spaces §7, composition layers §12) and the extension specifications named where
// they are used (XR_KHR_opengl_es_enable, XR_KHR_android_create_instance, XR_KHR_loader_init_android,
// XR_KHR_convert_timespec_time, XR_FB_display_refresh_rate, XR_FB_foveation(_configuration),
// XR_FB_swapchain_update_state, XR_FB_color_space, XR_EXT_performance_settings, XR_FB_passthrough,
// XR_META_passthrough_preferences, XR_KHR_composition_layer_cylinder for xr_layers.cc), against
// docs/spec/08, 09, 10 and 14 (DBG-SHOT). See xr_system.h for the threading model.
#include "android/xr_system.h"

#include <GLES3/gl3.h>
#include <pthread.h>
#include <sys/system_properties.h>
#include <time.h>

#include <algorithm>
#include <cinttypes>
#include <cmath>
#include <cstring>

#include "android/egl_xr.h"
#include "android/jni_android.h"
#include "android/xr_input.h"
#include "android/xr_loading.h"
#include "android/xr_shot.h"
#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "iwn/core/monotonic_cv.h"
#include "iwn/core/runtime.h"
#include "iwn/gl.h"
#include "iwn/xr/pacing.h"
#include "iwn/xr/perf_policy.h"
#include "iwn/xr/session_policy.h"

#ifndef GL_SRGB8_ALPHA8
#define GL_SRGB8_ALPHA8 0x8C43
#endif

namespace iwn::xr {

namespace L = layout;

namespace {

constexpr int64_t kGlRGBA8 = 0x8058;

double degrees(double radians) { return radians * (180.0 / 3.14159265358979323846); }

std::string prop(const char* name) {
  char buf[PROP_VALUE_MAX] = {};
  __system_property_get(name, buf);
  return buf;
}

XrPerfSettingsLevelEXT perf_level(PerfLevel l) {
  switch (l) {
    case PerfLevel::kPowerSavings: return XR_PERF_SETTINGS_LEVEL_POWER_SAVINGS_EXT;
    case PerfLevel::kSustainedLow: return XR_PERF_SETTINGS_LEVEL_SUSTAINED_LOW_EXT;
    case PerfLevel::kSustainedHigh: return XR_PERF_SETTINGS_LEVEL_SUSTAINED_HIGH_EXT;
    case PerfLevel::kBoost: return XR_PERF_SETTINGS_LEVEL_BOOST_EXT;
    default: return XR_PERF_SETTINGS_LEVEL_SUSTAINED_LOW_EXT;
  }
}

template <typename F>
void load(XrInstance instance, const char* name, F* fn) {
  *fn = nullptr;
  xrGetInstanceProcAddr(instance, name, reinterpret_cast<PFN_xrVoidFunction*>(fn));
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------------------

struct XrSystem::Impl {
  explicit Impl(XrSystem* o) : owner(o) {}
  XrSystem* owner;
  XrConfig* cfg = nullptr;

  // The Runtime, reached only through with_rt(). stop() clears it under rt_mu when it has to leave an XR thread
  // behind (an OpenXR call blocked past the stop timeout), so that thread never touches a Runtime being destroyed.
  std::mutex rt_mu;
  Runtime* rt = nullptr;
  template <typename F>
  void with_rt(F&& f) {
    std::lock_guard<std::mutex> lock(rt_mu);
    if (rt) f(*rt);
  }

  // initialisation handshake
  std::mutex init_mu;
  MonotonicCondVar init_cv;
  bool init_done = false;
  bool init_ok = false;
  bool thread_done = false;
  std::string init_error;
  std::atomic<bool> quit{false};

  AndroidContext android;
  JNIEnv* env = nullptr;
  EglXrContext egl;
  XrInstance instance = XR_NULL_HANDLE;
  XrSystemId system = XR_NULL_SYSTEM_ID;
  XrSession session = XR_NULL_HANDLE;
  std::atomic<int> state{XR_SESSION_STATE_UNKNOWN};
  bool running = false;  // xrBeginSession .. xrEndSession
  bool exiting = false;
  bool loss_pending = false;
  Visibility visibility;
  std::string runtime_name, runtime_version, system_name, model;

  // extensions
  std::vector<std::string> available_exts, enabled_exts;
  bool ext_convert_time = false, ext_refresh = false, ext_foveation = false, ext_color_space = false,
       ext_perf = false, ext_passthrough = false, ext_scale_bias = false, ext_pt_prefs = false;
  InputExtensions input_ext;
  bool sys_hand_tracking = false, sys_passthrough = false;

  PFN_xrGetOpenGLESGraphicsRequirementsKHR get_gles_requirements = nullptr;
  PFN_xrConvertTimespecTimeToTimeKHR convert_timespec = nullptr;
  PFN_xrEnumerateDisplayRefreshRatesFB enumerate_rates = nullptr;
  PFN_xrGetDisplayRefreshRateFB get_rate = nullptr;
  PFN_xrRequestDisplayRefreshRateFB request_rate = nullptr;
  PFN_xrCreateFoveationProfileFB create_fov_profile = nullptr;
  PFN_xrDestroyFoveationProfileFB destroy_fov_profile = nullptr;
  PFN_xrUpdateSwapchainFB update_swapchain = nullptr;
  PFN_xrSetColorSpaceFB set_color_space = nullptr;
  PFN_xrPerfSettingsSetPerformanceLevelEXT set_perf_level = nullptr;
  PFN_xrCreatePassthroughFB create_passthrough = nullptr;
  PFN_xrDestroyPassthroughFB destroy_passthrough_fn = nullptr;
  PFN_xrCreatePassthroughLayerFB create_pt_layer = nullptr;
  PFN_xrDestroyPassthroughLayerFB destroy_pt_layer = nullptr;
  PFN_xrPassthroughLayerResumeFB pt_layer_resume = nullptr;
  PFN_xrPassthroughLayerPauseFB pt_layer_pause = nullptr;
  PFN_xrGetPassthroughPreferencesMETA get_pt_prefs = nullptr;

  // view configuration
  uint32_t rec_w = 0, rec_h = 0, max_w = 0, max_h = 0;
  uint32_t max_layer_count = 16;  // XrSystemGraphicsProperties: layers per xrEndFrame
  std::vector<int64_t> formats;
  std::vector<float> rates;
  std::atomic<float> current_rate{0};

  // spaces
  XrSpace view_space = XR_NULL_HANDLE, local_space = XR_NULL_HANDLE, stage_space = XR_NULL_HANDLE;
  XrSpace base = XR_NULL_HANDLE;
  bool base_is_stage = false;
  bool has_bounds = false;
  float stage_w = 0, stage_d = 0;
  XrPosef last_local{{0, 0, 0, 1}, {0, 0, 0}};
  XrPosef last_viewer{{0, 0, 0, 1}, {0, 0, 0}};

  // swapchain
  XrSwapchain swapchain = XR_NULL_HANDLE;
  uint32_t sc_w = 0, sc_h = 0, sc_array = 0;
  int64_t sc_format = 0;
  std::vector<uint32_t> images;
  bool held_image = false;  // acquired + waited, not released
  uint32_t image_index = 0;
  bool destroy_pending = false;
  double foveation = 0;  // applied, 0..1
  bool foveation_dynamic = false;
  bool foveation_supported = false;
  // The profile last applied (apply_foveation skips an unchanged level on the same swapchain).
  XrSwapchain fov_applied_swapchain = XR_NULL_HANDLE;
  FoveationLevel fov_applied_level = FoveationLevel::kNone;

  // passthrough (XR_FB_passthrough, offered only to apps whose manifest declares com.oculus.feature.PASSTHROUGH): one
  // passthrough and one layer, shared by an immersive-ar session and the loading screen's passthrough background,
  // created when one of them needs it and destroyed when neither does (update_passthrough()).
  XrPassthroughFB passthrough = XR_NULL_HANDLE;
  XrPassthroughLayerFB pt_layer = XR_NULL_HANDLE;
  bool pt_visible = true;  // the layer runs (the page can hide its immersive-ar session's passthrough)
  bool unpremultiplied = false;
  XrCompositionLayerPassthroughFB pt_comp{XR_TYPE_COMPOSITION_LAYER_PASSTHROUGH_FB};

  // Projection layer and the JS frame. A frame JS began and the frame loop has not collected yet (it may span
  // OpenXR frames) is the slot's kRunning/kDone state itself (FrameSlot), never a separate flag that could drift
  // from it.
  XrCompositionLayerProjection projection{XR_TYPE_COMPOSITION_LAYER_PROJECTION};
  XrCompositionLayerFlags projection_flags = 0;  // the frame's own (immersive-ar blending); see run_frame for layers
  XrCompositionLayerProjectionView proj_views[2];
  bool have_projection = false;
  XrView frame_views[2] = {XrView{XR_TYPE_VIEW}, XrView{XR_TYPE_VIEW}};
  bool have_views = false;  // frame_views hold a located pose (XR_VIEW_STATE_ORIENTATION_VALID_BIT seen)
  bool frame_has_image = false;
  bool js_busy = false;   // the last posted frame was cancelled: JS is in a long task
  uint64_t frame_number = 0;
  uint64_t session_js_frames = 0;  // JS frames of the current WebXR session

  // Quad and cylinder layers (xr_layers.h): their swapchains, the frame's layer list, the stats published from them.
  CompositionLayers comp_layers;
  uint64_t comp_layers_version = ~0ull;  // stats_mu: the version comp_layers_json was built from
  Json comp_layers_json = Json::object();

  // WebXR session (from JS)
  bool webxr_active = false;
  bool session_hand_tracking = false;
  bool session_ar = false;

  // The loading screen (loading.h, xr_loading.h): shown from the first OpenXR frame until the app's first projection
  // layer, and again while the page has no WebXR content. The splash image is decoded on its own thread, started
  // with the XR thread, so it is ready by the time the session runs.
  LoadingLayers loading;
  LoadingPolicy loading_policy{false};
  LoadingPlacement loading_place;
  std::shared_ptr<AssetBytes> loading_bytes;
  std::thread loading_decode;
  LoadingImage loading_image;
  double loading_decode_ms = 0;
  uint64_t loading_frames = 0;  // stats_mu
  XrCompositionLayerColorScaleBiasKHR app_fade{XR_TYPE_COMPOSITION_LAYER_COLOR_SCALE_BIAS_KHR};
  // What the loading screen shows behind its quads (loading_background()), decided when it comes up and whenever it
  // comes back; the system's passthrough recommendation at launch (1 yes, 0 no, -1 unknown or not asked).
  LoadingBackground loading_bg = LoadingBackground::kColour;
  int pt_recommended = -1;
  // A run of frames of a session without an app frame (after a resume), covered with the opaque background.
  uint64_t covered_run = 0;

  // input
  XrInput input;
  bool input_ok = false;
  HandInput hands[2];

  // timing and policies
  XrClock clock;
  double last_calibration_ms = -1e9;
  FramePacing pacing;
  PerfPolicy perf;
  PerfLevel applied_cpu = PerfLevel::kUnset, applied_gpu = PerfLevel::kUnset;
  LifePolicy life;
  double last_life_tick = 0;
  ShotCapture shot;

  // stats (XR thread writes; stats() copies under stats_mu)
  std::mutex stats_mu;
  uint64_t xr_frames = 0, js_frames = 0, ticks = 0, cancelled = 0, withdrawn = 0, late = 0, projection_frames = 0,
           stale_resubmits = 0, perf_events = 0, never_offered_errors = 0, untracked_frames = 0, covered_frames = 0;
  WindowStat wait_ms, js_ms, end_ms;
  double session_running_ms = -1, first_idle_frame_ms = -1, first_js_frame_ms = -1, session_granted_ms = -1;
  double first_loading_frame_ms = -1, openxr_ready_ms = -1;
  double first_visible_loading_ms = -1;
  // loading screen state for stats(), published by publish_locked()
  bool loading_ready = false;
  LoadingPhase loading_phase = LoadingPhase::kOff;
  std::string loading_card = "none";
  uint64_t loading_handovers = 0;
  double loading_last_ms = -1;
  LoadingBackground loading_bg_stat = LoadingBackground::kColour;
  int pt_recommended_stat = -1;
  bool pt_available_stat = false;
  // where the loading screen was in the latest frame that showed it (degrees in the base space), written per frame
  bool loading_anchor_known = false;
  double loading_anchor_yaw_deg = 0, loading_anchor_pitch_deg = 0, loading_head_pitch_deg = 0;
  double last_end_ms = -1, max_boot_gap_ms = 0;
  bool last_end_visible = false;
  int boot_gap_logs = 0;  // XR thread only
  double last_stats_log_ms = 0;
  uint64_t log_frames = 0, log_missed = 0;
  WindowStat log_wait, log_js, log_end;

  // What stats() reports about XR-thread state, published under stats_mu by publish_locked().
  struct Snapshot {
    XrSessionState state = XR_SESSION_STATE_UNKNOWN;
    Visibility visibility;
    bool webxr = false;
    bool hand_tracking = false;
    uint32_t sc_w = 0, sc_h = 0, sc_array = 0;
    int64_t sc_format = 0;
    size_t images = 0;
    double foveation = 0;
    PerfLevel cpu = PerfLevel::kUnset, gpu = PerfLevel::kUnset;
    uint64_t raises = 0, lowers = 0, missed = 0;
    size_t layer_swapchains = 0;
    uint32_t layers_submitted = 0;
    uint64_t frames_with_layers = 0;
    const char* profile[2] = {"none", "none"};
    uint32_t mode[2] = {0, 0};
  } snap;

  std::mutex info_mu;
  Json info = Json::object();

  // --- XR thread ---
  void publish_locked();  // stats_mu held
  void publish() {
    std::lock_guard<std::mutex> lock(stats_mu);
    publish_locked();
  }
  bool initialize();
  void create_loading_screen();
  int query_passthrough_recommended();
  void choose_loading_background(const char* when, bool after_content, bool content_passthrough);
  void calibrate();
  void apply_perf(bool initial);
  void release_image();
  bool passthrough_available() const { return sys_passthrough && create_passthrough && create_pt_layer; }
  bool ensure_passthrough(const char* why);
  void update_passthrough();
  void destroy_passthrough();
  void destroy_swapchain();
  void pause_frames();
  void end_webxr(bool by_system);
  void apply_foveation(double level, bool dynamic);
  void create_swapchain(const SwapchainRequest& req, SwapchainAnswer* out);
  void begin_xr_session();
  void handle_state(XrSessionState s);
  void poll_events();
  void finish_js_frame();
  bool locate_views(XrTime display_time);
  void life_tick(double now);
  void run_frame();
  void log_stats(double now);
  void teardown();
  void push_event(const XrEvent& e);
  void wake_js();
  const char* result(XrResult r);
  void fail(const std::string& why);
};

XrSystem& XrSystem::get() {
  static XrSystem* s = new XrSystem();  // never destroyed: the XR thread is joined in stop()
  return *s;
}

double XrSystem::now_ms_() { return now_ms(); }

void XrSystem::set_js_wake(std::function<void()> wake) {
  std::lock_guard<std::mutex> lock(wake_mu_);
  js_wake_ = std::move(wake);
}

void XrSystem::Impl::publish_locked() {
  snap.state = static_cast<XrSessionState>(state.load());
  snap.visibility = visibility;
  snap.webxr = webxr_active;
  snap.hand_tracking = session_hand_tracking;
  snap.sc_w = sc_w;
  snap.sc_h = sc_h;
  snap.sc_array = sc_array;
  snap.sc_format = sc_format;
  snap.images = images.size();
  snap.foveation = foveation;
  snap.cpu = applied_cpu;
  snap.gpu = applied_gpu;
  snap.raises = perf.raises();
  snap.lowers = perf.lowers();
  snap.missed = pacing.missed();
  snap.layer_swapchains = comp_layers.live();
  snap.layers_submitted = comp_layers.last_submitted();
  snap.frames_with_layers = comp_layers.frames_with_layers();
  if (comp_layers.version() != comp_layers_version) {  // swapchains changed: rebuilt rarely, not per frame
    comp_layers_version = comp_layers.version();
    comp_layers_json = comp_layers.stats();
  }
  for (int h = 0; h < 2; ++h) {
    snap.profile[h] = input_ok ? input.profile_name(h) : "none";
    snap.mode[h] = static_cast<uint32_t>(hands[h].mode);
  }
  loading_ready = loading.ready();
  loading_phase = loading_policy.phase();
  loading_handovers = loading_policy.handovers();
  loading_last_ms = loading_policy.last_loading_duration_ms();
  loading_bg_stat = loading_bg;
  pt_recommended_stat = pt_recommended;
  pt_available_stat = passthrough_available();
}

void XrSystem::Impl::wake_js() {
  std::lock_guard<std::mutex> lock(owner->wake_mu_);
  if (owner->js_wake_) owner->js_wake_();
}

void XrSystem::Impl::push_event(const XrEvent& e) {
  {
    std::lock_guard<std::mutex> lock(owner->events_mu_);
    owner->events_.push_back(e);
  }
  owner->events_pending_.store(true, std::memory_order_release);
  wake_js();
}

const char* XrSystem::Impl::result(XrResult r) {
  static thread_local char buf[XR_MAX_RESULT_STRING_SIZE];
  if (instance == XR_NULL_HANDLE || XR_FAILED(xrResultToString(instance, r, buf))) {
    std::snprintf(buf, sizeof(buf), "XrResult(%d)", r);
  }
  return buf;
}

void XrSystem::Impl::fail(const std::string& why) {
  log(LogLevel::kError, "xr: %s; immersive sessions are unavailable", why.c_str());
  {
    std::lock_guard<std::mutex> lock(info_mu);
    info.set("available", false);
    info.set("error", why);
  }
  std::lock_guard<std::mutex> lock(init_mu);
  init_error = why;
  init_done = true;
  init_ok = false;
  init_cv.notify_all();
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifetime

void XrSystem::start(Runtime* rt, const XrConfig& config, bool debuggable, bool debug_endpoint,
                     std::shared_ptr<AssetBytes> loading_image) {
  if (started_) return;
  if (zombie_) {
    log(LogLevel::kError, "xr: a previous XR thread never stopped; immersive sessions are unavailable until the app "
        "process restarts");
    return;
  }
  started_ = true;
  rt_ = rt;
  config_ = config;
  debuggable_ = debuggable;
  debug_endpoint_ = debug_endpoint;
  impl_ = std::make_unique<Impl>(this);
  impl_->rt = rt;
  impl_->cfg = &config_;
  LifePolicyConfig life = config.life;
  life.debug_endpoint = debug_endpoint;
  impl_->life = LifePolicy(life);
  impl_->perf = PerfPolicy(config.perf);
  if (config_.loading.enabled && loading_image && loading_image->size() > 0) {
    // The splash image is decoded while OpenXR initialises (it is ready before the session runs).
    Impl* x = impl_.get();
    x->loading_bytes = std::move(loading_image);
    x->loading_decode = std::thread([x] {
      pthread_setname_np(pthread_self(), "iwn-xr-splash");
      const double t0 = now_ms();
      x->loading_image = decode_loading_image(x->loading_bytes->data(), x->loading_bytes->size());
      x->loading_decode_ms = now_ms() - t0;
    });
  }
  commands_.set_slot(&slot_);
  // The composition-layer buffer's header, before the page's prelude checks it (the XR thread fills in the rest).
  layer_words_[layers::kVersionAt] = layers::kVersion;
  layer_words_[layers::kCountAt] = layers::kNoList;
  thread_ = std::thread([this] { thread_main(); });
}

bool XrSystem::wait_initialized(int timeout_ms) {
  if (!impl_) return false;
  std::unique_lock<std::mutex> lock(impl_->init_mu);
  impl_->init_cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [this] { return impl_->init_done; });
  return impl_->init_done && impl_->init_ok;
}

bool XrSystem::focused() const {
  return impl_ && impl_->state.load(std::memory_order_relaxed) == XR_SESSION_STATE_FOCUSED;
}

void XrSystem::stop() {
  if (!started_ || !impl_) return;
  impl_->quit = true;
  slot_.kick();
  commands_.push([] {});  // wakes a commands_.wait()
  // The XR thread leaves within a display frame; a runtime that blocks xrWaitFrame much longer must not hang the
  // process teardown (PROC-7), so the join is bounded.
  {
    std::unique_lock<std::mutex> lock(impl_->init_mu);
    if (!impl_->init_cv.wait_for(lock, std::chrono::seconds(3), [this] { return impl_->thread_done; })) {
      log(LogLevel::kError, "xr: the XR thread did not stop within 3 s; leaving it behind");
      lock.unlock();
      // The thread finishes its loop iteration once the blocking OpenXR call returns: from now on it must reach
      // neither the Runtime (destroyed after this hook) nor the JS loop's wake function (which captures it).
      {
        std::lock_guard<std::mutex> rt_lock(impl_->rt_mu);
        impl_->rt = nullptr;
      }
      set_js_wake(nullptr);
      rt_ = nullptr;
      thread_.detach();
      (void)impl_.release();  // the detached thread still uses it
      started_ = false;
      zombie_ = true;
      return;
    }
  }
  if (thread_.joinable()) thread_.join();
  impl_.reset();
  // Ready for the next start() in this process (an activity relaunched after onDestroy): the joined thread closed
  // the command queue and may have left a frame, a tick or events behind for a JS thread that is gone.
  commands_.reopen();
  slot_.force_idle();
  pending_frame_.store(false, std::memory_order_release);
  pending_tick_.store(false, std::memory_order_release);
  events_pending_.store(false, std::memory_order_release);
  want_ticks_.store(false, std::memory_order_relaxed);
  {
    std::lock_guard<std::mutex> lock(events_mu_);
    events_.clear();
  }
  set_js_wake(nullptr);
  js_fence_ = nullptr;  // deleted by the XR thread's teardown
  {
    std::lock_guard<std::mutex> lock(sc_mu_);
    sc_names_.clear();
    sc_array_ = 0;
  }
  sc_serial_.fetch_add(1, std::memory_order_acq_rel);
  fov_requested_ = -1;
  fov_serial_ = 0;
  fov_enabled_serial_ = 0;
  fov_value_ = -1;
  fov_gain_ = 0;
  fov_refresh_ms_ = 0;
  rt_ = nullptr;
  started_ = false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Initialisation (XR thread)

bool XrSystem::Impl::initialize() {
  const double t_start = now_ms();
  env = attach_current_thread("iwn-xr");
  model = prop("ro.product.model");
  if (!env) {
    fail("no JavaVM reachable (JNI_GetCreatedJavaVMs)");
    return false;
  }
  if (!find_android_context(env, &android)) {
    fail("no Android Context found for the OpenXR loader");
    return false;
  }
  log(LogLevel::kInfo, "xr: Android context via %s", android.how.c_str());
  if (!cfg->explicit_grant && owner->debuggable_ && android.activity) {
    // XR-LIFE-2 launch-extra override (PKG-CFG-3): am start --es iwn.xrGrant explicit (debuggable builds).
    std::string g = activity_intent_extra(env, android.activity, "iwn.xrGrant");
    if (g == "explicit" || g == "true") {
      cfg->explicit_grant = true;
      log(LogLevel::kInfo, "xr: explicit-grant mode (launch extra iwn.xrGrant)");
    }
  }

  // --- loader + instance (XR-INIT-1) ---
  PFN_xrInitializeLoaderKHR init_loader = nullptr;
  xrGetInstanceProcAddr(XR_NULL_HANDLE, "xrInitializeLoaderKHR", reinterpret_cast<PFN_xrVoidFunction*>(&init_loader));
  if (!init_loader) {
    fail("xrInitializeLoaderKHR unavailable");
    return false;
  }
  XrLoaderInitInfoAndroidKHR li{XR_TYPE_LOADER_INIT_INFO_ANDROID_KHR};
  li.applicationVM = android.vm;
  li.applicationContext = android.activity ? android.activity : android.application;
  const double t_ctx = now_ms();
  XrResult r = init_loader(reinterpret_cast<const XrLoaderInitInfoBaseHeaderKHR*>(&li));
  if (XR_FAILED(r)) {
    fail("xrInitializeLoaderKHR failed: " + std::to_string(r));
    return false;
  }
  uint32_t n = 0;
  xrEnumerateInstanceExtensionProperties(nullptr, 0, &n, nullptr);
  std::vector<XrExtensionProperties> props(n, {XR_TYPE_EXTENSION_PROPERTIES});
  xrEnumerateInstanceExtensionProperties(nullptr, n, &n, props.data());
  for (auto& p : props) available_exts.push_back(p.extensionName);
  auto has = [&](const std::vector<std::string>& list, const char* e) {
    return std::find(list.begin(), list.end(), e) != list.end();
  };
  auto usable = [&](const char* e) {
    if (!has(available_exts, e)) return false;
    if (owner->debuggable_) {  // XR-INIT-1 debug switch: withhold an optional extension
      for (const auto& d : cfg->disabled_extensions) {
        if (d == e) {
          log(LogLevel::kWarn, "xr: %s withheld by config xr.disableExtensions", e);
          return false;
        }
      }
    }
    return true;
  };
  for (const char* e : {XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME, XR_KHR_ANDROID_CREATE_INSTANCE_EXTENSION_NAME}) {
    if (!has(available_exts, e)) {
      fail(std::string("required extension missing: ") + e);
      return false;
    }
    enabled_exts.push_back(e);
  }
  for (const char* e : {XR_KHR_CONVERT_TIMESPEC_TIME_EXTENSION_NAME, XR_FB_DISPLAY_REFRESH_RATE_EXTENSION_NAME,
                        XR_FB_FOVEATION_EXTENSION_NAME, XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME,
                        XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME,
                        XR_FB_SWAPCHAIN_UPDATE_STATE_OPENGL_ES_EXTENSION_NAME, XR_FB_COLOR_SPACE_EXTENSION_NAME,
                        XR_EXT_PERFORMANCE_SETTINGS_EXTENSION_NAME, XR_EXT_HAND_TRACKING_EXTENSION_NAME,
                        XR_FB_HAND_TRACKING_AIM_EXTENSION_NAME, XR_EXT_HAND_INTERACTION_EXTENSION_NAME,
                        XR_META_TOUCH_CONTROLLER_PLUS_EXTENSION_NAME,
                        XR_FB_TOUCH_CONTROLLER_PRO_EXTENSION_NAME, XR_FB_PASSTHROUGH_EXTENSION_NAME,
                        XR_KHR_COMPOSITION_LAYER_CYLINDER_EXTENSION_NAME,
                        XR_KHR_COMPOSITION_LAYER_COLOR_SCALE_BIAS_EXTENSION_NAME}) {
    if (usable(e)) enabled_exts.push_back(e);
  }
  // Microgestures extend XR_EXT_hand_interaction's profile: without it xrCreateInstance fails
  // (XR_ERROR_EXTENSION_DEPENDENCY_NOT_ENABLED). The input code finds out from its bindings what it got (xr_input.h).
  if (has(enabled_exts, XR_EXT_HAND_INTERACTION_EXTENSION_NAME) &&
      usable(XR_META_HAND_TRACKING_MICROGESTURES_EXTENSION_NAME)) {
    enabled_exts.push_back(XR_META_HAND_TRACKING_MICROGESTURES_EXTENSION_NAME);
  }
  // The system's passthrough recommendation for the loading screen's contextual background (loading.h). Needs no
  // manifest entry; showing passthrough does (XR_FB_passthrough is offered only with com.oculus.feature.PASSTHROUGH).
  if (usable(XR_META_PASSTHROUGH_PREFERENCES_EXTENSION_NAME)) {
    enabled_exts.push_back(XR_META_PASSTHROUGH_PREFERENCES_EXTENSION_NAME);
  }
  ext_convert_time = has(enabled_exts, XR_KHR_CONVERT_TIMESPEC_TIME_EXTENSION_NAME);
  ext_refresh = has(enabled_exts, XR_FB_DISPLAY_REFRESH_RATE_EXTENSION_NAME);
  ext_foveation = has(enabled_exts, XR_FB_FOVEATION_EXTENSION_NAME) &&
                  has(enabled_exts, XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME) &&
                  has(enabled_exts, XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME);
  ext_color_space = has(enabled_exts, XR_FB_COLOR_SPACE_EXTENSION_NAME);
  ext_perf = has(enabled_exts, XR_EXT_PERFORMANCE_SETTINGS_EXTENSION_NAME);
  ext_passthrough = has(enabled_exts, XR_FB_PASSTHROUGH_EXTENSION_NAME);
  ext_scale_bias = has(enabled_exts, XR_KHR_COMPOSITION_LAYER_COLOR_SCALE_BIAS_EXTENSION_NAME);
  ext_pt_prefs = has(enabled_exts, XR_META_PASSTHROUGH_PREFERENCES_EXTENSION_NAME);
  input_ext.hand_tracking = has(enabled_exts, XR_EXT_HAND_TRACKING_EXTENSION_NAME);
  input_ext.hand_tracking_aim = has(enabled_exts, XR_FB_HAND_TRACKING_AIM_EXTENSION_NAME);
  input_ext.touch_controller_plus = has(enabled_exts, XR_META_TOUCH_CONTROLLER_PLUS_EXTENSION_NAME);
  input_ext.touch_controller_pro = has(enabled_exts, XR_FB_TOUCH_CONTROLLER_PRO_EXTENSION_NAME);

  std::vector<const char*> names;
  for (const auto& e : enabled_exts) names.push_back(e.c_str());
  XrInstanceCreateInfoAndroidKHR ai{XR_TYPE_INSTANCE_CREATE_INFO_ANDROID_KHR};
  ai.applicationVM = android.vm;
  ai.applicationActivity = android.activity ? android.activity : android.application;
  XrInstanceCreateInfo ci{XR_TYPE_INSTANCE_CREATE_INFO};
  ci.next = &ai;
  std::string app = "iwer-native";
  uint32_t app_version = 0;
  with_rt([&](Runtime& r) {
    if (!r.config().package_id.empty()) app = r.config().package_id;
    app_version = static_cast<uint32_t>(r.config().version_code);
  });
  std::strncpy(ci.applicationInfo.applicationName, app.c_str(), XR_MAX_APPLICATION_NAME_SIZE - 1);
  ci.applicationInfo.applicationVersion = app_version;
  std::strncpy(ci.applicationInfo.engineName, "iwer-native", XR_MAX_ENGINE_NAME_SIZE - 1);
  ci.applicationInfo.engineVersion = 1;
  ci.applicationInfo.apiVersion = XR_API_VERSION_1_0;
  ci.enabledExtensionCount = static_cast<uint32_t>(names.size());
  ci.enabledExtensionNames = names.data();
  const double t_loader = now_ms();
  r = xrCreateInstance(&ci, &instance);
  const double t_instance = now_ms();
  if (XR_FAILED(r)) {
    fail("xrCreateInstance failed: " + std::to_string(r));
    return false;
  }
  XrInstanceProperties ip{XR_TYPE_INSTANCE_PROPERTIES};
  xrGetInstanceProperties(instance, &ip);
  char ver[64];
  std::snprintf(ver, sizeof(ver), "%u.%u.%u", XR_VERSION_MAJOR(ip.runtimeVersion), XR_VERSION_MINOR(ip.runtimeVersion),
                XR_VERSION_PATCH(ip.runtimeVersion));
  {
    std::lock_guard<std::mutex> lock(info_mu);  // stats() reads them from the debug endpoint's thread
    runtime_name = ip.runtimeName;
    runtime_version = ver;
  }
  with_rt([&](Runtime& r) { r.set_info_field("openxrRuntime", runtime_name + " " + runtime_version); });

  load(instance, "xrGetOpenGLESGraphicsRequirementsKHR", &get_gles_requirements);
  if (ext_convert_time) load(instance, "xrConvertTimespecTimeToTimeKHR", &convert_timespec);
  if (ext_refresh) {
    load(instance, "xrEnumerateDisplayRefreshRatesFB", &enumerate_rates);
    load(instance, "xrGetDisplayRefreshRateFB", &get_rate);
    load(instance, "xrRequestDisplayRefreshRateFB", &request_rate);
  }
  if (ext_foveation) {
    load(instance, "xrCreateFoveationProfileFB", &create_fov_profile);
    load(instance, "xrDestroyFoveationProfileFB", &destroy_fov_profile);
    load(instance, "xrUpdateSwapchainFB", &update_swapchain);
  }
  if (ext_color_space) load(instance, "xrSetColorSpaceFB", &set_color_space);
  if (ext_perf) load(instance, "xrPerfSettingsSetPerformanceLevelEXT", &set_perf_level);
  if (ext_passthrough) {
    load(instance, "xrCreatePassthroughFB", &create_passthrough);
    load(instance, "xrDestroyPassthroughFB", &destroy_passthrough_fn);
    load(instance, "xrCreatePassthroughLayerFB", &create_pt_layer);
    load(instance, "xrDestroyPassthroughLayerFB", &destroy_pt_layer);
    load(instance, "xrPassthroughLayerResumeFB", &pt_layer_resume);
    load(instance, "xrPassthroughLayerPauseFB", &pt_layer_pause);
  }
  if (ext_pt_prefs) load(instance, "xrGetPassthroughPreferencesMETA", &get_pt_prefs);

  // --- system (the headset may not be ready yet: retry) ---
  XrSystemGetInfo sgi{XR_TYPE_SYSTEM_GET_INFO};
  sgi.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
  for (int attempt = 0; attempt < 300 && !quit; ++attempt) {
    r = xrGetSystem(instance, &sgi, &system);
    if (r != XR_ERROR_FORM_FACTOR_UNAVAILABLE) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  const double t_system = now_ms();
  if (XR_FAILED(r)) {
    fail(std::string("xrGetSystem failed: ") + result(r));
    return false;
  }
  XrSystemProperties sp{XR_TYPE_SYSTEM_PROPERTIES};
  XrSystemHandTrackingPropertiesEXT hp{XR_TYPE_SYSTEM_HAND_TRACKING_PROPERTIES_EXT};
  XrSystemPassthroughProperties2FB pp{XR_TYPE_SYSTEM_PASSTHROUGH_PROPERTIES2_FB};
  void* chain = nullptr;
  if (ext_passthrough) {
    pp.next = chain;
    chain = &pp;
  }
  if (input_ext.hand_tracking) {
    hp.next = chain;
    chain = &hp;
  }
  sp.next = chain;
  xrGetSystemProperties(instance, system, &sp);
  system_name = sp.systemName;
  sys_hand_tracking = input_ext.hand_tracking && hp.supportsHandTracking;
  sys_passthrough = ext_passthrough && (pp.capabilities & XR_PASSTHROUGH_CAPABILITY_BIT_FB);

  uint32_t vc = 0;
  xrEnumerateViewConfigurationViews(instance, system, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &vc, nullptr);
  std::vector<XrViewConfigurationView> vcv(vc, {XR_TYPE_VIEW_CONFIGURATION_VIEW});
  xrEnumerateViewConfigurationViews(instance, system, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, vc, &vc, vcv.data());
  if (vc < 2) {
    fail("the system has no stereo view configuration");
    return false;
  }
  if (sp.graphicsProperties.maxLayerCount > 0) max_layer_count = sp.graphicsProperties.maxLayerCount;
  rec_w = vcv[0].recommendedImageRectWidth;
  rec_h = vcv[0].recommendedImageRectHeight;
  max_w = vcv[0].maxImageRectWidth;
  max_h = vcv[0].maxImageRectHeight;

  // --- graphics: the XR thread's context in the WebGL share group (XR-INIT-2) ---
  if (iwn::gl::RootDisplay() == EGL_NO_DISPLAY) iwn::gl::Init(iwn::gl::InitOptions{});
  XrGraphicsRequirementsOpenGLESKHR req{XR_TYPE_GRAPHICS_REQUIREMENTS_OPENGL_ES_KHR};
  if (get_gles_requirements) get_gles_requirements(instance, system, &req);  // required before xrCreateSession
  if (!egl.create(iwn::gl::RootDisplay(), iwn::gl::RootConfig(), iwn::gl::RootContext())) {
    fail("could not create the XR thread's EGL context");
    return false;
  }
  const char* gl_version = reinterpret_cast<const char*>(glGetString(GL_VERSION));
  log(LogLevel::kInfo, "xr: XR thread GL '%s'; runtime supports GLES %u.%u to %u.%u", gl_version ? gl_version : "?",
      XR_VERSION_MAJOR(req.minApiVersionSupported), XR_VERSION_MINOR(req.minApiVersionSupported),
      XR_VERSION_MAJOR(req.maxApiVersionSupported), XR_VERSION_MINOR(req.maxApiVersionSupported));

  // --- session ---
  XrGraphicsBindingOpenGLESAndroidKHR gb{XR_TYPE_GRAPHICS_BINDING_OPENGL_ES_ANDROID_KHR};
  gb.display = egl.display();
  gb.config = egl.config();
  gb.context = egl.context();
  XrSessionCreateInfo sci{XR_TYPE_SESSION_CREATE_INFO};
  sci.next = &gb;
  sci.systemId = system;
  const double t_egl = now_ms();
  r = xrCreateSession(instance, &sci, &session);
  const double t_session = now_ms();
  if (XR_FAILED(r)) {
    fail(std::string("xrCreateSession failed: ") + result(r));
    return false;
  }

  // One base space for the whole session (XRF-3): STAGE when the runtime has it, else LOCAL.
  uint32_t space_count = 0;
  xrEnumerateReferenceSpaces(session, 0, &space_count, nullptr);
  std::vector<XrReferenceSpaceType> spaces(space_count);
  xrEnumerateReferenceSpaces(session, space_count, &space_count, spaces.data());
  auto make_space = [&](XrReferenceSpaceType t) {
    XrReferenceSpaceCreateInfo rci{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
    rci.referenceSpaceType = t;
    rci.poseInReferenceSpace.orientation.w = 1;
    XrSpace s = XR_NULL_HANDLE;
    if (XR_FAILED(xrCreateReferenceSpace(session, &rci, &s))) return static_cast<XrSpace>(XR_NULL_HANDLE);
    return s;
  };
  view_space = make_space(XR_REFERENCE_SPACE_TYPE_VIEW);
  local_space = make_space(XR_REFERENCE_SPACE_TYPE_LOCAL);
  if (std::find(spaces.begin(), spaces.end(), XR_REFERENCE_SPACE_TYPE_STAGE) != spaces.end()) {
    stage_space = make_space(XR_REFERENCE_SPACE_TYPE_STAGE);
  }
  base_is_stage = stage_space != XR_NULL_HANDLE;
  base = base_is_stage ? stage_space : local_space;
  if (base_is_stage) {
    XrExtent2Df ext{};
    r = xrGetReferenceSpaceBoundsRect(session, XR_REFERENCE_SPACE_TYPE_STAGE, &ext);
    has_bounds = r == XR_SUCCESS && ext.width > 0 && ext.height > 0;
    stage_w = ext.width;
    stage_d = ext.height;
  }

  uint32_t fc = 0;
  xrEnumerateSwapchainFormats(session, 0, &fc, nullptr);
  formats.resize(fc);
  xrEnumerateSwapchainFormats(session, fc, &fc, formats.data());

  comp_layers.init(session, formats, owner->layer_words_,
                   has(enabled_exts, XR_KHR_COMPOSITION_LAYER_CYLINDER_EXTENSION_NAME),
                   sp.graphicsProperties.maxSwapchainImageWidth, sp.graphicsProperties.maxSwapchainImageHeight);

  if (ext_refresh && enumerate_rates) {
    uint32_t rc = 0;
    enumerate_rates(session, 0, &rc, nullptr);
    rates.resize(rc);
    enumerate_rates(session, rc, &rc, rates.data());
    float cur = 0;
    if (get_rate && XR_SUCCEEDED(get_rate(session, &cur))) current_rate = cur;
  }

  const double t_spaces = now_ms();
  input_ok = input.init(instance, session, input_ext, sys_hand_tracking);
  const double t_input = now_ms();
  // 'hand-tracking' is offered only when the trackers exist (the system supports hands and the APK declares
  // com.oculus.permission.HAND_TRACKING, which the packer adds for apps that use hands).
  if (sys_hand_tracking && !(input_ok && input.hand_tracking_available())) {
    log(LogLevel::kInfo, "xr: the system tracks hands but no hand tracker could be created (manifest permission "
        "com.oculus.permission.HAND_TRACKING missing?); 'hand-tracking' is not offered");
    sys_hand_tracking = false;
  }
  foveation_supported = ext_foveation && create_fov_profile && update_swapchain;

  // LOG-2 (session part): extensions, eye buffer, rates.
  std::string ext_list;
  for (const auto& e : enabled_exts) ext_list += (ext_list.empty() ? "" : " ") + e;
  std::string rate_list;
  for (float f : rates) rate_list += (rate_list.empty() ? "" : ",") + std::to_string(static_cast<int>(f));
  char bounds[64] = "";
  if (has_bounds) std::snprintf(bounds, sizeof(bounds), " bounds %.2fx%.2f m", stage_w, stage_d);
  log(LogLevel::kInfo,
      "xr: OpenXR %s %s, system '%s' (%s); eye %ux%u (max %ux%u); base %s%s; rates [%s] current %.0f; hands %d "
      "passthrough %d; extensions: %s",
      runtime_name.c_str(), runtime_version.c_str(), system_name.c_str(), model.c_str(), rec_w, rec_h, max_w, max_h,
      base_is_stage ? "STAGE" : "LOCAL", bounds, rate_list.c_str(), static_cast<double>(current_rate.load()),
      sys_hand_tracking ? 1 : 0, sys_passthrough ? 1 : 0, ext_list.c_str());

  {
    std::lock_guard<std::mutex> lock(info_mu);
    info.set("available", true);
    info.set("runtimeName", runtime_name);
    info.set("runtimeVersion", runtime_version);
    info.set("systemName", system_name);
    info.set("model", model);
    info.set("recommendedWidth", static_cast<int64_t>(rec_w));
    info.set("recommendedHeight", static_cast<int64_t>(rec_h));
    info.set("maxWidth", static_cast<int64_t>(max_w));
    info.set("maxHeight", static_cast<int64_t>(max_h));
    Json rate_json = Json::array();
    for (float f : rates) rate_json.push(static_cast<double>(f));
    info.set("refreshRates", rate_json);
    info.set("refreshRate", static_cast<double>(current_rate.load()));
    info.set("hasStage", has_bounds);
    info.set("stageWidth", static_cast<double>(stage_w));
    info.set("stageDepth", static_cast<double>(stage_d));
    info.set("baseIsStage", base_is_stage);
    info.set("handTracking", sys_hand_tracking);
    info.set("passthrough", sys_passthrough);
    info.set("immersiveAr", cfg->immersive_ar && sys_passthrough);  // XR-AR-1 is opt-in (xr.immersiveAr)
    info.set("foveation", foveation_supported);
    info.set("explicitGrant", cfg->explicit_grant);
    // XR-LAYER-1: quad and cylinder layers (the WebXR 'layers' feature itself is granted with projection layers)
    Json comp = Json::object();
    comp.set("quad", true);
    comp.set("cylinder", has(enabled_exts, XR_KHR_COMPOSITION_LAYER_CYLINDER_EXTENSION_NAME));
    comp.set("maxLayers", static_cast<int64_t>(max_layer_count));
    comp.set("bufferVersion", static_cast<int64_t>(layers::kVersion));
    info.set("compositionLayers", comp);
    info.set("layoutVersion", static_cast<int64_t>(L::kVersion));
    Json ext_json = Json::array();
    for (const auto& e : enabled_exts) ext_json.push(e);
    info.set("extensions", ext_json);
  }
  {
    std::lock_guard<std::mutex> lock(init_mu);
    init_done = true;
    init_ok = true;
    init_cv.notify_all();
  }
  {
    std::lock_guard<std::mutex> lock(stats_mu);
    openxr_ready_ms = now_ms();
  }
  // Where the time to the first frame goes (the loading screen can only appear after this).
  log(LogLevel::kInfo,
      "xr: OpenXR ready in %.0f ms (context %.0f, loader %.0f, instance %.0f, system %.0f, EGL %.0f, session %.0f, "
      "spaces %.0f, input %.0f, rest %.0f)",
      now_ms() - t_start, t_ctx - t_start, t_loader - t_ctx, t_instance - t_loader, t_system - t_instance,
      t_egl - t_system, t_session - t_egl, t_spaces - t_session, t_input - t_spaces, now_ms() - t_input);
  calibrate();
  create_loading_screen();
  return true;
}

void XrSystem::Impl::calibrate() {
  const double perf_now = now_ms();
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  XrTime xr_now = static_cast<XrTime>(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
  if (convert_timespec) convert_timespec(instance, &ts, &xr_now);
  clock.calibrate(perf_now, xr_now);
  last_calibration_ms = perf_now;
}

void XrSystem::Impl::create_loading_screen() {
  const LoadingConfig& lc = cfg->loading;
  if (!lc.enabled) {
    log(LogLevel::kInfo, "xr: loading screen off (config xr.loading)");
    return;
  }
  const double t0 = now_ms();
  if (loading_decode.joinable()) loading_decode.join();  // normally done long ago (it ran during OpenXR's start)
  const double waited = now_ms() - t0;
  if (!loading_image.error.empty()) {
    log(LogLevel::kWarn, "xr: loading screen: %s; showing the spinner only", loading_image.error.c_str());
  } else if (!loading_bytes) {
    log(LogLevel::kInfo, "xr: loading screen: no splash image%s%s; showing the spinner only",
        lc.image.empty() ? "" : " at assets/", lc.image.c_str());
  }
  const bool ok = loading.create(session, formats, lc, &loading_image);
  loading_image = LoadingImage{};  // the pixels live in the swapchain now
  loading_bytes.reset();
  loading_policy = LoadingPolicy(ok, ext_scale_bias ? lc.fade_ms : 0);
  loading_place = LoadingPlacement(lc.follow_deg);
  if (!ok) {
    log(LogLevel::kWarn, "xr: loading screen unavailable; the idle presentation stays black");
    return;
  }
  char card[48] = "none";
  if (loading.has_card()) std::snprintf(card, sizeof(card), "%dx%d", loading.card_width(), loading.card_height());
  char colour[8];
  std::snprintf(colour, sizeof(colour), "#%02x%02x%02x", static_cast<int>(std::lround(lc.background[0] * 255.0f)),
                static_cast<int>(std::lround(lc.background[1] * 255.0f)),
                static_cast<int>(std::lround(lc.background[2] * 255.0f)));
  {
    std::lock_guard<std::mutex> lock(stats_mu);
    loading_card = card;
    publish_locked();
  }
  log(LogLevel::kInfo,
      "xr: loading screen ready in %.0f ms (image decoded in %.0f ms, waited %.0f ms): card %s, spinner %d, "
      "background %s%s%s, cross-fade %.0f ms",
      now_ms() - t0, loading_decode_ms, waited, card, lc.spinner ? 1 : 0, lc.contextual ? "contextual (" : "", colour,
      lc.contextual ? (passthrough_available() ? " or passthrough)" : "; this app cannot show passthrough)") : "",
      ext_scale_bias ? lc.fade_ms : 0.0);
  choose_loading_background("start", false, false);
}

int XrSystem::Impl::query_passthrough_recommended() {
  if (!get_pt_prefs || session == XR_NULL_HANDLE) return -1;
  XrPassthroughPreferencesMETA prefs{XR_TYPE_PASSTHROUGH_PREFERENCES_META};
  const XrResult r = get_pt_prefs(session, &prefs);
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: xrGetPassthroughPreferencesMETA: %s", result(r));
    return -1;
  }
  return (prefs.flags & XR_PASSTHROUGH_PREFERENCE_DEFAULT_TO_ACTIVE_BIT_META) != 0 ? 1 : 0;
}

void XrSystem::Impl::choose_loading_background(const char* when, bool after_content, bool content_passthrough) {
  if (!loading.ready()) {
    update_passthrough();  // no loading screen: only a session keeps passthrough
    return;
  }
  const LoadingConfig& lc = cfg->loading;
  const bool available = passthrough_available();
  LoadingOrigin origin;
  origin.after_content = after_content;
  origin.content_passthrough = content_passthrough;
  // The system is asked at launch only, and only for a contextual background this app can show (an IPC round trip,
  // ~ms; never per frame). After content the user comes from the app's own session, whatever their home is.
  if (!after_content && lc.contextual && available) origin.recommended = query_passthrough_recommended();
  LoadingBackground bg = loading_background(lc, origin, available);
  const char* failed = nullptr;
  if (bg == LoadingBackground::kPassthrough && !ensure_passthrough("the loading screen")) {
    bg = LoadingBackground::kColour;  // never an empty background: the opaque colour instead
    failed = "passthrough could not be started";
  }
  loading_bg = bg;
  if (!after_content) pt_recommended = origin.recommended;
  update_passthrough();  // stops a passthrough nothing shows any more
  publish();
  const char* why = !lc.contextual  ? "configured"
                    : failed        ? failed
                    : !available    ? "contextual, but this app cannot show passthrough (XR_FB_passthrough is not "
                                      "offered without com.oculus.feature.PASSTHROUGH in the manifest)"
                    : after_content ? (content_passthrough ? "contextual: the session that ended showed passthrough"
                                                           : "contextual: the session that ended showed no passthrough")
                    : origin.recommended == 1 ? "contextual: the system recommends passthrough (the user's home is "
                                                "passthrough)"
                    : origin.recommended == 0 ? "contextual: the system does not recommend passthrough"
                    : ext_pt_prefs            ? "contextual: no recommendation (the query failed)"
                                              : "contextual: no recommendation (XR_META_passthrough_preferences "
                                                "unavailable)";
  log(LogLevel::kInfo, "xr: loading screen background (%s): %s (%s)", when,
      bg == LoadingBackground::kPassthrough ? "passthrough" : (is_black(lc.background) ? "black" : "colour"), why);
}

void XrSystem::Impl::apply_perf(bool initial) {
  if (!set_perf_level || session == XR_NULL_HANDLE) return;
  if (perf.cpu() != PerfLevel::kUnset && perf.cpu() != applied_cpu) {
    set_perf_level(session, XR_PERF_SETTINGS_DOMAIN_CPU_EXT, perf_level(perf.cpu()));
    applied_cpu = perf.cpu();
    log(LogLevel::kInfo, "xr: CPU performance level %s%s", perf_level_name(applied_cpu), initial ? " (start)" : "");
  }
  if (perf.gpu() != PerfLevel::kUnset && perf.gpu() != applied_gpu) {
    set_perf_level(session, XR_PERF_SETTINGS_DOMAIN_GPU_EXT, perf_level(perf.gpu()));
    applied_gpu = perf.gpu();
    log(LogLevel::kInfo, "xr: GPU performance level %s%s", perf_level_name(applied_gpu), initial ? " (start)" : "");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Swapchain, passthrough, foveation (XR thread)

void XrSystem::Impl::release_image() {
  if (held_image && swapchain != XR_NULL_HANDLE) {
    XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
    xrReleaseSwapchainImage(swapchain, &ri);
  }
  held_image = false;
}

void XrSystem::Impl::destroy_passthrough() {
  if (pt_layer != XR_NULL_HANDLE && destroy_pt_layer) destroy_pt_layer(pt_layer);
  if (passthrough != XR_NULL_HANDLE && destroy_passthrough_fn) destroy_passthrough_fn(passthrough);
  pt_layer = XR_NULL_HANDLE;
  passthrough = XR_NULL_HANDLE;
  pt_visible = true;  // a new one runs from its creation
}

bool XrSystem::Impl::ensure_passthrough(const char* why) {
  if (pt_layer != XR_NULL_HANDLE) return true;
  if (!passthrough_available() || session == XR_NULL_HANDLE) return false;
  // One passthrough per session (XR_FB_passthrough), running from its creation, and a full-view reconstruction layer.
  XrResult r = XR_SUCCESS;
  if (passthrough == XR_NULL_HANDLE) {
    XrPassthroughCreateInfoFB pci{XR_TYPE_PASSTHROUGH_CREATE_INFO_FB};
    pci.flags = XR_PASSTHROUGH_IS_RUNNING_AT_CREATION_BIT_FB;
    r = create_passthrough(session, &pci, &passthrough);
  }
  if (XR_SUCCEEDED(r)) {
    XrPassthroughLayerCreateInfoFB lci{XR_TYPE_PASSTHROUGH_LAYER_CREATE_INFO_FB};
    lci.passthrough = passthrough;
    lci.flags = XR_PASSTHROUGH_IS_RUNNING_AT_CREATION_BIT_FB;
    lci.purpose = XR_PASSTHROUGH_LAYER_PURPOSE_RECONSTRUCTION_FB;
    r = create_pt_layer(session, &lci, &pt_layer);
  }
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: passthrough for %s could not be started: %s", why, result(r));
    destroy_passthrough();
    return false;
  }
  pt_visible = true;
  log(LogLevel::kInfo, "xr: passthrough started (for %s)", why);
  return true;
}

void XrSystem::Impl::update_passthrough() {
  // Wanted by the loading screen's passthrough background until the app's frames replace it, and by an immersive-ar
  // session; otherwise the cameras stop.
  const LoadingPhase phase = loading_policy.phase();
  const bool loading_wants = loading_bg == LoadingBackground::kPassthrough &&
                             (phase == LoadingPhase::kLoading || phase == LoadingPhase::kHandover);
  const bool session_wants = webxr_active && session_ar;
  if (pt_layer != XR_NULL_HANDLE && !loading_wants && !session_wants) {
    destroy_passthrough();
    log(LogLevel::kInfo, "xr: passthrough stopped (nothing shows it any more)");
  }
}

void XrSystem::Impl::destroy_swapchain() {
  FrameSlot& slot = owner->slot_;
  // A posted frame JS has not begun is withdrawn (the frame loop waiting on it sees FrameSlot::Outcome::kWithdrawn
  // and holds nothing in flight). A frame JS is running, or finished but not collected yet, still owns an image:
  // the swapchain goes once finish_js_frame() collects it.
  slot.withdraw();
  const FrameSlot::State st = slot.state();
  if (st == FrameSlot::kRunning || st == FrameSlot::kDone) {
    destroy_pending = true;
    return;
  }
  release_image();
  if (swapchain != XR_NULL_HANDLE) {
    xrDestroySwapchain(swapchain);
    log(LogLevel::kInfo, "xr: swapchain destroyed");
  }
  swapchain = XR_NULL_HANDLE;
  images.clear();
  {
    std::lock_guard<std::mutex> lock(owner->sc_mu_);
    owner->sc_names_.clear();
    owner->sc_array_ = 0;
  }
  owner->sc_serial_.fetch_add(1, std::memory_order_acq_rel);
  have_projection = false;
  sc_w = sc_h = sc_array = 0;
  destroy_pending = false;
  fov_applied_swapchain = XR_NULL_HANDLE;
  // The passthrough outlives the swapchain: the loading screen may show it next (update_passthrough() stops it).
}

void XrSystem::Impl::pause_frames() {
  // A frame JS has not begun is dropped; one it is running gets a moment to finish, so its image is released before
  // xrEndSession (a debugger pause leaves it in flight: it is collected once frames run again).
  FrameSlot& slot = owner->slot_;
  slot.withdraw();
  if (slot.state() == FrameSlot::kRunning || slot.state() == FrameSlot::kDone) {
    slot.wait_done(std::chrono::steady_clock::now() + std::chrono::milliseconds(1000), &owner->commands_);
    if (slot.conclude() == FrameSlot::Outcome::kDone) finish_js_frame();
  }
  if (slot.state() == FrameSlot::kIdle) release_image();  // nothing renders into the held image any more
  have_projection = false;  // never re-submit a frame from before the pause
  if (destroy_pending) destroy_swapchain();
}

void XrSystem::Impl::end_webxr(bool by_system) {
  if (!webxr_active) return;
  // What the user was looking at: the session's passthrough (immersive-ar, not hidden by the page) or its VR scene.
  const bool showed_passthrough = session_ar && pt_layer != XR_NULL_HANDLE && pt_visible;
  webxr_active = false;
  session_hand_tracking = false;
  session_ar = false;
  js_busy = false;
  destroy_swapchain();
  // The layer swapchains go with the session (once a frame still in flight is collected).
  const FrameSlot::State st = owner->slot_.state();
  comp_layers.end_session(st == FrameSlot::kRunning || st == FrameSlot::kDone);
  life.on_session_ended(now_ms());
  if (input_ok) input.stop_haptics();
  // No WebXR content any more: the loading screen comes back, in front of the user (a reload boots the page again),
  // on the background that continues what the session showed (black after a VR session).
  loading_policy.content_lost(now_ms());
  loading_place.reset();
  choose_loading_background("content lost", true, showed_passthrough);
  log(LogLevel::kInfo, "xr: WebXR session ended (%s); idle presentation", by_system ? "by the system" : "by the page");
  if (by_system) push_event({XrEvent::kSessionEnd});
  publish();
}

void XrSystem::Impl::apply_foveation(double level, bool dynamic) {
  if (!foveation_supported || swapchain == XR_NULL_HANDLE) return;
  const FoveationLevel lv = foveation_level_for(level);
  // An unchanged level costs nothing (IWER forwards every fixedFoveation assignment; profile + update + glFinish
  // each time would stall this thread for an app that assigns it every frame).
  if (swapchain == fov_applied_swapchain && lv == fov_applied_level && dynamic == foveation_dynamic) return;
  XrFoveationLevelProfileCreateInfoFB lp{XR_TYPE_FOVEATION_LEVEL_PROFILE_CREATE_INFO_FB};
  lp.level = static_cast<XrFoveationLevelFB>(static_cast<int>(lv));
  lp.verticalOffset = 0;
  lp.dynamic = dynamic ? XR_FOVEATION_DYNAMIC_LEVEL_ENABLED_FB : XR_FOVEATION_DYNAMIC_DISABLED_FB;
  XrFoveationProfileCreateInfoFB pc{XR_TYPE_FOVEATION_PROFILE_CREATE_INFO_FB};
  pc.next = &lp;
  XrFoveationProfileFB profile = XR_NULL_HANDLE;
  XrResult r = create_fov_profile(session, &pc, &profile);
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: xrCreateFoveationProfileFB failed: %s", result(r));
    return;
  }
  XrSwapchainStateFoveationFB st{XR_TYPE_SWAPCHAIN_STATE_FOVEATION_FB};
  st.profile = profile;
  r = update_swapchain(swapchain, reinterpret_cast<const XrSwapchainStateBaseHeaderFB*>(&st));
  if (destroy_fov_profile) destroy_fov_profile(profile);
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: xrUpdateSwapchainFB (foveation) failed: %s", result(r));
    return;
  }
  glFinish();  // the texture state the runtime set is visible to the WebGL contexts before their next use
  if (!images.empty() && sc_array >= 2) {
    FoveationQuery q = query_foveation(images[0], GL_TEXTURE_2D_ARRAY, /*own_context=*/true);
    log(LogLevel::kInfo, "xr: foveation state of image 0 in the XR context: bits 0x%x supported 0x%x min density %.2f",
        q.feature_bits, q.supported, q.min_density);
  }
  foveation = foveation_value_for(lv);
  foveation_dynamic = dynamic;
  fov_applied_swapchain = swapchain;
  fov_applied_level = lv;
  log(LogLevel::kInfo, "xr: fixed foveation %s%s", foveation_level_name(lv), dynamic ? " (dynamic)" : "");
}

void XrSystem::Impl::create_swapchain(const SwapchainRequest& req, SwapchainAnswer* out) {
  if (session == XR_NULL_HANDLE) {
    out->error = init_error.empty() ? "no OpenXR session" : init_error;
    return;
  }
  // The page waits in this call, so no frame runs in JS now; one it finished that the frame loop has not collected
  // yet still holds an image of the old swapchain: collect it first, so the old swapchain can go.
  if (swapchain != XR_NULL_HANDLE && owner->slot_.state() == FrameSlot::kDone) finish_js_frame();
  if (swapchain != XR_NULL_HANDLE) destroy_swapchain();
  if (swapchain != XR_NULL_HANDLE) {
    out->error = "the previous swapchain is still in use by a frame";
    return;
  }
  // XR-SC-1: recommended per-eye size x scale (x the configured eye-buffer scale), clamped to the maximum.
  const double scale = std::clamp(req.scale * cfg->eye_buffer_scale, 0.1, 4.0);
  uint32_t eye_w = std::max<uint32_t>(16, static_cast<uint32_t>(std::lround(rec_w * scale)));
  uint32_t eye_h = std::max<uint32_t>(16, static_cast<uint32_t>(std::lround(rec_h * scale)));
  eye_w = std::min(eye_w, max_w ? max_w : eye_w);
  eye_h = std::min(eye_h, max_h ? max_h : eye_h);
  const uint32_t array = req.array_size >= 2 ? 2 : 1;
  const uint32_t width = array == 2 ? eye_w : eye_w * 2;
  int64_t format = static_cast<int64_t>(req.format ? req.format : kGlRGBA8);
  if (std::find(formats.begin(), formats.end(), format) == formats.end()) {
    log(LogLevel::kWarn, "xr: swapchain format 0x%" PRIx64 " unsupported; using RGBA8", format);
    format = kGlRGBA8;
  }
  XrSwapchainCreateInfo ci{XR_TYPE_SWAPCHAIN_CREATE_INFO};
  ci.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_SAMPLED_BIT;
  ci.format = format;
  ci.sampleCount = 1;  // MSAA comes from the multisampled multiview attachment (GL-24)
  ci.width = width;
  ci.height = eye_h;
  ci.faceCount = 1;
  ci.arraySize = array;
  ci.mipCount = 1;
  XrSwapchainCreateInfoFoveationFB fov{XR_TYPE_SWAPCHAIN_CREATE_INFO_FOVEATION_FB};
  if (foveation_supported) {
    fov.flags = XR_SWAPCHAIN_CREATE_FOVEATION_SCALED_BIN_BIT_FB;  // OpenGL ES: Qualcomm texture foveation
    ci.next = &fov;
  }
  XrResult r = xrCreateSwapchain(session, &ci, &swapchain);
  if (XR_FAILED(r) && foveation_supported) {
    log(LogLevel::kWarn, "xr: xrCreateSwapchain with foveation failed (%s); retrying without", result(r));
    ci.next = nullptr;
    foveation_supported = false;
    r = xrCreateSwapchain(session, &ci, &swapchain);
  }
  if (XR_FAILED(r)) {
    swapchain = XR_NULL_HANDLE;
    out->error = std::string("xrCreateSwapchain failed: ") + result(r);
    log(LogLevel::kError, "xr: %s (%ux%u x%u)", out->error.c_str(), width, eye_h, array);
    return;
  }
  uint32_t count = 0;
  xrEnumerateSwapchainImages(swapchain, 0, &count, nullptr);
  std::vector<XrSwapchainImageOpenGLESKHR> imgs(count, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR});
  xrEnumerateSwapchainImages(swapchain, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(imgs.data()));
  images.clear();
  for (auto& i : imgs) images.push_back(i.image);
  sc_w = width;
  sc_h = eye_h;
  sc_array = array;
  sc_format = format;
  held_image = false;
  have_projection = false;
  {
    std::lock_guard<std::mutex> lock(owner->sc_mu_);
    owner->sc_names_ = images;
    owner->sc_array_ = array;
  }
  owner->sc_serial_.fetch_add(1, std::memory_order_acq_rel);

  // Foveation before the first frame (XR-FOV-1): the session's startup level, else the config default.
  double level = req.foveation >= 0 ? req.foveation : (cfg->foveation >= 0 ? cfg->foveation : 0.0);
  foveation = 0;
  // A new swapchain starts without a profile (none, not dynamic).
  fov_applied_swapchain = swapchain;
  fov_applied_level = FoveationLevel::kNone;
  foveation_dynamic = false;
  if (foveation_supported && (level > 0 || cfg->foveation_dynamic)) apply_foveation(level, cfg->foveation_dynamic);
  glFinish();  // the new textures are complete before a WebGL context on the JS thread uses them

  // Passthrough under the projection layer (immersive-ar, XR_FB_passthrough): the loading screen's, when it shows
  // passthrough already, else a new one.
  session_ar = req.passthrough;
  unpremultiplied = req.unpremultiplied;
  if (req.passthrough) {
    if (pt_layer != XR_NULL_HANDLE && !pt_visible && pt_layer_resume) pt_layer_resume(pt_layer);  // a new layer shows it
    pt_visible = true;
    if (ensure_passthrough("immersive-ar")) {
      log(LogLevel::kInfo, "xr: passthrough running under the projection layer");
    } else {
      log(LogLevel::kWarn, "xr: passthrough unavailable; immersive-ar renders over black (the manifest needs "
          "com.oculus.feature.PASSTHROUGH)");
    }
  } else {
    update_passthrough();
  }

  out->ok = true;
  out->width = width;
  out->height = eye_h;
  out->array_size = array;
  out->rates = rates;
  out->rate = current_rate.load();
  out->has_stage = has_bounds;
  out->stage_width = stage_w;
  out->stage_depth = stage_d;
  out->foveation = foveation_supported ? foveation : -1;
  log(LogLevel::kInfo, "xr: swapchain %ux%u x%u format 0x%" PRIx64 ", %zu images, foveation %.2f%s", width, eye_h,
      array, format, images.size(), foveation, session_ar ? ", passthrough" : "");
  publish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Session state and events (XR thread)

void XrSystem::Impl::begin_xr_session() {
  XrSessionBeginInfo bi{XR_TYPE_SESSION_BEGIN_INFO};
  bi.primaryViewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
  XrResult r = xrBeginSession(session, &bi);
  if (XR_FAILED(r)) {
    log(LogLevel::kError, "xr: xrBeginSession failed: %s", result(r));
    return;
  }
  running = true;
  // XR-LIFE-6: colour space, refresh rate, performance levels before the first frame (foveation is per swapchain).
  if (set_color_space && !cfg->color_space.empty()) {
    XrColorSpaceFB cs = XR_COLOR_SPACE_REC709_FB;
    if (cfg->color_space == "rec2020") cs = XR_COLOR_SPACE_REC2020_FB;
    else if (cfg->color_space == "rift-cv1") cs = XR_COLOR_SPACE_RIFT_CV1_FB;
    else if (cfg->color_space == "rift-s") cs = XR_COLOR_SPACE_RIFT_S_FB;
    else if (cfg->color_space == "p3") cs = XR_COLOR_SPACE_P3_FB;
    else if (cfg->color_space == "adobe-rgb") cs = XR_COLOR_SPACE_ADOBE_RGB_FB;
    r = set_color_space(session, cs);
    log(LogLevel::kInfo, "xr: colour space %s: %s", cfg->color_space.c_str(), result(r));
  }
  if (cfg->frame_rate > 0 && request_rate) {
    r = request_rate(session, static_cast<float>(cfg->frame_rate));
    log(LogLevel::kInfo, "xr: requested %.0f Hz at session start: %s", cfg->frame_rate, result(r));
  }
  apply_perf(true);
  pacing.reset();
  {
    std::lock_guard<std::mutex> lock(stats_mu);
    if (session_running_ms < 0) session_running_ms = now_ms();
  }
  with_rt([](Runtime& r) { r.mark_boot("xrSessionRunning"); });
  push_event({XrEvent::kRunning, false, false, 0, true});
}

void XrSystem::Impl::handle_state(XrSessionState s) {
  const XrSessionState prev = static_cast<XrSessionState>(state.exchange(s));
  log(LogLevel::kInfo, "xr: session state %s -> %s", session_state_name(prev), session_state_name(s));
  switch (s) {
    case XR_SESSION_STATE_READY:
      begin_xr_session();
      break;
    case XR_SESSION_STATE_STOPPING: {
      // The app is paused (sleep, the system taking over the display): the OpenXR session stops, but the page's
      // WebXR session stays, hidden (XR-LIFE-4), with its swapchain, and runs again when OpenXR is READY. Only a
      // system end (EXITING, LOSS_PENDING) or the page ends it.
      pause_frames();
      XrResult r = xrEndSession(session);
      if (XR_FAILED(r)) log(LogLevel::kWarn, "xr: xrEndSession: %s", result(r));
      running = false;
      push_event({XrEvent::kRunning, false, false, 0, false});
      if (webxr_active) log(LogLevel::kInfo, "xr: paused; the WebXR session stays (hidden) until the app resumes");
      break;
    }
    case XR_SESSION_STATE_EXITING:
      exiting = true;
      end_webxr(true);
      log(LogLevel::kInfo, "xr: OpenXR asked the app to exit");
      with_rt([](Runtime& r) { r.request_exit(); });
      break;
    case XR_SESSION_STATE_LOSS_PENDING:
      loss_pending = true;
      end_webxr(true);
      log(LogLevel::kError, "xr: session loss pending; the app exits (session re-creation is not implemented yet)");
      with_rt([](Runtime& r) { r.request_exit(); });
      break;
    default:
      break;
  }
  const Visibility v = visibility_for(s);
  if (v != visibility) {
    if (v.visible && !visibility.visible) perf.restart_warmup(now_ms());  // resume transients do not raise levels
    visibility = v;
    life.on_xr_visible(v.visible, now_ms());
    push_event({XrEvent::kVisibility, v.visible, v.focused, 0, false});
    with_rt([&](Runtime& r) {
      r.post_lifecycle(v.visible ? LifecycleInput::kExternalVisible : LifecycleInput::kExternalHidden);
    });
  }
  publish();
}

void XrSystem::Impl::poll_events() {
  for (;;) {
    XrEventDataBuffer ev{XR_TYPE_EVENT_DATA_BUFFER};
    if (xrPollEvent(instance, &ev) != XR_SUCCESS) break;
    switch (ev.type) {
      case XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED:
        handle_state(reinterpret_cast<XrEventDataSessionStateChanged&>(ev).state);
        break;
      case XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING:
        log(LogLevel::kError, "xr: instance loss pending; the app exits");
        loss_pending = true;
        end_webxr(true);
        with_rt([](Runtime& r) { r.request_exit(); });
        break;
      case XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING: {
        auto& e = reinterpret_cast<XrEventDataReferenceSpaceChangePending&>(ev);
        log(LogLevel::kInfo, "xr: reference space %d change pending (recenter)", e.referenceSpaceType);
        if (e.referenceSpaceType == XR_REFERENCE_SPACE_TYPE_STAGE) {
          XrExtent2Df ext{};
          XrResult br = xrGetReferenceSpaceBoundsRect(session, XR_REFERENCE_SPACE_TYPE_STAGE, &ext);
          has_bounds = br == XR_SUCCESS && ext.width > 0 && ext.height > 0;
          stage_w = ext.width;
          stage_d = ext.height;
        }
        if (webxr_active) push_event({XrEvent::kReferenceSpaceReset});
        break;
      }
      case XR_TYPE_EVENT_DATA_INTERACTION_PROFILE_CHANGED:
        if (input_ok) input.refresh_profiles();
        break;
      case XR_TYPE_EVENT_DATA_DISPLAY_REFRESH_RATE_CHANGED_FB: {
        auto& e = reinterpret_cast<XrEventDataDisplayRefreshRateChangedFB&>(ev);
        log(LogLevel::kInfo, "xr: display refresh rate %.0f -> %.0f Hz", e.fromDisplayRefreshRate,
            e.toDisplayRefreshRate);
        current_rate = e.toDisplayRefreshRate;
        perf.restart_warmup(now_ms());  // frames around a rate switch are a transient, not a lack of clock
        push_event({XrEvent::kFrameRate, false, false, e.toDisplayRefreshRate, false});
        break;
      }
      case XR_TYPE_EVENT_DATA_PERF_SETTINGS_EXT: {
        auto& e = reinterpret_cast<XrEventDataPerfSettingsEXT&>(ev);
        log(LogLevel::kInfo, "xr: performance notification: domain %d subdomain %d level %d -> %d", e.domain,
            e.subDomain, e.fromLevel, e.toLevel);  // XR-PERF-2
        std::lock_guard<std::mutex> lock(stats_mu);
        ++perf_events;
        break;
      }
      case XR_TYPE_EVENT_DATA_EVENTS_LOST:
        log(LogLevel::kWarn, "xr: %u OpenXR events lost", reinterpret_cast<XrEventDataEventsLost&>(ev).lostEventCount);
        break;
      default:
        break;
    }
  }
}

void XrSystem::Impl::life_tick(double now) {
  if (now - last_life_tick < 100) return;
  last_life_tick = now;
  LifePolicy::Result lr = life.tick(now);
  if (lr.action == LifePolicy::Action::kLogNeverOffered) {
    {
      std::lock_guard<std::mutex> lock(stats_mu);
      ++never_offered_errors;
    }
    if (life.offers_rejected()) {
      log_text(kJsLogTag, LogLevel::kError,
               "No immersive session started 10 s after the page loaded: every navigator.xr.offerSession() / "
               "requestSession() call was rejected (see the app's error for the reason, for example a required "
               "feature this runtime does not support yet). This runtime shows WebXR content only. (XR-LIFE-7)");
    } else {
      log_text(kJsLogTag, LogLevel::kError,
               "No immersive session was offered or requested 10 s after the page loaded. This runtime shows WebXR "
               "content only: call navigator.xr.offerSession() or requestSession() (IWSDK: xr.offer must not be "
               "'none'). (XR-LIFE-7)");
    }
  } else if (lr.action == LifePolicy::Action::kRequestExit) {
    log(LogLevel::kWarn, "xr: %s: requesting exit (XR-LIFE-5/7)", lr.reason);
    if (running) {
      xrRequestExitSession(session);
    } else {
      with_rt([](Runtime& r) { r.request_exit(); });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Frames (XR thread)

void XrSystem::Impl::finish_js_frame() {
  // The app's GL work for this frame is fenced in its WebGL context; order this context after it before the
  // runtime fences the release (egl_xr.h).
  GLsync fence = static_cast<GLsync>(owner->js_fence_);
  owner->js_fence_ = nullptr;
  gl_wait_and_delete(fence);
  // The layers the frame drew get their new image released, and the frame's layer list becomes the plan.
  comp_layers.collect();
  const double js = owner->js_ms_;
  owner->slot_.reset();  // kDone -> kIdle: nothing is in flight any more
  {
    std::lock_guard<std::mutex> lock(stats_mu);
    ++js_frames;
    js_ms.add(js);
    log_js.add(js);
    if (first_js_frame_ms < 0) first_js_frame_ms = now_ms();
  }
  if (js_frames == 1) {
    with_rt([](Runtime& r) { r.mark_boot("firstXrFrame"); });
    // PERF-BOOT-1 in release builds, which have no debug endpoint for the boot marks: the logcat time is the mark.
    log(LogLevel::kInfo, "xr: first WebXR frame");
  }
  if (++session_js_frames == 1) perf.restart_warmup(now_ms());  // the session's first frame: its stall is a transient
  if (frame_has_image && held_image && swapchain != XR_NULL_HANDLE) {
    if (shot.has_request()) {
      shot.capture(images[image_index], static_cast<GLenum>(sc_format), sc_w, sc_h, sc_array, frame_number);
    }
    release_image();
    for (int i = 0; i < 2; ++i) {
      XrCompositionLayerProjectionView& pv = proj_views[i];
      pv = XrCompositionLayerProjectionView{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW};
      pv.pose = frame_views[i].pose;
      pv.fov = frame_views[i].fov;
      pv.subImage.swapchain = swapchain;
      const int32_t w = static_cast<int32_t>(sc_w), h = static_cast<int32_t>(sc_h);
      if (sc_array >= 2) {
        pv.subImage.imageRect = {{0, 0}, {w, h}};
        pv.subImage.imageArrayIndex = static_cast<uint32_t>(i);
      } else {
        const int32_t left = w / 2;  // IWER's layer target: left floor(w/2) columns, right the rest
        pv.subImage.imageRect = i == 0 ? XrRect2Di{{0, 0}, {left, h}} : XrRect2Di{{left, 0}, {w - left, h}};
        pv.subImage.imageArrayIndex = 0;
      }
    }
    projection_flags = 0;
    if (session_ar) {
      projection_flags |= XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
      if (unpremultiplied) projection_flags |= XR_COMPOSITION_LAYER_UNPREMULTIPLIED_ALPHA_BIT;
    }
    projection.layerFlags = projection_flags;
    projection.space = base;
    projection.viewCount = 2;
    projection.views = proj_views;
    have_projection = true;
  }
  if (destroy_pending) destroy_swapchain();
}

// The eye views for the predicted display time in the base space; the same poses go to JS and to the projection
// layer (XR-SC-4). Only what OpenXR marks valid is used (OpenXR 1.1 xrLocateViews, XrViewState): without a valid
// orientation (the call failed, tracking lost) the last located views stay, which the compositor re-projects,
// instead of zeroed quaternions that xrEndFrame rejects (XR_ERROR_POSE_INVALID) and IWER would turn into NaN
// matrices; without a valid position the last position stays. False until a first valid orientation (startup).
bool XrSystem::Impl::locate_views(XrTime display_time) {
  XrViewLocateInfo vli{XR_TYPE_VIEW_LOCATE_INFO};
  vli.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
  vli.displayTime = display_time;
  vli.space = base;
  XrViewState vs{XR_TYPE_VIEW_STATE};
  XrView located[2] = {XrView{XR_TYPE_VIEW}, XrView{XR_TYPE_VIEW}};
  uint32_t count = 0;
  const XrResult r = xrLocateViews(session, &vli, &vs, 2, &count, located);
  if (XR_SUCCEEDED(r) && count == 2 && (vs.viewStateFlags & XR_VIEW_STATE_ORIENTATION_VALID_BIT)) {
    const bool position = (vs.viewStateFlags & XR_VIEW_STATE_POSITION_VALID_BIT) != 0;
    for (int i = 0; i < 2; ++i) {
      frame_views[i].fov = located[i].fov;
      frame_views[i].pose.orientation = located[i].pose.orientation;
      if (position) {
        frame_views[i].pose.position = located[i].pose.position;
      } else if (!have_views) {
        frame_views[i].pose.position = XrVector3f{0, 0, 0};  // orientation only until the first valid position
      }
    }
    have_views = true;
  }
  return have_views;
}

void XrSystem::Impl::run_frame() {
  FrameRecord& record = owner->record_;
  FrameSlot& slot = owner->slot_;
  XrFrameWaitInfo wi{XR_TYPE_FRAME_WAIT_INFO};
  XrFrameState fs{XR_TYPE_FRAME_STATE};
  const double t_wait0 = now_ms();
  XrResult r = xrWaitFrame(session, &wi, &fs);
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: xrWaitFrame: %s", result(r));
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    return;
  }
  const double t_frame = now_ms();
  r = xrBeginFrame(session, nullptr);
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: xrBeginFrame: %s", result(r));
    return;
  }
  ++frame_number;
  if (t_frame - last_calibration_ms > 5000) calibrate();
  const int skipped = pacing.observe(fs.predictedDisplayTime, fs.predictedDisplayPeriod);
  const double period_ms = static_cast<double>(fs.predictedDisplayPeriod) / 1e6;
  // A JS frame that outlived its OpenXR frame (long frame, debugger) is collected as soon as it is done, before the
  // commands run, so a command that ends or replaces the session finds nothing in flight.
  if (slot.state() == FrameSlot::kDone) finish_js_frame();
  owner->commands_.run_pending();
  shot.poll();
  const double t_cmds = now_ms();
  double t_post = -1;

  const bool render = fs.shouldRender == XR_TRUE;
  bool js_frame = webxr_active && render && visibility.visible && slot.state() == FrameSlot::kIdle;
  double js_cpu_ms = 0;
  if (js_frame) {
    // Image first: the record carries the GL name of the image this frame renders into.
    frame_has_image = false;
    if (swapchain != XR_NULL_HANDLE) {
      if (!held_image) {
        XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
        if (XR_SUCCEEDED(xrAcquireSwapchainImage(swapchain, &ai, &image_index))) {
          XrSwapchainImageWaitInfo swi{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
          swi.timeout = 100000000;  // 100 ms per try
          XrResult wr;
          while ((wr = xrWaitSwapchainImage(swapchain, &swi)) == XR_TIMEOUT_EXPIRED && !quit) {
          }
          held_image = XR_SUCCEEDED(wr);
          if (!held_image) log(LogLevel::kWarn, "xr: xrWaitSwapchainImage: %s", result(wr));
        }
      }
      frame_has_image = held_image;
    }
    comp_layers.acquire_pending();  // every quad and cylinder layer has an image to draw into
    // Tracking for the predicted display time, all in the base space.
    if (!locate_views(fs.predictedDisplayTime)) {
      // No valid pose yet (tracking not ready at startup): nothing to hand to JS. The image stays held for the
      // next frame and this one is submitted without a projection layer.
      js_frame = false;
      std::lock_guard<std::mutex> lock(stats_mu);
      ++untracked_frames;
    }
  }
  if (js_frame) {
    XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
    if (base_is_stage && XR_SUCCEEDED(xrLocateSpace(local_space, base, fs.predictedDisplayTime, &loc)) &&
        location_valid(loc.locationFlags)) {
      last_local = loc.pose;
    }
    loc = XrSpaceLocation{XR_TYPE_SPACE_LOCATION};
    if (XR_SUCCEEDED(xrLocateSpace(view_space, base, fs.predictedDisplayTime, &loc)) &&
        location_valid(loc.locationFlags)) {
      last_viewer = loc.pose;
    }
    if (input_ok) input.sample(fs.predictedDisplayTime, base, session_hand_tracking, visibility.focused, hands);

    // The record (XRF-2), written while no JS frame is in flight.
    const double pdt = pacing.strictly_increasing(clock.to_perf_ms(fs.predictedDisplayTime));
    const uint32_t name = frame_has_image ? images[image_index] : 0;
    record.write_header(true, base_is_stage, 2, name, frame_has_image ? sc_array : 0, pdt, t_frame, period_ms,
                        current_rate.load(), static_cast<float>(foveation));
    record.write_view(0, frame_views[0].pose, frame_views[0].fov);
    record.write_view(1, frame_views[1].pose, frame_views[1].fov);
    record.write_pose(L::kLocalPose, last_local);
    record.write_pose(L::kViewerPose, last_viewer);
    for (int h = 0; h < 2; ++h) write_hand_input(record, h, hands[h], true);
    record.next_serial();

    t_post = now_ms();
    slot.post();
    owner->pending_frame_.store(true, std::memory_order_release);
    wake_js();
    // After a frame JS never began (a long task) the next ones are offered only briefly, and so is the session's
    // first frame (first-sight compiles and uploads outlast any deadline): idle frames keep being submitted on time
    // (XR-IDLE-1) and such a frame is collected whenever it is done.
    const double wait_periods = js_busy || session_js_frames == 0 ? 0.15 : cfg->frame_deadline_periods;
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::microseconds(static_cast<int64_t>(period_ms * wait_periods * 1000.0));
    slot.wait_done(deadline, &owner->commands_);
    switch (slot.conclude()) {
      case FrameSlot::Outcome::kDone:
        js_busy = false;
        js_cpu_ms = owner->js_ms_;
        finish_js_frame();
        break;
      case FrameSlot::Outcome::kCancelled: {
        // JS never began (a long task, a debugger pause): keep the image for the next frame.
        js_busy = true;
        std::lock_guard<std::mutex> lock(stats_mu);
        ++cancelled;
        break;
      }
      case FrameSlot::Outcome::kWithdrawn: {
        // A command run while waiting (the page ended its session or reloaded, a new swapchain) took the frame back
        // and released its image: nothing is in flight.
        js_busy = false;
        std::lock_guard<std::mutex> lock(stats_mu);
        ++withdrawn;
        break;
      }
      case FrameSlot::Outcome::kRunning: {
        // JS is still in the frame: it is collected, and its image submitted, in a later OpenXR frame.
        js_busy = false;
        std::lock_guard<std::mutex> lock(stats_mu);
        ++late;
        break;
      }
    }
  } else if (owner->want_ticks_.load(std::memory_order_relaxed) &&
             !owner->pending_tick_.load(std::memory_order_acquire)) {
    // Idle presentation (XR-IDLE-2), or a hidden / not-rendering session (XR-LOOP-2): window rAF only.
    owner->tick_start_ms_.store(t_frame, std::memory_order_relaxed);
    owner->tick_period_ms_.store(period_ms, std::memory_order_relaxed);
    owner->pending_tick_.store(true, std::memory_order_release);
    wake_js();
    std::lock_guard<std::mutex> lock(stats_mu);
    ++ticks;
  }
  if (!webxr_active && shot.has_request()) shot.capture_black(rec_w, rec_h, frame_number);

  // Layers (plan_frame_layers(), loading.h), back to front: passthrough (under an immersive-ar session's frames, or
  // the loading screen's passthrough background), the opaque background (behind the loading screen, or a session's
  // frame without an app frame), the projection layer with the last finished image and the poses it was rendered
  // with (XR-SC-4), and the loading screen's quads while the app has nothing to show yet or fading out over the
  // app's first frames.
  constexpr uint32_t kMaxLayers = 16;
  const uint32_t layer_limit = std::min(kMaxLayers, max_layer_count);
  const XrCompositionLayerBaseHeader* layers[kMaxLayers];
  uint32_t layer_count = 0;
  // A session that shows only quad or cylinder layers (no projection layer, XR-LAYER-1) presents too: its frames end
  // the loading screen and need no cover.
  const bool projection_frame = have_projection && swapchain != XR_NULL_HANDLE;
  const bool app_frame = projection_frame || (webxr_active && comp_layers.has_list() && comp_layers.has_content());
  const bool submit_projection = webxr_active && render && app_frame;
  const LoadingPolicy::Frame lf = render ? loading_policy.frame(t_frame, submit_projection) : LoadingPolicy::Frame{};
  FrameLayerInput li;
  li.render = render;
  li.webxr_active = webxr_active;
  li.session_ar = session_ar;
  li.app_frame = app_frame;
  li.loading_ready = loading.ready();
  li.cover_ready = loading.has_background();
  li.passthrough_ready = pt_layer != XR_NULL_HANDLE && pt_visible;
  li.background = loading_bg;
  const FrameLayerPlan plan = plan_frame_layers(li, lf);
  if (plan.passthrough) {
    pt_comp.layerHandle = pt_layer;
    pt_comp.flags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
    pt_comp.space = XR_NULL_HANDLE;
    layers[layer_count++] = reinterpret_cast<const XrCompositionLayerBaseHeader*>(&pt_comp);
  }
  if (plan.cover) layer_count += loading.build_cover(view_space, layers + layer_count, layer_limit - layer_count);
  if (plan.projection && projection_frame) {
    // The app's first frames come in under the fading loading layers (AppFade): from the background colour
    // (colour * s + background * bias, the bias in linear space as the compositor blends), over passthrough
    // (immersive-ar: premultiplied colour and alpha * s), or at once over a passthrough background.
    projection.next = nullptr;
    if (ext_scale_bias && plan.app_fade != AppFade::kNone) {
      const float s = plan.app_scale;
      if (plan.app_fade == AppFade::kAlpha) {
        app_fade.colorScale = unpremultiplied ? XrColor4f{1.0f, 1.0f, 1.0f, s} : XrColor4f{s, s, s, s};
        app_fade.colorBias = {0, 0, 0, 0};
      } else {
        const float k = plan.app_bias;
        const float* bg = cfg->loading.background;
        app_fade.colorScale = {s, s, s, 1.0f};
        app_fade.colorBias = {srgb_to_linear(bg[0]) * k, srgb_to_linear(bg[1]) * k, srgb_to_linear(bg[2]) * k, 0};
      }
      projection.next = &app_fade;
    }
  }
  const auto* app_projection = plan.projection && projection_frame
                                   ? reinterpret_cast<const XrCompositionLayerBaseHeader*>(&projection)
                                   : nullptr;
  if (webxr_active && render && comp_layers.has_list()) {
    // The page's renderState.layers (XR-SC-4, XR-LAYER-1): the projection layer where the list has it, the quad and
    // cylinder layers around it in list order; room is kept for the two loading quads. Layers listed before the
    // projection layer show through its transparent pixels, so it blends by its alpha then (Chromium blends
    // projection layers by default); otherwise its flags stay (opaque in VR).
    projection.layerFlags = projection_flags;
    if (app_projection && !session_ar && comp_layers.content_under_projection()) {
      projection.layerFlags |= XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
      if (unpremultiplied) projection.layerFlags |= XR_COMPOSITION_LAYER_UNPREMULTIPLIED_ALPHA_BIT;
    }
    const uint32_t room = layer_limit > layer_count + 2 ? layer_limit - layer_count - 2 : 0;
    layer_count += comp_layers.append(base, view_space, app_projection, layers + layer_count, room);
  } else if (app_projection) {
    projection.layerFlags = projection_flags;
    layers[layer_count++] = app_projection;
  }
  // A session's frames without an app frame (a resume: the page's next frame is still rendering) carry the opaque
  // background instead of nothing; how many is logged when the app's frames are back.
  const bool covered = plan.cover && !plan.quads;
  if (covered) {
    ++covered_run;
  } else if (covered_run > 0) {
    log(LogLevel::kInfo, "xr: %" PRIu64 " frame(s) without an app frame showed the opaque background (%s)", covered_run,
        plan.projection ? "until the app's next frame" : "until the loading screen");
    covered_run = 0;
  }
  bool loading_located = false;
  double loading_head_pitch = 0;
  if (plan.quads) {
    // World-locked in the base space (LoadingPlacement: on the horizon ahead, or along the gaze when the head is
    // pitched); head-locked while tracking reports no head pose (a missing position would put the card at the base
    // space's origin, on the floor).
    XrSpace space = base;
    XrPosef anchor{{0, 0, 0, 1}, {0, 0, 0}};
    XrSpaceLocation head{XR_TYPE_SPACE_LOCATION};
    if (XR_SUCCEEDED(xrLocateSpace(view_space, base, fs.predictedDisplayTime, &head)) &&
        location_valid(head.locationFlags)) {
      const bool placing = !loading_place.placed();
      anchor = loading_place.update(head.pose, t_frame);
      loading_located = true;
      loading_head_pitch = degrees(pitch_of(head.pose.orientation));
      if (placing) {
        log(LogLevel::kInfo, "xr: loading screen: placed %s (yaw %.0f, pitch %.0f degrees; the head's pitch %.0f)",
            loading_place.on_horizon() ? "on the horizon ahead" : "along the gaze",
            degrees(loading_place.yaw()), degrees(loading_place.pitch()), loading_head_pitch);
      }
    } else {
      space = view_space;
    }
    layer_count += loading.build_quads(space, anchor, t_frame, plan.quad_alpha, ext_scale_bias, layers + layer_count,
                                       layer_limit > layer_count ? layer_limit - layer_count : 0);
  }
  if (lf.first_loading || lf.handover) {
    const double t = now_ms();
    with_rt([&](Runtime& rt) { rt.mark_boot(lf.first_loading ? "firstLoadingFrame" : "loadingHandover"); });
    if (lf.first_loading) {
      {
        std::lock_guard<std::mutex> lock(stats_mu);
        first_loading_frame_ms = t;
      }
      // The time from process start (ms since onCreate) the user first sees the app's own pixels (PERF-BOOT).
      log(LogLevel::kInfo, "xr: loading screen: first frame at %.0f ms (%s)", t,
          visibility.visible ? "visible" : "not visible yet");
    } else {
      log(LogLevel::kInfo, "xr: loading screen: handed over to the app's first frame after %.0f ms on screen",
          loading_policy.last_loading_duration_ms());
    }
  }
  if (lf.loading) {
    double visible_at = -1;
    {
      std::lock_guard<std::mutex> lock(stats_mu);
      ++loading_frames;
      if (visibility.visible && first_visible_loading_ms < 0) visible_at = first_visible_loading_ms = now_ms();
      loading_anchor_known = loading_located;
      if (loading_located) {
        loading_anchor_yaw_deg = degrees(loading_place.yaw());
        loading_anchor_pitch_deg = degrees(loading_place.pitch());
        loading_head_pitch_deg = loading_head_pitch;
      }
    }
    if (visible_at >= 0) log(LogLevel::kInfo, "xr: loading screen: visible at %.0f ms", visible_at);
  }
  XrFrameEndInfo ei{XR_TYPE_FRAME_END_INFO};
  ei.displayTime = fs.predictedDisplayTime;
  ei.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
  ei.layerCount = layer_count;
  ei.layers = layer_count ? layers : nullptr;
  const double t_end0 = now_ms();
  r = xrEndFrame(session, &ei);
  const double t_end1 = now_ms();
  if (XR_FAILED(r)) log(LogLevel::kWarn, "xr: xrEndFrame: %s", result(r));
  if (lf.handover_done) update_passthrough();  // the app's frames replaced a passthrough background (after the submit)

  // Performance levels (XR-PERF-1) adapt to missed frames while the app renders.
  if (webxr_active) {
    PerfPolicy::Change ch = perf.on_frame(t_end1, skipped, js_cpu_ms, period_ms);
    if (ch.any()) {
      log(LogLevel::kInfo, "xr: performance levels -> CPU %s, GPU %s (%s)", perf_level_name(perf.cpu()),
          perf_level_name(perf.gpu()), ch.reason);
      apply_perf(false);
    }
  }
  double boot_gap = 0, prev_end = -1;
  {
    std::lock_guard<std::mutex> lock(stats_mu);
    ++xr_frames;
    if (submit_projection) ++projection_frames;
    if (submit_projection && !js_frame) ++stale_resubmits;
    if (covered) ++covered_frames;
    wait_ms.add(t_frame - t_wait0);
    end_ms.add(t_end1 - t_end0);
    log_wait.add(t_frame - t_wait0);
    log_end.add(t_end1 - t_end0);
    ++log_frames;
    log_missed += static_cast<uint64_t>(skipped);
    if (first_idle_frame_ms < 0) first_idle_frame_ms = t_end1;
    // XR-IDLE-1: the longest gap between submitted frames the user can see (both submitted while VISIBLE or
    // FOCUSED; OpenXR shows nothing of the app before that, e.g. while SYNCHRONIZED) from session start to the
    // first WebXR frame.
    if (first_js_frame_ms < 0 && last_end_ms >= 0) {
      boot_gap = t_end1 - last_end_ms;
      prev_end = last_end_ms;
      if (visibility.visible && last_end_visible) max_boot_gap_ms = std::max(max_boot_gap_ms, boot_gap);
    }
    last_end_ms = t_end1;
    last_end_visible = visibility.visible;
    publish_locked();
  }
  if (boot_gap > 2 * period_ms && boot_gap_logs < 5) {
    // Where a boot gap above XR-IDLE-1's SHOULD target (2 display periods) went (at most 5 lines per process),
    // also the ones before the app is visible, which the stat leaves out.
    ++boot_gap_logs;
    log(LogLevel::kInfo,
        "xr: boot gap %.1f ms (> 2 periods, %s): loop top (events, commands) %.1f, xrWaitFrame %.1f, "
        "collect+commands %.1f, %s %.1f, xrEndFrame %.1f",
        boot_gap, visibility.visible ? "visible" : "not visible yet", t_wait0 - prev_end, t_frame - t_wait0,
        t_cmds - t_frame, t_post >= 0 ? "image+views+record, JS frame" : "tick", t_end0 - t_cmds, t_end1 - t_end0);
  }
  if (cfg->stats_interval_ms > 0 && t_end1 - last_stats_log_ms >= cfg->stats_interval_ms) log_stats(t_end1);
}

void XrSystem::Impl::log_stats(double now) {
  std::lock_guard<std::mutex> lock(stats_mu);
  const double window = now - last_stats_log_ms;
  if (last_stats_log_ms > 0 && window > 0) {
    log(LogLevel::kInfo,
        "xr-stats fps=%.1f rate=%.0f state=%s vis=%s webxr=%d swapchain=%ux%ux%u waitMs=%.2f jsMs=%.2f endMs=%.2f "
        "missed=%" PRIu64 " cpu=%s gpu=%s fov=%.2f ticks=%" PRIu64 " cancelled=%" PRIu64 " late=%" PRIu64
        " resubmits=%" PRIu64 " left=%s right=%s withdrawn=%" PRIu64 " untracked=%" PRIu64 " layers=%u/%zu",
        log_frames * 1000.0 / window, static_cast<double>(current_rate.load()),
        session_state_name(static_cast<XrSessionState>(state.load())), web_visibility(visibility), webxr_active ? 1 : 0,
        sc_w, sc_h, sc_array, log_wait.mean(), log_js.mean(), log_end.mean(), log_missed, perf_level_name(applied_cpu),
        perf_level_name(applied_gpu), foveation, ticks, cancelled, late, stale_resubmits,
        input_ok ? input.profile_name(0) : "-", input_ok ? input.profile_name(1) : "-", withdrawn, untracked_frames,
        comp_layers.last_submitted(), comp_layers.live());
  }
  last_stats_log_ms = now;
  log_frames = 0;
  log_missed = 0;
  log_wait.reset();
  log_js.reset();
  log_end.reset();
}

void XrSystem::Impl::teardown() {
  owner->commands_.close();
  FrameSlot& slot = owner->slot_;
  shot.shutdown();
  // The JS thread is in the shutdown hook, so a frame it began can no longer finish: drop it (stop() puts the slot
  // back to idle after the join).
  slot.withdraw();
  slot.reset();
  if (owner->js_fence_) {
    glDeleteSync(static_cast<GLsync>(owner->js_fence_));
    owner->js_fence_ = nullptr;
  }
  release_image();
  if (swapchain != XR_NULL_HANDLE) xrDestroySwapchain(swapchain);
  swapchain = XR_NULL_HANDLE;
  comp_layers.destroy_all();
  if (loading_decode.joinable()) loading_decode.join();  // initialisation failed before it was collected
  loading.destroy();
  destroy_passthrough();
  if (input_ok) input.destroy();
  input_ok = false;
  for (XrSpace* s : {&view_space, &local_space, &stage_space}) {
    if (*s != XR_NULL_HANDLE) xrDestroySpace(*s);
    *s = XR_NULL_HANDLE;
  }
  if (session != XR_NULL_HANDLE) xrDestroySession(session);
  session = XR_NULL_HANDLE;
  if (instance != XR_NULL_HANDLE) xrDestroyInstance(instance);
  instance = XR_NULL_HANDLE;
  egl.destroy();
  release_android_context(env, &android);
}

void XrSystem::thread_main() {
  pthread_setname_np(pthread_self(), "iwn-xr");
  Impl& x = *impl_;
  const bool ok = x.initialize();
  while (!x.quit) {
    if (ok && x.instance != XR_NULL_HANDLE) x.poll_events();
    commands_.run_pending();
    if (x.quit) break;
    if (ok) x.life_tick(now_ms());
    if (!ok || x.exiting || x.loss_pending || !x.running) {
      commands_.wait(std::chrono::milliseconds(20));
      continue;
    }
    x.run_frame();
  }
  x.teardown();
  detach_current_thread();
  log(LogLevel::kInfo, "xr: XR thread stopped");
  std::lock_guard<std::mutex> lock(x.init_mu);
  x.thread_done = true;
  x.init_cv.notify_all();
}

// ---------------------------------------------------------------------------------------------------------------------
// JS-thread API

Json XrSystem::info() {
  if (!impl_) {
    Json j = Json::object();
    j.set("available", false);
    j.set("error", "XR module not started");
    return j;
  }
  wait_initialized(10000);  // boot: the adapter's device config needs the capabilities
  std::lock_guard<std::mutex> lock(impl_->info_mu);
  Json j = impl_->info;
  j.set("refreshRate", static_cast<double>(impl_->current_rate.load()));
  j.set("explicitGrant", config_.explicit_grant);
  return j;
}

SwapchainAnswer XrSystem::begin_swapchain(const SwapchainRequest& request) {
  auto answer = std::make_shared<SwapchainAnswer>();
  if (!impl_ || !wait_initialized(10000)) {
    answer->error = impl_ ? (impl_->init_error.empty() ? "OpenXR is not ready" : impl_->init_error)
                          : "XR module not started";
    return *answer;
  }
  Impl* x = impl_.get();
  const bool ran = commands_.call([x, request, answer] { x->create_swapchain(request, answer.get()); },
                                  std::chrono::milliseconds(5000));
  if (!ran) {
    SwapchainAnswer timeout;
    timeout.error = "the XR thread did not create the swapchain within 5 s";
    log(LogLevel::kError, "xr: %s", timeout.error.c_str());
    return timeout;
  }
  // set_foveation() compares against the level the new swapchain starts with (none when foveation is unavailable).
  if (answer->ok) fov_requested_ = static_cast<int>(foveation_level_for(answer->foveation > 0 ? answer->foveation : 0));
  return *answer;
}

LayerSwapchainAnswer XrSystem::begin_layer_swapchain(const LayerSwapchainRequest& request) {
  auto answer = std::make_shared<LayerSwapchainAnswer>();
  if (!impl_ || !wait_initialized(10000)) {
    answer->error = "OpenXR is not ready";
    return *answer;
  }
  Impl* x = impl_.get();
  // A command that times out still runs later (handoff.h): whichever of it and this caller comes second decides. A
  // swapchain made after the caller gave up has an id JS never learns, so the command destroys it (no JS frame can
  // have drawn into it).
  enum : int { kPending, kDone, kAbandoned };
  auto outcome = std::make_shared<std::atomic<int>>(kPending);
  const bool ran = commands_.call(
      [x, request, answer, outcome] {
        x->comp_layers.create(request, answer.get());
        int expected = kPending;
        if (!outcome->compare_exchange_strong(expected, kDone) && answer->ok) {
          log(LogLevel::kWarn, "xr: layer swapchain %u was made after its caller gave up; destroyed", answer->id);
          x->comp_layers.destroy(answer->id, false);
        }
      },
      std::chrono::milliseconds(5000));
  int expected = kPending;
  if (!ran && outcome->compare_exchange_strong(expected, kAbandoned)) {
    LayerSwapchainAnswer timeout;
    timeout.error = "the XR thread did not create the layer swapchain within 5 s";
    return timeout;
  }
  return *answer;
}

void XrSystem::destroy_layer_swapchain(uint32_t id) {
  if (!impl_) return;
  Impl* x = impl_.get();
  commands_.push([this, x, id] {
    const FrameSlot::State st = slot_.state();
    x->comp_layers.destroy(id, st == FrameSlot::kRunning || st == FrameSlot::kDone);
  });
}

uint32_t XrSystem::acquire_layer_image(uint32_t id) {
  if (!impl_ || !wait_initialized(0)) return 0;
  Impl* x = impl_.get();
  auto name = std::make_shared<uint32_t>(0);
  if (!commands_.call([x, id, name] { *name = x->comp_layers.acquire_now(id); }, std::chrono::milliseconds(1000))) {
    log(LogLevel::kWarn, "xr: the XR thread did not acquire a layer image within 1 s");
    return 0;
  }
  return *name;
}

void XrSystem::end_webxr_session() {
  if (!impl_) return;
  Impl* x = impl_.get();
  commands_.push([x] { x->end_webxr(false); });
}

bool XrSystem::request_frame_rate(float hz) {
  if (!impl_ || !wait_initialized(0)) return false;  // also orders the reads below after initialisation
  Impl* x = impl_.get();
  if (!x->request_rate || std::find(x->rates.begin(), x->rates.end(), hz) == x->rates.end()) return false;
  commands_.push([x, hz] {
    XrResult r = x->request_rate(x->session, hz);
    log(LogLevel::kInfo, "xr: requested %.0f Hz: %s", static_cast<double>(hz), x->result(r));
  });
  return true;
}

void XrSystem::set_foveation(double level) {
  if (!impl_) return;
  // IWER forwards every fixedFoveation assignment (an adaptive app may assign it each frame): only a change of
  // level becomes an XR-thread command.
  const int lv = static_cast<int>(foveation_level_for(level));
  if (lv == fov_requested_) return;
  fov_requested_ = lv;
  Impl* x = impl_.get();
  commands_.push([x, level] { x->apply_foveation(level, x->foveation_dynamic); });
}

void XrSystem::set_passthrough_visible(bool visible) {
  if (!impl_) return;
  Impl* x = impl_.get();
  commands_.push([x, visible] {
    x->pt_visible = visible;
    if (x->pt_layer != XR_NULL_HANDLE) {
      if (visible && x->pt_layer_resume) x->pt_layer_resume(x->pt_layer);
      if (!visible && x->pt_layer_pause) x->pt_layer_pause(x->pt_layer);
    }
  });
}

void XrSystem::haptic(int hand, float intensity, double duration_ms, float frequency_hz) {
  if (!impl_) return;
  Impl* x = impl_.get();
  const int64_t ns = static_cast<int64_t>(std::max(0.0, duration_ms) * 1e6);
  commands_.push([x, hand, intensity, ns, frequency_hz] {
    if (x->input_ok) x->input.haptic(hand, intensity, ns, frequency_hz);
  });
}

void XrSystem::notify_session_started(bool immersive_ar, bool hand_tracking, bool planes, bool meshes) {
  if (!impl_) return;
  Impl* x = impl_.get();
  (void)planes;
  (void)meshes;
  const double t = now_ms();
  rt_->mark_boot("sessionGranted");
  session_granted_ms_.store(t, std::memory_order_relaxed);
  session_first_frame_ms_.store(-1, std::memory_order_relaxed);
  session_first_frame_pending_.store(true, std::memory_order_relaxed);
  commands_.push([x, immersive_ar, hand_tracking, t] {
    x->webxr_active = true;
    x->session_ar = immersive_ar;
    x->session_hand_tracking = hand_tracking;
    x->js_busy = false;
    x->life.on_session_started(t);
    x->session_js_frames = 0;
    x->perf.restart_warmup(now_ms());  // first-frame compiles and uploads do not raise levels
    {
      std::lock_guard<std::mutex> lock(x->stats_mu);
      if (x->session_granted_ms < 0) x->session_granted_ms = t;
    }
    log(LogLevel::kInfo, "xr: WebXR session started (%s%s)", immersive_ar ? "immersive-ar" : "immersive-vr",
        hand_tracking ? ", hand-tracking" : "");
  });
}

void XrSystem::notify_offered() {
  if (!impl_) return;
  Impl* x = impl_.get();
  const double t = now_ms();
  commands_.push([x, t] { x->life.on_offered(t); });
}

void XrSystem::notify_offer_rejected() {
  if (!impl_) return;
  Impl* x = impl_.get();
  const double t = now_ms();
  commands_.push([x, t] {
    x->life.on_offer_rejected(t);
    if (x->life.offers_rejected() && !x->life.ever_offered()) {
      log(LogLevel::kInfo, "xr: every pending session request was rejected and no session exists (XR-LIFE-7 applies)");
    }
  });
}

void XrSystem::notify_entry_evaluated() {
  if (!impl_) return;
  Impl* x = impl_.get();
  const double t = now_ms();
  commands_.push([x, t] { x->life.on_entry_evaluated(t); });
}

void XrSystem::notify_page_started() {
  if (!impl_) return;
  Impl* x = impl_.get();
  const double t = now_ms();
  commands_.push([x, t] {
    x->life.on_page_started(t);
    log(LogLevel::kInfo, "xr: new page: the session timers start over (XR-LIFE-7 counts from its load)");
  });
}

void XrSystem::request_shot(const std::string& eye, double scale, std::function<void(Json)> reply) {
  if (!impl_ || !started_) {
    Json err = Json::object();
    err.set("error", "shot: the XR module is not running");
    reply(std::move(err));
    return;
  }
  impl_->shot.request(eye, scale, std::move(reply));
}

bool XrSystem::take_events(std::vector<XrEvent>* out) {
  if (!events_pending_.exchange(false, std::memory_order_acq_rel)) return false;
  std::lock_guard<std::mutex> lock(events_mu_);
  if (events_.empty()) return false;
  out->swap(events_);
  events_.clear();
  return !out->empty();
}

XrSystem::Pending XrSystem::take_pending(double* start_ms, double* period_ms) {
  if (pending_frame_.exchange(false, std::memory_order_acq_rel)) return Pending::kXrFrame;
  if (pending_tick_.exchange(false, std::memory_order_acq_rel)) {
    *start_ms = tick_start_ms_.load(std::memory_order_relaxed);
    *period_ms = tick_period_ms_.load(std::memory_order_relaxed);
    return Pending::kTick;
  }
  return Pending::kNone;
}

// ---------------------------------------------------------------------------------------------------------------------
// Foveation (XR-FOV-1)
//
// XR_FB_foveation applies a profile to the swapchain, and on GLES the OpenXR runtime implements it with
// QCOM_texture_foveated on the swapchain textures, from the session's graphics context (the XR thread's). The
// rendering happens in the page's WebGL context on the JS thread, where that state is readable (feature bits and
// minimum density query back as the runtime set them) but not in effect: measured on Quest 3S with a
// fragment-bound frame, GPU time was the same with the profile at none and at high, also after
// glTextureFoveationParametersQCOM was called from the WebGL context alone; it dropped by ~40 % once the feature
// bits and minimum density were also set from the WebGL context. So the runtime applies the level itself, from the
// session's WebGL context at the end of a frame (the adapter makes it current before endFrameGL): feature bits,
// minimum density and per-layer focal parameters, for every image of the current swapchain when the swapchain or
// the level changes, and again once a second. The texture binding it uses is restored, so the WebGL binding's
// state cache stays right. Focal points are each eye's projection centre from the frame's FOVs; the per-level
// values are foveation_params_for (xr_config.h). Dynamic foveation is applied as the configured level (for now).
// Sources: QCOM_texture_foveated, XR_FB_foveation, XR_FB_foveation_configuration, OpenGL ES 3.2 Appendix D.

void XrSystem::js_apply_foveation() {
  using ParamsFn = void (*)(GLuint, GLuint, GLuint, GLfloat, GLfloat, GLfloat, GLfloat, GLfloat);
  static const ParamsFn params = reinterpret_cast<ParamsFn>(eglGetProcAddress("glTextureFoveationParametersQCOM"));
  constexpr GLenum kFeatureBits = 0x8BFB;  // GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM
  constexpr GLenum kMinDensity = 0x8BFC;   // GL_TEXTURE_FOVEATED_MIN_PIXEL_DENSITY_QCOM
  constexpr GLenum kNumFocalPoints = 0x8BFE;  // GL_TEXTURE_FOVEATED_NUM_FOCAL_POINTS_QUERY_QCOM
  constexpr GLint kEnableScaledBin = 0x1 | 0x2;  // FOVEATION_ENABLE_BIT_QCOM | FOVEATION_SCALED_BIN_METHOD_BIT_QCOM
  if (!params) return;
  const uint32_t serial = sc_serial_.load(std::memory_order_acquire);
  const float value = record_.f32(L::kFoveation);
  const double now = now_ms();
  const bool changed = serial != fov_serial_ || value != fov_value_;
  if (!changed && now - fov_refresh_ms_ < 1000) return;
  uint32_t names[8];
  size_t count = 0;
  uint32_t array = 0;
  {
    std::lock_guard<std::mutex> lock(sc_mu_);
    count = std::min<size_t>(sc_names_.size(), 8);
    for (size_t i = 0; i < count; ++i) names[i] = sc_names_[i];
    array = sc_array_;
  }
  fov_serial_ = serial;
  fov_value_ = value;
  fov_refresh_ms_ = now;
  if (count == 0) return;
  const FoveationParams p = foveation_params_for(foveation_level_for(value));
  float fx[2], fy[2];
  for (int v = 0; v < 2; ++v) {
    const float* f = record_.at<float>(L::kViews) + v * 11 + 7;  // angleLeft angleRight angleUp angleDown
    foveation_focal_point(f[0], f[1], f[2], f[3], &fx[v], &fy[v]);
  }
  // No GL error may come out of this (the WebGL binding reports driver errors to the page lazily, GL-9), so every
  // call is one the extension accepts in this state: the feature is enabled before parameters are set (it cannot be
  // switched off again: none keeps it on with full density), and a second focal point is used only when offered.
  const GLenum target = array >= 2 ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
  const bool enable = p.gain > 0;
  if (!enable && fov_enabled_serial_ != serial) return;  // never enabled for this swapchain: nothing to undo
  GLint prev = 0;
  if (enable) glGetIntegerv(array >= 2 ? GL_TEXTURE_BINDING_2D_ARRAY : GL_TEXTURE_BINDING_2D, &prev);
  for (size_t i = 0; i < count; ++i) {
    if (enable) {
      glBindTexture(target, names[i]);
      glTexParameteri(target, kFeatureBits, kEnableScaledBin);
      glTexParameterf(target, kMinDensity, p.min_density);
      if (array < 2 && i == 0) {
        GLint n = 1;
        glGetTexParameteriv(target, kNumFocalPoints, &n);
        fov_focal_points_ = n;
      }
    }
    if (array >= 2) {
      for (GLuint layer = 0; layer < 2; ++layer) params(names[i], layer, 0, fx[layer], fy[layer], p.gain, p.gain, p.area);
    } else if (fov_focal_points_ >= 2) {
      // Both eyes side by side in one layer: one focal point per eye, x scaled into that eye's half.
      params(names[i], 0, 0, -0.5f + 0.5f * fx[0], fy[0], p.gain * 2, p.gain, p.area);
      params(names[i], 0, 1, 0.5f + 0.5f * fx[1], fy[1], p.gain * 2, p.gain, p.area);
    } else {
      params(names[i], 0, 0, 0.0f, 0.5f * (fy[0] + fy[1]), p.gain, p.gain, p.area);
    }
  }
  if (enable) {
    glBindTexture(target, static_cast<GLuint>(prev));
    fov_enabled_serial_ = serial;
  }
  ++fov_applications_;
  if (changed && (p.gain != fov_gain_ || fov_applications_ == 1)) {
    log(LogLevel::kInfo, "xr: foveation %s (gain %.1f) applied from the rendering context to %zu images, focal points "
        "(%.3f, %.3f) (%.3f, %.3f)", foveation_level_name(foveation_level_for(value)), static_cast<double>(p.gain),
        count, static_cast<double>(fx[0]), static_cast<double>(fy[0]), static_cast<double>(fx[1]),
        static_cast<double>(fy[1]));
  }
  fov_gain_ = p.gain;
}

Json XrSystem::debug_foveation() {
  Json j = Json::object();
  const uint32_t name = record_.u32(L::kColorTexture);
  j.set("image", static_cast<int64_t>(name));
  j.set("level", foveation_level_name(foveation_level_for(fov_value_ < 0 ? 0 : fov_value_)));
  j.set("gain", static_cast<double>(fov_gain_));
  j.set("applications", fov_applications_);
  if (name == 0) return j;
  // Only a current swapchain image is queried (a stale record name could be a deleted texture, which binding would
  // re-create), with its own target, and without glGetError: this runs in the page's WebGL context, whose driver
  // errors the WebGL binding reports to the page later (GL-9).
  uint32_t array = 0;
  bool live = false;
  {
    std::lock_guard<std::mutex> lock(sc_mu_);
    live = std::find(sc_names_.begin(), sc_names_.end(), name) != sc_names_.end();
    array = sc_array_;
  }
  if (!live) return j;
  FoveationQuery q = query_foveation(name, array >= 2 ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D, /*own_context=*/false);
  j.set("featureBits", static_cast<int64_t>(q.feature_bits));
  j.set("supported", static_cast<int64_t>(q.supported));
  j.set("minDensity", static_cast<double>(q.min_density));
  return j;
}

void XrSystem::js_fence_frame() {
  if (slot_.state() != FrameSlot::kRunning || js_fence_) return;
  js_apply_foveation();
  js_fence_ = gl_fence_and_flush();
}

void XrSystem::js_frame_finished(double js_ms, bool fence_created) {
  if (!fence_created && !js_fence_ && record_.u32(L::kColorTexture) != 0) {
    // The adapter did not fence (an exception before it got there): fence whatever context is current.
    js_fence_ = gl_fence_and_flush();
  }
  js_ms_ = js_ms;
  slot_.finish();
}

Json XrSystem::stats() {
  Json j = Json::object();
  if (!impl_) {
    j.set("available", false);
    return j;
  }
  Impl& x = *impl_;
  {
    std::lock_guard<std::mutex> lock(x.info_mu);
    j.set("available", x.info["available"].as_bool(false));
    j.set("runtime", x.runtime_name + " " + x.runtime_version);
  }
  std::lock_guard<std::mutex> lock(x.stats_mu);
  const Impl::Snapshot& s = x.snap;
  j.set("state", session_state_name(s.state));
  j.set("visibility", web_visibility(s.visibility));
  j.set("webxrSession", s.webxr);
  j.set("refreshRate", static_cast<double>(x.current_rate.load()));
  Json sc = Json::object();
  sc.set("width", static_cast<int64_t>(s.sc_w));
  sc.set("height", static_cast<int64_t>(s.sc_h));
  sc.set("arraySize", static_cast<int64_t>(s.sc_array));
  sc.set("format", s.sc_format);
  sc.set("images", static_cast<int64_t>(s.images));
  j.set("swapchain", sc);
  j.set("foveation", s.foveation);
  Json perf = Json::object();
  perf.set("cpu", perf_level_name(s.cpu));
  perf.set("gpu", perf_level_name(s.gpu));
  perf.set("raises", s.raises);
  perf.set("lowers", s.lowers);
  perf.set("runtimeNotifications", x.perf_events);
  j.set("perf", perf);
  Json frames = Json::object();
  frames.set("xr", x.xr_frames);
  frames.set("js", x.js_frames);
  frames.set("ticks", x.ticks);
  frames.set("cancelled", x.cancelled);
  frames.set("withdrawn", x.withdrawn);
  frames.set("untracked", x.untracked_frames);
  frames.set("late", x.late);
  frames.set("projection", x.projection_frames);
  frames.set("staleResubmits", x.stale_resubmits);
  // A session's frames without an app frame (a resume) that carried the opaque background instead of nothing.
  frames.set("covered", x.covered_frames);
  frames.set("missed", s.missed);
  j.set("frames", frames);
  // XR-LAYER-1: quad and cylinder layers: live swapchains, layers in the latest submitted frame, frames that had any.
  Json comp = x.comp_layers_json;
  comp.set("live", static_cast<int64_t>(s.layer_swapchains));
  comp.set("submitted", static_cast<int64_t>(s.layers_submitted));
  comp.set("framesWithLayers", s.frames_with_layers);
  j.set("layers", comp);
  Json timing = Json::object();  // means over the window since the previous stats call
  timing.set("waitMs", x.wait_ms.mean());
  timing.set("jsMs", x.js_ms.mean());
  timing.set("jsMaxMs", x.js_ms.max());
  timing.set("endMs", x.end_ms.mean());
  timing.set("frames", x.wait_ms.count());
  j.set("timing", timing);
  x.wait_ms.reset();
  x.js_ms.reset();
  x.end_ms.reset();
  Json boot = Json::object();
  boot.set("openxrReady", x.openxr_ready_ms);
  boot.set("xrSessionRunning", x.session_running_ms);
  boot.set("firstIdleFrame", x.first_idle_frame_ms);
  boot.set("firstLoadingFrame", x.first_loading_frame_ms);
  boot.set("firstVisibleLoadingFrame", x.first_visible_loading_ms);
  boot.set("sessionGranted", x.session_granted_ms);
  boot.set("firstXrFrame", x.first_js_frame_ms);
  boot.set("maxIdleGapMs", x.max_boot_gap_ms);
  j.set("boot", boot);
  // The loading screen (loading.h): its phase, what it shows and how long the last loading period lasted.
  Json loading = Json::object();
  loading.set("enabled", x.cfg->loading.enabled);
  loading.set("ready", x.loading_ready);
  loading.set("phase", loading_phase_name(x.loading_phase));
  loading.set("card", x.loading_card);
  // Behind the quads: "colour" (an opaque layer, black by default) or "passthrough" (a passthrough layer the runtime
  // submits); for a contextual config, whether this app can show passthrough and the system's recommendation at
  // launch (null: unknown or not asked).
  loading.set("background", loading_background_name(x.loading_bg_stat));
  loading.set("contextual", x.cfg->loading.contextual);
  loading.set("passthroughAvailable", x.pt_available_stat);
  if (x.pt_recommended_stat < 0) {
    loading.set("passthroughRecommended", Json());
  } else {
    loading.set("passthroughRecommended", x.pt_recommended_stat == 1);
  }
  loading.set("frames", x.loading_frames);
  loading.set("handovers", x.loading_handovers);
  loading.set("lastDurationMs", x.loading_last_ms);
  // Where the card was in the latest frame that showed it (absent: never shown, or head-locked without tracking).
  if (x.loading_anchor_known) {
    Json anchor = Json::object();
    anchor.set("yawDeg", x.loading_anchor_yaw_deg);
    anchor.set("pitchDeg", x.loading_anchor_pitch_deg);
    anchor.set("headPitchDeg", x.loading_head_pitch_deg);
    loading.set("anchor", anchor);
  }
  j.set("loading", loading);
  // XR-IDLE-3: the latest session, grant -> the first frame JS began (frame start, before the app's callbacks).
  Json session = Json::object();
  const double granted = session_granted_ms_.load(std::memory_order_relaxed);
  const double first = session_first_frame_ms_.load(std::memory_order_relaxed);
  session.set("grantedMs", granted);
  session.set("firstFrameMs", first);
  session.set("grantToFirstFrameMs", granted >= 0 && first >= 0 ? first - granted : -1.0);
  j.set("session", session);
  Json input = Json::object();
  input.set("left", s.profile[0]);
  input.set("right", s.profile[1]);
  input.set("leftMode", static_cast<int64_t>(s.mode[0]));
  input.set("rightMode", static_cast<int64_t>(s.mode[1]));
  input.set("handTracking", s.hand_tracking);
  j.set("input", input);
  j.set("neverOfferedErrors", x.never_offered_errors);
  return j;
}

}  // namespace iwn::xr
