// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Parsing of the absolute URLs the network core accepts, and the origin
// allowlist (spec NET-5, NET-7).
//
// The JS side parses and serialises every URL with the WHATWG URL parser
// before it reaches native code, so this parser only has to accept the
// serialised form of http, https, ws and wss URLs (lower-case scheme and
// host, punycode already applied, dot segments resolved). It is strict:
// anything unusual is rejected rather than guessed.

#ifndef IWN_NET_URL_H_
#define IWN_NET_URL_H_

#include <string>
#include <string_view>
#include <vector>

namespace iwn::net {

struct ParsedUrl {
  std::string scheme;      // "http", "https", "ws" or "wss"
  std::string host;        // lower-case; IPv6 keeps its brackets: "[::1]"
  int port = 0;            // explicit port or the scheme default
  bool explicit_port = false;
  std::string path_query;  // "/a/b?x=1" (no fragment); "/" at least
  bool has_userinfo = false;

  bool secure() const { return scheme == "https" || scheme == "wss"; }
  // host[:port] for the Host header (port only when not the default).
  std::string HostHeader() const;
  // "https://host[:port]"; ws/wss map to http/https (their HTTP origin).
  std::string HttpOrigin() const;
  // The URL serialised again (no fragment).
  std::string Href() const;
  bool IsLoopback() const;
};

// Returns false (and sets *error) if `url` is not an absolute http(s)/ws(s) URL.
bool ParseUrl(std::string_view url, ParsedUrl* out, std::string* error = nullptr);

int DefaultPort(std::string_view scheme);

// Resolves a Location header value against the request URL. Supports absolute
// URLs, scheme-relative ("//host/x"), absolute-path ("/x") and relative
// references ("x", "../x", "?q"). Spaces, controls and non-ASCII bytes are
// percent-encoded first (as the URL parser does). Returns false if the result
// is not http(s).
bool ResolveRedirect(const ParsedUrl& base, std::string_view location, std::string* out);

// Origin allowlist (NET-5). Entries are "scheme://host[:port]" with an
// optional leading "*." label wildcard ("https://*.example.com" matches
// "a.example.com" and "a.b.example.com", not "example.com"). Requests to
// ws:// and wss:// URLs are matched as http:// and https:// origins.
class OriginAllowlist {
 public:
  struct Entry {
    std::string scheme;
    std::string host_suffix;  // without "*." for wildcards
    bool wildcard = false;
    int port = 0;
  };

  // Invalid entries are skipped and reported in *rejected (the config
  // validator already refuses them; this is defence in depth).
  void Set(const std::vector<std::string>& entries, std::vector<std::string>* rejected = nullptr);
  // Cleartext (http/ws) is only ever allowed to loopback hosts in debug builds.
  void SetDebugBuild(bool debug) { debug_ = debug; }

  enum class Verdict {
    kAllowed,
    kNotListed,         // origin not in the allowlist
    kCleartextBlocked,  // http/ws outside loopback or in a release build
  };
  Verdict Check(const ParsedUrl& url) const;
  const std::vector<Entry>& entries() const { return entries_; }

 private:
  std::vector<Entry> entries_;
  bool debug_ = false;
};

}  // namespace iwn::net

#endif  // IWN_NET_URL_H_
