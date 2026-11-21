/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Canvas 2D text: font faces (FreeType), shaping (HarfBuzz), per-character font fallback, TextMetrics and drawing.
// Plain C++ (no V8).
//
// Glyph outlines are drawn through the same rasterizer as paths, so fillText/strokeText get transforms, gradients,
// patterns, shadows, clipping and compositing for free. Colour glyphs: CBDT/CBLC PNG strikes (Android's
// NotoColorEmoji) and COLR v0 layers. COLR v1 paint graphs are not drawn (documented gap).
//
// Thread safety: FreeType calls are serialised by one process-wide mutex; HarfBuzz fonts are immutable after
// creation and shared. Faces may be used from any thread (worker OffscreenCanvas).
#pragma once

#include <cmath>
#include <functional>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "iwn/canvas2d/canvas.h"

struct hb_font_t;
struct FT_FaceRec_;

namespace iwn::canvas2d {

// Font file bytes: owned copy or a read-only file mapping.
class FontBytes {
 public:
  static std::shared_ptr<FontBytes> Copy(const uint8_t* data, size_t size);
  static std::shared_ptr<FontBytes> MapFile(const std::string& path);  // nullptr if unreadable
  // Bytes owned elsewhere (e.g. a mapped APK asset); `owner` keeps them alive.
  static std::shared_ptr<FontBytes> Borrow(std::shared_ptr<const void> owner, const uint8_t* data, size_t size);
  ~FontBytes();
  const uint8_t* data() const { return data_; }
  size_t size() const { return size_; }

 private:
  FontBytes() = default;
  std::vector<uint8_t> owned_;
  const uint8_t* data_ = nullptr;
  size_t size_ = 0;
  void* map_ = nullptr;
  size_t map_size_ = 0;
  std::shared_ptr<const void> owner_;
};

struct GlyphOutline {
  std::vector<float> path;  // path commands in font units, y up
  bool empty = true;
  float x_min = 0, y_min = 0, x_max = 0, y_max = 0;  // exact bounds, font units
};

struct ColorBitmap {
  std::shared_ptr<OwnedImage> image;  // premultiplied
  float ppem = 0;                     // the strike's pixels per em
  float bearing_x = 0;                // strike pixels, origin to left edge
  float bearing_y = 0;                // strike pixels, baseline up to top edge
  // Box-filtered half-size levels (mips[0] is half of image, ...), so emoji drawn at label sizes are minified from a
  // level within 2x of the target instead of bilinear-sampling a ~136 px strike (which aliases).
  std::vector<std::shared_ptr<OwnedImage>> mips;
};

struct ColorLayer {
  uint32_t glyph = 0;
  bool use_foreground = false;  // palette index 0xFFFF: the current fill style
  Color color;                  // premultiplied
};

// Least-recently-used cache with a byte budget (per-face glyph caches). Values are shared, so an entry evicted while a
// caller still draws with it stays alive until that caller drops it. Not thread-safe: the owner locks.
template <class K, class V>
class GlyphLru {
 public:
  explicit GlyphLru(size_t budget) : budget_(budget) {}
  // True when `k` is cached (*out may be null: a cached "nothing").
  bool Get(K k, std::shared_ptr<const V>* out) {
    auto it = map_.find(k);
    if (it == map_.end()) return false;
    order_.splice(order_.begin(), order_, it->second);
    *out = it->second->value;
    return true;
  }
  void Put(K k, std::shared_ptr<const V> v, size_t bytes) {
    order_.push_front(Entry{k, std::move(v), bytes});
    map_[k] = order_.begin();
    bytes_ += bytes;
    while (bytes_ > budget_ && order_.size() > 1) {
      const Entry& e = order_.back();
      bytes_ -= e.bytes;
      map_.erase(e.key);
      order_.pop_back();
    }
  }
  size_t bytes() const { return bytes_; }
  size_t size() const { return map_.size(); }

 private:
  struct Entry {
    K key;
    std::shared_ptr<const V> value;
    size_t bytes;
  };
  size_t budget_;
  size_t bytes_ = 0;
  std::list<Entry> order_;
  std::unordered_map<K, typename std::list<Entry>::iterator> map_;
};

class Face {
 public:
  // Budgets of the per-face glyph caches (least recently used glyphs are dropped above them).
  static constexpr size_t kOutlineCacheBytes = size_t(4) << 20;
  static constexpr size_t kBitmapCacheBytes = size_t(12) << 20;  // ~130 colour emoji with their mips

  // Loads face `index` of a TrueType/OpenType/WOFF/WOFF2 file or collection. nullptr + error on failure.
  static std::shared_ptr<Face> Load(std::shared_ptr<FontBytes> bytes, int index, std::string* error);
  ~Face();

  const std::string& family() const { return family_; }
  const std::string& style_name() const { return style_name_; }
  int weight() const { return weight_; }
  bool italic() const { return italic_; }
  double stretch() const { return stretch_; }  // percent (CSS font-stretch)
  bool is_color() const { return has_cbdt_ || has_colr_; }
  bool has_weight_axis() const { return wght_axis_ >= 0; }
  float weight_min() const { return wght_min_; }
  float weight_max() const { return wght_max_; }
  int units_per_em() const { return upem_; }
  int num_faces() const { return num_faces_; }

  // Vertical metrics, font units (descent values positive downwards).
  double ascent() const { return ascent_; }
  double descent() const { return descent_; }
  double typo_ascent() const { return typo_ascent_; }
  double typo_descent() const { return typo_descent_; }

  // Glyph for a code point (0 when missing). With a variation selector, a matching variation glyph if any.
  uint32_t GlyphFor(uint32_t cp, uint32_t variation_selector = 0) const;
  hb_font_t* hb_font() const { return hb_font_; }

  // Glyph outline in font units. embolden_1024: synthetic bold growth in 1/1024 em (0 = none); see SyntheticBold1024.
  // Both are cached (bounded, see the budgets above); hold the returned pointer while using it.
  std::shared_ptr<const GlyphOutline> Outline(uint32_t glyph, int embolden_1024 = 0);
  std::shared_ptr<const ColorBitmap> Bitmap(uint32_t glyph);
  size_t CacheBytes();  // outlines + bitmaps currently cached
  bool ColorLayers(uint32_t glyph, std::vector<ColorLayer>* layers);

  // A variable-font instance at `wght` (this face when it has no weight axis or wght is its default).
  std::shared_ptr<Face> WeightInstance(float wght);

 private:
  Face() = default;
  bool Init(std::string* error);
  void ParseCbdtIndex();

  std::shared_ptr<FontBytes> bytes_;
  int index_ = 0;
  FT_FaceRec_* ft_ = nullptr;
  hb_font_t* hb_font_ = nullptr;
  std::string family_, style_name_;
  int weight_ = 400;
  bool italic_ = false;
  double stretch_ = 100;
  int upem_ = 1000;
  int num_faces_ = 1;
  double ascent_ = 0, descent_ = 0, typo_ascent_ = 0, typo_descent_ = 0;
  bool has_cbdt_ = false, has_colr_ = false;
  int wght_axis_ = -1;
  float wght_min_ = 0, wght_max_ = 0, wght_default_ = 400;
  float wght_value_ = 0;  // this instance's wght (0: default)

  std::mutex cache_mutex_;
  GlyphLru<uint64_t, GlyphOutline> outlines_{kOutlineCacheBytes};
  GlyphLru<uint32_t, ColorBitmap> bitmaps_{kBitmapCacheBytes};
  std::map<int, std::weak_ptr<Face>> instances_;
  std::weak_ptr<Face> self_;

  // CBLC/CBDT tables: views into the face's own sfnt bytes (bytes_, or FreeType's decompressed WOFF stream owned by
  // ft_), never copies (a colour-emoji font's CBDT is several MB). CBDT strike chosen at load time (largest ppem).
  struct TableView {
    const uint8_t* p = nullptr;
    size_t n = 0;
    const uint8_t* data() const { return p; }
    size_t size() const { return n; }
    bool empty() const { return n == 0; }
    uint8_t operator[](size_t i) const { return p[i]; }
  };
  TableView cblc_, cbdt_;
  int strike_ = -1;
};

struct FaceRef {
  std::shared_ptr<Face> face;
  bool synthetic_bold = false;
  bool synthetic_italic = false;
  // CSS font-weight descriptor range of the face (FontFace / @font-face); 0 = the face's own range. A variable
  // face's wght axis is instantiated at the requested weight clamped to this range (CSS Fonts 4 §5.2).
  int weight_min = 0, weight_max = 0;
};

struct FontDesc {
  std::vector<FaceRef> faces;  // matched by the JS layer from the family list, in priority order
  double size = 10;            // CSS px
  int weight = 400;
  bool italic = false;
  bool small_caps = false;
  bool kerning = true;          // fontKerning != "none"
  double letter_spacing = 0;    // px
  double word_spacing = 0;      // px
  bool use_system_fallback = true;
  std::string language;         // BCP 47, e.g. "en"
};

enum class TextAlign : uint8_t { kStart = 0, kEnd = 1, kLeft = 2, kRight = 3, kCenter = 4 };
enum class TextBaseline : uint8_t { kTop = 0, kHanging = 1, kMiddle = 2, kAlphabetic = 3, kIdeographic = 4, kBottom = 5 };
enum class TextDirection : uint8_t { kLtr = 0, kRtl = 1 };

// HTML TextMetrics, CSS px, relative to the alignment point (textAlign) and textBaseline.
struct TextMetricsResult {
  double width = 0;
  double actual_left = 0, actual_right = 0, actual_ascent = 0, actual_descent = 0;
  double font_ascent = 0, font_descent = 0;
  double em_ascent = 0, em_descent = 0;
  double hanging = 0, alphabetic = 0, ideographic = 0;
};

struct ShapedGlyph {
  Face* face = nullptr;
  uint32_t glyph = 0;
  uint32_t cluster = 0;  // UTF-16 index of the first character of the glyph's cluster
  double x = 0, y = 0;  // px from the run origin; y down
  bool synthetic_bold = false;
  bool synthetic_italic = false;
  bool color = false;
};

struct ShapedText {
  std::vector<ShapedGlyph> glyphs;
  double advance = 0;
  bool has_ink = false;
  double ink_left = 0, ink_right = 0, ink_top = 0, ink_bottom = 0;  // px, y up from the baseline (top > bottom)
};

class Font {
 public:
  explicit Font(FontDesc desc);
  const FontDesc& desc() const { return desc_; }

  void Shape(std::u16string_view text, TextDirection dir, ShapedText* out);
  void Measure(std::u16string_view text, TextAlign align, TextBaseline baseline, TextDirection dir,
               TextMetricsResult* out);
  // fillText / strokeText. max_width: NaN = none.
  void Draw(Canvas* canvas, std::u16string_view text, double x, double y, double max_width, TextAlign align,
            TextBaseline baseline, TextDirection dir, const StrokeStyle* stroke, const Paint& paint,
            const DrawParams& params);

  // Vertical metrics of the primary face in px (y up): ascent/descent and the normalised typo (em box) values.
  struct Vertical {
    double ascent, descent, em_ascent, em_descent;
  };
  Vertical VerticalMetrics() const;
  double BaselineOffset(TextBaseline baseline) const;  // up from the alphabetic baseline to `baseline`

 private:
  const std::vector<FaceRef>& Chain();
  FontDesc desc_;
  std::vector<FaceRef> chain_;
  bool chain_ready_ = false;
  std::mutex mutex_;
  // Small shaping cache: labels are measured then drawn with the same string.
  std::u16string last_text_;
  TextDirection last_dir_ = TextDirection::kLtr;
  ShapedText last_shape_;
  bool last_valid_ = false;
};

// Android /system/etc/fonts.xml (parsed by fonts_xml.cc).
struct FontsXmlFont {
  std::string file;
  int weight = 400;
  bool italic = false;
  int index = 0;
  std::string fallback_for;
};
struct FontsXmlFamily {
  std::string name;  // empty: a fallback family
  std::string lang;
  std::string variant;
  std::vector<FontsXmlFont> fonts;
};
struct FontsXmlAlias {
  std::string name, to;
  int weight = 0;
};
struct FontsXml {
  std::vector<FontsXmlFamily> families;
  std::vector<FontsXmlAlias> aliases;
};
bool ParseFontsXml(std::string_view xml, FontsXml* out, std::string* error);

// Process-wide font configuration: bundled default faces and the system fallback chain.
class FontRegistry {
 public:
  static FontRegistry& Get();

  using AssetReader = std::function<std::shared_ptr<FontBytes>(const std::string& name)>;
  // The host installs a reader for bundled runtime assets (APK assets on Android, a directory in host tests).
  void SetAssetReader(AssetReader reader);
  std::shared_ptr<FontBytes> ReadAsset(const std::string& name);

  struct DefaultFace {
    std::string family;  // generic family name the JS layer maps ("sans-serif", "monospace")
    std::shared_ptr<Face> face;
  };
  // The runtime's bundled fonts (C2D-9), loaded once through the asset reader, falling back to /system/fonts.
  std::vector<DefaultFace> DefaultFaces();

  // System fonts. Configured lazily from `fonts_xml_path` (default /system/etc/fonts.xml) and `font_dir`.
  void ConfigureSystemFonts(const std::string& fonts_xml_path, const std::string& font_dir);
  void ConfigureSystemFontsFromXml(const FontsXml& xml, const std::string& font_dir);
  // Named system families (e.g. "serif", "Roboto") with their faces, for the JS family matcher.
  struct NamedFamily {
    std::string name;
    std::vector<std::pair<FontsXmlFont, std::string>> fonts;  // font + absolute path
  };
  std::vector<NamedFamily> SystemFamilies();
  // Fallback faces (unnamed families, in fonts.xml order), opened lazily.
  // Calls visit(face_ref) in order until it returns true.
  void VisitFallback(int weight, bool italic, const std::function<bool(const FaceRef&)>& visit);
  std::shared_ptr<Face> OpenFile(const std::string& path, int index);

 private:
  FontRegistry() = default;
  void EnsureSystemConfig();

  std::mutex mutex_;
  AssetReader asset_reader_;
  bool defaults_loaded_ = false;
  std::vector<DefaultFace> defaults_;
  bool system_configured_ = false;
  std::string fonts_xml_path_ = "/system/etc/fonts.xml";
  std::string font_dir_ = "/system/fonts";
  FontsXml xml_;
  struct FallbackSlot {
    FontsXmlFont font;
    std::string path;
    bool tried = false;
    std::shared_ptr<Face> face;
  };
  std::vector<std::vector<FallbackSlot>> fallback_;  // per family
  std::map<std::pair<std::string, int>, std::weak_ptr<Face>> open_files_;
};

}  // namespace iwn::canvas2d
