// Minimal test harness (no dependency): TEST(name) { CHECK(...); }
#pragma once

#include <cstdio>
#include <vector>

namespace iwn::image::test {

struct TestCase {
  const char* name;
  void (*fn)();
};
std::vector<TestCase>& Registry();
extern int g_failures;

struct Registrar {
  Registrar(const char* name, void (*fn)()) { Registry().push_back({name, fn}); }
};

}  // namespace iwn::image::test

#define TEST(name)                                                              \
  static void test_##name();                                                    \
  static ::iwn::image::test::Registrar registrar_##name(#name, &test_##name);   \
  static void test_##name()

#define CHECK(cond)                                                             \
  do {                                                                          \
    if (!(cond)) {                                                              \
      std::printf("  %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond);    \
      ++::iwn::image::test::g_failures;                                         \
    }                                                                           \
  } while (0)

#define CHECK_EQ(a, b)                                                          \
  do {                                                                          \
    auto _a = (a);                                                              \
    auto _b = (b);                                                              \
    if (!(_a == _b)) {                                                          \
      std::printf("  %s:%d: CHECK_EQ(%s, %s) failed: %lld vs %lld\n", __FILE__, \
                  __LINE__, #a, #b, (long long)_a, (long long)_b);              \
      ++::iwn::image::test::g_failures;                                         \
    }                                                                           \
  } while (0)
