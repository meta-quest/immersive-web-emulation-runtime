/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Composition layers (WebXR Layers quad and cylinder layers, docs/spec/08 XR-LAYER-1): the buffer the adapter
// (web/xr/src/layers.ts) and the XR thread share for them, the pure part of turning one entry into OpenXR layer
// parameters, and the bookkeeping of a frame's list (which images become content, which layers can be shown).
// V8-free and OpenXR-call-free, so it is unit-tested on the host; the XR thread owns the swapchains and builds the
// OpenXR structs (src/android/xr_layers.cc).
//
// The buffer is not the frame record (XRF-*, whose layout stays fixed): 32-bit words, read and written as u32 and f32.
//   [kVersionAt]       kVersion, written by the native side; the adapter checks it once (as XRF-4 does the record's)
//   [kCountAt]         JS, each XR frame: the number of entries of the frame's layer list, kNoList when the frame has
//                      none (an XRWebGLLayer session, no renderState.layers): the projection layer alone then
//   [kNamesAt + slot]  XR thread, before it posts a frame (or in acquireLayerImage): the GL name of the image the page
//                      draws layer swapchain `slot` (id - 1) into next, 0 for none
//   [kEntriesAt ...]   JS: kMaxEntries entries of kEntryWords words, in renderState.layers order (listed ones), then
//                      the layers the page drew without listing them
// Synchronisation: the JS thread writes the list inside the frame and the XR thread reads it once the frame is done
// (FrameSlot kDone); the XR thread writes names before it posts the frame or inside a blocking command.
#pragma once

#include <cstdint>

namespace iwn::xr::layers {

constexpr uint32_t kVersion = 1;
constexpr uint32_t kMaxSwapchains = 16;  // live layer swapchains; a swapchain's id is its slot + 1
constexpr uint32_t kMaxEntries = 16;     // entries of one frame's list
constexpr uint32_t kEntryWords = 16;
constexpr uint32_t kNoList = 0xFFFFFFFFu;

constexpr uint32_t kVersionAt = 0;
constexpr uint32_t kCountAt = 1;
constexpr uint32_t kNamesAt = 4;
constexpr uint32_t kEntriesAt = kNamesAt + kMaxSwapchains;
constexpr uint32_t kWords = kEntriesAt + kMaxEntries * kEntryWords;

// Word offsets inside an entry. kPose: 7 f32 (x, y, z, quaternion x, y, z, w). kA, kB, kC: f32 shape, a quad's full
// width and height in metres; a cylinder's radius, central angle and aspect ratio.
enum EntryWord : uint32_t { kKind = 0, kId = 1, kFlags = 2, kLayout = 3, kPose = 4, kA = 11, kB = 12, kC = 13 };

enum Kind : uint32_t { kProjection = 1, kQuad = 2, kCylinder = 3 };

enum Flag : uint32_t {
  kListed = 1,      // in renderState.layers: shown
  kRedrawn = 2,     // the page drew the layer this frame (getSubImage): its image becomes the current one
  kBlendAlpha = 4,  // blendTextureSourceAlpha (premultiplied)
  kViewer = 8,      // the pose is in the viewer (VIEW) space, not the base space: a head-locked layer
  kLocated = 16,    // the layer's space was located this frame
};

// How the views share the swapchain image (WebXR XRLayerLayout as resolved by IWER).
enum Layout : uint32_t { kMono = 0, kStereoLeftRight = 1, kStereoTopBottom = 2, kStereoArray = 3 };

struct Entry {
  Kind kind = kProjection;
  uint32_t id = 0;
  uint32_t flags = 0;
  Layout layout = kMono;
  float pose[7] = {0, 0, 0, 0, 0, 0, 1};
  float a = 0, b = 0, c = 0;
};

// The frame's list from the buffer: the number of entries written to `out` (at most kMaxEntries; entries of an
// unknown kind or layout are dropped), or -1 when the frame has no list (kNoList, or a buffer of another version).
int read_entries(const uint32_t* words, Entry out[kMaxEntries]);

// What the adapter writes for one entry (tests, and the native side's own checks).
void write_entry(uint32_t* words, uint32_t index, const Entry& e);

// One view of an entry inside a swapchain image of `w` x `h` (GL's bottom-left origin): the eye it is shown to
// (0 both, 1 left, 2 right), its rectangle and array layer.
struct EntryView {
  int eye = 0;
  int32_t x = 0, y = 0, w = 0, h = 0;
  uint32_t array_index = 0;
};
// Mono: one view of the whole image for both eyes; stereo layouts: one per eye. Returns the number of views.
uint32_t entry_views(Layout layout, uint32_t w, uint32_t h, EntryView out[2]);

// The image size a layout needs for views of `view_w` x `view_h` pixels, and its array size.
void image_size(Layout layout, uint32_t view_w, uint32_t view_h, uint32_t* w, uint32_t* h, uint32_t* array_size);

// A pose OpenXR accepts: finite, with a unit quaternion (within 1 %; it is renormalised before submission).
bool valid_pose(const float pose[7]);
// A shape OpenXR accepts: a quad with positive finite size; a cylinder with a positive radius and aspect ratio and a
// central angle in (0, 2 pi].
bool valid_shape(const Entry& e);

// What the XR thread keeps per layer swapchain slot that decides what a frame's list does (collect()).
struct SlotState {
  bool live = false;           // a swapchain the page has not destroyed
  Kind kind = kQuad;
  bool held = false;           // an image is acquired and waited: the page draws into it next
  bool released_once = false;  // an image was released: the compositor has content to show
  bool is_static = false;
  bool static_done = false;    // a static image was released: never acquired again
};

// A frame's list once its GL work is fenced (CompositionLayers::collect()). Every redrawn quad or cylinder entry
// whose slot holds an image sets the slot's bit in `*release`: that image becomes the layer's content (OpenXR 1.1
// §9.4: the most recently released image is shown), and the slot's state is updated as released. `plan` gets the
// listed entries that can be shown, in list order: the projection layer, and quad and cylinder layers that have
// content, a located pose and a shape OpenXR accepts. Returns the plan's size (0 for `n` < 0, no list).
int collect(const Entry* list, int n, SlotState slots[kMaxSwapchains], uint32_t* release, Entry plan[kMaxEntries]);

// The plan shows quad or cylinder content: a session showing only such layers presents (it ends the loading screen).
bool plan_has_content(const Entry* plan, int count);

// Quad or cylinder content comes before (under) the projection layer: the projection layer then blends by its alpha,
// or that content would never show (Chromium blends projection layers by default).
bool content_under_projection(const Entry* plan, int count);

}  // namespace iwn::xr::layers
