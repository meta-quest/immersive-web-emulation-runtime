/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// See fake_openxr.h.
#include "fake_openxr.h"

#include <cstdio>
#include <cstring>

namespace fakexr {

namespace {

struct Handle {
  int entity = -1;
  bool alive = true;
  std::set<XrSpaceComponentTypeFB> enabled;
};

struct State {
  Runtime rt;
  std::vector<Handle> handles;   // handle value = (index + 1) << 4
  std::map<int, XrSpace> loaded;  // entity -> live handle (the runtime's spatial anchor map)
  std::map<XrAsyncRequestIdFB, std::vector<XrSpaceQueryResultFB>> results;
  XrAsyncRequestIdFB next_request = 100;
};

State& state() {
  static State s;
  return s;
}

XrSpace to_space(size_t index) { return reinterpret_cast<XrSpace>(static_cast<uintptr_t>(index + 1) << 4); }

Handle* from_space(XrSpace space) {
  const uintptr_t v = reinterpret_cast<uintptr_t>(space) >> 4;
  if (v == 0 || v > state().handles.size()) return nullptr;
  Handle* h = &state().handles[v - 1];
  return h->alive ? h : nullptr;
}

const Entity* entity_of(XrSpace space) {
  const Handle* h = from_space(space);
  return h && h->entity >= 0 ? &state().rt.world[static_cast<size_t>(h->entity)] : nullptr;
}

// An entity's space in the session: the loaded one, else a new handle (LOCATABLE disabled until enabled).
XrSpace load(int entity) {
  auto it = state().loaded.find(entity);
  if (it != state().loaded.end()) return it->second;
  state().handles.push_back(Handle{entity, true, {}});
  const XrSpace s = to_space(state().handles.size() - 1);
  state().loaded[entity] = s;
  return s;
}

void post(const void* event, size_t size) {
  XrEventDataBuffer b{};
  std::memcpy(&b, event, size);
  state().rt.events.push_back(b);
}

bool has_component(const Entity& e, XrSpaceComponentTypeFB type) {
  switch (type) {
    case XR_SPACE_COMPONENT_TYPE_SEMANTIC_LABELS_FB: return !e.labels.empty();
    case XR_SPACE_COMPONENT_TYPE_BOUNDED_2D_FB: return e.plane;
    case XR_SPACE_COMPONENT_TYPE_BOUNDED_3D_FB: return e.box;
    case XR_SPACE_COMPONENT_TYPE_TRIANGLE_MESH_META: return e.mesh;
    case XR_SPACE_COMPONENT_TYPE_SPACE_CONTAINER_FB:
    case XR_SPACE_COMPONENT_TYPE_ROOM_LAYOUT_FB: return e.room;
    default: return false;
  }
}

XrResult XRAPI_CALL QuerySpaces(XrSession, const XrSpaceQueryInfoBaseHeaderFB* base, XrAsyncRequestIdFB* id) {
  const auto* qi = reinterpret_cast<const XrSpaceQueryInfoFB*>(base);
  const auto* filter = reinterpret_cast<const XrSpaceFilterInfoBaseHeaderFB*>(qi->filter);
  std::vector<XrSpaceQueryResultFB> out;
  XrResult result = XR_SUCCESS;
  const auto& world = state().rt.world;
  if (filter && filter->type == XR_TYPE_SPACE_COMPONENT_FILTER_INFO_FB) {
    const auto* f = reinterpret_cast<const XrSpaceComponentFilterInfoFB*>(filter);
    if (f->componentType == XR_SPACE_COMPONENT_TYPE_ROOM_LAYOUT_FB && XR_FAILED(state().rt.room_query_result)) {
      result = state().rt.room_query_result;  // refused (no results), as SPS's ERROR_PACKAGE_UNTRUSTED
    } else {
      for (size_t i = 0; i < world.size(); ++i) {
        if (has_component(world[i], f->componentType)) out.push_back({load(static_cast<int>(i)), world[i].uuid});
      }
    }
  } else if (filter && filter->type == XR_TYPE_SPACE_UUID_FILTER_INFO_FB) {
    const auto* f = reinterpret_cast<const XrSpaceUuidFilterInfoFB*>(filter);
    for (uint32_t k = 0; k < f->uuidCount; ++k) {
      for (size_t i = 0; i < world.size(); ++i) {
        if (world[i].anchor && !world[i].persisted) continue;  // not in the local storage
        if (std::memcmp(world[i].uuid.data, f->uuids[k].data, XR_UUID_SIZE) == 0) {
          out.push_back({load(static_cast<int>(i)), world[i].uuid});
        }
      }
    }
  }
  *id = state().next_request++;
  if (!out.empty()) {
    XrEventDataSpaceQueryResultsAvailableFB available{XR_TYPE_EVENT_DATA_SPACE_QUERY_RESULTS_AVAILABLE_FB};
    available.requestId = *id;
    post(&available, sizeof available);
  }
  state().results[*id] = out;
  XrEventDataSpaceQueryCompleteFB complete{XR_TYPE_EVENT_DATA_SPACE_QUERY_COMPLETE_FB};
  complete.requestId = *id;
  complete.result = result;
  post(&complete, sizeof complete);
  return XR_SUCCESS;
}

XrResult XRAPI_CALL RetrieveResults(XrSession, XrAsyncRequestIdFB id, XrSpaceQueryResultsFB* r) {
  if (state().rt.fail_retrieve) return XR_ERROR_RUNTIME_FAILURE;
  const auto& list = state().results[id];
  r->resultCountOutput = static_cast<uint32_t>(list.size());
  if (r->resultCapacityInput == 0) return XR_SUCCESS;
  if (r->resultCapacityInput < list.size()) return XR_ERROR_SIZE_INSUFFICIENT;
  for (size_t i = 0; i < list.size(); ++i) r->results[i] = list[i];
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetComponentStatus(XrSpace space, XrSpaceComponentTypeFB type, XrSpaceComponentStatusFB* st) {
  Handle* h = from_space(space);
  if (!h) return XR_ERROR_HANDLE_INVALID;
  const Entity* e = entity_of(space);
  const bool settable = type == XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB || type == XR_SPACE_COMPONENT_TYPE_STORABLE_FB;
  st->enabled = (settable ? h->enabled.count(type) != 0 : e && has_component(*e, type)) ? XR_TRUE : XR_FALSE;
  st->changePending = XR_FALSE;
  return XR_SUCCESS;
}

XrResult XRAPI_CALL SetComponentStatus(XrSpace space, const XrSpaceComponentStatusSetInfoFB* info,
                                       XrAsyncRequestIdFB* id) {
  Handle* h = from_space(space);
  if (!h) return XR_ERROR_HANDLE_INVALID;
  *id = state().next_request++;
  const bool already = h->enabled.count(info->componentType) != 0;
  if (info->enabled) h->enabled.insert(info->componentType);
  XrEventDataSpaceSetStatusCompleteFB done{XR_TYPE_EVENT_DATA_SPACE_SET_STATUS_COMPLETE_FB};
  done.requestId = *id;
  done.result = already ? XR_ERROR_SPACE_COMPONENT_STATUS_ALREADY_SET_FB : XR_SUCCESS;
  done.space = space;
  done.componentType = info->componentType;
  done.enabled = info->enabled;
  post(&done, sizeof done);
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetContainer(XrSession, XrSpace space, XrSpaceContainerFB* c) {
  const Entity* e = entity_of(space);
  if (!e) return XR_ERROR_HANDLE_INVALID;
  if (state().rt.fail_container) return XR_ERROR_RUNTIME_FAILURE;
  std::vector<XrUuidEXT> uuids;
  for (const Entity& w : state().rt.world) {
    if (!w.room) uuids.push_back(w.uuid);
  }
  c->uuidCountOutput = static_cast<uint32_t>(uuids.size());
  if (c->uuidCapacityInput == 0) return XR_SUCCESS;
  for (size_t i = 0; i < uuids.size() && i < c->uuidCapacityInput; ++i) c->uuids[i] = uuids[i];
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetBox2D(XrSession, XrSpace space, XrRect2Df* r) {
  if (!entity_of(space)) return XR_ERROR_HANDLE_INVALID;
  *r = XrRect2Df{{-1, -1}, {2, 2}};
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetBox3D(XrSession, XrSpace space, XrRect3DfFB* r) {
  if (!entity_of(space)) return XR_ERROR_HANDLE_INVALID;
  *r = XrRect3DfFB{{-0.5f, -0.5f, 0}, {1, 1, 0.7f}};
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetLabels(XrSession, XrSpace space, XrSemanticLabelsFB* l) {
  const Entity* e = entity_of(space);
  if (!e) return XR_ERROR_HANDLE_INVALID;
  l->bufferCountOutput = static_cast<uint32_t>(e->labels.size() + 1);
  if (l->bufferCapacityInput == 0) return XR_SUCCESS;
  std::memcpy(l->buffer, e->labels.c_str(), l->bufferCountOutput);
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetBoundary(XrSession, XrSpace space, XrBoundary2DFB* b) {
  if (!entity_of(space)) return XR_ERROR_HANDLE_INVALID;
  b->vertexCountOutput = 4;
  if (b->vertexCapacityInput == 0) return XR_SUCCESS;
  const XrVector2f v[4] = {{-1, -1}, {1, -1}, {1, 1}, {-1, 1}};
  for (int i = 0; i < 4; ++i) b->vertices[i] = v[i];
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetTriangleMesh(XrSpace space, const XrSpaceTriangleMeshGetInfoMETA*, XrSpaceTriangleMeshMETA* m) {
  if (!entity_of(space)) return XR_ERROR_HANDLE_INVALID;
  m->vertexCountOutput = 3;
  m->indexCountOutput = 3;
  if (m->vertexCapacityInput == 0) return XR_SUCCESS;
  m->vertices[0] = {0, 0, 0};
  m->vertices[1] = {1, 0, 0};
  m->vertices[2] = {0, 0, 1};
  m->indices[0] = 0;
  m->indices[1] = 1;
  m->indices[2] = 2;
  return XR_SUCCESS;
}

XrResult XRAPI_CALL CreateSpatialAnchor(XrSession, const XrSpatialAnchorCreateInfoFB* info, XrAsyncRequestIdFB* id) {
  auto& s = state();
  *id = s.next_request++;
  XrEventDataSpatialAnchorCreateCompleteFB done{XR_TYPE_EVENT_DATA_SPATIAL_ANCHOR_CREATE_COMPLETE_FB};
  done.requestId = *id;
  done.result = s.rt.create_result;
  Entity e;
  e.uuid = uuid(static_cast<uint8_t>(100 + s.rt.world.size()));
  e.anchor = true;
  e.pose = info->poseInSpace;
  if (XR_SUCCEEDED(s.rt.create_result)) {
    s.rt.world.push_back(e);
    done.space = load(static_cast<int>(s.rt.world.size() - 1));
    from_space(done.space)->enabled.insert(XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB);
    done.uuid = e.uuid;
  } else {
    s.handles.push_back(Handle{-1, true, {}});  // delivered with the failure all the same
    done.space = to_space(s.handles.size() - 1);
  }
  post(&done, sizeof done);
  return XR_SUCCESS;
}

XrResult XRAPI_CALL GetSpaceUuid(XrSpace space, XrUuidEXT* out) {
  const Entity* e = entity_of(space);
  if (!e) return XR_ERROR_HANDLE_INVALID;
  *out = e->uuid;
  return XR_SUCCESS;
}

XrResult XRAPI_CALL SaveSpace(XrSession, const XrSpaceSaveInfoFB* info, XrAsyncRequestIdFB* id) {
  Handle* h = from_space(info->space);
  if (!h || h->entity < 0) return XR_ERROR_HANDLE_INVALID;
  if (h->enabled.count(XR_SPACE_COMPONENT_TYPE_STORABLE_FB) == 0) return XR_ERROR_SPACE_COMPONENT_NOT_ENABLED_FB;
  Entity& e = state().rt.world[static_cast<size_t>(h->entity)];
  e.persisted = true;
  *id = state().next_request++;
  XrEventDataSpaceSaveCompleteFB done{XR_TYPE_EVENT_DATA_SPACE_SAVE_COMPLETE_FB};
  done.requestId = *id;
  done.result = XR_SUCCESS;
  done.space = info->space;
  done.uuid = e.uuid;
  done.location = info->location;
  post(&done, sizeof done);
  return XR_SUCCESS;
}

XrResult XRAPI_CALL EraseSpace(XrSession, const XrSpaceEraseInfoFB* info, XrAsyncRequestIdFB* id) {
  Handle* h = from_space(info->space);
  if (!h || h->entity < 0) return XR_ERROR_HANDLE_INVALID;
  if (h->enabled.count(XR_SPACE_COMPONENT_TYPE_STORABLE_FB) == 0) return XR_ERROR_SPACE_COMPONENT_NOT_ENABLED_FB;
  Entity& e = state().rt.world[static_cast<size_t>(h->entity)];
  *id = state().next_request++;
  XrEventDataSpaceEraseCompleteFB done{XR_TYPE_EVENT_DATA_SPACE_ERASE_COMPLETE_FB};
  done.requestId = *id;
  done.result = e.persisted ? XR_SUCCESS : XR_ERROR_SPACE_COMPONENT_NOT_ENABLED_FB;
  done.space = info->space;
  done.uuid = e.uuid;
  done.location = info->location;
  e.persisted = false;
  post(&done, sizeof done);
  return XR_SUCCESS;
}

}  // namespace

Runtime& runtime() { return state().rt; }

bool persisted(const XrUuidEXT& u) {
  for (const Entity& e : state().rt.world) {
    if (std::memcmp(e.uuid.data, u.data, XR_UUID_SIZE) == 0) return e.persisted;
  }
  return false;
}

void reset() { state() = State{}; }

XrUuidEXT uuid(uint8_t n) {
  XrUuidEXT u{};
  u.data[0] = 0xab;
  u.data[15] = n;
  return u;
}

int live_handles() {
  int n = 0;
  for (const Handle& h : state().handles) n += h.alive ? 1 : 0;
  return n;
}

void pump(const std::function<void(const XrEventDataBuffer&)>& handler) {
  while (!state().rt.events.empty()) {
    const XrEventDataBuffer e = state().rt.events.front();
    state().rt.events.pop_front();
    handler(e);
  }
}

}  // namespace fakexr

using fakexr::from_space;

// --- the OpenXR entry points the code under test links against ---
extern "C" {

XRAPI_ATTR XrResult XRAPI_CALL xrGetInstanceProcAddr(XrInstance, const char* name, PFN_xrVoidFunction* fn) {
  struct Entry {
    const char* name;
    PFN_xrVoidFunction fn;
  };
  using namespace fakexr;
  static const Entry table[] = {
      {"xrQuerySpacesFB", reinterpret_cast<PFN_xrVoidFunction>(&QuerySpaces)},
      {"xrRetrieveSpaceQueryResultsFB", reinterpret_cast<PFN_xrVoidFunction>(&RetrieveResults)},
      {"xrGetSpaceComponentStatusFB", reinterpret_cast<PFN_xrVoidFunction>(&GetComponentStatus)},
      {"xrSetSpaceComponentStatusFB", reinterpret_cast<PFN_xrVoidFunction>(&SetComponentStatus)},
      {"xrGetSpaceContainerFB", reinterpret_cast<PFN_xrVoidFunction>(&GetContainer)},
      {"xrGetSpaceBoundingBox2DFB", reinterpret_cast<PFN_xrVoidFunction>(&GetBox2D)},
      {"xrGetSpaceBoundingBox3DFB", reinterpret_cast<PFN_xrVoidFunction>(&GetBox3D)},
      {"xrGetSpaceSemanticLabelsFB", reinterpret_cast<PFN_xrVoidFunction>(&GetLabels)},
      {"xrGetSpaceBoundary2DFB", reinterpret_cast<PFN_xrVoidFunction>(&GetBoundary)},
      {"xrGetSpaceTriangleMeshMETA", reinterpret_cast<PFN_xrVoidFunction>(&GetTriangleMesh)},
      {"xrCreateSpatialAnchorFB", reinterpret_cast<PFN_xrVoidFunction>(&CreateSpatialAnchor)},
      {"xrGetSpaceUuidFB", reinterpret_cast<PFN_xrVoidFunction>(&GetSpaceUuid)},
      {"xrSaveSpaceFB", reinterpret_cast<PFN_xrVoidFunction>(&SaveSpace)},
      {"xrEraseSpaceFB", reinterpret_cast<PFN_xrVoidFunction>(&EraseSpace)},
  };
  for (const Entry& e : table) {
    if (std::strcmp(e.name, name) == 0) {
      *fn = e.fn;
      return XR_SUCCESS;
    }
  }
  *fn = nullptr;
  return XR_ERROR_FUNCTION_UNSUPPORTED;
}

XRAPI_ATTR XrResult XRAPI_CALL xrGetSystemProperties(XrInstance, XrSystemId, XrSystemProperties* properties) {
  for (auto* next = static_cast<XrBaseOutStructure*>(properties->next); next; next = next->next) {
    if (next->type == XR_TYPE_SYSTEM_SPATIAL_ENTITY_PROPERTIES_FB) {
      reinterpret_cast<XrSystemSpatialEntityPropertiesFB*>(next)->supportsSpatialEntity = XR_TRUE;
    }
  }
  return XR_SUCCESS;
}

XRAPI_ATTR XrResult XRAPI_CALL xrResultToString(XrInstance, XrResult r, char buffer[XR_MAX_RESULT_STRING_SIZE]) {
  std::snprintf(buffer, XR_MAX_RESULT_STRING_SIZE, "XrResult(%d)", r);
  return XR_SUCCESS;
}

XRAPI_ATTR XrResult XRAPI_CALL xrDestroySpace(XrSpace space) {
  auto& s = fakexr::state();
  fakexr::Handle* h = from_space(space);
  if (!h) {
    ++s.rt.destroyed_dead;
    return XR_ERROR_HANDLE_INVALID;
  }
  h->alive = false;
  ++s.rt.destroyed_live;
  auto it = s.loaded.find(h->entity);
  if (it != s.loaded.end() && it->second == space) s.loaded.erase(it);
  return XR_SUCCESS;
}

XRAPI_ATTR XrResult XRAPI_CALL xrLocateSpace(XrSpace space, XrSpace, XrTime, XrSpaceLocation* loc) {
  fakexr::Handle* h = from_space(space);
  if (!h) {
    ++fakexr::state().rt.located_dead;
    return XR_ERROR_HANDLE_INVALID;
  }
  loc->locationFlags = 0;
  if (h->enabled.count(XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB) == 0) return XR_SUCCESS;  // not located yet
  loc->locationFlags = XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
  loc->pose = h->entity >= 0 ? fakexr::state().rt.world[static_cast<size_t>(h->entity)].pose
                             : XrPosef{{0, 0, 0, 1}, {0, 0, 0}};
  return XR_SUCCESS;
}

}  // extern "C"
