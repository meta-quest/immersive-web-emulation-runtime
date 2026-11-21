// Decode pool and transfer registry.
#include <atomic>
#include <chrono>
#include <thread>

#include "iwn/image/decode.h"
#include "iwn/image/pool.h"
#include "test_harness.h"
#include "test_images.h"

using namespace iwn::image;
using namespace iwn::image::test;

TEST(pool_runs_every_job_off_the_calling_thread) {
  std::atomic<int> done{0};
  std::atomic<int> on_caller{0};
  const auto caller = std::this_thread::get_id();
  {
    TaskPool pool(3);
    for (int i = 0; i < 200; ++i) {
      pool.Post([&] {
        if (std::this_thread::get_id() == caller) ++on_caller;
        ++done;
      });
    }
  }  // destructor drains
  CHECK_EQ(done.load(), 200);
  CHECK_EQ(on_caller.load(), 0);
}

TEST(pool_decodes_concurrently) {
  const Bytes png = EncodePng(Pattern(64, 64, true), 6, 8, false);
  const Bytes webp = EncodeWebp(Pattern(64, 64, true), true, 100);
  std::atomic<int> ok{0};
  {
    TaskPool pool(4);
    for (int i = 0; i < 64; ++i) {
      pool.Post([&, i] {
        const Bytes& b = i % 2 ? png : webp;
        DecodeResult r = Decode(b.data(), b.size(), DecodeOptions());
        if (r.status == Status::kOk && r.store->width() == 64) ++ok;
      });
    }
  }
  CHECK_EQ(ok.load(), 64);
}

TEST(transfer_registry_take_once) {
  auto& reg = TransferRegistry::Shared();
  std::shared_ptr<const PixelStore> s(PixelStore::AllocateHeap(2, 2).release());
  const uint64_t id = reg.Put(s);
  CHECK(id != 0);
  CHECK(reg.Take(id) == s);
  CHECK(reg.Take(id) == nullptr);
  const uint64_t id2 = reg.Put(s);
  reg.Discard(id2);
  CHECK(reg.Take(id2) == nullptr);
  CHECK_EQ(reg.size(), size_t{0});
}

TEST(heap_store_size_arithmetic_cannot_wrap) {
  // 2^31 x 2^31: width * height * 4 and the padded row * height both wrap to small values in 64-bit arithmetic;
  // before the overflow checks this returned a non-null store describing 2^62 pixels with no memory behind it.
  CHECK(PixelStore::AllocateHeap(0x80000000u, 0x80000000u) == nullptr);
  CHECK(PixelStore::AllocateHeap(0xFFFFFFFFu, 0xFFFFFFFFu) == nullptr);
  CHECK(PixelStore::AllocateHeap(0xFFFFFFFFu, 1) == nullptr);           // above kMaxPixels
  CHECK(PixelStore::AllocateHeap(1u << 16, (1u << 12) + 1) == nullptr);  // 2^28 + 2^16 pixels
  auto ok = PixelStore::AllocateHeap(3, 5);
  CHECK(ok && ok->width() == 3 && ok->height() == 5 && ok->stride() >= 12);
}
