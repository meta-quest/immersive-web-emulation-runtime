// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Minimal test harness (no third-party test framework needed on the host).

#ifndef IWN_TEST_H_
#define IWN_TEST_H_

#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace iwn_test {

struct Case {
  const char* name;
  std::function<void()> fn;
};
inline std::vector<Case>& Registry() {
  static std::vector<Case> r;
  return r;
}
inline int& Failures() {
  static int f = 0;
  return f;
}
struct Registrar {
  Registrar(const char* name, std::function<void()> fn) { Registry().push_back({name, std::move(fn)}); }
};

inline int RunAll(int argc, char** argv) {
  int ran = 0;
  for (const Case& c : Registry()) {
    if (argc > 1 && std::string(c.name).find(argv[1]) == std::string::npos) continue;
    int before = Failures();
    c.fn();
    ++ran;
    std::printf("%s %s\n", Failures() == before ? "ok  " : "FAIL", c.name);
  }
  std::printf("%d tests, %d failed checks\n", ran, Failures());
  return Failures() == 0 ? 0 : 1;
}

}  // namespace iwn_test

#define IWN_CAT2(a, b) a##b
#define IWN_CAT(a, b) IWN_CAT2(a, b)
#define TEST(name)                                                              \
  static void name();                                                           \
  static iwn_test::Registrar IWN_CAT(reg_, name)(#name, name);                  \
  static void name()

#define CHECK(cond)                                                             \
  do {                                                                          \
    if (!(cond)) {                                                              \
      std::printf("  %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond);    \
      ++iwn_test::Failures();                                                   \
    }                                                                           \
  } while (0)

#define CHECK_EQ(a, b)                                                          \
  do {                                                                          \
    auto _va = (a);                                                             \
    auto _vb = (b);                                                             \
    if (!(_va == _vb)) {                                                        \
      std::printf("  %s:%d: CHECK_EQ(%s, %s) failed\n", __FILE__, __LINE__, #a, #b); \
      ++iwn_test::Failures();                                                   \
    }                                                                           \
  } while (0)

#define TEST_MAIN() \
  int main(int argc, char** argv) { return iwn_test::RunAll(argc, argv); }

#endif  // IWN_TEST_H_
