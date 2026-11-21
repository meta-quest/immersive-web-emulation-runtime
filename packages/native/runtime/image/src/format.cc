/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Format sniffing (signatures from the PNG, JPEG/JFIF, GIF89a, RIFF/WebP, BMP, ICO and ISO-BMFF/HEIF specs, and the
// WHATWG MIME Sniffing standard's image table) and EXIF orientation lookup (TIFF 6.0 IFD layout, Exif 2.32 APP1,
// PNG 1.5 eXIf chunk, WebP container EXIF chunk).
#include <algorithm>
#include <climits>
#include <cstring>

#include "iwn/image/decode.h"

namespace iwn::image {

const char* FormatMime(Format format) {
  switch (format) {
    case Format::kPng: return "image/png";
    case Format::kJpeg: return "image/jpeg";
    case Format::kGif: return "image/gif";
    case Format::kWebp: return "image/webp";
    case Format::kBmp: return "image/bmp";
    case Format::kIco: return "image/x-icon";
    case Format::kHeif: return "image/heif";
    case Format::kAvif: return "image/avif";
    case Format::kUnknown: break;
  }
  return "application/octet-stream";
}

Format SniffFormat(const uint8_t* d, size_t n) {
  if (n >= 8 && std::memcmp(d, "\x89PNG\r\n\x1a\n", 8) == 0) return Format::kPng;
  if (n >= 3 && d[0] == 0xFF && d[1] == 0xD8 && d[2] == 0xFF) return Format::kJpeg;
  if (n >= 6 && (std::memcmp(d, "GIF87a", 6) == 0 || std::memcmp(d, "GIF89a", 6) == 0)) return Format::kGif;
  if (n >= 12 && std::memcmp(d, "RIFF", 4) == 0 && std::memcmp(d + 8, "WEBP", 4) == 0) return Format::kWebp;
  if (n >= 2 && d[0] == 'B' && d[1] == 'M') return Format::kBmp;
  if (n >= 4 && d[0] == 0 && d[1] == 0 && (d[2] == 1 || d[2] == 2) && d[3] == 0) return Format::kIco;
  if (n >= 12 && std::memcmp(d + 4, "ftyp", 4) == 0) {
    const uint8_t* brand = d + 8;
    if (std::memcmp(brand, "avif", 4) == 0 || std::memcmp(brand, "avis", 4) == 0) return Format::kAvif;
    if (std::memcmp(brand, "heic", 4) == 0 || std::memcmp(brand, "heix", 4) == 0 ||
        std::memcmp(brand, "hevc", 4) == 0 || std::memcmp(brand, "hevx", 4) == 0 ||
        std::memcmp(brand, "mif1", 4) == 0 || std::memcmp(brand, "msf1", 4) == 0) {
      // mif1 files may still be AVIF: look for an 'avif' compatible brand in the ftyp box.
      uint32_t box = (uint32_t{d[0]} << 24) | (uint32_t{d[1]} << 16) | (uint32_t{d[2]} << 8) | d[3];
      if (box > n) box = static_cast<uint32_t>(n);
      for (uint32_t off = 16; off + 4 <= box; off += 4) {
        if (std::memcmp(d + off, "avif", 4) == 0) return Format::kAvif;
      }
      return Format::kHeif;
    }
  }
  return Format::kUnknown;
}

namespace {

uint16_t Rd16(const uint8_t* p, bool le) { return le ? (p[0] | (p[1] << 8)) : ((p[0] << 8) | p[1]); }
uint32_t Rd32(const uint8_t* p, bool le) {
  return le ? (uint32_t{p[0]} | (uint32_t{p[1]} << 8) | (uint32_t{p[2]} << 16) | (uint32_t{p[3]} << 24))
            : ((uint32_t{p[0]} << 24) | (uint32_t{p[1]} << 16) | (uint32_t{p[2]} << 8) | uint32_t{p[3]});
}

int JpegOrientation(const uint8_t* d, size_t n) {
  size_t pos = 2;  // after SOI
  while (pos + 4 <= n) {
    if (d[pos] != 0xFF) return 1;
    uint8_t marker = d[pos + 1];
    if (marker == 0xFF) {  // fill byte
      ++pos;
      continue;
    }
    if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) {
      pos += 2;
      continue;
    }
    if (marker == 0xDA || marker == 0xD9) return 1;  // start of scan / end: no EXIF before the image data
    const size_t len = (size_t{d[pos + 2]} << 8) | d[pos + 3];
    if (len < 2 || pos + 2 + len > n) return 1;
    if (marker == 0xE1 && len >= 8 && std::memcmp(d + pos + 4, "Exif\0\0", 6) == 0) {
      return ReadTiffOrientation(d + pos + 10, len - 8);
    }
    pos += 2 + len;
  }
  return 1;
}

int PngOrientation(const uint8_t* d, size_t n) {
  size_t pos = 8;
  while (pos + 12 <= n) {
    const uint32_t len = Rd32(d + pos, false);
    const uint8_t* type = d + pos + 4;
    if (len > n - pos - 12) return 1;
    if (std::memcmp(type, "eXIf", 4) == 0) return ReadTiffOrientation(d + pos + 8, len);
    if (std::memcmp(type, "IDAT", 4) == 0 || std::memcmp(type, "IEND", 4) == 0) return 1;
    pos += 12 + len;
  }
  return 1;
}

int WebpOrientation(const uint8_t* d, size_t n) {
  size_t pos = 12;
  while (pos + 8 <= n) {
    const uint32_t len = Rd32(d + pos + 4, true);
    if (len > n - pos - 8) return 1;
    if (std::memcmp(d + pos, "EXIF", 4) == 0) {
      const uint8_t* p = d + pos + 8;
      size_t m = len;
      if (m >= 6 && std::memcmp(p, "Exif\0\0", 6) == 0) {
        p += 6;
        m -= 6;
      }
      return ReadTiffOrientation(p, m);
    }
    pos += 8 + len + (len & 1);
  }
  return 1;
}

}  // namespace

namespace {

// TiffIfdOrientation and ReadTiffOrientation are adapted from Skia's src/codec/SkParseEncodedOrigin.cpp
// (skia.googlesource.com/skia @ 3f8fc145), so the EXIF orientations accepted here are exactly the ones the OS
// decoder (Skia, behind AImageDecoder) accepts. That code is under the following license:
//
//   Copyright 2018 Google Inc.
//   Copyright (c) 2011 Google Inc. All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without modification, are permitted provided that
//   the following conditions are met:
//     * Redistributions of source code must retain the above copyright notice, this list of conditions and the
//       following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
//       following disclaimer in the documentation and/or other materials provided with the distribution.
//     * Neither the name of the copyright holder nor the names of its contributors may be used to endorse or
//       promote products derived from this software without specific prior written permission.
//
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
//   WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
//   PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY
//   DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
//   PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
//   CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
//   OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
//   DAMAGE.

// One IFD: the orientation entry (SHORT, count 1, 1..8), else the Exif sub-IFD (tag 0x8769, LONG, count 1) when
// `is_root`. Entries past the end of the buffer are not read (the count is clamped, as Skia does).
bool TiffIfdOrientation(const uint8_t* t, size_t n, uint64_t offset, bool le, bool is_root, int* out) {
  if (offset + 2 > n) return false;
  uint64_t count = Rd16(t + offset, le);
  count = std::min<uint64_t>(count, (n - offset - 2) / 12);
  for (uint64_t i = 0; i < count; ++i) {
    const uint8_t* e = t + offset + 2 + i * 12;
    const uint16_t tag = Rd16(e, le);
    const uint16_t type = Rd16(e + 2, le);
    const uint32_t n_values = Rd32(e + 4, le);
    if (tag == 0x0112 && type == 3 && n_values == 1) {
      const uint16_t v = Rd16(e + 8, le);
      if (v >= 1 && v <= 8) {
        *out = v;
        return true;
      }
    } else if (tag == 0x8769 && type == 4 && n_values == 1 && is_root) {
      const uint32_t sub = Rd32(e + 8, le);
      if (sub > 0 && sub < n && TiffIfdOrientation(t, n, sub, le, false, out)) return true;
    }
  }
  return false;
}

}  // namespace

int ReadTiffOrientation(const uint8_t* t, size_t n) {
  if (n < 8) return 1;
  bool le;
  if (t[0] == 'I' && t[1] == 'I' && t[2] == 42 && t[3] == 0) le = true;
  else if (t[0] == 'M' && t[1] == 'M' && t[2] == 0 && t[3] == 42) le = false;
  else return 1;
  int o = 1;
  return TiffIfdOrientation(t, n, Rd32(t + 4, le), le, true, &o) ? o : 1;
}

namespace {

void JpegHeader(const uint8_t* d, size_t n, HeaderInfo* h) {
  size_t pos = 2;
  while (pos + 4 <= n) {
    if (d[pos] != 0xFF) return;
    const uint8_t marker = d[pos + 1];
    if (marker == 0xFF) {
      ++pos;
      continue;
    }
    if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) {
      pos += 2;
      continue;
    }
    if (marker == 0xDA || marker == 0xD9) return;
    const size_t len = (size_t{d[pos + 2]} << 8) | d[pos + 3];
    if (len < 2 || pos + 2 + len > n) return;
    const bool sof = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
    if (sof && len >= 7) {
      h->height = Rd16(d + pos + 5, false);
      h->width = Rd16(d + pos + 7, false);
      h->known = h->width > 0 && h->height > 0;
      // Huffman-coded baseline/extended/progressive (SOF0-2): every 8x8 block of every component carries at least
      // one DC code of >= 1 bit (a baseline block also needs its EOB; a progressive file must start each component
      // with a DC scan, ITU T.81 G.1.1.1.1), so a complete file holds at least one bit per block. Arithmetic coding
      // (SOF9+) can go below that and gets no bound; the rest are not decodable here anyway.
      const size_t nf = len >= 8 ? d[pos + 9] : 0;
      if (h->known && marker <= 0xC2 && nf > 0 && len >= 8 + 3 * nf) {
        uint32_t hmax = 1, vmax = 1;
        for (size_t i = 0; i < nf; ++i) {
          const uint8_t hv = d[pos + 11 + 3 * i];
          hmax = std::max<uint32_t>(hmax, hv >> 4);
          vmax = std::max<uint32_t>(vmax, hv & 15);
        }
        uint64_t blocks = 0;
        for (size_t i = 0; i < nf; ++i) {
          const uint8_t hv = d[pos + 11 + 3 * i];
          const uint64_t hi = hv >> 4, vi = hv & 15;
          if (hi == 0 || vi == 0) return;  // invalid sampling factor: leave it to the decoder, no bound
          const uint64_t cw = (uint64_t{h->width} * hi + hmax - 1) / hmax, ch = (uint64_t{h->height} * vi + vmax - 1) / vmax;
          blocks += ((cw + 7) / 8) * ((ch + 7) / 8);
        }
        h->min_file_size = pos + blocks / 8;
      }
      return;
    }
    pos += 2 + len;
  }
}

void PngHeader(const uint8_t* d, size_t n, HeaderInfo* h) {
  if (n < 33 || std::memcmp(d + 12, "IHDR", 4) != 0) return;
  h->width = Rd32(d + 16, false);
  h->height = Rd32(d + 20, false);
  h->known = h->width > 0 && h->height > 0;
  if (!h->known) return;
  const uint32_t depth = d[24];
  uint32_t channels = 0;
  switch (d[25]) {
    case 0: channels = 1; break;
    case 2: channels = 3; break;
    case 3: channels = 1; break;
    case 4: channels = 2; break;
    case 6: channels = 4; break;
    default: return;
  }
  if (depth == 0 || depth > 16) return;
  // Filtered image data (one filter byte per row) for the non-interlaced layout; Adam7 only adds bytes. Deflate
  // cannot do better than 258 bytes per 2 bits (1032:1); a margin covers the zlib/chunk framing of tiny files.
  const uint64_t row = 1 + (uint64_t{h->width} * channels * depth + 7) / 8;
  const uint64_t raw = row * h->height;
  h->min_file_size = raw / 1032;
}

void WebpHeader(const uint8_t* d, size_t n, HeaderInfo* h) {
  if (n < 30) return;
  const uint8_t* c = d + 12;
  if (std::memcmp(c, "VP8 ", 4) == 0) {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height (2 bits of scale each).
    const uint8_t* f = c + 8;
    if (f[3] != 0x9d || f[4] != 0x01 || f[5] != 0x2a) return;
    h->width = Rd16(f + 6, true) & 0x3fff;
    h->height = Rd16(f + 8, true) & 0x3fff;
  } else if (std::memcmp(c, "VP8L", 4) == 0) {
    const uint8_t* f = c + 8;
    if (f[0] != 0x2f) return;
    const uint32_t bits = Rd32(f + 1, true);
    h->width = (bits & 0x3fff) + 1;
    h->height = ((bits >> 14) & 0x3fff) + 1;
  } else if (std::memcmp(c, "VP8X", 4) == 0) {
    const uint8_t* f = c + 8;
    h->width = (uint32_t{f[4]} | (uint32_t{f[5]} << 8) | (uint32_t{f[6]} << 16)) + 1;
    h->height = (uint32_t{f[7]} | (uint32_t{f[8]} << 8) | (uint32_t{f[9]} << 16)) + 1;
  } else {
    return;
  }
  h->known = h->width > 0 && h->height > 0;
}

void GifHeader(const uint8_t* d, size_t n, HeaderInfo* h) {
  if (n < 13) return;
  h->width = Rd16(d + 6, true);
  h->height = Rd16(d + 8, true);
  h->known = h->width > 0 && h->height > 0;
  if (!h->known) return;
  // Walk to the first image descriptor (skipping the global colour table and extension blocks). Its frame must be
  // fully coded for the decode to succeed (an incomplete frame fails), and LZW emits at most 4096 pixels per code
  // with codes of at least 2 bits, so the frame needs >= pixels / 16384 bytes. The logical screen can legitimately
  // be larger than the frame (the rest is transparent), so only the frame is bounded.
  size_t pos = 13;
  if (d[10] & 0x80) pos += 3 * (size_t{1} << ((d[10] & 7) + 1));
  while (pos < n) {
    if (d[pos] == 0x21) {  // extension: label, then data sub-blocks up to a zero-length one
      pos += 2;
      while (pos < n && d[pos] != 0) pos += 1 + size_t{d[pos]};
      ++pos;
      continue;
    }
    if (d[pos] == 0x2C && pos + 10 <= n) {
      const uint64_t fw = Rd16(d + pos + 5, true), fh = Rd16(d + pos + 7, true);
      h->min_file_size = pos + 10 + fw * fh / 16384;
    }
    return;
  }
}

}  // namespace

HeaderInfo ReadHeaderInfo(const uint8_t* d, size_t n, Format format) {
  HeaderInfo h;
  if (!d) return h;
  switch (format) {
    case Format::kPng: PngHeader(d, n, &h); break;
    case Format::kJpeg: JpegHeader(d, n, &h); break;
    case Format::kWebp: WebpHeader(d, n, &h); break;
    case Format::kGif: GifHeader(d, n, &h); break;
    case Format::kBmp:
      if (n >= 26) {
        const uint32_t header = Rd32(d + 14, true);
        if (header == 12) {
          h.width = Rd16(d + 18, true);
          h.height = Rd16(d + 20, true);
        } else if (header >= 40) {
          const int32_t w = static_cast<int32_t>(Rd32(d + 18, true));
          const int32_t ht = static_cast<int32_t>(Rd32(d + 22, true));
          h.width = w > 0 ? static_cast<uint32_t>(w) : 0;
          h.height = ht == INT32_MIN ? 0 : static_cast<uint32_t>(ht < 0 ? -ht : ht);
        }
        h.known = h.width > 0 && h.height > 0;
      }
      break;
    default: break;
  }
  if (!h.known) h = HeaderInfo();
  return h;
}

bool JpegHasEndAfterScan(const uint8_t* d, size_t n) {
  // Walk the marker segments to the first SOS; entropy-coded data never contains FF D9 (0xFF is stuffed as FF 00),
  // so any FF D9 after it is the EOI (segments between progressive scans have lengths and are skipped too).
  size_t pos = 2;
  while (pos + 4 <= n) {
    if (d[pos] != 0xFF) return false;
    const uint8_t marker = d[pos + 1];
    if (marker == 0xFF) {
      ++pos;
      continue;
    }
    if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) {
      pos += 2;
      continue;
    }
    if (marker == 0xD9) return false;  // EOI before any scan
    const size_t len = (size_t{d[pos + 2]} << 8) | d[pos + 3];
    if (len < 2 || pos + 2 + len > n) return false;
    pos += 2 + len;
    if (marker == 0xDA) break;
  }
  for (size_t i = pos; i + 1 < n; ++i) {
    if (d[i] == 0xFF && d[i + 1] == 0xD9) return true;
  }
  return false;
}

int ReadExifOrientation(const uint8_t* data, size_t size, Format format) {
  switch (format) {
    case Format::kJpeg: return JpegOrientation(data, size);
    case Format::kPng: return PngOrientation(data, size);
    case Format::kWebp: return WebpOrientation(data, size);
    default: return 1;  // HEIF/AVIF carry irot/imir boxes, which the OS decoder applies itself
  }
}

}  // namespace iwn::image
