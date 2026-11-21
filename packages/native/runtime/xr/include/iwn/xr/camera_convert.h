// The V8-free, Camera2-free parts of the passthrough camera (XR-CAM-1): YUV 4:2:0 → RGBA8 conversion of a camera
// image and the device list's naming. Host-tested; the Camera2 side is src/android/xr_camera.cc.
//
// Sources: Android NDK AImage (AIMAGE_FORMAT_YUV_420_888: three planes, Y full resolution, U and V subsampled 2x2,
// any row stride, a U/V pixel stride of 1 (planar) or 2 (semi-planar, interleaved)), JPEG File Interchange Format
// 1.02 (full-range BT.601 YCbCr, what Android camera YUV holds), Horizon OS Passthrough Camera API (camera metadata
// com.meta.extra_metadata.camera_source 0 = passthrough, .position 0 = left, 1 = right).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace iwn::xr {

struct YuvPlanes {
  const uint8_t* y = nullptr;
  const uint8_t* u = nullptr;
  const uint8_t* v = nullptr;
  int y_row_stride = 0;
  int uv_row_stride = 0;
  int uv_pixel_stride = 1;  // 1: planar (I420), 2: semi-planar (NV12 / NV21)
};

// Converts a width x height image (any size; odd edges reuse the last chroma sample) into opaque RGBA8 rows of
// `dst_stride` bytes, top row first. Full-range BT.601, fixed point (the result is within 1 of the exact formula).
void yuv420_to_rgba(const YuvPlanes& src, int width, int height, uint8_t* dst, size_t dst_stride);

// Horizon OS vendor tags in the camera characteristics (ACameraMetadata tag ids).
constexpr uint32_t kMetaCameraSourceTag = 0x80004d00;  // byte: 0 passthrough, 1 avatar, 3 spatial
constexpr uint32_t kMetaCameraPositionTag = 0x80004d01;  // byte: 0 left, 1 right
constexpr int kCameraSourcePassthrough = 0;

// ACAMERA_LENS_FACING values.
enum class LensFacing : int { kFront = 0, kBack = 1, kExternal = 2 };

// The MediaDeviceInfo label of a camera: "Left passthrough camera (id 50), facing back" on Quest; position < 0
// (not a Horizon OS passthrough camera) gives "Camera <id>, facing <...>". Pages pick cameras by label words
// ("back" / "environment"), as IWSDK's CameraUtils does, so the facing is always named.
std::string camera_label(const std::string& id, int position, LensFacing facing);

}  // namespace iwn::xr
