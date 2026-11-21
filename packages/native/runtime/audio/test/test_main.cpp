// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include <cstring>

#include "test.h"

namespace iwntest {
std::vector<Case>& cases() {
  static std::vector<Case> c;
  return c;
}
int g_failures = 0;
const char* g_current = "";
}  // namespace iwntest

int main(int argc, char** argv) {
  const char* filter = argc > 1 ? argv[1] : nullptr;
  int ran = 0;
  for (auto& c : iwntest::cases()) {
    if (filter && !std::strstr(c.name, filter)) continue;
    iwntest::g_current = c.name;
    int before = iwntest::g_failures;
    c.fn();
    ++ran;
    std::printf("%s %s\n", iwntest::g_failures == before ? "ok  " : "FAIL", c.name);
  }
  std::printf("\n%d tests, %d failed checks\n", ran, iwntest::g_failures);
  return iwntest::g_failures ? 1 : 0;
}
