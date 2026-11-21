// See fake_camera.h.
#include "fake_camera.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>

#include "android/xr_permissions.h"
#include "fake_ndk_camera.h"
#include "iwn/xr/camera_convert.h"

struct ACameraManager {
  std::vector<fakecam::Camera> visible;  // the list as it was when the manager was made
  std::vector<std::string> ids;
};
struct ACameraMetadata {
  uint8_t source = 0, position = 0, facing = 0;
  bool tagged = false;
  std::vector<int32_t> configs;
  std::vector<int32_t> fps;
};
struct ACameraDevice {
  std::string id;
};
struct ACaptureRequest {
  std::vector<const ACameraOutputTarget*> targets;
};
struct ACameraOutputTarget {
  ANativeWindow* window = nullptr;
};
struct ACaptureSessionOutput {
  ANativeWindow* window = nullptr;
};
struct ACaptureSessionOutputContainer {
  std::vector<const ACaptureSessionOutput*> outputs;
};
struct ACameraCaptureSession {
  std::vector<ANativeWindow*> windows;
  bool repeating = false;
};
struct AImageReader {
  int32_t width = 0, height = 0;
  AImageReader_ImageListener listener{};
  std::vector<uint8_t> y, u, v;
  int64_t timestamp_ns = 0;
};
struct AImage {
  AImageReader* reader = nullptr;
};

namespace fakecam {
namespace {

std::mutex mu;  // sessions, readers
std::vector<ACameraCaptureSession*> sessions;
std::vector<AImageReader*> readers;
uint8_t next_luma = 16;

}  // namespace

Service& service() {
  static Service s;
  return s;
}

void quest3() {
  Service& s = service();
  s.cameras = {{"1", 1, -1, 0}, {"50", iwn::xr::kCameraSourcePassthrough, 0, 1},
               {"51", iwn::xr::kCameraSourcePassthrough, 1, 1}};
}

void deliver_frame() {
  std::vector<AImageReader*> targets;
  {
    std::lock_guard<std::mutex> lock(mu);
    for (ACameraCaptureSession* s : sessions) {
      if (!s->repeating) continue;
      for (ANativeWindow* w : s->windows) {
        auto* r = reinterpret_cast<AImageReader*>(w);
        if (std::find(readers.begin(), readers.end(), r) != readers.end()) targets.push_back(r);
      }
    }
    ++next_luma;  // every frame its own picture
    for (AImageReader* r : targets) {
      std::fill(r->y.begin(), r->y.end(), next_luma);
      r->timestamp_ns += 33'333'333;
    }
  }
  for (AImageReader* r : targets) {
    if (r->listener.onImageAvailable) r->listener.onImageAvailable(r->listener.context, r);
  }
}

}  // namespace fakecam

namespace iwn::xr {

PermissionBroker& PermissionBroker::get() {
  static PermissionBroker b;
  return b;
}

std::vector<bool> PermissionBroker::check(const std::vector<std::string>& names) {
  std::vector<bool> out;
  for (const std::string& n : names) {
    out.push_back(n == "android.permission.CAMERA"             ? fakecam::service().camera_granted
                  : n == "horizonos.permission.HEADSET_CAMERA" ? fakecam::service().headset_camera_granted
                                                               : false);
  }
  return out;
}

}  // namespace iwn::xr

extern "C" {

ACameraManager* ACameraManager_create() {
  fakecam::Service& s = fakecam::service();
  ++s.managers_created;
  auto* m = new ACameraManager();
  for (fakecam::Camera c : s.cameras) {
    if (!s.headset_camera_granted) {
      if (c.source == iwn::xr::kCameraSourcePassthrough) continue;  // hidden, and the others without their tags
      c.source = -1;
      c.position = -1;
    }
    m->visible.push_back(c);
  }
  return m;
}

camera_status_t ACameraManager_getCameraIdList(ACameraManager* m, ACameraIdList** out) {
  m->ids.clear();
  for (const fakecam::Camera& c : m->visible) m->ids.push_back(c.id);
  auto* list = new ACameraIdList();
  list->numCameras = static_cast<int>(m->ids.size());
  list->cameraIds = new const char*[m->ids.size()];
  for (size_t i = 0; i < m->ids.size(); ++i) list->cameraIds[i] = m->ids[i].c_str();
  *out = list;
  return ACAMERA_OK;
}

void ACameraManager_deleteCameraIdList(ACameraIdList* list) {
  delete[] list->cameraIds;
  delete list;
}

camera_status_t ACameraManager_getCameraCharacteristics(ACameraManager* m, const char* id, ACameraMetadata** out) {
  for (const fakecam::Camera& c : m->visible) {
    if (c.id != id) continue;
    auto* meta = new ACameraMetadata();
    meta->tagged = c.source >= 0;
    meta->source = static_cast<uint8_t>(c.source);
    meta->position = static_cast<uint8_t>(c.position);
    meta->facing = static_cast<uint8_t>(c.facing);
    for (const auto& [w, h] : {std::pair<int, int>{640, 480}, {1280, 1080}}) {
      meta->configs.insert(meta->configs.end(),
                           {AIMAGE_FORMAT_YUV_420_888, w, h, ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS_OUTPUT});
    }
    meta->fps = {15, 15, 30, 30};
    *out = meta;
    return ACAMERA_OK;
  }
  return ACAMERA_ERROR_INVALID_PARAMETER;
}

camera_status_t ACameraManager_openCamera(ACameraManager* m, const char* id, ACameraDevice_StateCallbacks*,
                                          ACameraDevice** out) {
  fakecam::Service& s = fakecam::service();
  if (!s.camera_granted) return ACAMERA_ERROR_PERMISSION_DENIED;
  const bool listed = std::any_of(m->visible.begin(), m->visible.end(), [&](const fakecam::Camera& c) { return c.id == id; });
  if (!listed) return ACAMERA_ERROR_INVALID_PARAMETER;
  *out = new ACameraDevice{id};
  ++s.devices_opened;
  ++s.devices_open;
  return ACAMERA_OK;
}

camera_status_t ACameraMetadata_getConstEntry(const ACameraMetadata* meta, uint32_t tag, ACameraMetadata_const_entry* e) {
  e->tag = tag;
  if (tag == iwn::xr::kMetaCameraSourceTag && meta->tagged) {
    e->count = 1;
    e->data.u8 = &meta->source;
  } else if (tag == iwn::xr::kMetaCameraPositionTag && meta->tagged) {
    e->count = 1;
    e->data.u8 = &meta->position;
  } else if (tag == ACAMERA_LENS_FACING) {
    e->count = 1;
    e->data.u8 = &meta->facing;
  } else if (tag == ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS) {
    e->count = static_cast<uint32_t>(meta->configs.size());
    e->data.i32 = meta->configs.data();
  } else if (tag == ACAMERA_CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) {
    e->count = static_cast<uint32_t>(meta->fps.size());
    e->data.i32 = meta->fps.data();
  } else {
    return ACAMERA_ERROR_METADATA_NOT_FOUND;
  }
  return ACAMERA_OK;
}

void ACameraMetadata_free(ACameraMetadata* meta) { delete meta; }

camera_status_t ACameraDevice_close(ACameraDevice* d) {
  fakecam::Service& s = fakecam::service();
  if (s.close_delay_ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(s.close_delay_ms));
  --s.devices_open;
  delete d;
  return ACAMERA_OK;
}

camera_status_t ACameraDevice_createCaptureRequest(const ACameraDevice*, ACameraDevice_request_template,
                                                   ACaptureRequest** out) {
  *out = new ACaptureRequest();
  return ACAMERA_OK;
}

camera_status_t ACameraDevice_createCaptureSession(ACameraDevice*, const ACaptureSessionOutputContainer* outputs,
                                                   const ACameraCaptureSession_stateCallbacks*,
                                                   ACameraCaptureSession** out) {
  auto* s = new ACameraCaptureSession();
  for (const ACaptureSessionOutput* o : outputs->outputs) s->windows.push_back(o->window);
  std::lock_guard<std::mutex> lock(fakecam::mu);
  fakecam::sessions.push_back(s);
  *out = s;
  return ACAMERA_OK;
}

camera_status_t ACaptureSessionOutputContainer_create(ACaptureSessionOutputContainer** out) {
  *out = new ACaptureSessionOutputContainer();
  return ACAMERA_OK;
}
void ACaptureSessionOutputContainer_free(ACaptureSessionOutputContainer* c) { delete c; }
camera_status_t ACaptureSessionOutputContainer_add(ACaptureSessionOutputContainer* c, const ACaptureSessionOutput* o) {
  c->outputs.push_back(o);
  return ACAMERA_OK;
}
camera_status_t ACaptureSessionOutputContainer_remove(ACaptureSessionOutputContainer* c, const ACaptureSessionOutput* o) {
  c->outputs.erase(std::remove(c->outputs.begin(), c->outputs.end(), o), c->outputs.end());
  return ACAMERA_OK;
}
camera_status_t ACaptureSessionOutput_create(ANativeWindow* w, ACaptureSessionOutput** out) {
  *out = new ACaptureSessionOutput{w};
  return ACAMERA_OK;
}
void ACaptureSessionOutput_free(ACaptureSessionOutput* o) { delete o; }
camera_status_t ACameraOutputTarget_create(ANativeWindow* w, ACameraOutputTarget** out) {
  *out = new ACameraOutputTarget{w};
  return ACAMERA_OK;
}
void ACameraOutputTarget_free(ACameraOutputTarget* t) { delete t; }
camera_status_t ACaptureRequest_addTarget(ACaptureRequest* r, const ACameraOutputTarget* t) {
  r->targets.push_back(t);
  return ACAMERA_OK;
}
void ACaptureRequest_free(ACaptureRequest* r) { delete r; }
camera_status_t ACaptureRequest_setEntry_i32(ACaptureRequest*, uint32_t, uint32_t, const int32_t*) { return ACAMERA_OK; }

camera_status_t ACameraCaptureSession_setRepeatingRequest(ACameraCaptureSession* s, ACameraCaptureSession_captureCallbacks*,
                                                          int, ACaptureRequest**, int*) {
  std::lock_guard<std::mutex> lock(fakecam::mu);
  s->repeating = true;
  return ACAMERA_OK;
}
camera_status_t ACameraCaptureSession_stopRepeating(ACameraCaptureSession* s) {
  std::lock_guard<std::mutex> lock(fakecam::mu);
  s->repeating = false;
  return ACAMERA_OK;
}
void ACameraCaptureSession_close(ACameraCaptureSession* s) {
  std::lock_guard<std::mutex> lock(fakecam::mu);
  fakecam::sessions.erase(std::remove(fakecam::sessions.begin(), fakecam::sessions.end(), s), fakecam::sessions.end());
  delete s;
}

media_status_t AImageReader_new(int32_t w, int32_t h, int32_t, int32_t, AImageReader** out) {
  auto* r = new AImageReader();
  r->width = w;
  r->height = h;
  r->y.assign(static_cast<size_t>(w) * h, 0);
  r->u.assign(static_cast<size_t>(w / 2) * (h / 2), 128);
  r->v.assign(static_cast<size_t>(w / 2) * (h / 2), 128);
  std::lock_guard<std::mutex> lock(fakecam::mu);
  fakecam::readers.push_back(r);
  *out = r;
  return AMEDIA_OK;
}
media_status_t AImageReader_getWindow(AImageReader* r, ANativeWindow** out) {
  *out = reinterpret_cast<ANativeWindow*>(r);
  return AMEDIA_OK;
}
media_status_t AImageReader_setImageListener(AImageReader* r, AImageReader_ImageListener* l) {
  r->listener = *l;
  return AMEDIA_OK;
}
media_status_t AImageReader_acquireLatestImage(AImageReader* r, AImage** out) {
  *out = new AImage{r};
  return AMEDIA_OK;
}
void AImageReader_delete(AImageReader* r) {
  std::lock_guard<std::mutex> lock(fakecam::mu);
  fakecam::readers.erase(std::remove(fakecam::readers.begin(), fakecam::readers.end(), r), fakecam::readers.end());
  delete r;
}
media_status_t AImage_getWidth(const AImage* i, int32_t* w) {
  *w = i->reader->width;
  return AMEDIA_OK;
}
media_status_t AImage_getHeight(const AImage* i, int32_t* h) {
  *h = i->reader->height;
  return AMEDIA_OK;
}
media_status_t AImage_getTimestamp(const AImage* i, int64_t* ts) {
  *ts = i->reader->timestamp_ns;
  return AMEDIA_OK;
}
media_status_t AImage_getPlaneData(const AImage* i, int plane, uint8_t** data, int* len) {
  std::vector<uint8_t>& p = plane == 0 ? i->reader->y : plane == 1 ? i->reader->u : i->reader->v;
  *data = p.data();
  *len = static_cast<int>(p.size());
  return AMEDIA_OK;
}
media_status_t AImage_getPlaneRowStride(const AImage* i, int plane, int32_t* stride) {
  *stride = plane == 0 ? i->reader->width : i->reader->width / 2;
  return AMEDIA_OK;
}
media_status_t AImage_getPlanePixelStride(const AImage*, int, int32_t* stride) {
  *stride = 1;  // planar
  return AMEDIA_OK;
}
void AImage_delete(AImage* i) { delete i; }

int __system_property_get(const char* name, char* value) {
  const char* v = std::strcmp(name, "ro.product.manufacturer") == 0 ? "Oculus" : "";
  std::strcpy(value, v);
  return static_cast<int>(std::strlen(v));
}

}  // extern "C"
