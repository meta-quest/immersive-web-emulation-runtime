// The passthrough cameras for getUserMedia (XR-CAM-1): Camera2 NDK (ACameraManager) on the cameras Horizon OS marks
// as passthrough cameras, an AImageReader of YUV_420_888 images, each converted to RGBA8 on the reader's thread into
// an image-module PixelStore (runtime/image INTEROP.md), which texImage2D / drawImage then use like a decoded image.
// The stores are AHardwareBuffers, so texImage2D copies a frame on the GPU (runtime/gl gl_image.cc).
// No GL here, no OpenXR: the camera runs whether or not a session does.
//
// Threads: open/close run in order on one worker thread (opening a camera takes tens of milliseconds and must not
// stall the JS thread); frames arrive on the reader's own thread; latest() and the listener's consumer are on the JS
// thread. A stream that the system takes away (onDisconnected / onError: another open of the same camera, or the
// app left in the background for about a minute) ends, and the listener hears of it; web/xr closes its streams while
// the page is hidden and opens them again when it is visible, so the latter does not happen to it.
//
// Sources: Android NDK camera (NdkCameraManager.h, NdkCameraDevice.h, NdkCameraCaptureSession.h,
// NdkCameraMetadataTags.h), media (NdkImageReader.h, NdkImage.h); Horizon OS Passthrough Camera API (vendor tags in
// iwn/xr/camera_convert.h; permissions android.permission.CAMERA + horizonos.permission.HEADSET_CAMERA, without
// which ACameraManager_openCamera returns ACAMERA_ERROR_PERMISSION_DENIED).
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/image/pixels.h"
#include "iwn/xr/camera_convert.h"

namespace iwn::xr {

struct CameraDeviceInfo {
  std::string id;
  std::string label;
  int position = -1;  // 0 left, 1 right passthrough camera; -1 not a Horizon OS passthrough camera
  LensFacing facing = LensFacing::kExternal;
  std::vector<std::pair<int, int>> sizes;       // YUV_420_888 output sizes
  std::vector<std::pair<int, int>> frame_rates;  // AE target fps ranges (min, max)
};

struct CameraOpenResult {
  int stream = 0;          // > 0 on success
  std::string error;       // DOMException name on failure: NotAllowedError, NotFoundError, NotReadableError
  std::string message;
  int width = 0;
  int height = 0;
  int frame_rate = 0;
};

struct CameraFrame {
  std::shared_ptr<const image::PixelStore> store;
  uint64_t serial = 0;        // 1 for the first frame
  int64_t timestamp_ns = 0;   // sensor timestamp (AImage_getTimestamp)
};

class CameraService {
 public:
  static CameraService& get();

  // Whether the app holds the camera permissions: CAMERA, and on Horizon OS HEADSET_CAMERA (checkSelfPermission, no
  // dialog; any thread). Until then nothing here touches Camera2: Horizon OS fixes a process's camera list when its
  // camera manager first reads it, without the passthrough cameras for an app that lacks HEADSET_CAMERA, so a list read
  // before the grant would stay empty after it (until the app restarts).
  bool permitted();
  // The passthrough cameras (or, on another Android headset, every camera with YUV output). Any thread. Empty until
  // permitted(). `hidden` (optional): set when the cameras are withheld (the camera permissions are not granted).
  std::vector<CameraDeviceInfo> devices(bool* hidden = nullptr);
  // Opens camera `id` at width x height (one of its sizes) and `fps` (one of its ranges' max) on the worker thread;
  // `done` runs on that thread. Fails with NotAllowedError until permitted(), and with AbortError once shutdown() began.
  void open(const std::string& id, int width, int height, int fps, std::function<void(CameraOpenResult)> done);
  // The newest frame of `stream`; false before its first frame or for an unknown stream.
  bool latest(int stream, CameraFrame* out);
  // Stops and releases `stream` (on the worker thread; returns at once). Unknown ids are ignored.
  void close(int stream);
  // Stops every stream and waits for the worker (shutdown): opens still queued fail without opening a camera, and one
  // that was already opening is closed once the worker is done.
  void shutdown();
  // Called on the reader thread for every new frame (ended = false) and once when a stream ends by itself.
  void set_listener(std::function<void(int stream, bool ended)> listener);
  Json stats();

  struct Impl;

 private:
  CameraService();
  Impl* impl_;
};

}  // namespace iwn::xr
