// Minimal JSON (RFC 8259) for the runtime config, CDP message routing and the debug endpoint. Not for page code.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace iwn {

class Json {
 public:
  enum class Type { kNull, kBool, kNumber, kString, kArray, kObject };
  using Array = std::vector<Json>;
  using Object = std::vector<std::pair<std::string, Json>>;  // insertion order kept

  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool b) : type_(Type::kBool), bool_(b) {}
  Json(int v) : type_(Type::kNumber), num_(v) {}
  Json(int64_t v) : type_(Type::kNumber), num_(static_cast<double>(v)) {}
  Json(uint64_t v) : type_(Type::kNumber), num_(static_cast<double>(v)) {}
  Json(double v) : type_(Type::kNumber), num_(v) {}
  Json(const char* s) : type_(Type::kString), str_(s) {}
  Json(std::string s) : type_(Type::kString), str_(std::move(s)) {}
  Json(std::string_view s) : type_(Type::kString), str_(s) {}
  static Json array() {
    Json j;
    j.type_ = Type::kArray;
    return j;
  }
  static Json object() {
    Json j;
    j.type_ = Type::kObject;
    return j;
  }
  // A preformatted JSON fragment written verbatim by dump() (caller guarantees validity).
  static Json raw(std::string text) {
    Json j;
    j.type_ = Type::kString;
    j.str_ = std::move(text);
    j.raw_ = true;
    return j;
  }

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::kNull; }
  bool is_bool() const { return type_ == Type::kBool; }
  bool is_number() const { return type_ == Type::kNumber; }
  bool is_string() const { return type_ == Type::kString && !raw_; }
  bool is_array() const { return type_ == Type::kArray; }
  bool is_object() const { return type_ == Type::kObject; }

  bool as_bool(bool def = false) const { return is_bool() ? bool_ : def; }
  double as_number(double def = 0) const { return is_number() ? num_ : def; }
  int64_t as_int(int64_t def = 0) const { return is_number() ? static_cast<int64_t>(num_) : def; }
  const std::string& as_string() const { return str_; }
  std::string string_or(std::string_view def) const { return is_string() ? str_ : std::string(def); }
  const Array& items() const { return arr_; }
  const Object& members() const { return obj_; }

  // Object access: returns a null Json when missing or not an object.
  const Json& operator[](std::string_view key) const;
  bool has(std::string_view key) const;
  Json& set(std::string key, Json value);  // object; replaces an existing key
  Json& push(Json value);                  // array

  std::string dump() const;
  static std::optional<Json> parse(std::string_view text, std::string* error = nullptr);

  // Escapes a string as a JSON string literal (with quotes).
  static std::string quote(std::string_view s);

 private:
  void dump_to(std::string& out) const;
  Type type_ = Type::kNull;
  bool bool_ = false;
  bool raw_ = false;
  double num_ = 0;
  std::string str_;
  Array arr_;
  Object obj_;
};

}  // namespace iwn
