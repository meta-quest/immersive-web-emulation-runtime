/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host tests for the depth record (XR-DEPTH-2, iwn/xr/depth_record.h): the layout web/xr's depth.ts reads.
#include <cmath>
#include <limits>

#include "iwn/xr/depth_record.h"
#include "iwn_test.h"

using namespace iwn::xr;
namespace D = iwn::xr::depth_layout;

namespace {

DepthImage image() {
  DepthImage i;
  i.texture = 77;
  i.width = 320;
  i.height = 240;
  i.near_z = 0.1f;
  i.far_z = std::numeric_limits<float>::infinity();
  i.pose[0] = XrPosef{{0, 0, 0, 1}, {-0.03f, 1.6f, 0.01f}};
  i.pose[1] = XrPosef{{0.1f, 0.2f, 0.3f, 0.9f}, {0.03f, 1.6f, 0.01f}};
  i.fov[0] = XrFovf{-0.9f, 0.8f, 0.7f, -0.6f};
  i.fov[1] = XrFovf{-0.8f, 0.9f, 0.7f, -0.6f};
  return i;
}

}  // namespace

IWN_TEST(DepthRecord, LayoutIsTwoViewsOfElevenAfterTheHeader) {
  IWN_CHECK_EQ(D::kViews, 7u);
  IWN_CHECK_EQ(D::kAcquireMs, D::kViews + 22);
  IWN_CHECK_EQ(D::kCount, D::kSerial + 1);
}

IWN_TEST(DepthRecord, WriteFillsEveryField) {
  double r[D::kCount] = {};
  write_depth_record(r, image(), 0.25);
  IWN_CHECK_EQ(r[D::kVersion], static_cast<double>(D::kDepthVersion));
  IWN_CHECK_EQ(r[D::kValid], 1.0);
  IWN_CHECK_EQ(r[D::kTexture], 77.0);
  IWN_CHECK_EQ(r[D::kWidth], 320.0);
  IWN_CHECK_EQ(r[D::kHeight], 240.0);
  IWN_CHECK(std::fabs(r[D::kNear] - 0.1) < 1e-6);
  IWN_CHECK(std::isinf(r[D::kFar]) && r[D::kFar] > 0);  // an infinite far plane survives
  const double* right = r + D::kViews + D::kViewStride;
  IWN_CHECK(std::fabs(r[D::kViews + 0] + 0.03) < 1e-6);  // left position x
  IWN_CHECK(std::fabs(r[D::kViews + 6] - 1.0) < 1e-6);   // left orientation w
  IWN_CHECK(std::fabs(right[3] - 0.1) < 1e-6);           // right orientation x
  IWN_CHECK(std::fabs(right[7] + 0.8) < 1e-6);           // right FOV: left, right, up, down
  IWN_CHECK(std::fabs(right[8] - 0.9) < 1e-6);
  IWN_CHECK(std::fabs(right[10] + 0.6) < 1e-6);
  IWN_CHECK_EQ(r[D::kAcquireMs], 0.25);
  IWN_CHECK_EQ(r[D::kSerial], 1.0);
  write_depth_record(r, image(), 0.5);
  IWN_CHECK_EQ(r[D::kSerial], 2.0);  // counts images
}

IWN_TEST(DepthRecord, ClearMarksNoImageAndKeepsTheCount) {
  double r[D::kCount] = {};
  write_depth_record(r, image(), 0.25);
  clear_depth_record(r, 0.125);
  IWN_CHECK_EQ(r[D::kValid], 0.0);
  IWN_CHECK_EQ(r[D::kAcquireMs], 0.125);
  IWN_CHECK_EQ(r[D::kSerial], 1.0);
  IWN_CHECK_EQ(r[D::kVersion], static_cast<double>(D::kDepthVersion));
}
