// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/net/url.h"

#include <cstdlib>

#include "iwn/net/util.h"

namespace iwn::net {

int DefaultPort(std::string_view scheme) {
  if (scheme == "http" || scheme == "ws") return 80;
  if (scheme == "https" || scheme == "wss") return 443;
  return 0;
}

namespace {

bool ParsePort(std::string_view s, int* port) {
  if (s.empty() || s.size() > 5) return false;
  int v = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return false;
    v = v * 10 + (c - '0');
  }
  if (v < 1 || v > 65535) return false;
  *port = v;
  return true;
}

bool ValidHostChars(std::string_view host) {
  if (host.empty()) return false;
  if (host.front() == '[') {
    if (host.back() != ']' || host.size() < 3) return false;
    for (char c : host.substr(1, host.size() - 2)) {
      bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c == ':' || c == '.';
      if (!ok) return false;
    }
    return true;
  }
  for (char c : host) {
    bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_';
    if (!ok) return false;
  }
  return true;
}

// RFC 3986 §5.2.4.
std::string RemoveDotSegments(std::string_view in) {
  std::string input(in), output;
  while (!input.empty()) {
    if (input.rfind("../", 0) == 0) {
      input.erase(0, 3);
    } else if (input.rfind("./", 0) == 0) {
      input.erase(0, 2);
    } else if (input.rfind("/./", 0) == 0) {
      input.replace(0, 3, "/");
    } else if (input == "/.") {
      input = "/";
    } else if (input.rfind("/../", 0) == 0 || input == "/..") {
      input = input == "/.." ? "/" : input.substr(3);
      size_t slash = output.rfind('/');
      output.erase(slash == std::string::npos ? 0 : slash);
    } else if (input == "." || input == "..") {
      input.clear();
    } else {
      size_t start = input[0] == '/' ? 1 : 0;
      size_t next = input.find('/', start);
      output.append(input, 0, next);
      input.erase(0, next);
    }
  }
  return output;
}

}  // namespace

bool ParseUrl(std::string_view url, ParsedUrl* out, std::string* error) {
  auto fail = [&](const char* why) {
    if (error) *error = why;
    return false;
  };
  *out = ParsedUrl();
  size_t sep = url.find("://");
  if (sep == std::string_view::npos) return fail("not an absolute URL");
  out->scheme = AsciiLowerStr(url.substr(0, sep));
  if (DefaultPort(out->scheme) == 0) return fail("unsupported scheme");
  std::string_view rest = url.substr(sep + 3);
  size_t hash = rest.find('#');
  if (hash != std::string_view::npos) rest = rest.substr(0, hash);
  size_t path_start = rest.find_first_of("/?");
  std::string_view authority = rest.substr(0, path_start);
  std::string_view path = path_start == std::string_view::npos ? "" : rest.substr(path_start);
  size_t at = authority.rfind('@');
  if (at != std::string_view::npos) {
    out->has_userinfo = true;
    authority = authority.substr(at + 1);
  }
  std::string_view host = authority, port;
  if (!authority.empty() && authority.front() == '[') {
    size_t close = authority.find(']');
    if (close == std::string_view::npos) return fail("bad IPv6 host");
    host = authority.substr(0, close + 1);
    std::string_view after = authority.substr(close + 1);
    if (!after.empty()) {
      if (after.front() != ':') return fail("bad authority");
      port = after.substr(1);
    }
  } else {
    size_t colon = authority.rfind(':');
    if (colon != std::string_view::npos) {
      host = authority.substr(0, colon);
      port = authority.substr(colon + 1);
    }
  }
  out->host = AsciiLowerStr(host);
  if (!ValidHostChars(out->host)) return fail("bad host");
  if (!port.empty()) {
    if (!ParsePort(port, &out->port)) return fail("bad port");
    out->explicit_port = out->port != DefaultPort(out->scheme);
  } else {
    out->port = DefaultPort(out->scheme);
  }
  for (char c : path) {
    if (c == ' ' || c == '\r' || c == '\n' || c == '\t' || c == '\0') return fail("bad path");
  }
  out->path_query = path.empty() || path.front() == '?' ? "/" + std::string(path) : std::string(path);
  return true;
}

std::string ParsedUrl::HostHeader() const {
  if (port == DefaultPort(scheme)) return host;
  return host + ":" + std::to_string(port);
}

std::string ParsedUrl::HttpOrigin() const {
  std::string s = scheme == "ws" ? "http" : scheme == "wss" ? "https" : scheme;
  int def = DefaultPort(s);
  return s + "://" + host + (port == def ? "" : ":" + std::to_string(port));
}

std::string ParsedUrl::Href() const { return scheme + "://" + HostHeader() + path_query; }

bool ParsedUrl::IsLoopback() const {
  if (host == "localhost" || host == "[::1]") return true;
  // 127.0.0.0/8
  if (host.rfind("127.", 0) == 0) {
    int dots = 0;
    for (char c : host) {
      if (c == '.') ++dots;
      else if (c < '0' || c > '9') return false;
    }
    return dots == 3;
  }
  return false;
}

bool ResolveRedirect(const ParsedUrl& base, std::string_view raw_location, std::string* out) {
  // Servers send spaces and raw UTF-8 in Location; the URL parser percent-
  // encodes them (path/query percent-encode sets) and drops tabs/newlines.
  std::string encoded = PercentEncodeUrlBytes(TrimHttpWhitespace(raw_location));
  std::string_view location = encoded;
  if (location.empty()) return false;
  ParsedUrl abs;
  size_t colon = location.find(':');
  size_t first_delim = location.find_first_of("/?#");
  if (colon != std::string_view::npos && (first_delim == std::string_view::npos || colon < first_delim)) {
    if (!ParseUrl(location, &abs)) return false;
    if (abs.scheme != "http" && abs.scheme != "https") return false;
    std::string_view rest = location.substr(colon + 3);
    size_t p = rest.find_first_of("/?#");
    std::string path = p == std::string_view::npos ? "/" : std::string(rest.substr(p));
    size_t h = path.find('#');
    if (h != std::string::npos) path.erase(h);
    if (path.empty() || path[0] == '?') path = "/" + path;
    size_t q = path.find('?');
    abs.path_query = RemoveDotSegments(path.substr(0, q)) + (q == std::string::npos ? "" : path.substr(q));
    if (abs.path_query.empty() || abs.path_query[0] != '/') abs.path_query = "/" + abs.path_query;
    *out = abs.Href();
    return true;
  }
  std::string loc(location);
  size_t h = loc.find('#');
  if (h != std::string::npos) loc.erase(h);
  if (loc.rfind("//", 0) == 0) return ResolveRedirect(base, base.scheme + ":" + loc, out);
  std::string base_path = base.path_query.substr(0, base.path_query.find('?'));
  std::string target;
  if (loc.empty()) {
    target = base.path_query;
  } else if (loc[0] == '/') {
    size_t q = loc.find('?');
    target = RemoveDotSegments(loc.substr(0, q)) + (q == std::string::npos ? "" : loc.substr(q));
  } else if (loc[0] == '?') {
    target = base_path + loc;
  } else {
    size_t q = loc.find('?');
    std::string merged = base_path.substr(0, base_path.rfind('/') + 1) + loc.substr(0, q);
    target = RemoveDotSegments(merged) + (q == std::string::npos ? "" : loc.substr(q));
  }
  if (target.empty() || target[0] != '/') target = "/" + target;
  ParsedUrl r = base;
  r.path_query = target;
  *out = r.Href();
  return true;
}

void OriginAllowlist::Set(const std::vector<std::string>& entries, std::vector<std::string>* rejected) {
  entries_.clear();
  for (const std::string& raw : entries) {
    std::string s = AsciiLowerStr(TrimHttpWhitespace(raw));
    while (!s.empty() && s.back() == '/') s.pop_back();
    Entry e;
    size_t sep = s.find("://");
    bool ok = sep != std::string::npos;
    if (ok) {
      e.scheme = s.substr(0, sep);
      ok = e.scheme == "http" || e.scheme == "https";
    }
    if (ok) {
      std::string rest = s.substr(sep + 3);
      if (rest.find_first_of("/?#@") != std::string::npos) ok = false;
      if (ok && rest.rfind("*.", 0) == 0) {
        e.wildcard = true;
        rest.erase(0, 2);
      }
      ParsedUrl probe;
      if (ok && ParseUrl(e.scheme + "://" + rest + "/", &probe)) {
        e.host_suffix = probe.host;
        e.port = probe.port;
        if (e.wildcard && (e.host_suffix.find('*') != std::string::npos || e.host_suffix.front() == '[')) ok = false;
        if (e.host_suffix.find('.') == std::string::npos && e.wildcard) ok = false;  // no "*.com"
      } else {
        ok = false;
      }
    }
    if (ok) {
      entries_.push_back(e);
    } else if (rejected) {
      rejected->push_back(raw);
    }
  }
}

OriginAllowlist::Verdict OriginAllowlist::Check(const ParsedUrl& url) const {
  std::string scheme = url.scheme == "ws" ? "http" : url.scheme == "wss" ? "https" : url.scheme;
  if (scheme == "http" && !(debug_ && url.IsLoopback())) return Verdict::kCleartextBlocked;
  for (const Entry& e : entries_) {
    if (e.scheme != scheme || e.port != url.port) continue;
    if (!e.wildcard) {
      if (url.host == e.host_suffix) return Verdict::kAllowed;
      continue;
    }
    const std::string& h = url.host;
    if (h.size() > e.host_suffix.size() + 1 &&
        h.compare(h.size() - e.host_suffix.size(), e.host_suffix.size(), e.host_suffix) == 0 &&
        h[h.size() - e.host_suffix.size() - 1] == '.') {
      return Verdict::kAllowed;
    }
  }
  return Verdict::kNotListed;
}

}  // namespace iwn::net
