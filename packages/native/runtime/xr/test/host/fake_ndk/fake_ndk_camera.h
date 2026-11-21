// The slice of the Android NDK camera and media API that src/android/xr_camera.cc uses (NdkCameraManager.h,
// NdkCameraDevice.h, NdkCameraCaptureSession.h, NdkCameraMetadata(Tags).h, NdkCaptureRequest.h, NdkImageReader.h,
// NdkImage.h, sys/system_properties.h), declared with the NDK's signatures so that file compiles on the host against
// the fake camera service of fake_camera.cc (test/host/fake_camera.h). Enum values only need to be distinct.
#pragma once

#include <cstdint>

extern "C" {

typedef enum {
  ACAMERA_OK = 0,
  ACAMERA_ERROR_UNKNOWN = -10000,
  ACAMERA_ERROR_INVALID_PARAMETER = ACAMERA_ERROR_UNKNOWN - 1,
  ACAMERA_ERROR_CAMERA_DISCONNECTED = ACAMERA_ERROR_UNKNOWN - 2,
  ACAMERA_ERROR_NOT_ENOUGH_MEMORY = ACAMERA_ERROR_UNKNOWN - 3,
  ACAMERA_ERROR_METADATA_NOT_FOUND = ACAMERA_ERROR_UNKNOWN - 4,
  ACAMERA_ERROR_CAMERA_DEVICE = ACAMERA_ERROR_UNKNOWN - 5,
  ACAMERA_ERROR_CAMERA_SERVICE = ACAMERA_ERROR_UNKNOWN - 6,
  ACAMERA_ERROR_SESSION_CLOSED = ACAMERA_ERROR_UNKNOWN - 7,
  ACAMERA_ERROR_INVALID_OPERATION = ACAMERA_ERROR_UNKNOWN - 8,
  ACAMERA_ERROR_STREAM_CONFIGURE_FAIL = ACAMERA_ERROR_UNKNOWN - 9,
  ACAMERA_ERROR_CAMERA_IN_USE = ACAMERA_ERROR_UNKNOWN - 10,
  ACAMERA_ERROR_MAX_CAMERA_IN_USE = ACAMERA_ERROR_UNKNOWN - 11,
  ACAMERA_ERROR_CAMERA_DISABLED = ACAMERA_ERROR_UNKNOWN - 12,
  ACAMERA_ERROR_PERMISSION_DENIED = ACAMERA_ERROR_UNKNOWN - 13,
  ACAMERA_ERROR_UNSUPPORTED_OPERATION = ACAMERA_ERROR_UNKNOWN - 14,
} camera_status_t;

typedef enum { AMEDIA_OK = 0, AMEDIA_ERROR_UNKNOWN = -10000 } media_status_t;

enum { AIMAGE_FORMAT_YUV_420_888 = 0x23 };
typedef enum { TEMPLATE_PREVIEW = 1, TEMPLATE_RECORD = 3 } ACameraDevice_request_template;

// metadata tags (values arbitrary but distinct; the vendor tags are iwn/xr/camera_convert.h's)
enum : uint32_t {
  ACAMERA_LENS_FACING = 0x80005,
  ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS = 0xD000A,
  ACAMERA_CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES = 0x10013,
  ACAMERA_CONTROL_AE_TARGET_FPS_RANGE = 0x10005,
};
enum { ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS_OUTPUT = 0 };

typedef struct ACameraManager ACameraManager;
typedef struct ACameraMetadata ACameraMetadata;
typedef struct ACameraDevice ACameraDevice;
typedef struct ACaptureRequest ACaptureRequest;
typedef struct ACameraOutputTarget ACameraOutputTarget;
typedef struct ACaptureSessionOutput ACaptureSessionOutput;
typedef struct ACaptureSessionOutputContainer ACaptureSessionOutputContainer;
typedef struct ACameraCaptureSession ACameraCaptureSession;
typedef struct ACameraCaptureSession_captureCallbacks ACameraCaptureSession_captureCallbacks;
typedef struct AImageReader AImageReader;
typedef struct AImage AImage;
typedef struct ANativeWindow ANativeWindow;

typedef struct ACameraIdList {
  int numCameras;
  const char** cameraIds;
} ACameraIdList;

typedef struct ACameraMetadata_const_entry {
  uint32_t tag;
  uint8_t type;
  uint32_t count;
  union {
    const uint8_t* u8;
    const int32_t* i32;
    const float* f;
    const int64_t* i64;
    const double* d;
  } data;
} ACameraMetadata_const_entry;

typedef void (*ACameraDevice_StateCallback)(void* context, ACameraDevice* device);
typedef void (*ACameraDevice_ErrorStateCallback)(void* context, ACameraDevice* device, int error);
typedef struct ACameraDevice_StateCallbacks {
  void* context;
  ACameraDevice_StateCallback onDisconnected;
  ACameraDevice_ErrorStateCallback onError;
} ACameraDevice_StateCallbacks;

typedef void (*ACameraCaptureSession_stateCallback)(void* context, ACameraCaptureSession* session);
typedef struct ACameraCaptureSession_stateCallbacks {
  void* context;
  ACameraCaptureSession_stateCallback onClosed;
  ACameraCaptureSession_stateCallback onReady;
  ACameraCaptureSession_stateCallback onActive;
} ACameraCaptureSession_stateCallbacks;

typedef void (*AImageReader_ImageCallback)(void* context, AImageReader* reader);
typedef struct AImageReader_ImageListener {
  void* context;
  AImageReader_ImageCallback onImageAvailable;
} AImageReader_ImageListener;

ACameraManager* ACameraManager_create();
camera_status_t ACameraManager_getCameraIdList(ACameraManager* manager, ACameraIdList** cameraIdList);
void ACameraManager_deleteCameraIdList(ACameraIdList* cameraIdList);
camera_status_t ACameraManager_getCameraCharacteristics(ACameraManager* manager, const char* cameraId,
                                                        ACameraMetadata** characteristics);
camera_status_t ACameraManager_openCamera(ACameraManager* manager, const char* cameraId,
                                          ACameraDevice_StateCallbacks* callback, ACameraDevice** device);
camera_status_t ACameraMetadata_getConstEntry(const ACameraMetadata* metadata, uint32_t tag,
                                              ACameraMetadata_const_entry* entry);
void ACameraMetadata_free(ACameraMetadata* metadata);

camera_status_t ACameraDevice_close(ACameraDevice* device);
camera_status_t ACameraDevice_createCaptureRequest(const ACameraDevice* device,
                                                   ACameraDevice_request_template templateId,
                                                   ACaptureRequest** request);
camera_status_t ACameraDevice_createCaptureSession(ACameraDevice* device, const ACaptureSessionOutputContainer* outputs,
                                                   const ACameraCaptureSession_stateCallbacks* callbacks,
                                                   ACameraCaptureSession** session);
camera_status_t ACaptureSessionOutputContainer_create(ACaptureSessionOutputContainer** container);
void ACaptureSessionOutputContainer_free(ACaptureSessionOutputContainer* container);
camera_status_t ACaptureSessionOutputContainer_add(ACaptureSessionOutputContainer* container,
                                                   const ACaptureSessionOutput* output);
camera_status_t ACaptureSessionOutputContainer_remove(ACaptureSessionOutputContainer* container,
                                                      const ACaptureSessionOutput* output);
camera_status_t ACaptureSessionOutput_create(ANativeWindow* anw, ACaptureSessionOutput** output);
void ACaptureSessionOutput_free(ACaptureSessionOutput* output);
camera_status_t ACameraOutputTarget_create(ANativeWindow* window, ACameraOutputTarget** output);
void ACameraOutputTarget_free(ACameraOutputTarget* output);
camera_status_t ACaptureRequest_addTarget(ACaptureRequest* request, const ACameraOutputTarget* output);
void ACaptureRequest_free(ACaptureRequest* request);
camera_status_t ACaptureRequest_setEntry_i32(ACaptureRequest* request, uint32_t tag, uint32_t count,
                                             const int32_t* data);
camera_status_t ACameraCaptureSession_setRepeatingRequest(ACameraCaptureSession* session,
                                                          ACameraCaptureSession_captureCallbacks* callbacks,
                                                          int numRequests, ACaptureRequest** requests,
                                                          int* captureSequenceId);
camera_status_t ACameraCaptureSession_stopRepeating(ACameraCaptureSession* session);
void ACameraCaptureSession_close(ACameraCaptureSession* session);

media_status_t AImageReader_new(int32_t width, int32_t height, int32_t format, int32_t maxImages, AImageReader** reader);
media_status_t AImageReader_getWindow(AImageReader* reader, ANativeWindow** window);
media_status_t AImageReader_setImageListener(AImageReader* reader, AImageReader_ImageListener* listener);
media_status_t AImageReader_acquireLatestImage(AImageReader* reader, AImage** image);
void AImageReader_delete(AImageReader* reader);
media_status_t AImage_getWidth(const AImage* image, int32_t* width);
media_status_t AImage_getHeight(const AImage* image, int32_t* height);
media_status_t AImage_getTimestamp(const AImage* image, int64_t* timestampNs);
media_status_t AImage_getPlaneData(const AImage* image, int planeIdx, uint8_t** data, int* dataLength);
media_status_t AImage_getPlaneRowStride(const AImage* image, int planeIdx, int32_t* rowStride);
media_status_t AImage_getPlanePixelStride(const AImage* image, int planeIdx, int32_t* pixelStride);
void AImage_delete(AImage* image);

#define PROP_VALUE_MAX 92
int __system_property_get(const char* name, char* value);

}  // extern "C"
