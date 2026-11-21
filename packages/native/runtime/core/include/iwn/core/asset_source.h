// Read-only access to packaged files (the APK's assets on Android, a directory on the host), V8-free.
// Paths are relative to the asset root ("app/index.html", "iwn/config.json"), '/'-separated, never absolute.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace iwn {

// Bytes of one asset. Either memory-mapped/owned by the platform (uncompressed APK entries are mapped, NET-3) or a
// heap copy; the object keeps the memory alive.
class AssetBytes {
 public:
  virtual ~AssetBytes() = default;
  virtual const uint8_t* data() const = 0;
  virtual size_t size() const = 0;
  std::string_view view() const { return {reinterpret_cast<const char*>(data()), size()}; }
};

class AssetSource {
 public:
  virtual ~AssetSource() = default;
  // nullptr if the asset does not exist.
  virtual std::shared_ptr<AssetBytes> read(std::string_view path) = 0;
  virtual bool exists(std::string_view path) = 0;
};

// Host implementation over a directory (tests, a future desktop host).
std::unique_ptr<AssetSource> make_directory_asset_source(std::string root);

// Heap-backed bytes helper.
std::shared_ptr<AssetBytes> make_owned_bytes(std::string data);

}  // namespace iwn
