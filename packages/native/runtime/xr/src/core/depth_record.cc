// The depth record writer (depth_record.h).
#include "iwn/xr/depth_record.h"

namespace iwn::xr {

namespace D = depth_layout;

void write_depth_record(double* record, const DepthImage& image, double acquire_ms) {
  record[D::kVersion] = D::kDepthVersion;
  record[D::kTexture] = image.texture;
  record[D::kWidth] = image.width;
  record[D::kHeight] = image.height;
  record[D::kNear] = image.near_z;
  record[D::kFar] = image.far_z;  // +inf stays +inf (float -> double)
  for (int v = 0; v < 2; ++v) {
    double* o = record + D::kViews + static_cast<size_t>(v) * D::kViewStride;
    const XrPosef& p = image.pose[v];
    const XrFovf& f = image.fov[v];
    o[0] = p.position.x;
    o[1] = p.position.y;
    o[2] = p.position.z;
    o[3] = p.orientation.x;
    o[4] = p.orientation.y;
    o[5] = p.orientation.z;
    o[6] = p.orientation.w;
    o[7] = f.angleLeft;
    o[8] = f.angleRight;
    o[9] = f.angleUp;
    o[10] = f.angleDown;
  }
  record[D::kAcquireMs] = acquire_ms;
  record[D::kSerial] += 1;
  record[D::kValid] = 1;
}

void clear_depth_record(double* record, double acquire_ms) {
  record[D::kVersion] = D::kDepthVersion;
  record[D::kValid] = 0;
  record[D::kAcquireMs] = acquire_ms;
}

}  // namespace iwn::xr
