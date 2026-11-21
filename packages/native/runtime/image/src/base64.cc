// Forgiving-base64 decode (WHATWG Infra standard, "forgiving-base64 decode"), used for data: URL images so the JS
// thread does not decode base64 (REG-16): the binding copies the text and this runs on a pool thread.
#include <cstdint>
#include <vector>

#include "iwn/image/decode.h"

namespace iwn::image {

namespace {

constexpr bool IsAsciiWhitespace(uint8_t c) { return c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D || c == 0x20; }

// 0..63 for the base64 alphabet, 64 for anything else.
struct Table {
  uint8_t v[256];
  constexpr Table() : v() {
    for (int i = 0; i < 256; ++i) v[i] = 64;
    for (int i = 0; i < 26; ++i) {
      v['A' + i] = static_cast<uint8_t>(i);
      v['a' + i] = static_cast<uint8_t>(26 + i);
    }
    for (int i = 0; i < 10; ++i) v['0' + i] = static_cast<uint8_t>(52 + i);
    v[static_cast<uint8_t>('+')] = 62;
    v[static_cast<uint8_t>('/')] = 63;
  }
};
constexpr Table kTable;

}  // namespace

bool ForgivingBase64Decode(const uint8_t* in, size_t n, std::vector<uint8_t>* out) {
  out->clear();
  // Steps 1-2: count the significant characters and find where trailing padding starts.
  size_t significant = 0;
  for (size_t i = 0; i < n; ++i) {
    if (!IsAsciiWhitespace(in[i])) ++significant;
  }
  // Up to two '=' at the very end (ignoring whitespace) are removed when the length is a multiple of 4.
  size_t padding = 0;
  if (significant % 4 == 0) {
    for (size_t i = n; i > 0 && padding < 2;) {
      --i;
      if (IsAsciiWhitespace(in[i])) continue;
      if (in[i] != '=') break;
      ++padding;
    }
  }
  const size_t length = significant - padding;
  if (length % 4 == 1) return false;  // step 3
  out->reserve(length / 4 * 3 + 2);
  uint32_t buffer = 0;
  int bits = 0;
  size_t seen = 0;
  for (size_t i = 0; i < n && seen < length; ++i) {
    const uint8_t c = in[i];
    if (IsAsciiWhitespace(c)) continue;
    const uint8_t v = kTable.v[c];
    if (v == 64) return false;  // step 4 (an '=' anywhere but the removed padding included)
    ++seen;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out->push_back(static_cast<uint8_t>(buffer >> bits));
      buffer &= (1u << bits) - 1;
    }
  }
  return true;
}

}  // namespace iwn::image
