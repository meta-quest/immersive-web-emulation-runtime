// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Small helpers shared by the HTTP and WebSocket cores: ASCII case folding,
// base64 (RFC 4648 §4), SHA-1 (FIPS 180-4, needed only for the RFC 6455
// accept key), a CSPRNG and percent-decoding.

#ifndef IWN_NET_UTIL_H_
#define IWN_NET_UTIL_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace iwn::net {

char AsciiLower(char c);
std::string AsciiLowerStr(std::string_view s);
bool EqualsIgnoreCase(std::string_view a, std::string_view b);
std::string_view TrimHttpWhitespace(std::string_view s);
// True if the comma-separated header value contains `token` (case-insensitive).
bool HeaderHasToken(std::string_view value, std::string_view token);

std::string Base64Encode(const uint8_t* data, size_t len);
inline std::string Base64Encode(std::string_view s) {
  return Base64Encode(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

// 20-byte digest.
void Sha1(const uint8_t* data, size_t len, uint8_t out[20]);

// Fills `out` from the OS CSPRNG (getrandom/arc4random). Never fails silently:
// aborts if the OS cannot provide randomness.
void SecureRandom(uint8_t* out, size_t len);

// Percent-decodes one URL path segment. Returns false on a malformed escape.
bool PercentDecode(std::string_view in, std::string* out);

// True for a valid HTTP token (RFC 9110 §5.6.2), used for methods and header names.
bool IsHttpToken(std::string_view s);
// True if the header value has no CR, LF or NUL (RFC 9110 §5.5).
bool IsValidHeaderValue(std::string_view s);

// Names the calling thread (visible in /proc, logcat ANRs, simpleperf; PROC-4).
// At most 15 characters are kept.
void SetCurrentThreadName(const char* name);

// Percent-encodes the bytes of a URL reference that cannot appear raw in a
// request target: C0 controls, space, DEL, non-ASCII bytes and " < > ` { }
// (WHATWG URL path/query percent-encode sets). Tabs and newlines are removed
// (URL parser). Existing escapes are kept.
std::string PercentEncodeUrlBytes(std::string_view in);

// Validates UTF-8 incrementally (RFC 3629, no overlongs, no surrogates).
class Utf8Validator {
 public:
  // Returns false as soon as the input cannot be valid UTF-8.
  bool Feed(const uint8_t* data, size_t len);
  // True if the input so far ends on a code point boundary.
  bool Complete() const { return need_ == 0; }
  void Reset() { need_ = 0; lower_ = 0x80; upper_ = 0xBF; }

 private:
  int need_ = 0;
  uint8_t lower_ = 0x80;
  uint8_t upper_ = 0xBF;
};

}  // namespace iwn::net

#endif  // IWN_NET_UTIL_H_
