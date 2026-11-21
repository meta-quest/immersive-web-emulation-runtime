// Pixel storage shared by the image decoder, ImageBitmap/HTMLImageElement handles and the consumers that upload or
// draw them (the WebGL binding, Canvas 2D). Plain C++ (no V8), so it builds and is tested on the x86_64 host.
//
// Every store holds RGBA8 (R, G, B, A bytes in memory order, i.e. GL_RGBA + GL_UNSIGNED_BYTE), top row first,
// already oriented (EXIF, flipY) and with the alpha mode recorded in `alpha()`. A store is immutable once a
// decode/transform job has finished and published it; consumers share it through std::shared_ptr<const PixelStore>.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>

#if defined(__ANDROID__)
struct AHardwareBuffer;
#endif

namespace iwn::image {

enum class AlphaMode : uint8_t {
  kUnpremultiplied = 0,  // straight alpha (what decoders return, what ImageData holds)
  kPremultiplied = 1,    // colour channels already multiplied by alpha (canvas backing stores)
};

// A read view of a store's pixels. `data` stays valid while the ScopedPixels that produced it lives.
struct PixelView {
  const uint8_t* data = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  size_t stride = 0;  // bytes between rows, >= width * 4
  AlphaMode alpha = AlphaMode::kUnpremultiplied;
  bool opaque = false;  // every alpha byte is 255 (alpha mode is then irrelevant)
};

struct MutablePixelView {
  uint8_t* data = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  size_t stride = 0;
};

class PixelStore;

// RAII access to a store's memory. For heap stores this is free; for AHardwareBuffer stores it locks the buffer for
// CPU access for the lifetime of the object.
class ScopedPixels {
 public:
  ScopedPixels() = default;
  ScopedPixels(ScopedPixels&& other) noexcept;
  ScopedPixels& operator=(ScopedPixels&& other) noexcept;
  ScopedPixels(const ScopedPixels&) = delete;
  ScopedPixels& operator=(const ScopedPixels&) = delete;
  ~ScopedPixels();

  bool ok() const { return ok_; }
  const PixelView& view() const { return view_; }

 private:
  friend class PixelStore;
  PixelView view_;
  bool ok_ = false;
  const PixelStore* locked_ = nullptr;  // non-null when Unlock() must be called
};

class PixelStore {
 public:
  enum class Backing : uint8_t { kHeap, kHardwareBuffer };

  // Hard cap on the pixel count of any store this module allocates (2^28 px = 1 GiB of RGBA8). Every decoder limit
  // (DecodeLimits::max_pixels, 256e6) and the transform's output cap sit at or below it, so it never rejects a
  // legitimate image; it exists so no caller can drive the size arithmetic into wraparound.
  static constexpr uint64_t kMaxPixels = uint64_t{1} << 28;

  // Allocates width x height RGBA8 on the heap, rows 16-byte aligned. Returns nullptr when out of memory or when
  // width * height exceeds kMaxPixels (all size arithmetic is overflow-checked). Contents are uninitialised unless
  // `zero` is true.
  static std::unique_ptr<PixelStore> AllocateHeap(uint32_t width, uint32_t height, bool zero = false);

  // Takes ownership of `data` (rows of `stride` bytes), released with `release(data)`. Lets a decoder hand over the
  // buffer it allocated without a copy.
  static std::unique_ptr<PixelStore> Adopt(uint8_t* data, uint32_t width, uint32_t height, size_t stride,
                                           void (*release)(void*));

#if defined(__ANDROID__)
  // Allocates an AHardwareBuffer (R8G8B8A8_UNORM, CPU read/write often, GPU sampled). nullptr on failure or when
  // width * height exceeds kMaxPixels.
  static std::unique_ptr<PixelStore> AllocateHardwareBuffer(uint32_t width, uint32_t height);
  AHardwareBuffer* hardware_buffer() const { return ahb_; }
#endif

  ~PixelStore();
  PixelStore(const PixelStore&) = delete;
  PixelStore& operator=(const PixelStore&) = delete;

  uint32_t width() const { return width_; }
  uint32_t height() const { return height_; }
  size_t stride() const { return stride_; }
  size_t byte_size() const { return stride_ * height_; }
  Backing backing() const { return backing_; }
  AlphaMode alpha() const { return alpha_; }
  bool opaque() const { return opaque_; }

  // Metadata is set by the producer before the store is published.
  void set_alpha(AlphaMode mode) { alpha_ = mode; }
  void set_opaque(bool opaque) { opaque_ = opaque; }

  // CPU access. Read() may be called from any thread once the store is published.
  ScopedPixels Read() const;
  // Write access for producers (before publication). Same locking rules as Read().
  MutablePixelView LockWrite();
  void UnlockWrite();

 private:
  friend class ScopedPixels;
  PixelStore() = default;
  void Unlock() const;

  uint32_t width_ = 0;
  uint32_t height_ = 0;
  size_t stride_ = 0;
  Backing backing_ = Backing::kHeap;
  AlphaMode alpha_ = AlphaMode::kUnpremultiplied;
  bool opaque_ = false;
  uint8_t* heap_ = nullptr;
  void (*release_)(void*) = nullptr;  // frees heap_ (std::free when null)
#if defined(__ANDROID__)
  AHardwareBuffer* ahb_ = nullptr;
  mutable void* locked_ptr_ = nullptr;
#endif
};

// Allocator used by decoders and transforms for their final output, so the runtime can choose heap or
// AHardwareBuffer-backed stores without the decode code knowing.
using StoreAllocator = std::unique_ptr<PixelStore> (*)(uint32_t width, uint32_t height);
std::unique_ptr<PixelStore> HeapAllocator(uint32_t width, uint32_t height);

// Scans the alpha channel. True when every alpha byte is 255.
bool IsOpaque(const PixelView& view);

}  // namespace iwn::image
