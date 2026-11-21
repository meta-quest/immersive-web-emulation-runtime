/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Minimal test harness (no external test framework, so the host build has no extra dependencies).
#pragma once

#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace iwn_test {
struct Case {
  const char* name;
  std::function<void()> fn;
};
std::vector<Case>& Registry();
extern int g_failures;
struct Registrar {
  Registrar(const char* n, std::function<void()> f) { Registry().push_back({n, std::move(f)}); }
};
}  // namespace iwn_test

#define TEST(name)                                                           \
  static void test_##name();                                                 \
  static iwn_test::Registrar registrar_##name(#name, test_##name);           \
  static void test_##name()

#define EXPECT(cond)                                                                  \
  do {                                                                                \
    if (!(cond)) {                                                                    \
      std::fprintf(stderr, "  %s:%d: EXPECT(%s) failed\n", __FILE__, __LINE__, #cond); \
      iwn_test::g_failures++;                                                         \
    }                                                                                 \
  } while (0)

#define EXPECT_NEAR(a, b, tol)                                                                          \
  do {                                                                                                  \
    double _a = (a), _b = (b);                                                                          \
    if (!(std::fabs(_a - _b) <= (tol))) {                                                               \
      std::fprintf(stderr, "  %s:%d: EXPECT_NEAR(%s, %s) %g vs %g\n", __FILE__, __LINE__, #a, #b, _a, _b); \
      iwn_test::g_failures++;                                                                           \
    }                                                                                                   \
  } while (0)
