/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CON-2 / LOG-1: long messages split (not truncated) on UTF-8 boundaries, preferring newlines; tags.
#include <string>
#include <vector>

#include "iwn/core/log.h"
#include "iwn_test.h"

using namespace iwn;

IWN_TEST(Log, SplitsLongMessagesWithoutLoss) {
  std::string msg;
  for (int i = 0; i < 1000; ++i) msg += "word" + std::to_string(i) + " ";
  std::vector<std::string> chunks;
  split_log_text(msg, 100, [&](std::string_view c) { chunks.emplace_back(c); });
  std::string joined;
  for (auto& c : chunks) {
    IWN_CHECK(c.size() <= 100);
    joined += c;
  }
  IWN_CHECK_EQ(joined, msg);
}

IWN_TEST(Log, PrefersNewlines) {
  std::string msg = std::string(60, 'a') + "\n" + std::string(60, 'b');
  std::vector<std::string> chunks;
  split_log_text(msg, 100, [&](std::string_view c) { chunks.emplace_back(c); });
  IWN_CHECK_EQ(chunks.size(), size_t(2));
  IWN_CHECK_EQ(chunks[0], std::string(60, 'a'));
  IWN_CHECK_EQ(chunks[1], std::string(60, 'b'));
}

IWN_TEST(Log, NeverSplitsUtf8) {
  std::string euro = "\xE2\x82\xAC";  // 3 bytes
  std::string msg;
  for (int i = 0; i < 100; ++i) msg += euro;
  std::vector<std::string> chunks;
  split_log_text(msg, 10, [&](std::string_view c) { chunks.emplace_back(c); });
  std::string joined;
  for (auto& c : chunks) {
    IWN_CHECK(c.size() % 3 == 0);
    joined += c;
  }
  IWN_CHECK_EQ(joined, msg);
}

IWN_TEST(Log, SinkReceivesTagsAndLevels) {
  std::vector<std::string> lines;
  set_log_sink([&](const char* tag, LogLevel level, std::string_view line) {
    lines.push_back(std::string(tag) + "/" + std::to_string(static_cast<int>(level)) + ":" + std::string(line));
  });
  log(LogLevel::kWarn, "x=%d", 3);
  log_js(LogLevel::kError, "boom");
  set_log_sink(nullptr);
  IWN_CHECK_EQ(lines.size(), size_t(2));
  IWN_CHECK_EQ(lines[0], std::string("iwn/2:x=3"));
  IWN_CHECK_EQ(lines[1], std::string("iwn-js/3:boom"));
}
