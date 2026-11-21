// Eye-buffer screenshots for the debug endpoint's `shot` method (docs/spec/14 DBG-SHOT, REG-18: `screencap` is
// black during an immersive session, so the capture comes from the runtime).
//
// The XR thread captures the image of the next frame the app finished, after its glWaitSync on the app's fence
// and before xrReleaseSwapchainImage: the eye layer(s) are blitted into one RGBA8 (or sRGB, matching the swapchain
// format, so values are copied, never re-encoded) image of the requested eyes and scale, read into a pixel-pack
// buffer, and fenced. Later frames poll the fence, map the buffer, and hand the rows to an encoder thread that
// writes the PNG (top row first) and replies {png, width, height, frame}. The JS thread is never involved, and the
// readback never stalls a frame (DBG-7).
#pragma once

#include <GLES3/gl3.h>

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "iwn/core/json.h"

namespace iwn::xr {

class ShotCapture {
 public:
  using Reply = std::function<void(Json)>;

  ~ShotCapture();

  // Any thread: queue a request. `eye`: "left" | "right" | "both"; `scale` in (0, 1].
  void request(const std::string& eye, double scale, Reply reply);
  bool has_request();

  // XR thread, its context current: start the readback of `texture` (the app's finished image).
  void capture(GLuint texture, GLenum format, uint32_t width, uint32_t height, uint32_t array_size, uint64_t frame);
  // XR thread: answer the pending request with a black image (idle presentation: nothing is presented).
  void capture_black(uint32_t eye_width, uint32_t eye_height, uint64_t frame);
  // XR thread, every frame: collect finished readbacks.
  void poll();
  // XR thread at exit (context still current): drop GL objects, fail pending requests, join the encoder.
  void shutdown();

 private:
  struct Request {
    std::string eye;
    double scale = 1;
    Reply reply;
  };
  struct Readback {
    Reply reply;
    GLuint pbo = 0;
    GLsync fence = nullptr;
    uint32_t width = 0, height = 0;
    uint64_t frame = 0;
  };
  struct Job {
    Reply reply;
    std::vector<uint8_t> rgba;  // top row first
    uint32_t width = 0, height = 0;
    uint64_t frame = 0;
  };
  void encoder_main();
  void enqueue(Job job);

  std::mutex mu_;
  std::deque<Request> requests_;
  std::deque<Readback> inflight_;  // XR thread only
  GLuint read_fbo_ = 0, draw_fbo_ = 0, color_rb_ = 0;
  uint32_t rb_width_ = 0, rb_height_ = 0;
  GLenum rb_format_ = 0;

  std::mutex job_mu_;
  std::condition_variable job_cv_;
  std::deque<Job> jobs_;
  std::thread encoder_;
  bool stop_ = false;
};

}  // namespace iwn::xr
