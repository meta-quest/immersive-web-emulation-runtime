// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Read-only access to the app's bundled files (the Vite `dist/` packed into
// the APK's assets). Spec NET-1 (every file by its same-origin URL, byte for
// byte, `_`/`.`-prefixed and non-ASCII names), NET-3 (one copy at most:
// mapped when the asset is stored uncompressed), NET-4 (missing → 404,
// `..` → missing).
//
// AssetSource implementations: DirAssetSource (a directory: host tests and
// the headless runner) and AndroidAssetSource (AAssetManager; android only).
// The module loader can use the same source.

#ifndef IWN_NET_ASSETS_H_
#define IWN_NET_ASSETS_H_

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

namespace iwn::net {

// Owned bytes of one asset. The memory stays valid until the blob is
// destroyed; it is writable (copy-on-write for mapped files) so it can back a
// JS ArrayBuffer directly.
class AssetBlob {
 public:
  virtual ~AssetBlob() = default;
  virtual uint8_t* data() = 0;
  virtual size_t size() const = 0;
  // True if the bytes are a private file mapping (no heap copy was made).
  virtual bool mapped() const = 0;
};

enum class AssetStatus { kOk, kNotFound, kIoError };

class AssetSource {
 public:
  virtual ~AssetSource() = default;
  // `rel` is a normalised relative path from AssetPathFromUrlPath. Blocking;
  // call it from a background thread.
  virtual AssetStatus Open(const std::string& rel, std::unique_ptr<AssetBlob>* out) = 0;
  // Cheap existence/size probe. Blocking but fast.
  virtual AssetStatus Stat(const std::string& rel, uint64_t* size) = 0;
};

// Maps a URL path ("/assets/%C3%BC.txt?v=1") to a relative asset path
// ("assets/ü.txt"). Directory paths get "index.html". Returns false for
// paths that leave the root, contain encoded '/' or NUL, or have malformed
// escapes; such paths are treated as missing (404).
bool AssetPathFromUrlPath(std::string_view url_path, std::string* rel);

// NET-2: Content-Type by extension (case-insensitive), else
// "application/octet-stream".
const char* MimeTypeForPath(std::string_view path);

// Files larger than this are mapped instead of read (when possible).
constexpr size_t kAssetMapThreshold = 64 * 1024;

class DirAssetSource : public AssetSource {
 public:
  explicit DirAssetSource(std::string root);
  AssetStatus Open(const std::string& rel, std::unique_ptr<AssetBlob>* out) override;
  AssetStatus Stat(const std::string& rel, uint64_t* size) override;

 private:
  std::string root_;
};

// A heap blob (used for small files and compressed APK entries).
std::unique_ptr<AssetBlob> MakeHeapBlob(size_t size);
// Maps [offset, offset+size) of an open fd privately (copy-on-write). The fd
// may be closed afterwards. Returns null on failure.
std::unique_ptr<AssetBlob> MapFileRange(int fd, uint64_t offset, size_t size);

}  // namespace iwn::net

#endif  // IWN_NET_ASSETS_H_
