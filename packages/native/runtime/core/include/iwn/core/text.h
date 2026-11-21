/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Small V8-free text and byte utilities: hashes (SHA-1 for the WebSocket accept key and SHA-256, written from
// FIPS 180-4; a fast 128-bit hash for code-cache keys), base64 (RFC 4648; "forgiving-base64 decode" from the Infra
// standard), data: URLs (Fetch standard, "data: URL processor"), the MIME table (NET-2) and case-insensitive
// helpers (RFC 9110).
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace iwn {

std::array<uint8_t, 20> sha1(const void* data, size_t len);
std::array<uint8_t, 32> sha256(const void* data, size_t len);
// Fast non-cryptographic 128-bit content hash: 4 independent 64-bit multiply-rotate lanes (the xxHash64 round and
// primes from its public format spec), 32 bytes per step, then an avalanche; several GB/s. For change detection of trusted local content (code-cache keys and checksums), not
// for anything adversarial.
std::array<uint8_t, 16> fast_hash128(const void* data, size_t len);
std::string to_hex(const uint8_t* data, size_t len);
template <size_t N>
std::string to_hex(const std::array<uint8_t, N>& a) {
  return to_hex(a.data(), N);
}

std::string base64_encode(const void* data, size_t len);
// Forgiving-base64 decode: strips ASCII whitespace, accepts missing padding; nullopt if invalid.
std::optional<std::vector<uint8_t>> base64_decode(std::string_view in);

struct DataUrl {
  std::string mime_type;  // e.g. "text/javascript" (essence plus parameters as written), default text/plain
  std::vector<uint8_t> body;
};
// Decodes a full "data:..." URL string; nullopt if it is not a valid data: URL.
std::optional<DataUrl> decode_data_url(std::string_view url);

// Content-Type for an asset path by extension (NET-2); application/octet-stream when unknown.
std::string_view mime_type_for_path(std::string_view path);
// True for JavaScript MIME types (HTML "JavaScript MIME type essence match").
bool is_javascript_mime(std::string_view mime);

// Static import/export specifiers of an ES module source (`import "x"`, `import ... from "x"`,
// `export ... from "x"`), skipping comments, string bodies and `import(`/`import.meta`. A lexical heuristic used only
// to prefetch a dynamic import's graph off the JS thread (PROC-2): V8 still parses the real requests, so a miss or
// a false positive only costs a synchronous read or a wasted one. At most max_count results.
std::vector<std::string> scan_static_import_specifiers(std::string_view js, size_t max_count = 512);

bool iequals(std::string_view a, std::string_view b);
// True if a comma-separated header value contains `token` (case-insensitive, whitespace trimmed).
bool header_has_token(std::string_view value, std::string_view token);
std::string_view trim(std::string_view s);

}  // namespace iwn
