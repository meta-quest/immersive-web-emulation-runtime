/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/layers.h"

#include <cmath>
#include <cstring>

namespace iwn::xr::layers {

namespace {

float f32(uint32_t word) {
  float f;
  std::memcpy(&f, &word, sizeof f);
  return f;
}

uint32_t u32(float f) {
  uint32_t w;
  std::memcpy(&w, &f, sizeof w);
  return w;
}

}  // namespace

int read_entries(const uint32_t* words, Entry out[kMaxEntries]) {
  if (words[kVersionAt] != kVersion) return -1;
  const uint32_t count = words[kCountAt];
  if (count == kNoList) return -1;
  int n = 0;
  for (uint32_t i = 0; i < count && i < kMaxEntries; ++i) {
    const uint32_t* w = words + kEntriesAt + i * kEntryWords;
    if (w[kKind] < kProjection || w[kKind] > kCylinder || w[kLayout] > kStereoArray) continue;
    Entry& e = out[n++];
    e.kind = static_cast<Kind>(w[kKind]);
    e.id = w[kId];
    e.flags = w[kFlags];
    e.layout = static_cast<Layout>(w[kLayout]);
    for (int k = 0; k < 7; ++k) e.pose[k] = f32(w[kPose + k]);
    e.a = f32(w[kA]);
    e.b = f32(w[kB]);
    e.c = f32(w[kC]);
  }
  return n;
}

void write_entry(uint32_t* words, uint32_t index, const Entry& e) {
  uint32_t* w = words + kEntriesAt + index * kEntryWords;
  w[kKind] = e.kind;
  w[kId] = e.id;
  w[kFlags] = e.flags;
  w[kLayout] = e.layout;
  for (int k = 0; k < 7; ++k) w[kPose + k] = u32(e.pose[k]);
  w[kA] = u32(e.a);
  w[kB] = u32(e.b);
  w[kC] = u32(e.c);
}

uint32_t entry_views(Layout layout, uint32_t w, uint32_t h, EntryView out[2]) {
  const int32_t iw = static_cast<int32_t>(w), ih = static_cast<int32_t>(h);
  switch (layout) {
    case kStereoLeftRight: {
      const int32_t half = iw / 2;
      out[0] = {1, 0, 0, half, ih, 0};
      out[1] = {2, half, 0, iw - half, ih, 0};
      return 2;
    }
    case kStereoTopBottom: {
      // WebXR: the left eye is the top half, which with GL's bottom-left origin is the upper rows
      const int32_t half = ih / 2;
      out[0] = {1, 0, ih - half, iw, half, 0};
      out[1] = {2, 0, 0, iw, ih - half, 0};
      return 2;
    }
    case kStereoArray:
      out[0] = {1, 0, 0, iw, ih, 0};
      out[1] = {2, 0, 0, iw, ih, 1};
      return 2;
    case kMono:
    default:
      out[0] = {0, 0, 0, iw, ih, 0};
      return 1;
  }
}

void image_size(Layout layout, uint32_t view_w, uint32_t view_h, uint32_t* w, uint32_t* h, uint32_t* array_size) {
  *w = layout == kStereoLeftRight ? view_w * 2 : view_w;
  *h = layout == kStereoTopBottom ? view_h * 2 : view_h;
  *array_size = layout == kStereoArray ? 2 : 1;
}

bool valid_pose(const float pose[7]) {
  for (int k = 0; k < 7; ++k) {
    if (!std::isfinite(pose[k])) return false;
  }
  const double len2 = static_cast<double>(pose[3]) * pose[3] + static_cast<double>(pose[4]) * pose[4] +
                      static_cast<double>(pose[5]) * pose[5] + static_cast<double>(pose[6]) * pose[6];
  return std::fabs(len2 - 1.0) < 0.02;
}

bool valid_shape(const Entry& e) {
  if (!std::isfinite(e.a) || !std::isfinite(e.b)) return false;
  if (e.kind == kQuad) return e.a > 0 && e.b > 0;
  if (e.kind == kCylinder) {
    return e.a > 0 && e.b > 0 && e.b <= 6.2831855f && std::isfinite(e.c) && e.c > 0;
  }
  return true;
}

int collect(const Entry* list, int n, SlotState slots[kMaxSwapchains], uint32_t* release, Entry plan[kMaxEntries]) {
  *release = 0;
  // Redrawn layers, listed or not: the image the page drew becomes the content.
  for (int i = 0; i < n; ++i) {
    const Entry& e = list[i];
    if (e.kind == kProjection || !(e.flags & kRedrawn) || e.id == 0 || e.id > kMaxSwapchains) continue;
    SlotState& s = slots[e.id - 1];
    if (!s.live || !s.held) continue;
    *release |= 1u << (e.id - 1);
    s.held = false;
    s.released_once = true;
    if (s.is_static) s.static_done = true;
  }
  // The plan: the listed layers in order that can be shown.
  int count = 0;
  for (int i = 0; i < n && count < static_cast<int>(kMaxEntries); ++i) {
    const Entry& e = list[i];
    if (!(e.flags & kListed)) continue;
    if (e.kind != kProjection) {
      if (e.id == 0 || e.id > kMaxSwapchains) continue;
      const SlotState& s = slots[e.id - 1];
      if (!s.live || !s.released_once || s.kind != e.kind) continue;
      if (!(e.flags & kLocated) || !valid_pose(e.pose) || !valid_shape(e)) continue;
    }
    plan[count++] = e;
  }
  return count;
}

bool plan_has_content(const Entry* plan, int count) {
  for (int i = 0; i < count; ++i) {
    if (plan[i].kind != kProjection) return true;
  }
  return false;
}

bool content_under_projection(const Entry* plan, int count) {
  bool content = false;
  for (int i = 0; i < count; ++i) {
    if (plan[i].kind == kProjection) return content;
    content = true;
  }
  return false;
}

}  // namespace iwn::xr::layers
