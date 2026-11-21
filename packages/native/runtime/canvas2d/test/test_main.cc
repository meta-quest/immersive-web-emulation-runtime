#include <cstring>

#include "test.h"

namespace iwn_test {
std::vector<Case>& Registry() {
  static std::vector<Case> r;
  return r;
}
int g_failures = 0;
}  // namespace iwn_test

int main(int argc, char** argv) {
  int run = 0;
  for (auto& c : iwn_test::Registry()) {
    if (argc > 1 && std::strstr(c.name, argv[1]) == nullptr) continue;
    int before = iwn_test::g_failures;
    c.fn();
    run++;
    std::fprintf(stderr, "%s %s\n", iwn_test::g_failures == before ? "ok  " : "FAIL", c.name);
  }
  std::fprintf(stderr, "%d tests, %d failed expectations\n", run, iwn_test::g_failures);
  return iwn_test::g_failures == 0 ? 0 : 1;
}
