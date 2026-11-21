#include <vector>

#include "geometry.h"
#include "raster.h"
#include "test.h"

using namespace iwn::canvas2d;

namespace {
std::vector<uint8_t> Render(Rasterizer& r, int w, int h, FillRule rule = FillRule::kNonZero) {
  std::vector<uint8_t> out(w * h, 0);
  r.Sweep(rule, [&](int y, int x0, int x1, const uint8_t* cov) {
    for (int x = x0; x < x1; x++) out[y * w + x] = cov[x - x0];
  });
  return out;
}
void Rect(Rasterizer& r, double x0, double y0, double x1, double y1, bool reverse = false) {
  double p[] = {x0, y0, x1, y0, x1, y1, x0, y1};
  if (reverse) {
    double q[] = {x0, y0, x0, y1, x1, y1, x1, y0};
    r.AddPolygon(q, 4);
  } else {
    r.AddPolygon(p, 4);
  }
}
}  // namespace

TEST(raster_integer_rect_is_exact) {
  Rasterizer r;
  r.Reset({0, 0, 10, 10});
  Rect(r, 2, 3, 6, 7);
  auto px = Render(r, 10, 10);
  for (int y = 0; y < 10; y++)
    for (int x = 0; x < 10; x++) EXPECT(px[y * 10 + x] == ((x >= 2 && x < 6 && y >= 3 && y < 7) ? 255 : 0));
}

TEST(raster_half_pixel_edges) {
  Rasterizer r;
  r.Reset({0, 0, 10, 10});
  Rect(r, 2.5, 2, 5.5, 4);
  auto px = Render(r, 10, 10);
  EXPECT_NEAR(px[2 * 10 + 2], 128, 1);
  EXPECT(px[2 * 10 + 3] == 255);
  EXPECT_NEAR(px[2 * 10 + 5], 128, 1);
  EXPECT(px[2 * 10 + 6] == 0);
}

TEST(raster_orientation_independent_and_reverse_cancels) {
  Rasterizer r;
  r.Reset({0, 0, 10, 10});
  Rect(r, 1.3, 1.7, 7.9, 8.2, true);
  auto a = Render(r, 10, 10);
  r.Reset({0, 0, 10, 10});
  Rect(r, 1.3, 1.7, 7.9, 8.2, false);
  auto b = Render(r, 10, 10);
  EXPECT(a == b);
  r.Reset({0, 0, 10, 10});
  Rect(r, 1.3, 1.7, 7.9, 8.2, false);
  Rect(r, 1.3, 1.7, 7.9, 8.2, true);
  r.Finish();
  auto c = Render(r, 10, 10);
  for (uint8_t v : c) EXPECT(v == 0);
}

TEST(raster_fill_rules) {
  Rasterizer r;
  r.Reset({0, 0, 10, 10});
  Rect(r, 0, 0, 10, 10);
  Rect(r, 3, 3, 7, 7);  // same direction: winding 2 inside
  auto nz = Render(r, 10, 10, FillRule::kNonZero);
  r.Reset({0, 0, 10, 10});
  Rect(r, 0, 0, 10, 10);
  Rect(r, 3, 3, 7, 7);
  auto eo = Render(r, 10, 10, FillRule::kEvenOdd);
  EXPECT(nz[5 * 10 + 5] == 255);
  EXPECT(eo[5 * 10 + 5] == 0);
  EXPECT(eo[1 * 10 + 1] == 255);
}

TEST(raster_clips_left_and_right_exactly) {
  Rasterizer r;
  r.Reset({0, 0, 10, 4});
  Rect(r, -50, 0, 4, 2);    // extends far left
  Rect(r, 7, 2, 1000, 4);   // extends far right
  auto px = Render(r, 10, 4);
  for (int x = 0; x < 10; x++) {
    EXPECT(px[0 * 10 + x] == (x < 4 ? 255 : 0));
    EXPECT(px[3 * 10 + x] == (x >= 7 ? 255 : 0));
  }
}

TEST(raster_diagonal_area_is_half) {
  Rasterizer r;
  r.Reset({0, 0, 4, 4});
  double tri[] = {0, 0, 4, 0, 0, 4};
  r.AddPolygon(tri, 3);
  auto px = Render(r, 4, 4);
  int sum = 0;
  for (uint8_t v : px) sum += v;
  EXPECT_NEAR(sum / 255.0, 8.0, 0.05);  // area of the triangle
  EXPECT_NEAR(px[0 * 4 + 3], 128, 1);   // pixel cut by the diagonal through its corners
}

TEST(stroke_pieces_union_without_seams) {
  // A zigzag with miter joins: every pixel well inside the stroke must be fully covered.
  float path[] = {kVerbMove, 5, 5, kVerbLine, 25, 20, kVerbLine, 45, 5, kVerbLine, 65, 20};
  Rasterizer r;
  r.Reset({0, 0, 80, 30});
  StrokeParams sp;
  sp.width = 6;
  sp.join = LineJoin::kMiter;
  double a = StrokeToRasterizer(PathView{path, sizeof(path) / 4}, Matrix(), Matrix(), sp, &r);
  EXPECT(a == 1);
  auto px = Render(r, 80, 30);
  // Points on the centre line.
  EXPECT(px[12 * 80 + 15] == 255);
  EXPECT(px[20 * 80 + 25] == 255);
  EXPECT(px[12 * 80 + 35] == 255);
  EXPECT(px[5 * 80 + 45] == 255);
  EXPECT(px[28 * 80 + 2] == 0);
}

TEST(stroke_hairline_reduced_coverage) {
  float path[] = {kVerbMove, 0, 5.5f, kVerbLine, 10, 5.5f};
  Rasterizer r;
  r.Reset({0, 0, 10, 10});
  StrokeParams sp;
  sp.width = 0.25;
  double a = StrokeToRasterizer(PathView{path, sizeof(path) / 4}, Matrix(), Matrix(), sp, &r);
  EXPECT_NEAR(a, 0.25, 1e-9);
  auto px = Render(r, 10, 10);
  EXPECT(px[5 * 10 + 5] == 255);  // drawn 1px wide; the caller scales coverage by `a`
}

TEST(dash_pattern_gaps) {
  float path[] = {kVerbMove, 0, 5, kVerbLine, 40, 5};
  float dash[] = {5, 5};
  Rasterizer r;
  r.Reset({0, 0, 40, 10});
  StrokeParams sp;
  sp.width = 2;
  sp.dash = dash;
  sp.dash_count = 2;
  StrokeToRasterizer(PathView{path, sizeof(path) / 4}, Matrix(), Matrix(), sp, &r);
  auto px = Render(r, 40, 10);
  EXPECT(px[5 * 40 + 2] == 255);
  EXPECT(px[5 * 40 + 7] == 0);
  EXPECT(px[5 * 40 + 12] == 255);
}

TEST(point_in_path_rules) {
  float path[] = {kVerbMove, 0, 0, kVerbLine, 10, 0, kVerbLine, 10, 10, kVerbLine, 0, 10, kVerbClose,
                  kVerbMove, 2, 2, kVerbLine, 8, 2, kVerbLine, 8, 8, kVerbLine, 2, 8, kVerbClose};
  PathView pv{path, sizeof(path) / 4};
  EXPECT(PointInPath(pv, Matrix(), 5, 5, FillRule::kNonZero));
  EXPECT(!PointInPath(pv, Matrix(), 5, 5, FillRule::kEvenOdd));
  EXPECT(PointInPath(pv, Matrix(), 1, 1, FillRule::kEvenOdd));
  EXPECT(!PointInPath(pv, Matrix(), 11, 5, FillRule::kNonZero));
}
