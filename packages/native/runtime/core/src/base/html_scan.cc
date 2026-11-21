/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/core/html_scan.h"

#include <cctype>
#include <map>

#include "iwn/core/text.h"

namespace iwn {
namespace {

std::string lower(std::string_view s) {
  std::string out(s);
  for (auto& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

bool is_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'; }

// Finds a case-insensitive needle starting at pos.
size_t ifind(std::string_view hay, std::string_view needle, size_t pos) {
  if (needle.empty()) return pos;
  for (size_t i = pos; i + needle.size() <= hay.size(); ++i) {
    if (iequals(hay.substr(i, needle.size()), needle)) return i;
  }
  return std::string_view::npos;
}

struct Tag {
  std::string name;
  std::map<std::string, std::string> attrs;
  bool self_closing = false;
  size_t end = 0;  // index after '>'
};

// Parses a start tag at html[pos] == '<'. Returns false if it is not a start tag.
bool parse_start_tag(std::string_view html, size_t pos, Tag& tag) {
  size_t i = pos + 1;
  if (i >= html.size() || !std::isalpha(static_cast<unsigned char>(html[i]))) return false;
  size_t name_start = i;
  while (i < html.size() && !is_space(html[i]) && html[i] != '>' && html[i] != '/') ++i;
  tag.name = lower(html.substr(name_start, i - name_start));
  for (;;) {
    while (i < html.size() && (is_space(html[i]) || html[i] == '/')) {
      if (html[i] == '/') tag.self_closing = true;
      ++i;
    }
    if (i >= html.size()) {
      tag.end = html.size();
      return true;
    }
    if (html[i] == '>') {
      tag.end = i + 1;
      return true;
    }
    tag.self_closing = false;
    size_t an = i;
    while (i < html.size() && !is_space(html[i]) && html[i] != '>' && html[i] != '=' && html[i] != '/') ++i;
    std::string name = lower(html.substr(an, i - an));
    while (i < html.size() && is_space(html[i])) ++i;
    std::string value;
    if (i < html.size() && html[i] == '=') {
      ++i;
      while (i < html.size() && is_space(html[i])) ++i;
      if (i < html.size() && (html[i] == '"' || html[i] == '\'')) {
        char q = html[i++];
        size_t vs = i;
        while (i < html.size() && html[i] != q) ++i;
        value = decode_html_entities(html.substr(vs, i - vs));
        if (i < html.size()) ++i;
      } else {
        size_t vs = i;
        while (i < html.size() && !is_space(html[i]) && html[i] != '>') ++i;
        value = decode_html_entities(html.substr(vs, i - vs));
      }
    }
    if (!name.empty() && !tag.attrs.count(name)) tag.attrs[name] = value;
  }
}

size_t count_lines(std::string_view html, size_t upto, size_t from, size_t line) {
  for (size_t i = from; i < upto && i < html.size(); ++i) {
    if (html[i] == '\n') ++line;
  }
  return line;
}

}  // namespace

std::string decode_html_entities(std::string_view in) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    if (in[i] != '&') {
      out.push_back(in[i]);
      continue;
    }
    size_t semi = in.find(';', i);
    if (semi == std::string_view::npos || semi - i > 10) {
      out.push_back('&');
      continue;
    }
    std::string_view ent = in.substr(i + 1, semi - i - 1);
    std::string rep;
    if (ent == "amp") rep = "&";
    else if (ent == "lt") rep = "<";
    else if (ent == "gt") rep = ">";
    else if (ent == "quot") rep = "\"";
    else if (ent == "apos" || ent == "#39") rep = "'";
    else if (!ent.empty() && ent[0] == '#') {
      long cp = 0;
      bool ok = true;
      if (ent.size() > 1 && (ent[1] == 'x' || ent[1] == 'X')) {
        for (char c : ent.substr(2)) {
          if (!std::isxdigit(static_cast<unsigned char>(c))) ok = false;
        }
        if (ok && ent.size() > 2) cp = std::stol(std::string(ent.substr(2)), nullptr, 16);
        else ok = false;
      } else {
        for (char c : ent.substr(1)) {
          if (!std::isdigit(static_cast<unsigned char>(c))) ok = false;
        }
        if (ok && ent.size() > 1) cp = std::stol(std::string(ent.substr(1)));
        else ok = false;
      }
      if (ok && cp > 0 && cp < 0x110000) {
        // UTF-8 encode.
        if (cp < 0x80) rep.push_back(static_cast<char>(cp));
        else if (cp < 0x800) {
          rep.push_back(static_cast<char>(0xC0 | (cp >> 6)));
          rep.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
          rep.push_back(static_cast<char>(0xE0 | (cp >> 12)));
          rep.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
          rep.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
          rep.push_back(static_cast<char>(0xF0 | (cp >> 18)));
          rep.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
          rep.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
          rep.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
      }
    }
    if (rep.empty()) {
      out.push_back('&');
      continue;
    }
    out += rep;
    i = semi;
  }
  return out;
}

HtmlDocumentInfo scan_html(std::string_view html) {
  HtmlDocumentInfo info;
  size_t i = 0;
  size_t line = 1, line_pos = 0;
  while (i < html.size()) {
    size_t lt = html.find('<', i);
    if (lt == std::string_view::npos) break;
    if (html.compare(lt, 4, "<!--") == 0) {
      size_t end = html.find("-->", lt + 4);
      i = end == std::string_view::npos ? html.size() : end + 3;
      continue;
    }
    if (lt + 1 < html.size() && (html[lt + 1] == '!' || html[lt + 1] == '?' || html[lt + 1] == '/')) {
      size_t end = html.find('>', lt);
      i = end == std::string_view::npos ? html.size() : end + 1;
      continue;
    }
    Tag tag;
    if (!parse_start_tag(html, lt, tag)) {
      i = lt + 1;
      continue;
    }
    line = count_lines(html, lt, line_pos, line);
    line_pos = lt;
    i = tag.end;
    auto attr = [&](const char* n) -> const std::string* {
      auto it = tag.attrs.find(n);
      return it == tag.attrs.end() ? nullptr : &it->second;
    };
    if (tag.name == "script") {
      size_t close = ifind(html, "</script", i);
      std::string_view body = html.substr(i, (close == std::string_view::npos ? html.size() : close) - i);
      HtmlScript s;
      s.line = line;
      const std::string* type = attr("type");
      std::string t = type ? lower(trim(*type)) : "";
      s.module = t == "module";
      s.classic = !s.module && (t.empty() || is_javascript_mime(t));
      s.async = attr("async") != nullptr;
      s.defer = attr("defer") != nullptr;
      s.nomodule = attr("nomodule") != nullptr;
      if (const std::string* src = attr("src")) s.src = std::string(trim(*src));
      if (s.src.empty()) s.inline_text = std::string(body);
      if ((s.module || s.classic) && !s.nomodule) info.scripts.push_back(std::move(s));
      if (close == std::string_view::npos) break;
      size_t gt = html.find('>', close);
      i = gt == std::string_view::npos ? html.size() : gt + 1;
      continue;
    }
    if (tag.name == "style" || tag.name == "textarea" || tag.name == "template" || tag.name == "noscript") {
      std::string closing = "</" + tag.name;
      size_t close = ifind(html, closing, i);
      if (close == std::string_view::npos) break;
      size_t gt = html.find('>', close);
      i = gt == std::string_view::npos ? html.size() : gt + 1;
      continue;
    }
    if (tag.name == "title") {
      size_t close = ifind(html, "</title", i);
      if (close == std::string_view::npos) break;
      if (info.title.empty()) info.title = decode_html_entities(trim(html.substr(i, close - i)));
      i = close;
      continue;
    }
    if (tag.name == "link") {
      const std::string* rel = attr("rel");
      const std::string* href = attr("href");
      if (rel && href) {
        // rel is a space-separated token list.
        std::string r = lower(*rel);
        size_t p = 0;
        while (p < r.size()) {
          while (p < r.size() && is_space(r[p])) ++p;
          size_t e = p;
          while (e < r.size() && !is_space(r[e])) ++e;
          if (r.substr(p, e - p) == "modulepreload") {
            info.modulepreloads.push_back(std::string(trim(*href)));
            break;
          }
          p = e;
        }
      }
      continue;
    }
    if (tag.name == "base" && info.base_href.empty()) {
      if (const std::string* href = attr("href")) info.base_href = std::string(trim(*href));
      continue;
    }
  }
  return info;
}

}  // namespace iwn
