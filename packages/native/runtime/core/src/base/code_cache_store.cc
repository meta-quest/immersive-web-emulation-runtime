#include "iwn/core/code_cache_store.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "iwn/core/log.h"
#include "iwn/core/text.h"

namespace iwn {
namespace {

constexpr char kMagic[4] = {'I', 'W', 'N', 'C'};
constexpr uint32_t kFormatVersion = 2;  // 2: fast_hash128 source hash and checksum
constexpr size_t kHeaderSize = 4 + 4 + 4 + 32 + 8 + 8;  // magic, format, v8 tag, source hash, length, checksum

uint64_t checksum64(const uint8_t* p, size_t n) {
  auto h = fast_hash128(p, n);
  uint64_t x = 0;
  for (int i = 0; i < 8; ++i) x |= uint64_t(h[i]) << (i * 8);
  return x;
}

void put_u32(std::vector<uint8_t>& v, uint32_t x) {
  for (int i = 0; i < 4; ++i) v.push_back(static_cast<uint8_t>(x >> (i * 8)));
}
void put_u64(std::vector<uint8_t>& v, uint64_t x) {
  for (int i = 0; i < 8; ++i) v.push_back(static_cast<uint8_t>(x >> (i * 8)));
}
uint32_t get_u32(const uint8_t* p) {
  uint32_t x = 0;
  for (int i = 0; i < 4; ++i) x |= uint32_t(p[i]) << (i * 8);
  return x;
}
uint64_t get_u64(const uint8_t* p) {
  uint64_t x = 0;
  for (int i = 0; i < 8; ++i) x |= uint64_t(p[i]) << (i * 8);
  return x;
}

bool mkdirs(const std::string& path) {
  if (path.empty()) return false;
  std::string cur;
  size_t pos = 0;
  while (pos != std::string::npos) {
    pos = path.find('/', pos + 1);
    cur = path.substr(0, pos);
    if (cur.empty()) continue;
    if (mkdir(cur.c_str(), 0700) != 0 && errno != EEXIST) return false;
  }
  return true;
}

bool read_file(const std::string& path, std::vector<uint8_t>* out) {
  FILE* f = fopen(path.c_str(), "rb");
  if (!f) return false;
  out->clear();
  uint8_t buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out->insert(out->end(), buf, buf + n);
  fclose(f);
  return true;
}

bool write_file_atomic(const std::string& path, const uint8_t* data, size_t len) {
  std::string tmp = path + ".tmp" + std::to_string(getpid()) + "-" + std::to_string(reinterpret_cast<uintptr_t>(data));
  FILE* f = fopen(tmp.c_str(), "wb");
  if (!f) return false;
  bool ok = fwrite(data, 1, len, f) == len;
  ok = (fflush(f) == 0) && ok;
  fclose(f);
  if (!ok || rename(tmp.c_str(), path.c_str()) != 0) {
    unlink(tmp.c_str());
    return false;
  }
  return true;
}

void wipe_dir(const std::string& dir) {
  DIR* d = opendir(dir.c_str());
  if (!d) return;
  while (dirent* e = readdir(d)) {
    std::string name = e->d_name;
    if (name == "." || name == "..") continue;
    unlink((dir + "/" + name).c_str());
  }
  closedir(d);
}

}  // namespace

CodeCacheStore::CodeCacheStore(std::string dir, std::string stamp, uint64_t max_bytes)
    : dir_(std::move(dir)), max_bytes_(max_bytes) {
  mkdirs(dir_);
  std::string stamp_path = dir_ + "/STAMP";
  std::vector<uint8_t> old;
  bool same = read_file(stamp_path, &old) && std::string(old.begin(), old.end()) == stamp;
  if (!same) {
    wipe_dir(dir_);
    write_file_atomic(stamp_path, reinterpret_cast<const uint8_t*>(stamp.data()), stamp.size());
  }
}

CodeCacheStore::SourceHash CodeCacheStore::hash_source(std::string_view source) {
  // 128-bit fast hash plus the length (a full SHA-256 of a 7 MB chunk cost ~57 ms on the Quest 3S at
  // every boot). The rest of the array stays zero.
  SourceHash out{};
  auto h = fast_hash128(source.data(), source.size());
  std::copy(h.begin(), h.end(), out.begin());
  uint64_t n = source.size();
  for (int i = 0; i < 8; ++i) out[16 + i] = static_cast<uint8_t>(n >> (i * 8));
  return out;
}

std::string CodeCacheStore::path_for(std::string_view url) const {
  auto h = sha256(url.data(), url.size());
  return dir_ + "/" + to_hex(h.data(), 16) + ".cc";
}

const char* CodeCacheStore::result_name(Result r) {
  switch (r) {
    case Result::kHit: return "hit";
    case Result::kMiss: return "miss";
    case Result::kStale: return "stale";
    case Result::kCorrupt: return "corrupt";
  }
  return "?";
}

CodeCacheStore::Result CodeCacheStore::lookup(std::string_view url, const SourceHash& source_hash, uint32_t v8_tag,
                                              std::vector<uint8_t>* out) {
  std::lock_guard<std::mutex> lock(mu_);
  std::string path = path_for(url);
  std::vector<uint8_t> file;
  if (!read_file(path, &file)) return Result::kMiss;
  if (file.size() < kHeaderSize || memcmp(file.data(), kMagic, 4) != 0 || get_u32(&file[4]) != kFormatVersion) {
    unlink(path.c_str());
    return Result::kCorrupt;
  }
  uint32_t tag = get_u32(&file[8]);
  uint64_t len = get_u64(&file[44]);
  uint64_t sum = get_u64(&file[52]);
  if (len != file.size() - kHeaderSize || checksum64(file.data() + kHeaderSize, len) != sum) {
    unlink(path.c_str());
    return Result::kCorrupt;
  }
  if (tag != v8_tag || memcmp(&file[12], source_hash.data(), 32) != 0) {
    unlink(path.c_str());
    return Result::kStale;
  }
  out->assign(file.begin() + kHeaderSize, file.end());
  utimensat(AT_FDCWD, path.c_str(), nullptr, 0);  // LRU touch
  return Result::kHit;
}

bool CodeCacheStore::store(std::string_view url, const SourceHash& source_hash, uint32_t v8_tag, const uint8_t* data,
                           size_t len) {
  std::vector<uint8_t> file;
  file.reserve(kHeaderSize + len);
  file.insert(file.end(), kMagic, kMagic + 4);
  put_u32(file, kFormatVersion);
  put_u32(file, v8_tag);
  file.insert(file.end(), source_hash.begin(), source_hash.end());
  put_u64(file, len);
  put_u64(file, checksum64(data, len));
  file.insert(file.end(), data, data + len);
  std::lock_guard<std::mutex> lock(mu_);
  if (!write_file_atomic(path_for(url), file.data(), file.size())) return false;
  enforce_bound_locked();
  return true;
}

void CodeCacheStore::remove(std::string_view url) {
  std::lock_guard<std::mutex> lock(mu_);
  unlink(path_for(url).c_str());
}

uint64_t CodeCacheStore::total_bytes() {
  std::lock_guard<std::mutex> lock(mu_);
  uint64_t total = 0;
  DIR* d = opendir(dir_.c_str());
  if (!d) return 0;
  while (dirent* e = readdir(d)) {
    std::string name = e->d_name;
    if (name.size() < 3 || name.substr(name.size() - 3) != ".cc") continue;
    struct stat st{};
    if (stat((dir_ + "/" + name).c_str(), &st) == 0) total += static_cast<uint64_t>(st.st_size);
  }
  closedir(d);
  return total;
}

void CodeCacheStore::enforce_bound_locked() {
  struct Item {
    std::string path;
    uint64_t size;
    int64_t mtime_ns;
  };
  std::vector<Item> items;
  uint64_t total = 0;
  DIR* d = opendir(dir_.c_str());
  if (!d) return;
  while (dirent* e = readdir(d)) {
    std::string name = e->d_name;
    if (name.size() < 3 || name.substr(name.size() - 3) != ".cc") continue;
    std::string p = dir_ + "/" + name;
    struct stat st{};
    if (stat(p.c_str(), &st) != 0) continue;
    int64_t mt = static_cast<int64_t>(st.st_mtim.tv_sec) * 1000000000LL + st.st_mtim.tv_nsec;
    items.push_back({p, static_cast<uint64_t>(st.st_size), mt});
    total += static_cast<uint64_t>(st.st_size);
  }
  closedir(d);
  if (total <= max_bytes_) return;
  std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.mtime_ns < b.mtime_ns; });
  for (const auto& it : items) {
    if (total <= max_bytes_) break;
    unlink(it.path.c_str());
    total -= it.size;
  }
}

}  // namespace iwn
