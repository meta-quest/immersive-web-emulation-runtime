#include <string>
#include <vector>

#include "iwn/canvas2d/text.h"
#include "test.h"

using namespace iwn::canvas2d;

namespace {
std::shared_ptr<Face> LoadFont(const char* file) {
  auto bytes = FontBytes::MapFile(std::string(IWN_C2D_FONT_DIR) + "/" + file);
  std::string err;
  auto f = bytes ? Face::Load(bytes, 0, &err) : nullptr;
  if (!f) std::fprintf(stderr, "  cannot load %s: %s\n", file, err.c_str());
  return f;
}
std::shared_ptr<Font> MakeFont(std::shared_ptr<Face> face, double size) {
  FontDesc d;
  d.faces.push_back(FaceRef{face, false, false});
  d.size = size;
  d.use_system_fallback = false;
  return std::make_shared<Font>(d);
}
}  // namespace

TEST(face_loads_names_and_metrics) {
  auto f = LoadFont("Roboto-Regular.ttf");
  EXPECT(f != nullptr);
  if (!f) return;
  EXPECT(f->family() == "Roboto");
  EXPECT(f->weight() == 400);
  EXPECT(!f->italic());
  EXPECT(f->units_per_em() > 0);
  EXPECT(f->GlyphFor('A') != 0);
  EXPECT(f->GlyphFor(0x0416) != 0);  // Cyrillic Zhe
  EXPECT(f->GlyphFor(0x03A9) != 0);  // Greek Omega
  auto b = LoadFont("Roboto-Bold.ttf");
  EXPECT(b && b->weight() == 700);
}

TEST(face_rejects_garbage) {
  std::vector<uint8_t> junk(100, 7);
  std::string err;
  auto f = Face::Load(FontBytes::Copy(junk.data(), junk.size()), 0, &err);
  EXPECT(f == nullptr);
  EXPECT(!err.empty());
}

TEST(shape_and_measure_latin) {
  auto f = LoadFont("Roboto-Regular.ttf");
  if (!f) return;
  auto font = MakeFont(f, 48);
  TextMetricsResult m;
  font->Measure(u"Ag Showcase 123", TextAlign::kStart, TextBaseline::kAlphabetic, TextDirection::kLtr, &m);
  EXPECT(m.width > 48 * 5 && m.width < 48 * 10);
  EXPECT(m.actual_ascent > 30 && m.actual_ascent < 40);  // cap height ~0.71 em
  EXPECT(m.actual_descent > 5 && m.actual_descent < 15);  // 'g' descender
  EXPECT(m.font_ascent > m.actual_ascent);
  EXPECT_NEAR(m.alphabetic, 0, 1e-9);
  EXPECT(m.hanging > 0 && m.ideographic < 0);
  TextMetricsResult c;
  font->Measure(u"Ag Showcase 123", TextAlign::kCenter, TextBaseline::kTop, TextDirection::kLtr, &c);
  EXPECT_NEAR(c.actual_left + c.actual_right, m.actual_left + m.actual_right, 1e-6);
  EXPECT(c.actual_ascent < 2);  // the ink top is at or below the em-box top
}

TEST(draw_text_produces_ink_where_measured) {
  auto f = LoadFont("Roboto-Regular.ttf");
  if (!f) return;
  auto font = MakeFont(f, 24);
  Surface s;
  s.Resize(200, 40);
  Canvas c(&s);
  Paint p;
  p.color = Color{0, 0, 0, 1};
  DrawParams dp;
  font->Draw(&c, u"Hello", 10, 30, NAN, TextAlign::kLeft, TextBaseline::kAlphabetic, TextDirection::kLtr, nullptr, p,
             dp);
  TextMetricsResult m;
  font->Measure(u"Hello", TextAlign::kLeft, TextBaseline::kAlphabetic, TextDirection::kLtr, &m);
  int minx = 1000, maxx = -1, miny = 1000, maxy = -1;
  for (int y = 0; y < 40; y++)
    for (int x = 0; x < 200; x++)
      if (s.Row(y)[4 * x + 3] > 64) {
        minx = std::min(minx, x), maxx = std::max(maxx, x), miny = std::min(miny, y), maxy = std::max(maxy, y);
      }
  EXPECT(maxx > 0);
  EXPECT_NEAR(minx, 10 - m.actual_left, 1.5);
  EXPECT_NEAR(maxx + 1, 10 + m.actual_right, 1.5);
  EXPECT_NEAR(miny, 30 - m.actual_ascent, 1.5);
}

TEST(max_width_condenses) {
  auto f = LoadFont("Roboto-Regular.ttf");
  if (!f) return;
  auto font = MakeFont(f, 24);
  Surface s;
  s.Resize(200, 40);
  Canvas c(&s);
  Paint p;
  p.color = Color{0, 0, 0, 1};
  DrawParams dp;
  font->Draw(&c, u"Hello world", 0, 30, 40, TextAlign::kLeft, TextBaseline::kAlphabetic, TextDirection::kLtr, nullptr,
             p, dp);
  int maxx = -1;
  for (int y = 0; y < 40; y++)
    for (int x = 0; x < 200; x++)
      if (s.Row(y)[4 * x + 3]) maxx = std::max(maxx, x);
  EXPECT(maxx > 20 && maxx <= 41);
}

TEST(fonts_xml_parse) {
  const char* xml = R"(<?xml version="1.0" encoding="utf-8"?>
<!-- sample -->
<familyset version="23">
  <family name="sans-serif">
    <font weight="400" style="normal">Roboto-Regular.ttf
      <axis tag="wght" stylevalue="400" />
    </font>
    <font weight="700" style="italic" index="1">Roboto-BoldItalic.ttf</font>
  </family>
  <alias name="arial" to="sans-serif" />
  <alias name="sans-serif-medium" to="sans-serif" weight="500" />
  <family lang="und-Zsye">
    <font weight="400" style="normal">NotoColorEmoji.ttf</font>
  </family>
  <family lang="und-Arab" variant="elegant">
    <font weight="400" style="normal" fallbackFor="serif">NotoNaskhArabic-Regular.ttf</font>
  </family>
</familyset>)";
  FontsXml out;
  std::string err;
  EXPECT(ParseFontsXml(xml, &out, &err));
  EXPECT(out.families.size() == 3);
  if (out.families.size() == 3) {
    EXPECT(out.families[0].name == "sans-serif");
    EXPECT(out.families[0].fonts.size() == 2);
    EXPECT(out.families[0].fonts[0].file == "Roboto-Regular.ttf");
    EXPECT(out.families[0].fonts[1].italic && out.families[0].fonts[1].weight == 700 &&
           out.families[0].fonts[1].index == 1);
    EXPECT(out.families[1].lang == "und-Zsye" && out.families[1].name.empty());
    EXPECT(out.families[2].fonts[0].fallback_for == "serif");
  }
  EXPECT(out.aliases.size() == 2);
  FontsXml bad;
  EXPECT(!ParseFontsXml("<family>", &bad, &err));
}

TEST(system_fallback_chain) {
  // Fallback family = Roboto Mono; primary face list empty -> characters come from the fallback chain.
  FontsXml xml;
  FontsXmlFamily fam;
  FontsXmlFont font;
  font.file = "RobotoMono-Regular.ttf";
  fam.fonts.push_back(font);
  xml.families.push_back(fam);
  FontRegistry::Get().ConfigureSystemFontsFromXml(xml, IWN_C2D_FONT_DIR);
  FontDesc d;
  d.size = 20;
  Font f(d);
  ShapedText st;
  f.Shape(u"abc", TextDirection::kLtr, &st);
  EXPECT(st.glyphs.size() == 3);
  if (!st.glyphs.empty()) EXPECT(st.glyphs[0].face->family() == "Roboto Mono");
  EXPECT_NEAR(st.advance, 3 * 0.6 * 20, 0.5);  // Roboto Mono advance is 0.6 em
}
