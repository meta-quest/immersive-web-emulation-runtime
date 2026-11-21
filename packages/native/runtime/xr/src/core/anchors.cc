#include "iwn/xr/anchors.h"

#include <cstring>

namespace iwn::xr {

std::string format_uuid(const uint8_t bytes[16]) {
  static const char kHex[] = "0123456789abcdef";
  std::string s;
  s.reserve(36);
  for (int i = 0; i < 16; ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) s.push_back('-');
    s.push_back(kHex[bytes[i] >> 4]);
    s.push_back(kHex[bytes[i] & 0xF]);
  }
  return s;
}

bool parse_uuid(const std::string& text, uint8_t out[16]) {
  if (text.size() != 36) return false;
  uint8_t bytes[16];
  int n = 0;
  for (size_t i = 0; i < 36;) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (text[i] != '-') return false;
      ++i;
      continue;
    }
    int v[2];
    for (int k = 0; k < 2; ++k) {
      const char c = text[i + k];
      if (c >= '0' && c <= '9') v[k] = c - '0';
      else if (c >= 'a' && c <= 'f') v[k] = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v[k] = c - 'A' + 10;
      else return false;
    }
    bytes[n++] = static_cast<uint8_t>(v[0] << 4 | v[1]);
    i += 2;
  }
  std::memcpy(out, bytes, 16);
  return true;
}

AnchorTable::AnchorTable() {
  for (int i = 0; i < kMaxAnchors; ++i) {
    state_[i] = State::kFree;
    gen_[i] = 0;
  }
  std::memset(poses_, 0, sizeof(poses_));
}

bool AnchorTable::current(uint32_t id) const {
  const int slot = anchor_slot(id);
  return id != 0 && slot < kMaxAnchors && (id >> 8) == gen_[slot] && state_[slot] != State::kFree;
}

uint32_t AnchorTable::reserve() {
  std::lock_guard<std::mutex> lock(mu_);
  for (int i = 0; i < kMaxAnchors; ++i) {
    if (state_[i] != State::kFree) continue;
    // generations count from 1, so no id is 0; they wrap within 24 bits
    gen_[i] = (gen_[i] % 0xFFFFFF) + 1;
    state_[i] = State::kPending;
    return static_cast<uint32_t>(i) | gen_[i] << 8;
  }
  return 0;
}

AnchorTable::State AnchorTable::state(uint32_t id) const {
  std::lock_guard<std::mutex> lock(mu_);
  return current(id) ? state_[anchor_slot(id)] : State::kFree;
}

bool AnchorTable::go_live(uint32_t id) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!current(id) || state_[anchor_slot(id)] != State::kPending) return false;
  state_[anchor_slot(id)] = State::kLive;
  return true;
}

bool AnchorTable::release(uint32_t id) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!current(id)) return false;
  State& s = state_[anchor_slot(id)];
  if (s == State::kReleasing) return false;
  s = State::kReleasing;
  return true;
}

void AnchorTable::free(uint32_t id) {
  std::lock_guard<std::mutex> lock(mu_);
  const int slot = anchor_slot(id);
  if (!current(id)) return;
  state_[slot] = State::kFree;
  std::memset(poses_ + slot * kAnchorStride, 0, sizeof(float) * kAnchorStride);
}

int AnchorTable::release_all() {
  std::lock_guard<std::mutex> lock(mu_);
  int n = 0;
  for (int i = 0; i < kMaxAnchors; ++i) {
    if (state_[i] == State::kPending || state_[i] == State::kLive) {
      state_[i] = State::kReleasing;
      ++n;
    }
  }
  return n;
}

uint32_t AnchorTable::id_of(int slot) const {
  std::lock_guard<std::mutex> lock(mu_);
  return slot >= 0 && slot < kMaxAnchors ? static_cast<uint32_t>(slot) | gen_[slot] << 8 : 0;
}

int AnchorTable::live_count() const {
  std::lock_guard<std::mutex> lock(mu_);
  int n = 0;
  for (int i = 0; i < kMaxAnchors; ++i) n += state_[i] == State::kLive ? 1 : 0;
  return n;
}

void AnchorTable::clear() {
  std::lock_guard<std::mutex> lock(mu_);
  for (int i = 0; i < kMaxAnchors; ++i) state_[i] = State::kFree;
  std::memset(poses_, 0, sizeof(poses_));
}

void AnchorTable::write_pose(int slot, const XrPosef& pose, bool located) {
  if (slot < 0 || slot >= kMaxAnchors) return;
  float* p = poses_ + slot * kAnchorStride;
  p[0] = located ? 1.0f : 0.0f;
  if (!located) return;  // the last pose stays; JS shows none while flags is 0
  p[1] = pose.position.x;
  p[2] = pose.position.y;
  p[3] = pose.position.z;
  p[4] = pose.orientation.x;
  p[5] = pose.orientation.y;
  p[6] = pose.orientation.z;
  p[7] = pose.orientation.w;
}

}  // namespace iwn::xr
