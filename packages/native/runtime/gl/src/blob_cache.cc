#include "blob_cache.h"

#include <cstdio>
#include <cstring>

namespace iwn::gl {

namespace {
constexpr char kMagic[8] = {'I', 'W', 'N', 'B', 'L', 'O', 'B', '1'};
constexpr uint32_t kMaxEntry = 64u << 20;
BlobCache* g_cache = nullptr;

bool ReadU32(FILE* f, uint32_t* v) {
  uint8_t b[4];
  if (fread(b, 1, 4, f) != 4) return false;
  *v = uint32_t(b[0]) | uint32_t(b[1]) << 8 | uint32_t(b[2]) << 16 | uint32_t(b[3]) << 24;
  return true;
}
bool WriteU32(FILE* f, uint32_t v) {
  const uint8_t b[4] = {uint8_t(v), uint8_t(v >> 8), uint8_t(v >> 16), uint8_t(v >> 24)};
  return fwrite(b, 1, 4, f) == 4;
}
}  // namespace

BlobCache::BlobCache(std::string path, std::string invalidationKey, uint64_t maxBytes)
    : path_(std::move(path)), invalidation_key_(std::move(invalidationKey)), max_bytes_(maxBytes) {}

void BlobCache::Load() {
  std::lock_guard<std::mutex> lock(mu_);
  lru_.clear();
  map_.clear();
  bytes_ = 0;
  dirty_ = false;
  FILE* f = fopen(path_.c_str(), "rb");
  if (!f) return;
  char magic[8];
  uint32_t keyLen = 0;
  bool ok = fread(magic, 1, 8, f) == 8 && memcmp(magic, kMagic, 8) == 0 && ReadU32(f, &keyLen) && keyLen < 4096;
  std::string key(ok ? keyLen : 0, '\0');
  ok = ok && fread(key.data(), 1, keyLen, f) == keyLen && key == invalidation_key_;
  if (!ok) {
    fclose(f);
    dirty_ = true;  // stale or foreign: rewrite on next flush
    return;
  }
  for (;;) {
    uint32_t k = 0, v = 0;
    if (!ReadU32(f, &k) || !ReadU32(f, &v) || k == 0 || k > kMaxEntry || v > kMaxEntry) break;
    Entry e;
    e.key.resize(k);
    e.value.resize(v);
    if (fread(e.key.data(), 1, k, f) != k || fread(e.value.data(), 1, v, f) != v) break;
    if (map_.count(e.key)) continue;
    bytes_ += k + v;
    lru_.push_back(std::move(e));
    map_[lru_.back().key] = std::prev(lru_.end());
  }
  fclose(f);
  EvictLocked();
}

bool BlobCache::Flush() {
  // Snapshot under the lock, write without it (drivers call Set/Get from compiler threads).
  std::vector<std::pair<std::string, std::vector<uint8_t>>> snapshot;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (!dirty_ || path_.empty()) return true;
    snapshot.reserve(lru_.size());
    for (const Entry& e : lru_) snapshot.emplace_back(e.key, e.value);
    dirty_ = false;
  }
  const std::string tmp = path_ + ".tmp";
  FILE* f = fopen(tmp.c_str(), "wb");
  bool ok = f != nullptr;
  if (ok) {
    ok = fwrite(kMagic, 1, 8, f) == 8 && WriteU32(f, uint32_t(invalidation_key_.size())) &&
         fwrite(invalidation_key_.data(), 1, invalidation_key_.size(), f) == invalidation_key_.size();
    for (const auto& [k, v] : snapshot) {
      if (!ok) break;
      ok = WriteU32(f, uint32_t(k.size())) && WriteU32(f, uint32_t(v.size())) &&
           fwrite(k.data(), 1, k.size(), f) == k.size() && fwrite(v.data(), 1, v.size(), f) == v.size();
    }
    ok = (fclose(f) == 0) && ok;
  }
  if (!ok || rename(tmp.c_str(), path_.c_str()) != 0) {
    remove(tmp.c_str());
    std::lock_guard<std::mutex> lock(mu_);
    dirty_ = true;
    return false;
  }
  return true;
}

bool BlobCache::dirty() {
  std::lock_guard<std::mutex> lock(mu_);
  return dirty_;
}

void BlobCache::Set(const void* key, size_t keySize, const void* value, size_t valueSize) {
  if (!key || !keySize || keySize > kMaxEntry || valueSize > kMaxEntry) return;
  if (keySize + valueSize > max_bytes_) return;
  std::lock_guard<std::mutex> lock(mu_);
  std::string k(static_cast<const char*>(key), keySize);
  auto it = map_.find(k);
  if (it != map_.end()) {
    bytes_ -= it->second->key.size() + it->second->value.size();
    lru_.erase(it->second);
    map_.erase(it);
  }
  Entry e;
  e.key = std::move(k);
  e.value.assign(static_cast<const uint8_t*>(value), static_cast<const uint8_t*>(value) + valueSize);
  bytes_ += e.key.size() + e.value.size();
  lru_.push_front(std::move(e));
  map_[lru_.front().key] = lru_.begin();
  dirty_ = true;
  EvictLocked();
}

size_t BlobCache::Get(const void* key, size_t keySize, void* value, size_t valueSize) {
  if (!key || !keySize) return 0;
  std::lock_guard<std::mutex> lock(mu_);
  auto it = map_.find(std::string(static_cast<const char*>(key), keySize));
  if (it == map_.end()) {
    misses_++;
    return 0;
  }
  hits_++;
  lru_.splice(lru_.begin(), lru_, it->second);
  const auto& v = it->second->value;
  // EGL_ANDROID_blob_cache: copy only if the caller's buffer holds the whole value.
  if (value && valueSize >= v.size()) memcpy(value, v.data(), v.size());
  return v.size();
}

void BlobCache::EvictLocked() {
  while (bytes_ > max_bytes_ && !lru_.empty()) {
    const Entry& e = lru_.back();
    bytes_ -= e.key.size() + e.value.size();
    map_.erase(e.key);
    lru_.pop_back();
    dirty_ = true;
  }
}

void BlobCache::SetGlobal(BlobCache* cache) { g_cache = cache; }

void BlobCache::EglSet(const void* key, long keySize, const void* value, long valueSize) {
  if (g_cache && keySize > 0 && valueSize >= 0) g_cache->Set(key, size_t(keySize), value, size_t(valueSize));
}

long BlobCache::EglGet(const void* key, long keySize, void* value, long valueSize) {
  if (!g_cache || keySize <= 0 || valueSize < 0) return 0;
  return long(g_cache->Get(key, size_t(keySize), value, size_t(valueSize)));
}

}  // namespace iwn::gl
