// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/net/util.h"

#include <pthread.h>

#include <cstdlib>
#include <cstring>

#if defined(__ANDROID__)
#include <stdlib.h>  // arc4random_buf
#else
#include <sys/random.h>
#include <cerrno>
#endif

namespace iwn::net {

void SetCurrentThreadName(const char* name) {
  char buf[16];
  std::strncpy(buf, name, sizeof buf - 1);
  buf[sizeof buf - 1] = '\0';
  pthread_setname_np(pthread_self(), buf);
}

std::string PercentEncodeUrlBytes(std::string_view in) {
  static const char kHex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(in.size());
  for (char ch : in) {
    unsigned char c = static_cast<unsigned char>(ch);
    if (c == '\t' || c == '\n' || c == '\r') continue;
    bool encode = c <= 0x20 || c >= 0x7F || c == '"' || c == '<' || c == '>' || c == '`' || c == '{' || c == '}';
    if (!encode) {
      out.push_back(ch);
      continue;
    }
    out.push_back('%');
    out.push_back(kHex[c >> 4]);
    out.push_back(kHex[c & 15]);
  }
  return out;
}

char AsciiLower(char c) { return (c >= 'A' && c <= 'Z') ? static_cast<char>(c + 32) : c; }

std::string AsciiLowerStr(std::string_view s) {
  std::string out(s);
  for (char& c : out) c = AsciiLower(c);
  return out;
}

bool EqualsIgnoreCase(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    if (AsciiLower(a[i]) != AsciiLower(b[i])) return false;
  }
  return true;
}

std::string_view TrimHttpWhitespace(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  return s;
}

bool HeaderHasToken(std::string_view value, std::string_view token) {
  while (!value.empty()) {
    size_t comma = value.find(',');
    std::string_view part = TrimHttpWhitespace(value.substr(0, comma));
    if (EqualsIgnoreCase(part, token)) return true;
    if (comma == std::string_view::npos) break;
    value.remove_prefix(comma + 1);
  }
  return false;
}

std::string Base64Encode(const uint8_t* data, size_t len) {
  static const char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < len; i += 3) {
    uint32_t v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
    out.push_back(kAlphabet[v & 63]);
  }
  if (i + 1 == len) {
    uint32_t v = data[i] << 16;
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.append("==");
  } else if (i + 2 == len) {
    uint32_t v = (data[i] << 16) | (data[i + 1] << 8);
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
    out.push_back('=');
  }
  return out;
}

namespace {
inline uint32_t Rotl(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }
}  // namespace

void Sha1(const uint8_t* data, size_t len, uint8_t out[20]) {
  uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
  // Message padding (FIPS 180-4 §5.1.1): 0x80, zeros, 64-bit big-endian bit length.
  uint64_t bit_len = static_cast<uint64_t>(len) * 8;
  size_t padded = ((len + 8) / 64 + 1) * 64;
  std::vector<uint8_t> msg(padded, 0);
  if (len) std::memcpy(msg.data(), data, len);
  msg[len] = 0x80;
  for (int i = 0; i < 8; ++i) msg[padded - 1 - i] = static_cast<uint8_t>(bit_len >> (8 * i));
  uint32_t w[80];
  for (size_t off = 0; off < padded; off += 64) {
    for (int t = 0; t < 16; ++t) {
      const uint8_t* p = &msg[off + t * 4];
      w[t] = (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3];
    }
    for (int t = 16; t < 80; ++t) w[t] = Rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
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
      uint32_t temp = Rotl(a, 5) + f + e + k + w[t];
      e = d;
      d = c;
      c = Rotl(b, 30);
      b = a;
      a = temp;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
  }
  for (int i = 0; i < 5; ++i) {
    out[i * 4] = static_cast<uint8_t>(h[i] >> 24);
    out[i * 4 + 1] = static_cast<uint8_t>(h[i] >> 16);
    out[i * 4 + 2] = static_cast<uint8_t>(h[i] >> 8);
    out[i * 4 + 3] = static_cast<uint8_t>(h[i]);
  }
}

void SecureRandom(uint8_t* out, size_t len) {
#if defined(__ANDROID__)
  arc4random_buf(out, len);
#else
  size_t done = 0;
  while (done < len) {
    ssize_t n = getrandom(out + done, len - done, 0);
    if (n < 0) {
      if (errno == EINTR) continue;
      std::abort();
    }
    done += static_cast<size_t>(n);
  }
#endif
}

namespace {
int HexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
}  // namespace

bool PercentDecode(std::string_view in, std::string* out) {
  out->clear();
  out->reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    char c = in[i];
    if (c != '%') {
      out->push_back(c);
      continue;
    }
    if (i + 2 >= in.size()) return false;
    int hi = HexValue(in[i + 1]), lo = HexValue(in[i + 2]);
    if (hi < 0 || lo < 0) return false;
    out->push_back(static_cast<char>(hi * 16 + lo));
    i += 2;
  }
  return true;
}

bool IsHttpToken(std::string_view s) {
  if (s.empty()) return false;
  for (unsigned char c : s) {
    if (c >= 'a' && c <= 'z') continue;
    if (c >= 'A' && c <= 'Z') continue;
    if (c >= '0' && c <= '9') continue;
    if (std::strchr("!#$%&'*+-.^_`|~", c) && c != 0) continue;
    return false;
  }
  return true;
}

bool IsValidHeaderValue(std::string_view s) {
  for (char c : s) {
    if (c == '\r' || c == '\n' || c == '\0') return false;
  }
  return true;
}

bool Utf8Validator::Feed(const uint8_t* data, size_t len) {
  // Byte-at-a-time DFA following the Unicode well-formed byte sequence table
  // (Unicode 15, table 3-7).
  for (size_t i = 0; i < len; ++i) {
    uint8_t b = data[i];
    if (need_ == 0) {
      if (b < 0x80) continue;
      lower_ = 0x80;
      upper_ = 0xBF;
      if (b >= 0xC2 && b <= 0xDF) {
        need_ = 1;
      } else if (b >= 0xE0 && b <= 0xEF) {
        need_ = 2;
        if (b == 0xE0) lower_ = 0xA0;
        if (b == 0xED) upper_ = 0x9F;
      } else if (b >= 0xF0 && b <= 0xF4) {
        need_ = 3;
        if (b == 0xF0) lower_ = 0x90;
        if (b == 0xF4) upper_ = 0x8F;
      } else {
        return false;
      }
      continue;
    }
    if (b < lower_ || b > upper_) return false;
    lower_ = 0x80;
    upper_ = 0xBF;
    --need_;
  }
  return true;
}

}  // namespace iwn::net
