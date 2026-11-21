/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pixel format tables: bytes per pixel of (format, type) pairs (OpenGL ES 3.0 §3.7 tables 3.2-3.5), the
// ArrayBufferView kind each type requires (WebGL 2.0 §3.7.6 / §5.14.8), the client format/type of each sized
// internal format (for zero-filling formats that cannot be cleared through a framebuffer), and the block
// layout of compressed formats (the WEBGL_compressed_texture_* extension specifications).

// prettier-ignore
const FORMAT_COMPONENTS: Record<number, number> = {
  0x1908: 4, // RGBA
  0x1907: 3, // RGB
  0x8227: 2, // RG
  0x1903: 1, // RED
  0x1906: 1, // ALPHA
  0x1909: 1, // LUMINANCE
  0x190a: 2, // LUMINANCE_ALPHA
  0x8d99: 4, // RGBA_INTEGER
  0x8d98: 3, // RGB_INTEGER
  0x8228: 2, // RG_INTEGER
  0x8d94: 1, // RED_INTEGER
  0x1902: 1, // DEPTH_COMPONENT
  0x84f9: 1, // DEPTH_STENCIL (packed types only)
  0x8c40: 3, // SRGB_EXT
  0x8c42: 4, // SRGB_ALPHA_EXT
};

// prettier-ignore
const TYPE_BYTES: Record<number, number> = {
  0x1401: 1, // UNSIGNED_BYTE
  0x1400: 1, // BYTE
  0x1403: 2, // UNSIGNED_SHORT
  0x1402: 2, // SHORT
  0x140b: 2, // HALF_FLOAT
  0x8d61: 2, // HALF_FLOAT_OES
  0x1405: 4, // UNSIGNED_INT
  0x1404: 4, // INT
  0x1406: 4, // FLOAT
};

// Packed types: bytes per pixel regardless of the component count.
// prettier-ignore
const PACKED_TYPE_BYTES: Record<number, number> = {
  0x8363: 2, // UNSIGNED_SHORT_5_6_5
  0x8033: 2, // UNSIGNED_SHORT_4_4_4_4
  0x8034: 2, // UNSIGNED_SHORT_5_5_5_1
  0x8368: 4, // UNSIGNED_INT_2_10_10_10_REV
  0x8c3b: 4, // UNSIGNED_INT_10F_11F_11F_REV
  0x8c3e: 4, // UNSIGNED_INT_5_9_9_9_REV
  0x84fa: 4, // UNSIGNED_INT_24_8
  0x8dad: 8, // FLOAT_32_UNSIGNED_INT_24_8_REV
};

/** Bytes per pixel of a (format, type) pair, 0 if the pair is unknown. */
export function bytesPerPixel(format: number, type: number): number {
  const packed = PACKED_TYPE_BYTES[type];
  if (packed !== undefined) return FORMAT_COMPONENTS[format] !== undefined ? packed : 0;
  const c = FORMAT_COMPONENTS[format];
  const b = TYPE_BYTES[type];
  if (c === undefined || b === undefined) return 0;
  return c * b;
}

export function componentsOf(format: number): number {
  return FORMAT_COMPONENTS[format] ?? 0;
}

/** Typed-array kinds, by constructor name. */
export const VIEW_U8 = 1;
export const VIEW_I8 = 2;
export const VIEW_U16 = 3;
export const VIEW_I16 = 4;
export const VIEW_U32 = 5;
export const VIEW_I32 = 6;
export const VIEW_F32 = 7;
export const VIEW_U8C = 8;
export const VIEW_F64 = 9;
export const VIEW_DATAVIEW = 10;
export const VIEW_BIG = 11;
export const VIEW_F16 = 12;

export function viewKind(v: ArrayBufferView): number {
  if (v instanceof Uint8Array) return VIEW_U8;
  if (v instanceof Float32Array) return VIEW_F32;
  if (v instanceof Uint16Array) return VIEW_U16;
  if (v instanceof Int32Array) return VIEW_I32;
  if (v instanceof Uint32Array) return VIEW_U32;
  if (v instanceof Uint8ClampedArray) return VIEW_U8C;
  if (v instanceof Int8Array) return VIEW_I8;
  if (v instanceof Int16Array) return VIEW_I16;
  if (v instanceof Float64Array) return VIEW_F64;
  if (v instanceof DataView) return VIEW_DATAVIEW;
  const F16 = (globalThis as { Float16Array?: Function }).Float16Array;
  if (F16 && v instanceof F16) return VIEW_F16;
  return VIEW_BIG;
}

/** Whether a view of `kind` may carry pixels of `type` (WebGL 2.0 §3.7.6 table; 0 = only null allowed). */
export function viewMatchesType(kind: number, type: number): boolean {
  switch (type) {
    case 0x1401: // UNSIGNED_BYTE
      return kind === VIEW_U8 || kind === VIEW_U8C;
    case 0x1400: // BYTE
      return kind === VIEW_I8;
    case 0x1403: // UNSIGNED_SHORT
    case 0x8363:
    case 0x8033:
    case 0x8034:
    case 0x140b: // HALF_FLOAT
    case 0x8d61: // HALF_FLOAT_OES
      return kind === VIEW_U16;
    case 0x1402: // SHORT
      return kind === VIEW_I16;
    case 0x1405: // UNSIGNED_INT
    case 0x8368:
    case 0x8c3b:
    case 0x8c3e:
    case 0x84fa:
      return kind === VIEW_U32;
    case 0x1404: // INT
      return kind === VIEW_I32;
    case 0x1406: // FLOAT
      return kind === VIEW_F32;
    default:
      return false; // FLOAT_32_UNSIGNED_INT_24_8_REV: only null
  }
}

export function viewElementBytes(v: ArrayBufferView): number {
  return (v as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
}

export interface PixelStore {
  alignment: number;
  rowLength: number;
  imageHeight: number;
  skipPixels: number;
  skipRows: number;
  skipImages: number;
}

/**
 * Bytes a client-memory pixel transfer reads or writes (OpenGL ES 3.0 §3.7.1 "Unpacking", §4.3.2): the last
 * row and last image are not padded. Returns -1 on overflow / invalid sizes.
 */
export function imageByteSize(
  width: number,
  height: number,
  depth: number,
  format: number,
  type: number,
  ps: PixelStore,
  is3D: boolean,
): number {
  if (width < 0 || height < 0 || depth < 0) return -1;
  const bpp = bytesPerPixel(format, type);
  if (bpp === 0) return -1;
  if (width === 0 || height === 0 || depth === 0) return 0;
  const rowPixels = ps.rowLength > 0 ? ps.rowLength : width;
  const unalignedRow = rowPixels * bpp;
  const a = ps.alignment;
  const rowBytes = Math.ceil(unalignedRow / a) * a;
  const imageRows = is3D && ps.imageHeight > 0 ? ps.imageHeight : height;
  const imageBytes = rowBytes * imageRows;
  const skipImages = is3D ? ps.skipImages : 0;
  const lastRowBytes = (ps.skipPixels + width) * bpp;
  const total = (skipImages + depth - 1) * imageBytes + (ps.skipRows + height - 1) * rowBytes + lastRowBytes;
  return Number.isSafeInteger(total) ? total : -1;
}

/** Client format/type for each sized internal format (WebGL 2.0 / ES 3.0 table 3.2), for zero uploads. */
// prettier-ignore
export const SIZED_FORMAT_INFO: Record<number, readonly [format: number, type: number]> = {
  0x8229: [0x1903, 0x1401], // R8
  0x8f94: [0x1903, 0x1400], // R8_SNORM
  0x822d: [0x1903, 0x140b], // R16F
  0x822e: [0x1903, 0x1406], // R32F
  0x8232: [0x8d94, 0x1401], // R8UI
  0x8231: [0x8d94, 0x1400], // R8I
  0x8234: [0x8d94, 0x1403], // R16UI
  0x8233: [0x8d94, 0x1402], // R16I
  0x8236: [0x8d94, 0x1405], // R32UI
  0x8235: [0x8d94, 0x1404], // R32I
  0x822b: [0x8227, 0x1401], // RG8
  0x8f95: [0x8227, 0x1400], // RG8_SNORM
  0x822f: [0x8227, 0x140b], // RG16F
  0x8230: [0x8227, 0x1406], // RG32F
  0x8238: [0x8228, 0x1401], // RG8UI
  0x8237: [0x8228, 0x1400], // RG8I
  0x823a: [0x8228, 0x1403], // RG16UI
  0x8239: [0x8228, 0x1402], // RG16I
  0x823c: [0x8228, 0x1405], // RG32UI
  0x823b: [0x8228, 0x1404], // RG32I
  0x8051: [0x1907, 0x1401], // RGB8
  0x8c41: [0x1907, 0x1401], // SRGB8
  0x8d62: [0x1907, 0x8363], // RGB565
  0x8f96: [0x1907, 0x1400], // RGB8_SNORM
  0x8c3a: [0x1907, 0x8c3b], // R11F_G11F_B10F
  0x8c3d: [0x1907, 0x8c3e], // RGB9_E5
  0x881b: [0x1907, 0x140b], // RGB16F
  0x8815: [0x1907, 0x1406], // RGB32F
  0x8d7d: [0x8d98, 0x1401], // RGB8UI
  0x8d8f: [0x8d98, 0x1400], // RGB8I
  0x8d77: [0x8d98, 0x1403], // RGB16UI
  0x8d89: [0x8d98, 0x1402], // RGB16I
  0x8d71: [0x8d98, 0x1405], // RGB32UI
  0x8d83: [0x8d98, 0x1404], // RGB32I
  0x8058: [0x1908, 0x1401], // RGBA8
  0x8c43: [0x1908, 0x1401], // SRGB8_ALPHA8
  0x8f97: [0x1908, 0x1400], // RGBA8_SNORM
  0x8057: [0x1908, 0x8034], // RGB5_A1
  0x8056: [0x1908, 0x8033], // RGBA4
  0x8059: [0x1908, 0x8368], // RGB10_A2
  0x881a: [0x1908, 0x140b], // RGBA16F
  0x8814: [0x1908, 0x1406], // RGBA32F
  0x8d7c: [0x8d99, 0x1401], // RGBA8UI
  0x8d8e: [0x8d99, 0x1400], // RGBA8I
  0x906f: [0x8d99, 0x8368], // RGB10_A2UI
  0x8d76: [0x8d99, 0x1403], // RGBA16UI
  0x8d88: [0x8d99, 0x1402], // RGBA16I
  0x8d70: [0x8d99, 0x1405], // RGBA32UI
  0x8d82: [0x8d99, 0x1404], // RGBA32I
  0x81a5: [0x1902, 0x1403], // DEPTH_COMPONENT16
  0x81a6: [0x1902, 0x1405], // DEPTH_COMPONENT24
  0x8cac: [0x1902, 0x1406], // DEPTH_COMPONENT32F
  0x88f0: [0x84f9, 0x84fa], // DEPTH24_STENCIL8
  0x8cad: [0x84f9, 0x8dad], // DEPTH32F_STENCIL8
  // EXT_texture_norm16
  0x822a: [0x1903, 0x1403], // R16_EXT
  0x822c: [0x8227, 0x1403], // RG16_EXT
  0x8054: [0x1907, 0x1403], // RGB16_EXT
  0x805b: [0x1908, 0x1403], // RGBA16_EXT
};

/** Compressed formats: [block width, block height, bytes per block, extension name]. */
// prettier-ignore
export const COMPRESSED_FORMATS: Record<number, readonly [number, number, number, string]> = {
  // ETC2 / EAC (ES 3.0 core; WEBGL_compressed_texture_etc)
  0x9270: [4, 4, 8, 'WEBGL_compressed_texture_etc'], 0x9271: [4, 4, 8, 'WEBGL_compressed_texture_etc'],
  0x9272: [4, 4, 16, 'WEBGL_compressed_texture_etc'], 0x9273: [4, 4, 16, 'WEBGL_compressed_texture_etc'],
  0x9274: [4, 4, 8, 'WEBGL_compressed_texture_etc'], 0x9275: [4, 4, 8, 'WEBGL_compressed_texture_etc'],
  0x9276: [4, 4, 8, 'WEBGL_compressed_texture_etc'], 0x9277: [4, 4, 8, 'WEBGL_compressed_texture_etc'],
  0x9278: [4, 4, 16, 'WEBGL_compressed_texture_etc'], 0x9279: [4, 4, 16, 'WEBGL_compressed_texture_etc'],
  // ETC1
  0x8d64: [4, 4, 8, 'WEBGL_compressed_texture_etc1'],
  // S3TC
  0x83f0: [4, 4, 8, 'WEBGL_compressed_texture_s3tc'], 0x83f1: [4, 4, 8, 'WEBGL_compressed_texture_s3tc'],
  0x83f2: [4, 4, 16, 'WEBGL_compressed_texture_s3tc'], 0x83f3: [4, 4, 16, 'WEBGL_compressed_texture_s3tc'],
  0x8c4c: [4, 4, 8, 'WEBGL_compressed_texture_s3tc_srgb'], 0x8c4d: [4, 4, 8, 'WEBGL_compressed_texture_s3tc_srgb'],
  0x8c4e: [4, 4, 16, 'WEBGL_compressed_texture_s3tc_srgb'], 0x8c4f: [4, 4, 16, 'WEBGL_compressed_texture_s3tc_srgb'],
  // BPTC / RGTC
  0x8e8c: [4, 4, 16, 'EXT_texture_compression_bptc'], 0x8e8d: [4, 4, 16, 'EXT_texture_compression_bptc'],
  0x8e8e: [4, 4, 16, 'EXT_texture_compression_bptc'], 0x8e8f: [4, 4, 16, 'EXT_texture_compression_bptc'],
  0x8dbb: [4, 4, 8, 'EXT_texture_compression_rgtc'], 0x8dbc: [4, 4, 8, 'EXT_texture_compression_rgtc'],
  0x8dbd: [4, 4, 16, 'EXT_texture_compression_rgtc'], 0x8dbe: [4, 4, 16, 'EXT_texture_compression_rgtc'],
  // ASTC LDR (and sRGB)
  0x93b0: [4, 4, 16, 'WEBGL_compressed_texture_astc'], 0x93b1: [5, 4, 16, 'WEBGL_compressed_texture_astc'],
  0x93b2: [5, 5, 16, 'WEBGL_compressed_texture_astc'], 0x93b3: [6, 5, 16, 'WEBGL_compressed_texture_astc'],
  0x93b4: [6, 6, 16, 'WEBGL_compressed_texture_astc'], 0x93b5: [8, 5, 16, 'WEBGL_compressed_texture_astc'],
  0x93b6: [8, 6, 16, 'WEBGL_compressed_texture_astc'], 0x93b7: [8, 8, 16, 'WEBGL_compressed_texture_astc'],
  0x93b8: [10, 5, 16, 'WEBGL_compressed_texture_astc'], 0x93b9: [10, 6, 16, 'WEBGL_compressed_texture_astc'],
  0x93ba: [10, 8, 16, 'WEBGL_compressed_texture_astc'], 0x93bb: [10, 10, 16, 'WEBGL_compressed_texture_astc'],
  0x93bc: [12, 10, 16, 'WEBGL_compressed_texture_astc'], 0x93bd: [12, 12, 16, 'WEBGL_compressed_texture_astc'],
  0x93d0: [4, 4, 16, 'WEBGL_compressed_texture_astc'], 0x93d1: [5, 4, 16, 'WEBGL_compressed_texture_astc'],
  0x93d2: [5, 5, 16, 'WEBGL_compressed_texture_astc'], 0x93d3: [6, 5, 16, 'WEBGL_compressed_texture_astc'],
  0x93d4: [6, 6, 16, 'WEBGL_compressed_texture_astc'], 0x93d5: [8, 5, 16, 'WEBGL_compressed_texture_astc'],
  0x93d6: [8, 6, 16, 'WEBGL_compressed_texture_astc'], 0x93d7: [8, 8, 16, 'WEBGL_compressed_texture_astc'],
  0x93d8: [10, 5, 16, 'WEBGL_compressed_texture_astc'], 0x93d9: [10, 6, 16, 'WEBGL_compressed_texture_astc'],
  0x93da: [10, 8, 16, 'WEBGL_compressed_texture_astc'], 0x93db: [10, 10, 16, 'WEBGL_compressed_texture_astc'],
  0x93dc: [12, 10, 16, 'WEBGL_compressed_texture_astc'], 0x93dd: [12, 12, 16, 'WEBGL_compressed_texture_astc'],
};

export function compressedByteSize(format: number, width: number, height: number, depth: number): number {
  const f = COMPRESSED_FORMATS[format];
  if (!f) return -1;
  return Math.ceil(width / f[0]) * Math.ceil(height / f[1]) * f[2] * depth;
}

/** Unsized internal formats accepted by texImage* in WebGL (format == internalformat). */
export function isUnsizedInternalFormat(f: number): boolean {
  return f === 0x1908 || f === 0x1907 || f === 0x1906 || f === 0x1909 || f === 0x190a || f === 0x8c40 || f === 0x8c42;
}

/** Element size of index types. */
export function indexTypeBytes(type: number): number {
  return type === 0x1401 ? 1 : type === 0x1403 ? 2 : type === 0x1405 ? 4 : 0;
}

// ------------------------------------------------------------------------------------------ format validation

/** OpenGL ES 3.0 table 3.2 (+ EXT_texture_norm16): sized internal format -> [format, allowed types]. */
// prettier-ignore
const SIZED_COMBOS: Record<number, readonly [number, readonly number[]]> = {
  0x8229: [0x1903, [0x1401]], 0x8f94: [0x1903, [0x1400]], 0x822d: [0x1903, [0x140b, 0x1406]], 0x822e: [0x1903, [0x1406]],
  0x8232: [0x8d94, [0x1401]], 0x8231: [0x8d94, [0x1400]], 0x8234: [0x8d94, [0x1403]], 0x8233: [0x8d94, [0x1402]],
  0x8236: [0x8d94, [0x1405]], 0x8235: [0x8d94, [0x1404]],
  0x822b: [0x8227, [0x1401]], 0x8f95: [0x8227, [0x1400]], 0x822f: [0x8227, [0x140b, 0x1406]], 0x8230: [0x8227, [0x1406]],
  0x8238: [0x8228, [0x1401]], 0x8237: [0x8228, [0x1400]], 0x823a: [0x8228, [0x1403]], 0x8239: [0x8228, [0x1402]],
  0x823c: [0x8228, [0x1405]], 0x823b: [0x8228, [0x1404]],
  0x8051: [0x1907, [0x1401]], 0x8c41: [0x1907, [0x1401]], 0x8d62: [0x1907, [0x1401, 0x8363]], 0x8f96: [0x1907, [0x1400]],
  0x8c3a: [0x1907, [0x8c3b, 0x140b, 0x1406]], 0x8c3d: [0x1907, [0x8c3e, 0x140b, 0x1406]], 0x881b: [0x1907, [0x140b, 0x1406]],
  0x8815: [0x1907, [0x1406]], 0x8d7d: [0x8d98, [0x1401]], 0x8d8f: [0x8d98, [0x1400]], 0x8d77: [0x8d98, [0x1403]],
  0x8d89: [0x8d98, [0x1402]], 0x8d71: [0x8d98, [0x1405]], 0x8d83: [0x8d98, [0x1404]],
  0x8058: [0x1908, [0x1401]], 0x8c43: [0x1908, [0x1401]], 0x8f97: [0x1908, [0x1400]], 0x8057: [0x1908, [0x1401, 0x8034, 0x8368]],
  0x8056: [0x1908, [0x1401, 0x8033]], 0x8059: [0x1908, [0x8368]], 0x881a: [0x1908, [0x140b, 0x1406]], 0x8814: [0x1908, [0x1406]],
  0x8d7c: [0x8d99, [0x1401]], 0x8d8e: [0x8d99, [0x1400]], 0x906f: [0x8d99, [0x8368]], 0x8d76: [0x8d99, [0x1403]],
  0x8d88: [0x8d99, [0x1402]], 0x8d82: [0x8d99, [0x1404]], 0x8d70: [0x8d99, [0x1405]],
  0x81a5: [0x1902, [0x1403, 0x1405]], 0x81a6: [0x1902, [0x1405]], 0x8cac: [0x1902, [0x1406]],
  0x88f0: [0x84f9, [0x84fa]], 0x8cad: [0x84f9, [0x8dad]],
};
const NORM16: Record<number, readonly [number, readonly number[]]> = {
  0x822a: [0x1903, [0x1403]], 0x822c: [0x8227, [0x1403]], 0x8054: [0x1907, [0x1403]], 0x805b: [0x1908, [0x1403]],
  0x8f98: [0x1903, [0x1402]], 0x8f99: [0x8227, [0x1402]], 0x8f9a: [0x1907, [0x1402]], 0x8f9b: [0x1908, [0x1402]],
};
/** OpenGL ES 3.0 table 3.3 (unsized internal formats, format == internalformat). */
const UNSIZED_COMBOS: Record<number, readonly number[]> = {
  0x1907: [0x1401, 0x8363], // RGB
  0x1908: [0x1401, 0x8033, 0x8034], // RGBA
  0x190a: [0x1401], // LUMINANCE_ALPHA
  0x1909: [0x1401], // LUMINANCE
  0x1906: [0x1401], // ALPHA
};
const ALL_FORMATS = new Set([0x1903, 0x8d94, 0x8227, 0x8228, 0x1907, 0x8d98, 0x1908, 0x8d99, 0x1902, 0x84f9, 0x190a, 0x1909, 0x1906]);
const ALL_TYPES = new Set([0x1401, 0x1400, 0x1403, 0x1402, 0x1405, 0x1404, 0x140b, 0x1406, 0x8363, 0x8033, 0x8034, 0x8368, 0x8c3b, 0x8c3e, 0x84fa, 0x8dad]);

/** Extensions a validation needs to know about (enabled through getExtension). */
export interface FormatExtensions {
  has(name: string): boolean;
}

/**
 * WebGL texImage* (internalformat, format, type) validation. Returns 0 or the error: unknown enums are
 * INVALID_ENUM (internal format INVALID_VALUE in WebGL 2), a valid but unsupported combination INVALID_OPERATION.
 * GLES 3.2 drivers accept more (BGRA, RGBA/FLOAT unsized, ...) than WebGL does, so this runs before the driver.
 */
export function texFormatError(v2: boolean, ext: FormatExtensions, internalformat: number, format: number, type: number): number {
  if (!v2) return texFormatErrorWebGL1(ext, internalformat, format, type);
  const fmtOk = ALL_FORMATS.has(format);
  const typeOk = ALL_TYPES.has(type);
  if (!fmtOk || !typeOk) return 0x0500; // INVALID_ENUM
  const sized = SIZED_COMBOS[internalformat] ?? (ext.has('EXT_texture_norm16') ? NORM16[internalformat] : undefined);
  if (sized) return sized[0] === format && sized[1].includes(type) ? 0 : 0x0502;
  const unsized = UNSIZED_COMBOS[internalformat];
  if (unsized) return internalformat === format && unsized.includes(type) ? 0 : 0x0502;
  return 0x0501; // INVALID_VALUE: unknown internal format
}

function texFormatErrorWebGL1(ext: FormatExtensions, internalformat: number, format: number, type: number): number {
  const srgb = ext.has('EXT_sRGB');
  const formatKnown =
    format === 0x1908 || format === 0x1907 || format === 0x190a || format === 0x1909 || format === 0x1906 ||
    ((format === 0x1902 || format === 0x84f9) && ext.has('WEBGL_depth_texture')) ||
    ((format === 0x8c40 || format === 0x8c42) && srgb);
  if (!formatKnown) return 0x0500;
  const float = type === 0x1406 && ext.has('OES_texture_float');
  const half = type === 0x8d61 && ext.has('OES_texture_half_float');
  const typeKnown =
    type === 0x1401 || type === 0x8363 || type === 0x8033 || type === 0x8034 || float || half ||
    ((type === 0x1403 || type === 0x1405 || type === 0x84fa) && ext.has('WEBGL_depth_texture'));
  if (!typeKnown) return 0x0500;
  if (internalformat !== format) return 0x0502;
  switch (format) {
    case 0x1908:
      return type === 0x1401 || type === 0x8033 || type === 0x8034 || float || half ? 0 : 0x0502;
    case 0x1907:
      return type === 0x1401 || type === 0x8363 || float || half ? 0 : 0x0502;
    case 0x190a:
    case 0x1909:
    case 0x1906:
      return type === 0x1401 || float || half ? 0 : 0x0502;
    case 0x1902:
      return type === 0x1403 || type === 0x1405 ? 0 : 0x0502;
    case 0x84f9:
      return type === 0x84fa ? 0 : 0x0502;
    default:
      return type === 0x1401 ? 0 : 0x0502; // sRGB
  }
}

/** Formats texSubImage* accepts (the level's internal format decides the rest; the driver checks that). */
export function subFormatError(v2: boolean, ext: FormatExtensions, format: number, type: number): number {
  if (!v2) return texFormatErrorWebGL1(ext, format, format, type) === 0x0500 ? 0x0500 : 0;
  return ALL_FORMATS.has(format) && ALL_TYPES.has(type) ? 0 : 0x0500;
}
