// Cost and edge-case bounds: shadow work proportional to the shape (not the canvas), extreme stroke widths, culled
// off-canvas dashes, dashes on enormous segments, overflowing edge slopes, the rasterizer's left-of-clip edge accumulation, hit testing on the path boundary, fonts.xml wght axes, colour emoji
// (no CBDT copy, mip minification, independent of imageSmoothingEnabled) and bounded glyph caches.

#include <malloc.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

#include "iwn/canvas2d/canvas.h"
#include "iwn/canvas2d/text.h"
#include "raster.h"
#include "test.h"

using namespace iwn::canvas2d;

#if defined(__SANITIZE_ADDRESS__)
#define IWN_TEST_ASAN 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define IWN_TEST_ASAN 1
#endif
#endif
#ifndef IWN_TEST_ASAN
#define IWN_TEST_ASAN 0
#endif

namespace {

double Seconds(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
}

std::vector<float> Rect(float x, float y, float w, float h) {
  return {kVerbMove, x, y, kVerbLine, x + w, y, kVerbLine, x + w, y + h, kVerbLine, x, y + h, kVerbClose};
}

Paint Solid(float r, float g, float b, float a = 1) {
  Paint p;
  p.color = Color{r * a, g * a, b * a, a};
  return p;
}

// Best of several runs (the first warms caches and the per-thread scratch).
template <class F>
double BestSeconds(int runs, F&& f) {
  double best = 1e9;
  for (int i = 0; i < runs; i++) {
    auto t0 = std::chrono::steady_clock::now();
    f();
    best = std::min(best, Seconds(t0));
  }
  return best;
}

}  // namespace

TEST(shadow_cost_follows_the_shape_not_the_canvas) {
  // A 20x20 shadowed rect: identical pixels on a small and a 4096^2 canvas, and the big canvas costs about the same.
  auto r = Rect(40, 40, 20, 20);
  DrawParams p;
  p.shadow.color = Color{0, 0, 0, 0.5f};
  p.shadow.blur = 4;
  p.shadow.offset_x = 3;
  p.shadow.offset_y = 5;
  Paint red = Solid(1, 0, 0);
  Surface small, big;
  small.Resize(128, 128);
  big.Resize(4096, 4096);
  Canvas cs(&small), cb(&big);
  double t_small = BestSeconds(5, [&] { cs.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, red, p); });
  double t_big = BestSeconds(5, [&] { cb.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, red, p); });
  bool same = true;
  for (int y = 0; y < 128; y++)
    for (int x = 0; x < 128 * 4; x++) same &= small.Row(y)[x] == big.Row(y)[x];
  EXPECT(same);
  EXPECT(big.Row(4000)[4 * 4000 + 3] == 0);
  // Before: ~17.7 ms on 4096^2 (every pixel of the canvas visited twice). Now the same few hundred microseconds as
  // on the small canvas; the bound leaves room for a loaded machine.
  EXPECT(t_big < 0.004);
  EXPECT(t_big < t_small * 10 + 0.001);
  // Unbounded operators still clear the rest of the box (copy: outside the shape and shadow becomes transparent).
  DrawParams q = p;
  q.op = CompositeOp::kCopy;
  Surface u;
  u.Resize(256, 256);
  Canvas cu(&u);
  auto all = Rect(0, 0, 256, 256);
  cu.Fill(PathView{all.data(), all.size()}, false, FillRule::kNonZero, Solid(0, 0, 1), DrawParams());
  cu.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, red, q);
  EXPECT(u.Row(200)[4 * 200 + 3] == 0);
  EXPECT(u.Row(50)[4 * 50] == 255 && u.Row(50)[4 * 50 + 3] == 255);
}

TEST(extreme_stroke_widths_stay_fast) {
  Surface s;
  s.Resize(1024, 1024);
  Canvas c(&s);
  std::vector<float> curve = {kVerbMove, 100, 500, kVerbCubic, 300, 100, 700, 900, 900, 500,
                              kVerbQuad, 950, 300, 600, 200};
  StrokeStyle st;
  st.join = LineJoin::kRound;
  st.cap = LineCap::kRound;
  for (double w : {3e29, 1e12, 5e5}) {
    st.width = w;
    auto t0 = std::chrono::steady_clock::now();
    c.Stroke(PathView{curve.data(), curve.size()}, false, st, Solid(0, 0, 0), DrawParams());
    EXPECT(Seconds(t0) < 0.5);
    EXPECT(s.Row(512)[4 * 512 + 3] == 255);  // a stroke this wide covers the canvas
  }
  // A normal width under a CTM with an enormous component.
  st.width = 10;
  DrawParams p;
  p.ctm = Matrix{1e26, 0, 0, 1, 0, 0};
  auto t0 = std::chrono::steady_clock::now();
  c.Stroke(PathView{curve.data(), curve.size()}, false, st, Solid(0, 0, 0), p);
  EXPECT(Seconds(t0) < 0.5);
}

TEST(dashed_strokes_skip_offscreen_dashes) {
  // A dashed zigzag reaching far outside a 100x100 canvas, drawn there (dashes outside are culled) and on an 800x800
  // canvas translated by (300, 300) where nothing is culled: the same pixels over the small canvas's area.
  std::vector<float> zig = {kVerbMove, -290, 30.5f, kVerbLine, 50.3f, 12, kVerbLine, 390, 61, kVerbLine, 62, 88.7f,
                            kVerbLine, -200, 72, kVerbLine, 40, 140, kVerbLine, 47, -150};
  std::vector<float> dash = {7, 5, 1, 4};
  for (LineCap cap : {LineCap::kRound, LineCap::kSquare, LineCap::kButt}) {
    for (LineJoin join : {LineJoin::kMiter, LineJoin::kRound}) {
      StrokeStyle st;
      st.width = 6;
      st.cap = cap;
      st.join = join;
      st.miter_limit = 10;
      st.dash = dash;
      st.dash_offset = 3;
      Surface small, big;
      small.Resize(100, 100);
      big.Resize(800, 800);
      Canvas cs(&small), cb(&big);
      cs.Stroke(PathView{zig.data(), zig.size()}, false, st, Solid(0, 0, 0), DrawParams());
      DrawParams p;
      p.ctm = Matrix::Translate(300, 300);
      cb.Stroke(PathView{zig.data(), zig.size()}, false, st, Solid(0, 0, 0), p);
      int maxdiff = 0, inked = 0;
      for (int y = 0; y < 100; y++)
        for (int x = 0; x < 100; x++) {
          int a = small.Row(y)[4 * x + 3], b = big.Row(y + 300)[4 * (x + 300) + 3];
          maxdiff = std::max(maxdiff, std::abs(a - b));
          inked += a > 0;
        }
      if (maxdiff > 2) std::fprintf(stderr, "  cap %d join %d: max alpha difference %d\n", int(cap), int(join), maxdiff);
      EXPECT(maxdiff <= 2);
      EXPECT(inked > 300);
    }
  }
  // Cost: a 4e8 px dashed line with round caps (about 1e6 dashes, nearly all off the canvas). Before: 0.5 s at
  // lineWidth 1, 14 s at lineWidth 1e4. Width 1e6: dashes far wider than the period merge (average coverage).
  Surface s;
  s.Resize(512, 128);
  Canvas c(&s);
  std::vector<float> line = {kVerbMove, 0, 10, kVerbLine, 4e8f, 10};
  for (double w : {1.0, 50.0, 1e4, 1e6}) {
    StrokeStyle st;
    st.width = w;
    st.cap = LineCap::kRound;
    st.dash = {190, 232};
    auto t0 = std::chrono::steady_clock::now();
    c.Stroke(PathView{line.data(), line.size()}, false, st, Solid(0, 0, 0), DrawParams());
    double t = Seconds(t0);
    if (t > 0.1) std::fprintf(stderr, "  width %g: %.3f s\n", w, t);
    EXPECT(t < 0.1);
    if (w <= 50) {
      // Still really dashed (not the average-coverage fallback): ink in the first dash, a gap at x = 300.
      EXPECT(s.Row(10)[4 * 100 + 3] > 0);
      EXPECT(s.Row(10)[4 * 300 + 3] == 0);
      s.Clear();
    }
  }
  EXPECT(s.Row(64)[4 * 256 + 3] == 255);
}

TEST(dashes_on_enormous_segments_terminate) {
  // Fuzzer case: a dashed stroke whose path starts at y = -9.5e36. Positions along the segment were measured from its
  // start, where adding a 135 px dash to ~1e37 changes nothing, so the dash walk never ended and allocated until the
  // process died (100 GB). Run in a child with a 2 GB address-space limit and a 20 s alarm, so a regression fails
  // this test instead of taking the machine down. (Skipped under ASan, which reserves terabytes of address space.)
#if IWN_TEST_ASAN
  std::fprintf(stderr, "  skipped under ASan\n");
#else
  auto run = [] {
    Surface s;
    s.Resize(160, 96);
    Canvas c(&s);
    std::vector<float> path = {kVerbClose, kVerbQuad, 82.773613f, -6.34424162f, 8.60853863f, 152.766541f,
                               kVerbMove, 62.9010315f, -9.53541423e+36f, kVerbCubic, 149.041031f, -44285.5586f,
                               118.841309f, 2.82421126e-07f, 151.79509f, 105.528145f};
    StrokeStyle st;
    st.width = 21786.17223511968;
    st.cap = LineCap::kSquare;
    st.join = LineJoin::kRound;
    st.miter_limit = 265.41353456406119;
    st.dash = {135.30513f, 5.51830759e-08f};
    st.dash_offset = 34400.484959786481;
    c.Stroke(PathView{path.data(), path.size()}, false, st, Solid(0, 0, 0), DrawParams());
    // A plain dashed vertical line from y = -1e30 down through the canvas: still dashed where visible, on x = 50.
    Surface t;
    t.Resize(100, 100);
    Canvas ct(&t);
    std::vector<float> line = {kVerbMove, 50, -1e30f, kVerbLine, 50, 100};
    StrokeStyle ls;
    ls.width = 4;
    ls.dash = {10, 10};
    ct.Stroke(PathView{line.data(), line.size()}, false, ls, Solid(0, 0, 0), DrawParams());
    int on = 0, off = 0, stray = 0;
    for (int y = 0; y < 100; y++) {
      (t.Row(y)[4 * 50 + 3] == 255 ? on : off)++;
      stray += t.Row(y)[4 * 30 + 3] != 0;
    }
    return on >= 40 && off >= 40 && stray == 0;
  };
  pid_t pid = fork();
  if (pid == 0) {
    rlimit lim{size_t(2) << 30, size_t(2) << 30};
    setrlimit(RLIMIT_AS, &lim);
    alarm(20);
    _exit(run() ? 0 : 3);
  }
  int status = 0;
  waitpid(pid, &status, 0);
  if (!(WIFEXITED(status) && WEXITSTATUS(status) == 0)) std::fprintf(stderr, "  child status %d\n", status);
  EXPECT(WIFEXITED(status) && WEXITSTATUS(status) == 0);
#endif
}

TEST(rasterizer_survives_overflowing_edge_slopes) {
  // Finite endpoints whose slope overflows (|dx| ~ 1.7e308 over a sub-pixel dy), starting above a clip box whose top
  // row is not 0. Before: inf/NaN intercepts gave cells in row 0 and Finish() indexed out of range (ASan).
  Rasterizer r;
  r.Reset(IntRect{0, 50, 100, 100});
  const double tri[] = {-1.7e308, 49.75, 5, 50.25, 5, 60};
  r.AddPolygon(tri, 3);
  const double tri2[] = {1.7e308, 99.9, -1.7e308, 100.2, 50, 70};
  r.AddPolygon(tri2, 3);
  r.Finish();
  IntRect b = r.Bounds();
  EXPECT(b.y0 >= 50 && b.y1 <= 100);
  int rows_seen = 0;
  bool in_range = true;
  r.Sweep(FillRule::kNonZero, [&](int y, int, int, const uint8_t*) {
    in_range &= y >= 50 && y < 100;
    rows_seen++;
  });
  EXPECT(in_range);
  EXPECT(rows_seen > 0);
  // Through the canvas, as the JS repro: x scale 1.7e308 with a clip; the visible part is rows 50-60, x < 5.
  Surface s;
  s.Resize(100, 100);
  Canvas c(&s);
  auto cr = Rect(0, 50, 100, 50);
  auto clip = c.MakeClip(PathView{cr.data(), cr.size()}, false, FillRule::kNonZero, Matrix{}, nullptr);
  for (double sx : {1.7e308, 1e308, 3e307}) {
    s.Clear();
    DrawParams p;
    p.clip = clip.get();
    p.ctm = Matrix{sx, 0, 0, 1, 5, 0};
    std::vector<float> path = {kVerbMove, -1, 49.75f, kVerbLine, 0, 50.25f, kVerbLine, 0, 60, kVerbClose};
    c.Fill(PathView{path.data(), path.size()}, false, FillRule::kNonZero, Solid(1, 0, 0), p);
    int ink = 0;
    for (int y = 0; y < 100; y++)
      for (int x = 0; x < 100; x++) ink += s.Row(y)[4 * x + 3] != 0;
    EXPECT(ink == 50);
  }
}

TEST(edges_left_of_the_clip_accumulate_exactly) {
  // The same polygon rasterised with the clip starting at 0 (edges left of it take the per-row accumulation path) and
  // at -300 (every edge walked as cells): identical coverage over the visible columns.
  const double poly[] = {-250.3, 3.3, 20.6, 10.1, 35.2, 40.7, -10.4, 60.2, -120.9, 30.5, -5.5, 22.25};
  for (FillRule rule : {FillRule::kNonZero, FillRule::kEvenOdd}) {
    std::vector<std::vector<uint8_t>> out(2, std::vector<uint8_t>(64 * 64, 0));
    for (int k = 0; k < 2; k++) {
      Rasterizer r;
      r.Reset(IntRect{k == 0 ? 0 : -300, 0, 64, 64});
      r.AddPolygon(poly, 6);
      // A second, reversed copy of part of it (cancelling edges left of the clip must cancel exactly).
      const double tri[] = {-50, 5, -40, 50, -60, 30};
      const double rev[] = {-60, 30, -40, 50, -50, 5};
      r.AddPolygon(tri, 3);
      r.AddPolygon(rev, 3);
      r.Finish();
      r.Sweep(rule, [&](int y, int x0, int x1, const uint8_t* cov) {
        for (int x = std::max(x0, 0); x < x1; x++) out[k][y * 64 + x] = cov[x - x0];
      });
    }
    // Equal up to the rounding of where an edge crossing x = 0 is split (double vs. 24.8 cell walk): at most 1 level.
    int maxdiff = 0;
    for (size_t i = 0; i < out[0].size(); i++) maxdiff = std::max(maxdiff, std::abs(int(out[0][i]) - int(out[1][i])));
    if (maxdiff > 1) std::fprintf(stderr, "  max coverage difference %d\n", maxdiff);
    EXPECT(maxdiff <= 1);
    int inked = 0;
    for (uint8_t v : out[0]) inked += v > 0;
    EXPECT(inked > 500);
  }
}

TEST(points_on_the_path_are_inside) {
  Surface s;
  s.Resize(40, 40);
  Canvas c(&s);
  auto r = Rect(0, 0, 10, 10);
  PathView pv{r.data(), r.size()};
  auto in = [&](double x, double y) { return c.IsPointInPath(pv, false, Matrix::Identity(), x, y, FillRule::kNonZero); };
  // Chrome 145: [true, true, true, true, true, true, true, false].
  EXPECT(in(0, 5) && in(10, 5) && in(5, 0) && in(5, 10) && in(0, 0) && in(10, 10) && in(9.999, 5));
  EXPECT(!in(10.001, 5));
  // Stroke of y = 14, lineWidth 4: both outline sides and the butt ends count.
  std::vector<float> line = {kVerbMove, 0, 14, kVerbLine, 30, 14};
  StrokeStyle st;
  st.width = 4;
  auto ins = [&](double x, double y) {
    return c.IsPointInStroke(PathView{line.data(), line.size()}, false, Matrix::Identity(), st, x, y);
  };
  // Chrome 145: [true, true, false, true, true, false].
  EXPECT(ins(15, 12) && ins(15, 16) && !ins(15, 11.999) && ins(0, 14) && ins(30, 14) && !ins(-0.001, 14));
}

TEST(fonts_xml_wght_axis_names_the_instance) {
  const char* xml = R"(<?xml version="1.0"?>
<familyset>
  <family name="sans-serif">
    <font weight="400" style="normal">Roboto-Regular.ttf</font>
    <font style="normal">Roboto-Regular.ttf<axis tag="wdth" stylevalue="100"/><axis tag="wght" stylevalue="700"/></font>
    <font weight="900" style="normal">Roboto-Regular.ttf<axis tag="wght" stylevalue="800"/></font>
  </family>
</familyset>)";
  FontsXml fx;
  std::string err;
  EXPECT(ParseFontsXml(xml, &fx, &err));
  EXPECT(fx.families.size() == 1 && fx.families[0].fonts.size() == 3);
  if (fx.families.size() == 1 && fx.families[0].fonts.size() == 3) {
    EXPECT(fx.families[0].fonts[0].weight == 400);
    EXPECT(fx.families[0].fonts[1].weight == 700);  // from the wght axis
    EXPECT(fx.families[0].fonts[2].weight == 900);  // the weight attribute wins
  }
}

TEST(colour_emoji_mapped_not_copied_mipmapped_and_always_smoothed) {
  // Optional: a CBDT colour emoji font (e.g. NotoColorEmoji.ttf from the Android system image). Not bundled.
  const char* env = std::getenv("IWN_C2D_EMOJI_FONT");
  std::string path = env ? env : "";
  struct stat sb;
  if (path.empty() || stat(path.c_str(), &sb) != 0) {
    std::fprintf(stderr, "  (skipped: set IWN_C2D_EMOJI_FONT to a CBDT emoji font)\n");
    return;
  }
  size_t before = mallinfo2().uordblks;
  std::string e;
  auto face = Face::Load(FontBytes::MapFile(path), 0, &e);
  EXPECT(face != nullptr);
  if (!face) return;
  // Opening the face does not copy the multi-MB CBLC/CBDT tables to the heap (they stay in the mapped file).
  size_t grown = mallinfo2().uordblks - before;
  EXPECT(grown < size_t(1) << 20);
  uint32_t g = face->GlyphFor(0x1F600, 0);
  std::shared_ptr<const ColorBitmap> bm = face->Bitmap(g);
  EXPECT(bm && bm->image && !bm->mips.empty());
  if (!bm || !bm->image) return;
  EXPECT(bm->mips[0]->width == (bm->image->width + 1) / 2);
  FontDesc d;
  d.faces.push_back(FaceRef{face, false, false});
  d.size = 16;
  d.use_system_fallback = false;
  Font font(d);
  auto draw = [&](bool smoothing) {
    Surface s;
    s.Resize(40, 30);
    Canvas c(&s);
    DrawParams p;
    p.smoothing = smoothing;
    font.Draw(&c, u"\U0001F600", 4, 22, NAN, TextAlign::kLeft, TextBaseline::kAlphabetic, TextDirection::kLtr, nullptr,
              Solid(0, 0, 0), p);
    return std::vector<uint8_t>(s.data(), s.data() + s.byte_size());
  };
  auto on = draw(true), off = draw(false);
  EXPECT(on == off);
  int ink = 0;
  for (size_t i = 3; i < on.size(); i += 4) ink += on[i] > 0;
  EXPECT(ink > 100);
}

TEST(glyph_caches_are_bounded_lru) {
  GlyphLru<uint32_t, int> lru(100);
  for (uint32_t k = 0; k < 10; k++) lru.Put(k, std::make_shared<const int>(int(k)), 20);
  EXPECT(lru.bytes() <= 100);
  EXPECT(lru.size() == 5);
  std::shared_ptr<const int> v;
  EXPECT(!lru.Get(0, &v));
  EXPECT(lru.Get(9, &v) && v && *v == 9);
  // A value evicted while held stays valid; the most recently used entry survives eviction.
  std::shared_ptr<const int> held;
  EXPECT(lru.Get(5, &held));
  lru.Get(9, &v);
  for (uint32_t k = 100; k < 104; k++) lru.Put(k, std::make_shared<const int>(int(k)), 20);
  EXPECT(*held == 5);
  EXPECT(!lru.Get(5, &v));
  EXPECT(lru.Get(9, &v));
  // Real faces: thousands of distinct outlines stay within the face's budget.
  std::string e;
  auto face = Face::Load(FontBytes::MapFile(std::string(IWN_C2D_FONT_DIR) + "/Roboto-Regular.ttf"), 0, &e);
  EXPECT(face != nullptr);
  if (!face) return;
  for (int bold = 0; bold < 40; bold++)
    for (uint32_t g = 1; g < 400; g++) face->Outline(g, bold * 7);
  EXPECT(face->CacheBytes() <= Face::kOutlineCacheBytes);
  EXPECT(face->CacheBytes() > Face::kOutlineCacheBytes / 2);

  // Optional colour emoji: drawing ~900 distinct emoji keeps the bitmap cache within its budget.
  const char* env = std::getenv("IWN_C2D_EMOJI_FONT");
  struct stat sb;
  if (!env || stat(env, &sb) != 0) return;
  auto emoji = Face::Load(FontBytes::MapFile(env), 0, &e);
  EXPECT(emoji != nullptr);
  if (!emoji) return;
  int drawn = 0;
  for (uint32_t cp = 0x1F300; cp < 0x1FAFF; cp++) {
    uint32_t g = emoji->GlyphFor(cp, 0);
    if (g && emoji->Bitmap(g)) drawn++;
  }
  EXPECT(drawn > 500);
  EXPECT(emoji->CacheBytes() <= Face::kBitmapCacheBytes + Face::kOutlineCacheBytes);
}
