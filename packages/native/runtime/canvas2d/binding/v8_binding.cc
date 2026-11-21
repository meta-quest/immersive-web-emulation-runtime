/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// V8 binding for canvas2d: decodes arguments and wraps handles; every operation is in api.cc (shared with the
// Node-API test addon, so headless tests exercise the same code as the device). Written against the V8 15.5
// embedder API (v8.h): FunctionTemplate callbacks, ObjectTemplate internal fields, weak Globals for lifetime and
// v8::ExternalMemoryAccounter for pixel memory (IMG-7).

#include <cstring>
#include <cmath>
#include <mutex>
#include <string>
#include <new>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <v8-external-memory-accounter.h>

#include "api.h"
#include "canvas2d_v8.h"

#if defined(IWN_C2D_WITH_IMAGE)
#include "iwn/image/pixels.h"
#include "iwn/image/v8_binding.h"
#endif
#if defined(IWN_HAVE_CORE_RUNTIME)
#include "iwn/core/runtime.h"
#endif

using namespace iwn::canvas2d;
using namespace iwn::canvas2d::api;

namespace {

constexpr v8::EmbedderDataTypeTag kTag = v8::kEmbedderDataTypeTagDefault;
int g_marker;  // address identifies our wrappers in internal field 0

struct Wrapper {
  v8::Global<v8::Object> ref;
  Handle* handle;
  int64_t reported;
  v8::ExternalMemoryAccounter accounter;
  v8::Isolate* isolate;
};

// Live wrappers per isolate, so DisposeIsolate() can free what V8 will never finalize (weak callbacks do not run at
// isolate teardown). The wrapper template itself is per context (the callbacks' data), so nothing here outlives an
// isolate once DisposeIsolate() ran.
std::mutex g_live_mutex;
std::unordered_map<v8::Isolate*, std::unordered_set<Wrapper*>>& Live() {
  static auto* m = new std::unordered_map<v8::Isolate*, std::unordered_set<Wrapper*>>();
  return *m;
}

void FreeWrapper(Wrapper* w) {
  if (w->reported) w->accounter.Decrease(w->isolate, static_cast<size_t>(w->reported));
  w->ref.Reset();
  delete w->handle;
  delete w;
}

void WeakCallback(const v8::WeakCallbackInfo<Wrapper>& info) {
  Wrapper* w = info.GetParameter();
  {
    std::lock_guard<std::mutex> l(g_live_mutex);
    auto it = Live().find(w->isolate);
    if (it != Live().end()) it->second.erase(w);
  }
  FreeWrapper(w);
}

// `ctor` is the per-context wrapper constructor (a function whose instances have two internal fields).
v8::Local<v8::Value> Wrap(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> ctor, Handle* h) {
  v8::Local<v8::Object> obj;
  if (!ctor->IsFunction() || !ctor.As<v8::Function>()->NewInstance(ctx).ToLocal(&obj)) {
    delete h;
    return v8::Null(isolate);
  }
  auto* w = new Wrapper{v8::Global<v8::Object>(isolate, obj), h, static_cast<int64_t>(h->ExternalBytes()), {}, isolate};
  obj->SetAlignedPointerInInternalField(0, &g_marker, kTag);
  obj->SetAlignedPointerInInternalField(1, w, kTag);
  w->ref.SetWeak(w, WeakCallback, v8::WeakCallbackType::kParameter);
  if (w->reported) w->accounter.Increase(isolate, static_cast<size_t>(w->reported));
  {
    std::lock_guard<std::mutex> l(g_live_mutex);
    Live()[isolate].insert(w);
  }
  return obj;
}

Wrapper* Unwrap(v8::Local<v8::Value> v) {
  if (!v->IsObject()) return nullptr;
  v8::Local<v8::Object> o = v.As<v8::Object>();
  if (o->InternalFieldCount() != 2) return nullptr;
  if (o->GetAlignedPointerFromInternalField(0, kTag) != &g_marker) return nullptr;
  return static_cast<Wrapper*>(o->GetAlignedPointerFromInternalField(1, kTag));
}

// Re-report external memory after a size change (surface resize).
void Rereport(v8::Isolate* isolate, Wrapper* w) {
  int64_t now = static_cast<int64_t>(w->handle->ExternalBytes());
  if (now != w->reported) {
    w->accounter.Update(isolate, now - w->reported);
    w->reported = now;
  }
}

struct Args {
  const v8::FunctionCallbackInfo<v8::Value>& info;
  v8::Isolate* isolate;
  v8::Local<v8::Context> ctx;
  explicit Args(const v8::FunctionCallbackInfo<v8::Value>& i)
      : info(i), isolate(i.GetIsolate()), ctx(i.GetIsolate()->GetCurrentContext()) {}
  v8::Local<v8::Value> WrapHandle(Handle* h) const { return Wrap(isolate, ctx, info.Data(), h); }
  v8::Local<v8::Value> At(int i) const { return info[i]; }
  // Numbers and booleans only; anything else is `def`. Never calls NumberValue(): on an object that runs user
  // valueOf, which could detach or resize a typed array whose raw pointer a callback already holds (Floats, State).
  // The web layer always converts arguments before calling natives, so this changes nothing for it.
  double Num(int i, double def = 0) const {
    v8::Local<v8::Value> v = info[i];
    if (v->IsNumber()) return v.As<v8::Number>()->Value();
    if (v->IsBoolean()) return v->IsTrue() ? 1 : 0;
    return def;
  }
  int Int(int i, int def = 0) const { return ToInt(Num(i, def), def); }
  bool Bool(int i) const { return info[i]->BooleanValue(isolate); }
  Handle* Obj(int i, HandleKind kind) const {
    Wrapper* w = Unwrap(info[i]);
    return (w && w->handle->kind == kind) ? w->handle : nullptr;
  }
  Wrapper* Wrapped(int i) const { return Unwrap(info[i]); }
  Handle* Paint(int i) const {
    Wrapper* w = Unwrap(info[i]);
    if (!w) return nullptr;
    HandleKind k = w->handle->kind;
    return (k == HandleKind::kGradient || k == HandleKind::kPattern) ? w->handle : nullptr;
  }
  template <class T>
  T* Typed(int i, size_t* count) const {
    v8::Local<v8::Value> v = info[i];
    if (!v->IsArrayBufferView()) return nullptr;
    v8::Local<v8::ArrayBufferView> view = v.As<v8::ArrayBufferView>();
    *count = view->ByteLength() / sizeof(T);
    return reinterpret_cast<T*>(static_cast<uint8_t*>(view->Buffer()->Data()) + view->ByteOffset());
  }
  const double* State(int i) const {
    if (!info[i]->IsFloat64Array()) return nullptr;
    size_t n = 0;
    const double* s = Typed<double>(i, &n);
    return n >= kStateSize ? s : nullptr;
  }
  Span Floats(int i, int len_arg) const {
    if (!info[i]->IsFloat32Array()) return {};
    size_t n = 0;
    const float* f = Typed<float>(i, &n);
    double l = Num(len_arg, double(n));
    return {f, (l >= 0 && l <= double(n)) ? static_cast<size_t>(l) : n};
  }
  Span FloatsAll(int i) const {
    if (!info[i]->IsFloat32Array()) return {};
    size_t n = 0;
    const float* f = Typed<float>(i, &n);
    return {f, n};
  }
  const uint8_t* Bytes(int i, size_t* n) const {
    v8::Local<v8::Value> v = info[i];
    if (v->IsUint8Array() || v->IsUint8ClampedArray()) return Typed<uint8_t>(i, n);
    if (v->IsArrayBuffer()) {
      v8::Local<v8::ArrayBuffer> ab = v.As<v8::ArrayBuffer>();
      *n = ab->ByteLength();
      return static_cast<const uint8_t*>(ab->Data());
    }
    return nullptr;
  }
  // Strings only (no ToString on objects: user code, see Num()).
  std::u16string Str16(int i) const {
    if (!info[i]->IsString()) return {};
    v8::Local<v8::String> s = info[i].As<v8::String>();
    std::u16string out(s->Length(), u'\0');
    s->Write(isolate, 0, s->Length(), reinterpret_cast<uint16_t*>(out.data()));
    return out;
  }
  std::string Str8(int i) const {
    if (!info[i]->IsString()) return {};
    v8::String::Utf8Value u(isolate, info[i]);
    return *u ? std::string(*u, u.length()) : std::string();
  }
  void Return(v8::Local<v8::Value> v) const { info.GetReturnValue().Set(v); }
  void Return(bool b) const { info.GetReturnValue().Set(b); }
  void Throw(const char* msg) const {
    isolate->ThrowException(v8::Exception::TypeError(v8::String::NewFromUtf8(isolate, msg).ToLocalChecked()));
  }
};

v8::Local<v8::String> S(v8::Isolate* isolate, const std::string& s) {
  return v8::String::NewFromUtf8(isolate, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size()))
      .ToLocalChecked();
}

#define SURFACE_STATE(fname)                                                   \
  Args a(info);                                                                \
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));       \
  const double* st = a.State(1);                                               \
  if (!s || !st) return a.Throw("canvas2d." fname ": bad surface or state");

void CreateSurfaceCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* h = new SurfaceHandle();
  h->surface.Resize(a.Int(0), a.Int(1));
  a.Return(a.WrapHandle(h));
}

void ResizeCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  Wrapper* w = a.Wrapped(0);
  if (!w || w->handle->kind != HandleKind::kSurface) return a.Throw("canvas2d.resize: not a surface");
  bool ok = static_cast<SurfaceHandle*>(w->handle)->surface.Resize(a.Int(1), a.Int(2));
  Rereport(a.isolate, w);
  a.Return(ok);
}

void FillCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("fill");
  Fill(s, st, a.Floats(2, 3), a.Paint(4), static_cast<ClipHandle*>(a.Obj(5, HandleKind::kClip)));
}

void StrokeCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("stroke");
  Stroke(s, st, a.Floats(2, 3), a.Paint(4), static_cast<ClipHandle*>(a.Obj(5, HandleKind::kClip)), a.FloatsAll(6));
}

void ClearRectCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("clearRect");
  ClearRect(s, st, a.Num(2), a.Num(3), a.Num(4), a.Num(5), static_cast<ClipHandle*>(a.Obj(6, HandleKind::kClip)));
}

void ClipCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("clip");
  auto h = Clip(s, st, a.Floats(2, 3), static_cast<ClipHandle*>(a.Obj(4, HandleKind::kClip)));
  // Optional arg 5: a clip handle the caller no longer references; the new mask goes into it (no new JS object).
  Wrapper* reuse = a.Wrapped(5);
  if (reuse && reuse->handle->kind == HandleKind::kClip) {
    static_cast<ClipHandle*>(reuse->handle)->mask = std::move(h->mask);
    Rereport(a.isolate, reuse);
    return a.Return(a.At(5));
  }
  a.Return(a.WrapHandle(h.release()));
}

void IsPointInPathCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("isPointInPath");
  a.Return(IsPointInPath(s, st, a.Floats(2, 3), a.Num(4), a.Num(5)));
}

void IsPointInStrokeCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("isPointInStroke");
  a.Return(IsPointInStroke(s, st, a.Floats(2, 3), a.Num(4), a.Num(5), a.FloatsAll(6)));
}

void DrawSurfaceCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("drawSurface");
  auto* src = static_cast<SurfaceHandle*>(a.Obj(2, HandleKind::kSurface));
  if (!src) return a.Throw("canvas2d.drawSurface: bad source");
  double r[8];
  for (int i = 0; i < 8; i++) r[i] = a.Num(3 + i);
  DrawImage(s, st, src->surface.View(), r, static_cast<ClipHandle*>(a.Obj(11, HandleKind::kClip)));
}

void DrawPixelsCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("drawPixels");
  size_t n = 0;
  const uint8_t* px = a.Bytes(2, &n);
  int w = a.Int(3), h = a.Int(4);
  if (!px || !PixelBytesFit(n, w, h)) return a.Throw("canvas2d.drawPixels: bad pixels");
  ImageView v{px, w, h, size_t(w) * 4, a.Bool(5)};
  double r[8];
  for (int i = 0; i < 8; i++) r[i] = a.Num(6 + i);
  DrawImage(s, st, v, r, static_cast<ClipHandle*>(a.Obj(14, HandleKind::kClip)));
}

void DrawExternalCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  SURFACE_STATE("drawExternal");
  ExternalImageResolver resolver = GetExternalImageResolver();
  ImageView view;
  std::shared_ptr<void> keep;
  v8::Local<v8::Value> obj = a.At(2);
  if (!resolver || !resolver(&obj, &view, &keep)) return a.Return(false);
  double r[8];
  for (int i = 0; i < 8; i++) r[i] = a.Num(3 + i);
  DrawImage(s, st, view, r, static_cast<ClipHandle*>(a.Obj(11, HandleKind::kClip)));
  a.Return(true);
}

void GetImageDataCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  size_t n = 0;
  uint8_t* out = a.info[5]->IsUint8ClampedArray() || a.info[5]->IsUint8Array() ? a.Typed<uint8_t>(5, &n) : nullptr;
  int w = a.Int(3), h = a.Int(4);
  if (!s || !out || !PixelBytesFit(n, w, h)) return a.Throw("canvas2d.getImageData: bad args");
  s->canvas.GetImageData(a.Int(1), a.Int(2), w, h, out);
}

void PutImageDataCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  size_t n = 0;
  const uint8_t* data = a.Bytes(1, &n);
  int dw = a.Int(2), dh = a.Int(3);
  if (!s || !data || !PixelBytesFit(n, dw, dh)) return a.Throw("canvas2d.putImageData: bad args");
  s->canvas.PutImageData(data, dw, dh, a.Int(4), a.Int(5), a.Int(6),
                         a.Int(7), a.Int(8), a.Int(9));
}

void ReadPixelsCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  size_t n = 0;
  uint8_t* out = const_cast<uint8_t*>(a.Bytes(1, &n));
  if (!s || !out || n < s->surface.byte_size()) return a.Throw("canvas2d.readPixels: bad args");
  // An unallocated (oversize) bitmap reads as transparent black, not as what the shared buffer held before.
  if (s->surface.byte_size() < n) std::memset(out + s->surface.byte_size(), 0, n - s->surface.byte_size());
  ReadPixels(s->surface, out, a.Bool(2), a.Bool(3));
}

void EncodeCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  if (!s) return a.Throw("canvas2d.encode: bad surface");
  std::vector<uint8_t> out;
  std::string used;
  if (!EncodeImage(s->surface, a.Str8(1), a.Num(2, -1), &out, &used)) return a.Return(v8::Null(a.isolate));
  v8::Local<v8::ArrayBuffer> ab = v8::ArrayBuffer::New(a.isolate, out.size());
  std::copy(out.begin(), out.end(), static_cast<uint8_t*>(ab->Data()));
  v8::Local<v8::Value> items[] = {ab, S(a.isolate, used)};
  a.Return(v8::Array::New(a.isolate, items, 2));
}

void CreateGradientCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  int kind = a.Int(0);
  double p[6];
  for (int i = 0; i < 6; i++) p[i] = a.Num(1 + i);
  a.Return(a.WrapHandle(
                new GradientHandle(kind == 1 ? Gradient::Kind::kRadial : kind == 2 ? Gradient::Kind::kConic : Gradient::Kind::kLinear, p)));
}

void AddColorStopCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* g = static_cast<GradientHandle*>(a.Obj(0, HandleKind::kGradient));
  if (!g) return a.Throw("canvas2d.addColorStop: bad gradient");
  g->gradient.AddStop(a.Num(1), static_cast<float>(a.Num(2)), static_cast<float>(a.Num(3)), static_cast<float>(a.Num(4)),
                      static_cast<float>(a.Num(5)));
}

void CreatePatternFromSurfaceCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* src = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  if (!src) return a.Throw("canvas2d.createPatternFromSurface: bad source");
  a.Return(a.WrapHandle(CreatePattern(src->surface.View(), a.Bool(1), a.Bool(2)).release()));
}

void CreatePatternFromPixelsCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  size_t n = 0;
  const uint8_t* px = a.Bytes(0, &n);
  int w = a.Int(1), h = a.Int(2);
  if (!px || !PixelBytesFit(n, w, h)) return a.Throw("canvas2d.createPatternFromPixels: bad pixels");
  ImageView v{px, w, h, size_t(w) * 4, a.Bool(3)};
  a.Return(a.WrapHandle(CreatePattern(v, a.Bool(4), a.Bool(5)).release()));
}

void CreatePatternFromExternalCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  ExternalImageResolver resolver = GetExternalImageResolver();
  ImageView view;
  std::shared_ptr<void> keep;
  v8::Local<v8::Value> obj = a.At(0);
  if (!resolver || !resolver(&obj, &view, &keep)) return a.Return(v8::Null(a.isolate));
  a.Return(a.WrapHandle(CreatePattern(view, a.Bool(1), a.Bool(2)).release()));
}

void SetPatternTransformCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* p = static_cast<PatternHandle*>(a.Obj(0, HandleKind::kPattern));
  if (!p) return a.Throw("canvas2d.setPatternTransform: bad pattern");
  p->pattern.SetTransform(Matrix{a.Num(1), a.Num(2), a.Num(3), a.Num(4), a.Num(5), a.Num(6)});
}

void LoadFaceCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  size_t n = 0;
  const uint8_t* data = a.Bytes(0, &n);
  if (!data) return a.Return(S(a.isolate, "font data must be an ArrayBuffer or Uint8Array"));
  std::string err;
  auto f = Face::Load(FontBytes::Copy(data, n), a.Int(1), &err);
  if (!f) return a.Return(S(a.isolate, err));
  a.Return(a.WrapHandle(new FaceHandle(f)));
}

void LoadFaceFileCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto f = FontRegistry::Get().OpenFile(a.Str8(0), a.Int(1));
  if (!f) return a.Return(v8::Null(a.isolate));
  a.Return(a.WrapHandle(new FaceHandle(f)));
}

void Set(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* k, v8::Local<v8::Value> v) {
  // CreateDataProperty, not [[Set]]: setters an app installed on Object.prototype must not run, and a failure (an
  // exception already pending) must not abort the process.
  (void)o->CreateDataProperty(ctx, S(isolate, k), v).FromMaybe(false);
}

void FaceInfoCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* f = static_cast<FaceHandle*>(a.Obj(0, HandleKind::kFace));
  if (!f) return a.Throw("canvas2d.faceInfo: bad face");
  const Face& face = *f->face;
  v8::Isolate* is = a.isolate;
  v8::Local<v8::Object> o = v8::Object::New(is);
  Set(is, a.ctx, o, "family", S(is, face.family()));
  Set(is, a.ctx, o, "style", S(is, face.style_name()));
  Set(is, a.ctx, o, "weight", v8::Number::New(is, face.weight()));
  Set(is, a.ctx, o, "italic", v8::Boolean::New(is, face.italic()));
  Set(is, a.ctx, o, "stretch", v8::Number::New(is, face.stretch()));
  Set(is, a.ctx, o, "color", v8::Boolean::New(is, face.is_color()));
  Set(is, a.ctx, o, "weightMin", v8::Number::New(is, face.has_weight_axis() ? face.weight_min() : face.weight()));
  Set(is, a.ctx, o, "weightMax", v8::Number::New(is, face.has_weight_axis() ? face.weight_max() : face.weight()));
  Set(is, a.ctx, o, "numFaces", v8::Number::New(is, face.num_faces()));
  a.Return(o);
}

void DefaultFacesCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto faces = FontRegistry::Get().DefaultFaces();
  v8::Local<v8::Array> arr = v8::Array::New(a.isolate, static_cast<int>(faces.size()));
  for (size_t i = 0; i < faces.size(); i++) {
    v8::Local<v8::Value> pair[] = {S(a.isolate, faces[i].family), a.WrapHandle(new FaceHandle(faces[i].face))};
    (void)arr->CreateDataProperty(a.ctx, static_cast<uint32_t>(i), v8::Array::New(a.isolate, pair, 2)).FromMaybe(false);
  }
  a.Return(arr);
}

void SystemFamiliesCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  v8::Isolate* is = a.isolate;
  auto fams = FontRegistry::Get().SystemFamilies();
  v8::Local<v8::Array> arr = v8::Array::New(is, static_cast<int>(fams.size()));
  for (size_t i = 0; i < fams.size(); i++) {
    v8::Local<v8::Object> o = v8::Object::New(is);
    Set(is, a.ctx, o, "name", S(is, fams[i].name));
    v8::Local<v8::Array> fonts = v8::Array::New(is, static_cast<int>(fams[i].fonts.size()));
    for (size_t k = 0; k < fams[i].fonts.size(); k++) {
      v8::Local<v8::Object> fo = v8::Object::New(is);
      Set(is, a.ctx, fo, "path", S(is, fams[i].fonts[k].second));
      Set(is, a.ctx, fo, "weight", v8::Number::New(is, fams[i].fonts[k].first.weight));
      Set(is, a.ctx, fo, "italic", v8::Boolean::New(is, fams[i].fonts[k].first.italic));
      Set(is, a.ctx, fo, "index", v8::Number::New(is, fams[i].fonts[k].first.index));
      (void)fonts->CreateDataProperty(a.ctx, static_cast<uint32_t>(k), fo).FromMaybe(false);
    }
    Set(is, a.ctx, o, "fonts", fonts);
    (void)arr->CreateDataProperty(a.ctx, static_cast<uint32_t>(i), o).FromMaybe(false);
  }
  a.Return(arr);
}

void CreateFontCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  std::vector<FaceHandle*> faces;
  std::vector<int> synth;
  if (a.At(0)->IsArray()) {
    v8::Local<v8::Array> arr = a.At(0).As<v8::Array>();
    for (uint32_t i = 0; i < arr->Length(); i++) {
      v8::Local<v8::Value> v;
      Wrapper* w = arr->Get(a.ctx, i).ToLocal(&v) ? Unwrap(v) : nullptr;
      faces.push_back(w && w->handle->kind == HandleKind::kFace ? static_cast<FaceHandle*>(w->handle) : nullptr);
    }
  }
  if (a.At(1)->IsArray()) {
    v8::Local<v8::Array> arr = a.At(1).As<v8::Array>();
    for (uint32_t i = 0; i < arr->Length(); i++) {
      v8::Local<v8::Value> v;
      int32_t x = 0;
      if (arr->Get(a.ctx, i).ToLocal(&v)) x = v->Int32Value(a.ctx).FromMaybe(0);
      synth.push_back(x);
    }
  }
  auto f = CreateFont(faces, synth, a.Num(2, 10), a.Int(3, 400), a.Bool(4), a.Bool(5), a.Bool(6),
                      a.Num(7), a.Num(8), a.Str8(9));
  a.Return(a.WrapHandle(f.release()));
}

void MeasureTextCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  auto* f = static_cast<FontHandle*>(a.Obj(0, HandleKind::kFont));
  size_t n = 0;
  double* out = a.info[5]->IsFloat64Array() ? a.Typed<double>(5, &n) : nullptr;
  if (!f || !out || n < 12) return a.Throw("canvas2d.measureText: bad args");
  std::u16string text = a.Str16(1);
  MeasureText(f, text, a.Int(2), a.Int(3), a.Int(4), out);
}

void DrawTextCommon(const v8::FunctionCallbackInfo<v8::Value>& info, bool stroke) {
  Args a(info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  const double* st = a.State(1);
  auto* f = static_cast<FontHandle*>(a.Obj(2, HandleKind::kFont));
  if (!s || !st || !f) return a.Throw("canvas2d.fillText: bad args");
  std::u16string text = a.Str16(3);
  double max_width = a.At(6)->IsNumber() ? a.Num(6) : NAN;
  DrawText(s, st, f, text, a.Num(4), a.Num(5), max_width, a.Paint(7), static_cast<ClipHandle*>(a.Obj(8, HandleKind::kClip)),
           stroke, stroke ? a.FloatsAll(9) : Span{});
}
void FillTextCb(const v8::FunctionCallbackInfo<v8::Value>& info) { DrawTextCommon(info, false); }
void StrokeTextCb(const v8::FunctionCallbackInfo<v8::Value>& info) { DrawTextCommon(info, true); }

void ConfigureSystemFontsCb(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Args a(info);
  FontRegistry::Get().ConfigureSystemFonts(a.Str8(0), a.Str8(1));
}

#if defined(IWN_C2D_WITH_IMAGE)
// ImageBitmap / HTMLImageElement handles from runtime/image (INTEROP.md §4): draw straight from the PixelStore.
struct LockedStore {
  std::shared_ptr<const iwn::image::PixelStore> store;
  iwn::image::ScopedPixels pixels;
};
bool ResolveImageHandle(void* object, ImageView* view, std::shared_ptr<void>* keepalive) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::Local<v8::Value> value = *static_cast<v8::Local<v8::Value>*>(object);
  auto store = iwn::image::GetPixelStore(isolate, value);
  if (!store) return false;
  auto locked = std::make_shared<LockedStore>();
  locked->store = store;
  locked->pixels = store->Read();
  if (!locked->pixels.ok()) return false;
  const iwn::image::PixelView& pv = locked->pixels.view();
  view->data = pv.data;
  view->width = static_cast<int>(pv.width);
  view->height = static_cast<int>(pv.height);
  view->stride = pv.stride;
  view->premultiplied = pv.opaque || pv.alpha == iwn::image::AlphaMode::kPremultiplied;
  *keepalive = locked;
  return true;
}
#endif

// Exceptions never cross into V8: an allocation failure (huge canvas, extreme parameters) becomes a JS RangeError,
// anything else a JS Error, instead of terminating the process.
template <v8::FunctionCallback F>
void Guarded(const v8::FunctionCallbackInfo<v8::Value>& info) {
  const char* msg = nullptr;
  bool oom = false;
  try {
    F(info);
    return;
  } catch (const std::bad_alloc&) {
    oom = true;
  } catch (const std::exception& e) {
    msg = e.what();
  } catch (...) {
    msg = "canvas2d: internal error";
  }
  v8::Isolate* isolate = info.GetIsolate();
  if (oom) {
    isolate->ThrowException(v8::Exception::RangeError(
        v8::String::NewFromUtf8Literal(isolate, "canvas2d: out of memory (the operation needs more memory than is available)")));
  } else {
    v8::Local<v8::String> m;
    if (!v8::String::NewFromUtf8(isolate, msg ? msg : "canvas2d: internal error").ToLocal(&m)) {
      m = v8::String::NewFromUtf8Literal(isolate, "canvas2d: internal error");
    }
    isolate->ThrowException(v8::Exception::Error(m));
  }
}

}  // namespace

void iwn_register_canvas2d(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  v8::HandleScope scope(isolate);
#if defined(IWN_C2D_WITH_IMAGE)
  static std::once_flag resolver_once;
  std::call_once(resolver_once, [] { SetExternalImageResolver(ResolveImageHandle); });
#endif
  struct Entry {
    const char* name;
    v8::FunctionCallback fn;
  };
#define IWN_C2D_ENTRY(name, cb) {name, Guarded<cb>}
  static const Entry kEntries[] = {
      IWN_C2D_ENTRY("createSurface", CreateSurfaceCb),
      IWN_C2D_ENTRY("resize", ResizeCb),
      IWN_C2D_ENTRY("fill", FillCb),
      IWN_C2D_ENTRY("stroke", StrokeCb),
      IWN_C2D_ENTRY("clearRect", ClearRectCb),
      IWN_C2D_ENTRY("clip", ClipCb),
      IWN_C2D_ENTRY("isPointInPath", IsPointInPathCb),
      IWN_C2D_ENTRY("isPointInStroke", IsPointInStrokeCb),
      IWN_C2D_ENTRY("drawSurface", DrawSurfaceCb),
      IWN_C2D_ENTRY("drawPixels", DrawPixelsCb),
      IWN_C2D_ENTRY("drawExternal", DrawExternalCb),
      IWN_C2D_ENTRY("getImageData", GetImageDataCb),
      IWN_C2D_ENTRY("putImageData", PutImageDataCb),
      IWN_C2D_ENTRY("readPixels", ReadPixelsCb),
      IWN_C2D_ENTRY("encode", EncodeCb),
      IWN_C2D_ENTRY("createGradient", CreateGradientCb),
      IWN_C2D_ENTRY("addColorStop", AddColorStopCb),
      IWN_C2D_ENTRY("createPatternFromSurface", CreatePatternFromSurfaceCb),
      IWN_C2D_ENTRY("createPatternFromPixels", CreatePatternFromPixelsCb),
      IWN_C2D_ENTRY("createPatternFromExternal", CreatePatternFromExternalCb),
      IWN_C2D_ENTRY("setPatternTransform", SetPatternTransformCb),
      IWN_C2D_ENTRY("loadFace", LoadFaceCb),
      IWN_C2D_ENTRY("loadFaceFile", LoadFaceFileCb),
      IWN_C2D_ENTRY("faceInfo", FaceInfoCb),
      IWN_C2D_ENTRY("defaultFaces", DefaultFacesCb),
      IWN_C2D_ENTRY("systemFamilies", SystemFamiliesCb),
      IWN_C2D_ENTRY("createFont", CreateFontCb),
      IWN_C2D_ENTRY("measureText", MeasureTextCb),
      IWN_C2D_ENTRY("fillText", FillTextCb),
      IWN_C2D_ENTRY("strokeText", StrokeTextCb),
      IWN_C2D_ENTRY("configureSystemFonts", ConfigureSystemFontsCb),
  };
#undef IWN_C2D_ENTRY
  // Handles are instances of this per-context constructor (two internal fields: marker, Wrapper*). It is every
  // callback's data, so no per-isolate template has to be kept (or cleaned up) anywhere.
  v8::Local<v8::FunctionTemplate> handle_tmpl = v8::FunctionTemplate::New(isolate);
  handle_tmpl->SetClassName(v8::String::NewFromUtf8Literal(isolate, "Canvas2DHandle"));
  handle_tmpl->InstanceTemplate()->SetInternalFieldCount(2);
  v8::Local<v8::Function> handle_ctor = handle_tmpl->GetFunction(ctx).ToLocalChecked();
#if defined(IWN_HAVE_CORE_RUNTIME)
  // Inside the runtime (main isolate): bundled fonts come from the APK assets under iwn/fonts/ (C2D-9; the packer
  // copies runtime/canvas2d/fonts/*.ttf there, see apk-assets.json), and canvas2d handles still alive when the page
  // shuts down are freed by a teardown hook (V8 runs no weak callbacks at isolate disposal).
  if (iwn::Runtime* rt = iwn::Runtime::From(isolate)) {
    static std::mutex hooks_mutex;
    static std::unordered_set<v8::Isolate*> hooked;
    bool first = false;
    {
      std::lock_guard<std::mutex> l(hooks_mutex);
      first = hooked.insert(isolate).second;
    }
    if (first) {
      iwn::AssetSource* assets = &rt->assets();
      FontRegistry::Get().SetAssetReader([assets](const std::string& name) -> std::shared_ptr<FontBytes> {
        std::shared_ptr<iwn::AssetBytes> b = assets->read("iwn/" + name);
        if (!b || b->size() == 0) return nullptr;
        const uint8_t* data = b->data();
        size_t size = b->size();
        return FontBytes::Borrow(std::move(b), data, size);
      });
      rt->add_shutdown_hook([isolate] {
        FontRegistry::Get().SetAssetReader(nullptr);
        iwn::canvas2d::DisposeIsolate(isolate);
        std::lock_guard<std::mutex> l(hooks_mutex);
        hooked.erase(isolate);
      });
    }
  }
#endif
  v8::Local<v8::Object> mod = v8::Object::New(isolate);
  for (const Entry& e : kEntries) {
    v8::Local<v8::Function> fn = v8::FunctionTemplate::New(isolate, e.fn, handle_ctor)->GetFunction(ctx).ToLocalChecked();
    mod->Set(ctx, S(isolate, e.name), fn).Check();
  }
  natives->Set(ctx, S(isolate, "canvas2d"), mod).Check();
}

namespace iwn::canvas2d {

Surface* SurfaceFromValue(v8::Isolate* isolate, v8::Local<v8::Value> value) {
  Wrapper* w = Unwrap(value);
  if (!w || w->handle->kind != HandleKind::kSurface) return nullptr;
  return &static_cast<SurfaceHandle*>(w->handle)->surface;
}

void DisposeIsolate(v8::Isolate* isolate) {
  std::unordered_set<Wrapper*> live;
  {
    std::lock_guard<std::mutex> l(g_live_mutex);
    auto it = Live().find(isolate);
    if (it == Live().end()) return;
    live.swap(it->second);
    Live().erase(it);
  }
  for (Wrapper* w : live) FreeWrapper(w);
}

}  // namespace iwn::canvas2d
