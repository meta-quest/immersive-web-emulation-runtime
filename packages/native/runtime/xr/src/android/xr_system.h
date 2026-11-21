// The XR system (Android): one OpenXR instance and session for the process, owned by a dedicated XR thread
// ("iwn-xr"), and the frame protocol with the main JS thread. Spec: docs/spec/08 (XR-*), 09 (XRF-*), 10 (IN-*).
//
// Threads (PROC-1, XR-IDLE-1, CDP-7):
//   iwn-xr   all OpenXR calls, its own EGL context (egl_xr.h). Loop: poll events -> xrWaitFrame -> xrBeginFrame ->
//            [WebXR frame: acquire + wait the swapchain image, locate views/LOCAL/VIEW/input for the predicted
//            display time, write the frame record, hand the frame to JS and wait for it up to a deadline] or
//            [idle presentation: post a window-rAF tick] -> glWaitSync on the JS fence -> release -> xrEndFrame.
//            It never waits for the JS thread longer than the deadline: a long task or a debugger pause gets
//            frames that re-submit the last finished image (re-projected by the compositor), and the idle
//            presentation keeps running during boot's long module compile.
//   iwn-js   runs the frame JS through the core's FramePump (xr_binding.cc): IWER host mode reads the record in
//            place, the app renders into the swapchain image through the session's opaque texture, then the
//            runtime fences the WebGL context and signals the XR thread.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "android/xr_layers.h"
#include "iwn/core/asset_source.h"
#include "iwn/core/json.h"
#include "iwn/xr/frame_record.h"
#include "iwn/xr/handoff.h"
#include "iwn/xr/xr_config.h"

namespace iwn {
class Runtime;
}

namespace iwn::xr {

class XrScene;

struct SwapchainRequest {
  uint32_t array_size = 2;  // 2: texture-array (multiview), 1: both eyes side by side
  double scale = 1.0;
  uint32_t format = 0x8058;  // GL_RGBA8
  double foveation = -1;     // < 0: none requested
  bool passthrough = false;  // immersive-ar
  bool unpremultiplied = false;
};

struct SwapchainAnswer {
  bool ok = false;
  std::string error;
  uint32_t width = 0, height = 0, array_size = 0;
  std::vector<float> rates;
  float rate = 0;
  bool has_stage = false;
  float stage_width = 0, stage_depth = 0;
  double foveation = -1;  // applied level, < 0 when foveation is unavailable
};

// Runtime events for the WebXR session, delivered to JS in order, before the frame that reflects them.
struct XrEvent {
  enum Type { kVisibility, kFrameRate, kReferenceSpaceReset, kSessionEnd, kRunning } type;
  bool visible = false;
  bool focused = false;
  float rate = 0;
  bool running = false;
};

class XrSystem {
 public:
  static XrSystem& get();

  // --- lifetime (JS thread) ---
  // Starts the XR thread for a Runtime (once per runtime instance: an activity relaunched in the same process gets a
  // new Runtime and a new XR thread, OpenXR instance and session). `debuggable`: honour debug switches;
  // `debug_endpoint`: the inspector or the debug endpoint is served (XR-LIFE-7 never exits then).
  // `loading_image`: the splash image's file (config xr.loading.image), decoded off the XR thread for the loading
  // screen (null: spinner only).
  void start(Runtime* rt, const XrConfig& config, bool debuggable, bool debug_endpoint,
             std::shared_ptr<AssetBytes> loading_image = nullptr);
  // Shutdown hook (PROC-7): ends everything, joins the XR thread and makes the system ready for the next start().
  void stop();
  bool started() const { return started_; }
  // The OpenXR session is FOCUSED (the app has the input focus; a system dialog takes it). Any thread.
  bool focused() const;
  // Waits until OpenXR initialisation finished (true when an XR session exists).
  bool wait_initialized(int timeout_ms);

  // --- JS-thread API (xr_binding.cc) ---
  Json info();
  SwapchainAnswer begin_swapchain(const SwapchainRequest& request);
  // Quad and cylinder layers (XR-LAYER-1, xr_layers.h): a swapchain per layer, its destruction, and an image for a
  // layer the page draws in the frame it created it in. layer_words(): the buffer shared with the adapter
  // (iwn/xr/layers.h), alive for the process.
  LayerSwapchainAnswer begin_layer_swapchain(const LayerSwapchainRequest& request);
  void destroy_layer_swapchain(uint32_t id);
  uint32_t acquire_layer_image(uint32_t id);
  uint32_t* layer_words() { return layer_words_; }
  void end_webxr_session();
  bool request_frame_rate(float hz);
  void set_foveation(double level);
  void set_passthrough_visible(bool visible);
  void haptic(int hand, float intensity, double duration_ms, float frequency_hz);
  void notify_session_started(bool immersive_ar, bool hand_tracking, bool planes, bool meshes);
  void notify_offered();
  // Every offerSession()/requestSession() the page still had pending was rejected and no session exists.
  void notify_offer_rejected();
  void notify_entry_evaluated();
  // A new page context replaced the old one (location.reload(), PROC-8): the session-lifetime timers start over for
  // it (XR-LIFE-5/7). Call after end_webxr_session() for the old page.
  void notify_page_started();
  void request_shot(const std::string& eye, double scale, std::function<void(Json)> reply);
  bool explicit_grant() const { return config_.explicit_grant; }
  // Moves pending events into `out`; false when there were none (no allocation then).
  bool take_events(std::vector<XrEvent>* out);
  Json stats();
  // The scene model (xr_scene.h; null before start()). want_scene(): a session wants scene data, so the XR thread
  // queries the room (once per session).
  XrScene* scene();
  void want_scene();
  // Diagnostics: QCOM texture-foveation state of the current image in the JS thread's current GL context, and the
  // parameters the runtime last applied from that context.
  Json debug_foveation();

  // --- JS frame protocol (JS thread) ---
  enum class Pending { kNone, kXrFrame, kTick };
  // Something for the JS thread: a posted XR frame, a window-rAF tick or events.
  bool js_work_pending() const {
    return pending_frame_.load(std::memory_order_acquire) || pending_tick_.load(std::memory_order_acquire) ||
           events_pending_.load(std::memory_order_acquire);
  }
  // Takes the pending XR frame (then call slot().begin()) or tick; `start_ms` gets the frame's start time.
  Pending take_pending(double* start_ms, double* period_ms);
  FrameSlot& slot() { return slot_; }
  FrameRecord& record() { return record_; }
  // The JS thread's current WebGL context finished the frame: fence + flush (called by the adapter through
  // xr.endFrameGL(), with the session's GL context made current first).
  void js_fence_frame();
  // The JS frame is over (after the adapter returned): signals the XR thread.
  void js_frame_finished(double js_ms, bool fence_created);
  // The JS thread began a posted XR frame (XR-IDLE-3: grant -> first frame of the session).
  void js_frame_begun() {
    if (session_first_frame_pending_.exchange(false, std::memory_order_relaxed)) {
      session_first_frame_ms_.store(now_ms_(), std::memory_order_relaxed);
    }
  }
  void set_want_ticks(bool want) { want_ticks_.store(want, std::memory_order_relaxed); }
  void set_js_wake(std::function<void()> wake);

 private:
  XrSystem() = default;
  struct Impl;
  void thread_main();
  // JS thread, the session's WebGL context current: QCOM foveation parameters for the swapchain images (see
  // "Foveation" in xr_system.cc).
  void js_apply_foveation();

  Runtime* rt_ = nullptr;
  XrConfig config_;
  bool debuggable_ = false;
  bool debug_endpoint_ = false;
  bool started_ = false;
  // An XR thread that did not stop in time was left running (stop()); its state cannot be reused, so XR stays off
  // until the process restarts.
  bool zombie_ = false;
  std::thread thread_;
  std::unique_ptr<Impl> impl_;

  FrameRecord record_;
  FrameSlot slot_;
  uint32_t layer_words_[layers::kWords] = {};
  CommandQueue commands_;
  std::atomic<bool> pending_frame_{false};
  std::atomic<bool> pending_tick_{false};
  std::atomic<double> tick_start_ms_{0};
  std::atomic<double> tick_period_ms_{0};
  std::atomic<bool> events_pending_{false};
  std::atomic<bool> want_ticks_{false};
  std::mutex events_mu_;
  std::vector<XrEvent> events_;
  std::mutex wake_mu_;
  std::function<void()> js_wake_;
  // written by the JS thread between begin() and finish(), read by the XR thread after kDone
  void* js_fence_ = nullptr;
  double js_ms_ = 0;
  // The current swapchain's image names for the JS thread (published by the XR thread when it creates or destroys
  // the swapchain; the serial changes each time).
  std::mutex sc_mu_;
  std::vector<uint32_t> sc_names_;
  uint32_t sc_array_ = 0;
  std::atomic<uint32_t> sc_serial_{0};
  // The latest WebXR session: when it was granted and when JS began its first frame (performance.now() ms).
  std::atomic<bool> session_first_frame_pending_{false};
  std::atomic<double> session_granted_ms_{-1};
  std::atomic<double> session_first_frame_ms_{-1};
  static double now_ms_();
  // JS thread: the fixed-foveation level (FoveationLevel) last asked of the XR thread for the current swapchain.
  int fov_requested_ = -1;
  // JS thread: what js_apply_foveation last applied.
  uint32_t fov_serial_ = 0;
  uint32_t fov_enabled_serial_ = 0;  // the swapchain whose images have the QCOM feature enabled from the JS side
  int fov_focal_points_ = 1;         // focal points per layer the driver offers (queried for side-by-side images)
  float fov_value_ = -1;
  float fov_gain_ = 0;
  double fov_refresh_ms_ = 0;
  uint64_t fov_applications_ = 0;
  friend struct Impl;
};

}  // namespace iwn::xr
