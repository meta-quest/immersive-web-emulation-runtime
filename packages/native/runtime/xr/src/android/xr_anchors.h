// Spatial anchors for WebXR (XR-ANCHOR-1): XR_FB_spatial_entity (xrCreateSpatialAnchorFB, component status, locate,
// destroy), XR_FB_spatial_entity_storage (xrSaveSpaceFB, xrEraseSpaceFB, local storage) and XR_FB_spatial_entity_query
// (load by UUID). Written from those extension specifications and the call sequences of Meta's OpenXR SDK samples
// (XrSpatialAnchor). No OVRPlugin.
//
// Threads: the JS thread asks (create, persist, restore, erase, destroy) and gets a request number back; the work runs
// on the XR thread as commands, and each request ends with one AnchorResult the JS thread collects (take_results) at
// its next frame. Every OpenXR call and every XrSpace is the XR thread's. The slot table (iwn/xr/anchors.h) is shared,
// under its lock; the pose buffer is written by locate() before the XR thread posts a frame.
//
// Each anchor of a session is destroyed when the page deletes it or its WebXR session ends (end_session()); a copy
// saved with persist() stays in the system's local anchor storage (for this app) until erase().
//
// Handles: the runtime hands out the same XrSpace again for an anchor already loaded in the session (a query for its
// UUID while it is live, or being restored), and xrDestroySpace unloads it for every holder; so a query's handle that a
// slot already owns is used through that slot, never destroyed on its own. Spaces a query loads start without the
// LOCATABLE and STORABLE components: restore enables LOCATABLE, and erase enables STORABLE first (xrEraseSpaceFB
// needs it).
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/xr/anchors.h"
#include "iwn/xr/handoff.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

struct AnchorResult {
  uint32_t request = 0;
  bool ok = false;
  uint32_t anchor = 0;  // create, restore: the anchor id
  std::string uuid;     // persist: the persisted anchor's UUID
  std::string error;
};

class XrAnchors {
 public:
  // The extensions this needs (enabled when the runtime offers them).
  static constexpr const char* kExtensions[] = {"XR_FB_spatial_entity", "XR_FB_spatial_entity_storage",
                                                "XR_FB_spatial_entity_query"};

  // --- XR thread ---
  // After xrCreateSession: loads the functions and asks the system whether it supports spatial entities. `base`: the
  // space poses are given in (the frame record's base space).
  void init(XrInstance instance, XrSystemId system, XrSession session, XrSpace base,
            const std::vector<std::string>& enabled_extensions);
  // OpenXR events: the completion events of this module's requests (others are ignored, so the scene module can see
  // the same query events).
  void on_event(const XrEventDataBuffer& event);
  // Every frame handed to JS, before it is posted: locates the live anchors at the frame's display time.
  void locate(XrTime display_time);
  // The WebXR session ended: every anchor of it is destroyed.
  void end_session();
  // Before xrDestroySession.
  void shutdown();

  // --- any thread ---
  bool supported() const { return supported_.load(std::memory_order_acquire); }
  bool persistence() const { return persistence_.load(std::memory_order_acquire); }
  float* poses() { return table_.poses(); }
  static constexpr size_t pose_bytes() { return AnchorTable::pose_bytes(); }

  // --- JS thread: each returns a request number (the AnchorResult carries it), 0 when refused at once ---
  void set_queue(CommandQueue* queue) { queue_ = queue; }
  uint32_t create(const XrPosef& pose);
  uint32_t persist(uint32_t anchor);
  uint32_t restore(const std::string& uuid);
  uint32_t erase(const std::string& uuid);
  void destroy(uint32_t anchor);
  // Moves finished requests into `out`; false when there were none (no allocation then).
  bool take_results(std::vector<AnchorResult>* out);
  Json stats();
  // After the XR thread stopped (same-process relaunch): nothing pending, every slot free.
  void reset();

 private:
  enum class Op : uint8_t { kCreate, kStorable, kSave, kRestoreQuery, kLocatable, kEraseQuery, kEraseStorable, kErase };
  struct Pending {
    Op op;
    uint32_t request = 0;
    uint32_t anchor = 0;         // the slot's id (0: none, e.g. an erase of an anchor this session never loaded)
    XrSpace space = XR_NULL_HANDLE;  // kEraseQuery / kEraseStorable / kErase without a slot: the space loaded for it
    XrUuidEXT uuid{};
    bool duplicate = false;  // kRestoreQuery: the anchor came back as another slot's space (restored twice)
  };
  struct Slot {  // XR thread only
    XrSpace space = XR_NULL_HANDLE;
    XrUuidEXT uuid{};
    int busy = 0;  // requests in flight that use the space (a release waits for them)
  };

  uint32_t next_request();
  bool post(std::function<void()> work);
  void finish(const AnchorResult& r);
  void fail(uint32_t request, uint32_t anchor, const std::string& why);
  const char* result_name(XrResult r);
  // XR thread
  void do_create(uint32_t request, uint32_t anchor, XrPosef pose);
  void do_persist(uint32_t request, uint32_t anchor);
  void do_save(uint32_t request, uint32_t anchor);
  void do_restore(uint32_t request, uint32_t anchor, XrUuidEXT uuid);
  void do_erase(uint32_t request, XrUuidEXT uuid);
  // STORABLE enabled, then xrEraseSpaceFB: on a slot's space (`anchor` != 0) or one loaded for the erase.
  void start_erase(uint32_t request, uint32_t anchor, XrSpace space, XrUuidEXT uuid);
  void erase_space(uint32_t request, uint32_t anchor, XrSpace space, XrUuidEXT uuid);
  // The id of the slot whose space `space` is (any state), else 0.
  uint32_t owner_of(XrSpace space) const;
  void restored(uint32_t request, uint32_t anchor);
  void settle(uint32_t anchor);  // after a request on the slot ended: carries out a release that waited for it
  void destroy_slot(uint32_t anchor);
  bool enable_component(uint32_t request, uint32_t anchor, XrSpace space, XrSpaceComponentTypeFB type, Op op,
                        bool* already, const XrUuidEXT* uuid = nullptr);
  void on_query_results(XrAsyncRequestIdFB id);
  void on_query_complete(XrAsyncRequestIdFB id, XrResult result);

  XrInstance instance_ = XR_NULL_HANDLE;
  XrSession session_ = XR_NULL_HANDLE;
  XrSpace base_ = XR_NULL_HANDLE;
  XrTime last_time_ = 0;
  std::atomic<bool> supported_{false};
  std::atomic<bool> persistence_{false};
  CommandQueue* queue_ = nullptr;

  PFN_xrCreateSpatialAnchorFB create_anchor_ = nullptr;
  PFN_xrGetSpaceUuidFB get_uuid_ = nullptr;
  PFN_xrGetSpaceComponentStatusFB get_status_ = nullptr;
  PFN_xrSetSpaceComponentStatusFB set_status_ = nullptr;
  PFN_xrSaveSpaceFB save_space_ = nullptr;
  PFN_xrEraseSpaceFB erase_space_ = nullptr;
  PFN_xrQuerySpacesFB query_spaces_ = nullptr;
  PFN_xrRetrieveSpaceQueryResultsFB retrieve_results_ = nullptr;

  AnchorTable table_;
  Slot slots_[kMaxAnchors];
  std::unordered_map<XrAsyncRequestIdFB, Pending> pending_;  // XR thread
  std::atomic<uint32_t> requests_{0};

  std::mutex results_mu_;
  std::vector<AnchorResult> results_;
  std::atomic<bool> results_ready_{false};

  // stats (XR thread writes, stats() reads under stats_mu_)
  std::mutex stats_mu_;
  uint64_t created_ = 0, persisted_ = 0, restored_ = 0, erased_ = 0, destroyed_ = 0, failed_ = 0, lost_frames_ = 0;
  std::string last_error_;
};

}  // namespace iwn::xr
