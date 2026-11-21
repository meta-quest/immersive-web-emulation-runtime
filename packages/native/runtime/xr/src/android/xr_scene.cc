/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The scene model for plane detection, mesh detection and hit test (see xr_scene.h). XR thread, except where noted.
#include "android/xr_scene.h"

#include <algorithm>
#include <cstring>
#include <set>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"

namespace iwn::xr {

namespace {

template <typename F>
void load(XrInstance instance, const char* name, F* fn) {
  *fn = nullptr;
  xrGetInstanceProcAddr(instance, name, reinterpret_cast<PFN_xrVoidFunction*>(fn));
}

bool has(const std::vector<std::string>& list, const char* e) {
  return std::find(list.begin(), list.end(), e) != list.end();
}

std::string uuid_hex(const XrUuidEXT& u) {
  static const char* digits = "0123456789abcdef";
  std::string s(32, '0');
  for (int i = 0; i < XR_UUID_SIZE; ++i) {
    s[i * 2] = digits[u.data[i] >> 4];
    s[i * 2 + 1] = digits[u.data[i] & 15];
  }
  return s;
}

// The labels this runtime understands (XR_FB_scene spec version 2+): without the list the runtime reports labels
// added after version 1 as OTHER. DESK is migrated to TABLE and invisible walls are reported (Quest Browser shows
// them as walls).
constexpr const char* kRecognizedLabels =
    "TABLE,COUCH,FLOOR,CEILING,WALL_FACE,WINDOW_FRAME,DOOR_FRAME,STORAGE,BED,SCREEN,LAMP,PLANT,WALL_ART,"
    "GLOBAL_MESH,INVISIBLE_WALL_FACE,OTHER";

// Upper bound for one room query's results (Meta's samples ask for 100; larger counts fail validation on Quest).
constexpr uint32_t kMaxRooms = 100;

}  // namespace

float* XrScene::poses() {
  alignas(16) static float table[kMaxSlots * kSlotFloats] = {};
  return table;
}

void XrScene::choose_extensions(const std::function<bool(const char*)>& usable, std::vector<std::string>* enabled) {
  // The four that make a room readable, all or none; the room mesh and scene capture's event when offered. None of
  // them is offered without com.oculus.permission.USE_ANCHOR_API in the manifest (xr_scene.h).
  const char* core[] = {XR_FB_SPATIAL_ENTITY_EXTENSION_NAME, XR_FB_SPATIAL_ENTITY_QUERY_EXTENSION_NAME,
                        XR_FB_SPATIAL_ENTITY_CONTAINER_EXTENSION_NAME, XR_FB_SCENE_EXTENSION_NAME};
  for (const char* e : core) {
    if (!has(*enabled, e) && !usable(e)) return;
  }
  for (const char* e : core) {
    if (!has(*enabled, e)) enabled->push_back(e);
  }
  for (const char* e : {XR_META_SPATIAL_ENTITY_MESH_EXTENSION_NAME, XR_FB_SCENE_CAPTURE_EXTENSION_NAME}) {
    if (!has(*enabled, e) && usable(e)) enabled->push_back(e);
  }
}

void XrScene::init(XrInstance instance, XrSession session, const std::vector<std::string>& enabled) {
  instance_ = instance;
  session_ = session;
  if (!has(enabled, XR_FB_SCENE_EXTENSION_NAME) || !has(enabled, XR_FB_SPATIAL_ENTITY_QUERY_EXTENSION_NAME)) return;
  load(instance, "xrQuerySpacesFB", &query_spaces_);
  load(instance, "xrRetrieveSpaceQueryResultsFB", &retrieve_results_);
  load(instance, "xrGetSpaceComponentStatusFB", &get_component_status_);
  load(instance, "xrSetSpaceComponentStatusFB", &set_component_status_);
  load(instance, "xrGetSpaceContainerFB", &get_container_);
  load(instance, "xrGetSpaceBoundingBox2DFB", &get_box_2d_);
  load(instance, "xrGetSpaceBoundingBox3DFB", &get_box_3d_);
  load(instance, "xrGetSpaceSemanticLabelsFB", &get_labels_);
  load(instance, "xrGetSpaceBoundary2DFB", &get_boundary_);
  if (has(enabled, XR_META_SPATIAL_ENTITY_MESH_EXTENSION_NAME)) {
    load(instance, "xrGetSpaceTriangleMeshMETA", &get_triangle_mesh_);
  }
  has_mesh_ = get_triangle_mesh_ != nullptr;
  has_capture_ = has(enabled, XR_FB_SCENE_CAPTURE_EXTENSION_NAME);
  available_ = query_spaces_ && retrieve_results_ && get_component_status_ && get_container_ && get_labels_ &&
               get_boundary_ && get_box_3d_;
  std::lock_guard<std::mutex> lock(mu_);
  status_.phase = available_ ? "idle" : "unavailable";
}

const char* XrScene::result_name(XrResult r) {
  static thread_local char buf[XR_MAX_RESULT_STRING_SIZE];
  if (instance_ == XR_NULL_HANDLE || XR_FAILED(xrResultToString(instance_, r, buf))) {
    std::snprintf(buf, sizeof(buf), "XrResult(%d)", r);
  }
  return buf;
}

void XrScene::start(const char* why) {
  wanted_.store(true);
  if (!available_) return;
  const bool first = !active_;
  active_ = true;
  if (!first || phase_ == Phase::kRooms || phase_ == Phase::kContents) return;  // this session's query ran or runs
  log(LogLevel::kInfo, "xr: scene: querying the room (%s)", why);
  query_rooms();
}

void XrScene::resumed() {
  if (!available_ || !active_ || phase_ == Phase::kRooms || phase_ == Phase::kContents) return;
  log(LogLevel::kInfo, "xr: scene: querying the room again (resumed)");
  query_rooms();
}

void XrScene::session_ended() {
  active_ = false;
  wanted_.store(false);
}

void XrScene::query_rooms() {
  // Rooms first: each room's container lists the entities Space Setup made for it (XrSceneModel's sequence).
  // The runtime wants the storage location with the filter (XR_ERROR_VALIDATION_FAILURE without it on Quest 3).
  XrSpaceStorageLocationFilterInfoFB local{XR_TYPE_SPACE_STORAGE_LOCATION_FILTER_INFO_FB};
  local.location = XR_SPACE_STORAGE_LOCATION_LOCAL_FB;
  XrSpaceComponentFilterInfoFB filter{XR_TYPE_SPACE_COMPONENT_FILTER_INFO_FB};
  filter.next = &local;
  filter.componentType = XR_SPACE_COMPONENT_TYPE_ROOM_LAYOUT_FB;
  XrSpaceQueryInfoFB qi{XR_TYPE_SPACE_QUERY_INFO_FB};
  qi.queryAction = XR_SPACE_QUERY_ACTION_LOAD_FB;
  qi.maxResultCount = kMaxRooms;
  qi.timeout = 0;  // the runtime's default
  qi.filter = reinterpret_cast<const XrSpaceFilterInfoBaseHeaderFB*>(&filter);
  for (XrSpace s : rooms_) xrDestroySpace(s);
  rooms_.clear();
  contents_.clear();
  pending_.clear();
  destroy_unless_kept(pending_entities_, entities_);
  pending_entities_.clear();
  step_error_ = XR_SUCCESS;
  query_start_ms_ = now_ms();
  const XrResult r =
      query_spaces_(session_, reinterpret_cast<const XrSpaceQueryInfoBaseHeaderFB*>(&qi), &rooms_request_);
  {
    std::lock_guard<std::mutex> lock(mu_);
    ++status_.queries;
  }
  if (XR_FAILED(r)) {
    finish(r);
    return;
  }
  phase_ = Phase::kRooms;
  std::lock_guard<std::mutex> lock(mu_);
  status_.phase = "querying";
  status_.error.clear();
}

void XrScene::query_contents() {
  XrSpaceStorageLocationFilterInfoFB local{XR_TYPE_SPACE_STORAGE_LOCATION_FILTER_INFO_FB};
  local.location = XR_SPACE_STORAGE_LOCATION_LOCAL_FB;
  XrSpaceUuidFilterInfoFB filter{XR_TYPE_SPACE_UUID_FILTER_INFO_FB};
  filter.next = &local;
  filter.uuidCount = static_cast<uint32_t>(contents_.size());
  filter.uuids = contents_.data();
  XrSpaceQueryInfoFB qi{XR_TYPE_SPACE_QUERY_INFO_FB};
  qi.queryAction = XR_SPACE_QUERY_ACTION_LOAD_FB;
  qi.maxResultCount = static_cast<uint32_t>(contents_.size());
  qi.timeout = 0;
  qi.filter = reinterpret_cast<const XrSpaceFilterInfoBaseHeaderFB*>(&filter);
  step_error_ = XR_SUCCESS;
  const XrResult r =
      query_spaces_(session_, reinterpret_cast<const XrSpaceQueryInfoBaseHeaderFB*>(&qi), &contents_request_);
  if (XR_FAILED(r)) {
    finish(r);
    return;
  }
  phase_ = Phase::kContents;
}

bool XrScene::on_event(const XrEventDataBuffer& event) {
  if (!available_) return false;
  switch (event.type) {
    case XR_TYPE_EVENT_DATA_SPACE_QUERY_RESULTS_AVAILABLE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpaceQueryResultsAvailableFB&>(event);
      const bool rooms = phase_ == Phase::kRooms && e.requestId == rooms_request_;
      const bool contents = phase_ == Phase::kContents && e.requestId == contents_request_;
      if (!rooms && !contents) return false;  // another feature's query (anchors)
      XrSpaceQueryResultsFB results{XR_TYPE_SPACE_QUERY_RESULTS_FB};
      XrResult r = retrieve_results_(session_, e.requestId, &results);
      std::vector<XrSpaceQueryResultFB> list(results.resultCountOutput);
      if (XR_SUCCEEDED(r) && !list.empty()) {
        results.resultCapacityInput = static_cast<uint32_t>(list.size());
        results.results = list.data();
        r = retrieve_results_(session_, e.requestId, &results);
        list.resize(XR_SUCCEEDED(r) ? results.resultCountOutput : 0);
      }
      if (XR_FAILED(r)) {
        // the step fails when it completes (the last room stays published)
        log(LogLevel::kWarn, "xr: scene: xrRetrieveSpaceQueryResultsFB: %s", result_name(r));
        step_error_ = r;
        return true;
      }
      if (rooms) {
        std::set<std::string> seen;
        for (const XrUuidEXT& u : contents_) seen.insert(uuid_hex(u));
        for (const XrSpaceQueryResultFB& res : list) {
          rooms_.push_back(res.space);
          XrSpaceContainerFB c{XR_TYPE_SPACE_CONTAINER_FB};
          XrResult cr = get_container_(session_, res.space, &c);
          if (XR_SUCCEEDED(cr) && c.uuidCountOutput == 0) continue;  // an empty room
          std::vector<XrUuidEXT> uuids(c.uuidCountOutput);
          c.uuidCapacityInput = c.uuidCountOutput;
          c.uuids = uuids.data();
          if (XR_SUCCEEDED(cr)) cr = get_container_(session_, res.space, &c);
          if (XR_FAILED(cr)) {
            log(LogLevel::kWarn, "xr: scene: a room's contents (xrGetSpaceContainerFB): %s", result_name(cr));
            step_error_ = cr;
            continue;
          }
          uuids.resize(c.uuidCountOutput);
          for (const XrUuidEXT& u : uuids) {
            if (seen.insert(uuid_hex(u)).second) contents_.push_back(u);
          }
        }
      } else {
        for (const XrSpaceQueryResultFB& res : list) {
          SceneEntity geometry;
          add_entity(res.space, res.uuid, &geometry);
          pending_.push_back(std::move(geometry));
        }
      }
      return true;
    }
    case XR_TYPE_EVENT_DATA_SPACE_QUERY_COMPLETE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpaceQueryCompleteFB&>(event);
      if (phase_ == Phase::kRooms && e.requestId == rooms_request_) {
        // Quest completes a query that finds no room with XR_SUCCESS (no Space Setup: an empty scene). An error is a
        // refusal (see Failures in xr_scene.h), and so is a room whose contents could not be read when none could.
        if (XR_FAILED(e.result)) {
          finish(e.result);
        } else if (!contents_.empty()) {
          query_contents();
        } else {
          finish(step_error_);
        }
        return true;
      }
      if (phase_ == Phase::kContents && e.requestId == contents_request_) {
        finish(XR_FAILED(e.result) ? e.result : step_error_);
        return true;
      }
      return false;
    }
    case XR_TYPE_EVENT_DATA_SPACE_SET_STATUS_COMPLETE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpaceSetStatusCompleteFB&>(event);
      const auto mine = [&](const std::vector<Entity>& list) {
        return std::any_of(list.begin(), list.end(), [&](const Entity& en) { return en.space == e.space; });
      };
      if (!mine(entities_) && !mine(pending_entities_)) return false;
      if (XR_FAILED(e.result)) {
        log(LogLevel::kWarn, "xr: scene: enabling an entity's locatable component failed: %s", result_name(e.result));
      }
      return true;
    }
    case XR_TYPE_EVENT_DATA_SCENE_CAPTURE_COMPLETE_FB:
      // Space Setup ran (started by someone else: this runtime never asks for it): the room may be new.
      if (active_ && phase_ != Phase::kRooms && phase_ != Phase::kContents) {
        log(LogLevel::kInfo, "xr: scene: scene capture completed; querying the room again");
        query_rooms();
      }
      return false;  // not ours alone
    default:
      return false;
  }
}

bool XrScene::component_enabled(XrSpace space, XrSpaceComponentTypeFB type) {
  XrSpaceComponentStatusFB st{XR_TYPE_SPACE_COMPONENT_STATUS_FB};
  return XR_SUCCEEDED(get_component_status_(space, type, &st)) && st.enabled == XR_TRUE;
}

void XrScene::enable_locatable(XrSpace space) {
  XrSpaceComponentStatusFB st{XR_TYPE_SPACE_COMPONENT_STATUS_FB};
  if (XR_FAILED(get_component_status_(space, XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB, &st))) return;
  if (st.enabled == XR_TRUE || st.changePending == XR_TRUE || !set_component_status_) return;
  XrSpaceComponentStatusSetInfoFB si{XR_TYPE_SPACE_COMPONENT_STATUS_SET_INFO_FB};
  si.componentType = XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB;
  si.enabled = XR_TRUE;
  si.timeout = 0;
  XrAsyncRequestIdFB id = 0;
  set_component_status_(space, &si, &id);
}

void XrScene::add_entity(XrSpace space, const XrUuidEXT& uuid, SceneEntity* out) {
  out->id = uuid_hex(uuid);
  out->slot = slot_for(out->id);
  enable_locatable(space);
  if (component_enabled(space, XR_SPACE_COMPONENT_TYPE_SEMANTIC_LABELS_FB)) {
    XrSemanticLabelsSupportInfoFB support{XR_TYPE_SEMANTIC_LABELS_SUPPORT_INFO_FB};
    support.flags = XR_SEMANTIC_LABELS_SUPPORT_MULTIPLE_SEMANTIC_LABELS_BIT_FB |
                    XR_SEMANTIC_LABELS_SUPPORT_ACCEPT_DESK_TO_TABLE_MIGRATION_BIT_FB |
                    XR_SEMANTIC_LABELS_SUPPORT_ACCEPT_INVISIBLE_WALL_FACE_BIT_FB;
    support.recognizedLabels = kRecognizedLabels;
    XrSemanticLabelsFB labels{XR_TYPE_SEMANTIC_LABELS_FB};
    labels.next = &support;
    if (XR_SUCCEEDED(get_labels_(session_, space, &labels)) && labels.bufferCountOutput > 0) {
      std::vector<char> buf(labels.bufferCountOutput + 1, '\0');
      labels.bufferCapacityInput = labels.bufferCountOutput;
      labels.buffer = buf.data();
      if (XR_SUCCEEDED(get_labels_(session_, space, &labels))) {
        out->labels.assign(buf.data(), strnlen(buf.data(), buf.size()));
      }
    }
  }
  if (component_enabled(space, XR_SPACE_COMPONENT_TYPE_BOUNDED_2D_FB)) {
    XrBoundary2DFB b{XR_TYPE_BOUNDARY_2D_FB};
    if (XR_SUCCEEDED(get_boundary_(session_, space, &b)) && b.vertexCountOutput >= 3) {
      std::vector<XrVector2f> v(b.vertexCountOutput);
      b.vertexCapacityInput = b.vertexCountOutput;
      b.vertices = v.data();
      if (XR_SUCCEEDED(get_boundary_(session_, space, &b))) {
        v.resize(b.vertexCountOutput);
        out->polygon.reserve(v.size() * 2);
        for (const XrVector2f& p : v) {
          out->polygon.push_back(p.x);
          out->polygon.push_back(p.y);
        }
      }
    } else if (get_box_2d_) {
      // No boundary: the bounding rectangle is the plane's outline.
      XrRect2Df r{};
      if (XR_SUCCEEDED(get_box_2d_(session_, space, &r))) {
        const float x0 = r.offset.x, y0 = r.offset.y, x1 = x0 + r.extent.width, y1 = y0 + r.extent.height;
        out->polygon = {x0, y0, x1, y0, x1, y1, x0, y1};
      }
    }
  }
  if (component_enabled(space, XR_SPACE_COMPONENT_TYPE_BOUNDED_3D_FB)) {
    XrRect3DfFB r{};
    if (XR_SUCCEEDED(get_box_3d_(session_, space, &r))) {
      out->has_box = true;
      out->box[0] = r.offset.x;
      out->box[1] = r.offset.y;
      out->box[2] = r.offset.z;
      out->box[3] = r.extent.width;
      out->box[4] = r.extent.height;
      out->box[5] = r.extent.depth;
    }
  }
  if (has_mesh_ && component_enabled(space, XR_SPACE_COMPONENT_TYPE_TRIANGLE_MESH_META)) {
    XrSpaceTriangleMeshGetInfoMETA gi{XR_TYPE_SPACE_TRIANGLE_MESH_GET_INFO_META};
    XrSpaceTriangleMeshMETA m{XR_TYPE_SPACE_TRIANGLE_MESH_META};
    if (XR_SUCCEEDED(get_triangle_mesh_(space, &gi, &m)) && m.vertexCountOutput > 0 && m.indexCountOutput >= 3) {
      std::vector<XrVector3f> v(m.vertexCountOutput);
      out->indices.resize(m.indexCountOutput);
      m.vertexCapacityInput = m.vertexCountOutput;
      m.vertices = v.data();
      m.indexCapacityInput = m.indexCountOutput;
      m.indices = out->indices.data();
      if (XR_SUCCEEDED(get_triangle_mesh_(space, &gi, &m))) {
        v.resize(m.vertexCountOutput);
        out->indices.resize(m.indexCountOutput - m.indexCountOutput % 3);
        out->vertices.reserve(v.size() * 3);
        for (const XrVector3f& p : v) {
          out->vertices.push_back(p.x);
          out->vertices.push_back(p.y);
          out->vertices.push_back(p.z);
        }
        // indices must stay inside the vertex list (a short read would leave them dangling)
        for (uint32_t& i : out->indices) {
          if (i >= v.size()) i = 0;
        }
      } else {
        out->indices.clear();
      }
    }
  }
  Entity e;
  e.space = space;
  e.uuid = uuid;
  e.slot = out->slot;
  pending_entities_.push_back(e);
}

uint32_t XrScene::slot_for(const std::string& id) {
  auto it = slots_.find(id);
  if (it != slots_.end()) return it->second;
  const uint32_t slot = static_cast<uint32_t>(slots_.size());
  if (slot >= kMaxSlots) return kMaxSlots;  // past the pose table: never located (status() counts entities)
  slots_.emplace(id, slot);
  return slot;
}

void XrScene::destroy_unless_kept(const std::vector<Entity>& doomed, const std::vector<Entity>& keep) {
  std::set<XrSpace> spared;
  for (const Entity& e : keep) spared.insert(e.space);
  for (const Entity& e : doomed) {
    if (spared.insert(e.space).second) xrDestroySpace(e.space);
  }
}

void XrScene::clear_entities() {
  destroy_unless_kept(entities_, {});
  destroy_unless_kept(pending_entities_, entities_);
  entities_.clear();
  pending_entities_.clear();
}

void XrScene::finish(XrResult result) {
  const double ms = now_ms() - query_start_ms_;
  if (XR_FAILED(result)) {
    phase_ = Phase::kFailed;
    log(LogLevel::kWarn,
        "xr: scene: the room query failed: %s (com.oculus.permission.USE_SCENE not granted, or the spatial-data "
        "service refused the package: see SP:AP lines); %s",
        result_name(result), snapshot_ ? "the last room stays published" : "no planes, meshes or hit-test results");
    destroy_unless_kept(pending_entities_, entities_);  // a re-query's results may be the current set's handles
    pending_entities_.clear();
    pending_.clear();
    std::lock_guard<std::mutex> lock(mu_);
    status_.phase = "failed";
    status_.error = result_name(result);
    status_.query_ms = ms;
    return;
  }
  // The new set replaces the old one (slots stay with their UUIDs, so JS's view stays consistent); handles the new
  // set got back from the runtime stay alive (see Handles in xr_scene.h).
  destroy_unless_kept(entities_, pending_entities_);
  entities_.swap(pending_entities_);
  pending_entities_.clear();
  auto snap = std::make_shared<SceneSnapshot>();
  snap->version = ++version_;
  snap->entities = std::move(pending_);
  pending_.clear();
  uint32_t planes = 0, boxes = 0, meshes = 0, triangles = 0;
  for (const SceneEntity& g : snap->entities) {
    if (!g.polygon.empty()) ++planes;
    if (g.has_box) ++boxes;
    if (!g.indices.empty()) {
      ++meshes;
      triangles += static_cast<uint32_t>(g.indices.size() / 3);
    }
  }
  phase_ = Phase::kReady;
  log(LogLevel::kInfo,
      "xr: scene: %zu room(s), %zu entities (%u planes, %u boxes, %u meshes with %u triangles) in %.0f ms%s",
      rooms_.size(), snap->entities.size(), planes, boxes, meshes, triangles, ms,
      rooms_.empty() ? "; no room from Space Setup" : "");
  std::lock_guard<std::mutex> lock(mu_);
  status_.phase = "ready";
  status_.error.clear();
  status_.rooms = static_cast<uint32_t>(rooms_.size());
  status_.entities = static_cast<uint32_t>(snap->entities.size());
  status_.planes = planes;
  status_.boxes = boxes;
  status_.meshes = meshes;
  status_.mesh_triangles = triangles;
  status_.query_ms = ms;
  snapshot_ = std::move(snap);
}

void XrScene::locate(XrSpace base, XrTime time) {
  if (!active_ || entities_.empty()) return;
  uint32_t located = 0;
  for (const Entity& e : entities_) {
    if (e.slot >= kMaxSlots) continue;
    float* p = poses() + e.slot * kSlotFloats;
    XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
    const bool ok = XR_SUCCEEDED(xrLocateSpace(e.space, base, time, &loc)) &&
                    (loc.locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) &&
                    (loc.locationFlags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT);
    if (ok) {
      p[0] = loc.pose.position.x;
      p[1] = loc.pose.position.y;
      p[2] = loc.pose.position.z;
      p[3] = loc.pose.orientation.x;
      p[4] = loc.pose.orientation.y;
      p[5] = loc.pose.orientation.z;
      p[6] = loc.pose.orientation.w;
      ++located;
    }
    p[7] = ok ? 1.0f : 0.0f;
  }
  std::lock_guard<std::mutex> lock(mu_);
  ++status_.located_frames;
  status_.located_last = located;
}

void XrScene::destroy() {
  clear_entities();
  for (XrSpace s : rooms_) xrDestroySpace(s);
  rooms_.clear();
  active_ = false;
  wanted_.store(false);  // an XR-system restart without session_ended(): the next session queries again
  phase_ = Phase::kIdle;
  // The pose table outlives the XR system: a restarted one hands out slots from 0 again, and its JS must not see the
  // old room's located flags (stale poses) before its own query's entities are located.
  float* p = poses();
  for (uint32_t slot = 0; slot < kMaxSlots; ++slot) p[slot * kSlotFloats + 7] = 0.0f;
  std::lock_guard<std::mutex> lock(mu_);
  snapshot_.reset();
}

std::shared_ptr<const SceneSnapshot> XrScene::snapshot() {
  std::lock_guard<std::mutex> lock(mu_);
  return snapshot_;
}

Json XrScene::status() {
  std::lock_guard<std::mutex> lock(mu_);
  Json j = Json::object();
  j.set("phase", status_.phase);
  if (!status_.error.empty()) j.set("error", status_.error);
  j.set("queries", static_cast<int64_t>(status_.queries));
  j.set("rooms", static_cast<int64_t>(status_.rooms));
  j.set("entities", static_cast<int64_t>(status_.entities));
  j.set("planes", static_cast<int64_t>(status_.planes));
  j.set("boxes", static_cast<int64_t>(status_.boxes));
  j.set("meshes", static_cast<int64_t>(status_.meshes));
  j.set("meshTriangles", static_cast<int64_t>(status_.mesh_triangles));
  j.set("queryMs", status_.query_ms);
  j.set("locatedFrames", status_.located_frames);
  j.set("locatedLast", static_cast<int64_t>(status_.located_last));
  j.set("version", static_cast<int64_t>(snapshot_ ? snapshot_->version : 0));
  return j;
}

}  // namespace iwn::xr
