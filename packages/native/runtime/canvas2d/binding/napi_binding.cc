// Node-API addon exposing the same JS-facing canvas2d API as the V8 binding, so web/canvas2d runs its golden tests
// headlessly in Node against the real raster core. Host-only (not shipped).

#include <cstring>
#include <node_api.h>

#include <cmath>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

#include "api.h"

using namespace iwn::canvas2d;
using namespace iwn::canvas2d::api;

namespace {

struct Args {
  napi_env env;
  size_t argc = 16;
  napi_value argv[16];
  napi_value self;
  Args(napi_env e, napi_callback_info info) : env(e) { napi_get_cb_info(e, info, &argc, argv, &self, nullptr); }
  napi_value At(size_t i) const {
    if (i < argc) return argv[i];
    napi_value u;
    napi_get_undefined(env, &u);
    return u;
  }
  double Num(size_t i, double def = 0) const {
    double v;
    if (napi_get_value_double(env, At(i), &v) != napi_ok) return def;
    return v;
  }
  int Int(size_t i, int def = 0) const { return ToInt(Num(i, def), def); }
  bool Bool(size_t i) const {
    bool v = false;
    napi_valuetype t;
    napi_typeof(env, At(i), &t);
    if (t == napi_boolean) {
      napi_get_value_bool(env, At(i), &v);
      return v;
    }
    return Num(i) != 0;
  }
  Handle* Obj(size_t i, HandleKind kind) const {
    napi_valuetype t;
    if (napi_typeof(env, At(i), &t) != napi_ok || t != napi_object) return nullptr;
    void* p = nullptr;
    if (napi_unwrap(env, At(i), &p) != napi_ok || !p) return nullptr;
    Handle* h = static_cast<Handle*>(p);
    return h->kind == kind ? h : nullptr;
  }
  Handle* Paint(size_t i) const {
    napi_valuetype t;
    if (napi_typeof(env, At(i), &t) != napi_ok || t != napi_object) return nullptr;
    void* p = nullptr;
    if (napi_unwrap(env, At(i), &p) != napi_ok || !p) return nullptr;
    Handle* h = static_cast<Handle*>(p);
    return (h->kind == HandleKind::kGradient || h->kind == HandleKind::kPattern) ? h : nullptr;
  }
  template <class T>
  T* Typed(size_t i, napi_typedarray_type want, size_t* len) const {
    bool is = false;
    if (napi_is_typedarray(env, At(i), &is) != napi_ok || !is) return nullptr;
    napi_typedarray_type type;
    size_t length;
    void* data;
    napi_value ab;
    size_t off;
    napi_get_typedarray_info(env, At(i), &type, &length, &data, &ab, &off);
    if (type != want && !(want == napi_uint8_array && type == napi_uint8_clamped_array)) return nullptr;
    *len = length;
    return static_cast<T*>(data);
  }
  const double* State(size_t i) const {
    size_t n = 0;
    const double* s = Typed<double>(i, napi_float64_array, &n);
    return (s && n >= kStateSize) ? s : nullptr;
  }
  Span Floats(size_t i, size_t len_arg) const {
    size_t n = 0;
    const float* f = Typed<float>(i, napi_float32_array, &n);
    if (!f) return {};
    double l = Num(len_arg, double(n));
    size_t use = (l >= 0 && l <= n) ? static_cast<size_t>(l) : n;
    return {f, use};
  }
  Span FloatsAll(size_t i) const {
    size_t n = 0;
    const float* f = Typed<float>(i, napi_float32_array, &n);
    return f ? Span{f, n} : Span{};
  }
  std::u16string Str16(size_t i) const {
    size_t len = 0;
    if (napi_get_value_string_utf16(env, At(i), nullptr, 0, &len) != napi_ok) return {};
    std::u16string s(len, u'\0');
    napi_get_value_string_utf16(env, At(i), reinterpret_cast<char16_t*>(s.data()), len + 1, &len);
    return s;
  }
  std::string Str8(size_t i) const {
    size_t len = 0;
    if (napi_get_value_string_utf8(env, At(i), nullptr, 0, &len) != napi_ok) return {};
    std::string s(len, '\0');
    napi_get_value_string_utf8(env, At(i), s.data(), len + 1, &len);
    return s;
  }
};

napi_value Undef(napi_env env) {
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}
napi_value Null(napi_env env) {
  napi_value u;
  napi_get_null(env, &u);
  return u;
}
napi_value Bool(napi_env env, bool b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  return v;
}
napi_value Num(napi_env env, double d) {
  napi_value v;
  napi_create_double(env, d, &v);
  return v;
}
napi_value Str(napi_env env, const std::string& s) {
  napi_value v;
  napi_create_string_utf8(env, s.data(), s.size(), &v);
  return v;
}

void Finalize(napi_env env, void* data, void*) {
  Handle* h = static_cast<Handle*>(data);
  int64_t ignored;
  napi_adjust_external_memory(env, -static_cast<int64_t>(h->ExternalBytes()), &ignored);
  delete h;
}

napi_value Wrap(napi_env env, Handle* h) {
  napi_value obj;
  napi_create_object(env, &obj);
  napi_wrap(env, obj, h, Finalize, nullptr, nullptr);
  int64_t ignored;
  napi_adjust_external_memory(env, static_cast<int64_t>(h->ExternalBytes()), &ignored);
  return obj;
}

napi_value Throw(napi_env env, const char* msg) {
  napi_throw_type_error(env, nullptr, msg);
  return nullptr;
}

#define FN(name) napi_value name(napi_env env, napi_callback_info info)

FN(CreateSurface) {
  Args a(env, info);
  auto* h = new SurfaceHandle();
  h->surface.Resize(a.Int(0), a.Int(1));
  return Wrap(env, h);
}

FN(Resize) {
  Args a(env, info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  if (!s) return Throw(env, "canvas2d.resize: not a surface");
  int64_t before = static_cast<int64_t>(s->ExternalBytes());
  bool ok = s->surface.Resize(a.Int(1), a.Int(2));
  int64_t ignored;
  napi_adjust_external_memory(env, static_cast<int64_t>(s->ExternalBytes()) - before, &ignored);
  return Bool(env, ok);
}

#define SURFACE_AND_STATE(fname)                                                 \
  Args a(env, info);                                                             \
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));         \
  const double* st = a.State(1);                                                 \
  if (!s || !st) return Throw(env, "canvas2d." fname ": bad surface or state");

FN(Fill) {
  SURFACE_AND_STATE("fill");
  Fill(s, st, a.Floats(2, 3), a.Paint(4), static_cast<ClipHandle*>(a.Obj(5, HandleKind::kClip)));
  return Undef(env);
}

FN(Stroke) {
  SURFACE_AND_STATE("stroke");
  Stroke(s, st, a.Floats(2, 3), a.Paint(4), static_cast<ClipHandle*>(a.Obj(5, HandleKind::kClip)), a.FloatsAll(6));
  return Undef(env);
}

FN(ClearRectFn) {
  SURFACE_AND_STATE("clearRect");
  ClearRect(s, st, a.Num(2), a.Num(3), a.Num(4), a.Num(5), static_cast<ClipHandle*>(a.Obj(6, HandleKind::kClip)));
  return Undef(env);
}

FN(ClipFn) {
  SURFACE_AND_STATE("clip");
  auto h = Clip(s, st, a.Floats(2, 3), static_cast<ClipHandle*>(a.Obj(4, HandleKind::kClip)));
  if (auto* reuse = static_cast<ClipHandle*>(a.Obj(5, HandleKind::kClip))) {
    int64_t before = static_cast<int64_t>(reuse->ExternalBytes());
    reuse->mask = std::move(h->mask);
    int64_t ignored;
    napi_adjust_external_memory(env, static_cast<int64_t>(reuse->ExternalBytes()) - before, &ignored);
    return a.At(5);
  }
  return Wrap(env, h.release());
}

FN(IsPointInPathFn) {
  SURFACE_AND_STATE("isPointInPath");
  return Bool(env, IsPointInPath(s, st, a.Floats(2, 3), a.Num(4), a.Num(5)));
}

FN(IsPointInStrokeFn) {
  SURFACE_AND_STATE("isPointInStroke");
  return Bool(env, IsPointInStroke(s, st, a.Floats(2, 3), a.Num(4), a.Num(5), a.FloatsAll(6)));
}

FN(DrawSurface) {
  SURFACE_AND_STATE("drawSurface");
  auto* src = static_cast<SurfaceHandle*>(a.Obj(2, HandleKind::kSurface));
  if (!src) return Throw(env, "canvas2d.drawSurface: bad source");
  double r[8];
  for (int i = 0; i < 8; i++) r[i] = a.Num(3 + i);
  DrawImage(s, st, src->surface.View(), r, static_cast<ClipHandle*>(a.Obj(11, HandleKind::kClip)));
  return Undef(env);
}

FN(DrawPixels) {
  SURFACE_AND_STATE("drawPixels");
  size_t n = 0;
  const uint8_t* px = a.Typed<uint8_t>(2, napi_uint8_array, &n);
  int w = a.Int(3), h = a.Int(4);
  if (!px || !PixelBytesFit(n, w, h)) return Throw(env, "canvas2d.drawPixels: bad pixels");
  ImageView v{px, w, h, size_t(w) * 4, a.Bool(5)};
  double r[8];
  for (int i = 0; i < 8; i++) r[i] = a.Num(6 + i);
  DrawImage(s, st, v, r, static_cast<ClipHandle*>(a.Obj(14, HandleKind::kClip)));
  return Undef(env);
}

FN(GetImageDataFn) {
  Args a(env, info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  size_t n = 0;
  uint8_t* out = a.Typed<uint8_t>(5, napi_uint8_array, &n);
  int w = a.Int(3), h = a.Int(4);
  if (!s || !out || !PixelBytesFit(n, w, h)) return Throw(env, "canvas2d.getImageData: bad args");
  s->canvas.GetImageData(a.Int(1), a.Int(2), w, h, out);
  return Undef(env);
}

FN(PutImageDataFn) {
  Args a(env, info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  size_t n = 0;
  const uint8_t* data = a.Typed<uint8_t>(1, napi_uint8_array, &n);
  int dw = a.Int(2), dh = a.Int(3);
  if (!s || !data || !PixelBytesFit(n, dw, dh)) return Throw(env, "canvas2d.putImageData: bad args");
  s->canvas.PutImageData(data, dw, dh, a.Int(4), a.Int(5), a.Int(6),
                         a.Int(7), a.Int(8), a.Int(9));
  return Undef(env);
}

FN(ReadPixelsFn) {
  Args a(env, info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  size_t n = 0;
  uint8_t* out = a.Typed<uint8_t>(1, napi_uint8_array, &n);
  if (!s || !out || n < s->surface.byte_size()) return Throw(env, "canvas2d.readPixels: bad args");
  // An unallocated (oversize) bitmap reads as transparent black, not as what the shared buffer held before.
  if (s->surface.byte_size() < n) std::memset(out + s->surface.byte_size(), 0, n - s->surface.byte_size());
  ReadPixels(s->surface, out, a.Bool(2), a.Bool(3));
  return Undef(env);
}

FN(Encode) {
  Args a(env, info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  if (!s) return Throw(env, "canvas2d.encode: bad surface");
  std::vector<uint8_t> out;
  std::string used;
  if (!EncodeImage(s->surface, a.Str8(1), a.Num(2, -1), &out, &used)) return Null(env);
  void* data;
  napi_value ab;
  napi_create_arraybuffer(env, out.size(), &data, &ab);
  std::copy(out.begin(), out.end(), static_cast<uint8_t*>(data));
  napi_value arr;
  napi_create_array_with_length(env, 2, &arr);
  napi_set_element(env, arr, 0, ab);
  napi_set_element(env, arr, 1, Str(env, used));
  return arr;
}

FN(CreateGradient) {
  Args a(env, info);
  int kind = a.Int(0);
  double p[6];
  for (int i = 0; i < 6; i++) p[i] = a.Num(1 + i);
  auto* g = new GradientHandle(kind == 1 ? Gradient::Kind::kRadial : kind == 2 ? Gradient::Kind::kConic
                                                                               : Gradient::Kind::kLinear,
                               p);
  return Wrap(env, g);
}

FN(AddColorStop) {
  Args a(env, info);
  auto* g = static_cast<GradientHandle*>(a.Obj(0, HandleKind::kGradient));
  if (!g) return Throw(env, "canvas2d.addColorStop: bad gradient");
  g->gradient.AddStop(a.Num(1), static_cast<float>(a.Num(2)), static_cast<float>(a.Num(3)), static_cast<float>(a.Num(4)),
                      static_cast<float>(a.Num(5)));
  return Undef(env);
}

FN(CreatePatternFromSurface) {
  Args a(env, info);
  auto* src = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  if (!src) return Throw(env, "canvas2d.createPatternFromSurface: bad source");
  return Wrap(env, CreatePattern(src->surface.View(), a.Bool(1), a.Bool(2)).release());
}

FN(CreatePatternFromPixels) {
  Args a(env, info);
  size_t n = 0;
  const uint8_t* px = a.Typed<uint8_t>(0, napi_uint8_array, &n);
  int w = a.Int(1), h = a.Int(2);
  if (!px || !PixelBytesFit(n, w, h)) return Throw(env, "canvas2d.createPatternFromPixels: bad pixels");
  ImageView v{px, w, h, size_t(w) * 4, a.Bool(3)};
  return Wrap(env, CreatePattern(v, a.Bool(4), a.Bool(5)).release());
}

FN(SetPatternTransform) {
  Args a(env, info);
  auto* p = static_cast<PatternHandle*>(a.Obj(0, HandleKind::kPattern));
  if (!p) return Throw(env, "canvas2d.setPatternTransform: bad pattern");
  p->pattern.SetTransform(Matrix{a.Num(1), a.Num(2), a.Num(3), a.Num(4), a.Num(5), a.Num(6)});
  return Undef(env);
}

napi_value FaceValue(napi_env env, std::shared_ptr<Face> f) { return Wrap(env, new FaceHandle(std::move(f))); }

FN(LoadFace) {
  Args a(env, info);
  const uint8_t* data = nullptr;
  size_t len = 0;
  bool is_ab = false;
  napi_is_arraybuffer(env, a.At(0), &is_ab);
  if (is_ab) {
    void* d;
    napi_get_arraybuffer_info(env, a.At(0), &d, &len);
    data = static_cast<const uint8_t*>(d);
  } else {
    data = a.Typed<uint8_t>(0, napi_uint8_array, &len);
  }
  if (!data) return Str(env, "font data must be an ArrayBuffer or Uint8Array");
  std::string err;
  auto f = Face::Load(FontBytes::Copy(data, len), a.Int(1), &err);
  if (!f) return Str(env, err);
  return FaceValue(env, f);
}

FN(LoadFaceFile) {
  Args a(env, info);
  auto f = FontRegistry::Get().OpenFile(a.Str8(0), a.Int(1));
  return f ? FaceValue(env, f) : Null(env);
}

void SetProp(napi_env env, napi_value obj, const char* k, napi_value v) { napi_set_named_property(env, obj, k, v); }

FN(FaceInfo) {
  Args a(env, info);
  auto* f = static_cast<FaceHandle*>(a.Obj(0, HandleKind::kFace));
  if (!f) return Throw(env, "canvas2d.faceInfo: bad face");
  const Face& face = *f->face;
  napi_value o;
  napi_create_object(env, &o);
  SetProp(env, o, "family", Str(env, face.family()));
  SetProp(env, o, "style", Str(env, face.style_name()));
  SetProp(env, o, "weight", Num(env, face.weight()));
  SetProp(env, o, "italic", Bool(env, face.italic()));
  SetProp(env, o, "stretch", Num(env, face.stretch()));
  SetProp(env, o, "color", Bool(env, face.is_color()));
  SetProp(env, o, "weightMin", Num(env, face.has_weight_axis() ? face.weight_min() : face.weight()));
  SetProp(env, o, "weightMax", Num(env, face.has_weight_axis() ? face.weight_max() : face.weight()));
  SetProp(env, o, "numFaces", Num(env, face.num_faces()));
  return o;
}

FN(DefaultFaces) {
  auto faces = FontRegistry::Get().DefaultFaces();
  napi_value arr;
  napi_create_array_with_length(env, faces.size(), &arr);
  for (size_t i = 0; i < faces.size(); i++) {
    napi_value pair;
    napi_create_array_with_length(env, 2, &pair);
    napi_set_element(env, pair, 0, Str(env, faces[i].family));
    napi_set_element(env, pair, 1, FaceValue(env, faces[i].face));
    napi_set_element(env, arr, i, pair);
  }
  return arr;
}

FN(SystemFamilies) {
  auto fams = FontRegistry::Get().SystemFamilies();
  napi_value arr;
  napi_create_array_with_length(env, fams.size(), &arr);
  for (size_t i = 0; i < fams.size(); i++) {
    napi_value o, fonts;
    napi_create_object(env, &o);
    SetProp(env, o, "name", Str(env, fams[i].name));
    napi_create_array_with_length(env, fams[i].fonts.size(), &fonts);
    for (size_t k = 0; k < fams[i].fonts.size(); k++) {
      napi_value fo;
      napi_create_object(env, &fo);
      SetProp(env, fo, "path", Str(env, fams[i].fonts[k].second));
      SetProp(env, fo, "weight", Num(env, fams[i].fonts[k].first.weight));
      SetProp(env, fo, "italic", Bool(env, fams[i].fonts[k].first.italic));
      SetProp(env, fo, "index", Num(env, fams[i].fonts[k].first.index));
      napi_set_element(env, fonts, k, fo);
    }
    SetProp(env, o, "fonts", fonts);
    napi_set_element(env, arr, i, o);
  }
  return arr;
}

FN(CreateFontFn) {
  Args a(env, info);
  std::vector<FaceHandle*> faces;
  std::vector<int> synth;
  bool is_arr = false;
  napi_is_array(env, a.At(0), &is_arr);
  if (is_arr) {
    uint32_t n = 0;
    napi_get_array_length(env, a.At(0), &n);
    for (uint32_t i = 0; i < n; i++) {
      napi_value v;
      napi_get_element(env, a.At(0), i, &v);
      void* p = nullptr;
      if (napi_unwrap(env, v, &p) == napi_ok && p && static_cast<Handle*>(p)->kind == HandleKind::kFace)
        faces.push_back(static_cast<FaceHandle*>(p));
      else
        faces.push_back(nullptr);
    }
  }
  napi_is_array(env, a.At(1), &is_arr);
  if (is_arr) {
    uint32_t n = 0;
    napi_get_array_length(env, a.At(1), &n);
    for (uint32_t i = 0; i < n; i++) {
      napi_value v;
      napi_get_element(env, a.At(1), i, &v);
      int32_t x = 0;
      napi_get_value_int32(env, v, &x);
      synth.push_back(x);
    }
  }
  auto f = CreateFont(faces, synth, a.Num(2, 10), a.Int(3, 400), a.Bool(4), a.Bool(5), a.Bool(6),
                      a.Num(7), a.Num(8), a.Str8(9));
  return Wrap(env, f.release());
}

FN(MeasureTextFn) {
  Args a(env, info);
  auto* f = static_cast<FontHandle*>(a.Obj(0, HandleKind::kFont));
  size_t n = 0;
  double* out = a.Typed<double>(5, napi_float64_array, &n);
  if (!f || !out || n < 12) return Throw(env, "canvas2d.measureText: bad args");
  std::u16string text = a.Str16(1);
  MeasureText(f, text, a.Int(2), a.Int(3), a.Int(4), out);
  return Undef(env);
}

napi_value DrawTextCommon(napi_env env, napi_callback_info info, bool stroke) {
  Args a(env, info);
  auto* s = static_cast<SurfaceHandle*>(a.Obj(0, HandleKind::kSurface));
  const double* st = a.State(1);
  auto* f = static_cast<FontHandle*>(a.Obj(2, HandleKind::kFont));
  if (!s || !st || !f) return Throw(env, "canvas2d.fillText: bad args");
  std::u16string text = a.Str16(3);
  napi_valuetype t;
  napi_typeof(env, a.At(6), &t);
  double max_width = t == napi_number ? a.Num(6) : NAN;
  DrawText(s, st, f, text, a.Num(4), a.Num(5), max_width, a.Paint(7), static_cast<ClipHandle*>(a.Obj(8, HandleKind::kClip)),
           stroke, stroke ? a.FloatsAll(9) : Span{});
  return Undef(env);
}

FN(FillTextFn) { return DrawTextCommon(env, info, false); }
FN(StrokeTextFn) { return DrawTextCommon(env, info, true); }

FN(ConfigureSystemFonts) {
  Args a(env, info);
  FontRegistry::Get().ConfigureSystemFonts(a.Str8(0), a.Str8(1));
  return Undef(env);
}

FN(SetAssetRootFn) {
  Args a(env, info);
  SetAssetRoot(a.Str8(0));
  return Undef(env);
}

// Same exception policy as the V8 binding: allocation failures become RangeError, other C++ exceptions Error.
template <napi_callback F>
napi_value Guarded(napi_env env, napi_callback_info info) {
  try {
    return F(env, info);
  } catch (const std::bad_alloc&) {
    napi_throw_range_error(env, nullptr, "canvas2d: out of memory (the operation needs more memory than is available)");
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
  } catch (...) {
    napi_throw_error(env, nullptr, "canvas2d: internal error");
  }
  return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
  struct Entry {
    const char* name;
    napi_callback fn;
  };
  static const Entry kEntries[] = {
      {"createSurface", Guarded<CreateSurface>},
      {"resize", Guarded<Resize>},
      {"fill", Guarded<Fill>},
      {"stroke", Guarded<Stroke>},
      {"clearRect", Guarded<ClearRectFn>},
      {"clip", Guarded<ClipFn>},
      {"isPointInPath", Guarded<IsPointInPathFn>},
      {"isPointInStroke", Guarded<IsPointInStrokeFn>},
      {"drawSurface", Guarded<DrawSurface>},
      {"drawPixels", Guarded<DrawPixels>},
      {"getImageData", Guarded<GetImageDataFn>},
      {"putImageData", Guarded<PutImageDataFn>},
      {"readPixels", Guarded<ReadPixelsFn>},
      {"encode", Guarded<Encode>},
      {"createGradient", Guarded<CreateGradient>},
      {"addColorStop", Guarded<AddColorStop>},
      {"createPatternFromSurface", Guarded<CreatePatternFromSurface>},
      {"createPatternFromPixels", Guarded<CreatePatternFromPixels>},
      {"setPatternTransform", Guarded<SetPatternTransform>},
      {"loadFace", Guarded<LoadFace>},
      {"loadFaceFile", Guarded<LoadFaceFile>},
      {"faceInfo", Guarded<FaceInfo>},
      {"defaultFaces", Guarded<DefaultFaces>},
      {"systemFamilies", Guarded<SystemFamilies>},
      {"createFont", Guarded<CreateFontFn>},
      {"measureText", Guarded<MeasureTextFn>},
      {"fillText", Guarded<FillTextFn>},
      {"strokeText", Guarded<StrokeTextFn>},
      {"configureSystemFonts", Guarded<ConfigureSystemFonts>},
      {"setAssetRoot", Guarded<SetAssetRootFn>},
  };
  for (const Entry& e : kEntries) {
    napi_value fn;
    napi_create_function(env, e.name, NAPI_AUTO_LENGTH, e.fn, nullptr, &fn);
    napi_set_named_property(env, exports, e.name, fn);
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
