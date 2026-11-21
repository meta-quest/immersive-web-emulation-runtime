/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// URL handling the module loader needs without V8 (MOD-2, MOD-3, NET-1, NET-4, NET-12), written from the WHATWG
// URL Standard (basic URL parser, special schemes, path normalisation) and HTML's "resolve a module specifier".
// It is deliberately a subset: no IDNA/punycode, no IPv6 host parsing beyond pass-through, no setters. The full
// URL class for page code is the web glue's job (NET-13).
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace iwn {

struct Url {
  std::string scheme;    // lower case, without ':'
  std::string username;  // as written (percent-encoded)
  std::string password;
  std::string host;      // lower case for special schemes; empty for opaque URLs
  std::string port;      // empty = default port
  std::string path;      // "/a/b" for hierarchical URLs; the opaque path for data:, blob:, etc.
  std::optional<std::string> query;     // without '?'
  std::optional<std::string> fragment;  // without '#'
  bool opaque_path = false;
  bool has_authority = false;  // "//" present (always for special schemes)

  bool special() const;
  // Serialisation per the URL Standard (href).
  std::string href() const;
  // "scheme://host[:port]" for special schemes with a host; "null" otherwise.
  std::string origin() const;
};

// Parses `input` against an optional base (WHATWG basic URL parser, subset). Returns nullopt on failure.
std::optional<Url> parse_url(std::string_view input, const Url* base = nullptr);

enum class SpecifierError { kNone, kBare, kInvalid };
// HTML "resolve a module specifier" without import maps: "/", "./", "../" prefixes resolve against the referrer,
// otherwise the specifier must parse as an absolute URL; anything else is a bare specifier (TypeError).
std::optional<Url> resolve_module_specifier(std::string_view specifier, const Url& referrer, SpecifierError* error);

// Percent-decodes bytes ("%41" -> "A"); malformed escapes are kept literally.
std::string percent_decode(std::string_view in);

// Maps a URL in the app's origin to a relative asset path inside the dist ("assets/main.js"). Percent-decoded,
// "/" maps to "index.html", directory URLs map to "<dir>/index.html". Returns nullopt for other origins and for
// paths that would leave the dist after normalisation (NET-4: treated as missing) or contain NUL / backslashes.
std::optional<std::string> app_asset_path(const Url& url, const Url& app_origin);

}  // namespace iwn
