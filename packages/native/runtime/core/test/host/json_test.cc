/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/core/json.h"
#include "iwn_test.h"

using iwn::Json;

IWN_TEST(Json, RoundTrip) {
  auto j = Json::parse(R"({"id": 7, "method": "Runtime.evaluate", "params": {"expression": "1+1", "x": [1, 2.5, true, null]}})");
  IWN_CHECK(j.has_value());
  IWN_CHECK_EQ((*j)["id"].as_int(), int64_t(7));
  IWN_CHECK_EQ((*j)["method"].as_string(), std::string("Runtime.evaluate"));
  IWN_CHECK_EQ((*j)["params"]["expression"].as_string(), std::string("1+1"));
  IWN_CHECK_EQ((*j)["params"]["x"].items().size(), size_t(4));
  IWN_CHECK((*j)["missing"]["deeper"].is_null());
  IWN_CHECK_EQ(j->dump(), std::string(R"({"id":7,"method":"Runtime.evaluate","params":{"expression":"1+1","x":[1,2.5,true,null]}})"));
}

IWN_TEST(Json, Strings) {
  auto j = Json::parse(R"("a\"b\\c\n\u00e9\ud83d\ude00")");
  IWN_CHECK_EQ(j->as_string(), std::string("a\"b\\c\n\xC3\xA9\xF0\x9F\x98\x80"));
  IWN_CHECK_EQ(Json(std::string("tab\tq\"")).dump(), std::string("\"tab\\tq\\\"\""));
  IWN_CHECK_EQ(Json(std::string("\x01")).dump(), std::string("\"\\u0001\""));
}

IWN_TEST(Json, Errors) {
  std::string err;
  IWN_CHECK(!Json::parse("{\"a\":}", &err).has_value());
  IWN_CHECK(!err.empty());
  IWN_CHECK(!Json::parse("[1,2", nullptr).has_value());
  IWN_CHECK(!Json::parse("1 2", nullptr).has_value());
}

IWN_TEST(Json, Build) {
  Json o = Json::object();
  o.set("a", 1);
  o.set("b", "x");
  o.set("a", 2);
  Json arr = Json::array();
  arr.push(1.5);
  o.set("arr", arr);
  o.set("raw", Json::raw("{\"k\":true}"));
  IWN_CHECK_EQ(o.dump(), std::string(R"({"a":2,"b":"x","arr":[1.5],"raw":{"k":true}})"));
}
