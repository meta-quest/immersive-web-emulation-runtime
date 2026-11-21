/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Hashes against FIPS 180-4 / RFC test vectors, base64, data: URLs (NET-12), MIME table (NET-2).
#include <cstdio>
#include <set>
#include <string>

#include "iwn/core/clock.h"
#include "iwn/core/text.h"
#include "iwn_test.h"

using namespace iwn;

IWN_TEST(Text, Sha1Vectors) {
  std::string abc = "abc";
  IWN_CHECK_EQ(to_hex(sha1(abc.data(), abc.size())), std::string("a9993e364706816aba3e25717850c26c9cd0d89d"));
  IWN_CHECK_EQ(to_hex(sha1("", 0)), std::string("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
  std::string two = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  IWN_CHECK_EQ(to_hex(sha1(two.data(), two.size())), std::string("84983e441c3bd26ebaae4aa1f95129e5e54670f1"));
}

IWN_TEST(Text, Sha256Vectors) {
  std::string abc = "abc";
  IWN_CHECK_EQ(to_hex(sha256(abc.data(), abc.size())),
               std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  IWN_CHECK_EQ(to_hex(sha256("", 0)),
               std::string("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
  std::string million(1000000, 'a');
  IWN_CHECK_EQ(to_hex(sha256(million.data(), million.size())),
               std::string("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
}

IWN_TEST(Text, Base64) {
  IWN_CHECK_EQ(base64_encode("", 0), std::string(""));
  IWN_CHECK_EQ(base64_encode("f", 1), std::string("Zg=="));
  IWN_CHECK_EQ(base64_encode("fo", 2), std::string("Zm8="));
  IWN_CHECK_EQ(base64_encode("foobar", 6), std::string("Zm9vYmFy"));
  auto d = base64_decode("Zm9v YmE=");
  IWN_CHECK(d.has_value());
  IWN_CHECK_EQ(std::string(d->begin(), d->end()), std::string("fooba"));
  IWN_CHECK(base64_decode("Zm9vY").has_value() == false);  // length % 4 == 1
  IWN_CHECK(!base64_decode("Zm$v").has_value());
  auto nopad = base64_decode("Zm8");
  IWN_CHECK_EQ(std::string(nopad->begin(), nopad->end()), std::string("fo"));
}

IWN_TEST(Text, DataUrls) {
  auto a = decode_data_url("data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgNDI7");
  IWN_CHECK(a.has_value());
  IWN_CHECK_EQ(a->mime_type, std::string("text/javascript"));
  IWN_CHECK_EQ(std::string(a->body.begin(), a->body.end()), std::string("export default 42;"));
  auto b = decode_data_url("data:text/javascript,export%20const%20x%20%3D%201%3B");
  IWN_CHECK_EQ(std::string(b->body.begin(), b->body.end()), std::string("export const x = 1;"));
  auto c = decode_data_url("data:,hello");
  IWN_CHECK_EQ(c->mime_type, std::string("text/plain;charset=US-ASCII"));
  IWN_CHECK(!decode_data_url("data:nocomma").has_value());
  IWN_CHECK(!decode_data_url("http://x/").has_value());
  auto d = decode_data_url("DATA:application/octet-stream;BASE64,AAEC");
  IWN_CHECK_EQ(d->body.size(), size_t(3));
}

IWN_TEST(Text, MimeTable) {
  IWN_CHECK_EQ(std::string(mime_type_for_path("assets/main.js")), std::string("text/javascript"));
  IWN_CHECK_EQ(std::string(mime_type_for_path("a.MJS")), std::string("text/javascript"));
  IWN_CHECK_EQ(std::string(mime_type_for_path("x.wasm")), std::string("application/wasm"));
  IWN_CHECK_EQ(std::string(mime_type_for_path("m.glb")), std::string("model/gltf-binary"));
  IWN_CHECK_EQ(std::string(mime_type_for_path("t.ktx2")), std::string("image/ktx2"));
  IWN_CHECK_EQ(std::string(mime_type_for_path("noext")), std::string("application/octet-stream"));
  IWN_CHECK_EQ(std::string(mime_type_for_path("dir.v1/file")), std::string("application/octet-stream"));
  IWN_CHECK(is_javascript_mime("text/javascript; charset=utf-8"));
  IWN_CHECK(is_javascript_mime("Application/JavaScript"));
  IWN_CHECK(!is_javascript_mime("application/json"));
}

IWN_TEST(Text, HeaderTokens) {
  IWN_CHECK(header_has_token("keep-alive, Upgrade", "upgrade"));
  IWN_CHECK(header_has_token("UPGRADE", "upgrade"));
  IWN_CHECK(!header_has_token("keep-alive", "upgrade"));
  IWN_CHECK(!header_has_token("upgraded", "upgrade"));
  IWN_CHECK(iequals("WebSocket", "websocket"));
}

IWN_TEST(Text, ShaPaddingBoundaries) {
  // 56 bytes: the length no longer fits in the last data block, so padding needs a second block (FIPS 180-2 vectors).
  std::string s56 = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  IWN_CHECK_EQ(to_hex(sha256(s56.data(), s56.size())),
               std::string("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
  IWN_CHECK_EQ(to_hex(sha1(s56.data(), s56.size())), std::string("84983e441c3bd26ebaae4aa1f95129e5e54670f1"));
  // Every tail length hashes like a byte-at-a-time reference would: compare split points via distinct outputs.
  std::string base(130, 'q');
  std::set<std::string> seen;
  for (size_t n = 50; n <= 130; ++n) seen.insert(to_hex(sha256(base.data(), n)));
  IWN_CHECK_EQ(seen.size(), size_t(81));
}

IWN_TEST(Text, FastHash128) {
  std::string a(1000, 'x');
  auto h1 = fast_hash128(a.data(), a.size());
  IWN_CHECK(h1 == fast_hash128(a.data(), a.size()));
  std::set<std::string> seen;
  for (size_t i = 0; i < a.size(); i += 37) {
    std::string b = a;
    b[i] ^= 1;  // a single-bit change anywhere changes the hash
    seen.insert(to_hex(fast_hash128(b.data(), b.size())));
  }
  IWN_CHECK_EQ(seen.size(), size_t((a.size() + 36) / 37));
  IWN_CHECK(seen.count(to_hex(h1)) == 0);
  // Trailing zero bytes and length changes are distinct.
  std::string z1("a", 1), z2("a\0", 2), z3("", 0);
  IWN_CHECK(fast_hash128(z1.data(), 1) != fast_hash128(z2.data(), 2));
  IWN_CHECK(fast_hash128(z3.data(), 0) != fast_hash128(z2.data() + 1, 1));
  std::set<std::string> lens;
  std::string zeros(100, '\0');
  for (size_t n = 0; n <= 100; ++n) lens.insert(to_hex(fast_hash128(zeros.data(), n)));
  IWN_CHECK_EQ(lens.size(), size_t(101));
  // Speed: 7 MiB (the showcase chunk size) well under the SHA-256 cost.
  std::string big(7u << 20, '\0');
  for (size_t i = 0; i < big.size(); ++i) big[i] = static_cast<char>(i * 2654435761u >> 13);
  double t0 = iwn::now_ms();
  auto hb = fast_hash128(big.data(), big.size());
  double fast_ms = iwn::now_ms() - t0;
  t0 = iwn::now_ms();
  auto hs = sha256(big.data(), big.size());
  double sha_ms = iwn::now_ms() - t0;
  (void)hb;
  (void)hs;
  printf("    fast_hash128 7 MiB: %.2f ms; sha256: %.2f ms\n", fast_ms, sha_ms);
  IWN_CHECK(fast_ms * 4 < sha_ms);
}

IWN_TEST(Text, ScanStaticImportSpecifiers) {
  // Vite-style minified output plus the forms that must not count.
  const char* src =
      "import{a as b}from\"./chunk-A.js\";import\"./side.js\";export{c}from'./re.js';"
      "export*from\"./star.js\";import x,{y}from './spaced.js'\n"
      "const s='import \"./in-string.js\"';// import \"./in-comment.js\"\n"
      "/* from \"./block.js\" */ const t=`from \"./tpl.js\"`;"
      "import('./dynamic.js');const u=import.meta.url;obj.import(\"./member.js\");let from_=1;";
  std::vector<std::string> got = scan_static_import_specifiers(src);
  std::vector<std::string> want = {"./chunk-A.js", "./side.js", "./re.js", "./star.js", "./spaced.js"};
  IWN_CHECK_EQ(got.size(), want.size());
  for (size_t i = 0; i < want.size() && i < got.size(); ++i) IWN_CHECK_EQ(got[i], want[i]);
  IWN_CHECK(scan_static_import_specifiers("import\"a\";import\"b\";import\"c\"", 2).size() == 2);
  IWN_CHECK(scan_static_import_specifiers("").empty());
  IWN_CHECK(scan_static_import_specifiers("import \"unterminated").size() == 1);
}
