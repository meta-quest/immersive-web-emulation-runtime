// MOD-2, MOD-3, NET-1, NET-4: URL parsing, module specifier resolution, asset path mapping.
#include "iwn/core/url.h"
#include "iwn_test.h"

using namespace iwn;

namespace {
std::string resolve(const char* spec, const char* base) {
  auto b = parse_url(base);
  SpecifierError err;
  auto u = resolve_module_specifier(spec, *b, &err);
  if (!u) return err == SpecifierError::kBare ? "<bare>" : "<invalid>";
  return u->href();
}
std::string href(const char* in, const char* base = nullptr) {
  std::optional<Url> b;
  if (base) b = parse_url(base);
  auto u = parse_url(in, b ? &*b : nullptr);
  return u ? u->href() : "<fail>";
}
}  // namespace

IWN_TEST(Url, ParsesAbsolute) {
  IWN_CHECK_EQ(href("https://App.Local/a/b.js?x=1#y"), std::string("https://app.local/a/b.js?x=1#y"));
  IWN_CHECK_EQ(href("https://app.local"), std::string("https://app.local/"));
  IWN_CHECK_EQ(href("https://app.local:443/x"), std::string("https://app.local/x"));
  IWN_CHECK_EQ(href("http://localhost:9229/json"), std::string("http://localhost:9229/json"));
  IWN_CHECK_EQ(href("HTTPS://app.local/%7Efoo"), std::string("https://app.local/%7Efoo"));
}

IWN_TEST(Url, RelativeResolution) {
  const char* base = "https://app.local/assets/main.js";
  IWN_CHECK_EQ(href("./chunk.js", base), std::string("https://app.local/assets/chunk.js"));
  IWN_CHECK_EQ(href("../x/y.js", base), std::string("https://app.local/x/y.js"));
  IWN_CHECK_EQ(href("/root.js", base), std::string("https://app.local/root.js"));
  IWN_CHECK_EQ(href("../../../../up.js", base), std::string("https://app.local/up.js"));
  IWN_CHECK_EQ(href("a/./b/../c.js", base), std::string("https://app.local/assets/a/c.js"));
  IWN_CHECK_EQ(href("?q", base), std::string("https://app.local/assets/main.js?q"));
  IWN_CHECK_EQ(href("#f", base), std::string("https://app.local/assets/main.js#f"));
  IWN_CHECK_EQ(href("//cdn.example.org/lib.js", base), std::string("https://cdn.example.org/lib.js"));
  IWN_CHECK_EQ(href("dir/", base), std::string("https://app.local/assets/dir/"));
  IWN_CHECK_EQ(href("%2e%2e/z.js", base), std::string("https://app.local/z.js"));
  IWN_CHECK_EQ(href("a b.js", base), std::string("https://app.local/assets/a%20b.js"));
}

IWN_TEST(Url, OpaqueSchemes) {
  auto d = parse_url("data:text/javascript,export default 1");
  IWN_CHECK(d.has_value());
  IWN_CHECK(d->opaque_path);
  IWN_CHECK_EQ(d->scheme, std::string("data"));
  auto b = parse_url("blob:https://app.local/1234-abcd");
  IWN_CHECK(b.has_value());
  IWN_CHECK_EQ(b->origin(), std::string("https://app.local"));
  IWN_CHECK_EQ(b->href(), std::string("blob:https://app.local/1234-abcd"));
  // Relative against an opaque base fails (except fragments).
  IWN_CHECK_EQ(href("./x.js", "data:text/plain,hi"), std::string("<fail>"));
}

IWN_TEST(Url, ModuleSpecifiers) {
  const char* base = "https://app.local/assets/main.js";
  IWN_CHECK_EQ(resolve("./a.js", base), std::string("https://app.local/assets/a.js"));
  IWN_CHECK_EQ(resolve("../a.js", base), std::string("https://app.local/a.js"));
  IWN_CHECK_EQ(resolve("/a.js", base), std::string("https://app.local/a.js"));
  IWN_CHECK_EQ(resolve("https://cdn.example.org/m.js", base), std::string("https://cdn.example.org/m.js"));
  IWN_CHECK_EQ(resolve("data:text/javascript,1", base), std::string("data:text/javascript,1"));
  IWN_CHECK_EQ(resolve("lodash", base), std::string("<bare>"));
  IWN_CHECK_EQ(resolve("three/addons/x.js", base), std::string("<bare>"));
  IWN_CHECK_EQ(resolve("a.js", base), std::string("<bare>"));  // no ./ prefix: bare per HTML
}

IWN_TEST(Url, Origin) {
  IWN_CHECK_EQ(parse_url("https://app.local:8443/x")->origin(), std::string("https://app.local:8443"));
  IWN_CHECK_EQ(parse_url("data:,x")->origin(), std::string("null"));
}

IWN_TEST(Url, AppAssetPath) {
  auto origin = *parse_url("https://app.local/");
  auto path = [&](const char* u) {
    auto p = app_asset_path(*parse_url(u), origin);
    return p ? *p : std::string("<none>");
  };
  IWN_CHECK_EQ(path("https://app.local/"), std::string("index.html"));
  IWN_CHECK_EQ(path("https://app.local/assets/main.js?v=1"), std::string("assets/main.js"));
  IWN_CHECK_EQ(path("https://app.local/_app/x.js"), std::string("_app/x.js"));
  IWN_CHECK_EQ(path("https://app.local/.well-known/y.json"), std::string(".well-known/y.json"));
  IWN_CHECK_EQ(path("https://app.local/%C3%BC.txt"), std::string("\xC3\xBC.txt"));
  IWN_CHECK_EQ(path("https://app.local/docs/"), std::string("docs/index.html"));
  IWN_CHECK_EQ(path("https://other.example/x.js"), std::string("<none>"));
  IWN_CHECK_EQ(path("https://app.local/a/..%2F..%2Fsecret"), std::string("<none>"));
  IWN_CHECK_EQ(path("https://app.local/a%00b"), std::string("<none>"));
  IWN_CHECK_EQ(path("https://app.local/a/../../b.js"), std::string("b.js"));  // normalised by the parser
}
