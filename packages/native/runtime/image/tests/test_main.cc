/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "test_harness.h"

#include <cstdio>
#include <cstring>

namespace iwn::image::test {

std::vector<TestCase>& Registry() {
  static std::vector<TestCase> tests;
  return tests;
}

int g_failures = 0;

}  // namespace iwn::image::test

int main(int argc, char** argv) {
  using namespace iwn::image::test;
  const char* filter = argc > 1 ? argv[1] : nullptr;
  int ran = 0, failed = 0;
  for (const TestCase& t : Registry()) {
    if (filter && !std::strstr(t.name, filter)) continue;
    const int before = g_failures;
    t.fn();
    ++ran;
    if (g_failures != before) {
      ++failed;
      std::printf("FAIL %s\n", t.name);
    } else {
      std::printf("ok   %s\n", t.name);
    }
  }
  std::printf("\n%d tests, %d failed\n", ran, failed);
  return failed ? 1 : 0;
}
