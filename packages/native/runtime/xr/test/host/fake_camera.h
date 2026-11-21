/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A fake camera service for the host tests of src/android/xr_camera.cc (the passthrough cameras, XR-CAM-1), behind
// the NDK camera API of fake_ndk/ (compiled in place of the NDK's headers). It behaves as Horizon OS does where that
// code depends on it:
//   - the camera list is fixed when the process's camera manager is created (the NDK registers its listener then),
//     and an app without HEADSET_CAMERA sees no passthrough camera: a list read before the grant stays without them;
//   - opening a camera needs CAMERA (ACAMERA_ERROR_PERMISSION_DENIED) and a camera the list has;
//   - ACameraDevice_close can take a while (the device's close on Quest takes 40-220 ms).
// Tests set the state, call CameraService, and deliver frames to the open streams' readers.
#pragma once

#include <string>
#include <vector>

namespace fakecam {

struct Camera {
  std::string id;
  int source = -1;    // com.meta.extra_metadata.camera_source (-1: no Horizon OS tags, which hide them until granted)
  int position = -1;  // com.meta.extra_metadata.position
  int facing = 1;     // ACAMERA_LENS_FACING (1: back)
};

struct Service {
  std::vector<Camera> cameras;
  bool camera_granted = false;          // android.permission.CAMERA
  bool headset_camera_granted = false;  // horizonos.permission.HEADSET_CAMERA
  int close_delay_ms = 0;               // each ACameraDevice_close takes this long
  // what happened
  int managers_created = 0;
  int devices_opened = 0;
  int devices_open = 0;  // open now
};

// The service the NDK entry points act on.
Service& service();
// The Quest 3's cameras: the untagged avatar camera "1" and the passthrough cameras "50" (left) and "51" (right).
void quest3();
// One frame into the reader of every streaming capture session (calls its image listener on this thread).
void deliver_frame();

}  // namespace fakecam
