/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/core/text.h"

#include <cctype>
#include <cstring>

#include "iwn/core/url.h"

namespace iwn {
namespace {

inline uint32_t rotl(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }
inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

// Merkle-Damgard padding shared by SHA-1 and SHA-256 (FIPS 180-4 §5.1.1): 0x80, zeros, 64-bit big-endian length.
// Full 64-byte blocks are fed straight from the input; only the tail is copied (into at most two blocks).
template <typename Fn>
void for_each_padded_block(const void* data, size_t len, Fn&& block) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  size_t full = len / 64 * 64;
  for (size_t off = 0; off < full; off += 64) block(p + off);
  uint8_t tail[128] = {};
  size_t rest = len - full;
  if (rest) memcpy(tail, p + full, rest);
  tail[rest] = 0x80;
  size_t tail_len = rest + 1 + 8 <= 64 ? 64 : 128;
  uint64_t bits = static_cast<uint64_t>(len) * 8;
  for (int i = 0; i < 8; ++i) tail[tail_len - 1 - i] = static_cast<uint8_t>(bits >> (i * 8));
  block(tail);
  if (tail_len == 128) block(tail + 64);
}

inline uint32_t load_be32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

}  // namespace

std::array<uint8_t, 20> sha1(const void* data, size_t len) {
  uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
  uint32_t w[80];
  for_each_padded_block(data, len, [&](const uint8_t* blk) {
    for (int t = 0; t < 16; ++t) w[t] = load_be32(blk + t * 4);
    for (int t = 16; t < 80; ++t) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int t = 0; t < 80; ++t) {
      uint32_t f, k;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5A827999u;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1u;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDCu;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6u;
      }
      uint32_t temp = rotl(a, 5) + f + e + k + w[t];
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
  });
  std::array<uint8_t, 20> out{};
  for (int i = 0; i < 5; ++i) {
    out[i * 4] = static_cast<uint8_t>(h[i] >> 24);
    out[i * 4 + 1] = static_cast<uint8_t>(h[i] >> 16);
    out[i * 4 + 2] = static_cast<uint8_t>(h[i] >> 8);
    out[i * 4 + 3] = static_cast<uint8_t>(h[i]);
  }
  return out;
}

std::array<uint8_t, 32> sha256(const void* data, size_t len) {
  static const uint32_t k[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  uint32_t w[64];
  for_each_padded_block(data, len, [&](const uint8_t* blk) {
    for (int t = 0; t < 16; ++t) w[t] = load_be32(blk + t * 4);
    for (int t = 16; t < 64; ++t) {
      uint32_t s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >> 3);
      uint32_t s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >> 10);
      w[t] = w[t - 16] + s0 + w[t - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int t = 0; t < 64; ++t) {
      uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = hh + S1 + ch + k[t] + w[t];
      uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  });
  std::array<uint8_t, 32> out{};
  for (int i = 0; i < 8; ++i) {
    out[i * 4] = static_cast<uint8_t>(h[i] >> 24);
    out[i * 4 + 1] = static_cast<uint8_t>(h[i] >> 16);
    out[i * 4 + 2] = static_cast<uint8_t>(h[i] >> 8);
    out[i * 4 + 3] = static_cast<uint8_t>(h[i]);
  }
  return out;
}

namespace {
constexpr uint64_t kP1 = 0x9E3779B185EBCA87ull, kP2 = 0xC2B2AE3D27D4EB4Full, kP3 = 0x165667B19E3779F9ull;
inline uint64_t rotl64(uint64_t x, int n) { return (x << n) | (x >> (64 - n)); }
inline uint64_t load_le64(const uint8_t* p) {
  uint64_t x;
  memcpy(&x, p, 8);
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
  x = __builtin_bswap64(x);
#endif
  return x;
}
inline uint64_t lane(uint64_t acc, uint64_t in) { return rotl64(acc + in * kP2, 31) * kP1; }
inline uint64_t avalanche(uint64_t h) {
  h ^= h >> 33;
  h *= kP2;
  h ^= h >> 29;
  h *= kP3;
  h ^= h >> 32;
  return h;
}
}  // namespace

std::array<uint8_t, 16> fast_hash128(const void* data, size_t len) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  uint64_t v[4] = {kP1 + kP2, kP2, 0, 0 - kP1};
  size_t i = 0;
  for (; i + 32 <= len; i += 32) {
    v[0] = lane(v[0], load_le64(p + i));
    v[1] = lane(v[1], load_le64(p + i + 8));
    v[2] = lane(v[2], load_le64(p + i + 16));
    v[3] = lane(v[3], load_le64(p + i + 24));
  }
  uint8_t tail[32] = {};
  memcpy(tail, p + i, len - i);
  tail[len - i] = 0x80;  // unambiguous end marker; the length is mixed in below as well
  for (int k = 0; k < 4; ++k) v[k] = lane(v[k], load_le64(tail + k * 8));
  uint64_t n = static_cast<uint64_t>(len);
  uint64_t a = avalanche(rotl64(v[0], 1) + rotl64(v[1], 7) + rotl64(v[2], 12) + rotl64(v[3], 18) + n * kP3);
  uint64_t b = avalanche((v[0] ^ rotl64(v[2], 29)) * kP3 + (v[1] ^ rotl64(v[3], 41)) * kP1 + (n ^ a));
  std::array<uint8_t, 16> out{};
  for (int k = 0; k < 8; ++k) {
    out[k] = static_cast<uint8_t>(a >> (k * 8));
    out[8 + k] = static_cast<uint8_t>(b >> (k * 8));
  }
  return out;
}

std::string to_hex(const uint8_t* data, size_t len) {
  static const char hex[] = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; ++i) {
    out.push_back(hex[data[i] >> 4]);
    out.push_back(hex[data[i] & 15]);
  }
  return out;
}

std::string base64_encode(const void* data, size_t len) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < len; i += 3) {
    uint32_t v = (uint32_t(p[i]) << 16) | (uint32_t(p[i + 1]) << 8) | p[i + 2];
    out.push_back(kB64[v >> 18]);
    out.push_back(kB64[(v >> 12) & 63]);
    out.push_back(kB64[(v >> 6) & 63]);
    out.push_back(kB64[v & 63]);
  }
  if (i < len) {
    uint32_t v = uint32_t(p[i]) << 16;
    if (i + 1 < len) v |= uint32_t(p[i + 1]) << 8;
    out.push_back(kB64[v >> 18]);
    out.push_back(kB64[(v >> 12) & 63]);
    out.push_back(i + 1 < len ? kB64[(v >> 6) & 63] : '=');
    out.push_back('=');
  }
  return out;
}

std::optional<std::vector<uint8_t>> base64_decode(std::string_view in) {
  std::string s;
  s.reserve(in.size());
  for (char c : in) {
    if (c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r') continue;
    s.push_back(c);
  }
  if (s.size() % 4 == 0 && !s.empty()) {
    if (s.back() == '=') s.pop_back();
    if (!s.empty() && s.back() == '=') s.pop_back();
  }
  if (s.size() % 4 == 1) return std::nullopt;
  std::vector<uint8_t> out;
  out.reserve(s.size() * 3 / 4);
  uint32_t buffer = 0;
  int bits = 0;
  for (char c : s) {
    int v;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '+') v = 62;
    else if (c == '/') v = 63;
    else return std::nullopt;
    buffer = (buffer << 6) | static_cast<uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((buffer >> bits) & 0xFF));
    }
  }
  return out;
}

std::string_view trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  return s;
}

bool iequals(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    if (std::tolower(static_cast<unsigned char>(a[i])) != std::tolower(static_cast<unsigned char>(b[i]))) return false;
  }
  return true;
}

bool header_has_token(std::string_view value, std::string_view token) {
  size_t start = 0;
  while (start <= value.size()) {
    size_t comma = value.find(',', start);
    if (comma == std::string_view::npos) comma = value.size();
    if (iequals(trim(value.substr(start, comma - start)), token)) return true;
    start = comma + 1;
  }
  return false;
}

std::optional<DataUrl> decode_data_url(std::string_view url) {
  // Fetch §"data: URL processor": scheme check, split at the first ',', percent-decode the body, ";base64".
  std::string_view s = trim(url);
  if (s.size() < 5 || !iequals(s.substr(0, 5), "data:")) return std::nullopt;
  s.remove_prefix(5);
  size_t hash = s.find('#');
  if (hash != std::string_view::npos) s = s.substr(0, hash);
  size_t comma = s.find(',');
  if (comma == std::string_view::npos) return std::nullopt;
  std::string mime(trim(s.substr(0, comma)));
  std::string body = percent_decode(s.substr(comma + 1));
  bool b64 = false;
  // ";base64" at the end of the mime part (ASCII case-insensitive, optional spaces before it).
  if (mime.size() >= 7) {
    std::string_view tail(mime);
    size_t semi = tail.rfind(';');
    if (semi != std::string_view::npos && iequals(trim(tail.substr(semi + 1)), "base64")) {
      b64 = true;
      mime = std::string(trim(tail.substr(0, semi)));
    }
  }
  DataUrl out;
  if (b64) {
    auto bytes = base64_decode(body);
    if (!bytes) return std::nullopt;
    out.body = std::move(*bytes);
  } else {
    out.body.assign(body.begin(), body.end());
  }
  if (mime.empty() || mime[0] == ';') mime = "text/plain" + mime;
  if (mime == "text/plain") mime = "text/plain;charset=US-ASCII";
  out.mime_type = mime;
  return out;
}

std::string_view mime_type_for_path(std::string_view path) {
  struct Entry {
    const char* ext;
    const char* mime;
  };
  static const Entry kTable[] = {
      {"html", "text/html"},          {"htm", "text/html"},
      {"js", "text/javascript"},      {"mjs", "text/javascript"},
      {"css", "text/css"},            {"json", "application/json"},
      {"map", "application/json"},    {"wasm", "application/wasm"},
      {"png", "image/png"},           {"jpg", "image/jpeg"},
      {"jpeg", "image/jpeg"},         {"webp", "image/webp"},
      {"gif", "image/gif"},           {"svg", "image/svg+xml"},
      {"ktx2", "image/ktx2"},         {"basis", "application/octet-stream"},
      {"glb", "model/gltf-binary"},   {"gltf", "model/gltf+json"},
      {"bin", "application/octet-stream"}, {"hdr", "image/vnd.radiance"},
      {"exr", "image/x-exr"},         {"mp3", "audio/mpeg"},
      {"ogg", "audio/ogg"},           {"wav", "audio/wav"},
      {"m4a", "audio/mp4"},           {"ttf", "font/ttf"},
      {"otf", "font/otf"},            {"woff2", "font/woff2"},
      {"woff", "font/woff"},          {"txt", "text/plain"},
  };
  size_t slash = path.rfind('/');
  std::string_view name = slash == std::string_view::npos ? path : path.substr(slash + 1);
  size_t dot = name.rfind('.');
  if (dot == std::string_view::npos) return "application/octet-stream";
  std::string_view ext = name.substr(dot + 1);
  for (const auto& e : kTable) {
    if (iequals(ext, e.ext)) return e.mime;
  }
  return "application/octet-stream";
}

bool is_javascript_mime(std::string_view mime) {
  size_t semi = mime.find(';');
  std::string_view essence = trim(mime.substr(0, semi));
  static const char* kJs[] = {"application/ecmascript", "application/javascript", "application/x-ecmascript",
                              "application/x-javascript", "text/ecmascript", "text/javascript",
                              "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
                              "text/javascript1.3", "text/javascript1.4", "text/javascript1.5",
                              "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript"};
  for (const char* m : kJs) {
    if (iequals(essence, m)) return true;
  }
  return false;
}

namespace {
bool js_ident_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '$' ||
         static_cast<unsigned char>(c) >= 0x80;
}
// Skips whitespace and comments from i; returns the new index.
size_t js_skip_space(std::string_view s, size_t i) {
  while (i < s.size()) {
    char c = s[i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
      ++i;
    } else if (c == '/' && i + 1 < s.size() && s[i + 1] == '/') {
      size_t e = s.find('\n', i);
      i = e == std::string_view::npos ? s.size() : e + 1;
    } else if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      size_t e = s.find("*/", i + 2);
      i = e == std::string_view::npos ? s.size() : e + 2;
    } else {
      break;
    }
  }
  return i;
}
// Reads a '...' or "..." literal starting at i (s[i] is the quote). Returns the index after it; *out gets the body
// with simple escapes resolved (specifiers rarely contain any).
size_t js_read_string(std::string_view s, size_t i, std::string* out) {
  char q = s[i++];
  std::string body;
  while (i < s.size() && s[i] != q) {
    if (s[i] == '\\' && i + 1 < s.size()) {
      body.push_back(s[i + 1]);
      i += 2;
      continue;
    }
    if (s[i] == '\n') break;  // unterminated
    body.push_back(s[i++]);
  }
  if (out) *out = std::move(body);
  return i < s.size() ? i + 1 : i;
}
bool js_keyword_at(std::string_view s, size_t i, std::string_view kw) {
  if (s.compare(i, kw.size(), kw) != 0) return false;
  if (i > 0 && (js_ident_char(s[i - 1]) || s[i - 1] == '.')) return false;
  size_t e = i + kw.size();
  return e >= s.size() || !js_ident_char(s[e]);
}
}  // namespace

std::vector<std::string> scan_static_import_specifiers(std::string_view s, size_t max_count) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < s.size() && out.size() < max_count) {
    char c = s[i];
    if (c == '/' && i + 1 < s.size() && (s[i + 1] == '/' || s[i + 1] == '*')) {
      i = js_skip_space(s, i);
    } else if (c == '\'' || c == '"') {
      i = js_read_string(s, i, nullptr);
    } else if (c == '`') {
      size_t e = i + 1;
      while (e < s.size() && s[e] != '`') e += s[e] == '\\' ? 2 : 1;
      i = e < s.size() ? e + 1 : s.size();
    } else if (c == 'i' && js_keyword_at(s, i, "import")) {
      size_t j = js_skip_space(s, i + 6);
      if (j < s.size() && (s[j] == '\'' || s[j] == '"')) {
        std::string spec;
        i = js_read_string(s, j, &spec);
        if (!spec.empty()) out.push_back(std::move(spec));
      } else {
        i = j;  // `import x from` continues at `from`; `import(` / `import.meta` are not static imports
      }
    } else if (c == 'f' && js_keyword_at(s, i, "from")) {
      size_t j = js_skip_space(s, i + 4);
      if (j < s.size() && (s[j] == '\'' || s[j] == '"')) {
        std::string spec;
        i = js_read_string(s, j, &spec);
        if (!spec.empty()) out.push_back(std::move(spec));
      } else {
        i = j > i + 4 ? j : i + 4;
      }
    } else {
      ++i;
    }
  }
  return out;
}

}  // namespace iwn
