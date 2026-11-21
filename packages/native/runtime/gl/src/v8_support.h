/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Helpers shared by the generated natives (generated/gl_natives.gen.cc) and the hand-written V8 glue.
// Compiles against V8 15.5 (device) and the V8 that ships inside Node 24 (13.6, host test addon).
//
// Typed arrays by pointer: fast-API calls in these V8 versions take typed arrays as v8::Local<v8::Value>;
// ArrayBufferView::GetContents() returns a span into the off-heap backing store without allocating, or
// copies a small on-heap array (<= typed_array_max_size_in_heap, 64 bytes by default) into caller storage.
// Writes therefore need a view with a materialised buffer: the JS layer touches `view.buffer` once
// before passing a view that natives write to (see web/webgl/context.ts `_outView`), and the slow path
// materialises it itself.
#pragma once

#include <v8-array-buffer.h>
#include <v8-context.h>
#include <v8-fast-api-calls.h>
#include <v8-function-callback.h>
#include <v8-isolate.h>
#include <v8-primitive.h>
#include <v8-typed-array.h>
#include <v8-value.h>
#include <v8-array-buffer.h>
#include <v8-object.h>
#include <v8-container.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "stats.h"

namespace iwn::gl {

struct NativeDesc {
  const char* name;
  v8::FunctionCallback slow;
  const v8::CFunction* fast;  // nullptr: slow path only (allocates JS values or takes strings)
  int length;
};

namespace v8s {

inline constexpr size_t kInlineViewStorage = 128;  // >= typed_array_max_size_in_heap (64)

struct ViewSpan {
  uint8_t* data;
  size_t len;
};

inline ViewSpan ReadableView(v8::Local<v8::Value> value, uint8_t* storage) {
  if (value.IsEmpty() || !value->IsArrayBufferView()) return {nullptr, 0};
  auto contents = value.As<v8::ArrayBufferView>()->GetContents({storage, kInlineViewStorage});
  return {contents.data(), contents.size()};
}

// Fast path: only views that already own an ArrayBuffer can be written in place.
inline ViewSpan WritableView(v8::Local<v8::Value> value, uint8_t* storage) {
  if (value.IsEmpty() || !value->IsArrayBufferView()) return {nullptr, 0};
  auto view = value.As<v8::ArrayBufferView>();
  if (!view->HasBuffer()) return {nullptr, 0};
  auto contents = view->GetContents({storage, kInlineViewStorage});
  if (contents.data() == storage) return {nullptr, 0};
  return {contents.data(), contents.size()};
}

// Slow path: materialise the buffer first (may allocate; allowed here).
inline ViewSpan WritableViewSlow(v8::Local<v8::Value> value, uint8_t* storage) {
  if (value.IsEmpty() || !value->IsArrayBufferView()) return {nullptr, 0};
  auto view = value.As<v8::ArrayBufferView>();
  (void)view->Buffer();
  return WritableView(value, storage);
}

inline bool InBounds(const ViewSpan& s, uint32_t off, uint32_t bytes) {
  if (bytes == 0) return off <= s.len;  // empty ranges are fine (the GL call sees count 0 / size 0)
  return s.data != nullptr && off <= s.len && bytes <= s.len - off;
}

template <typename T>
inline bool NeedOk(uint32_t bytes, T need) {
  return need >= 0 && static_cast<double>(bytes) >= static_cast<double>(need);
}

inline void CountCall() { Stats().nativeCalls++; }

inline v8::Local<v8::Context> Ctx(const v8::FunctionCallbackInfo<v8::Value>& info) {
  return info.GetIsolate()->GetCurrentContext();
}

inline uint32_t ArgU32(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  if (i >= info.Length()) return 0;
  v8::Local<v8::Value> v = info[i];
  if (v->IsUint32()) return v.As<v8::Uint32>()->Value();
  return v->Uint32Value(Ctx(info)).FromMaybe(0);
}
inline int32_t ArgI32(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  if (i >= info.Length()) return 0;
  v8::Local<v8::Value> v = info[i];
  if (v->IsInt32()) return v.As<v8::Int32>()->Value();
  return v->Int32Value(Ctx(info)).FromMaybe(0);
}
inline double ArgF64(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  if (i >= info.Length()) return 0;
  v8::Local<v8::Value> v = info[i];
  if (v->IsNumber()) return v.As<v8::Number>()->Value();
  return v->NumberValue(Ctx(info)).FromMaybe(0);
}
inline float ArgF32(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  return static_cast<float>(ArgF64(info, i));
}
inline bool ArgBool(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  if (i >= info.Length()) return false;
  return info[i]->BooleanValue(info.GetIsolate());
}
inline std::string ToStdString(v8::Isolate* isolate, v8::Local<v8::Value> v) {
  v8::String::Utf8Value s(isolate, v);
  return *s ? std::string(*s, s.length()) : std::string();
}
inline std::string ArgString(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  if (i >= info.Length()) return std::string();
  return ToStdString(info.GetIsolate(), info[i]);
}
inline std::vector<std::string> ArgStrings(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  std::vector<std::string> out;
  if (i >= info.Length() || !info[i]->IsArray()) return out;
  auto arr = info[i].As<v8::Array>();
  auto ctx = Ctx(info);
  out.reserve(arr->Length());
  for (uint32_t k = 0; k < arr->Length(); ++k) {
    v8::Local<v8::Value> e;
    if (!arr->Get(ctx, k).ToLocal(&e)) break;
    out.push_back(ToStdString(info.GetIsolate(), e));
  }
  return out;
}

}  // namespace v8s
}  // namespace iwn::gl
