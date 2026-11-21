// Writes a frame record with known contents, produced by the real native writer (FrameRecord + write_hand_input),
// to a file. web/xr/test/record-roundtrip.test.ts loads it as the XRHostFrame and checks what IWER host mode makes
// of it (XRF-2: XRView.transform.matrix, projectionMatrix, input poses and buttons).
//
//   iwn_xr_record_dump <out.bin>
#include <cmath>
#include <cstdio>

#include "iwn/xr/frame_record.h"
#include "iwn/xr/input_map.h"

using namespace iwn::xr;

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  FrameRecord r;
  // Head 1.6 m above a stage floor, yawed 30 degrees to the left (about +Y), eyes 64 mm apart.
  const float half = 0.5235988f * 0.5f;  // 30 deg / 2
  XrQuaternionf yaw{0, std::sin(half), 0, std::cos(half)};
  const float c = std::cos(0.5235988f), s = std::sin(0.5235988f);
  // eye offsets along the head's +x axis (rotated by the yaw): x' = (c, 0, -s)
  XrPosef left{yaw, {-0.032f * c, 1.6f, 0.032f * s}};
  XrPosef right{yaw, {0.032f * c, 1.6f, -0.032f * s}};
  XrFovf fov_l{-0.9425f, 0.6981f, 0.8029f, -0.9076f};
  XrFovf fov_r{-0.6981f, 0.9425f, 0.8029f, -0.9076f};
  r.write_view(0, left, fov_l);
  r.write_view(1, right, fov_r);
  r.write_pose(layout::kLocalPose, XrPosef{{0, 0, 0, 1}, {0.25f, 1.55f, -0.4f}});
  r.write_pose(layout::kViewerPose, XrPosef{yaw, {0, 1.6f, 0}});
  r.write_header(true, true, 2, 41, 2, 123456.789, 123440.5, 1000.0 / 72.0, 72.0f, 0.0f);
  r.next_serial();

  HandInput lh;
  lh.mode = InputMode::kController;
  lh.profile = InputProfile::kTouchPlus;
  lh.controller.active = true;
  lh.controller.aim = {XrPosef{{0, 0, 0, 1}, {-0.2f, 1.3f, -0.35f}}, true};
  lh.controller.grip = {XrPosef{{0, 0, 0, 1}, {-0.2f, 1.25f, -0.3f}}, true};
  lh.controller.trigger = 0.75f;
  lh.controller.trigger_pressed = true;
  lh.controller.stick_x = -0.5f;
  lh.controller.stick_y = 0.5f;
  write_hand_input(r, 0, lh);

  HandInput rh;
  rh.mode = InputMode::kHand;
  rh.hand.tracked = true;
  for (int j = 0; j < kOpenXrJoints; ++j) {
    rh.hand.joints[j].locationFlags = XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
    rh.hand.joints[j].pose = XrPosef{{0, 0, 0, 1}, {0.2f + 0.005f * j, 1.2f, -0.3f}};
    rh.hand.joints[j].radius = 0.01f;
  }
  rh.hand.aim = {XrPosef{{0, 0, 0, 1}, {0.2f, 1.25f, -0.3f}}, true};
  rh.hand.pinch_index = 1.0f;
  rh.hand.pinching = true;
  write_hand_input(r, 1, rh);

  FILE* f = std::fopen(argv[1], "wb");
  if (!f) return 1;
  const size_t n = std::fwrite(r.data(), 1, FrameRecord::size(), f);
  std::fclose(f);
  return n == FrameRecord::size() ? 0 : 1;
}
