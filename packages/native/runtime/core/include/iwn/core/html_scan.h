// Scans a Vite dist's index.html for what boot needs (MOD-1, MOD-7): scripts in document order (classic or module,
// external or inline), modulepreload links, <base href> and <title>. This is a tag scanner, not an HTML parser:
// it skips comments and raw-text elements correctly, which is enough for build output. The packer (PKG-5) does the
// same at pack time; the runtime does it at launch so an unpacked dist also boots.
#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace iwn {

struct HtmlScript {
  bool module = false;      // type="module"
  bool classic = true;      // a classic script (no type, or a JavaScript MIME type)
  bool async = false;
  bool defer = false;
  bool nomodule = false;
  std::string src;          // empty for inline
  std::string inline_text;  // inline source
  size_t line = 1;          // 1-based line of the <script> tag
};

struct HtmlDocumentInfo {
  std::vector<HtmlScript> scripts;
  std::vector<std::string> modulepreloads;
  std::string base_href;
  std::string title;
};

HtmlDocumentInfo scan_html(std::string_view html);

// Decodes the few character references attribute values in build output use (&amp; &lt; &gt; &quot; &#39; &#NN;).
std::string decode_html_entities(std::string_view in);

}  // namespace iwn
