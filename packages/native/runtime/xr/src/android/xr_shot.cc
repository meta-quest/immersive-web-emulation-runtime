#include "android/xr_shot.h"

#include <pthread.h>

#include <algorithm>
#include <cmath>
#include <cstring>

#include "iwn/core/log.h"
#include "iwn/core/text.h"
#include "iwn/xr/png.h"

namespace iwn::xr {

ShotCapture::~ShotCapture() {
  {
    std::lock_guard<std::mutex> lock(job_mu_);
    stop_ = true;
  }
  job_cv_.notify_all();
  if (encoder_.joinable()) encoder_.join();
}

void ShotCapture::request(const std::string& eye, double scale, Reply reply) {
  if (!(scale > 0)) scale = 1;
  if (scale > 1) scale = 1;
  std::string e = eye == "left" || eye == "right" ? eye : "both";
  std::lock_guard<std::mutex> lock(mu_);
  requests_.push_back({e, scale, std::move(reply)});
}

bool ShotCapture::has_request() {
  std::lock_guard<std::mutex> lock(mu_);
  return !requests_.empty();
}

void ShotCapture::capture(GLuint texture, GLenum format, uint32_t width, uint32_t height, uint32_t array_size,
                          uint64_t frame) {
  Request req;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (requests_.empty()) return;
    req = std::move(requests_.front());
    requests_.pop_front();
  }
  // Source rectangles: array swapchains hold one eye per layer; side-by-side images hold both halves.
  const bool array = array_size >= 2;
  const uint32_t eye_w = array ? width : width / 2;
  const bool both = req.eye == "both";
  const uint32_t out_w = std::max(1u, static_cast<uint32_t>(std::lround((both ? 2 : 1) * eye_w * req.scale)));
  const uint32_t out_h = std::max(1u, static_cast<uint32_t>(std::lround(height * req.scale)));
  const GLenum rb_format = format == GL_SRGB8_ALPHA8 ? GL_SRGB8_ALPHA8 : GL_RGBA8;

  if (!read_fbo_) glGenFramebuffers(1, &read_fbo_);
  if (!draw_fbo_) glGenFramebuffers(1, &draw_fbo_);
  if (!color_rb_ || rb_width_ != out_w || rb_height_ != out_h || rb_format_ != rb_format) {
    if (!color_rb_) glGenRenderbuffers(1, &color_rb_);
    glBindRenderbuffer(GL_RENDERBUFFER, color_rb_);
    glRenderbufferStorage(GL_RENDERBUFFER, rb_format, static_cast<GLsizei>(out_w), static_cast<GLsizei>(out_h));
    rb_width_ = out_w;
    rb_height_ = out_h;
    rb_format_ = rb_format;
  }
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, draw_fbo_);
  glFramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, color_rb_);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, read_fbo_);
  auto blit_eye = [&](int eye, int slot) {
    GLint sx0 = 0;
    if (array) {
      glFramebufferTextureLayer(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, texture, 0, eye);
    } else {
      glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
      sx0 = static_cast<GLint>(eye * eye_w);
    }
    const GLint per = static_cast<GLint>(both ? out_w / 2 : out_w);
    const GLint dx0 = slot * per;
    glBlitFramebuffer(sx0, 0, sx0 + static_cast<GLint>(eye_w), static_cast<GLint>(height), dx0, 0,
                      slot == 1 ? static_cast<GLint>(out_w) : dx0 + per, static_cast<GLint>(out_h),
                      GL_COLOR_BUFFER_BIT, req.scale < 1 ? GL_LINEAR : GL_NEAREST);
  };
  if (both) {
    blit_eye(0, 0);
    blit_eye(1, 1);
  } else {
    blit_eye(req.eye == "right" ? 1 : 0, 0);
  }
  glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);

  Readback rb;
  rb.reply = std::move(req.reply);
  rb.width = out_w;
  rb.height = out_h;
  rb.frame = frame;
  glGenBuffers(1, &rb.pbo);
  glBindBuffer(GL_PIXEL_PACK_BUFFER, rb.pbo);
  glBufferData(GL_PIXEL_PACK_BUFFER, static_cast<GLsizeiptr>(out_w) * out_h * 4, nullptr, GL_STREAM_READ);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, draw_fbo_);
  glReadBuffer(GL_COLOR_ATTACHMENT0);
  glPixelStorei(GL_PACK_ALIGNMENT, 4);
  glReadPixels(0, 0, static_cast<GLsizei>(out_w), static_cast<GLsizei>(out_h), GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
  glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  rb.fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
  glFlush();
  inflight_.push_back(std::move(rb));
}

void ShotCapture::capture_black(uint32_t eye_width, uint32_t eye_height, uint64_t frame) {
  Request req;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (requests_.empty()) return;
    req = std::move(requests_.front());
    requests_.pop_front();
  }
  const bool both = req.eye == "both";
  Job job;
  job.reply = std::move(req.reply);
  job.width = std::max(1u, static_cast<uint32_t>(std::lround((both ? 2 : 1) * eye_width * req.scale)));
  job.height = std::max(1u, static_cast<uint32_t>(std::lround(eye_height * req.scale)));
  job.frame = frame;
  job.rgba.assign(static_cast<size_t>(job.width) * job.height * 4, 0);
  for (size_t i = 3; i < job.rgba.size(); i += 4) job.rgba[i] = 255;  // opaque black
  enqueue(std::move(job));
}

void ShotCapture::poll() {
  while (!inflight_.empty()) {
    Readback& rb = inflight_.front();
    GLenum st = glClientWaitSync(rb.fence, 0, 0);
    if (st == GL_TIMEOUT_EXPIRED) return;
    glDeleteSync(rb.fence);
    Job job;
    job.reply = std::move(rb.reply);
    job.width = rb.width;
    job.height = rb.height;
    job.frame = rb.frame;
    const size_t row = static_cast<size_t>(rb.width) * 4;
    glBindBuffer(GL_PIXEL_PACK_BUFFER, rb.pbo);
    const void* p = st == GL_WAIT_FAILED ? nullptr
                                          : glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0,
                                                             static_cast<GLsizeiptr>(row * rb.height), GL_MAP_READ_BIT);
    if (p) {
      job.rgba.resize(row * rb.height);
      const uint8_t* src = static_cast<const uint8_t*>(p);
      for (uint32_t y = 0; y < rb.height; ++y) {  // GL rows are bottom-up; PNG is top row first
        std::memcpy(&job.rgba[static_cast<size_t>(y) * row], src + static_cast<size_t>(rb.height - 1 - y) * row, row);
      }
      glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
    }
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    glDeleteBuffers(1, &rb.pbo);
    inflight_.pop_front();
    if (job.rgba.empty()) {
      Json err = Json::object();
      err.set("error", "shot: reading the eye buffer failed");
      if (job.reply) job.reply(std::move(err));
      continue;
    }
    enqueue(std::move(job));
  }
}

void ShotCapture::enqueue(Job job) {
  {
    std::lock_guard<std::mutex> lock(job_mu_);
    if (stop_) {
      Json err = Json::object();
      err.set("error", "shot: runtime shutting down");
      if (job.reply) job.reply(std::move(err));
      return;
    }
    jobs_.push_back(std::move(job));
    if (!encoder_.joinable()) encoder_ = std::thread([this] { encoder_main(); });
  }
  job_cv_.notify_one();
}

void ShotCapture::encoder_main() {
  pthread_setname_np(pthread_self(), "iwn-xr-shot");
  for (;;) {
    Job job;
    {
      std::unique_lock<std::mutex> lock(job_mu_);
      job_cv_.wait(lock, [this] { return stop_ || !jobs_.empty(); });
      if (jobs_.empty()) return;
      job = std::move(jobs_.front());
      jobs_.pop_front();
    }
    std::vector<uint8_t> png = encode_png_rgba(job.rgba.data(), job.width, job.height, job.width * 4, 1);
    Json result = Json::object();
    if (png.empty()) {
      result.set("error", "shot: PNG encoding failed");
    } else {
      result.set("png", base64_encode(png.data(), png.size()));
      result.set("width", static_cast<int64_t>(job.width));
      result.set("height", static_cast<int64_t>(job.height));
      result.set("frame", static_cast<uint64_t>(job.frame));
    }
    if (job.reply) job.reply(std::move(result));
  }
}

void ShotCapture::shutdown() {
  for (Readback& rb : inflight_) {
    if (rb.fence) glDeleteSync(rb.fence);
    if (rb.pbo) glDeleteBuffers(1, &rb.pbo);
    Json err = Json::object();
    err.set("error", "shot: runtime shutting down");
    if (rb.reply) rb.reply(std::move(err));
  }
  inflight_.clear();
  if (read_fbo_) glDeleteFramebuffers(1, &read_fbo_);
  if (draw_fbo_) glDeleteFramebuffers(1, &draw_fbo_);
  if (color_rb_) glDeleteRenderbuffers(1, &color_rb_);
  read_fbo_ = draw_fbo_ = color_rb_ = 0;
  std::deque<Request> pending;
  {
    std::lock_guard<std::mutex> lock(mu_);
    pending.swap(requests_);
  }
  for (Request& r : pending) {
    Json err = Json::object();
    err.set("error", "shot: runtime shutting down");
    if (r.reply) r.reply(std::move(err));
  }
  {
    std::lock_guard<std::mutex> lock(job_mu_);
    stop_ = true;
  }
  job_cv_.notify_all();
  if (encoder_.joinable()) encoder_.join();
}

}  // namespace iwn::xr
