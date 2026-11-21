// Spatial anchors (XR-ANCHOR-1). See xr_anchors.h for the threading model. Sequences, from the extension
// specifications and Meta's OpenXR SDK sample XrSpatialAnchor:
//   create   xrCreateSpatialAnchorFB (base space, pose, frame time) -> XrEventDataSpatialAnchorCreateCompleteFB (space,
//            uuid). A new anchor is locatable.
//   persist  STORABLE enabled (xrGetSpaceComponentStatusFB, else xrSetSpaceComponentStatusFB ->
//            XrEventDataSpaceSetStatusCompleteFB) -> xrSaveSpaceFB (local, indefinite) -> XrEventDataSpaceSaveCompleteFB.
//   restore  xrQuerySpacesFB (load, UUID filter, local storage) -> XrEventDataSpaceQueryResultsAvailableFB ->
//            xrRetrieveSpaceQueryResultsFB -> XrEventDataSpaceQueryCompleteFB; then LOCATABLE enabled as above.
//   erase    on this session's anchor with that UUID (live, being restored or released: pinned until done), else on one
//            loaded for it by a query (destroyed afterwards): STORABLE enabled (a loaded space has it off), then
//            xrEraseSpaceFB (local) -> XrEventDataSpaceEraseCompleteFB.
#include "android/xr_anchors.h"

#include <algorithm>
#include <cstring>

#include "iwn/core/log.h"
#include "iwn/xr/input_map.h"

namespace iwn::xr {

namespace {

template <typename F>
void load(XrInstance instance, const char* name, F* fn) {
  *fn = nullptr;
  xrGetInstanceProcAddr(instance, name, reinterpret_cast<PFN_xrVoidFunction*>(fn));
}

bool same_uuid(const XrUuidEXT& a, const XrUuidEXT& b) { return std::memcmp(a.data, b.data, XR_UUID_SIZE) == 0; }

std::string uuid_text(const XrUuidEXT& u) { return format_uuid(u.data); }

}  // namespace

// --- requests from the JS thread ------------------------------------------------------------------------------------

uint32_t XrAnchors::next_request() {
  uint32_t r = requests_.fetch_add(1, std::memory_order_relaxed) + 1;
  if (r == 0) r = requests_.fetch_add(1, std::memory_order_relaxed) + 1;  // 0 means "refused"
  return r;
}

bool XrAnchors::post(std::function<void()> work) { return queue_ && queue_->push(std::move(work)); }

void XrAnchors::finish(const AnchorResult& r) {
  {
    std::lock_guard<std::mutex> lock(results_mu_);
    results_.push_back(r);
  }
  results_ready_.store(true, std::memory_order_release);
}

void XrAnchors::fail(uint32_t request, uint32_t anchor, const std::string& why) {
  log(LogLevel::kWarn, "xr: anchor request %u failed: %s", request, why.c_str());
  {
    std::lock_guard<std::mutex> lock(stats_mu_);
    ++failed_;
    last_error_ = why;
  }
  AnchorResult r;
  r.request = request;
  r.anchor = anchor;
  r.error = why;
  finish(r);
}

const char* XrAnchors::result_name(XrResult r) {
  static thread_local char buf[XR_MAX_RESULT_STRING_SIZE];
  if (instance_ == XR_NULL_HANDLE || XR_FAILED(xrResultToString(instance_, r, buf))) {
    std::snprintf(buf, sizeof(buf), "XrResult(%d)", r);
  }
  return buf;
}

uint32_t XrAnchors::create(const XrPosef& pose) {
  if (!supported()) return 0;
  const uint32_t request = next_request();
  const uint32_t id = table_.reserve();
  if (id == 0) {
    fail(request, 0, "too many anchors (at most " + std::to_string(kMaxAnchors) + " at a time)");
    return request;
  }
  if (!post([this, request, id, pose] { do_create(request, id, pose); })) {
    table_.free(id);
    fail(request, 0, "the XR system is not running");
  }
  return request;
}

uint32_t XrAnchors::persist(uint32_t anchor) {
  if (!persistence()) return 0;
  const uint32_t request = next_request();
  if (table_.state(anchor) != AnchorTable::State::kLive) {
    fail(request, anchor, "the anchor was deleted");
    return request;
  }
  if (!post([this, request, anchor] { do_persist(request, anchor); })) fail(request, anchor, "the XR system is not running");
  return request;
}

uint32_t XrAnchors::restore(const std::string& uuid) {
  if (!persistence()) return 0;
  const uint32_t request = next_request();
  XrUuidEXT u{};
  if (!parse_uuid(uuid, u.data)) {
    fail(request, 0, "'" + uuid + "' is not a persistent anchor UUID");
    return request;
  }
  const uint32_t id = table_.reserve();
  if (id == 0) {
    fail(request, 0, "too many anchors (at most " + std::to_string(kMaxAnchors) + " at a time)");
    return request;
  }
  if (!post([this, request, id, u] { do_restore(request, id, u); })) {
    table_.free(id);
    fail(request, 0, "the XR system is not running");
  }
  return request;
}

uint32_t XrAnchors::erase(const std::string& uuid) {
  if (!persistence()) return 0;
  const uint32_t request = next_request();
  XrUuidEXT u{};
  if (!parse_uuid(uuid, u.data)) {
    fail(request, 0, "'" + uuid + "' is not a persistent anchor UUID");
    return request;
  }
  if (!post([this, request, u] { do_erase(request, u); })) fail(request, 0, "the XR system is not running");
  return request;
}

void XrAnchors::destroy(uint32_t anchor) {
  // A stale id (the session ended, the slot was taken again) changes nothing.
  if (table_.release(anchor)) post([this, anchor] { settle(anchor); });
}

bool XrAnchors::take_results(std::vector<AnchorResult>* out) {
  if (!results_ready_.exchange(false, std::memory_order_acq_rel)) return false;
  std::lock_guard<std::mutex> lock(results_mu_);
  out->swap(results_);
  results_.clear();
  return !out->empty();
}

Json XrAnchors::stats() {
  Json j = Json::object();
  j.set("supported", supported());
  j.set("persistence", persistence());
  j.set("live", static_cast<int64_t>(table_.live_count()));
  std::lock_guard<std::mutex> lock(stats_mu_);
  j.set("created", created_);
  j.set("persisted", persisted_);
  j.set("restored", restored_);
  j.set("erased", erased_);
  j.set("destroyed", destroyed_);
  j.set("failed", failed_);
  j.set("lostFrames", lost_frames_);  // anchor-frames without a located pose
  if (!last_error_.empty()) j.set("lastError", last_error_);
  return j;
}

void XrAnchors::reset() {
  table_.clear();
  for (Slot& s : slots_) s = Slot{};
  pending_.clear();
  std::lock_guard<std::mutex> lock(results_mu_);
  results_.clear();
  results_ready_.store(false, std::memory_order_release);
}

// --- XR thread ------------------------------------------------------------------------------------------------------

void XrAnchors::init(XrInstance instance, XrSystemId system, XrSession session, XrSpace base,
                     const std::vector<std::string>& enabled) {
  instance_ = instance;
  session_ = session;
  base_ = base;
  auto has = [&](const char* e) { return std::find(enabled.begin(), enabled.end(), e) != enabled.end(); };
  if (!has(XR_FB_SPATIAL_ENTITY_EXTENSION_NAME)) return;
  load(instance, "xrCreateSpatialAnchorFB", &create_anchor_);
  load(instance, "xrGetSpaceUuidFB", &get_uuid_);
  load(instance, "xrGetSpaceComponentStatusFB", &get_status_);
  load(instance, "xrSetSpaceComponentStatusFB", &set_status_);
  XrSystemSpatialEntityPropertiesFB ep{XR_TYPE_SYSTEM_SPATIAL_ENTITY_PROPERTIES_FB};
  XrSystemProperties sp{XR_TYPE_SYSTEM_PROPERTIES};
  sp.next = &ep;
  const bool system_ok = XR_SUCCEEDED(xrGetSystemProperties(instance, system, &sp)) && ep.supportsSpatialEntity;
  const bool ok = system_ok && create_anchor_ && get_status_ && set_status_;
  bool persist = false;
  if (ok && has(XR_FB_SPATIAL_ENTITY_STORAGE_EXTENSION_NAME) && has(XR_FB_SPATIAL_ENTITY_QUERY_EXTENSION_NAME)) {
    load(instance, "xrSaveSpaceFB", &save_space_);
    load(instance, "xrEraseSpaceFB", &erase_space_);
    load(instance, "xrQuerySpacesFB", &query_spaces_);
    load(instance, "xrRetrieveSpaceQueryResultsFB", &retrieve_results_);
    persist = save_space_ && erase_space_ && query_spaces_ && retrieve_results_;
  }
  supported_.store(ok, std::memory_order_release);
  persistence_.store(persist, std::memory_order_release);
  log(LogLevel::kInfo, "xr: anchors %s (system spatial entities %d), persistent anchors %s", ok ? "available" : "unavailable",
      system_ok ? 1 : 0, persist ? "available" : "unavailable");
}

void XrAnchors::do_create(uint32_t request, uint32_t anchor, XrPosef pose) {
  if (table_.state(anchor) != AnchorTable::State::kPending) {  // the session ended before the command ran
    table_.free(anchor);
    fail(request, 0, "the session ended");
    return;
  }
  if (session_ == XR_NULL_HANDLE || last_time_ == 0) {
    table_.free(anchor);
    fail(request, 0, "no OpenXR frame yet");
    return;
  }
  XrSpatialAnchorCreateInfoFB ci{XR_TYPE_SPATIAL_ANCHOR_CREATE_INFO_FB};
  ci.space = base_;
  ci.poseInSpace = pose;
  ci.time = last_time_;
  XrAsyncRequestIdFB id = 0;
  const XrResult r = create_anchor_(session_, &ci, &id);
  if (XR_FAILED(r)) {
    table_.free(anchor);
    fail(request, 0, std::string("xrCreateSpatialAnchorFB: ") + result_name(r) +
                         (r == XR_ERROR_PERMISSION_INSUFFICIENT
                              ? " (the manifest needs com.oculus.permission.USE_ANCHOR_API)"
                              : ""));
    return;
  }
  pending_[id] = Pending{Op::kCreate, request, anchor};
  ++slots_[anchor_slot(anchor)].busy;
}

bool XrAnchors::enable_component(uint32_t request, uint32_t anchor, XrSpace space, XrSpaceComponentTypeFB type, Op op,
                                 bool* already, const XrUuidEXT* uuid) {
  *already = false;
  XrSpaceComponentStatusFB status{XR_TYPE_SPACE_COMPONENT_STATUS_FB};
  if (XR_SUCCEEDED(get_status_(space, type, &status)) && status.enabled && !status.changePending) {
    *already = true;
    return true;
  }
  XrSpaceComponentStatusSetInfoFB si{XR_TYPE_SPACE_COMPONENT_STATUS_SET_INFO_FB};
  si.componentType = type;
  si.enabled = XR_TRUE;
  si.timeout = 0;
  XrAsyncRequestIdFB id = 0;
  const XrResult r = set_status_(space, &si, &id);
  if (r == XR_ERROR_SPACE_COMPONENT_STATUS_ALREADY_SET_FB) {
    *already = true;
    return true;
  }
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: xrSetSpaceComponentStatusFB(%d): %s", static_cast<int>(type), result_name(r));
    return false;
  }
  Pending p{op, request, anchor};
  if (uuid) p.uuid = *uuid;
  if (anchor != 0) {
    ++slots_[anchor_slot(anchor)].busy;
  } else {
    p.space = space;  // loaded for this request alone
  }
  pending_[id] = p;
  return true;
}

uint32_t XrAnchors::owner_of(XrSpace space) const {
  if (space == XR_NULL_HANDLE) return 0;
  for (int i = 0; i < kMaxAnchors; ++i) {
    if (slots_[i].space == space) return table_.id_of(i);
  }
  return 0;
}

void XrAnchors::do_persist(uint32_t request, uint32_t anchor) {
  Slot& s = slots_[anchor_slot(anchor)];
  if (table_.state(anchor) != AnchorTable::State::kLive || s.space == XR_NULL_HANDLE) {
    fail(request, anchor, "the anchor was deleted");
    return;
  }
  bool already = false;
  if (!enable_component(request, anchor, s.space, XR_SPACE_COMPONENT_TYPE_STORABLE_FB, Op::kStorable, &already)) {
    fail(request, anchor, "the anchor cannot be stored (STORABLE component)");
  } else if (already) {
    do_save(request, anchor);
  }
}

void XrAnchors::do_save(uint32_t request, uint32_t anchor) {
  Slot& s = slots_[anchor_slot(anchor)];
  if (s.space == XR_NULL_HANDLE) {
    fail(request, anchor, "the anchor was deleted");
    return;
  }
  XrSpaceSaveInfoFB si{XR_TYPE_SPACE_SAVE_INFO_FB};
  si.space = s.space;
  si.location = XR_SPACE_STORAGE_LOCATION_LOCAL_FB;
  si.persistenceMode = XR_SPACE_PERSISTENCE_MODE_INDEFINITE_FB;
  XrAsyncRequestIdFB id = 0;
  const XrResult r = save_space_(session_, &si, &id);
  if (XR_FAILED(r)) {
    fail(request, anchor, std::string("xrSaveSpaceFB: ") + result_name(r));
    return;
  }
  pending_[id] = Pending{Op::kSave, request, anchor};
  ++s.busy;
}

void XrAnchors::do_restore(uint32_t request, uint32_t anchor, XrUuidEXT uuid) {
  if (table_.state(anchor) != AnchorTable::State::kPending) {
    table_.free(anchor);
    fail(request, 0, "the session ended");
    return;
  }
  XrSpaceStorageLocationFilterInfoFB where{XR_TYPE_SPACE_STORAGE_LOCATION_FILTER_INFO_FB};
  where.location = XR_SPACE_STORAGE_LOCATION_LOCAL_FB;
  XrSpaceUuidFilterInfoFB filter{XR_TYPE_SPACE_UUID_FILTER_INFO_FB};
  filter.next = &where;
  filter.uuidCount = 1;
  filter.uuids = &uuid;
  XrSpaceQueryInfoFB qi{XR_TYPE_SPACE_QUERY_INFO_FB};
  qi.queryAction = XR_SPACE_QUERY_ACTION_LOAD_FB;
  qi.maxResultCount = 1;
  qi.timeout = 0;
  qi.filter = reinterpret_cast<const XrSpaceFilterInfoBaseHeaderFB*>(&filter);
  XrAsyncRequestIdFB id = 0;
  const XrResult r = query_spaces_(session_, reinterpret_cast<const XrSpaceQueryInfoBaseHeaderFB*>(&qi), &id);
  if (XR_FAILED(r)) {
    table_.free(anchor);
    fail(request, 0, std::string("xrQuerySpacesFB: ") + result_name(r));
    return;
  }
  Pending p{Op::kRestoreQuery, request, anchor};
  p.uuid = uuid;
  pending_[id] = p;
  ++slots_[anchor_slot(anchor)].busy;
}

void XrAnchors::restored(uint32_t request, uint32_t anchor) {
  if (!table_.go_live(anchor)) {
    fail(request, 0, "the session ended");
    return;  // settle() destroys it
  }
  {
    std::lock_guard<std::mutex> lock(stats_mu_);
    ++restored_;
  }
  log(LogLevel::kInfo, "xr: anchor %u restored from %s", anchor, uuid_text(slots_[anchor_slot(anchor)].uuid).c_str());
  AnchorResult res;
  res.request = request;
  res.ok = true;
  res.anchor = anchor;
  finish(res);
}

void XrAnchors::do_erase(uint32_t request, XrUuidEXT uuid) {
  // This session's anchor with that UUID, in any state (live, being restored, released by the page a moment ago):
  // a query would only hand back its space (see Handles in xr_anchors.h).
  for (int i = 0; i < kMaxAnchors; ++i) {
    Slot& s = slots_[i];
    const uint32_t id = table_.id_of(i);
    if (s.space != XR_NULL_HANDLE && same_uuid(s.uuid, uuid) && table_.state(id) != AnchorTable::State::kFree) {
      start_erase(request, id, s.space, uuid);
      return;
    }
  }
  XrSpaceStorageLocationFilterInfoFB where{XR_TYPE_SPACE_STORAGE_LOCATION_FILTER_INFO_FB};
  where.location = XR_SPACE_STORAGE_LOCATION_LOCAL_FB;
  XrSpaceUuidFilterInfoFB filter{XR_TYPE_SPACE_UUID_FILTER_INFO_FB};
  filter.next = &where;
  filter.uuidCount = 1;
  filter.uuids = &uuid;
  XrSpaceQueryInfoFB qi{XR_TYPE_SPACE_QUERY_INFO_FB};
  qi.queryAction = XR_SPACE_QUERY_ACTION_LOAD_FB;
  qi.maxResultCount = 1;
  qi.filter = reinterpret_cast<const XrSpaceFilterInfoBaseHeaderFB*>(&filter);
  XrAsyncRequestIdFB id = 0;
  const XrResult r = query_spaces_(session_, reinterpret_cast<const XrSpaceQueryInfoBaseHeaderFB*>(&qi), &id);
  if (XR_FAILED(r)) {
    fail(request, 0, std::string("xrQuerySpacesFB: ") + result_name(r));
    return;
  }
  Pending p{Op::kEraseQuery, request, 0};
  p.uuid = uuid;
  pending_[id] = p;
}

void XrAnchors::start_erase(uint32_t request, uint32_t anchor, XrSpace space, XrUuidEXT uuid) {
  // xrEraseSpaceFB fails with XR_ERROR_SPACE_COMPONENT_NOT_ENABLED_FB unless STORABLE is enabled, which a space a
  // query loaded (a restored anchor, one loaded for the erase) does not have
  bool already = false;
  if (!enable_component(request, anchor, space, XR_SPACE_COMPONENT_TYPE_STORABLE_FB, Op::kEraseStorable, &already,
                        &uuid)) {
    if (anchor == 0) xrDestroySpace(space);
    fail(request, 0, "the persisted anchor cannot be erased (STORABLE component)");
  } else if (already) {
    erase_space(request, anchor, space, uuid);
  }
}

void XrAnchors::erase_space(uint32_t request, uint32_t anchor, XrSpace space, XrUuidEXT uuid) {
  XrSpaceEraseInfoFB ei{XR_TYPE_SPACE_ERASE_INFO_FB};
  ei.space = space;
  ei.location = XR_SPACE_STORAGE_LOCATION_LOCAL_FB;
  XrAsyncRequestIdFB id = 0;
  const XrResult r = erase_space_(session_, &ei, &id);
  if (XR_FAILED(r)) {
    if (anchor == 0) xrDestroySpace(space);
    fail(request, anchor, std::string("xrEraseSpaceFB: ") + result_name(r));
    return;
  }
  Pending p{Op::kErase, request, anchor};
  p.uuid = uuid;
  if (anchor == 0) {
    p.space = space;  // loaded for the erase only: destroyed once it is done
  } else {
    ++slots_[anchor_slot(anchor)].busy;
  }
  pending_[id] = p;
}

void XrAnchors::destroy_slot(uint32_t anchor) {
  Slot& s = slots_[anchor_slot(anchor)];
  if (s.space != XR_NULL_HANDLE) {
    xrDestroySpace(s.space);
    std::lock_guard<std::mutex> lock(stats_mu_);
    ++destroyed_;
  }
  s = Slot{};
  table_.free(anchor);
}

void XrAnchors::settle(uint32_t anchor) {
  if (table_.state(anchor) == AnchorTable::State::kReleasing && slots_[anchor_slot(anchor)].busy == 0) {
    destroy_slot(anchor);
  }
}

void XrAnchors::on_query_results(XrAsyncRequestIdFB id) {
  auto it = pending_.find(id);
  if (it == pending_.end()) return;  // another module's query (scene)
  Pending& p = it->second;
  XrSpaceQueryResultsFB qr{XR_TYPE_SPACE_QUERY_RESULTS_FB};
  if (XR_FAILED(retrieve_results_(session_, id, &qr)) || qr.resultCountOutput == 0) return;
  std::vector<XrSpaceQueryResultFB> results(qr.resultCountOutput);
  qr.resultCapacityInput = qr.resultCountOutput;
  qr.results = results.data();
  if (XR_FAILED(retrieve_results_(session_, id, &qr))) return;
  for (uint32_t i = 0; i < qr.resultCountOutput; ++i) {
    const XrSpaceQueryResultFB& q = results[i];
    // a handle a slot owns, or that another request loaded, is that holder's: used through it, never destroyed here
    const uint32_t owner = owner_of(q.space);
    Pending* loader = nullptr;
    for (auto& [other_id, other] : pending_) {
      if (other_id != id && other.space == q.space) loader = &other;
    }
    if (!same_uuid(q.uuid, p.uuid)) {
      if (owner == 0 && !loader) xrDestroySpace(q.space);  // not asked for
      continue;
    }
    if (p.op == Op::kRestoreQuery) {
      Slot& s = slots_[anchor_slot(p.anchor)];
      if (owner != 0 && owner != p.anchor) {
        p.duplicate = true;  // already this session's anchor (restored twice): the slot keeps nothing
      } else if (s.space == XR_NULL_HANDLE) {
        s.space = q.space;
        s.uuid = q.uuid;
        if (loader && loader->anchor == 0) {
          // an erase in flight loaded the same anchor: it goes on through the slot, which it pins
          loader->space = XR_NULL_HANDLE;
          loader->anchor = p.anchor;
          ++s.busy;
        }
      }
    } else if (p.space == XR_NULL_HANDLE && p.anchor == 0) {  // kEraseQuery
      if (owner != 0) {
        p.anchor = owner;  // this session's anchor (restored meanwhile): erased through its slot, pinned
        ++slots_[anchor_slot(owner)].busy;
      } else if (!loader) {
        p.space = q.space;
      }
    }
  }
}

void XrAnchors::on_query_complete(XrAsyncRequestIdFB id, XrResult result) {
  auto it = pending_.find(id);
  if (it == pending_.end()) return;
  const Pending p = it->second;
  pending_.erase(it);
  const std::string uuid = uuid_text(p.uuid);
  if (p.op == Op::kRestoreQuery) {
    Slot& s = slots_[anchor_slot(p.anchor)];
    --s.busy;
    if (s.space == XR_NULL_HANDLE) {
      fail(p.request, 0, p.duplicate ? "the anchor with UUID " + uuid + " is already restored in this session"
                         : XR_FAILED(result) ? std::string("xrQuerySpacesFB: ") + result_name(result)
                                             : "no persisted anchor with UUID " + uuid);
      if (s.busy == 0) destroy_slot(p.anchor);
      return;
    }
    if (table_.state(p.anchor) != AnchorTable::State::kPending) {
      fail(p.request, 0, "the session ended");
      settle(p.anchor);
      return;
    }
    bool already = false;
    if (!enable_component(p.request, p.anchor, s.space, XR_SPACE_COMPONENT_TYPE_LOCATABLE_FB, Op::kLocatable,
                          &already)) {
      fail(p.request, 0, "the restored anchor cannot be located (LOCATABLE component)");
      table_.release(p.anchor);
      settle(p.anchor);
    } else if (already) {
      restored(p.request, p.anchor);
      settle(p.anchor);
    }
  } else if (p.op == Op::kEraseQuery) {
    if (p.anchor != 0) {
      start_erase(p.request, p.anchor, slots_[anchor_slot(p.anchor)].space, p.uuid);
      --slots_[anchor_slot(p.anchor)].busy;  // the query's pin; start_erase took its own
      settle(p.anchor);
      return;
    }
    if (p.space == XR_NULL_HANDLE) {
      fail(p.request, 0, XR_FAILED(result) ? std::string("xrQuerySpacesFB: ") + result_name(result)
                                           : "no persisted anchor with UUID " + uuid);
      return;
    }
    start_erase(p.request, 0, p.space, p.uuid);
  }
}

void XrAnchors::on_event(const XrEventDataBuffer& ev) {
  switch (ev.type) {
    case XR_TYPE_EVENT_DATA_SPATIAL_ANCHOR_CREATE_COMPLETE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpatialAnchorCreateCompleteFB&>(ev);
      auto it = pending_.find(e.requestId);
      if (it == pending_.end() || it->second.op != Op::kCreate) return;
      const Pending p = it->second;
      pending_.erase(it);
      Slot& s = slots_[anchor_slot(p.anchor)];
      --s.busy;
      if (XR_FAILED(e.result)) {
        // Horizon OS places anchors only with 6DoF tracking; without it the completion carries a generic runtime
        // failure (its tracking service logs "Tried to place an anchor without 6DoF tracking). The runtime still makes
        // a space for the event (XrRuntimeSystem_Client: CreateAndFinalize whatever the result): destroyed here.
        if (e.space != XR_NULL_HANDLE && owner_of(e.space) == 0) xrDestroySpace(e.space);
        fail(p.request, 0, std::string("anchor creation failed: ") + result_name(e.result) +
                               (e.result == XR_ERROR_RUNTIME_FAILURE ? " (is the headset tracking its position?)" : ""));
        table_.release(p.anchor);
        settle(p.anchor);
        return;
      }
      s.space = e.space;
      s.uuid = e.uuid;
      if (!table_.go_live(p.anchor)) {  // the session ended meanwhile
        fail(p.request, 0, "the session ended");
        settle(p.anchor);
        return;
      }
      {
        std::lock_guard<std::mutex> lock(stats_mu_);
        ++created_;
      }
      log(LogLevel::kInfo, "xr: anchor %u created (%s)", p.anchor, uuid_text(e.uuid).c_str());
      AnchorResult r;
      r.request = p.request;
      r.ok = true;
      r.anchor = p.anchor;
      finish(r);
      break;
    }
    case XR_TYPE_EVENT_DATA_SPACE_SET_STATUS_COMPLETE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpaceSetStatusCompleteFB&>(ev);
      auto it = pending_.find(e.requestId);
      if (it == pending_.end() || (it->second.op != Op::kStorable && it->second.op != Op::kLocatable &&
                                   it->second.op != Op::kEraseStorable)) {
        return;
      }
      const Pending p = it->second;
      pending_.erase(it);
      const bool ok = XR_SUCCEEDED(e.result) || e.result == XR_ERROR_SPACE_COMPONENT_STATUS_ALREADY_SET_FB;
      if (p.op == Op::kEraseStorable) {
        if (!ok) {
          if (p.anchor == 0) xrDestroySpace(p.space);
          fail(p.request, 0, std::string("enabling STORABLE for the erase: ") + result_name(e.result));
        } else {
          erase_space(p.request, p.anchor, p.anchor != 0 ? slots_[anchor_slot(p.anchor)].space : p.space, p.uuid);
        }
        if (p.anchor != 0) {
          --slots_[anchor_slot(p.anchor)].busy;
          settle(p.anchor);
        }
        break;
      }
      --slots_[anchor_slot(p.anchor)].busy;
      if (p.op == Op::kStorable) {
        if (ok) {
          do_save(p.request, p.anchor);
        } else {
          fail(p.request, p.anchor, std::string("enabling STORABLE: ") + result_name(e.result));
        }
      } else if (ok) {
        restored(p.request, p.anchor);
      } else {
        fail(p.request, 0, std::string("enabling LOCATABLE: ") + result_name(e.result));
        table_.release(p.anchor);
      }
      settle(p.anchor);
      break;
    }
    case XR_TYPE_EVENT_DATA_SPACE_SAVE_COMPLETE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpaceSaveCompleteFB&>(ev);
      auto it = pending_.find(e.requestId);
      if (it == pending_.end() || it->second.op != Op::kSave) return;
      const Pending p = it->second;
      pending_.erase(it);
      Slot& s = slots_[anchor_slot(p.anchor)];
      --s.busy;
      if (XR_FAILED(e.result)) {
        fail(p.request, p.anchor, std::string("xrSaveSpaceFB completion: ") + result_name(e.result));
      } else {
        {
          std::lock_guard<std::mutex> lock(stats_mu_);
          ++persisted_;
        }
        AnchorResult r;
        r.request = p.request;
        r.ok = true;
        r.anchor = p.anchor;
        r.uuid = uuid_text(e.uuid);
        log(LogLevel::kInfo, "xr: anchor %u persisted as %s", p.anchor, r.uuid.c_str());
        finish(r);
      }
      settle(p.anchor);
      break;
    }
    case XR_TYPE_EVENT_DATA_SPACE_ERASE_COMPLETE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpaceEraseCompleteFB&>(ev);
      auto it = pending_.find(e.requestId);
      if (it == pending_.end() || it->second.op != Op::kErase) return;
      const Pending p = it->second;
      pending_.erase(it);
      if (p.anchor != 0) {
        --slots_[anchor_slot(p.anchor)].busy;
        settle(p.anchor);
      } else if (p.space != XR_NULL_HANDLE) {
        xrDestroySpace(p.space);
      }
      if (XR_FAILED(e.result)) {
        fail(p.request, 0, std::string("xrEraseSpaceFB completion: ") + result_name(e.result));
        return;
      }
      {
        std::lock_guard<std::mutex> lock(stats_mu_);
        ++erased_;
      }
      log(LogLevel::kInfo, "xr: persisted anchor %s erased", uuid_text(p.uuid).c_str());
      AnchorResult r;
      r.request = p.request;
      r.ok = true;
      finish(r);
      break;
    }
    case XR_TYPE_EVENT_DATA_SPACE_QUERY_RESULTS_AVAILABLE_FB:
      on_query_results(reinterpret_cast<const XrEventDataSpaceQueryResultsAvailableFB&>(ev).requestId);
      break;
    case XR_TYPE_EVENT_DATA_SPACE_QUERY_COMPLETE_FB: {
      const auto& e = reinterpret_cast<const XrEventDataSpaceQueryCompleteFB&>(ev);
      on_query_complete(e.requestId, e.result);
      break;
    }
    default:
      break;
  }
}

void XrAnchors::locate(XrTime display_time) {
  last_time_ = display_time;
  if (!supported()) return;
  uint64_t lost = 0;
  for (int i = 0; i < kMaxAnchors; ++i) {
    const Slot& s = slots_[i];
    if (s.space == XR_NULL_HANDLE) continue;
    XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
    const bool located =
        XR_SUCCEEDED(xrLocateSpace(s.space, base_, display_time, &loc)) && location_valid(loc.locationFlags);
    table_.write_pose(i, loc.pose, located);
    if (!located) ++lost;
  }
  if (lost) {
    std::lock_guard<std::mutex> lock(stats_mu_);
    lost_frames_ += lost;
  }
}

void XrAnchors::end_session() {
  if (table_.release_all() == 0) return;
  int destroyed = 0;
  for (int i = 0; i < kMaxAnchors; ++i) {
    const uint32_t id = table_.id_of(i);
    if (table_.state(id) == AnchorTable::State::kReleasing && slots_[i].busy == 0) {
      destroy_slot(id);
      ++destroyed;
    }
  }
  log(LogLevel::kInfo, "xr: WebXR session ended: %d anchor(s) destroyed (persisted copies stay)", destroyed);
}

void XrAnchors::shutdown() {
  for (int i = 0; i < kMaxAnchors; ++i) {
    if (slots_[i].space != XR_NULL_HANDLE) xrDestroySpace(slots_[i].space);
    slots_[i] = Slot{};
  }
  for (auto& [id, p] : pending_) {
    if (p.space != XR_NULL_HANDLE) xrDestroySpace(p.space);
  }
  pending_.clear();
  table_.clear();
  supported_.store(false, std::memory_order_release);
  persistence_.store(false, std::memory_order_release);
  session_ = XR_NULL_HANDLE;
  base_ = XR_NULL_HANDLE;
  last_time_ = 0;
}

}  // namespace iwn::xr
