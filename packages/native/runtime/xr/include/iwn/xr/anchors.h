// Spatial anchors, the V8-free and OpenXR-call-free part (XR-ANCHOR-1): the slot table the JS thread and the XR thread
// share, the pose buffer JS reads every frame, and the UUID text form. The Android side (android/xr_anchors.h) makes
// the OpenXR calls (XR_FB_spatial_entity, _storage, _query) and keeps the handles; this part is unit-tested on the host.
//
// Pose buffer (JS: natives.anchorPoses(), a Float32Array view of the same memory every frame): kAnchorStride floats
// per slot, [flags, px, py, pz, qx, qy, qz, qw], the pose in the base space; flags 1 = located this frame, 0 = not
// (tracking lost, or the slot holds no anchor). The XR thread writes it before it posts a frame, like the frame record
// (XRF-2), so JS reads it inside a frame without a lock.
//
// Anchor ids: slot | generation << 8. A slot freed and taken again gets a new generation, so an id kept by a page
// whose session already ended (or a late destroy) never reaches the anchor that took its slot.
#pragma once

#include <cstdint>
#include <mutex>
#include <string>

#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

inline constexpr int kMaxAnchors = 64;
inline constexpr int kAnchorStride = 8;

// 16 bytes -> "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (lower case), the form Quest Browser's persistent handles have.
std::string format_uuid(const uint8_t bytes[16]);
// The reverse; upper or lower case. False (out untouched) for anything else.
bool parse_uuid(const std::string& text, uint8_t out[16]);

inline int anchor_slot(uint32_t id) { return static_cast<int>(id & 0xFF); }

class AnchorTable {
 public:
  enum class State : uint8_t {
    kFree,       // no anchor
    kPending,    // taken for a create or restore the XR thread has not finished
    kLive,       // holds a located anchor
    kReleasing,  // JS let it go (or the session ended) while the XR thread still has work on it
  };

  AnchorTable();

  // --- either thread (locked) ---
  // A free slot for a new anchor: kPending, returns its id, or 0 when every slot is taken.
  uint32_t reserve();
  // The id's slot, if the id is current (same generation, not free): its state, else kFree.
  State state(uint32_t id) const;
  // kPending -> kLive. False when the id is stale or the slot is no longer pending (released meanwhile).
  bool go_live(uint32_t id);
  // Marks the anchor released: kPending/kLive -> kReleasing. False for a stale id or a free slot.
  bool release(uint32_t id);
  // Back to kFree (the XR thread destroyed whatever the slot held); the pose is cleared.
  void free(uint32_t id);
  // Every non-free slot -> kReleasing (the WebXR session ended).
  int release_all();
  // The current id of a slot (any state).
  uint32_t id_of(int slot) const;
  int live_count() const;
  // Every slot free and every pose cleared (generations go on), for a new XR thread after the old one was joined.
  void clear();

  // --- pose buffer (XR thread writes, JS reads within a frame) ---
  float* poses() { return poses_; }
  static constexpr size_t pose_bytes() { return sizeof(float) * kMaxAnchors * kAnchorStride; }
  void write_pose(int slot, const XrPosef& pose, bool located);

 private:
  bool current(uint32_t id) const;
  mutable std::mutex mu_;
  State state_[kMaxAnchors];
  uint32_t gen_[kMaxAnchors];
  alignas(16) float poses_[kMaxAnchors * kAnchorStride];
};

}  // namespace iwn::xr
