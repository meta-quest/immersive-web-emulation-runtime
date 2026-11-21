/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// UAX #9 for one paragraph without explicit embeddings (see bidi.h). Rule names below are UAX #9's.

#include "bidi.h"

#include <algorithm>

namespace iwn::canvas2d {

namespace {

struct Range {
  uint32_t lo, hi;
};

template <size_t N>
bool InRanges(const Range (&r)[N], uint32_t c) {
  for (const Range& x : r) {
    if (c >= x.lo && c <= x.hi) return true;
  }
  return false;
}

// European numbers (EN): ASCII, superscript/subscript, Extended Arabic-Indic (Persian/Urdu) and fullwidth digits.
// (NKo digits U+07C0-07C9 are R, not EN: they fall in kDefaultR.)
constexpr Range kEN[] = {{0x30, 0x39},       {0xB2, 0xB3},       {0xB9, 0xB9},       {0x6F0, 0x6F9},
                         {0x2070, 0x2070},   {0x2074, 0x2079},   {0x2080, 0x2089},
                         {0x2488, 0x249B},   {0xFF10, 0xFF19},   {0x1D7CE, 0x1D7FF}, {0x1F100, 0x1F10A},
                         {0x1FBF0, 0x1FBF9}};
// Arabic numbers (AN): Arabic-Indic digits, Arabic number signs and separators.
constexpr Range kAN[] = {{0x600, 0x605}, {0x660, 0x669}, {0x66B, 0x66C}, {0x6DD, 0x6DD},
                         {0x890, 0x891}, {0x8E2, 0x8E2}, {0x10E60, 0x10E7E}};
constexpr Range kES[] = {{0x2B, 0x2B},     {0x2D, 0x2D},     {0x207A, 0x207B}, {0x208A, 0x208B}, {0x2212, 0x2212},
                         {0xFB29, 0xFB29}, {0xFE62, 0xFE63}, {0xFF0B, 0xFF0B}, {0xFF0D, 0xFF0D}};
constexpr Range kET[] = {{0x23, 0x25},     {0xA2, 0xA5},     {0xB0, 0xB1},     {0x58F, 0x58F},   {0x609, 0x60A},
                         {0x66A, 0x66A},   {0x9F2, 0x9F3},   {0x9FB, 0x9FB},   {0xAF1, 0xAF1},   {0xBF9, 0xBF9},
                         {0xE3F, 0xE3F},   {0x17DB, 0x17DB}, {0x2030, 0x2034}, {0x20A0, 0x20CF}, {0x212E, 0x212E},
                         {0x2213, 0x2213}, {0xA838, 0xA839}, {0xFE5F, 0xFE5F}, {0xFE69, 0xFE6A}, {0xFF03, 0xFF05},
                         {0xFFE0, 0xFFE1}, {0xFFE5, 0xFFE6}};
constexpr Range kCS[] = {{0x2C, 0x2C},     {0x2E, 0x2F},     {0x3A, 0x3A},     {0xA0, 0xA0},     {0x60C, 0x60C},
                         {0x202F, 0x202F}, {0x2044, 0x2044}, {0xFE50, 0xFE50}, {0xFE52, 0xFE52}, {0xFE55, 0xFE55},
                         {0xFF0C, 0xFF0C}, {0xFF0E, 0xFF0F}, {0xFF1A, 0xFF1A}};
constexpr Range kWS[] = {{0x0C, 0x0C},     {0x20, 0x20},     {0x1680, 0x1680}, {0x2000, 0x200A},
                         {0x2028, 0x2028}, {0x205F, 0x205F}, {0x3000, 0x3000}};
constexpr Range kB[] = {{0x0A, 0x0A}, {0x0D, 0x0D}, {0x1C, 0x1E}, {0x85, 0x85}, {0x2029, 0x2029}};
constexpr Range kS[] = {{0x09, 0x09}, {0x0B, 0x0B}, {0x1F, 0x1F}};
// Boundary neutrals; the explicit embedding/isolate controls are included here (no explicit levels, see bidi.h).
constexpr Range kBN[] = {{0x00, 0x08},       {0x0E, 0x1B},       {0x7F, 0x84},       {0x86, 0x9F},
                         {0xAD, 0xAD},       {0x180E, 0x180E},   {0x200B, 0x200D},   {0x202A, 0x202E},
                         {0x2060, 0x2069},   {0xFEFF, 0xFEFF},   {0x1BCA0, 0x1BCA3}, {0xE0001, 0xE0001},
                         {0xE0020, 0xE007F}};
// Blocks whose unassigned/common characters default to AL or R (DerivedBidiClass defaults).
constexpr Range kDefaultAL[] = {{0x600, 0x7BF},     {0x860, 0x8FF},     {0xFB50, 0xFDCF}, {0xFDF0, 0xFDFF},
                                {0xFE70, 0xFEFF},   {0x10D00, 0x10D3F}, {0x10EC0, 0x10EFF}, {0x10F30, 0x10F6F},
                                {0x1EC70, 0x1ECBF}, {0x1ED00, 0x1ED4F}, {0x1EE00, 0x1EEFF}};
constexpr Range kDefaultR[] = {{0x590, 0x5FF},     {0x7C0, 0x85F},     {0xFB1D, 0xFB4F}, {0x10800, 0x10CFF},
                               {0x10D40, 0x10EBF}, {0x10F00, 0x10F2F}, {0x10F70, 0x10FFF}, {0x1E800, 0x1EC6F},
                               {0x1ECC0, 0x1ECFF}, {0x1ED50, 0x1EDFF}, {0x1EF00, 0x1EFFF}};

bool IsAlScript(hb_script_t s) {
  return s == HB_SCRIPT_ARABIC || s == HB_SCRIPT_SYRIAC || s == HB_SCRIPT_THAANA || s == HB_SCRIPT_HANIFI_ROHINGYA;
}

// Paired brackets (BidiBrackets.txt, the commonly used part): opening, closing.
constexpr uint32_t kBrackets[][2] = {
    {0x28, 0x29},     {0x5B, 0x5D},     {0x7B, 0x7D},     {0xF3A, 0xF3B},   {0xF3C, 0xF3D},   {0x169B, 0x169C},
    {0x2045, 0x2046}, {0x207D, 0x207E}, {0x208D, 0x208E}, {0x2308, 0x2309}, {0x230A, 0x230B}, {0x2329, 0x232A},
    {0x2768, 0x2769}, {0x276A, 0x276B}, {0x276C, 0x276D}, {0x276E, 0x276F}, {0x2770, 0x2771}, {0x2772, 0x2773},
    {0x2774, 0x2775}, {0x27C5, 0x27C6}, {0x27E6, 0x27E7}, {0x27E8, 0x27E9}, {0x27EA, 0x27EB}, {0x27EC, 0x27ED},
    {0x27EE, 0x27EF}, {0x2983, 0x2984}, {0x2985, 0x2986}, {0x2987, 0x2988}, {0x2989, 0x298A}, {0x298B, 0x298C},
    {0x2E22, 0x2E23}, {0x2E24, 0x2E25}, {0x2E26, 0x2E27}, {0x2E28, 0x2E29}, {0x3008, 0x3009}, {0x300A, 0x300B},
    {0x300C, 0x300D}, {0x300E, 0x300F}, {0x3010, 0x3011}, {0x3014, 0x3015}, {0x3016, 0x3017}, {0x3018, 0x3019},
    {0x301A, 0x301B}, {0xFE59, 0xFE5A}, {0xFE5B, 0xFE5C}, {0xFE5D, 0xFE5E}, {0xFF08, 0xFF09}, {0xFF3B, 0xFF3D},
    {0xFF5B, 0xFF5D}, {0xFF5F, 0xFF60}, {0xFF62, 0xFF63}};

// +1 opening bracket, -1 closing, 0 none; *pair receives the opening bracket of the pair.
int BracketType(uint32_t c, uint32_t* pair) {
  for (const auto& b : kBrackets) {
    if (c == b[0]) {
      *pair = b[0];
      return 1;
    }
    if (c == b[1]) {
      *pair = b[0];
      return -1;
    }
  }
  return 0;
}

bool IsStrongOrNumber(BidiClass c) {
  return c == BidiClass::kL || c == BidiClass::kR || c == BidiClass::kEN || c == BidiClass::kAN;
}
// N1/N0: European and Arabic numbers act as R.
BidiClass StrongDir(BidiClass c) { return c == BidiClass::kL ? BidiClass::kL : BidiClass::kR; }
bool IsNeutral(BidiClass c) {
  return c == BidiClass::kB || c == BidiClass::kS || c == BidiClass::kWS || c == BidiClass::kON;
}

}  // namespace

BidiClass BidiClassOf(uint32_t c, hb_unicode_funcs_t* uf) {
  if (c < 0x80) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) return BidiClass::kL;
  }
  if (c == 0x200E) return BidiClass::kL;   // LRM
  if (c == 0x200F) return BidiClass::kR;   // RLM
  if (c == 0x061C) return BidiClass::kAL;  // ALM
  if (InRanges(kEN, c)) return BidiClass::kEN;
  if (InRanges(kAN, c)) return BidiClass::kAN;
  if (InRanges(kES, c)) return BidiClass::kES;
  if (InRanges(kET, c)) return BidiClass::kET;
  if (InRanges(kCS, c)) return BidiClass::kCS;
  if (InRanges(kWS, c)) return BidiClass::kWS;
  if (InRanges(kB, c)) return BidiClass::kB;
  if (InRanges(kS, c)) return BidiClass::kS;
  if (InRanges(kBN, c)) return BidiClass::kBN;
  hb_unicode_general_category_t gc = hb_unicode_general_category(uf, c);
  if (gc == HB_UNICODE_GENERAL_CATEGORY_NON_SPACING_MARK || gc == HB_UNICODE_GENERAL_CATEGORY_ENCLOSING_MARK) {
    return BidiClass::kNSM;
  }
  if (gc == HB_UNICODE_GENERAL_CATEGORY_FORMAT) return BidiClass::kBN;
  hb_script_t s = hb_unicode_script(uf, c);
  if (s != HB_SCRIPT_COMMON && s != HB_SCRIPT_INHERITED && s != HB_SCRIPT_UNKNOWN) {
    if (hb_script_get_horizontal_direction(s) == HB_DIRECTION_RTL) return IsAlScript(s) ? BidiClass::kAL : BidiClass::kR;
    return BidiClass::kL;
  }
  // Common / unassigned: the block default for right-to-left blocks, letters L, everything else ON.
  if (InRanges(kDefaultAL, c)) return BidiClass::kAL;
  if (InRanges(kDefaultR, c)) return BidiClass::kR;
  switch (gc) {
    case HB_UNICODE_GENERAL_CATEGORY_LOWERCASE_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_UPPERCASE_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_TITLECASE_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_OTHER_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_SPACING_MARK:
    case HB_UNICODE_GENERAL_CATEGORY_DECIMAL_NUMBER:
    case HB_UNICODE_GENERAL_CATEGORY_LETTER_NUMBER:
    case HB_UNICODE_GENERAL_CATEGORY_UNASSIGNED:
    case HB_UNICODE_GENERAL_CATEGORY_PRIVATE_USE:
      return BidiClass::kL;
    default:
      return BidiClass::kON;
  }
}

void ResolveBidiLevels(const uint32_t* cps, size_t n, int para_level, hb_unicode_funcs_t* uf, std::vector<uint8_t>* levels) {
  levels->assign(n, static_cast<uint8_t>(para_level & 1));
  if (n == 0) return;
  std::vector<BidiClass> orig(n);
  bool any_rtl = para_level & 1;
  for (size_t i = 0; i < n; i++) {
    orig[i] = BidiClassOf(cps[i], uf);
    any_rtl |= orig[i] == BidiClass::kR || orig[i] == BidiClass::kAL || orig[i] == BidiClass::kAN;
  }
  // Pure left-to-right text in an LTR paragraph: every level is 0 (the common case, no further work).
  if (!any_rtl) return;

  // X9: boundary neutrals are removed; the rules below run over the remaining characters (one isolating run
  // sequence: the paragraph, sos = eos = the paragraph direction).
  std::vector<size_t> idx;
  idx.reserve(n);
  for (size_t i = 0; i < n; i++) {
    if (orig[i] != BidiClass::kBN) idx.push_back(i);
  }
  const size_t m = idx.size();
  std::vector<BidiClass> t(m);
  for (size_t k = 0; k < m; k++) t[k] = orig[idx[k]];
  const BidiClass e = (para_level & 1) ? BidiClass::kR : BidiClass::kL;
  const BidiClass sos = e, eos = e;

  // W1: NSM takes the type of the previous character (sos at the start).
  BidiClass prev = sos;
  for (size_t k = 0; k < m; k++) {
    if (t[k] == BidiClass::kNSM) t[k] = prev;
    prev = t[k];
  }
  // W2: EN preceded (through weak types) by AL becomes AN.
  BidiClass last_strong = sos;
  for (size_t k = 0; k < m; k++) {
    BidiClass c = t[k];
    if (c == BidiClass::kEN && last_strong == BidiClass::kAL) t[k] = BidiClass::kAN;
    if (c == BidiClass::kL || c == BidiClass::kR || c == BidiClass::kAL) last_strong = c;
  }
  // W3: AL -> R.
  for (size_t k = 0; k < m; k++) {
    if (t[k] == BidiClass::kAL) t[k] = BidiClass::kR;
  }
  // W4: a single ES between ENs -> EN; a single CS between numbers of the same type -> that type.
  for (size_t k = 1; k + 1 < m; k++) {
    if (t[k] == BidiClass::kES && t[k - 1] == BidiClass::kEN && t[k + 1] == BidiClass::kEN) {
      t[k] = BidiClass::kEN;
    } else if (t[k] == BidiClass::kCS) {
      if (t[k - 1] == BidiClass::kEN && t[k + 1] == BidiClass::kEN) t[k] = BidiClass::kEN;
      else if (t[k - 1] == BidiClass::kAN && t[k + 1] == BidiClass::kAN) t[k] = BidiClass::kAN;
    }
  }
  // W5: a sequence of ETs adjacent to an EN -> EN.
  for (size_t k = 0; k < m;) {
    if (t[k] != BidiClass::kET) {
      k++;
      continue;
    }
    size_t j = k;
    while (j < m && t[j] == BidiClass::kET) j++;
    bool en = (k > 0 && t[k - 1] == BidiClass::kEN) || (j < m && t[j] == BidiClass::kEN);
    if (en) {
      for (size_t q = k; q < j; q++) t[q] = BidiClass::kEN;
    }
    k = j;
  }
  // W6: remaining separators and terminators -> ON.
  for (size_t k = 0; k < m; k++) {
    if (t[k] == BidiClass::kES || t[k] == BidiClass::kET || t[k] == BidiClass::kCS) t[k] = BidiClass::kON;
  }
  // W7: EN preceded by L (or sos L) -> L.
  last_strong = sos;
  for (size_t k = 0; k < m; k++) {
    BidiClass c = t[k];
    if (c == BidiClass::kEN && last_strong == BidiClass::kL) t[k] = BidiClass::kL;
    if (c == BidiClass::kL || c == BidiClass::kR) last_strong = c;
  }

  // N0: paired brackets (BD16: a stack of 63 openers; pairs processed in order of their opening bracket).
  {
    struct Opener {
      uint32_t pair;
      size_t pos;
    };
    std::vector<Opener> stack;
    std::vector<std::pair<size_t, size_t>> pairs;
    bool overflow = false;
    for (size_t k = 0; k < m && !overflow; k++) {
      if (t[k] != BidiClass::kON) continue;
      uint32_t pair = 0;
      int bt = BracketType(cps[idx[k]], &pair);
      if (bt > 0) {
        if (stack.size() == 63) {
          overflow = true;
          break;
        }
        stack.push_back({pair, k});
      } else if (bt < 0) {
        for (size_t s = stack.size(); s-- > 0;) {
          if (stack[s].pair == pair) {
            pairs.emplace_back(stack[s].pos, k);
            stack.resize(s);
            break;
          }
        }
      }
    }
    if (overflow) pairs.clear();
    std::sort(pairs.begin(), pairs.end());
    for (const auto& [o, c] : pairs) {
      bool found_e = false, found_opposite = false;
      for (size_t k = o + 1; k < c; k++) {
        if (!IsStrongOrNumber(t[k])) continue;
        BidiClass d = StrongDir(t[k]);
        if (d == e) found_e = true;
        else found_opposite = true;
      }
      BidiClass set = BidiClass::kON;
      if (found_e) {
        set = e;
      } else if (found_opposite) {
        BidiClass before = sos;
        for (size_t k = o; k-- > 0;) {
          if (IsStrongOrNumber(t[k])) {
            before = StrongDir(t[k]);
            break;
          }
        }
        set = before != e ? before : e;
      }
      if (set == BidiClass::kON) continue;
      t[o] = t[c] = set;
      // NSMs that followed a bracket (W1 made them ON) take the bracket's new type.
      for (size_t k = o + 1; k < m && orig[idx[k]] == BidiClass::kNSM; k++) t[k] = set;
      for (size_t k = c + 1; k < m && orig[idx[k]] == BidiClass::kNSM; k++) t[k] = set;
    }
  }

  // N1/N2: sequences of neutrals take the direction of the surrounding strong text when both sides agree
  // (numbers count as R), otherwise the embedding direction.
  for (size_t k = 0; k < m;) {
    if (!IsNeutral(t[k])) {
      k++;
      continue;
    }
    size_t j = k;
    while (j < m && IsNeutral(t[j])) j++;
    BidiClass before = k == 0 ? sos : StrongDir(t[k - 1]);
    BidiClass after = j == m ? eos : StrongDir(t[j]);
    BidiClass set = before == after ? before : e;
    for (size_t q = k; q < j; q++) t[q] = set;
    k = j;
  }

  // I1/I2.
  const uint8_t base = static_cast<uint8_t>(para_level & 1);
  for (size_t k = 0; k < m; k++) {
    uint8_t lv = base;
    BidiClass c = t[k];
    if (base == 0) {
      if (c == BidiClass::kR) lv = 1;
      else if (c == BidiClass::kAN || c == BidiClass::kEN) lv = 2;
    } else if (c == BidiClass::kL || c == BidiClass::kEN || c == BidiClass::kAN) {
      lv = 2;
    }
    (*levels)[idx[k]] = lv;
  }
  // Removed boundary neutrals take the level of the character before them (so they stay inside its run).
  uint8_t last = base;
  for (size_t i = 0; i < n; i++) {
    if (orig[i] == BidiClass::kBN) (*levels)[i] = last;
    else last = (*levels)[i];
  }
  // L1: segment/paragraph separators, and whitespace before them or at the end of the line, get the paragraph level.
  bool trailing = true;
  for (size_t i = n; i-- > 0;) {
    BidiClass c = orig[i];
    if (c == BidiClass::kB || c == BidiClass::kS) {
      (*levels)[i] = base;
      trailing = true;
    } else if (trailing && (c == BidiClass::kWS || c == BidiClass::kBN)) {
      (*levels)[i] = base;
    } else {
      trailing = false;
    }
  }
}

}  // namespace iwn::canvas2d
