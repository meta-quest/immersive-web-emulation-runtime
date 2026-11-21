// Regression tests: thin strokes under a non-uniform transform (true geometry, bounded dash work), banded
// rasterisation (same coverage as one pass, bounded memory), non-finite paths, cell sum overflow, the dot of a
// leading zero-length dash, and the colour-glyph PNG size cap.

#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cmath>
#include <cstdint>
#include <limits>
#include <random>
#include <vector>

#include "codec.h"
#include "iwn/canvas2d/canvas.h"
#include "raster.h"
#include "test.h"

using namespace iwn::canvas2d;

#if defined(__SANITIZE_ADDRESS__)
#define IWN_R5_ASAN 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define IWN_R5_ASAN 1
#endif
#endif
#ifndef IWN_R5_ASAN
#define IWN_R5_ASAN 0
#endif

namespace {

Paint Black() {
  Paint p;
  p.color = Color{0, 0, 0, 1};
  return p;
}

int Alpha(Surface& s, int x, int y) { return s.Row(y)[4 * x + 3]; }

// Rows with any ink in column x.
int InkedRows(Surface& s, int x) {
  int n = 0;
  for (int y = 0; y < s.height(); y++) n += Alpha(s, x, y) != 0;
  return n;
}

void StrokeLine(Canvas& c, const Matrix& ctm, float x0, float y0, float x1, float y1, const StrokeStyle& st) {
  std::vector<float> path = {kVerbMove, x0, y0, kVerbLine, x1, y1};
  DrawParams p;
  p.ctm = ctm;
  c.Stroke(PathView{path.data(), path.size()}, false, st, Black(), p);
}

// Runs f in a child with an address-space limit and an alarm, so a regression fails instead of eating the machine.
bool Bounded(size_t mb, int seconds, bool (*f)()) {
  pid_t pid = fork();
  if (pid == 0) {
    rlimit lim{mb << 20, mb << 20};
    setrlimit(RLIMIT_AS, &lim);
    alarm(seconds);
    _exit(f() ? 0 : 3);
  }
  int status = 0;
  waitpid(pid, &status, 0);
  if (!(WIFEXITED(status) && WEXITSTATUS(status) == 0)) std::fprintf(stderr, "  child status %d\n", status);
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

std::vector<uint8_t> RenderCoverage(Rasterizer& r, const IntRect& clip, FillRule rule) {
  const int w = clip.x1 - clip.x0, h = clip.y1 - clip.y0;
  std::vector<uint8_t> out(static_cast<size_t>(w) * h, 0);
  r.Sweep(rule, [&](int y, int x0, int x1, const uint8_t* cov) {
    for (int x = x0; x < x1; x++) out[static_cast<size_t>(y - clip.y0) * w + (x - clip.x0)] = cov[x - x0];
  });
  return out;
}

}  // namespace

TEST(thin_strokes_under_nonuniform_scale_keep_their_true_geometry) {
  // scale(0.1, 1), lineWidth 2: a horizontal line is 2 device px thick and fully opaque (Chrome: a 2 px black line).
  // Before, the "hairline" test used the mean scale (sqrt|det| = 0.32 < 1), and drew a 3 px band at alpha 0.63.
  {
    Surface s;
    s.Resize(64, 32);
    Canvas c(&s);
    StrokeStyle st;
    st.width = 2;
    StrokeLine(c, Matrix::Scale(0.1, 1), 0, 16, 600, 16, st);
    EXPECT(Alpha(s, 30, 15) == 255 && Alpha(s, 30, 16) == 255);
    EXPECT(Alpha(s, 30, 14) == 0 && Alpha(s, 30, 17) == 0);
    // A vertical line under the same transform is 0.2 px wide: coverage about 20 %.
    s.Clear();
    StrokeLine(c, Matrix::Scale(0.1, 1), 305, 2, 305, 30, st);
    EXPECT_NEAR(Alpha(s, 30, 16), 51, 3);
    EXPECT(Alpha(s, 29, 16) == 0 && Alpha(s, 31, 16) == 0);
  }
  // Sparkline idiom: data space scale(0.096, 32), lineWidth 0.08: 2.56 px thick (Chrome ~2.5 px), not an 18 px band.
  {
    Surface s;
    s.Resize(64, 40);
    Canvas c(&s);
    StrokeStyle st;
    st.width = 0.08;
    StrokeLine(c, Matrix::Scale(0.096, 32), 10, 0.5, 600, 0.5, st);
    EXPECT(Alpha(s, 30, 15) == 255 && Alpha(s, 30, 16) == 255);
    EXPECT(InkedRows(s, 30) <= 4);
  }
  // Uniform transforms are unchanged: lineWidth 0.5 is a 1 px hairline at 50 % coverage.
  {
    Surface s;
    s.Resize(20, 20);
    Canvas c(&s);
    StrokeStyle st;
    st.width = 0.5;
    StrokeLine(c, Matrix{}, 0, 10.5, 20, 10.5, st);
    EXPECT_NEAR(Alpha(s, 10, 10), 128, 2);
    EXPECT(InkedRows(s, 10) == 1);
    // Thin in both directions under a non-uniform transform: still a 1 px device hairline, coverage the mean width.
    s.Clear();
    StrokeLine(c, Matrix::Scale(1.5, 0.5), 0, 21, 12, 21, st);  // widths 0.75 x 0.25: hairline, coverage 0.5
    EXPECT_NEAR(Alpha(s, 10, 10), 128, 2);
    EXPECT(InkedRows(s, 10) == 1);
  }
}

namespace {
bool CompressedAxisDashes() {
  // Probe: scale(1e-4, 1), lineWidth 1, setLineDash([20, 20]) across 1024 px took 5.2 s and 1.6 GB, with
  // 100 inked rows. The dash period is 0.004 px on screen: drawn as its average, one row, in milliseconds.
  struct Case {
    double sx;
    float dash;
    int h;
  } cases[] = {{1e-4, 20, 256}, {1e-5, 180, 1024}, {1e-6, 1800, 1024}};
  for (const Case& k : cases) {
    Surface s;
    s.Resize(1024, k.h);
    Canvas c(&s);
    StrokeStyle st;
    st.width = 1;
    st.dash = {k.dash, k.dash};
    auto t0 = std::chrono::steady_clock::now();
    StrokeLine(c, Matrix::Scale(k.sx, 1), 0, 100.5f, float(1024 / k.sx), 100.5f, st);
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    if (secs > 0.5) {
      std::fprintf(stderr, "  sx %g: %.3f s\n", k.sx, secs);
      return false;
    }
    // A hairline (widths 1e-4 x 1 device px, as Skia: coverage their mean, ~0.5) times the dash average 0.5.
    if (InkedRows(s, 500) != 1 || Alpha(s, 500, 100) < 54 || Alpha(s, 500, 100) > 74) {
      std::fprintf(stderr, "  sx %g: rows %d alpha %d\n", k.sx, InkedRows(s, 500), Alpha(s, 500, 100));
      return false;
    }
  }
  // Dashes that are long on screen along the compressed axis are still drawn as dashes: scale(1, 1e-3) vertical line
  // with [10000, 10000] -> 10 px dashes.
  Surface s;
  s.Resize(20, 100);
  Canvas c(&s);
  StrokeStyle st;
  st.width = 2;
  st.dash = {10000, 10000};
  StrokeLine(c, Matrix::Scale(1, 1e-3), 10, 0, 10, 100000, st);
  int on = 0, off = 0;
  for (int y = 0; y < 100; y++) {
    on += Alpha(s, 10, y) == 255;
    off += Alpha(s, 10, y) == 0;
  }
  return on >= 45 && off >= 45;
}
}  // namespace

TEST(dashes_along_a_compressed_axis_are_bounded) {
#if IWN_R5_ASAN
  EXPECT(CompressedAxisDashes());
#else
  EXPECT(Bounded(2048, 20, CompressedAxisDashes));
#endif
}

TEST(banded_sweep_matches_one_pass) {
  // Long edges across many rows (a random waveform), edges left and right of the clip, a clip not at row 0: the
  // banded sweep (forced with a tiny band budget) gives exactly the one-pass coverage, and can be swept twice.
  std::mt19937 rng(7);
  std::uniform_real_distribution<double> ux(-40, 140), uy(-10, 110);
  std::vector<double> poly;
  for (int i = 0; i < 300; i++) {
    poly.push_back(ux(rng));
    poly.push_back(uy(rng));
  }
  const IntRect clip{0, 5, 100, 97};
  for (FillRule rule : {FillRule::kNonZero, FillRule::kEvenOdd}) {
    Rasterizer one;
    one.Reset(clip);
    one.AddPolygon(poly.data(), static_cast<int>(poly.size() / 2));
    one.Finish();
    auto a = RenderCoverage(one, clip, rule);
    Rasterizer band;
    band.set_band_cells_for_test(500);
    band.Reset(clip);
    band.AddPolygon(poly.data(), static_cast<int>(poly.size() / 2));
    band.Finish();
    IntRect b1 = one.Bounds(), b2 = band.Bounds();
    EXPECT(b2.x0 <= b1.x0 && b2.y0 <= b1.y0 && b2.x1 >= b1.x1 && b2.y1 >= b1.y1);
    auto b = RenderCoverage(band, clip, rule);
    auto c = RenderCoverage(band, clip, rule);
    EXPECT(a == b);
    EXPECT(b == c);
    int ink = 0;
    for (uint8_t v : a) ink += v != 0;
    EXPECT(ink > 1000);
  }
}

TEST(dense_rows_match_sorted_rows) {
  // A many-edge polygon (rows of ~200 cells in a 100 px clip): the per-column accumulator sweep gives exactly the
  // coverage of the sorted sparse sweep (forced by raising the dense threshold), banded or not.
  std::mt19937 rng(11);
  std::uniform_real_distribution<double> ux(-20, 120), uy(-10, 110);
  std::vector<double> poly;
  for (int i = 0; i < 300; i++) {
    poly.push_back(ux(rng));
    poly.push_back(uy(rng));
  }
  const IntRect clip{0, 0, 100, 100};
  for (FillRule rule : {FillRule::kNonZero, FillRule::kEvenOdd}) {
    std::vector<std::vector<uint8_t>> out;
    for (int mode = 0; mode < 3; mode++) {
      Rasterizer r;
      if (mode == 1) r.set_dense_min_cells_for_test(size_t(1) << 30);
      if (mode == 2) r.set_band_cells_for_test(700);
      r.Reset(clip);
      r.AddPolygon(poly.data(), static_cast<int>(poly.size() / 2));
      r.Finish();
      out.push_back(RenderCoverage(r, clip, rule));
    }
    EXPECT(out[0] == out[1]);
    EXPECT(out[0] == out[2]);
    int ink = 0;
    for (uint8_t v : out[0]) ink += v != 0;
    EXPECT(ink > 3000);
  }
}

namespace {
bool WaveformStaysSmall() {
  // A random 44,100-sample waveform stroked across a 1024 x 1024 canvas: ~30 M cells in one pass (measured
  // +913 MB). Banded, the rasterizer's memory is bounded by kBandCells; a 400 MB address-space cap here (the
  // unbanded rasterizer aborts under it).
  Surface s;
  s.Resize(1024, 1024);
  Canvas c(&s);
  std::mt19937 rng(3);
  std::uniform_real_distribution<float> uy(0, 1024);
  std::vector<float> path;
  const int n = 44100;
  for (int i = 0; i < n; i++) {
    path.push_back(i == 0 ? kVerbMove : kVerbLine);
    path.push_back(1024.0f * i / n);
    path.push_back(uy(rng));
  }
  StrokeStyle st;
  st.width = 1;
  st.join = LineJoin::kRound;
  c.Stroke(PathView{path.data(), path.size()}, false, st, Black(), DrawParams());
  int ink = 0;
  for (int y = 0; y < 1024; y += 64) ink += Alpha(s, 512, y) != 0;
  return ink > 8;
}
}  // namespace

TEST(large_polylines_rasterize_in_bounded_memory) {
#if IWN_R5_ASAN
  std::fprintf(stderr, "  skipped under ASan\n");
#else
  EXPECT(Bounded(400, 60, WaveformStaysSmall));
#endif
}

TEST(paths_with_non_finite_points_draw_nothing) {
  // moveTo(4, 4); lineTo(1e39, 4) (beyond float: inf); lineTo(4, 28); fill(): Chrome draws nothing. Before, the
  // infinite edge was dropped and the open contour filled out to the canvas edge.
  Surface s;
  s.Resize(64, 32);
  Canvas c(&s);
  const float inf = std::numeric_limits<float>::infinity();
  std::vector<float> path = {kVerbMove, 4, 4, kVerbLine, inf, 4, kVerbLine, 4, 28, kVerbClose};
  c.Fill(PathView{path.data(), path.size()}, false, FillRule::kNonZero, Black(), DrawParams());
  int ink = 0;
  for (int y = 0; y < 32; y++)
    for (int x = 0; x < 64; x++) ink += Alpha(s, x, y) != 0;
  EXPECT(ink == 0);
  // A finite path in the same rasterizer afterwards draws normally (the flag is per shape).
  std::vector<float> tri = {kVerbMove, 4, 4, kVerbLine, 40, 4, kVerbLine, 4, 28, kVerbClose};
  c.Fill(PathView{tri.data(), tri.size()}, false, FillRule::kNonZero, Black(), DrawParams());
  EXPECT(Alpha(s, 8, 8) == 255);
}

TEST(cell_sums_do_not_overflow) {
  // 40,000 same-direction loops inside one pixel: the cell's area sum passed INT_MAX (UBSan: signed overflow). Cells
  // are now split before their sums could overflow; the winding saturates to full coverage inside the square.
  Rasterizer r;
  const IntRect clip{0, 0, 4, 4};
  r.Reset(clip);
  const double sq[] = {1.25, 1.25, 1.75, 1.25, 1.75, 1.75, 1.25, 1.75};  // exact in 24.8: a quarter pixel
  for (int i = 0; i < 40000; i++) r.AddPolygon(sq, 4);
  r.Finish();
  auto cov = RenderCoverage(r, clip, FillRule::kNonZero);
  EXPECT(cov[1 * 4 + 1] == 255);
  EXPECT(cov[0] == 0 && cov[2 * 4 + 2] == 0);
  // Even-odd folds the pixel's integrated winding: 40,000 x 1/4 = 10,000 full pixels, even, so empty.
  auto eo = RenderCoverage(r, clip, FillRule::kEvenOdd);
  EXPECT(eo[1 * 4 + 1] == 0);
}

TEST(zero_length_leading_dash_draws_a_dot_at_the_start) {
  // setLineDash([0, 6]), round caps, width 4, from x = 4 to x = 60: HTML puts a point at the start, so Chrome draws
  // dots at x = 4, 10, ..., 58 (10 dots). Before, the first dot was at x = 10.
  Surface s;
  s.Resize(64, 20);
  Canvas c(&s);
  StrokeStyle st;
  st.width = 4;
  st.cap = LineCap::kRound;
  st.dash = {0, 6};
  StrokeLine(c, Matrix{}, 4, 10, 60, 10, st);
  EXPECT(Alpha(s, 3, 9) > 200 && Alpha(s, 4, 10) > 200);
  int dots = 0;
  for (int x = 1; x < 64; x++) dots += Alpha(s, x, 10) > 128 && Alpha(s, x - 1, 10) <= 128;
  EXPECT(dots == 10);
  // A non-zero offset that lands on the zero-length dash also starts with a dot.
  s.Clear();
  st.dash_offset = 6;
  StrokeLine(c, Matrix{}, 4, 10, 60, 10, st);
  EXPECT(Alpha(s, 4, 10) > 200);
}

TEST(colour_glyph_png_size_is_capped) {
  std::vector<uint8_t> rgba(64 * 32 * 4, 200), png, out;
  EXPECT(EncodePng(rgba.data(), 64, 32, &png));
  int w = 0, h = 0;
  EXPECT(!DecodePngPremultiplied(png.data(), png.size(), &w, &h, &out, 32));
  EXPECT(out.empty());
  EXPECT(DecodePngPremultiplied(png.data(), png.size(), &w, &h, &out, 64));
  EXPECT(w == 64 && h == 32 && out.size() == size_t(64) * 32 * 4);
}
