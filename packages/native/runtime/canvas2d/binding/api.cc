#include "api.h"

#include <algorithm>
#include <atomic>
#include <cmath>

namespace iwn::canvas2d::api {

namespace {
inline double Clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
std::atomic<ExternalImageResolver> g_resolver{nullptr};
}  // namespace

DrawParams DecodeDraw(const double* st, const ClipHandle* clip) {
  DrawParams p;
  p.ctm = Matrix{st[kCtmA], st[kCtmB], st[kCtmC], st[kCtmD], st[kCtmE], st[kCtmF]};
  p.global_alpha = static_cast<float>(Clamp01(st[kGlobalAlpha]));
  int op = ToInt(st[kCompositeOp]);
  p.op = (op >= 0 && op < static_cast<int>(CompositeOp::kClear)) ? static_cast<CompositeOp>(op) : CompositeOp::kSourceOver;
  p.smoothing = st[kSmoothing] != 0;
  p.smoothing_quality = static_cast<uint8_t>(std::clamp(ToInt(st[kSmoothingQuality]), 0, 2));
  double a = Clamp01(st[kShadowA]);
  p.shadow.color = Color{static_cast<float>(Clamp01(st[kShadowR]) * a), static_cast<float>(Clamp01(st[kShadowG]) * a),
                         static_cast<float>(Clamp01(st[kShadowB]) * a), static_cast<float>(a)};
  p.shadow.blur = std::isfinite(st[kShadowBlur]) && st[kShadowBlur] > 0 ? st[kShadowBlur] : 0;
  p.shadow.offset_x = std::isfinite(st[kShadowOffsetX]) ? st[kShadowOffsetX] : 0;
  p.shadow.offset_y = std::isfinite(st[kShadowOffsetY]) ? st[kShadowOffsetY] : 0;
  p.clip = clip ? clip->mask.get() : nullptr;
  return p;
}

StrokeStyle DecodeStroke(const double* st, const float* dash, size_t dash_len) {
  StrokeStyle s;
  s.width = st[kLineWidth];
  int cap = ToInt(st[kLineCap]);
  s.cap = cap == 1 ? LineCap::kRound : cap == 2 ? LineCap::kSquare : LineCap::kButt;
  int join = ToInt(st[kLineJoin]);
  s.join = join == 1 ? LineJoin::kRound : join == 2 ? LineJoin::kBevel : LineJoin::kMiter;
  s.miter_limit = st[kMiterLimit];
  s.dash_offset = std::isfinite(st[kDashOffset]) ? st[kDashOffset] : 0;
  if (dash && dash_len) {
    s.dash.assign(dash, dash + dash_len);
    if (s.dash.size() % 2) s.dash.insert(s.dash.end(), dash, dash + dash_len);
  }
  return s;
}

Paint DecodePaint(const double* st, const Handle* paint) {
  Paint p;
  int kind = ToInt(st[kPaintKind]);
  if (kind == 1 && paint && paint->kind == HandleKind::kGradient) {
    p.kind = Paint::Kind::kGradient;
    p.gradient = &static_cast<const GradientHandle*>(paint)->gradient;
    return p;
  }
  if (kind == 2 && paint && paint->kind == HandleKind::kPattern) {
    p.kind = Paint::Kind::kPattern;
    p.pattern = &static_cast<const PatternHandle*>(paint)->pattern;
    return p;
  }
  p.kind = Paint::Kind::kSolid;
  p.color = Color::FromUnpremultiplied(static_cast<float>(Clamp01(st[kColorR])), static_cast<float>(Clamp01(st[kColorG])),
                                       static_cast<float>(Clamp01(st[kColorB])), static_cast<float>(Clamp01(st[kColorA])));
  return p;
}

void Fill(SurfaceHandle* s, const double* st, Span cmds, const Handle* paint, const ClipHandle* clip) {
  DrawParams p = DecodeDraw(st, clip);
  Paint pt = DecodePaint(st, paint);
  FillRule rule = st[kFillRule] == 1 ? FillRule::kEvenOdd : FillRule::kNonZero;
  s->canvas.Fill(PathView{cmds.data, cmds.length}, st[kPathSpace] == 1, rule, pt, p);
}

void Stroke(SurfaceHandle* s, const double* st, Span cmds, const Handle* paint, const ClipHandle* clip, Span dash) {
  DrawParams p = DecodeDraw(st, clip);
  Paint pt = DecodePaint(st, paint);
  StrokeStyle style = DecodeStroke(st, dash.data, dash.length);
  s->canvas.Stroke(PathView{cmds.data, cmds.length}, st[kPathSpace] == 1, style, pt, p);
}

void ClearRect(SurfaceHandle* s, const double* st, double x, double y, double w, double h, const ClipHandle* clip) {
  DrawParams p = DecodeDraw(st, clip);
  s->canvas.ClearRect(x, y, w, h, p);
}

std::unique_ptr<ClipHandle> Clip(SurfaceHandle* s, const double* st, Span cmds, const ClipHandle* parent) {
  auto h = std::make_unique<ClipHandle>();
  Matrix ctm{st[kCtmA], st[kCtmB], st[kCtmC], st[kCtmD], st[kCtmE], st[kCtmF]};
  FillRule rule = st[kFillRule] == 1 ? FillRule::kEvenOdd : FillRule::kNonZero;
  h->mask = s->canvas.MakeClip(PathView{cmds.data, cmds.length}, st[kPathSpace] == 1, rule, ctm,
                               parent ? parent->mask.get() : nullptr);
  return h;
}

bool IsPointInPath(SurfaceHandle* s, const double* st, Span cmds, double x, double y) {
  Matrix ctm{st[kCtmA], st[kCtmB], st[kCtmC], st[kCtmD], st[kCtmE], st[kCtmF]};
  FillRule rule = st[kFillRule] == 1 ? FillRule::kEvenOdd : FillRule::kNonZero;
  return s->canvas.IsPointInPath(PathView{cmds.data, cmds.length}, st[kPathSpace] == 1, ctm, x, y, rule);
}

bool IsPointInStroke(SurfaceHandle* s, const double* st, Span cmds, double x, double y, Span dash) {
  Matrix ctm{st[kCtmA], st[kCtmB], st[kCtmC], st[kCtmD], st[kCtmE], st[kCtmF]};
  StrokeStyle style = DecodeStroke(st, dash.data, dash.length);
  return s->canvas.IsPointInStroke(PathView{cmds.data, cmds.length}, st[kPathSpace] == 1, ctm, style, x, y);
}

void DrawImage(SurfaceHandle* s, const double* st, const ImageView& src, const double* r, const ClipHandle* clip) {
  DrawParams p = DecodeDraw(st, clip);
  s->canvas.DrawImage(src, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], p);
}

std::unique_ptr<PatternHandle> CreatePattern(const ImageView& src, bool repeat_x, bool repeat_y) {
  auto img = OwnedImage::CopyFrom(src);
  return std::make_unique<PatternHandle>(img, repeat_x, repeat_y);
}

std::unique_ptr<FontHandle> CreateFont(const std::vector<FaceHandle*>& faces, const std::vector<int>& synth,
                                       double size, int weight, bool italic, bool small_caps, bool kerning,
                                       double letter_spacing, double word_spacing, const std::string& lang) {
  FontDesc d;
  for (size_t i = 0; i < faces.size(); i++) {
    if (!faces[i] || !faces[i]->face) continue;
    FaceRef r;
    r.face = faces[i]->face;
    int s = i < synth.size() ? synth[i] : 0;
    r.synthetic_bold = (s & 1) != 0;
    r.synthetic_italic = (s & 2) != 0;
    // Bits 8-17 / 18-27: the face's CSS weight descriptor range (0 = none), see web/canvas2d/src/fonts.ts.
    r.weight_min = (s >> 8) & 0x3FF;
    r.weight_max = (s >> 18) & 0x3FF;
    d.faces.push_back(r);
  }
  d.size = size;
  d.weight = weight;
  d.italic = italic;
  d.small_caps = small_caps;
  d.kerning = kerning;
  d.letter_spacing = std::isfinite(letter_spacing) ? letter_spacing : 0;
  d.word_spacing = std::isfinite(word_spacing) ? word_spacing : 0;
  d.language = lang;
  return std::make_unique<FontHandle>(std::make_shared<Font>(std::move(d)));
}

void MeasureText(FontHandle* f, std::u16string_view text, int align, int baseline, int direction, double* out) {
  TextMetricsResult m;
  f->font->Measure(text, static_cast<TextAlign>(std::clamp(align, 0, 4)),
                   static_cast<TextBaseline>(std::clamp(baseline, 0, 5)),
                   direction == 1 ? TextDirection::kRtl : TextDirection::kLtr, &m);
  double v[12] = {m.width,       m.actual_left, m.actual_right, m.actual_ascent, m.actual_descent, m.font_ascent,
                  m.font_descent, m.em_ascent,  m.em_descent,   m.hanging,       m.alphabetic,     m.ideographic};
  for (int i = 0; i < 12; i++) out[i] = v[i];
}

void DrawText(SurfaceHandle* s, const double* st, FontHandle* f, std::u16string_view text, double x, double y,
              double max_width, const Handle* paint, const ClipHandle* clip, bool stroke, Span dash) {
  DrawParams p = DecodeDraw(st, clip);
  Paint pt = DecodePaint(st, paint);
  StrokeStyle style;
  if (stroke) style = DecodeStroke(st, dash.data, dash.length);
  int align = std::clamp(ToInt(st[kTextAlign]), 0, 4);
  int baseline = std::clamp(ToInt(st[kTextBaseline]), 0, 5);
  f->font->Draw(&s->canvas, text, x, y, max_width, static_cast<TextAlign>(align), static_cast<TextBaseline>(baseline),
                st[kDirection] == 1 ? TextDirection::kRtl : TextDirection::kLtr, stroke ? &style : nullptr, pt, p);
}

void SetAssetRoot(const std::string& dir) {
  if (dir.empty()) {
    FontRegistry::Get().SetAssetReader(nullptr);
    return;
  }
  FontRegistry::Get().SetAssetReader([dir](const std::string& name) { return FontBytes::MapFile(dir + "/" + name); });
}

void SetExternalImageResolver(ExternalImageResolver resolver) { g_resolver.store(resolver, std::memory_order_release); }
ExternalImageResolver GetExternalImageResolver() { return g_resolver.load(std::memory_order_acquire); }

}  // namespace iwn::canvas2d::api
