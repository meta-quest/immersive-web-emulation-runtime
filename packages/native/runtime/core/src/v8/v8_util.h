/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Small V8 helpers shared by the core's binding layer.
#pragma once

#include <v8.h>

#include <string>
#include <string_view>

namespace iwn::v8u {

inline v8::Local<v8::String> str(v8::Isolate* isolate, std::string_view s) {
  return v8::String::NewFromUtf8(isolate, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size()))
      .ToLocalChecked();
}
inline v8::Local<v8::String> sym(v8::Isolate* isolate, const char* s) {
  return v8::String::NewFromUtf8(isolate, s, v8::NewStringType::kInternalized).ToLocalChecked();
}
std::string to_utf8(v8::Isolate* isolate, v8::Local<v8::Value> value);
// String(value) without throwing (falls back to "<unprintable>").
std::string safe_to_string(v8::Isolate* isolate, v8::Local<v8::Value> value);

void throw_type_error(v8::Isolate* isolate, std::string_view message);
void throw_error(v8::Isolate* isolate, std::string_view message);

void set_function(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
                  v8::FunctionCallback cb, v8::Local<v8::Value> data = v8::Local<v8::Value>());
void set_value(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
               v8::Local<v8::Value> value);

// "message\n    at ..." from an exception value: its `stack` if it is a string, else String(value).
std::string exception_text(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> exception);

}  // namespace iwn::v8u
