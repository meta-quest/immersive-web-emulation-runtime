/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Parser for Android's /system/etc/fonts.xml (the platform font configuration documented in the Android source
// tree's frameworks/base/data/fonts/fonts.xml format): <familyset> of <family name|lang|variant> elements holding
// <font weight style index fallbackFor>file</font> entries (with optional <axis> children), plus <alias>.
// A tiny tolerant XML tokenizer (elements, attributes, text, comments, processing instructions); no DTDs.

#include <cctype>
#include <cmath>
#include <cstdlib>
#include <string>

#include "iwn/canvas2d/text.h"

namespace iwn::canvas2d {

namespace {

std::string DecodeEntities(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] != '&') {
      out.push_back(s[i]);
      continue;
    }
    size_t semi = s.find(';', i);
    if (semi == std::string_view::npos) {
      out.push_back('&');
      continue;
    }
    std::string_view e = s.substr(i + 1, semi - i - 1);
    if (e == "amp") out.push_back('&');
    else if (e == "lt") out.push_back('<');
    else if (e == "gt") out.push_back('>');
    else if (e == "quot") out.push_back('"');
    else if (e == "apos") out.push_back('\'');
    else if (!e.empty() && e[0] == '#') {
      unsigned long v = (e.size() > 1 && (e[1] == 'x' || e[1] == 'X')) ? std::strtoul(std::string(e.substr(2)).c_str(), nullptr, 16)
                                                                       : std::strtoul(std::string(e.substr(1)).c_str(), nullptr, 10);
      if (v < 0x80) out.push_back(static_cast<char>(v));
    } else {
      out.append(s.substr(i, semi - i + 1));
    }
    i = semi;
  }
  return out;
}

std::string Trim(std::string_view s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) a++;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) b--;
  return std::string(s.substr(a, b - a));
}

struct Tag {
  std::string name;
  std::vector<std::pair<std::string, std::string>> attrs;
  bool closing = false;
  bool self_closing = false;
  std::string Attr(const char* key) const {
    for (const auto& kv : attrs) {
      if (kv.first == key) return kv.second;
    }
    return std::string();
  }
};

class Tokenizer {
 public:
  explicit Tokenizer(std::string_view s) : s_(s) {}
  // Returns false at end. Either text (is_text) or a tag.
  bool Next(bool* is_text, std::string* text, Tag* tag, std::string* error) {
    while (pos_ < s_.size()) {
      if (s_[pos_] != '<') {
        size_t lt = s_.find('<', pos_);
        if (lt == std::string_view::npos) lt = s_.size();
        *text = DecodeEntities(s_.substr(pos_, lt - pos_));
        pos_ = lt;
        *is_text = true;
        return true;
      }
      if (s_.compare(pos_, 4, "<!--") == 0) {
        size_t e = s_.find("-->", pos_ + 4);
        if (e == std::string_view::npos) {
          *error = "unterminated comment";
          return false;
        }
        pos_ = e + 3;
        continue;
      }
      if (s_.compare(pos_, 2, "<?") == 0 || s_.compare(pos_, 2, "<!") == 0) {
        size_t e = s_.find('>', pos_);
        if (e == std::string_view::npos) {
          *error = "unterminated declaration";
          return false;
        }
        pos_ = e + 1;
        continue;
      }
      // Element tag.
      size_t i = pos_ + 1;
      *tag = Tag();
      if (i < s_.size() && s_[i] == '/') {
        tag->closing = true;
        i++;
      }
      size_t ns = i;
      while (i < s_.size() && !std::isspace(static_cast<unsigned char>(s_[i])) && s_[i] != '>' && s_[i] != '/') i++;
      tag->name = std::string(s_.substr(ns, i - ns));
      for (;;) {
        while (i < s_.size() && std::isspace(static_cast<unsigned char>(s_[i]))) i++;
        if (i >= s_.size()) {
          *error = "unterminated tag";
          return false;
        }
        if (s_[i] == '>') {
          i++;
          break;
        }
        if (s_[i] == '/' && i + 1 < s_.size() && s_[i + 1] == '>') {
          tag->self_closing = true;
          i += 2;
          break;
        }
        size_t ks = i;
        while (i < s_.size() && s_[i] != '=' && !std::isspace(static_cast<unsigned char>(s_[i])) && s_[i] != '>' &&
               s_[i] != '/')
          i++;
        std::string key(s_.substr(ks, i - ks));
        while (i < s_.size() && std::isspace(static_cast<unsigned char>(s_[i]))) i++;
        std::string value;
        if (i < s_.size() && s_[i] == '=') {
          i++;
          while (i < s_.size() && std::isspace(static_cast<unsigned char>(s_[i]))) i++;
          if (i < s_.size() && (s_[i] == '"' || s_[i] == '\'')) {
            char q = s_[i++];
            size_t vs = i;
            while (i < s_.size() && s_[i] != q) i++;
            if (i >= s_.size()) {
              *error = "unterminated attribute";
              return false;
            }
            value = DecodeEntities(s_.substr(vs, i - vs));
            i++;
          } else {
            size_t vs = i;
            while (i < s_.size() && !std::isspace(static_cast<unsigned char>(s_[i])) && s_[i] != '>') i++;
            value = DecodeEntities(s_.substr(vs, i - vs));
          }
        }
        if (key.empty()) {
          *error = "malformed attribute";
          return false;
        }
        tag->attrs.emplace_back(std::move(key), std::move(value));
      }
      pos_ = i;
      *is_text = false;
      return true;
    }
    return false;
  }

 private:
  std::string_view s_;
  size_t pos_ = 0;
};

}  // namespace

bool ParseFontsXml(std::string_view xml, FontsXml* out, std::string* error) {
  *out = FontsXml();
  Tokenizer tok(xml);
  bool is_text;
  std::string text, err;
  Tag tag;
  bool saw_root = false;
  FontsXmlFamily* family = nullptr;
  FontsXmlFont* font = nullptr;
  bool font_has_weight = false;
  std::string font_text;
  while (tok.Next(&is_text, &text, &tag, &err)) {
    if (is_text) {
      if (font) font_text += text;
      continue;
    }
    if (tag.name == "familyset") {
      if (!tag.closing) saw_root = true;
      continue;
    }
    if (tag.name == "family") {
      if (tag.closing) {
        family = nullptr;
        continue;
      }
      out->families.emplace_back();
      family = &out->families.back();
      family->name = tag.Attr("name");
      family->lang = tag.Attr("lang");
      family->variant = tag.Attr("variant");
      if (tag.self_closing) family = nullptr;
      continue;
    }
    if (tag.name == "font") {
      if (tag.closing) {
        if (font) font->file = Trim(font_text);
        font = nullptr;
        continue;
      }
      if (!family) continue;
      family->fonts.emplace_back();
      font = &family->fonts.back();
      font_text.clear();
      std::string w = tag.Attr("weight");
      if (!w.empty()) font->weight = std::atoi(w.c_str());
      font_has_weight = !w.empty();
      font->italic = tag.Attr("style") == "italic";
      std::string idx = tag.Attr("index");
      if (!idx.empty()) font->index = std::atoi(idx.c_str());
      font->fallback_for = tag.Attr("fallbackFor");
      if (tag.self_closing) {
        font->file = tag.Attr("file");
        font = nullptr;
      }
      continue;
    }
    if (tag.name == "alias" && !tag.closing) {
      FontsXmlAlias a;
      a.name = tag.Attr("name");
      a.to = tag.Attr("to");
      std::string w = tag.Attr("weight");
      if (!w.empty()) a.weight = std::atoi(w.c_str());
      if (!a.name.empty() && !a.to.empty()) out->aliases.push_back(a);
      continue;
    }
    // <axis tag="wght" stylevalue="700"/> inside a <font>: the variable-font instance this entry names. Its weight is
    // the entry's weight when the <font> has no weight attribute (several entries share one variable file; the JS
    // matcher keeps one entry per weight and the native side instantiates the file at it). Other axes, unknown
    // elements: ignored.
    if (tag.name == "axis" && !tag.closing && font && !font_has_weight && tag.Attr("tag") == "wght") {
      std::string v = tag.Attr("stylevalue");
      if (!v.empty()) font->weight = static_cast<int>(std::lround(std::atof(v.c_str())));
    }
  }
  if (!err.empty()) {
    if (error) *error = err;
    return false;
  }
  if (!saw_root) {
    if (error) *error = "no <familyset> root";
    return false;
  }
  // Drop fonts with no file name.
  for (FontsXmlFamily& f : out->families) {
    std::vector<FontsXmlFont> keep;
    for (FontsXmlFont& ft : f.fonts) {
      if (!ft.file.empty()) keep.push_back(ft);
    }
    f.fonts.swap(keep);
  }
  return true;
}

}  // namespace iwn::canvas2d
