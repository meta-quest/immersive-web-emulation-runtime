// Minimal host test harness (no external dependency). Other modules may use it through iwn_add_host_test().
//   IWN_TEST(suite, name) { IWN_CHECK(cond); IWN_CHECK_EQ(a, b); }
#pragma once

#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace iwn::test {

struct Case {
  const char* suite;
  const char* name;
  std::function<void()> fn;
};
std::vector<Case>& registry();
void fail(const char* file, int line, const std::string& msg);
int run_all(int argc, char** argv);

struct Registrar {
  Registrar(const char* suite, const char* name, std::function<void()> fn) {
    registry().push_back({suite, name, std::move(fn)});
  }
};

template <typename A, typename B>
std::string describe(const A& a, const B& b) {
  std::ostringstream os;
  os << "  left:  " << a << "\n  right: " << b;
  return os.str();
}

template <typename A, typename B>
void check_eq(const char* file, int line, const char* expr, const A& a, const B& b) {
  if (!(a == b)) fail(file, line, std::string(expr) + "\n" + describe(a, b));
}

}  // namespace iwn::test

#define IWN_TEST(suite, name)                                                                 \
  static void iwn_test_##suite##_##name();                                                    \
  static ::iwn::test::Registrar iwn_reg_##suite##_##name(#suite, #name, iwn_test_##suite##_##name); \
  static void iwn_test_##suite##_##name()

#define IWN_CHECK(cond)                                                     \
  do {                                                                      \
    if (!(cond)) ::iwn::test::fail(__FILE__, __LINE__, "CHECK(" #cond ")"); \
  } while (0)

// Both operands are evaluated as arguments of one call, so temporaries they refer to (e.g. q.pop()->id, where
// pop() returns an optional) live until the comparison is done; binding them to `auto&&` locals would dangle.
#define IWN_CHECK_EQ(a, b) ::iwn::test::check_eq(__FILE__, __LINE__, "CHECK_EQ(" #a ", " #b ")", (a), (b))
