#include "iwn/core/url.h"

#include <algorithm>
#include <cctype>

namespace iwn {
namespace {

bool is_special_scheme(std::string_view s) {
  return s == "http" || s == "https" || s == "ws" || s == "wss" || s == "ftp" || s == "file";
}

std::string_view default_port(std::string_view scheme) {
  if (scheme == "http" || scheme == "ws") return "80";
  if (scheme == "https" || scheme == "wss") return "443";
  if (scheme == "ftp") return "21";
  return "";
}

std::string lower(std::string_view s) {
  std::string out(s);
  for (auto& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

bool is_c0_or_space(unsigned char c) { return c <= 0x20; }

const char kHex[] = "0123456789ABCDEF";

void append_encoded(std::string& out, unsigned char c) {
  out.push_back('%');
  out.push_back(kHex[c >> 4]);
  out.push_back(kHex[c & 15]);
}

bool in_path_set(unsigned char c) {
  return c <= 0x20 || c >= 0x7F || c == '"' || c == '#' || c == '<' || c == '>' || c == '?' || c == '`' ||
         c == '{' || c == '}';
}
bool in_query_set(unsigned char c, bool special) {
  return c <= 0x20 || c >= 0x7F || c == '"' || c == '#' || c == '<' || c == '>' || (special && c == '\'');
}
bool in_fragment_set(unsigned char c) {
  return c <= 0x20 || c >= 0x7F || c == '"' || c == '<' || c == '>' || c == '`';
}
bool in_c0_set(unsigned char c) { return c < 0x20 || c >= 0x7F; }

template <typename Pred>
std::string encode(std::string_view in, Pred pred) {
  std::string out;
  out.reserve(in.size());
  for (unsigned char c : in) {
    if (pred(c)) {
      append_encoded(out, c);
    } else {
      out.push_back(static_cast<char>(c));
    }
  }
  return out;
}

bool is_single_dot(std::string_view seg) {
  return seg == "." || seg == "%2e" || seg == "%2E";
}
bool is_double_dot(std::string_view seg) {
  std::string l = lower(seg);
  return l == ".." || l == ".%2e" || l == "%2e." || l == "%2e%2e";
}

// Normalises a hierarchical path (already split off query/fragment) into "/a/b".
std::string normalize_path(std::string_view raw, bool special) {
  std::vector<std::string> out;
  // raw begins with '/' (or '\' for special) or is empty.
  size_t i = 0;
  if (!raw.empty() && (raw[0] == '/' || (special && raw[0] == '\\'))) i = 1;
  std::string seg;
  auto flush = [&](bool at_end) {
    if (is_double_dot(seg)) {
      if (!out.empty()) out.pop_back();
      if (at_end) out.emplace_back();
    } else if (is_single_dot(seg)) {
      if (at_end) out.emplace_back();
    } else {
      out.push_back(encode(seg, in_path_set));
    }
    seg.clear();
  };
  for (; i < raw.size(); ++i) {
    char c = raw[i];
    if (c == '/' || (special && c == '\\')) {
      flush(false);
    } else {
      seg.push_back(c);
    }
  }
  flush(true);
  std::string path;
  for (auto& s : out) {
    path.push_back('/');
    path += s;
  }
  if (path.empty()) path = "/";
  return path;
}

struct Split {
  std::string_view before;
  std::optional<std::string_view> query;
  std::optional<std::string_view> fragment;
};

Split split_query_fragment(std::string_view s) {
  Split r;
  size_t hash = s.find('#');
  std::string_view main = s;
  if (hash != std::string_view::npos) {
    r.fragment = s.substr(hash + 1);
    main = s.substr(0, hash);
  }
  size_t q = main.find('?');
  if (q != std::string_view::npos) {
    r.query = main.substr(q + 1);
    r.before = main.substr(0, q);
  } else {
    r.before = main;
  }
  return r;
}

void set_query_fragment(Url& u, const Split& s) {
  if (s.query) {
    u.query = encode(*s.query, [&](unsigned char c) { return in_query_set(c, u.special()); });
  } else {
    u.query.reset();
  }
  if (s.fragment) {
    u.fragment = encode(*s.fragment, in_fragment_set);
  } else {
    u.fragment.reset();
  }
}

// Parses "user:pass@host:port" into u. Returns false on an invalid port or a missing host for special URLs.
bool parse_authority(std::string_view auth, Url& u) {
  size_t at = auth.rfind('@');
  if (at != std::string_view::npos) {
    std::string_view userinfo = auth.substr(0, at);
    size_t colon = userinfo.find(':');
    if (colon != std::string_view::npos) {
      u.username = std::string(userinfo.substr(0, colon));
      u.password = std::string(userinfo.substr(colon + 1));
    } else {
      u.username = std::string(userinfo);
    }
    auth = auth.substr(at + 1);
  }
  std::string_view host = auth;
  std::string_view port;
  if (!auth.empty() && auth[0] == '[') {
    size_t close = auth.find(']');
    if (close == std::string_view::npos) return false;
    host = auth.substr(0, close + 1);
    if (close + 1 < auth.size()) {
      if (auth[close + 1] != ':') return false;
      port = auth.substr(close + 2);
    }
  } else {
    size_t colon = auth.rfind(':');
    if (colon != std::string_view::npos) {
      host = auth.substr(0, colon);
      port = auth.substr(colon + 1);
    }
  }
  for (char c : port) {
    if (!std::isdigit(static_cast<unsigned char>(c))) return false;
  }
  if (!port.empty()) {
    // Strip leading zeros, check range.
    size_t nz = port.find_first_not_of('0');
    std::string p = nz == std::string_view::npos ? "0" : std::string(port.substr(nz));
    if (p.size() > 5 || std::stoi(p) > 65535) return false;
    u.port = (p == default_port(u.scheme)) ? "" : p;
  }
  u.host = u.special() ? lower(host) : std::string(host);
  for (unsigned char c : u.host) {
    if (c == ' ' || c == '#' || c == '/' || c == '<' || c == '>' || c == '?' || c == '@' || c == '\\' ||
        c == '^' || c == '|')
      return false;
  }
  if (u.special() && u.scheme != "file" && u.host.empty()) return false;
  return true;
}

// Parses "//authority/path?query#fragment" (input starts after the slashes have been consumed by the caller).
bool parse_after_slashes(std::string_view rest, Url& u) {
  size_t end = 0;
  while (end < rest.size()) {
    char c = rest[end];
    if (c == '/' || c == '?' || c == '#' || (u.special() && c == '\\')) break;
    ++end;
  }
  if (!parse_authority(rest.substr(0, end), u)) return false;
  u.has_authority = true;
  Split s = split_query_fragment(rest.substr(end));
  u.path = normalize_path(s.before, u.special());
  if (!u.special() && s.before.empty()) u.path.clear();
  set_query_fragment(u, s);
  return true;
}

}  // namespace

bool Url::special() const { return is_special_scheme(scheme); }

std::string Url::href() const {
  std::string out = scheme + ":";
  if (has_authority) {
    out += "//";
    if (!username.empty() || !password.empty()) {
      out += username;
      if (!password.empty()) out += ":" + password;
      out += "@";
    }
    out += host;
    if (!port.empty()) out += ":" + port;
  } else if (!opaque_path && path.size() > 1 && path[0] == '/' && path[1] == '/') {
    out += "/.";
  }
  out += path;
  if (query) out += "?" + *query;
  if (fragment) out += "#" + *fragment;
  return out;
}

std::string Url::origin() const {
  if (scheme == "blob") {
    auto inner = parse_url(path);
    if (inner && (inner->scheme == "http" || inner->scheme == "https")) return inner->origin();
    return "null";
  }
  if (special() && scheme != "file" && has_authority) {
    std::string o = scheme + "://" + host;
    if (!port.empty()) o += ":" + port;
    return o;
  }
  return "null";
}

std::optional<Url> parse_url(std::string_view input, const Url* base) {
  // Strip leading/trailing C0 controls and spaces; remove ASCII tab and newline anywhere.
  while (!input.empty() && is_c0_or_space(static_cast<unsigned char>(input.front()))) input.remove_prefix(1);
  while (!input.empty() && is_c0_or_space(static_cast<unsigned char>(input.back()))) input.remove_suffix(1);
  std::string cleaned;
  cleaned.reserve(input.size());
  for (char c : input) {
    if (c != '\t' && c != '\n' && c != '\r') cleaned.push_back(c);
  }
  std::string_view in = cleaned;

  // Scheme.
  size_t i = 0;
  std::string scheme;
  if (!in.empty() && std::isalpha(static_cast<unsigned char>(in[0]))) {
    i = 1;
    while (i < in.size() && (std::isalnum(static_cast<unsigned char>(in[i])) || in[i] == '+' || in[i] == '-' ||
                             in[i] == '.'))
      ++i;
    if (i < in.size() && in[i] == ':') {
      scheme = lower(in.substr(0, i));
    }
  }

  if (!scheme.empty()) {
    std::string_view rest = in.substr(i + 1);
    Url u;
    u.scheme = scheme;
    if (u.special()) {
      bool slashes = !rest.empty() && (rest[0] == '/' || rest[0] == '\\');
      if (!slashes && base && base->scheme == scheme && !base->opaque_path) {
        // "special relative or authority" with a same-scheme base: treat as relative reference.
        return parse_url(rest, base);
      }
      size_t s = 0;
      while (s < rest.size() && (rest[s] == '/' || rest[s] == '\\')) ++s;
      if (scheme == "file") {
        // file:///path or file://host/path
        if (s >= 2) {
          if (!parse_after_slashes(rest.substr(2), u)) return std::nullopt;
          if (u.host == "localhost") u.host.clear();
        } else {
          u.has_authority = true;
          Split sp = split_query_fragment(rest);
          u.path = normalize_path(sp.before, true);
          set_query_fragment(u, sp);
        }
        return u;
      }
      if (!parse_after_slashes(rest.substr(s), u)) return std::nullopt;
      return u;
    }
    // Non-special.
    if (rest.size() >= 2 && rest[0] == '/' && rest[1] == '/') {
      if (!parse_after_slashes(rest.substr(2), u)) return std::nullopt;
      return u;
    }
    Split sp = split_query_fragment(rest);
    if (!sp.before.empty() && sp.before[0] == '/') {
      u.path = normalize_path(sp.before, false);
    } else {
      u.opaque_path = true;
      u.path = encode(sp.before, in_c0_set);
    }
    set_query_fragment(u, sp);
    return u;
  }

  // Relative reference.
  if (!base) return std::nullopt;
  Url u = *base;
  if (base->opaque_path) {
    if (!in.empty() && in[0] == '#') {
      u.fragment = encode(in.substr(1), in_fragment_set);
      return u;
    }
    return std::nullopt;
  }
  const bool special = u.special();
  auto is_slash = [&](char c) { return c == '/' || (special && c == '\\'); };
  if (in.size() >= 2 && is_slash(in[0]) && is_slash(in[1])) {
    Url r;
    r.scheme = u.scheme;
    if (!parse_after_slashes(in.substr(2), r)) return std::nullopt;
    return r;
  }
  if (!in.empty() && is_slash(in[0])) {
    Split sp = split_query_fragment(in);
    u.path = normalize_path(sp.before, special);
    set_query_fragment(u, sp);
    return u;
  }
  if (in.empty()) {
    u.fragment.reset();
    return u;
  }
  if (in[0] == '?') {
    Split sp = split_query_fragment(in);
    set_query_fragment(u, sp);
    return u;
  }
  if (in[0] == '#') {
    u.fragment = encode(in.substr(1), in_fragment_set);
    return u;
  }
  // Merge with the base path's directory.
  Split sp = split_query_fragment(in);
  std::string dir = base->path;
  size_t last = dir.rfind('/');
  dir = (last == std::string::npos) ? std::string("/") : dir.substr(0, last + 1);
  std::string merged = dir + std::string(sp.before);
  u.path = normalize_path(merged, special);
  set_query_fragment(u, sp);
  return u;
}

std::optional<Url> resolve_module_specifier(std::string_view specifier, const Url& referrer, SpecifierError* error) {
  if (error) *error = SpecifierError::kNone;
  bool relative = specifier.substr(0, 1) == "/" || specifier.substr(0, 2) == "./" || specifier.substr(0, 3) == "../";
  if (relative) {
    auto u = parse_url(specifier, &referrer);
    if (!u && error) *error = SpecifierError::kInvalid;
    return u;
  }
  auto u = parse_url(specifier, nullptr);
  if (!u) {
    if (error) *error = SpecifierError::kBare;
    return std::nullopt;
  }
  return u;
}

std::string percent_decode(std::string_view in) {
  auto hexval = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    if (in[i] == '%' && i + 2 < in.size()) {
      int h = hexval(in[i + 1]), l = hexval(in[i + 2]);
      if (h >= 0 && l >= 0) {
        out.push_back(static_cast<char>(h * 16 + l));
        i += 2;
        continue;
      }
    }
    out.push_back(in[i]);
  }
  return out;
}

std::optional<std::string> app_asset_path(const Url& url, const Url& app_origin) {
  if (url.origin() != app_origin.origin() || url.scheme == "blob") return std::nullopt;
  std::string decoded = percent_decode(url.path);
  if (decoded.empty() || decoded[0] != '/') return std::nullopt;
  if (decoded.find('\0') != std::string::npos || decoded.find('\\') != std::string::npos) return std::nullopt;
  // Reject any ".." segment that survived (e.g. "%2e%2e" decoded after normalisation already removed real ones,
  // or "/a/%2E%2E/b" style escapes the parser normalised; a decoded "/../" means an encoded slash trick).
  std::string rel = decoded.substr(1);
  size_t start = 0;
  while (start <= rel.size()) {
    size_t end = rel.find('/', start);
    if (end == std::string::npos) end = rel.size();
    std::string_view seg(rel.data() + start, end - start);
    if (seg == "..") return std::nullopt;
    start = end + 1;
  }
  if (rel.empty() || rel.back() == '/') rel += "index.html";
  return rel;
}

}  // namespace iwn
