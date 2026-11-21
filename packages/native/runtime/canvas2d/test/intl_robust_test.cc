// Bidi levels and visual order, script itemisation of emoji sequences, variable-font weight clamping, and the
// robustness bounds (shadow blur, dash count), plus edge accuracy of curved fills against analytic coverage.

#include <chrono>
#include <cmath>
#include <string>
#include <sys/stat.h>
#include <vector>

#include "bidi.h"
#include "iwn/canvas2d/canvas.h"
#include "iwn/canvas2d/text.h"
#include "test.h"

using namespace iwn::canvas2d;

namespace {

std::vector<uint8_t> Levels(const std::u32string& s, int para) {
  std::vector<uint8_t> lv;
  std::vector<uint32_t> cps(s.begin(), s.end());
  ResolveBidiLevels(cps.data(), cps.size(), para, hb_unicode_funcs_get_default(), &lv);
  return lv;
}

std::shared_ptr<Face> LoadFontFile(const std::string& path) {
  auto bytes = FontBytes::MapFile(path);
  std::string err;
  return bytes ? Face::Load(bytes, 0, &err) : nullptr;
}

std::shared_ptr<Font> MakeFont(std::shared_ptr<Face> face, double size, int weight = 400, int wmin = 0, int wmax = 0) {
  FontDesc d;
  FaceRef r{face, false, false};
  r.weight_min = wmin;
  r.weight_max = wmax;
  d.faces.push_back(r);
  d.size = size;
  d.weight = weight;
  d.use_system_fallback = false;
  return std::make_shared<Font>(d);
}

std::vector<uint32_t> Clusters(Font& f, std::u16string_view text, TextDirection dir) {
  ShapedText st;
  f.Shape(text, dir, &st);
  std::vector<uint32_t> out;
  for (const ShapedGlyph& g : st.glyphs) out.push_back(g.cluster);
  return out;
}

double Seconds(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
}

std::vector<float> RectPath(float x, float y, float w, float h) {
  return {kVerbMove, x, y, kVerbLine, x + w, y, kVerbLine, x + w, y + h, kVerbLine, x, y + h, kVerbClose};
}

}  // namespace

TEST(bidi_levels_digits_neutrals_brackets) {
  // Pure LTR text stays at level 0.
  for (uint8_t l : Levels(U"Hello, world 42!", 0)) EXPECT(l == 0);
  // "Label: <arabic> 42" in an LTR paragraph: Arabic at 1, the space between Arabic and the number at 1 (N1: R and
  // AN on both sides), the European digits after Arabic become AN (W2) at level 2, in logical order.
  auto a = Levels(U"Label: مرحبا 42", 0);
  EXPECT(a.size() == 15);
  for (int i = 0; i < 7; i++) EXPECT(a[i] == 0);
  for (int i = 7; i < 12; i++) EXPECT(a[i] == 1);
  EXPECT(a[12] == 1);
  EXPECT(a[13] == 2 && a[14] == 2);
  // RTL paragraph with a number: digits at 2, letters and spaces at 1.
  auto b = Levels(U"العدد 123 هنا", 1);
  EXPECT(b[5] == 1 && b[6] == 2 && b[7] == 2 && b[8] == 2 && b[9] == 1 && b[10] == 1);
  // Latin inside RTL: level 2, the spaces around it level 1.
  auto c = Levels(U"שלום Hello עולם", 1);
  EXPECT(c[4] == 1 && c[5] == 2 && c[9] == 2 && c[10] == 1 && c[11] == 1);
  // N0: a bracket pair enclosing R text after R text takes R (level 1) even though L follows it.
  auto d = Levels(U"א (ב) a", 0);
  EXPECT(d[2] == 1 && d[3] == 1 && d[4] == 1);
  EXPECT(d[6] == 0);
  // L1: trailing whitespace returns to the paragraph level.
  auto e = Levels(U"אב ", 0);
  EXPECT(e[0] == 1 && e[1] == 1 && e[2] == 0);
  // European number terminators/separators: "-5%" after Hebrew in RTL stays one number (ES/ET handled).
  auto f = Levels(U"א 5%", 1);
  EXPECT(f[2] == 2 && f[3] == 2);
}

TEST(shape_visual_order_mixed_direction) {
  auto face = LoadFontFile(std::string(IWN_C2D_FONT_DIR) + "/Roboto-Regular.ttf");
  if (!face) return;
  auto font = MakeFont(face, 20);
  // Arabic has no glyphs in Roboto (.notdef), but clusters show the visual order: "Label: " 42 " " then the Arabic
  // word right to left (what Chrome draws: "Label: 42 <word>"), never "24".
  std::u16string t = u"Label: مرحبا 42";
  auto cl = Clusters(*font, t, TextDirection::kLtr);
  std::vector<uint32_t> want = {0, 1, 2, 3, 4, 5, 6, 13, 14, 12, 11, 10, 9, 8, 7};
  EXPECT(cl == want);
  // RTL paragraph: "<arabic> 123 <arabic>": the first word is rightmost, digits read left to right.
  std::u16string r = u"العدد 123 هنا";
  auto rc = Clusters(*font, r, TextDirection::kRtl);
  std::vector<uint32_t> rwant = {12, 11, 10, 9, 6, 7, 8, 5, 4, 3, 2, 1, 0};
  EXPECT(rc == rwant);
  // Latin in an RTL paragraph stays left to right inside.
  auto lc = Clusters(*font, u"abc", TextDirection::kRtl);
  EXPECT((lc == std::vector<uint32_t>{0, 1, 2}));
}

TEST(emoji_sequences_shape_as_one_cluster_without_letters) {
  auto face = LoadFontFile(std::string(IWN_C2D_FONT_DIR) + "/Roboto-Regular.ttf");
  if (!face) return;
  auto font = MakeFont(face, 20);
  // Family (man ZWJ woman ZWJ girl) and keycap one: each one grapheme. Shaped in one HarfBuzz run, every glyph
  // carries the cluster of the sequence start; split runs (the old itemisation) gave each part its own cluster.
  for (std::u16string s : {std::u16string(u"\U0001F468‍\U0001F469‍\U0001F467"), std::u16string(u"1️⃣")}) {
    for (uint32_t c : Clusters(*font, s, TextDirection::kLtr)) EXPECT(c == 0);
    // Same with a letter before it (the case that already worked) and digits after.
    std::u16string t = u"a " + s;
    for (uint32_t c : Clusters(*font, t, TextDirection::kLtr)) EXPECT(c == 0 || c == 1 || c == 2);
  }
}

TEST(variable_font_weight_clamped_to_descriptor) {
  // Optional (host font): a variable face declared weight 400 must not be instantiated at 700.
  const char* path = "/usr/share/fonts/google-noto-vf/NotoSansMono-VF.ttf";
  struct stat st;
  if (stat(path, &st) != 0) return;
  auto face = LoadFontFile(path);
  if (!face || !face->has_weight_axis()) return;
  auto ink = [&](int weight, int wmin, int wmax) {
    auto font = MakeFont(face, 40, weight, wmin, wmax);
    Surface s;
    s.Resize(200, 60);
    Canvas c(&s);
    Paint p;
    p.color = Color{0, 0, 0, 1};
    font->Draw(&c, u"Weight", 4, 45, NAN, TextAlign::kLeft, TextBaseline::kAlphabetic, TextDirection::kLtr, nullptr, p,
               DrawParams());
    double sum = 0;
    for (int y = 0; y < 60; y++)
      for (int x = 0; x < 200; x++) sum += s.Row(y)[4 * x + 3];
    return sum;
  };
  double regular = ink(400, 400, 400);
  double clamped = ink(700, 400, 400);
  double bold = ink(700, 0, 0);
  EXPECT_NEAR(clamped, regular, regular * 0.001);
  EXPECT(bold > regular * 1.2);
}

TEST(shadow_blur_and_dashes_are_bounded) {
  Surface s;
  s.Resize(512, 128);
  Canvas c(&s);
  auto r = RectPath(236, 44, 40, 40);
  for (double blur : {1000.0, 1e4, 1e9}) {
    DrawParams p;
    p.shadow.color = Color{0, 0, 0, 1};
    p.shadow.blur = blur;
    Paint red;
    red.color = Color{1, 0, 0, 1};
    auto t0 = std::chrono::steady_clock::now();
    c.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, red, p);
    double secs = Seconds(t0);
    EXPECT(secs < 0.5);
    EXPECT(s.Row(64)[4 * 256] == 255);  // the shape itself
  }
  // A shape far larger than the canvas with a huge blur: the capped sigma bounds the area that is rasterised.
  {
    auto big = RectPath(-1e5f, -1e5f, 2e5f, 2e5f);
    DrawParams p;
    p.shadow.color = Color{0, 0, 0, 0.5f};
    p.shadow.blur = 1e4;
    Paint red;
    red.color = Color{1, 0, 0, 1};
    auto t0 = std::chrono::steady_clock::now();
    c.Fill(PathView{big.data(), big.size()}, false, FillRule::kNonZero, red, p);
    EXPECT(Seconds(t0) < 1.0);
    EXPECT(s.Row(10)[4 * 10] == 255);
  }
  // A sigma just above the full-resolution limit still looks like a blur: symmetric, smooth falloff.
  {
    Surface t;
    t.Resize(256, 256);
    Canvas tc(&t);
    DrawParams p;
    p.shadow.color = Color{0, 0, 0, 1};
    p.shadow.blur = 100;  // sigma 50: downsampled path
    p.shadow.offset_x = 0;
    auto sq = RectPath(-1000, 108, 40, 40);  // off canvas; only the shadow (offset) shows
    p.shadow.offset_x = 1128;
    Paint red;
    red.color = Color{1, 0, 0, 1};
    tc.Fill(PathView{sq.data(), sq.size()}, false, FillRule::kNonZero, red, p);
    int centre = t.Row(128)[4 * 148 + 3];
    int left = t.Row(128)[4 * 98 + 3], right = t.Row(128)[4 * 198 + 3];
    // Gaussian of sigma 50 over a 40 px square: peak = erf(20 / (50 sqrt 2))^2 of full alpha (about 25/255); the box
    // approximation lands within a few levels of it.
    double peak = std::pow(std::erf(20 / (50 * std::sqrt(2.0))), 2) * 255;
    EXPECT_NEAR(centre, peak, 4);
    EXPECT(std::abs(left - right) <= 2);
    EXPECT(left < centre && left > 0);
  }
  // Sub-pixel dash periods draw as the average coverage of the pattern, quickly.
  StrokeStyle st;
  st.width = 4;
  st.dash = {1e-5f, 1e-5f};
  std::vector<float> line = {kVerbMove, 6, 100, kVerbLine, 506, 100};
  Surface u;
  u.Resize(512, 128);
  Canvas uc(&u);
  Paint black;
  black.color = Color{0, 0, 0, 1};
  auto t0 = std::chrono::steady_clock::now();
  uc.Stroke(PathView{line.data(), line.size()}, false, st, black, DrawParams());
  EXPECT(Seconds(t0) < 0.2);
  int a = u.Row(100)[4 * 256 + 3];
  EXPECT(a > 110 && a < 145);
}

TEST(clip_mask_stores_only_its_area) {
  Surface s;
  s.Resize(2048, 2048);
  Canvas c(&s);
  auto r = RectPath(100, 100, 50, 20);
  auto clip = c.MakeClip(PathView{r.data(), r.size()}, false, FillRule::kNonZero, Matrix::Identity(), nullptr);
  EXPECT(clip->alpha.size() <= size_t(52) * 22);
  EXPECT(clip->bounds.x0 == 100 && clip->bounds.x1 == 150 && clip->bounds.y0 == 100 && clip->bounds.y1 == 120);
  DrawParams p;
  p.clip = clip.get();
  auto all = RectPath(0, 0, 2048, 2048);
  Paint black;
  black.color = Color{0, 0, 0, 1};
  c.Fill(PathView{all.data(), all.size()}, false, FillRule::kNonZero, black, p);
  EXPECT(s.Row(110)[4 * 120 + 3] == 255);
  EXPECT(s.Row(99)[4 * 120 + 3] == 0 && s.Row(110)[4 * 150 + 3] == 0);
}

TEST(curved_fill_edges_match_analytic_coverage) {
  // A circle's edge pixels against 16x16 supersampled analytic coverage: no systematic inward bias.
  Surface s;
  s.Resize(128, 128);
  Canvas c(&s);
  const double cx = 64.3, cy = 63.6, R = 40;
  std::vector<float> path = {kVerbMove, float(cx + R), float(cy)};
  const double k = 0.5522847498307936;
  for (int q = 0; q < 4; q++) {
    double a0 = q * M_PI / 2, a1 = (q + 1) * M_PI / 2;
    double x0 = cos(a0), y0 = sin(a0), x1 = cos(a1), y1 = sin(a1);
    path.insert(path.end(), {float(kVerbCubic), float(cx + R * (x0 - k * y0)), float(cy + R * (y0 + k * x0)),
                             float(cx + R * (x1 + k * y1)), float(cy + R * (y1 - k * x1)), float(cx + R * x1),
                             float(cy + R * y1)});
  }
  path.push_back(kVerbClose);
  Paint black;
  black.color = Color{0, 0, 0, 1};
  c.Fill(PathView{path.data(), path.size()}, false, FillRule::kNonZero, black, DrawParams());
  double sum = 0;
  int n = 0, off = 0;
  for (int y = 0; y < 128; y++) {
    for (int x = 0; x < 128; x++) {
      int in = 0;
      for (int j = 0; j < 16; j++)
        for (int i = 0; i < 16; i++) in += std::hypot(x + (i + 0.5) / 16 - cx, y + (j + 0.5) / 16 - cy) <= R;
      if (in == 0 || in == 256) continue;
      double want = in * 255.0 / 256;
      double got = s.Row(y)[4 * x + 3];
      sum += got - want;
      n++;
      off += std::fabs(got - want) > 16;
    }
  }
  EXPECT(n > 200);
  EXPECT(std::fabs(sum / n) < 3);  // mean signed error (was about -19/255 with uncorrected 0.2 px flattening)
  EXPECT(off <= n / 50);
}
