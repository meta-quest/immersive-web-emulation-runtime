/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Composite natives that return JS values (slow path only): reflection records, shader status, strings.
// The record layouts are decoded by web/webgl/reflection.ts; keep the two in sync.

#include <v8-container.h>
#include <v8-context.h>
#include <v8-isolate.h>
#include <v8-local-handle.h>
#include <v8-primitive.h>

#include "composites.h"
#include "egl_context.h"

namespace iwn::gl::v8c {

namespace {

v8::Local<v8::String> Str(v8::Isolate* isolate, const std::string& s) {
  return v8::String::NewFromUtf8(isolate, s.data(), v8::NewStringType::kNormal, int(s.size())).ToLocalChecked();
}

v8::Local<v8::Array> Arr(v8::Isolate* isolate, std::vector<v8::Local<v8::Value>>& items) {
  return v8::Array::New(isolate, items.data(), items.size());
}

v8::Local<v8::Value> Int(v8::Isolate* isolate, int64_t v) { return v8::Number::New(isolate, double(v)); }

}  // namespace

// [compileStatus, infoLog]
v8::Local<v8::Value> shaderInfo(v8::Isolate* isolate, uint32_t shader) {
  ShaderStatus s = CollectShaderStatus(shader);
  std::vector<v8::Local<v8::Value>> items = {v8::Boolean::New(isolate, s.compiled), Str(isolate, s.infoLog)};
  return Arr(isolate, items);
}

// [validateStatus, infoLog]
v8::Local<v8::Value> programValidate(v8::Isolate* isolate, uint32_t program) {
  Stats().syncQueries++;
  GLint ok = 0;
  Api().GetProgramiv(program, GL_VALIDATE_STATUS, &ok);
  GLint len = 0;
  Api().GetProgramiv(program, GL_INFO_LOG_LENGTH, &len);
  std::string log;
  if (len > 1) {
    log.resize(size_t(len));
    GLsizei w = 0;
    Api().GetProgramInfoLog(program, len, &w, log.data());
    log.resize(size_t(w > 0 ? w : 0));
  }
  std::vector<v8::Local<v8::Value>> items = {v8::Boolean::New(isolate, ok != 0), Str(isolate, log)};
  return Arr(isolate, items);
}

// Program record (web/webgl/reflection.ts decodes it):
// [ linked, infoLog,
//   attributes: [name, type, size, location]*,
//   uniforms:   [name, type, size, location | locations[], blockIndex, offset, arrayStride, matrixStride, rowMajor]*,
//   blocks:     [name, binding, dataSize, activeUniformIndices[], refVS, refFS]*,
//   tfVaryings: [name, type, size]*,
//   tfBufferMode,
//   fragmentOutputs: [name, type, location, arraySize]* | null (driver without program interface queries) ]
v8::Local<v8::Value> programInfo(v8::Isolate* isolate, uint32_t program) {
  ProgramRecord r = CollectProgramRecord(program);
  std::vector<v8::Local<v8::Value>> attrs, unis, blocks, tfs, outs;
  for (const auto& a : r.attributes) {
    attrs.push_back(Str(isolate, a.name));
    attrs.push_back(Int(isolate, a.type));
    attrs.push_back(Int(isolate, a.size));
    attrs.push_back(Int(isolate, a.location));
  }
  for (const auto& u : r.uniforms) {
    unis.push_back(Str(isolate, u.name));
    unis.push_back(Int(isolate, u.type));
    unis.push_back(Int(isolate, u.size));
    if (u.elementLocations.size() > 1) {
      std::vector<v8::Local<v8::Value>> locs;
      for (int32_t l : u.elementLocations) locs.push_back(Int(isolate, l));
      unis.push_back(Arr(isolate, locs));
    } else {
      unis.push_back(Int(isolate, u.location));
    }
    unis.push_back(Int(isolate, u.blockIndex));
    unis.push_back(Int(isolate, u.offset));
    unis.push_back(Int(isolate, u.arrayStride));
    unis.push_back(Int(isolate, u.matrixStride));
    unis.push_back(Int(isolate, u.isRowMajor));
  }
  for (const auto& b : r.blocks) {
    blocks.push_back(Str(isolate, b.name));
    blocks.push_back(Int(isolate, b.binding));
    blocks.push_back(Int(isolate, b.dataSize));
    std::vector<v8::Local<v8::Value>> idx;
    for (uint32_t i : b.activeUniformIndices) idx.push_back(Int(isolate, i));
    blocks.push_back(Arr(isolate, idx));
    blocks.push_back(v8::Boolean::New(isolate, b.referencedByVertexShader));
    blocks.push_back(v8::Boolean::New(isolate, b.referencedByFragmentShader));
  }
  for (const auto& t : r.transformFeedbackVaryings) {
    tfs.push_back(Str(isolate, t.name));
    tfs.push_back(Int(isolate, t.type));
    tfs.push_back(Int(isolate, t.size));
  }
  for (const auto& o : r.fragmentOutputs) {
    outs.push_back(Str(isolate, o.name));
    outs.push_back(Int(isolate, o.type));
    outs.push_back(Int(isolate, o.location));
    outs.push_back(Int(isolate, o.size));
  }
  std::vector<v8::Local<v8::Value>> items = {
      v8::Boolean::New(isolate, r.linked), Str(isolate, r.infoLog), Arr(isolate, attrs), Arr(isolate, unis),
      Arr(isolate, blocks),                Arr(isolate, tfs),        Int(isolate, r.transformFeedbackBufferMode),
      r.fragmentOutputsKnown ? v8::Local<v8::Value>(Arr(isolate, outs)) : v8::Local<v8::Value>(v8::Null(isolate))};
  return Arr(isolate, items);
}

v8::Local<v8::Value> getString(v8::Isolate* isolate, uint32_t name) {
  const GLubyte* s = Api().GetString(name);
  if (!s) return v8::Null(isolate);
  return Str(isolate, reinterpret_cast<const char*>(s));
}

// { version, renderer, vendor, glsl, extensions: string[], robust: bool, contextId }
v8::Local<v8::Value> contextInfo(v8::Isolate* isolate, uint32_t id) {
  auto& env = EglEnvironment::Get();
  if (!env.MakeCurrent(id)) return v8::Null(isolate);
  auto ctx = isolate->GetCurrentContext();
  auto obj = v8::Object::New(isolate);
  auto str = [&](GLenum e) {
    const GLubyte* s = Api().GetString(e);
    return Str(isolate, s ? reinterpret_cast<const char*>(s) : "");
  };
  obj->Set(ctx, Str(isolate, "version"), str(GL_VERSION)).Check();
  obj->Set(ctx, Str(isolate, "renderer"), str(GL_RENDERER)).Check();
  obj->Set(ctx, Str(isolate, "vendor"), str(GL_VENDOR)).Check();
  obj->Set(ctx, Str(isolate, "glsl"), str(GL_SHADING_LANGUAGE_VERSION)).Check();
  std::vector<v8::Local<v8::Value>> exts;
  for (const auto& e : GlExtensions()) exts.push_back(Str(isolate, e));
  obj->Set(ctx, Str(isolate, "extensions"), Arr(isolate, exts)).Check();
  obj->Set(ctx, Str(isolate, "robust"), v8::Boolean::New(isolate, env.robustAvailable())).Check();
  obj->Set(ctx, Str(isolate, "contextId"), Int(isolate, id)).Check();
  return obj;
}

}  // namespace iwn::gl::v8c
