#include "iwn_test.h"

#include <cstring>
#include <stdexcept>

namespace iwn::test {
namespace {
struct Failure : std::runtime_error {
  using std::runtime_error::runtime_error;
};
}  // namespace

std::vector<Case>& registry() {
  static std::vector<Case> r;
  return r;
}

void fail(const char* file, int line, const std::string& msg) {
  throw Failure(std::string(file) + ":" + std::to_string(line) + ": " + msg);
}

int run_all(int argc, char** argv) {
  const char* filter = argc > 1 ? argv[1] : nullptr;
  int passed = 0, failed = 0;
  for (auto& c : registry()) {
    std::string full = std::string(c.suite) + "." + c.name;
    if (filter && full.find(filter) == std::string::npos) continue;
    try {
      c.fn();
      ++passed;
      std::cout << "[ ok ] " << full << "\n";
    } catch (const std::exception& e) {
      ++failed;
      std::cout << "[FAIL] " << full << "\n" << e.what() << "\n";
    }
  }
  std::cout << passed << " passed, " << failed << " failed\n";
  return failed == 0 ? 0 : 1;
}

}  // namespace iwn::test

int main(int argc, char** argv) { return iwn::test::run_all(argc, argv); }
