/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The headset's scene model for WebXR plane detection, mesh detection and hit test (docs/spec/08 XR-AR-2): the room
// from Space Setup, read with XR_FB_spatial_entity, XR_FB_spatial_entity_query, XR_FB_spatial_entity_container,
// XR_FB_scene and XR_META_spatial_entity_mesh (no OVRPlugin, no MRUK).
//
// A query runs when a session first wants scene data (web/xr asks through sceneData()), again when the app resumes
// (the room may have changed in Space Setup meanwhile) and after a scene capture completes: rooms
// (XR_SPACE_COMPONENT_TYPE_ROOM_LAYOUT_FB), each room's contents (its container's UUIDs, queried by UUID), and for
// every entity what it has of: semantic labels, a 2D boundary (a plane, in the space's x-y plane, normal +z), a 3D
// bounding box and a triangle mesh (the global mesh). That geometry is published as an immutable snapshot the JS
// thread reads when its version changes. Every entity keeps one pose slot for the life of the process (by UUID); the
// XR thread locates every entity in the base space for each frame it hands to JS and writes the slots before the
// frame is posted, so JS reads them during the frame like the frame record, without a lock (docs/spec/09: the frame
// record's layout is not changed for this).
//
// Handles: Meta's runtime hands out the SAME XrSpace again for an entity already loaded in the session, and
// xrDestroySpace unloads the entity for every holder of that handle; so a re-query of an unchanged room returns the
// handles of the current set, and only handles no longer in use are destroyed.
//
// Failures: Quest completes a query that finds no room with XR_SUCCESS (no Space Setup: an empty scene). A query that
// completes with an error, whose results cannot be read, or whose rooms' containers cannot be read failed (USE_SCENE
// not granted, or the spatial-data service refusing the package: "ERROR_PACKAGE_UNTRUSTED" in logcat): status()
// reports "failed" with the error, and the last room stays published.
//
// Manifest: the runtime offers XR_FB_spatial_entity*, XR_FB_scene and XR_META_spatial_entity_mesh only to apps that
// declare com.oculus.permission.USE_ANCHOR_API (Quest 3, OS runtime 211: USE_SCENE alone gets none of them), so
// without it available() is false and the features are not offered. The queries also need
// com.oculus.permission.USE_SCENE, in the manifest and granted at run time: without it they fail or find nothing,
// which status() reports. Space Setup is never started from here.
//
// Sources: OpenXR 1.1 (§7 spaces, xrLocateSpace), XR_FB_spatial_entity, XR_FB_spatial_entity_query,
// XR_FB_spatial_entity_container, XR_FB_scene, XR_META_spatial_entity_mesh, XR_FB_scene_capture (its completion
// event), and the call sequence of Meta's open-source OpenXR SDK samples (XrSceneModel).
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

// One scene entity as JS sees it. Geometry is in the entity's own space.
struct SceneEntity {
  std::string id;      // UUID, 32 hex digits
  uint32_t slot = 0;   // pose slot
  std::string labels;  // XR_FB_scene labels as the runtime reports them, comma separated ("TABLE", "WALL_FACE", ...)
  std::vector<float> polygon;  // 2D boundary, x y pairs in the space's x-y plane; empty: no plane
  bool has_box = false;
  float box[6] = {0, 0, 0, 0, 0, 0};  // 3D bounding box: offset x y z (the minimum corner), extent w h d
  std::vector<float> vertices;        // triangle mesh, x y z per vertex; empty: no mesh
  std::vector<uint32_t> indices;
};

struct SceneSnapshot {
  uint32_t version = 0;
  std::vector<SceneEntity> entities;
};

class XrScene {
 public:
  // Pose slots (8 floats each: x y z, qx qy qz qw, flags with bit 0 = located this frame).
  static constexpr uint32_t kMaxSlots = 512;
  static constexpr uint32_t kSlotFloats = 8;

  // --- XR thread ---
  // Adds the scene extensions the runtime offers to `enabled` (skipping ones already there); `usable` applies the
  // runtime's debug switches.
  void choose_extensions(const std::function<bool(const char*)>& usable, std::vector<std::string>* enabled);
  void init(XrInstance instance, XrSession session, const std::vector<std::string>& enabled);
  // A WebXR session wants scene data: query unless a query ran for this session already.
  void start(const char* why);
  // The app resumed (OpenXR READY again): query again if a session wants scene data. A re-query that fails keeps
  // the last snapshot and its entities published (status() says "failed") until a later query succeeds.
  void resumed();
  // The WebXR session ended: entities stop being located; the next session queries again.
  void session_ended();
  // An event for the scene (query results and completion, component status, scene capture): true if handled.
  bool on_event(const XrEventDataBuffer& event);
  // Locates every entity in `base` at `time` into the pose slots (call before a frame is posted to JS).
  void locate(XrSpace base, XrTime time);
  void destroy();
  bool available() const { return available_; }

  // --- any thread ---
  // The latest snapshot (null before the first query finished).
  std::shared_ptr<const SceneSnapshot> snapshot();
  // The pose table: process-lifetime memory (an ArrayBuffer over it outlives an XR system restart).
  static float* poses();
  // Diagnostics (DBG-STATS xr.scene and sceneStatus()).
  Json status();
  // web/xr asked for scene data: the session wants it (the binding then has the XR thread call start()).
  bool mark_wanted() { return !wanted_.exchange(true); }

 private:
  enum class Phase { kIdle, kRooms, kContents, kReady, kFailed };
  struct Entity {
    XrSpace space = XR_NULL_HANDLE;
    XrUuidEXT uuid{};
    uint32_t slot = 0;
  };
  void query_rooms();
  void query_contents();
  void finish(XrResult result);
  // Destroys the spaces of `doomed` that are not in `keep`, each once (see Handles).
  static void destroy_unless_kept(const std::vector<Entity>& doomed, const std::vector<Entity>& keep);
  void add_entity(XrSpace space, const XrUuidEXT& uuid, SceneEntity* out);
  bool component_enabled(XrSpace space, XrSpaceComponentTypeFB type);
  void enable_locatable(XrSpace space);
  void clear_entities();
  uint32_t slot_for(const std::string& id);
  const char* result_name(XrResult r);

  XrInstance instance_ = XR_NULL_HANDLE;
  XrSession session_ = XR_NULL_HANDLE;
  bool available_ = false;
  bool has_mesh_ = false;
  bool has_capture_ = false;
  PFN_xrQuerySpacesFB query_spaces_ = nullptr;
  PFN_xrRetrieveSpaceQueryResultsFB retrieve_results_ = nullptr;
  PFN_xrGetSpaceComponentStatusFB get_component_status_ = nullptr;
  PFN_xrSetSpaceComponentStatusFB set_component_status_ = nullptr;
  PFN_xrGetSpaceContainerFB get_container_ = nullptr;
  PFN_xrGetSpaceBoundingBox2DFB get_box_2d_ = nullptr;
  PFN_xrGetSpaceBoundingBox3DFB get_box_3d_ = nullptr;
  PFN_xrGetSpaceSemanticLabelsFB get_labels_ = nullptr;
  PFN_xrGetSpaceBoundary2DFB get_boundary_ = nullptr;
  PFN_xrGetSpaceTriangleMeshMETA get_triangle_mesh_ = nullptr;

  // XR thread state
  Phase phase_ = Phase::kIdle;
  bool active_ = false;  // a session wants scene data: entities are located per frame
  XrAsyncRequestIdFB rooms_request_ = 0, contents_request_ = 0;
  XrResult step_error_ = XR_SUCCESS;  // the query step's results or rooms' containers could not be read
  std::vector<XrSpace> rooms_;
  std::vector<XrUuidEXT> contents_;
  std::vector<Entity> entities_;          // located per frame
  std::vector<Entity> pending_entities_;  // found by the query in progress
  std::vector<SceneEntity> pending_;  // geometry of the query in progress
  std::map<std::string, uint32_t> slots_;
  double query_start_ms_ = 0;
  uint32_t version_ = 0;
  std::atomic<bool> wanted_{false};

  // shared with other threads
  std::mutex mu_;
  std::shared_ptr<const SceneSnapshot> snapshot_;
  struct Status {
    std::string phase = "idle";
    std::string error;
    uint32_t queries = 0, rooms = 0, entities = 0, planes = 0, boxes = 0, meshes = 0, mesh_triangles = 0;
    double query_ms = -1;
    uint64_t located_frames = 0;
    uint32_t located_last = 0;
  } status_;
};

}  // namespace iwn::xr
