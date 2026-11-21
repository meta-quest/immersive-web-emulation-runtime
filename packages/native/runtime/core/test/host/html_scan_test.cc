// MOD-1, MOD-7 (index.html scan): classic and module scripts in order, preloads, title, base, comments.
#include "iwn/core/html_scan.h"
#include "iwn_test.h"

using namespace iwn;

IWN_TEST(HtmlScan, ViteIndex) {
  const char* html = R"(<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Proto &amp; Showcase</title>
    <!-- <script type="module" src="/commented.js"></script> -->
    <script>window.__classic = 1;</script>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-def.js">
    <link rel="stylesheet" href="/assets/index.css">
    <script src="/legacy.js" defer></script>
    <SCRIPT TYPE="text/json">{"not":"js"}</SCRIPT>
    <script nomodule src="/old.js"></script>
    <style> .x { content: "<script>"; } </style>
  </head>
  <body><div id="app"></div></body>
</html>)";
  auto info = scan_html(html);
  IWN_CHECK_EQ(info.title, std::string("Proto & Showcase"));
  IWN_CHECK_EQ(info.scripts.size(), size_t(3));
  IWN_CHECK(info.scripts[0].classic);
  IWN_CHECK_EQ(info.scripts[0].inline_text, std::string("window.__classic = 1;"));
  IWN_CHECK(info.scripts[1].module);
  IWN_CHECK_EQ(info.scripts[1].src, std::string("/assets/index-abc123.js"));
  IWN_CHECK(info.scripts[2].classic && info.scripts[2].defer);
  IWN_CHECK_EQ(info.scripts[2].src, std::string("/legacy.js"));
  IWN_CHECK_EQ(info.modulepreloads.size(), size_t(1));
  IWN_CHECK_EQ(info.modulepreloads[0], std::string("/assets/vendor-def.js"));
  IWN_CHECK_EQ(info.scripts[1].line, size_t(8));
}

IWN_TEST(HtmlScan, InlineModuleAndBase) {
  auto info = scan_html(
      "<base href='/sub/'><script type=module>import './a.js'</script><script type='text/javascript' src=x.js>"
      "</script>");
  IWN_CHECK_EQ(info.base_href, std::string("/sub/"));
  IWN_CHECK_EQ(info.scripts.size(), size_t(2));
  IWN_CHECK(info.scripts[0].module);
  IWN_CHECK_EQ(info.scripts[0].inline_text, std::string("import './a.js'"));
  IWN_CHECK(info.scripts[1].classic);
  IWN_CHECK_EQ(info.scripts[1].src, std::string("x.js"));
}

IWN_TEST(HtmlScan, NoModuleEntry) {
  auto info = scan_html("<html><body>hi</body></html>");
  IWN_CHECK(info.scripts.empty());
}

IWN_TEST(HtmlScan, ScriptBodyWithLessThan) {
  auto info = scan_html("<script>if (a < b && c > d) {}</script><script type=\"module\" src=\"/m.js\"></script>");
  IWN_CHECK_EQ(info.scripts.size(), size_t(2));
  IWN_CHECK_EQ(info.scripts[0].inline_text, std::string("if (a < b && c > d) {}"));
}

IWN_TEST(HtmlScan, Entities) {
  IWN_CHECK_EQ(decode_html_entities("a&amp;b&lt;&#65;&#x42;&unknown;"), std::string("a&b<AB&unknown;"));
}
