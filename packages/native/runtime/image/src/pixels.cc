#include "iwn/image/pixels.h"

#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>

#if defined(__ANDROID__)
#include <android/hardware_buffer.h>
#endif

namespace iwn::image {

ScopedPixels::ScopedPixels(ScopedPixels&& other) noexcept
    : view_(other.view_), ok_(other.ok_), locked_(other.locked_) {
  other.view_ = {};
  other.ok_ = false;
  other.locked_ = nullptr;
}

ScopedPixels& ScopedPixels::operator=(ScopedPixels&& other) noexcept {
  if (this != &other) {
    if (locked_) locked_->Unlock();
    view_ = other.view_;
    ok_ = other.ok_;
    locked_ = other.locked_;
    other.view_ = {};
    other.ok_ = false;
    other.locked_ = nullptr;
  }
  return *this;
}

ScopedPixels::~ScopedPixels() {
  if (locked_) locked_->Unlock();
}

std::unique_ptr<PixelStore> PixelStore::AllocateHeap(uint32_t width, uint32_t height, bool zero) {
  if (width == 0 || height == 0) {
    auto store = std::unique_ptr<PixelStore>(new PixelStore());
    store->width_ = width;
    store->height_ = height;
    return store;
  }
  uint64_t pixels = 0;
  if (__builtin_mul_overflow(uint64_t{width}, uint64_t{height}, &pixels) || pixels > kMaxPixels) return nullptr;
  // width <= kMaxPixels here, so the row cannot overflow; the total is still checked rather than assumed.
  const uint64_t row = (static_cast<uint64_t>(width) * 4 + 15) & ~uint64_t{15};
  uint64_t total = 0;
  if (__builtin_mul_overflow(row, uint64_t{height}, &total)) return nullptr;
  if (total > std::numeric_limits<size_t>::max() / 2) return nullptr;
  void* mem = nullptr;
  if (posix_memalign(&mem, 64, static_cast<size_t>(total)) != 0 || mem == nullptr) return nullptr;
  if (zero) std::memset(mem, 0, static_cast<size_t>(total));
  auto store = std::unique_ptr<PixelStore>(new (std::nothrow) PixelStore());
  if (!store) {
    std::free(mem);
    return nullptr;
  }
  store->width_ = width;
  store->height_ = height;
  store->stride_ = static_cast<size_t>(row);
  store->heap_ = static_cast<uint8_t*>(mem);
  return store;
}

#if defined(__ANDROID__)
std::unique_ptr<PixelStore> PixelStore::AllocateHardwareBuffer(uint32_t width, uint32_t height) {
  if (width == 0 || height == 0) return nullptr;
  uint64_t pixels = 0;
  if (__builtin_mul_overflow(uint64_t{width}, uint64_t{height}, &pixels) || pixels > kMaxPixels) return nullptr;
  AHardwareBuffer_Desc desc = {};
  desc.width = width;
  desc.height = height;
  desc.layers = 1;
  desc.format = AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM;
  desc.usage = AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN | AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN |
               AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE;
  AHardwareBuffer* buffer = nullptr;
  if (AHardwareBuffer_allocate(&desc, &buffer) != 0 || buffer == nullptr) return nullptr;
  AHardwareBuffer_Desc actual = {};
  AHardwareBuffer_describe(buffer, &actual);
  auto store = std::unique_ptr<PixelStore>(new (std::nothrow) PixelStore());
  if (!store) {
    AHardwareBuffer_release(buffer);
    return nullptr;
  }
  store->width_ = width;
  store->height_ = height;
  store->stride_ = static_cast<size_t>(actual.stride) * 4;
  store->backing_ = Backing::kHardwareBuffer;
  store->ahb_ = buffer;
  return store;
}
#endif

std::unique_ptr<PixelStore> PixelStore::Adopt(uint8_t* data, uint32_t width, uint32_t height, size_t stride,
                                              void (*release)(void*)) {
  auto store = std::unique_ptr<PixelStore>(new (std::nothrow) PixelStore());
  if (!store) {
    if (release) release(data);
    return nullptr;
  }
  store->width_ = width;
  store->height_ = height;
  store->stride_ = stride;
  store->heap_ = data;
  store->release_ = release;
  return store;
}

PixelStore::~PixelStore() {
  if (release_) release_(heap_);
  else std::free(heap_);
#if defined(__ANDROID__)
  if (ahb_) AHardwareBuffer_release(ahb_);
#endif
}

ScopedPixels PixelStore::Read() const {
  ScopedPixels out;
  out.view_.width = width_;
  out.view_.height = height_;
  out.view_.stride = stride_;
  out.view_.alpha = alpha_;
  out.view_.opaque = opaque_;
  if (backing_ == Backing::kHeap) {
    out.view_.data = heap_;
    out.ok_ = true;
    return out;
  }
#if defined(__ANDROID__)
  void* ptr = nullptr;
  if (AHardwareBuffer_lock(ahb_, AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN, -1, nullptr, &ptr) != 0) {
    out.view_ = {};
    return out;
  }
  out.view_.data = static_cast<const uint8_t*>(ptr);
  out.ok_ = true;
  out.locked_ = this;
#endif
  return out;
}

MutablePixelView PixelStore::LockWrite() {
  MutablePixelView v{nullptr, width_, height_, stride_};
  if (backing_ == Backing::kHeap) {
    v.data = heap_;
    return v;
  }
#if defined(__ANDROID__)
  void* ptr = nullptr;
  if (AHardwareBuffer_lock(ahb_, AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN, -1, nullptr, &ptr) == 0) {
    v.data = static_cast<uint8_t*>(ptr);
    locked_ptr_ = ptr;
  }
#endif
  return v;
}

void PixelStore::UnlockWrite() {
#if defined(__ANDROID__)
  if (backing_ == Backing::kHardwareBuffer && locked_ptr_) {
    AHardwareBuffer_unlock(ahb_, nullptr);
    locked_ptr_ = nullptr;
  }
#endif
}

void PixelStore::Unlock() const {
#if defined(__ANDROID__)
  if (backing_ == Backing::kHardwareBuffer) AHardwareBuffer_unlock(ahb_, nullptr);
#endif
}

std::unique_ptr<PixelStore> HeapAllocator(uint32_t width, uint32_t height) {
  return PixelStore::AllocateHeap(width, height);
}

bool IsOpaque(const PixelView& view) {
  for (uint32_t y = 0; y < view.height; ++y) {
    const uint8_t* row = view.data + y * view.stride;
    for (uint32_t x = 0; x < view.width; ++x) {
      if (row[x * 4 + 3] != 255) return false;
    }
  }
  return true;
}

}  // namespace iwn::image
