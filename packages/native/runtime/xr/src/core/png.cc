/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/png.h"

#include <zlib.h>

#include <cstring>

namespace iwn::xr {

namespace {

void put32(std::vector<uint8_t>& out, uint32_t v) {
  out.push_back(static_cast<uint8_t>(v >> 24));
  out.push_back(static_cast<uint8_t>(v >> 16));
  out.push_back(static_cast<uint8_t>(v >> 8));
  out.push_back(static_cast<uint8_t>(v));
}

// Appends a chunk whose data is already in `out` starting at `data_at` (length field written in front later).
void finish_chunk(std::vector<uint8_t>& out, size_t length_at) {
  const size_t type_at = length_at + 4;
  const uint32_t length = static_cast<uint32_t>(out.size() - type_at - 4);
  out[length_at] = static_cast<uint8_t>(length >> 24);
  out[length_at + 1] = static_cast<uint8_t>(length >> 16);
  out[length_at + 2] = static_cast<uint8_t>(length >> 8);
  out[length_at + 3] = static_cast<uint8_t>(length);
  uLong crc = crc32(0L, Z_NULL, 0);
  crc = crc32(crc, out.data() + type_at, static_cast<uInt>(out.size() - type_at));
  put32(out, static_cast<uint32_t>(crc));
}

size_t begin_chunk(std::vector<uint8_t>& out, const char type[4]) {
  const size_t at = out.size();
  put32(out, 0);
  out.insert(out.end(), type, type + 4);
  return at;
}

}  // namespace

std::vector<uint8_t> encode_png_rgba(const uint8_t* rgba, uint32_t width, uint32_t height, uint32_t stride,
                                     int level) {
  std::vector<uint8_t> out;
  if (!rgba || width == 0 || height == 0 || stride < width * 4) return out;
  static const uint8_t kSignature[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  out.insert(out.end(), kSignature, kSignature + 8);

  size_t c = begin_chunk(out, "IHDR");
  put32(out, width);
  put32(out, height);
  out.push_back(8);  // bit depth
  out.push_back(6);  // colour type: RGBA
  out.push_back(0);  // deflate
  out.push_back(0);  // adaptive filtering
  out.push_back(0);  // no interlace
  finish_chunk(out, c);

  z_stream z;
  std::memset(&z, 0, sizeof(z));
  if (deflateInit(&z, level) != Z_OK) return {};
  const size_t row_bytes = static_cast<size_t>(width) * 4 + 1;
  std::vector<uint8_t> row(row_bytes);
  std::vector<uint8_t> buf(1 << 16);
  c = begin_chunk(out, "IDAT");
  bool ok = true;
  for (uint32_t y = 0; y < height && ok; ++y) {
    const uint8_t* src = rgba + static_cast<size_t>(y) * stride;
    row[0] = 1;  // Sub: each byte minus the same channel of the pixel to its left
    for (size_t i = 0; i < 4; ++i) row[1 + i] = src[i];
    for (size_t i = 4; i < static_cast<size_t>(width) * 4; ++i) row[1 + i] = static_cast<uint8_t>(src[i] - src[i - 4]);
    z.next_in = row.data();
    z.avail_in = static_cast<uInt>(row_bytes);
    while (z.avail_in > 0) {
      z.next_out = buf.data();
      z.avail_out = static_cast<uInt>(buf.size());
      if (deflate(&z, Z_NO_FLUSH) == Z_STREAM_ERROR) {
        ok = false;
        break;
      }
      out.insert(out.end(), buf.data(), buf.data() + (buf.size() - z.avail_out));
    }
  }
  if (ok) {
    int r;
    do {  // Z_OK: more output pending; Z_STREAM_END: the stream (and its Adler-32 trailer) is complete
      z.next_out = buf.data();
      z.avail_out = static_cast<uInt>(buf.size());
      r = deflate(&z, Z_FINISH);
      out.insert(out.end(), buf.data(), buf.data() + (buf.size() - z.avail_out));
    } while (r == Z_OK);
    ok = r == Z_STREAM_END;
  }
  deflateEnd(&z);
  if (!ok) return {};
  finish_chunk(out, c);
  c = begin_chunk(out, "IEND");
  finish_chunk(out, c);
  return out;
}

}  // namespace iwn::xr
