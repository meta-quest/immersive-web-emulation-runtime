#include "android/xr_camera.h"

#include <camera/NdkCameraCaptureSession.h>
#include <camera/NdkCameraDevice.h>
#include <camera/NdkCameraManager.h>
#include <camera/NdkCameraMetadata.h>
#include <camera/NdkCameraMetadataTags.h>
#include <media/NdkImage.h>
#include <media/NdkImageReader.h>
#include <sys/system_properties.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <thread>

#include "android/xr_permissions.h"
#include "iwn/core/clock.h"
#include "iwn/core/log.h"

namespace iwn::xr {

namespace {

using iwn::LogLevel;

// Stores per stream. A store is rewritten only when nothing else holds it (not `latest`, not a page handle), and then
// the one released longest ago: with all four rotating, a store the page let go of is rewritten about three camera
// frames later, which leaves a GPU copy queued from it (texImage2D, runtime/gl gl_image.cc) time to run first. Pages
// that keep a frame (createImageBitmap, a clone, a transfer) get a copy (PixelStore::recycled), so they never pin a
// store.
constexpr size_t kPoolSize = 4;
constexpr int32_t kReaderImages = 3;
constexpr uint64_t kLogEveryFrames = 300;  // a progress line every ~10 s at 30 Hz

struct Stream {
  int id = 0;
  // pool[i] was last written with frame written[i] (0: never)
  std::vector<uint64_t> written;
  std::string camera;
  int width = 0;
  int height = 0;
  int fps = 0;
  ACameraDevice* device = nullptr;
  AImageReader* reader = nullptr;
  ANativeWindow* window = nullptr;
  ACaptureSessionOutputContainer* outputs = nullptr;
  ACaptureSessionOutput* output = nullptr;
  ACameraOutputTarget* target = nullptr;
  ACaptureRequest* request = nullptr;
  ACameraCaptureSession* session = nullptr;
  std::atomic<bool> ended{false};
  // AImageReader_delete holds the reader's lock while it waits for a running image callback, and the callback takes
  // that lock to acquire or delete its image: a deadlock. release() sets `closing` and waits for `in_image` to drain
  // before deleting the reader; a callback that starts after that returns without touching the reader.
  std::atomic<bool> closing{false};
  std::atomic<int> in_image{0};

  std::mutex mu;  // pool, latest, counters
  std::vector<std::shared_ptr<image::PixelStore>> pool;
  std::shared_ptr<image::PixelStore> latest;
  uint64_t serial = 0;
  int64_t timestamp_ns = 0;
  double opened_ms = 0;
  double first_frame_ms = 0;
  double convert_ms_total = 0;
  double convert_ms_max = 0;
  uint64_t dropped = 0;  // frames without a free store
};

const char* camera_status_name(camera_status_t s) {
  switch (s) {
    case ACAMERA_OK: return "ok";
    case ACAMERA_ERROR_INVALID_PARAMETER: return "invalid parameter";
    case ACAMERA_ERROR_CAMERA_DISCONNECTED: return "camera disconnected";
    case ACAMERA_ERROR_NOT_ENOUGH_MEMORY: return "not enough memory";
    case ACAMERA_ERROR_METADATA_NOT_FOUND: return "metadata not found";
    case ACAMERA_ERROR_CAMERA_DEVICE: return "camera device error";
    case ACAMERA_ERROR_CAMERA_SERVICE: return "camera service error";
    case ACAMERA_ERROR_SESSION_CLOSED: return "session closed";
    case ACAMERA_ERROR_INVALID_OPERATION: return "invalid operation";
    case ACAMERA_ERROR_STREAM_CONFIGURE_FAIL: return "stream configuration failed";
    case ACAMERA_ERROR_CAMERA_IN_USE: return "camera in use";
    case ACAMERA_ERROR_MAX_CAMERA_IN_USE: return "too many cameras in use";
    case ACAMERA_ERROR_CAMERA_DISABLED: return "camera disabled";
    case ACAMERA_ERROR_PERMISSION_DENIED: return "permission denied";
    case ACAMERA_ERROR_UNSUPPORTED_OPERATION: return "unsupported operation";
    default: return "camera error";
  }
}

// Horizon OS hides its cameras' vendor tags (and the passthrough cameras themselves) until HEADSET_CAMERA is granted;
// without the tags its other cameras (the avatar camera) look like plain ones, and must not be offered either.
bool is_horizon_os() {
  static const bool horizon = [] {
    char v[PROP_VALUE_MAX] = {};
    __system_property_get("ro.product.manufacturer", v);
    std::string m(v);
    for (char& c : m) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return m.find("oculus") != std::string::npos || m.find("meta") != std::string::npos;
  }();
  return horizon;
}

int meta_u8(const ACameraMetadata* meta, uint32_t tag, int def) {
  ACameraMetadata_const_entry e{};
  if (ACameraMetadata_getConstEntry(meta, tag, &e) != ACAMERA_OK || e.count < 1) return def;
  return e.data.u8[0];
}

}  // namespace

struct CameraService::Impl {
  ACameraManager* manager = nullptr;
  std::mutex mu;  // streams, listener, next_id, counters, shutting_down
  std::map<int, std::shared_ptr<Stream>> streams;
  std::function<void(int, bool)> listener;
  int next_id = 1;
  uint64_t opened = 0;
  uint64_t failed = 0;
  bool shutting_down = false;  // from shutdown() until it returns: opens fail

  // The worker: open/close in order.
  std::mutex qmu;
  std::condition_variable qcv;
  std::deque<std::function<void()>> queue;
  std::thread worker;
  bool stopping = false;

  void post(std::function<void()> fn) {
    std::lock_guard<std::mutex> lock(qmu);
    if (!worker.joinable()) {
      stopping = false;
      worker = std::thread([this] { run(); });
    }
    queue.push_back(std::move(fn));
    qcv.notify_one();
  }

  void run() {
    for (;;) {
      std::function<void()> fn;
      {
        std::unique_lock<std::mutex> lock(qmu);
        qcv.wait(lock, [this] { return stopping || !queue.empty(); });
        if (queue.empty()) return;  // stopping, and every queued job ran
        fn = std::move(queue.front());
        queue.pop_front();
      }
      fn();
    }
  }

  std::once_flag manager_once;
  ACameraManager* mgr() {
    std::call_once(manager_once, [this] { manager = ACameraManager_create(); });
    return manager;
  }

  void notify(int id, bool ended) {
    std::function<void(int, bool)> l;
    {
      std::lock_guard<std::mutex> lock(mu);
      l = listener;
    }
    if (l) l(id, ended);
  }

  // --- the reader thread --------------------------------------------------------------------------------------------

  static void on_image(void* ctx, AImageReader* reader) {
    auto* s = static_cast<Stream*>(ctx);
    s->in_image.fetch_add(1);
    struct InImage {
      Stream* s;
      ~InImage() { s->in_image.fetch_sub(1); }
    } in_image{s};
    if (s->closing.load()) return;
    AImage* img = nullptr;
    if (AImageReader_acquireLatestImage(reader, &img) != AMEDIA_OK || !img) return;
    int32_t w = 0, h = 0;
    AImage_getWidth(img, &w);
    AImage_getHeight(img, &h);
    int64_t ts = 0;
    AImage_getTimestamp(img, &ts);
    YuvPlanes p;
    uint8_t* data = nullptr;
    int len = 0;
    int32_t ystride = 0, uvstride = 0, uvpixel = 0;
    bool ok = w > 0 && h > 0;
    ok = ok && AImage_getPlaneData(img, 0, &data, &len) == AMEDIA_OK && AImage_getPlaneRowStride(img, 0, &ystride) == AMEDIA_OK;
    p.y = data;
    ok = ok && AImage_getPlaneData(img, 1, &data, &len) == AMEDIA_OK;
    p.u = data;
    ok = ok && AImage_getPlaneData(img, 2, &data, &len) == AMEDIA_OK;
    p.v = data;
    ok = ok && AImage_getPlaneRowStride(img, 1, &uvstride) == AMEDIA_OK &&
         AImage_getPlanePixelStride(img, 1, &uvpixel) == AMEDIA_OK;
    if (!ok) {
      AImage_delete(img);
      return;
    }
    p.y_row_stride = ystride;
    p.uv_row_stride = uvstride;
    p.uv_pixel_stride = uvpixel;

    std::shared_ptr<image::PixelStore> store;
    size_t slot = 0;
    {
      std::lock_guard<std::mutex> lock(s->mu);
      if (s->pool.size() >= kPoolSize) {
        uint64_t oldest = UINT64_MAX;
        for (size_t i = 0; i < s->pool.size(); ++i) {
          auto& candidate = s->pool[i];
          // only the pool holds it (not `latest`, not a page handle), and it was written longest ago
          if (candidate.use_count() == 1 && candidate->width() == static_cast<uint32_t>(w) &&
              candidate->height() == static_cast<uint32_t>(h) && s->written[i] < oldest) {
            oldest = s->written[i];
            store = candidate;
            slot = i;
          }
        }
      } else {
        // AHardwareBuffer-backed, so the WebGL binding copies frames on the GPU (runtime/gl gl_image.cc); heap memory
        // if that allocation fails (then uploads go through the CPU), and in the host tests.
#if defined(__ANDROID__)
        std::unique_ptr<image::PixelStore> made = image::PixelStore::AllocateHardwareBuffer(w, h);
        if (!made && s->pool.empty()) iwn::log(LogLevel::kWarn, "camera: no AHardwareBuffer for %dx%d frames: heap", w, h);
#else
        std::unique_ptr<image::PixelStore> made;
#endif
        if (!made) made = image::PixelStore::AllocateHeap(w, h);
        std::shared_ptr<image::PixelStore> fresh(made.release());
        if (fresh) {
          fresh->set_alpha(image::AlphaMode::kUnpremultiplied);
          fresh->set_opaque(true);
          fresh->set_recycled(true);  // rewritten in place: whatever keeps a frame takes a copy (pixels.h)
          s->pool.push_back(fresh);
          s->written.push_back(0);
          slot = s->pool.size() - 1;
          store = fresh;
        }
      }
      if (!store) s->dropped++;
    }
    if (!store) {
      AImage_delete(img);
      return;
    }
    const double t0 = iwn::now_ms();
    image::MutablePixelView out = store->LockWrite();
    if (out.data) yuv420_to_rgba(p, w, h, out.data, out.stride);
    store->UnlockWrite();
    AImage_delete(img);
    const double t1 = iwn::now_ms();
    {
      std::lock_guard<std::mutex> lock(s->mu);
      s->latest = store;
      s->serial++;
      s->written[slot] = s->serial;
      s->timestamp_ns = ts;
      if (s->serial == 1) s->first_frame_ms = t1;
      s->convert_ms_total += t1 - t0;
      s->convert_ms_max = std::max(s->convert_ms_max, t1 - t0);
      if (s->serial % kLogEveryFrames == 0) {
        iwn::log(LogLevel::kInfo, "camera: stream %d: %llu frames, %.1f fps, convert avg %.2f ms (max %.2f), %llu dropped",
                 s->id, static_cast<unsigned long long>(s->serial),
                 static_cast<double>(s->serial - 1) * 1000.0 / std::max(1.0, t1 - s->first_frame_ms),
                 s->convert_ms_total / static_cast<double>(s->serial), s->convert_ms_max,
                 static_cast<unsigned long long>(s->dropped));
      }
    }
    CameraService::get().impl_->notify(s->id, false);
  }

  static void on_disconnected(void* ctx, ACameraDevice*) { end_stream(static_cast<Stream*>(ctx), "disconnected"); }
  static void on_error(void* ctx, ACameraDevice*, int error) {
    iwn::log(LogLevel::kWarn, "camera: device error %d", error);
    end_stream(static_cast<Stream*>(ctx), "device error");
  }
  static void end_stream(Stream* s, const char* why) {
    if (s->ended.exchange(true)) return;
    iwn::log(LogLevel::kInfo, "camera: stream %d (camera %s) ended: %s", s->id, s->camera.c_str(), why);
    CameraService::get().impl_->notify(s->id, true);
  }
  static void on_session_closed(void*, ACameraCaptureSession*) {}
  static void on_session_ready(void*, ACameraCaptureSession*) {}
  static void on_session_active(void*, ACameraCaptureSession*) {}

  // --- the worker thread --------------------------------------------------------------------------------------------

  // Opens `s` (filled with camera/width/height/fps); on failure releases what it made and returns the status.
  camera_status_t start(Stream* s, std::string* what) {
    static ACameraDevice_StateCallbacks device_cbs{nullptr, on_disconnected, on_error};
    ACameraDevice_StateCallbacks cbs = device_cbs;
    cbs.context = s;
    camera_status_t st = ACameraManager_openCamera(mgr(), s->camera.c_str(), &cbs, &s->device);
    if (st != ACAMERA_OK) {
      *what = "ACameraManager_openCamera";
      return st;
    }
    if (AImageReader_new(s->width, s->height, AIMAGE_FORMAT_YUV_420_888, kReaderImages, &s->reader) != AMEDIA_OK ||
        AImageReader_getWindow(s->reader, &s->window) != AMEDIA_OK) {
      *what = "AImageReader_new";
      return ACAMERA_ERROR_NOT_ENOUGH_MEMORY;
    }
    AImageReader_ImageListener listener{s, on_image};
    AImageReader_setImageListener(s->reader, &listener);
    if ((st = ACaptureSessionOutputContainer_create(&s->outputs)) != ACAMERA_OK ||
        (st = ACaptureSessionOutput_create(s->window, &s->output)) != ACAMERA_OK ||
        (st = ACaptureSessionOutputContainer_add(s->outputs, s->output)) != ACAMERA_OK ||
        (st = ACameraOutputTarget_create(s->window, &s->target)) != ACAMERA_OK ||
        (st = ACameraDevice_createCaptureRequest(s->device, TEMPLATE_RECORD, &s->request)) != ACAMERA_OK ||
        (st = ACaptureRequest_addTarget(s->request, s->target)) != ACAMERA_OK) {
      *what = "capture request";
      return st;
    }
    const int32_t range[2] = {s->fps, s->fps};
    ACaptureRequest_setEntry_i32(s->request, ACAMERA_CONTROL_AE_TARGET_FPS_RANGE, 2, range);
    static ACameraCaptureSession_stateCallbacks session_cbs{nullptr, on_session_closed, on_session_ready,
                                                            on_session_active};
    if ((st = ACameraDevice_createCaptureSession(s->device, s->outputs, &session_cbs, &s->session)) != ACAMERA_OK) {
      *what = "ACameraDevice_createCaptureSession";
      return st;
    }
    if ((st = ACameraCaptureSession_setRepeatingRequest(s->session, nullptr, 1, &s->request, nullptr)) != ACAMERA_OK) {
      *what = "ACameraCaptureSession_setRepeatingRequest";
      return st;
    }
    return ACAMERA_OK;
  }

  static void release(Stream* s) {
    if (s->session) {
      ACameraCaptureSession_stopRepeating(s->session);
      ACameraCaptureSession_close(s->session);
      s->session = nullptr;
    }
    if (s->device) {
      ACameraDevice_close(s->device);
      s->device = nullptr;
    }
    if (s->request) {
      ACaptureRequest_free(s->request);
      s->request = nullptr;
    }
    if (s->target) {
      ACameraOutputTarget_free(s->target);
      s->target = nullptr;
    }
    if (s->outputs) {
      if (s->output) ACaptureSessionOutputContainer_remove(s->outputs, s->output);
      ACaptureSessionOutputContainer_free(s->outputs);
      s->outputs = nullptr;
    }
    if (s->output) {
      ACaptureSessionOutput_free(s->output);
      s->output = nullptr;
    }
    if (s->reader) {
      // Deleting the reader waits for a running image callback (under the reader's lock: see Stream::closing) and
      // releases the window.
      s->closing.store(true);
      while (s->in_image.load() > 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
      AImageReader_delete(s->reader);
      s->reader = nullptr;
      s->window = nullptr;
    }
  }
};

CameraService& CameraService::get() {
  static CameraService* s = new CameraService();
  return *s;
}

CameraService::CameraService() : impl_(new Impl()) {}

bool CameraService::permitted() {
  static const std::vector<std::string> kHorizon = {"android.permission.CAMERA", "horizonos.permission.HEADSET_CAMERA"};
  static const std::vector<std::string> kAndroid = {"android.permission.CAMERA"};
  const std::vector<bool> held = PermissionBroker::get().check(is_horizon_os() ? kHorizon : kAndroid);
  return std::all_of(held.begin(), held.end(), [](bool h) { return h; });
}

std::vector<CameraDeviceInfo> CameraService::devices(bool* hidden) {
  if (hidden) *hidden = false;
  std::vector<CameraDeviceInfo> out;
  std::vector<CameraDeviceInfo> others;
  if (!permitted()) {
    if (hidden) *hidden = true;  // and no camera manager yet, so the list read after the grant is complete
    return out;
  }
  ACameraManager* m = impl_->mgr();
  if (!m) return out;
  ACameraIdList* ids = nullptr;
  if (ACameraManager_getCameraIdList(m, &ids) != ACAMERA_OK || !ids) return out;
  for (int i = 0; i < ids->numCameras; ++i) {
    ACameraMetadata* meta = nullptr;
    if (ACameraManager_getCameraCharacteristics(m, ids->cameraIds[i], &meta) != ACAMERA_OK || !meta) continue;
    CameraDeviceInfo d;
    d.id = ids->cameraIds[i];
    const int source = meta_u8(meta, kMetaCameraSourceTag, -1);
    d.position = source == kCameraSourcePassthrough ? meta_u8(meta, kMetaCameraPositionTag, -1) : -1;
    d.facing = static_cast<LensFacing>(meta_u8(meta, ACAMERA_LENS_FACING, static_cast<int>(LensFacing::kExternal)));
    ACameraMetadata_const_entry e{};
    if (ACameraMetadata_getConstEntry(meta, ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS, &e) == ACAMERA_OK) {
      for (uint32_t k = 0; k + 3 < e.count; k += 4) {
        if (e.data.i32[k] == AIMAGE_FORMAT_YUV_420_888 &&
            e.data.i32[k + 3] == ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS_OUTPUT) {
          d.sizes.emplace_back(e.data.i32[k + 1], e.data.i32[k + 2]);
        }
      }
    }
    if (ACameraMetadata_getConstEntry(meta, ACAMERA_CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES, &e) == ACAMERA_OK) {
      for (uint32_t k = 0; k + 1 < e.count; k += 2) d.frame_rates.emplace_back(e.data.i32[k], e.data.i32[k + 1]);
    }
    ACameraMetadata_free(meta);
    if (d.sizes.empty()) continue;
    d.label = camera_label(d.id, d.position, d.facing);
    if (source == kCameraSourcePassthrough) {
      out.push_back(std::move(d));
    } else if (source < 0) {
      others.push_back(std::move(d));  // no Horizon OS tags: another Android headset's cameras
    }
    // Horizon OS cameras that are not passthrough cameras (avatar, spatial) are not offered.
  }
  ACameraManager_deleteCameraIdList(ids);
  // Left before right, as the system lists them for Quest Browser.
  std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.position < b.position; });
  if (out.empty()) {
    if (!is_horizon_os()) {
      out = std::move(others);
    } else if (hidden && !others.empty()) {
      *hidden = true;  // cameras without their tags: the system withholds them
    }
  }
  return out;
}

void CameraService::open(const std::string& id, int width, int height, int fps,
                         std::function<void(CameraOpenResult)> done) {
  Impl* x = impl_;
  x->post([this, x, id, width, height, fps, done = std::move(done)] {
    CameraOpenResult refused;
    if (!permitted()) {
      refused.error = "NotAllowedError";
      refused.message = "the camera permissions are not granted";
    }
    auto s = std::make_shared<Stream>();
    s->camera = id;
    s->width = width;
    s->height = height;
    s->fps = fps;
    s->opened_ms = iwn::now_ms();
    // Registered before the first frame can arrive, so latest() finds it; not at all once shutdown() began.
    {
      std::lock_guard<std::mutex> lock(x->mu);
      if (x->shutting_down) {
        refused.error = "AbortError";
        refused.message = "the app is shutting down";
      }
      if (refused.error.empty()) {
        s->id = x->next_id++;
        x->streams[s->id] = s;
      } else {
        x->failed++;
      }
    }
    if (!refused.error.empty()) {
      iwn::log(LogLevel::kWarn, "camera: cannot open camera %s: %s", id.c_str(), refused.message.c_str());
      done(std::move(refused));
      return;
    }
    std::string what;
    const camera_status_t st = x->start(s.get(), &what);
    CameraOpenResult r;
    if (st != ACAMERA_OK) {
      Impl::release(s.get());
      {
        std::lock_guard<std::mutex> lock(x->mu);
        x->streams.erase(s->id);
        x->failed++;
      }
      r.error = st == ACAMERA_ERROR_PERMISSION_DENIED ? "NotAllowedError"
                : st == ACAMERA_ERROR_INVALID_PARAMETER ? "NotFoundError"
                                                         : "NotReadableError";
      r.message = what + ": " + camera_status_name(st);
      iwn::log(LogLevel::kWarn, "camera: cannot open camera %s %dx%d@%d: %s", id.c_str(), width, height, fps,
               r.message.c_str());
    } else {
      {
        std::lock_guard<std::mutex> lock(x->mu);
        x->opened++;
      }
      r.stream = s->id;
      r.width = width;
      r.height = height;
      r.frame_rate = fps;
      iwn::log(LogLevel::kInfo, "camera: stream %d: camera %s %dx%d@%d YUV_420_888 (open %.1f ms)", s->id, id.c_str(),
               width, height, fps, iwn::now_ms() - s->opened_ms);
    }
    done(std::move(r));
  });
}

bool CameraService::latest(int stream, CameraFrame* out) {
  std::shared_ptr<Stream> s;
  {
    std::lock_guard<std::mutex> lock(impl_->mu);
    auto it = impl_->streams.find(stream);
    if (it == impl_->streams.end()) return false;
    s = it->second;
  }
  std::lock_guard<std::mutex> lock(s->mu);
  if (!s->latest) return false;
  out->store = s->latest;
  out->serial = s->serial;
  out->timestamp_ns = s->timestamp_ns;
  return true;
}

void CameraService::close(int stream) {
  Impl* x = impl_;
  std::shared_ptr<Stream> s;
  {
    std::lock_guard<std::mutex> lock(x->mu);
    auto it = x->streams.find(stream);
    if (it == x->streams.end()) return;
    s = it->second;
    x->streams.erase(it);
  }
  x->post([s] {
    const double t0 = iwn::now_ms();
    Impl::release(s.get());
    std::lock_guard<std::mutex> lock(s->mu);
    iwn::log(LogLevel::kInfo, "camera: stream %d closed after %llu frames (convert avg %.2f ms, max %.2f ms; %llu "
             "dropped; close %.1f ms)", s->id, static_cast<unsigned long long>(s->serial),
             s->serial ? s->convert_ms_total / static_cast<double>(s->serial) : 0.0, s->convert_ms_max,
             static_cast<unsigned long long>(s->dropped), iwn::now_ms() - t0);
  });
}

void CameraService::shutdown() {
  Impl* x = impl_;
  std::vector<int> ids;
  {
    std::lock_guard<std::mutex> lock(x->mu);
    x->shutting_down = true;  // opens still queued behind the closes below fail at once
    for (const auto& [id, s] : x->streams) ids.push_back(id);
    x->listener = nullptr;
  }
  for (int id : ids) close(id);
  std::thread worker;
  {
    std::lock_guard<std::mutex> lock(x->qmu);
    x->stopping = true;
    x->qcv.notify_one();
    worker = std::move(x->worker);
  }
  if (worker.joinable()) worker.join();
  // An open that was already past its check registered its stream after `ids` was taken: released here, as nothing
  // else would (a camera left open past the process raises a system ANR on the next sleep).
  std::vector<std::shared_ptr<Stream>> left;
  {
    std::lock_guard<std::mutex> lock(x->mu);
    for (const auto& [id, s] : x->streams) left.push_back(s);
    x->streams.clear();
    x->shutting_down = false;  // an activity relaunched in this process opens cameras again
  }
  for (const auto& s : left) {
    iwn::log(LogLevel::kInfo, "camera: stream %d (camera %s) closed at shutdown", s->id, s->camera.c_str());
    Impl::release(s.get());
  }
}

void CameraService::set_listener(std::function<void(int, bool)> listener) {
  std::lock_guard<std::mutex> lock(impl_->mu);
  impl_->listener = std::move(listener);
}

Json CameraService::stats() {
  Json j = Json::object();
  std::vector<std::shared_ptr<Stream>> list;
  {
    std::lock_guard<std::mutex> lock(impl_->mu);
    j.set("opened", impl_->opened);
    j.set("failed", impl_->failed);
    for (const auto& [id, s] : impl_->streams) list.push_back(s);
  }
  Json streams = Json::array();
  const double now = iwn::now_ms();
  for (const auto& s : list) {
    std::lock_guard<std::mutex> lock(s->mu);
    Json o = Json::object();
    o.set("id", s->id);
    o.set("camera", s->camera);
    o.set("width", s->width);
    o.set("height", s->height);
    o.set("frameRate", s->fps);
    o.set("frames", s->serial);
    o.set("ended", s->ended.load());
    o.set("dropped", s->dropped);
    o.set("pool", static_cast<int64_t>(s->pool.size()));
    o.set("hardwareBuffers", !s->pool.empty() && s->pool.front()->backing() == image::PixelStore::Backing::kHardwareBuffer);
    o.set("firstFrameMs", s->serial ? s->first_frame_ms - s->opened_ms : -1.0);
    o.set("fps", s->serial > 1 && now > s->first_frame_ms
                     ? static_cast<double>(s->serial - 1) * 1000.0 / (now - s->first_frame_ms)
                     : 0.0);
    o.set("convertMsAvg", s->serial ? s->convert_ms_total / static_cast<double>(s->serial) : 0.0);
    o.set("convertMsMax", s->convert_ms_max);
    streams.push(std::move(o));
  }
  j.set("streams", std::move(streams));
  return j;
}

}  // namespace iwn::xr
