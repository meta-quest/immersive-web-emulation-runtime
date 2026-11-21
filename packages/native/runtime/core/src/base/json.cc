/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/core/json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace iwn {
namespace {

const Json& null_json() {
  static const Json n;
  return n;
}

void append_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

class Parser {
 public:
  Parser(std::string_view s) : s_(s) {}
  std::optional<Json> run(std::string* error) {
    auto v = value(0);
    ws();
    if (v && pos_ != s_.size()) {
      err_ = "trailing characters";
      v.reset();
    }
    if (!v && error) *error = err_ + " at offset " + std::to_string(pos_);
    return v;
  }

 private:
  void ws() {
    while (pos_ < s_.size() && (s_[pos_] == ' ' || s_[pos_] == '\t' || s_[pos_] == '\n' || s_[pos_] == '\r')) ++pos_;
  }
  std::optional<Json> value(int depth) {
    if (depth > 200) {
      err_ = "nesting too deep";
      return std::nullopt;
    }
    ws();
    if (pos_ >= s_.size()) {
      err_ = "unexpected end";
      return std::nullopt;
    }
    char c = s_[pos_];
    if (c == '{') return object(depth);
    if (c == '[') return array(depth);
    if (c == '"') {
      auto s = string();
      if (!s) return std::nullopt;
      return Json(std::move(*s));
    }
    if (s_.compare(pos_, 4, "true") == 0) {
      pos_ += 4;
      return Json(true);
    }
    if (s_.compare(pos_, 5, "false") == 0) {
      pos_ += 5;
      return Json(false);
    }
    if (s_.compare(pos_, 4, "null") == 0) {
      pos_ += 4;
      return Json(nullptr);
    }
    if (c == '-' || (c >= '0' && c <= '9')) return number();
    err_ = "unexpected character";
    return std::nullopt;
  }
  std::optional<Json> number() {
    size_t start = pos_;
    if (s_[pos_] == '-') ++pos_;
    while (pos_ < s_.size() && ((s_[pos_] >= '0' && s_[pos_] <= '9') || s_[pos_] == '.' || s_[pos_] == 'e' ||
                                s_[pos_] == 'E' || s_[pos_] == '+' || s_[pos_] == '-'))
      ++pos_;
    std::string text(s_.substr(start, pos_ - start));
    char* end = nullptr;
    double v = std::strtod(text.c_str(), &end);
    if (end != text.c_str() + text.size()) {
      err_ = "bad number";
      return std::nullopt;
    }
    return Json(v);
  }
  std::optional<std::string> string() {
    ++pos_;  // opening quote
    std::string out;
    while (pos_ < s_.size()) {
      char c = s_[pos_++];
      if (c == '"') return out;
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (pos_ >= s_.size()) break;
      char e = s_[pos_++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          auto hex4 = [&](uint32_t& v) -> bool {
            if (pos_ + 4 > s_.size()) return false;
            v = 0;
            for (int i = 0; i < 4; ++i) {
              char h = s_[pos_++];
              v <<= 4;
              if (h >= '0' && h <= '9') v |= h - '0';
              else if (h >= 'a' && h <= 'f') v |= h - 'a' + 10;
              else if (h >= 'A' && h <= 'F') v |= h - 'A' + 10;
              else return false;
            }
            return true;
          };
          uint32_t cp;
          if (!hex4(cp)) {
            err_ = "bad \\u escape";
            return std::nullopt;
          }
          if (cp >= 0xD800 && cp <= 0xDBFF && pos_ + 6 <= s_.size() && s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
            size_t save = pos_;
            pos_ += 2;
            uint32_t lo;
            if (hex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            } else {
              pos_ = save;
            }
          }
          if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
          append_utf8(out, cp);
          break;
        }
        default:
          err_ = "bad escape";
          return std::nullopt;
      }
    }
    err_ = "unterminated string";
    return std::nullopt;
  }
  std::optional<Json> array(int depth) {
    ++pos_;
    Json arr = Json::array();
    ws();
    if (pos_ < s_.size() && s_[pos_] == ']') {
      ++pos_;
      return arr;
    }
    for (;;) {
      auto v = value(depth + 1);
      if (!v) return std::nullopt;
      arr.push(std::move(*v));
      ws();
      if (pos_ < s_.size() && s_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (pos_ < s_.size() && s_[pos_] == ']') {
        ++pos_;
        return arr;
      }
      err_ = "expected , or ]";
      return std::nullopt;
    }
  }
  std::optional<Json> object(int depth) {
    ++pos_;
    Json obj = Json::object();
    ws();
    if (pos_ < s_.size() && s_[pos_] == '}') {
      ++pos_;
      return obj;
    }
    for (;;) {
      ws();
      if (pos_ >= s_.size() || s_[pos_] != '"') {
        err_ = "expected key";
        return std::nullopt;
      }
      auto key = string();
      if (!key) return std::nullopt;
      ws();
      if (pos_ >= s_.size() || s_[pos_] != ':') {
        err_ = "expected :";
        return std::nullopt;
      }
      ++pos_;
      auto v = value(depth + 1);
      if (!v) return std::nullopt;
      obj.set(std::move(*key), std::move(*v));
      ws();
      if (pos_ < s_.size() && s_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (pos_ < s_.size() && s_[pos_] == '}') {
        ++pos_;
        return obj;
      }
      err_ = "expected , or }";
      return std::nullopt;
    }
  }

  std::string_view s_;
  size_t pos_ = 0;
  std::string err_;
};

}  // namespace

const Json& Json::operator[](std::string_view key) const {
  if (type_ != Type::kObject) return null_json();
  for (const auto& kv : obj_) {
    if (kv.first == key) return kv.second;
  }
  return null_json();
}

bool Json::has(std::string_view key) const {
  if (type_ != Type::kObject) return false;
  for (const auto& kv : obj_) {
    if (kv.first == key) return true;
  }
  return false;
}

Json& Json::set(std::string key, Json value) {
  if (type_ != Type::kObject) {
    *this = object();
  }
  for (auto& kv : obj_) {
    if (kv.first == key) {
      kv.second = std::move(value);
      return kv.second;
    }
  }
  obj_.emplace_back(std::move(key), std::move(value));
  return obj_.back().second;
}

Json& Json::push(Json value) {
  if (type_ != Type::kArray) *this = array();
  arr_.push_back(std::move(value));
  return arr_.back();
}

std::string Json::quote(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
  return out;
}

void Json::dump_to(std::string& out) const {
  switch (type_) {
    case Type::kNull: out += "null"; break;
    case Type::kBool: out += bool_ ? "true" : "false"; break;
    case Type::kNumber: {
      if (!std::isfinite(num_)) {
        out += "null";
      } else if (num_ == std::floor(num_) && std::fabs(num_) < 9.007199254740992e15) {
        out += std::to_string(static_cast<int64_t>(num_));
      } else {
        char buf[32];
        snprintf(buf, sizeof(buf), "%.17g", num_);
        out += buf;
      }
      break;
    }
    case Type::kString:
      if (raw_) {
        out += str_;
      } else {
        out += quote(str_);
      }
      break;
    case Type::kArray: {
      out.push_back('[');
      bool first = true;
      for (const auto& v : arr_) {
        if (!first) out.push_back(',');
        first = false;
        v.dump_to(out);
      }
      out.push_back(']');
      break;
    }
    case Type::kObject: {
      out.push_back('{');
      bool first = true;
      for (const auto& kv : obj_) {
        if (!first) out.push_back(',');
        first = false;
        out += quote(kv.first);
        out.push_back(':');
        kv.second.dump_to(out);
      }
      out.push_back('}');
      break;
    }
  }
}

std::string Json::dump() const {
  std::string out;
  dump_to(out);
  return out;
}

std::optional<Json> Json::parse(std::string_view text, std::string* error) { return Parser(text).run(error); }

}  // namespace iwn
