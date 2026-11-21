/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host tests of src/android/xr_camera.cc (the passthrough cameras, XR-CAM-1) against the fake camera service of
// fake_camera.h. CameraService is a process singleton that makes its camera manager once, so the permission test
// comes first (tests run in the order they are written).
#include <future>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "android/xr_camera.h"
#include "fake_camera.h"
#include "iwn_test.h"

using iwn::xr::CameraFrame;
using iwn::xr::CameraOpenResult;
using iwn::xr::CameraService;

namespace {

CameraOpenResult open_and_wait(const std::string& id, int width, int height) {
  std::promise<CameraOpenResult> done;
  std::future<CameraOpenResult> answer = done.get_future();
  CameraService::get().open(id, width, height, 30, [&done](CameraOpenResult r) { done.set_value(std::move(r)); });
  return answer.get();
}

// Every job posted before it ran on the worker (an open of a camera the list lacks fails on the worker, in order).
void drain_worker() { (void)open_and_wait("no-such-camera", 640, 480); }

}  // namespace

IWN_TEST(Camera, NothingReadsTheCameraListBeforeThePermissions) {
  fakecam::quest3();
  fakecam::Service& svc = fakecam::service();
  bool hidden = false;
  IWN_CHECK(!CameraService::get().permitted());
  IWN_CHECK(CameraService::get().devices(&hidden).empty());
  IWN_CHECK(hidden);
  CameraOpenResult refused = open_and_wait("50", 640, 480);
  IWN_CHECK_EQ(refused.error, std::string("NotAllowedError"));
  // a camera manager made now would keep a list without the passthrough cameras for the life of the process
  IWN_CHECK_EQ(svc.managers_created, 0);
  // the user allows the camera in the system dialog (same process)
  svc.camera_granted = true;
  svc.headset_camera_granted = true;
  IWN_CHECK(CameraService::get().permitted());
  std::vector<iwn::xr::CameraDeviceInfo> list = CameraService::get().devices(&hidden);
  IWN_CHECK_EQ(list.size(), size_t{2});
  IWN_CHECK(!hidden);
  IWN_CHECK(list[0].id == "50" && list[0].position == 0 && list[1].id == "51" && list[1].position == 1);
  IWN_CHECK_EQ(svc.managers_created, 1);
}

IWN_TEST(Camera, FourStoresRotateOldestFirstAndAKeptFrameIsNotRewritten) {
  CameraOpenResult r = open_and_wait("50", 640, 480);
  IWN_CHECK(r.stream > 0);
  std::vector<const iwn::image::PixelStore*> written;
  bool recycled = true;
  auto frame = [&] {
    fakecam::deliver_frame();
    CameraFrame f;
    IWN_CHECK(CameraService::get().latest(r.stream, &f));
    recycled = recycled && f.store->recycled();
    written.push_back(f.store.get());
  };
  for (int i = 0; i < 4; ++i) frame();
  // four stores before any is rewritten: a store the page let go of is rewritten frames later, not at the next one
  IWN_CHECK_EQ(std::set<const iwn::image::PixelStore*>(written.begin(), written.end()).size(), size_t{4});
  frame();
  frame();
  IWN_CHECK(written[4] == written[0] && written[5] == written[1]);  // the one written longest ago first
  IWN_CHECK(recycled);  // whatever keeps one of these frames gets a copy (PixelStore::recycled)
  // the page keeps the newest frame (a held handle): its store is skipped, the others keep rotating
  CameraFrame kept;
  IWN_CHECK(CameraService::get().latest(r.stream, &kept));
  const uint8_t first = kept.store->Read().view().data[0];
  for (int i = 0; i < 6; ++i) frame();
  for (size_t i = 6; i < written.size(); ++i) IWN_CHECK(written[i] != kept.store.get());
  IWN_CHECK_EQ(int{kept.store->Read().view().data[0]}, int{first});
  kept = CameraFrame{};
  CameraService::get().close(r.stream);
  drain_worker();
  IWN_CHECK_EQ(fakecam::service().devices_open, 0);
}

IWN_TEST(Camera, ShutdownRefusesAnOpenQueuedBehindAClose) {
  fakecam::Service& svc = fakecam::service();
  CameraOpenResult a = open_and_wait("50", 640, 480);
  IWN_CHECK(a.stream > 0);
  // the worker spends a while closing it (40-220 ms on Quest), and a getUserMedia's open waits behind that close
  svc.close_delay_ms = 200;
  CameraService::get().close(a.stream);
  std::promise<CameraOpenResult> done;
  std::future<CameraOpenResult> answer = done.get_future();
  CameraService::get().open("51", 640, 480, 30, [&done](CameraOpenResult r) { done.set_value(std::move(r)); });
  // the app exits meanwhile
  CameraService::get().shutdown();
  CameraOpenResult b = answer.get();
  IWN_CHECK_EQ(b.stream, 0);
  IWN_CHECK_EQ(b.error, std::string("AbortError"));
  IWN_CHECK_EQ(svc.devices_open, 0);  // nothing left open past the process (a system ANR on the next sleep)
  svc.close_delay_ms = 0;
  // an activity relaunched in this process opens cameras again
  CameraOpenResult c = open_and_wait("51", 640, 480);
  IWN_CHECK(c.stream > 0);
  CameraService::get().close(c.stream);
  drain_worker();
  IWN_CHECK_EQ(svc.devices_open, 0);
}
