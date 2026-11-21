// AssetSource over the APK's assets (Android NDK AAssetManager). Uncompressed entries are memory-mapped by
// AAsset_getBuffer (NET-3); compressed ones are inflated once into memory the AAsset owns.
#include "apk_assets.h"

#include <android/asset_manager.h>

namespace iwn {
namespace {

class ApkAssetBytes : public AssetBytes {
 public:
  explicit ApkAssetBytes(AAsset* asset) : asset_(asset) {
    data_ = static_cast<const uint8_t*>(AAsset_getBuffer(asset_));
    size_ = static_cast<size_t>(AAsset_getLength64(asset_));
  }
  ~ApkAssetBytes() override { AAsset_close(asset_); }
  const uint8_t* data() const override { return data_; }
  size_t size() const override { return size_; }
  bool ok() const { return data_ != nullptr || size_ == 0; }

 private:
  AAsset* asset_;
  const uint8_t* data_ = nullptr;
  size_t size_ = 0;
};

bool safe_relative(const std::string& p) {
  if (p.empty() || p[0] == '/') return false;
  size_t start = 0;
  while (start <= p.size()) {
    size_t end = p.find('/', start);
    if (end == std::string::npos) end = p.size();
    if (p.compare(start, end - start, "..") == 0 && end - start == 2) return false;
    start = end + 1;
  }
  return true;
}

class ApkAssets : public AssetSource {
 public:
  explicit ApkAssets(AAssetManager* mgr) : mgr_(mgr) {}
  std::shared_ptr<AssetBytes> read(std::string_view path) override {
    std::string p(path);
    if (!safe_relative(p)) return nullptr;
    AAsset* a = AAssetManager_open(mgr_, p.c_str(), AASSET_MODE_BUFFER);
    if (!a) return nullptr;
    auto bytes = std::make_shared<ApkAssetBytes>(a);
    if (!bytes->ok()) return nullptr;
    return bytes;
  }
  bool exists(std::string_view path) override {
    std::string p(path);
    if (!safe_relative(p)) return false;
    AAsset* a = AAssetManager_open(mgr_, p.c_str(), AASSET_MODE_UNKNOWN);
    if (!a) return false;
    AAsset_close(a);
    return true;
  }

 private:
  AAssetManager* mgr_;
};

}  // namespace

std::shared_ptr<AssetSource> make_apk_asset_source(AAssetManager* mgr) { return std::make_shared<ApkAssets>(mgr); }

}  // namespace iwn
