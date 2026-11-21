// A fake OpenXR runtime for the host tests of the XR thread's spatial-entity code (src/android/xr_scene.cc), which
// makes OpenXR calls only. It behaves as Meta's mobile runtime does where that code depends on it:
//   - a LOAD query returns the SAME XrSpace for an entity already loaded in the session (XrRuntimeSystem_Client
//     GetXrSpaceFromSpatialAnchorMap; AnchorFrameworkHelper mergeAnchorWithRecord), and xrDestroySpace unloads the
//     entity and invalidates that handle (OpenXR_Space.cpp), so a destroyed handle is dead for every holder;
//   - handles are never reused (monotonically increasing), so a dead handle stays dead;
//   - a query posts XrEventDataSpaceQueryResultsAvailableFB (unless it found nothing) and then
//     XrEventDataSpaceQueryCompleteFB with the query's result; an empty room query completes with XR_SUCCESS;
//   - spaces a query loads start with LOCATABLE disabled (xrSetSpaceComponentStatusFB enables it, with its event).
// Tests set up `world()` and the failure knobs, call into the code under test and pump the events into it.
#pragma once

#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "iwn/xr/openxr_headers.h"

namespace fakexr {

struct Entity {
  XrUuidEXT uuid{};
  bool room = false;         // has ROOM_LAYOUT and SPACE_CONTAINER (its container lists every non-room entity)
  std::string labels;        // SEMANTIC_LABELS (empty: no component)
  bool plane = false;        // BOUNDED_2D: a 2x2 m boundary
  bool box = false;          // BOUNDED_3D
  bool mesh = false;         // TRIANGLE_MESH_META: one triangle
  XrPosef pose{{0, 0, 0, 1}, {0, 0, 0}};
};

struct Runtime {
  std::vector<Entity> world;
  // knobs
  XrResult room_query_result = XR_SUCCESS;  // what the rooms query completes with (an error: no results either)
  bool fail_retrieve = false;               // xrRetrieveSpaceQueryResultsFB fails
  bool fail_container = false;              // xrGetSpaceContainerFB fails
  // what happened
  int destroyed_live = 0, destroyed_dead = 0, located_dead = 0;
  std::deque<XrEventDataBuffer> events;
};

// The runtime the global entry points below act on (reset by reset()).
Runtime& runtime();
void reset();
XrUuidEXT uuid(uint8_t n);
// Handles alive now.
int live_handles();

// Delivers every queued event to `handler`, also those posted while it runs.
void pump(const std::function<void(const XrEventDataBuffer&)>& handler);

inline const XrInstance kInstance = reinterpret_cast<XrInstance>(uintptr_t{0x1});
inline const XrSession kSession = reinterpret_cast<XrSession>(uintptr_t{0x2});
inline const XrSpace kBase = reinterpret_cast<XrSpace>(uintptr_t{0x3});

}  // namespace fakexr
