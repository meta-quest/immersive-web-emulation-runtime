#include <vector>

#include "iwn/canvas2d/canvas.h"
#include "test.h"

using namespace iwn::canvas2d;

namespace {
struct Px {
  int r, g, b, a;
};
Px At(const Surface& s, int x, int y) {
  const uint8_t* p = s.Row(y) + 4 * x;
  return {p[0], p[1], p[2], p[3]};
}
Paint Solid(float r, float g, float b, float a) {
  Paint p;
  p.color = Color::FromUnpremultiplied(r, g, b, a);
  return p;
}
std::vector<float> RectPath(float x, float y, float w, float h) {
  return {kVerbMove, x, y, kVerbLine, x + w, y, kVerbLine, x + w, y + h, kVerbLine, x, y + h, kVerbClose};
}
}  // namespace

TEST(canvas_fill_rect_solid_and_alpha) {
  Surface s;
  EXPECT(s.Resize(20, 20));
  Canvas c(&s);
  auto r = RectPath(2, 2, 10, 10);
  DrawParams p;
  c.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, Solid(1, 0, 0, 1), p);
  Px a = At(s, 5, 5);
  EXPECT(a.r == 255 && a.g == 0 && a.a == 255);
  EXPECT(At(s, 15, 15).a == 0);
  p.global_alpha = 0.5f;
  auto r2 = RectPath(8, 8, 10, 10);
  c.Fill(PathView{r2.data(), r2.size()}, false, FillRule::kNonZero, Solid(0, 0, 1, 1), p);
  Px b = At(s, 10, 10);  // half blue over red
  EXPECT_NEAR(b.r, 127, 2);
  EXPECT_NEAR(b.b, 128, 2);
  EXPECT(b.a == 255);
  Px d = At(s, 15, 15);  // half blue over transparent (premultiplied)
  EXPECT_NEAR(d.b, 128, 1);
  EXPECT_NEAR(d.a, 128, 1);
}

TEST(canvas_transform_and_clear_rect) {
  Surface s;
  s.Resize(20, 20);
  Canvas c(&s);
  DrawParams p;
  auto r = RectPath(0, 0, 20, 20);
  c.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, Solid(0, 1, 0, 1), p);
  p.ctm = Matrix::Translate(5, 5) * Matrix::Scale(2, 2);
  c.ClearRect(0, 0, 2, 2, p);  // device (5,5)-(9,9)
  EXPECT(At(s, 6, 6).a == 0);
  EXPECT(At(s, 9, 9).a == 255);
  EXPECT(At(s, 4, 4).a == 255);
}

TEST(canvas_clip_restricts_drawing) {
  Surface s;
  s.Resize(20, 20);
  Canvas c(&s);
  DrawParams p;
  auto clip_path = RectPath(5, 5, 5, 5);
  auto mask = c.MakeClip(PathView{clip_path.data(), clip_path.size()}, false, FillRule::kNonZero, p.ctm, nullptr);
  p.clip = mask.get();
  auto r = RectPath(0, 0, 20, 20);
  c.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, Solid(1, 1, 1, 1), p);
  EXPECT(At(s, 7, 7).a == 255);
  EXPECT(At(s, 3, 3).a == 0);
  EXPECT(At(s, 12, 7).a == 0);
}

TEST(canvas_copy_clears_outside_shape) {
  Surface s;
  s.Resize(10, 10);
  Canvas c(&s);
  DrawParams p;
  auto all = RectPath(0, 0, 10, 10);
  c.Fill(PathView{all.data(), all.size()}, false, FillRule::kNonZero, Solid(1, 0, 0, 1), p);
  p.op = CompositeOp::kCopy;
  auto small = RectPath(2, 2, 2, 2);
  c.Fill(PathView{small.data(), small.size()}, false, FillRule::kNonZero, Solid(0, 0, 1, 0.5f), p);
  EXPECT(At(s, 8, 8).a == 0);
  Px in = At(s, 3, 3);
  EXPECT_NEAR(in.a, 128, 1);
  EXPECT_NEAR(in.b, 128, 1);
  EXPECT(in.r == 0);
}

TEST(canvas_image_data_round_trip) {
  Surface s;
  s.Resize(4, 4);
  Canvas c(&s);
  std::vector<uint8_t> data(4 * 4 * 4);
  for (size_t i = 0; i < data.size(); i += 4) {
    data[i] = 200, data[i + 1] = 100, data[i + 2] = 50, data[i + 3] = 255;
  }
  data[3] = 128;
  c.PutImageData(data.data(), 4, 4, 0, 0, 0, 0, 4, 4);
  std::vector<uint8_t> out(4 * 4 * 4);
  c.GetImageData(0, 0, 4, 4, out.data());
  EXPECT(out[4] == 200 && out[5] == 100 && out[6] == 50 && out[7] == 255);
  EXPECT_NEAR(out[0], 200, 2);
  EXPECT(out[3] == 128);
  // Out-of-bounds reads are transparent black; dirty rect limits writes.
  std::vector<uint8_t> o2(2 * 2 * 4);
  c.GetImageData(3, 3, 2, 2, o2.data());
  EXPECT(o2[3] == 255 && o2[7] == 0);
}

TEST(canvas_linear_gradient_ends) {
  Surface s;
  s.Resize(100, 4);
  Canvas c(&s);
  double gp[6] = {0, 0, 100, 0, 0, 0};
  Gradient g(Gradient::Kind::kLinear, gp);
  g.AddStop(0, 1, 0, 0, 1);
  g.AddStop(1, 0, 0, 1, 1);
  Paint paint;
  paint.kind = Paint::Kind::kGradient;
  paint.gradient = &g;
  auto r = RectPath(0, 0, 100, 4);
  DrawParams p;
  c.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, paint, p);
  EXPECT(At(s, 0, 1).r > 250);
  EXPECT(At(s, 99, 1).b > 250);
  EXPECT_NEAR(At(s, 50, 1).r, 127, 3);
}

TEST(canvas_draw_image_scaled_nearest) {
  Surface src;
  src.Resize(2, 2);
  uint8_t* d = src.data();
  const uint8_t colors[4][4] = {{255, 0, 0, 255}, {0, 255, 0, 255}, {0, 0, 255, 255}, {255, 255, 255, 255}};
  for (int i = 0; i < 4; i++)
    for (int k = 0; k < 4; k++) d[4 * i + k] = colors[i][k];
  Surface s;
  s.Resize(8, 8);
  Canvas c(&s);
  DrawParams p;
  p.smoothing = false;
  c.DrawImage(src.View(), 0, 0, 2, 2, 0, 0, 8, 8, p);
  EXPECT(At(s, 1, 1).r == 255 && At(s, 1, 1).g == 0);
  EXPECT(At(s, 6, 1).g == 255);
  EXPECT(At(s, 1, 6).b == 255);
  EXPECT(At(s, 6, 6).r == 255 && At(s, 6, 6).g == 255);
}

TEST(canvas_shadow_offsets) {
  Surface s;
  s.Resize(30, 30);
  Canvas c(&s);
  DrawParams p;
  p.shadow.color = Color{0, 0, 0, 1};
  p.shadow.offset_x = 10;
  p.shadow.offset_y = 10;
  auto r = RectPath(2, 2, 6, 6);
  c.Fill(PathView{r.data(), r.size()}, false, FillRule::kNonZero, Solid(1, 0, 0, 1), p);
  EXPECT(At(s, 4, 4).r == 255);
  Px sh = At(s, 14, 14);
  EXPECT(sh.a == 255 && sh.r == 0);
}

TEST(canvas_encode_png) {
  Surface s;
  s.Resize(3, 2);
  std::vector<uint8_t> png;
  std::string mime;
  EXPECT(EncodeImage(s, "image/png", 0, &png, &mime));
  EXPECT(mime == "image/png");
  EXPECT(png.size() > 8 && png[1] == 'P' && png[2] == 'N' && png[3] == 'G');
  EXPECT(EncodeImage(s, "image/jpeg", 0.8, &png, &mime));
  EXPECT(mime == "image/jpeg" && png[0] == 0xFF && png[1] == 0xD8);
}
