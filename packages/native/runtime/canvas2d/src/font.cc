// Font faces over FreeType (outlines, names, metrics, COLR v0) and HarfBuzz (cmap, shaping); CBDT colour strikes
// parsed here from the OpenType CBLC/CBDT table formats and decoded with stb_image.

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>
#include <fstream>
#include <sstream>

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include FT_BBOX_H
#include FT_TRUETYPE_TABLES_H
#include FT_TRUETYPE_TAGS_H
#include FT_MULTIPLE_MASTERS_H
#include FT_COLOR_H

#include <hb-ot.h>
#include <hb.h>

#include "codec.h"
#include "font_internal.h"
#include "iwn/canvas2d/text.h"

namespace iwn::canvas2d {

std::mutex& FtMutex() {
  static std::mutex m;
  return m;
}

FT_Library FtLibrary() {
  static FT_Library lib = [] {
    FT_Library l = nullptr;
    if (FT_Init_FreeType(&l) != 0) return static_cast<FT_Library>(nullptr);
    return l;
  }();
  return lib;
}

namespace {

inline uint32_t Be32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
inline uint16_t Be16(const uint8_t* p) { return static_cast<uint16_t>((p[0] << 8) | p[1]); }
constexpr uint32_t Tag(char a, char b, char c, char d) {
  return (uint32_t(uint8_t(a)) << 24) | (uint32_t(uint8_t(b)) << 16) | (uint32_t(uint8_t(c)) << 8) | uint8_t(d);
}

// Finds a table in an uncompressed sfnt or collection.
bool FindTable(const uint8_t* d, size_t n, int index, uint32_t tag, const uint8_t** out, size_t* len) {
  if (n < 12) return false;
  size_t base = 0;
  if (Be32(d) == Tag('t', 't', 'c', 'f')) {
    if (n < 16) return false;
    uint32_t count = Be32(d + 8);
    if (index < 0 || static_cast<uint32_t>(index) >= count || 12 + 4 * size_t(index) + 4 > n) return false;
    base = Be32(d + 12 + 4 * index);
  }
  if (base + 12 > n) return false;
  uint16_t num = Be16(d + base + 4);
  if (base + 12 + size_t(num) * 16 > n) return false;
  for (uint16_t i = 0; i < num; i++) {
    const uint8_t* r = d + base + 12 + size_t(i) * 16;
    if (Be32(r) == tag) {
      size_t off = Be32(r + 8), l = Be32(r + 12);
      if (off > n || l > n - off) return false;
      *out = d + off;
      *len = l;
      return true;
    }
  }
  return false;
}

struct DecomposeCtx {
  std::vector<float>* path;
  bool open = false;
};

int MoveTo(const FT_Vector* to, void* user) {
  auto* c = static_cast<DecomposeCtx*>(user);
  if (c->open) c->path->push_back(kVerbClose);
  c->path->insert(c->path->end(), {float(kVerbMove), to->x / 64.0f, to->y / 64.0f});
  c->open = true;
  return 0;
}
int LineTo(const FT_Vector* to, void* user) {
  auto* c = static_cast<DecomposeCtx*>(user);
  c->path->insert(c->path->end(), {float(kVerbLine), to->x / 64.0f, to->y / 64.0f});
  return 0;
}
int ConicTo(const FT_Vector* ctl, const FT_Vector* to, void* user) {
  auto* c = static_cast<DecomposeCtx*>(user);
  c->path->insert(c->path->end(), {float(kVerbQuad), ctl->x / 64.0f, ctl->y / 64.0f, to->x / 64.0f, to->y / 64.0f});
  return 0;
}
int CubicTo(const FT_Vector* c1, const FT_Vector* c2, const FT_Vector* to, void* user) {
  auto* c = static_cast<DecomposeCtx*>(user);
  c->path->insert(c->path->end(), {float(kVerbCubic), c1->x / 64.0f, c1->y / 64.0f, c2->x / 64.0f, c2->y / 64.0f,
                                   to->x / 64.0f, to->y / 64.0f});
  return 0;
}

double StretchFromWidthClass(int wc) {
  static const double kMap[] = {100, 50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200};
  return (wc >= 1 && wc <= 9) ? kMap[wc] : 100;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------------
// FontBytes

std::shared_ptr<FontBytes> FontBytes::Copy(const uint8_t* data, size_t size) {
  std::shared_ptr<FontBytes> b(new FontBytes());
  b->owned_.assign(data, data + size);
  b->data_ = b->owned_.data();
  b->size_ = size;
  return b;
}

std::shared_ptr<FontBytes> FontBytes::MapFile(const std::string& path) {
  int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) return nullptr;
  struct stat st;
  if (fstat(fd, &st) != 0 || st.st_size <= 0) {
    close(fd);
    return nullptr;
  }
  size_t size = static_cast<size_t>(st.st_size);
  void* p = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
  close(fd);
  if (p == MAP_FAILED) return nullptr;
  std::shared_ptr<FontBytes> b(new FontBytes());
  b->map_ = p;
  b->map_size_ = size;
  b->data_ = static_cast<const uint8_t*>(p);
  b->size_ = size;
  return b;
}

std::shared_ptr<FontBytes> FontBytes::Borrow(std::shared_ptr<const void> owner, const uint8_t* data, size_t size) {
  std::shared_ptr<FontBytes> b(new FontBytes());
  b->owner_ = std::move(owner);
  b->data_ = data;
  b->size_ = size;
  return b;
}

FontBytes::~FontBytes() {
  if (map_) munmap(map_, map_size_);
}

// ---------------------------------------------------------------------------------------------------------------
// Face

std::shared_ptr<Face> Face::Load(std::shared_ptr<FontBytes> bytes, int index, std::string* error) {
  if (!bytes || bytes->size() == 0) {
    if (error) *error = "empty font data";
    return nullptr;
  }
  std::shared_ptr<Face> f(new Face());
  f->bytes_ = std::move(bytes);
  f->index_ = index;
  std::string err;
  if (!f->Init(&err)) {
    if (error) *error = err;
    return nullptr;
  }
  f->self_ = f;
  return f;
}

Face::~Face() {
  if (hb_font_) hb_font_destroy(hb_font_);
  if (ft_) {
    std::lock_guard<std::mutex> lock(FtMutex());
    FT_Done_Face(ft_);
  }
}

bool Face::Init(std::string* error) {
  std::lock_guard<std::mutex> lock(FtMutex());
  FT_Library lib = FtLibrary();
  if (!lib) {
    *error = "FreeType failed to initialise";
    return false;
  }
  FT_Error e = FT_New_Memory_Face(lib, bytes_->data(), static_cast<FT_Long>(bytes_->size()), index_, &ft_);
  if (e != 0 || !ft_) {
    ft_ = nullptr;
    *error = "unsupported or corrupt font data (FreeType error " + std::to_string(e) + ")";
    return false;
  }
  num_faces_ = static_cast<int>(ft_->num_faces);
  upem_ = ft_->units_per_EM > 0 ? ft_->units_per_EM : 1000;
  if (FT_IS_SCALABLE(ft_)) FT_Set_Char_Size(ft_, FT_F26Dot6(upem_) * 64, 0, 72, 72);
  family_ = ft_->family_name ? ft_->family_name : "";
  style_name_ = ft_->style_name ? ft_->style_name : "";
  italic_ = (ft_->style_flags & FT_STYLE_FLAG_ITALIC) != 0;
  weight_ = (ft_->style_flags & FT_STYLE_FLAG_BOLD) ? 700 : 400;
  ascent_ = ft_->ascender;
  descent_ = -static_cast<double>(ft_->descender);
  auto* os2 = static_cast<TT_OS2*>(FT_Get_Sfnt_Table(ft_, FT_SFNT_OS2));
  if (os2 && os2->version != 0xFFFF) {
    int w = os2->usWeightClass;
    if (w >= 1 && w <= 9) w *= 100;
    if (w >= 1 && w <= 1000) weight_ = w;
    stretch_ = StretchFromWidthClass(os2->usWidthClass);
    typo_ascent_ = os2->sTypoAscender;
    typo_descent_ = -static_cast<double>(os2->sTypoDescender);
    if (os2->fsSelection & 1) italic_ = true;
  }
  if (ascent_ == 0 && descent_ == 0) {
    ascent_ = typo_ascent_ != 0 ? typo_ascent_ : upem_ * 0.8;
    descent_ = typo_descent_ != 0 ? typo_descent_ : upem_ * 0.2;
  }
  if (typo_ascent_ == 0 && typo_descent_ == 0) {
    typo_ascent_ = ascent_;
    typo_descent_ = descent_;
  }
  if (FT_HAS_MULTIPLE_MASTERS(ft_)) {
    FT_MM_Var* mm = nullptr;
    if (FT_Get_MM_Var(ft_, &mm) == 0 && mm) {
      for (FT_UInt i = 0; i < mm->num_axis; i++) {
        if (mm->axis[i].tag == FT_MAKE_TAG('w', 'g', 'h', 't')) {
          wght_axis_ = static_cast<int>(i);
          wght_min_ = mm->axis[i].minimum / 65536.0f;
          wght_max_ = mm->axis[i].maximum / 65536.0f;
          wght_default_ = mm->axis[i].def / 65536.0f;
        }
      }
      FT_Done_MM_Var(lib, mm);
    }
  }
  FT_ULong len = 0;
  has_colr_ = FT_Load_Sfnt_Table(ft_, TTAG_COLR, 0, nullptr, &len) == 0 && len > 0;
  len = 0;
  has_cbdt_ = FT_Load_Sfnt_Table(ft_, TTAG_CBDT, 0, nullptr, &len) == 0 && len > 0;

  // HarfBuzz reads the sfnt directly. WOFF/WOFF2 data is decompressed by FreeType into its own memory stream.
  const uint8_t* sfnt = bytes_->data();
  size_t sfnt_size = bytes_->size();
  int hb_index = index_;
  uint32_t sig = bytes_->size() >= 4 ? Be32(bytes_->data()) : 0;
  if (sig == Tag('w', 'O', 'F', 'F') || sig == Tag('w', 'O', 'F', '2')) {
    if (ft_->stream && ft_->stream->base) {
      sfnt = ft_->stream->base;
      sfnt_size = ft_->stream->size;
      hb_index = 0;
    }
  }
  hb_blob_t* blob =
      hb_blob_create(reinterpret_cast<const char*>(sfnt), static_cast<unsigned>(sfnt_size), HB_MEMORY_MODE_READONLY,
                     nullptr, nullptr);
  hb_face_t* hface = hb_face_create(blob, static_cast<unsigned>(hb_index));
  hb_blob_destroy(blob);
  hb_font_ = hb_font_create(hface);
  hb_face_destroy(hface);
  hb_font_set_scale(hb_font_, upem_, upem_);

  if (has_cbdt_) {
    const uint8_t* p;
    size_t n;
    if (FindTable(sfnt, sfnt_size, hb_index, Tag('C', 'B', 'L', 'C'), &p, &n)) cblc_ = TableView{p, n};
    if (FindTable(sfnt, sfnt_size, hb_index, Tag('C', 'B', 'D', 'T'), &p, &n)) cbdt_ = TableView{p, n};
    ParseCbdtIndex();
  }
  return true;
}

uint32_t Face::GlyphFor(uint32_t cp, uint32_t vs) const {
  hb_codepoint_t g = 0;
  if (vs && hb_font_get_variation_glyph(hb_font_, cp, vs, &g)) return g;
  if (hb_font_get_nominal_glyph(hb_font_, cp, &g)) return g;
  return 0;
}

std::shared_ptr<const GlyphOutline> Face::Outline(uint32_t glyph, int embolden_1024) {
  const bool bold = embolden_1024 > 0;
  uint64_t key = uint64_t(glyph) | (uint64_t(embolden_1024 & 0xFFFF) << 32);
  std::lock_guard<std::mutex> cl(cache_mutex_);
  std::shared_ptr<const GlyphOutline> hit;
  if (outlines_.Get(key, &hit) && hit) return hit;
  auto out = std::make_shared<GlyphOutline>();
  {
    std::lock_guard<std::mutex> lock(FtMutex());
    if (FT_IS_SCALABLE(ft_) &&
        FT_Load_Glyph(ft_, glyph, FT_LOAD_NO_HINTING | FT_LOAD_NO_BITMAP | FT_LOAD_IGNORE_TRANSFORM) == 0 &&
        ft_->glyph->format == FT_GLYPH_FORMAT_OUTLINE && ft_->glyph->outline.n_points > 0) {
      FT_Outline* o = &ft_->glyph->outline;
      if (bold) {
        // FreeType grows the outline right and up (left/bottom stay); browsers' synthetic bold grows it evenly.
        FT_Pos strength = FT_Pos(upem_) * 64 * embolden_1024 / 1024;
        FT_Outline_Embolden(o, strength);
        FT_Outline_Translate(o, -strength / 2, -strength / 2);
      }
      FT_BBox bb;
      FT_Outline_Get_BBox(o, &bb);
      out->x_min = bb.xMin / 64.0f;
      out->y_min = bb.yMin / 64.0f;
      out->x_max = bb.xMax / 64.0f;
      out->y_max = bb.yMax / 64.0f;
      FT_Outline_Funcs funcs = {MoveTo, LineTo, ConicTo, CubicTo, 0, 0};
      DecomposeCtx ctx{&out->path, false};
      FT_Outline_Decompose(o, &funcs, &ctx);
      if (ctx.open) out->path.push_back(kVerbClose);
      out->empty = out->path.empty();
    }
  }
  outlines_.Put(key, out, sizeof(GlyphOutline) + 64 + out->path.capacity() * sizeof(float));
  return out;
}

size_t Face::CacheBytes() {
  std::lock_guard<std::mutex> cl(cache_mutex_);
  return outlines_.bytes() + bitmaps_.bytes();
}

// CBLC: pick the largest strike. Table layout per the OpenType CBLC/CBDT specification.
void Face::ParseCbdtIndex() {
  strike_ = -1;
  if (cblc_.size() < 8 || cbdt_.empty()) return;
  uint32_t num = Be32(cblc_.data() + 4);
  int best_ppem = -1;
  for (uint32_t i = 0; i < num; i++) {
    size_t rec = 8 + size_t(i) * 48;
    if (rec + 48 > cblc_.size()) break;
    int ppem = cblc_[rec + 45];
    if (ppem > best_ppem) {
      best_ppem = ppem;
      strike_ = static_cast<int>(i);
    }
  }
}

std::shared_ptr<const ColorBitmap> Face::Bitmap(uint32_t glyph) {
  if (strike_ < 0) return nullptr;
  std::lock_guard<std::mutex> cl(cache_mutex_);
  std::shared_ptr<const ColorBitmap> hit;
  if (bitmaps_.Get(glyph, &hit)) return hit;
  std::unique_ptr<ColorBitmap> result;
  const uint8_t* L = cblc_.data();
  size_t Ln = cblc_.size();
  size_t rec = 8 + size_t(strike_) * 48;
  uint32_t array_off = Be32(L + rec);
  uint32_t num_sub = Be32(L + rec + 8);
  uint16_t start = Be16(L + rec + 40), end = Be16(L + rec + 42);
  int ppem = L[rec + 45];
  auto decode = [&](size_t img_off, size_t img_len, int format, const uint8_t* big_metrics) {
    const uint8_t* D = cbdt_.data();
    size_t Dn = cbdt_.size();
    if (img_off > Dn || img_len > Dn - img_off) return;
    const uint8_t* p = D + img_off;
    size_t n = img_len;
    int bx = 0, by = 0;
    size_t hdr;
    if (format == 17) {
      if (n < 9) return;
      bx = static_cast<int8_t>(p[2]);
      by = static_cast<int8_t>(p[3]);
      hdr = 5;
    } else if (format == 18) {
      if (n < 12) return;
      bx = static_cast<int8_t>(p[2]);
      by = static_cast<int8_t>(p[3]);
      hdr = 8;
    } else if (format == 19) {
      if (!big_metrics || n < 4) return;
      bx = static_cast<int8_t>(big_metrics[2]);
      by = static_cast<int8_t>(big_metrics[3]);
      hdr = 0;
    } else {
      return;
    }
    uint32_t data_len = Be32(p + hdr);
    if (hdr + 4 > n || data_len > n - hdr - 4) return;
    int w = 0, h = 0;
    auto img = std::make_shared<OwnedImage>();
    // Strikes are glyph-sized (NotoColorEmoji: 136 x 128); the cap bounds what a crafted font (FontFace(url())) can
    // make one glyph allocate: the decode, its premultiplied copy and the mips.
    constexpr int kMaxStrikeDim = 1024;
    if (!DecodePngPremultiplied(p + hdr + 4, data_len, &w, &h, &img->pixels, kMaxStrikeDim)) return;
    img->width = w;
    img->height = h;
    result = std::make_unique<ColorBitmap>();
    result->image = img;
    result->ppem = static_cast<float>(ppem);
    result->bearing_x = static_cast<float>(bx);
    result->bearing_y = static_cast<float>(by);
    // Mip chain down to ~4 px: each level averages 2x2 premultiplied pixels (edge pixels of odd sizes repeat).
    const OwnedImage* prev = img.get();
    while (prev->width > 4 || prev->height > 4) {
      auto m = std::make_shared<OwnedImage>();
      m->width = (prev->width + 1) / 2;
      m->height = (prev->height + 1) / 2;
      m->pixels.resize(static_cast<size_t>(m->width) * m->height * 4);
      for (int y = 0; y < m->height; y++) {
        int y0 = std::min(2 * y, prev->height - 1), y1 = std::min(2 * y + 1, prev->height - 1);
        for (int x = 0; x < m->width; x++) {
          int x0 = std::min(2 * x, prev->width - 1), x1 = std::min(2 * x + 1, prev->width - 1);
          const uint8_t* a = &prev->pixels[(static_cast<size_t>(y0) * prev->width + x0) * 4];
          const uint8_t* b = &prev->pixels[(static_cast<size_t>(y0) * prev->width + x1) * 4];
          const uint8_t* c = &prev->pixels[(static_cast<size_t>(y1) * prev->width + x0) * 4];
          const uint8_t* d = &prev->pixels[(static_cast<size_t>(y1) * prev->width + x1) * 4];
          uint8_t* o = &m->pixels[(static_cast<size_t>(y) * m->width + x) * 4];
          for (int ch = 0; ch < 4; ch++) o[ch] = static_cast<uint8_t>((a[ch] + b[ch] + c[ch] + d[ch] + 2) / 4);
        }
      }
      result->mips.push_back(m);
      prev = m.get();
    }
  };
  if (glyph >= start && glyph <= end) {
    for (uint32_t s = 0; s < num_sub && !result; s++) {
      size_t e = size_t(array_off) + size_t(s) * 8;
      if (e + 8 > Ln) break;
      uint16_t first = Be16(L + e), last = Be16(L + e + 2);
      if (glyph < first || glyph > last) continue;
      size_t sub = size_t(array_off) + Be32(L + e + 4);
      if (sub + 8 > Ln) break;
      uint16_t index_format = Be16(L + sub);
      uint16_t image_format = Be16(L + sub + 2);
      uint32_t image_data = Be32(L + sub + 4);
      size_t body = sub + 8;
      uint32_t g = glyph - first;
      switch (index_format) {
        case 1: {
          if (body + (size_t(g) + 2) * 4 > Ln) break;
          uint32_t o0 = Be32(L + body + g * 4), o1 = Be32(L + body + (g + 1) * 4);
          if (o1 > o0) decode(size_t(image_data) + o0, o1 - o0, image_format, nullptr);
          break;
        }
        case 2: {
          if (body + 12 > Ln) break;
          uint32_t size = Be32(L + body);
          decode(size_t(image_data) + size_t(g) * size, size, image_format, L + body + 4);
          break;
        }
        case 3: {
          if (body + (size_t(g) + 2) * 2 > Ln) break;
          uint32_t o0 = Be16(L + body + g * 2), o1 = Be16(L + body + (g + 1) * 2);
          if (o1 > o0) decode(size_t(image_data) + o0, o1 - o0, image_format, nullptr);
          break;
        }
        case 4: {
          if (body + 4 > Ln) break;
          uint32_t count = Be32(L + body);
          if (body + 4 + (size_t(count) + 1) * 4 > Ln) break;
          for (uint32_t k = 0; k < count; k++) {
            const uint8_t* pr = L + body + 4 + size_t(k) * 4;
            if (Be16(pr) == glyph) {
              uint32_t o0 = Be16(pr + 2), o1 = Be16(pr + 6);
              if (o1 > o0) decode(size_t(image_data) + o0, o1 - o0, image_format, nullptr);
              break;
            }
          }
          break;
        }
        case 5: {
          if (body + 16 > Ln) break;
          uint32_t size = Be32(L + body);
          uint32_t count = Be32(L + body + 12);
          if (body + 16 + size_t(count) * 2 > Ln) break;
          for (uint32_t k = 0; k < count; k++) {
            if (Be16(L + body + 16 + size_t(k) * 2) == glyph) {
              decode(size_t(image_data) + size_t(k) * size, size, image_format, L + body + 4);
              break;
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }
  size_t bytes = sizeof(ColorBitmap) + 64;
  if (result) {
    auto img_bytes = [](const std::shared_ptr<OwnedImage>& im) { return im ? im->pixels.capacity() + sizeof(OwnedImage) : 0; };
    bytes += img_bytes(result->image);
    for (const auto& m : result->mips) bytes += img_bytes(m);
  }
  std::shared_ptr<const ColorBitmap> ptr(std::move(result));
  bitmaps_.Put(glyph, ptr, bytes);
  return ptr;
}

bool Face::ColorLayers(uint32_t glyph, std::vector<ColorLayer>* layers) {
  layers->clear();
  if (!has_colr_) return false;
  std::lock_guard<std::mutex> lock(FtMutex());
  FT_Color* palette = nullptr;
  FT_Palette_Data pd;
  if (FT_Palette_Data_Get(ft_, &pd) == 0 && pd.num_palettes > 0) FT_Palette_Select(ft_, 0, &palette);
  FT_LayerIterator it;
  it.p = nullptr;
  FT_UInt layer_glyph = 0, color_index = 0;
  while (FT_Get_Color_Glyph_Layer(ft_, glyph, &layer_glyph, &color_index, &it)) {
    ColorLayer l;
    l.glyph = layer_glyph;
    if (color_index == 0xFFFF || !palette || color_index >= pd.num_palette_entries) {
      l.use_foreground = true;
    } else {
      const FT_Color& c = palette[color_index];
      float a = c.alpha / 255.0f;
      l.color = Color{c.red / 255.0f * a, c.green / 255.0f * a, c.blue / 255.0f * a, a};
    }
    layers->push_back(l);
  }
  return !layers->empty();
}

std::shared_ptr<Face> Face::WeightInstance(float wght) {
  if (wght_axis_ < 0) return self_.lock();
  wght = std::clamp(wght, wght_min_, wght_max_);
  if (wght == wght_default_ && wght_value_ == 0) return self_.lock();
  int key = static_cast<int>(std::lround(wght));
  std::lock_guard<std::mutex> cl(cache_mutex_);
  auto it = instances_.find(key);
  if (it != instances_.end()) {
    if (auto f = it->second.lock()) return f;
  }
  std::string err;
  auto inst = Load(bytes_, index_, &err);
  if (!inst) return self_.lock();
  {
    std::lock_guard<std::mutex> lock(FtMutex());
    FT_MM_Var* mm = nullptr;
    if (FT_Get_MM_Var(inst->ft_, &mm) == 0 && mm) {
      std::vector<FT_Fixed> coords(mm->num_axis);
      for (FT_UInt i = 0; i < mm->num_axis; i++) coords[i] = mm->axis[i].def;
      coords[wght_axis_] = static_cast<FT_Fixed>(std::lround(wght * 65536.0));
      FT_Set_Var_Design_Coordinates(inst->ft_, mm->num_axis, coords.data());
      FT_Done_MM_Var(FtLibrary(), mm);
    }
  }
  hb_variation_t var{HB_TAG('w', 'g', 'h', 't'), wght};
  hb_font_set_variations(inst->hb_font_, &var, 1);
  inst->wght_value_ = wght;
  inst->weight_ = key;
  instances_[key] = inst;
  return inst;
}

// ---------------------------------------------------------------------------------------------------------------
// FontRegistry

FontRegistry& FontRegistry::Get() {
  static FontRegistry* r = new FontRegistry();
  return *r;
}

void FontRegistry::SetAssetReader(AssetReader reader) {
  std::lock_guard<std::mutex> l(mutex_);
  asset_reader_ = std::move(reader);
  defaults_loaded_ = false;
  defaults_.clear();
}

std::shared_ptr<FontBytes> FontRegistry::ReadAsset(const std::string& name) {
  AssetReader r;
  {
    std::lock_guard<std::mutex> l(mutex_);
    r = asset_reader_;
  }
  return r ? r(name) : nullptr;
}

std::vector<FontRegistry::DefaultFace> FontRegistry::DefaultFaces() {
  {
    std::lock_guard<std::mutex> l(mutex_);
    if (defaults_loaded_) return defaults_;
  }
  struct Entry {
    const char* family;
    const char* file;
  };
  static const Entry kDefaults[] = {
      {"sans-serif", "Roboto-Regular.ttf"},
      {"sans-serif", "Roboto-Bold.ttf"},
      {"monospace", "RobotoMono-Regular.ttf"},
  };
  std::vector<DefaultFace> out;
  for (const Entry& e : kDefaults) {
    std::shared_ptr<FontBytes> bytes = ReadAsset(std::string("fonts/") + e.file);
    if (!bytes) bytes = FontBytes::MapFile(std::string("/system/fonts/") + e.file);
    if (!bytes) continue;
    std::string err;
    auto face = Face::Load(bytes, 0, &err);
    if (face) out.push_back({e.family, face});
  }
  std::lock_guard<std::mutex> l(mutex_);
  defaults_ = out;
  defaults_loaded_ = true;
  return defaults_;
}

void FontRegistry::ConfigureSystemFonts(const std::string& fonts_xml_path, const std::string& font_dir) {
  std::lock_guard<std::mutex> l(mutex_);
  fonts_xml_path_ = fonts_xml_path;
  font_dir_ = font_dir;
  system_configured_ = false;
  fallback_.clear();
  xml_ = FontsXml();
}

void FontRegistry::ConfigureSystemFontsFromXml(const FontsXml& xml, const std::string& font_dir) {
  std::lock_guard<std::mutex> l(mutex_);
  xml_ = xml;
  font_dir_ = font_dir;
  fallback_.clear();
  for (const FontsXmlFamily& fam : xml_.families) {
    if (!fam.name.empty()) continue;
    std::vector<FallbackSlot> slots;
    for (const FontsXmlFont& f : fam.fonts) {
      if (!f.fallback_for.empty()) continue;
      FallbackSlot s;
      s.font = f;
      s.path = (!f.file.empty() && f.file[0] == '/') ? f.file : font_dir_ + "/" + f.file;
      slots.push_back(s);
    }
    if (!slots.empty()) fallback_.push_back(std::move(slots));
  }
  system_configured_ = true;
}

void FontRegistry::EnsureSystemConfig() {
  std::string xml_path, dir;
  {
    std::lock_guard<std::mutex> l(mutex_);
    if (system_configured_) return;
    xml_path = fonts_xml_path_;
    dir = font_dir_;
  }
  FontsXml xml;
  std::ifstream in(xml_path, std::ios::binary);
  bool parsed = false;
  if (in) {
    std::stringstream ss;
    ss << in.rdbuf();
    std::string err;
    parsed = ParseFontsXml(ss.str(), &xml, &err);
  }
  if (!parsed) xml = FontsXml();
  ConfigureSystemFontsFromXml(xml, dir);
}

std::vector<FontRegistry::NamedFamily> FontRegistry::SystemFamilies() {
  EnsureSystemConfig();
  std::lock_guard<std::mutex> l(mutex_);
  std::vector<NamedFamily> out;
  for (const FontsXmlFamily& fam : xml_.families) {
    if (fam.name.empty()) continue;
    NamedFamily nf;
    nf.name = fam.name;
    for (const FontsXmlFont& f : fam.fonts) {
      std::string path = (!f.file.empty() && f.file[0] == '/') ? f.file : font_dir_ + "/" + f.file;
      nf.fonts.emplace_back(f, path);
    }
    out.push_back(std::move(nf));
  }
  for (const FontsXmlAlias& a : xml_.aliases) {
    for (const NamedFamily& nf : std::vector<NamedFamily>(out)) {
      if (nf.name != a.to) continue;
      NamedFamily alias;
      alias.name = a.name;
      for (const auto& fp : nf.fonts) {
        if (a.weight == 0 || fp.first.weight == a.weight) alias.fonts.push_back(fp);
      }
      if (!alias.fonts.empty()) out.push_back(alias);
    }
  }
  return out;
}

std::shared_ptr<Face> FontRegistry::OpenFile(const std::string& path, int index) {
  {
    std::lock_guard<std::mutex> l(mutex_);
    auto it = open_files_.find({path, index});
    if (it != open_files_.end()) {
      if (auto f = it->second.lock()) return f;
    }
  }
  auto bytes = FontBytes::MapFile(path);
  if (!bytes) return nullptr;
  std::string err;
  auto face = Face::Load(bytes, index, &err);
  if (!face) return nullptr;
  std::lock_guard<std::mutex> l(mutex_);
  open_files_[{path, index}] = face;
  return face;
}

void FontRegistry::VisitFallback(int weight, bool italic, const std::function<bool(const FaceRef&)>& visit) {
  EnsureSystemConfig();
  for (size_t i = 0;; i++) {
    std::shared_ptr<Face> face;
    std::string path;
    int index = 0;
    bool need_open = false;
    {
      std::lock_guard<std::mutex> l(mutex_);
      if (i >= fallback_.size()) return;
      FallbackSlot* best = nullptr;
      int best_score = 1 << 30;
      for (FallbackSlot& s : fallback_[i]) {
        int score = std::abs(s.font.weight - weight) + (s.font.italic != italic ? 1000 : 0);
        if (score < best_score) {
          best_score = score;
          best = &s;
        }
      }
      if (!best) continue;
      if (best->tried) {
        face = best->face;
      } else {
        need_open = true;
        path = best->path;
        index = best->font.index;
      }
    }
    if (need_open) {
      face = OpenFile(path, index);
      std::lock_guard<std::mutex> l(mutex_);
      if (i < fallback_.size()) {
        for (FallbackSlot& s : fallback_[i]) {
          if (s.path == path && s.font.index == index) {
            s.tried = true;
            s.face = face;
          }
        }
      }
    }
    if (face && visit(FaceRef{face, false, false})) return;
  }
}

}  // namespace iwn::canvas2d
