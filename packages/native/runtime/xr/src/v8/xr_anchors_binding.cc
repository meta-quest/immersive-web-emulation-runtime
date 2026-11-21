/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// V8 binding of the spatial anchors (android/xr_anchors.h, XR-ANCHOR-1): members of globalThis.__iwn.xr that web/xr's
// anchor hooks call. Written from the V8 embedder headers like xr_binding.cc.
//
// JS API:
//   anchorPoses() -> ArrayBuffer         the pose buffer (iwn/xr/anchors.h layout), the same memory every call
//   anchorCreate(px, py, pz, qx, qy, qz, qw) -> request   a pose in the base space
//   anchorPersist(anchor) -> request     anchorRestore(uuid) -> request     anchorErase(uuid) -> request
//   anchorDestroy(anchor)
//   anchorResults() -> [{ request, ok, anchor?, uuid?, error? }] | undefined   finished requests since the last call
//   anchorStats() -> object              counters for tools and tests
// A request number of 0 means refused at once (no anchor support).
#include <v8.h>

#include <cmath>
#include <string>
#include <vector>

#include "android/xr_system.h"

namespace {

using iwn::xr::AnchorResult;
using iwn::xr::XrSystem;

v8::Local<v8::String> str(v8::Isolate* iso, const char* s) {
  return v8::String::NewFromUtf8(iso, s, v8::NewStringType::kInternalized).ToLocalChecked();
}

v8::Local<v8::String> text(v8::Isolate* iso, const std::string& s) {
  return v8::String::NewFromUtf8(iso, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size()))
      .ToLocalChecked();
}

double num(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  if (info.Length() <= i) return 0;
  const double v = info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).FromMaybe(0);
  return std::isfinite(v) ? v : 0;
}

uint32_t id_arg(const v8::FunctionCallbackInfo<v8::Value>& info) {
  const double v = num(info, 0);
  return v >= 0 && v <= 4294967295.0 ? static_cast<uint32_t>(v) : 0;
}

std::string string_arg(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsString()) return {};
  v8::String::Utf8Value s(info.GetIsolate(), info[0]);
  return *s ? std::string(*s, s.length()) : std::string();
}

void AnchorPoses(const v8::FunctionCallbackInfo<v8::Value>& info) {
  std::shared_ptr<v8::BackingStore> store =
      v8::ArrayBuffer::NewBackingStore(XrSystem::get().anchors().poses(), iwn::xr::XrAnchors::pose_bytes(),
                                       v8::BackingStore::EmptyDeleter, nullptr);
  info.GetReturnValue().Set(v8::ArrayBuffer::New(info.GetIsolate(), std::move(store)));
}

void AnchorCreate(const v8::FunctionCallbackInfo<v8::Value>& info) {
  XrPosef pose;
  pose.position = {static_cast<float>(num(info, 0)), static_cast<float>(num(info, 1)), static_cast<float>(num(info, 2))};
  pose.orientation = {static_cast<float>(num(info, 3)), static_cast<float>(num(info, 4)),
                      static_cast<float>(num(info, 5)), static_cast<float>(num(info, 6))};
  const float len = std::sqrt(pose.orientation.x * pose.orientation.x + pose.orientation.y * pose.orientation.y +
                              pose.orientation.z * pose.orientation.z + pose.orientation.w * pose.orientation.w);
  if (!(len > 1e-6f)) {
    pose.orientation = {0, 0, 0, 1};
  } else {  // OpenXR rejects a quaternion that is not unit length (XR_ERROR_POSE_INVALID)
    pose.orientation = {pose.orientation.x / len, pose.orientation.y / len, pose.orientation.z / len,
                        pose.orientation.w / len};
  }
  info.GetReturnValue().Set(XrSystem::get().anchors().create(pose));
}

void AnchorPersist(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(XrSystem::get().anchors().persist(id_arg(info)));
}

void AnchorRestore(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(XrSystem::get().anchors().restore(string_arg(info)));
}

void AnchorErase(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(XrSystem::get().anchors().erase(string_arg(info)));
}

void AnchorDestroy(const v8::FunctionCallbackInfo<v8::Value>& info) { XrSystem::get().anchors().destroy(id_arg(info)); }

void AnchorResults(const v8::FunctionCallbackInfo<v8::Value>& info) {
  static std::vector<AnchorResult>* list = new std::vector<AnchorResult>();
  list->clear();
  if (!XrSystem::get().anchors().take_results(list)) return;  // undefined: nothing finished
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso, static_cast<int>(list->size()));
  uint32_t i = 0;
  for (const AnchorResult& r : *list) {
    v8::Local<v8::Object> o = v8::Object::New(iso);
    o->Set(ctx, str(iso, "request"), v8::Integer::NewFromUnsigned(iso, r.request)).Check();
    o->Set(ctx, str(iso, "ok"), v8::Boolean::New(iso, r.ok)).Check();
    if (r.anchor) o->Set(ctx, str(iso, "anchor"), v8::Integer::NewFromUnsigned(iso, r.anchor)).Check();
    if (!r.uuid.empty()) o->Set(ctx, str(iso, "uuid"), text(iso, r.uuid)).Check();
    if (!r.error.empty()) o->Set(ctx, str(iso, "error"), text(iso, r.error)).Check();
    arr->Set(ctx, i++, o).Check();
  }
  info.GetReturnValue().Set(arr);
}

void AnchorStats(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  const std::string json = XrSystem::get().anchors().stats().dump();
  v8::Local<v8::Value> out;
  if (v8::JSON::Parse(iso->GetCurrentContext(), text(iso, json)).ToLocal(&out)) info.GetReturnValue().Set(out);
}

void set_fn(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* name,
            v8::FunctionCallback cb) {
  v8::Local<v8::Function> fn = v8::Function::New(ctx, cb).ToLocalChecked();
  fn->SetName(str(iso, name));
  o->Set(ctx, str(iso, name), fn).Check();
}

}  // namespace

void iwn_register_xr_anchors(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> xr) {
  set_fn(isolate, ctx, xr, "anchorPoses", AnchorPoses);
  set_fn(isolate, ctx, xr, "anchorCreate", AnchorCreate);
  set_fn(isolate, ctx, xr, "anchorPersist", AnchorPersist);
  set_fn(isolate, ctx, xr, "anchorRestore", AnchorRestore);
  set_fn(isolate, ctx, xr, "anchorErase", AnchorErase);
  set_fn(isolate, ctx, xr, "anchorDestroy", AnchorDestroy);
  set_fn(isolate, ctx, xr, "anchorResults", AnchorResults);
  set_fn(isolate, ctx, xr, "anchorStats", AnchorStats);
}
