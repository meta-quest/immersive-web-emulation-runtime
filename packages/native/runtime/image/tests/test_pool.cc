/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Decode pool and transfer registry.
#include <atomic>
#include <chrono>
#include <cstring>
#include <memory>
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

TEST(keepable_pixels_copies_a_recycled_store_only) {
  using iwn::image::PixelStore;
  std::shared_ptr<PixelStore> camera(PixelStore::AllocateHeap(4, 2).release());
  {
    iwn::image::MutablePixelView w = camera->LockWrite();
    for (uint32_t y = 0; y < 2; ++y) std::memset(w.data + y * w.stride, 0x40 + static_cast<int>(y), 16);
    camera->UnlockWrite();
  }
  camera->set_opaque(true);
  // an ordinary store is immutable: kept as it is
  std::shared_ptr<const PixelStore> same = iwn::image::KeepablePixels(camera);
  CHECK(same.get() == camera.get());
  // a recycled one (a camera frame the producer rewrites once released) is copied, and the copy keeps its pixels
  camera->set_recycled(true);
  std::shared_ptr<const PixelStore> kept = iwn::image::KeepablePixels(camera);
  CHECK(kept && kept.get() != camera.get());
  CHECK(!kept->recycled());
  CHECK(kept->opaque());
  {
    iwn::image::MutablePixelView w = camera->LockWrite();
    std::memset(w.data, 0, 16);  // the producer writes the next frame into the original
    camera->UnlockWrite();
  }
  iwn::image::ScopedPixels p = kept->Read();
  CHECK(p.ok() && p.view().data[0] == 0x40 && p.view().data[p.view().stride] == 0x41);
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
