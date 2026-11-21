/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Text layout for canvas: code points -> per-character font choice (primary faces, then the system fallback chain,
// colour fonts first for emoji presentation) -> script runs -> HarfBuzz shaping -> glyph positions; TextMetrics
// (HTML "measureText") and drawing through the path rasterizer.

#include <algorithm>
#include <cmath>

#include <hb.h>

#include "bidi.h"
#include "iwn/canvas2d/text.h"

namespace iwn::canvas2d {

namespace {

constexpr double kSyntheticItalicSkew = 0.25;  // x += skew * y (font units, y up), about 14 degrees

// Synthetic bold growth (total, in 1/1024 em) for a font size in px: 1/24 em at 9 px and below, 1/32 em at 36 px and
// above, linear in between (the fake-bold scale browsers use; measured against Chrome: 1.5 % golden difference).
int SyntheticBold1024(double size_px) {
  double r = size_px <= 9 ? 1.0 / 24 : size_px >= 36 ? 1.0 / 32 : 1.0 / 24 + (size_px - 9) / 27 * (1.0 / 32 - 1.0 / 24);
  int v = static_cast<int>(std::lround(r * 1024));
  return v > 0 ? v : 1;
}

bool IsEmojiPresentation(uint32_t c) {
  if (c >= 0x1F1E6 && c <= 0x1F1FF) return true;  // regional indicators
  if (c >= 0x1F300 && c <= 0x1F64F) return true;
  if (c >= 0x1F680 && c <= 0x1F6FF) return true;
  if (c >= 0x1F900 && c <= 0x1F9FF) return true;
  if (c >= 0x1FA70 && c <= 0x1FAFF) return true;
  switch (c) {
    case 0x231A: case 0x231B: case 0x23E9: case 0x23EA: case 0x23EB: case 0x23EC: case 0x23F0: case 0x23F3:
    case 0x25FD: case 0x25FE: case 0x2614: case 0x2615: case 0x267F: case 0x2693: case 0x26A1: case 0x26AA:
    case 0x26AB: case 0x26BD: case 0x26BE: case 0x26C4: case 0x26C5: case 0x26CE: case 0x26D4: case 0x26EA:
    case 0x26F2: case 0x26F3: case 0x26F5: case 0x26FA: case 0x26FD: case 0x2705: case 0x270A: case 0x270B:
    case 0x2728: case 0x274C: case 0x274E: case 0x2753: case 0x2754: case 0x2755: case 0x2757: case 0x2795:
    case 0x2796: case 0x2797: case 0x27B0: case 0x27BF: case 0x2B1B: case 0x2B1C: case 0x2B50: case 0x2B55:
    case 0x1F004: case 0x1F0CF: case 0x1F18E: case 0x1F201: case 0x1F21A: case 0x1F22F:
      return true;
    default:
      break;
  }
  if (c >= 0x2648 && c <= 0x2653) return true;
  if (c >= 0x1F191 && c <= 0x1F19A) return true;
  return false;
}

// Characters that stay in the font of the character before them.
bool AttachesToPrevious(uint32_t c, hb_unicode_funcs_t* uf) {
  if (c == 0x200D || c == 0x200C || c == 0x20E3) return true;            // ZWJ, ZWNJ, keycap
  if ((c >= 0xFE00 && c <= 0xFE0F) || (c >= 0xE0100 && c <= 0xE01EF)) return true;  // variation selectors
  if (c >= 0x1F3FB && c <= 0x1F3FF) return true;                         // skin tone modifiers
  if (c >= 0xE0020 && c <= 0xE007F) return true;                         // tags
  hb_unicode_general_category_t gc = hb_unicode_general_category(uf, c);
  return gc == HB_UNICODE_GENERAL_CATEGORY_NON_SPACING_MARK || gc == HB_UNICODE_GENERAL_CATEGORY_SPACING_MARK ||
         gc == HB_UNICODE_GENERAL_CATEGORY_ENCLOSING_MARK;
}

}  // namespace

Font::Font(FontDesc desc) : desc_(std::move(desc)) {
  if (!(desc_.size > 0) || !std::isfinite(desc_.size)) desc_.size = 10;
}

const std::vector<FaceRef>& Font::Chain() {
  if (chain_ready_) return chain_;
  chain_.clear();
  for (const FaceRef& r : desc_.faces) {
    if (!r.face) continue;
    FaceRef ref = r;
    if (r.face->has_weight_axis()) {
      // CSS Fonts 4: the requested weight clamped to the face's descriptor range (when the page declared one),
      // then to the font's axis. Synthetic bold stays as the matcher decided (descriptor range below 600).
      float lo = r.face->weight_min(), hi = r.face->weight_max();
      if (r.weight_min > 0 && r.weight_max >= r.weight_min) {
        lo = std::clamp(static_cast<float>(r.weight_min), lo, hi);
        hi = std::clamp(static_cast<float>(r.weight_max), lo, hi);
      }
      float w = std::clamp(static_cast<float>(desc_.weight), lo, hi);
      ref.face = r.face->WeightInstance(w);
    }
    chain_.push_back(ref);
  }
  chain_ready_ = true;
  return chain_;
}

Font::Vertical Font::VerticalMetrics() const {
  const Face* f = nullptr;
  for (const FaceRef& r : desc_.faces) {
    if (r.face) {
      f = r.face.get();
      break;
    }
  }
  double size = desc_.size;
  Vertical v;
  if (!f) {
    v.ascent = size * 0.8;
    v.descent = size * 0.2;
    v.em_ascent = size * 0.8;
    v.em_descent = size * 0.2;
    return v;
  }
  double s = size / f->units_per_em();
  // Ascent/descent are whole pixels (what Chrome reports and lays out with on Android/Linux).
  v.ascent = std::round(f->ascent() * s);
  v.descent = std::round(f->descent() * s);
  double ta = f->typo_ascent(), td = f->typo_descent();
  if (ta + td > 0) {
    v.em_ascent = size * ta / (ta + td);
    v.em_descent = size - v.em_ascent;
  } else {
    v.em_ascent = size * 0.8;
    v.em_descent = size * 0.2;
  }
  return v;
}

double Font::BaselineOffset(TextBaseline baseline) const {
  Vertical v = VerticalMetrics();
  switch (baseline) {
    case TextBaseline::kTop:
      return v.em_ascent;
    case TextBaseline::kHanging:
      return v.ascent * 0.8;
    case TextBaseline::kMiddle:
      return (v.em_ascent - v.em_descent) / 2;
    case TextBaseline::kIdeographic:
      return -v.descent;
    case TextBaseline::kBottom:
      return -v.em_descent;
    case TextBaseline::kAlphabetic:
    default:
      return 0;
  }
}

void Font::Shape(std::u16string_view text, TextDirection dir, ShapedText* out) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (last_valid_ && last_dir_ == dir && text == last_text_) {
    *out = last_shape_;
    return;
  }
  *out = ShapedText();
  const std::vector<FaceRef>& chain0 = Chain();
  (void)chain0;
  hb_unicode_funcs_t* uf = hb_unicode_funcs_get_default();

  // HTML: replace ASCII whitespace with U+0020 before rendering.
  std::u16string t(text);
  for (char16_t& c : t) {
    if (c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D) c = 0x20;
  }
  struct Cp {
    uint32_t cp;
    uint32_t start;  // UTF-16 index
    uint32_t len;
    int face;
    hb_script_t script;
  };
  std::vector<Cp> cps;
  cps.reserve(t.size());
  for (uint32_t i = 0; i < t.size();) {
    uint32_t c = t[i];
    uint32_t len = 1;
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < t.size() && t[i + 1] >= 0xDC00 && t[i + 1] <= 0xDFFF) {
      c = 0x10000 + ((c - 0xD800) << 10) + (t[i + 1] - 0xDC00);
      len = 2;
    } else if (c >= 0xD800 && c <= 0xDFFF) {
      c = 0xFFFD;
    }
    cps.push_back({c, i, len, 0, HB_SCRIPT_COMMON});
    i += len;
  }
  if (cps.empty()) {
    last_text_ = std::u16string(text);
    last_dir_ = dir;
    last_shape_ = *out;
    last_valid_ = true;
    return;
  }

  // Font choice per code point.
  auto weight_wanted_bold = desc_.weight >= 600;
  auto find_in_chain = [&](uint32_t cp, uint32_t vs, bool color_only) -> int {
    for (size_t k = 0; k < chain_.size(); k++) {
      if (color_only && !chain_[k].face->is_color()) continue;
      if (chain_[k].face->GlyphFor(cp, vs)) return static_cast<int>(k);
    }
    return -1;
  };
  auto find_fallback = [&](uint32_t cp, uint32_t vs, bool color_only) -> int {
    if (!desc_.use_system_fallback) return -1;
    int found = -1;
    FontRegistry::Get().VisitFallback(desc_.weight, desc_.italic, [&](const FaceRef& r) {
      if (color_only && !r.face->is_color()) return false;
      if (!r.face->GlyphFor(cp, vs)) return false;
      for (size_t k = 0; k < chain_.size(); k++) {
        if (chain_[k].face == r.face) {
          found = static_cast<int>(k);
          return true;
        }
      }
      FaceRef ref = r;
      ref.synthetic_bold = weight_wanted_bold && r.face->weight() < 600 && !r.face->is_color();
      ref.synthetic_italic = desc_.italic && !r.face->italic() && !r.face->is_color();
      chain_.push_back(ref);
      found = static_cast<int>(chain_.size() - 1);
      return true;
    });
    return found;
  };
  for (size_t i = 0; i < cps.size(); i++) {
    uint32_t c = cps[i].cp;
    if (i > 0 && AttachesToPrevious(c, uf)) {
      cps[i].face = cps[i - 1].face;
      continue;
    }
    uint32_t vs = (i + 1 < cps.size() && cps[i + 1].cp >= 0xFE00 && cps[i + 1].cp <= 0xFE0F) ? cps[i + 1].cp : 0;
    bool want_color = (vs == 0xFE0F) || (vs != 0xFE0E && IsEmojiPresentation(c));
    int f = -1;
    if (want_color) {
      f = find_in_chain(c, 0, true);
      if (f < 0) f = find_fallback(c, 0, true);
    }
    if (f < 0) f = find_in_chain(c, vs, false);
    if (f < 0 && vs) f = find_in_chain(c, 0, false);
    if (f < 0) f = find_fallback(c, 0, false);
    if (f < 0) f = chain_.empty() ? -1 : 0;  // .notdef of the primary face
    cps[i].face = f;
  }

  // Script per code point (UAX #24): Inherited always takes the script of the character before it (so ZWJ, variation
  // selectors and combining marks never split a sequence, even in text without letters); Common/Unknown take the
  // script of the nearest real script before them, or after them at the start of the text. Text with no real
  // script at all stays Common throughout (one run).
  for (size_t i = 0; i < cps.size(); i++) {
    hb_script_t s = hb_unicode_script(uf, cps[i].cp);
    if (s == HB_SCRIPT_INHERITED) s = i > 0 ? cps[i - 1].script : HB_SCRIPT_COMMON;
    if (s == HB_SCRIPT_UNKNOWN) s = HB_SCRIPT_COMMON;
    cps[i].script = s;
  }
  hb_script_t last = HB_SCRIPT_INVALID;
  for (Cp& c : cps) {
    if (c.script == HB_SCRIPT_COMMON) {
      if (last != HB_SCRIPT_INVALID) c.script = last;
    } else {
      last = c.script;
    }
  }
  last = HB_SCRIPT_INVALID;
  for (size_t i = cps.size(); i-- > 0;) {
    hb_script_t s = cps[i].script;
    if (s == HB_SCRIPT_COMMON) {
      if (last != HB_SCRIPT_INVALID) cps[i].script = last;
    } else {
      last = s;
    }
  }

  // Bidi embedding levels (HTML text preparation: the bidi algorithm with ctx.direction as the paragraph direction).
  std::vector<uint32_t> cpv(cps.size());
  for (size_t i = 0; i < cps.size(); i++) cpv[i] = cps[i].cp;
  std::vector<uint8_t> levels;
  ResolveBidiLevels(cpv.data(), cpv.size(), dir == TextDirection::kRtl ? 1 : 0, uf, &levels);

  // Runs: maximal stretches with one face, script and level, then reordered visually (UAX #9 L2: from the highest
  // level down to the lowest odd level, reverse every sequence of runs at that level or higher).
  struct Run {
    size_t first, last;  // code point indices, inclusive
    int face;
    hb_script_t script;
    uint8_t level;
  };
  std::vector<Run> runs;
  for (size_t i = 0; i < cps.size(); i++) {
    if (!runs.empty() && runs.back().face == cps[i].face && runs.back().script == cps[i].script &&
        runs.back().level == levels[i]) {
      runs.back().last = i;
    } else {
      runs.push_back({i, i, cps[i].face, cps[i].script, levels[i]});
    }
  }
  {
    uint8_t max_level = 0, min_odd = 255;
    for (const Run& r : runs) {
      max_level = std::max(max_level, r.level);
      if (r.level & 1) min_odd = std::min(min_odd, r.level);
    }
    for (int lv = max_level; lv >= min_odd && lv > 0; lv--) {
      for (size_t i = 0; i < runs.size();) {
        if (runs[i].level < lv) {
          i++;
          continue;
        }
        size_t j = i;
        while (j < runs.size() && runs[j].level >= lv) j++;
        std::reverse(runs.begin() + static_cast<std::ptrdiff_t>(i), runs.begin() + static_cast<std::ptrdiff_t>(j));
        i = j;
      }
    }
  }

  hb_language_t lang = desc_.language.empty() ? hb_language_get_default()
                                              : hb_language_from_string(desc_.language.c_str(), -1);
  std::vector<hb_feature_t> feats;
  auto add_feat = [&](const char* tag, uint32_t value) {
    hb_feature_t f;
    f.tag = hb_tag_from_string(tag, 4);
    f.value = value;
    f.start = HB_FEATURE_GLOBAL_START;
    f.end = HB_FEATURE_GLOBAL_END;
    feats.push_back(f);
  };
  if (!desc_.kerning) add_feat("kern", 0);
  if (desc_.small_caps) add_feat("smcp", 1);
  if (desc_.letter_spacing != 0) {
    add_feat("liga", 0);
    add_feat("clig", 0);
  }

  double pen = 0;
  const double size = desc_.size;
  hb_buffer_t* buf = hb_buffer_create();
  for (const Run& run : runs) {
    if (run.face < 0) continue;
    const FaceRef& ref = chain_[run.face];
    Face* face = ref.face.get();
    double s = size / face->units_per_em();
    uint32_t start16 = cps[run.first].start;
    uint32_t end16 = cps[run.last].start + cps[run.last].len;
    hb_buffer_clear_contents(buf);
    hb_buffer_add_utf16(buf, reinterpret_cast<const uint16_t*>(t.data()), static_cast<int>(t.size()), start16,
                        static_cast<int>(end16 - start16));
    // Odd levels are shaped right-to-left (HarfBuzz returns the glyphs in visual order either way).
    hb_buffer_set_direction(buf, (run.level & 1) ? HB_DIRECTION_RTL : HB_DIRECTION_LTR);
    hb_buffer_set_script(buf, run.script);
    hb_buffer_set_language(buf, lang);
    hb_shape(face->hb_font(), buf, feats.data(), static_cast<unsigned>(feats.size()));
    unsigned n = 0;
    hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &n);
    hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &n);
    for (unsigned g = 0; g < n; g++) {
      ShapedGlyph sg;
      sg.face = face;
      sg.glyph = info[g].codepoint;
      sg.cluster = info[g].cluster;
      sg.x = pen + pos[g].x_offset * s;
      sg.y = -pos[g].y_offset * s;
      sg.synthetic_bold = ref.synthetic_bold;
      sg.synthetic_italic = ref.synthetic_italic;
      sg.color = face->is_color();
      pen += pos[g].x_advance * s;
      bool cluster_end = (g + 1 == n) || info[g + 1].cluster != info[g].cluster;
      if (cluster_end) {
        pen += desc_.letter_spacing;
        uint32_t cl = info[g].cluster;
        if (desc_.word_spacing != 0 && cl < t.size() && t[cl] == 0x20) pen += desc_.word_spacing;
      }
      // Ink bounds.
      double l, r, top, bottom;
      bool ink = false;
      std::shared_ptr<const ColorBitmap> bm = sg.color ? face->Bitmap(sg.glyph) : nullptr;
      if (bm && bm->image) {
        double k = size / bm->ppem;
        l = sg.x + bm->bearing_x * k;
        r = l + bm->image->width * k;
        top = -sg.y + bm->bearing_y * k;
        bottom = top - bm->image->height * k;
        ink = true;
      } else {
        auto op = face->Outline(sg.glyph, sg.synthetic_bold ? SyntheticBold1024(size) : 0);
        const GlyphOutline& o = *op;
        if (!o.empty) {
          double sk = sg.synthetic_italic ? kSyntheticItalicSkew : 0;
          // Glyph bounds rounded out to whole pixels around the glyph origin, as browsers report them.
          l = sg.x + std::floor((o.x_min + sk * std::min(0.0f, o.y_min)) * s);
          r = sg.x + std::ceil((o.x_max + sk * std::max(0.0f, o.y_max)) * s);
          top = -sg.y + std::ceil(o.y_max * s);
          bottom = -sg.y + std::floor(o.y_min * s);
          ink = true;
        }
      }
      if (ink) {
        if (!out->has_ink) {
          out->ink_left = l, out->ink_right = r, out->ink_top = top, out->ink_bottom = bottom;
          out->has_ink = true;
        } else {
          out->ink_left = std::min(out->ink_left, l);
          out->ink_right = std::max(out->ink_right, r);
          out->ink_top = std::max(out->ink_top, top);
          out->ink_bottom = std::min(out->ink_bottom, bottom);
        }
      }
      out->glyphs.push_back(sg);
    }
  }
  hb_buffer_destroy(buf);
  out->advance = pen;
  last_text_ = std::u16string(text);
  last_dir_ = dir;
  last_shape_ = *out;
  last_valid_ = true;
}

namespace {
double AlignOffset(TextAlign align, TextDirection dir, double width) {
  switch (align) {
    case TextAlign::kLeft:
      return 0;
    case TextAlign::kRight:
      return -width;
    case TextAlign::kCenter:
      return -width / 2;
    case TextAlign::kEnd:
      return dir == TextDirection::kRtl ? 0 : -width;
    case TextAlign::kStart:
    default:
      return dir == TextDirection::kRtl ? -width : 0;
  }
}
}  // namespace

void Font::Measure(std::u16string_view text, TextAlign align, TextBaseline baseline, TextDirection dir,
                   TextMetricsResult* out) {
  ShapedText st;
  Shape(text, dir, &st);
  Vertical v = VerticalMetrics();
  double shift = BaselineOffset(baseline);
  double off = AlignOffset(align, dir, st.advance);
  *out = TextMetricsResult();
  out->width = st.advance;
  if (st.has_ink) {
    out->actual_left = -(st.ink_left + off);
    out->actual_right = st.ink_right + off;
    out->actual_ascent = st.ink_top - shift;
    out->actual_descent = -st.ink_bottom + shift;
  } else {
    out->actual_left = -off;
    out->actual_right = off;
    out->actual_ascent = -shift;
    out->actual_descent = shift;
  }
  out->font_ascent = v.ascent - shift;
  out->font_descent = v.descent + shift;
  out->em_ascent = v.em_ascent - shift;
  out->em_descent = v.em_descent + shift;
  out->hanging = v.ascent * 0.8 - shift;
  out->alphabetic = 0.0 - shift;
  out->ideographic = -v.descent - shift;
}

void Font::Draw(Canvas* canvas, std::u16string_view text, double x, double y, double max_width, TextAlign align,
                TextBaseline baseline, TextDirection dir, const StrokeStyle* stroke, const Paint& paint,
                const DrawParams& params) {
  ShapedText st;
  Shape(text, dir, &st);
  if (st.glyphs.empty()) return;
  double width = st.advance;
  double sx = 1;
  if (std::isfinite(max_width) && width > max_width && width > 0) sx = max_width / width;
  double origin_x = x + AlignOffset(align, dir, width * sx);
  double base_y = y + BaselineOffset(baseline);
  const double size = desc_.size;

  std::vector<float> path;
  path.reserve(st.glyphs.size() * 64);
  // Axis-aligned text: glyph origins snap to 1/4 device pixel horizontally and whole pixels vertically, like
  // browsers' glyph caches do; rotated/skewed or very large text is positioned exactly.
  const Matrix& m = params.ctm;
  const bool snap = m.b == 0 && m.c == 0 && m.a != 0 && m.d != 0 && std::fabs(size * m.d) < 256;
  auto snap_x = [&](double ux) {
    if (!snap) return 0.0;
    double dx = m.a * ux + m.e;
    return (std::floor(dx * 4 + 0.5) / 4 - dx) / m.a;
  };
  auto snap_y = [&](double uy) {
    if (!snap) return 0.0;
    double dy = m.d * uy + m.f;
    return (std::floor(dy + 0.5) - dy) / m.d;
  };
  auto append_outline = [&](const ShapedGlyph& g, const GlyphOutline& o, std::vector<float>* dst) {
    double s = size / g.face->units_per_em();
    double sk = g.synthetic_italic ? kSyntheticItalicSkew : 0;
    double gx0 = origin_x + g.x * sx, gy0 = base_y + g.y;
    double ox = snap_x(gx0), oy = snap_y(gy0);
    const float* p = o.path.data();
    const float* end = p + o.path.size();
    while (p < end) {
      int verb = static_cast<int>(p[0]);
      int npts = verb == kVerbMove || verb == kVerbLine ? 1 : verb == kVerbQuad ? 2 : verb == kVerbCubic ? 3 : 0;
      dst->push_back(p[0]);
      for (int i = 0; i < npts; i++) {
        double fx = p[1 + 2 * i], fy = p[2 + 2 * i];
        dst->push_back(static_cast<float>(gx0 + ox + (fx + sk * fy) * s * sx));
        dst->push_back(static_cast<float>(gy0 + oy - fy * s));
      }
      p += 1 + 2 * npts;
    }
  };
  struct Deferred {
    const ShapedGlyph* g;
    std::shared_ptr<const ColorBitmap> bitmap;  // held: the face's cache may evict it meanwhile
  };
  std::vector<Deferred> color;
  std::vector<ColorLayer> layers;
  for (const ShapedGlyph& g : st.glyphs) {
    if (g.color && !stroke) {
      std::shared_ptr<const ColorBitmap> bm = g.face->Bitmap(g.glyph);
      if (bm && bm->image) {
        color.push_back({&g, std::move(bm)});
        continue;
      }
      if (g.face->ColorLayers(g.glyph, &layers)) {
        color.push_back({&g, nullptr});
        continue;
      }
    }
    auto op = g.face->Outline(g.glyph, g.synthetic_bold ? SyntheticBold1024(size) : 0);
    if (!op->empty) append_outline(g, *op, &path);
  }
  if (!path.empty()) {
    PathView pv{path.data(), path.size()};
    if (stroke)
      canvas->Stroke(pv, false, *stroke, paint, params);
    else
      canvas->Fill(pv, false, FillRule::kNonZero, paint, params);
  }
  for (const Deferred& d : color) {
    const ShapedGlyph& g = *d.g;
    if (d.bitmap) {
      double k = size / d.bitmap->ppem;
      // Minify from the mip level within 2x of the device size (the strike is ~136 px; labels are ~10-40 px).
      const OwnedImage* img = d.bitmap->image.get();
      double dev = k * params.ctm.MaxScale() * std::max(1.0, std::fabs(sx));
      for (const auto& m : d.bitmap->mips) {
        if (!(dev * d.bitmap->image->width / img->width < 0.5)) break;
        img = m.get();
      }
      double kx = k * d.bitmap->image->width / img->width, ky = k * d.bitmap->image->height / img->height;
      Matrix m{kx * sx, 0, 0, ky,
               origin_x + (g.x + d.bitmap->bearing_x * k) * sx,
               base_y + g.y - d.bitmap->bearing_y * k};
      DrawParams p = params;
      if (paint.kind == Paint::Kind::kSolid) p.global_alpha *= paint.color.a;
      // Browsers do not apply imageSmoothingEnabled to text: colour glyphs are always filtered.
      p.smoothing = true;
      canvas->DrawImageTransformed(img->View(), m, p);
      continue;
    }
    g.face->ColorLayers(g.glyph, &layers);
    for (const ColorLayer& l : layers) {
      auto op = g.face->Outline(l.glyph, 0);
      const GlyphOutline& o = *op;
      if (o.empty) continue;
      std::vector<float> lp;
      append_outline(g, o, &lp);
      Paint lpaint = paint;
      if (!l.use_foreground) {
        lpaint = Paint();
        lpaint.color = l.color;
      }
      canvas->Fill(PathView{lp.data(), lp.size()}, false, FillRule::kNonZero, lpaint, params);
    }
  }
}

}  // namespace iwn::canvas2d
