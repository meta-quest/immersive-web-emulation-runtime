/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Minimal ZIP reader and deterministic, aligning ZIP writer for APKs.
 *
 * Written from the PKWARE APPNOTE (local file header, central directory,
 * end of central directory record) and Android's documented APK rules:
 * uncompressed entries are aligned so the platform can map them (4 bytes for
 * assets, 16 KiB for native libraries on 16 KiB-page devices), the alignment
 * padding lives in a local-header extra field, and nothing may sit between
 * the last entry and the central directory except an APK Signing Block.
 *
 * Not supported (refused with a clear error): ZIP64, encryption, multi-disk
 * archives, compression methods other than stored (0) and deflate (8).
 */

import { crc32, deflateRaw, inflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';

const deflateRawAsync = promisify(deflateRaw);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

/** Header ID of the extra field Android's zipalign uses for padding. */
export const ALIGNMENT_EXTRA_ID = 0xd935;

/**
 * Fixed DOS timestamp for reproducible archives: 1981-01-01 00:00:00 (the
 * earliest date every unzip handles without a timezone quirk).
 */
const DOS_DATE = ((1981 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  headerOffset: number;
  /** Offset of the (possibly compressed) data. */
  dataOffset: number;
}

export interface ZipArchive {
  buffer: Buffer;
  entries: ZipEntry[];
  /** Offset where the central directory starts. */
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  eocdOffset: number;
}

/** Parse the central directory of a ZIP held in memory. */
export function readZip(buffer: Buffer): ZipArchive {
  const eocdOffset = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const cdDisk = buffer.readUInt16LE(eocdOffset + 6);
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || cdDisk !== 0)
    throw new ZipFormatError('multi-disk ZIP archives are not supported');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipFormatError('ZIP64 archives are not supported');
  if (cdOffset + cdSize > eocdOffset)
    throw new ZipFormatError('central directory overlaps the end record');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocdOffset || buffer.readUInt32LE(p) !== SIG_CENTRAL)
      throw new ZipFormatError(`bad central directory entry #${i}`);
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const headerOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    if (flags & 1) throw new ZipFormatError(`entry "${name}" is encrypted`);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE)
      throw new ZipFormatError(
        `entry "${name}" uses unsupported compression method ${method}`,
      );
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      headerOffset === 0xffffffff
    )
      throw new ZipFormatError('ZIP64 archives are not supported');
    if (
      headerOffset + 30 > cdOffset ||
      buffer.readUInt32LE(headerOffset) !== SIG_LOCAL
    )
      throw new ZipFormatError(`entry "${name}": bad local header`);
    const localNameLen = buffer.readUInt16LE(headerOffset + 26);
    const localExtraLen = buffer.readUInt16LE(headerOffset + 28);
    const dataOffset = headerOffset + 30 + localNameLen + localExtraLen;
    if (dataOffset + compressedSize > cdOffset)
      throw new ZipFormatError(`entry "${name}": data runs past the archive`);
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      headerOffset,
      dataOffset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    buffer,
    entries,
    centralDirectoryOffset: cdOffset,
    centralDirectorySize: cdSize,
    eocdOffset,
  };
}

function findEocd(buffer: Buffer): number {
  if (buffer.length < EOCD_SIZE)
    throw new ZipFormatError('not a ZIP archive (too short)');
  const stop = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT);
  for (let p = buffer.length - EOCD_SIZE; p >= stop; p--) {
    if (
      buffer.readUInt32LE(p) === SIG_EOCD &&
      p + EOCD_SIZE + buffer.readUInt16LE(p + 20) === buffer.length
    )
      return p;
  }
  throw new ZipFormatError('not a ZIP archive (no end of central directory)');
}

/** The stored bytes of an entry (compressed if the entry is deflated). */
export function rawEntryData(zip: ZipArchive, entry: ZipEntry): Buffer {
  return zip.buffer.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
}

/** The uncompressed bytes of an entry, CRC-checked. */
export function entryData(zip: ZipArchive, entry: ZipEntry): Buffer {
  const raw = rawEntryData(zip, entry);
  const data = entry.method === METHOD_STORED ? raw : inflateRawSync(raw);
  if (data.length !== entry.size || crc32(data) >>> 0 !== entry.crc)
    throw new ZipFormatError(`entry "${entry.name}": CRC or size mismatch`);
  return data;
}

export function findEntry(zip: ZipArchive, name: string): ZipEntry | undefined {
  return zip.entries.find((e) => e.name === name);
}

/** One entry ready to be written: data already in its stored form. */
export interface PreparedEntry {
  name: string;
  method: number;
  crc: number;
  size: number;
  /** Stored bytes (deflated when method is deflate). */
  data: Buffer;
  /** Byte alignment of the data offset; only honoured for stored entries. */
  align: number;
}

/**
 * Prepare an entry from uncompressed bytes. `compress` false stores it
 * verbatim. Deflate uses level 9 (zlib output is deterministic for the same
 * zlib build and input).
 */
export async function prepareEntry(
  name: string,
  data: Buffer,
  options: { compress: boolean; align?: number },
): Promise<PreparedEntry> {
  const crc = crc32(data) >>> 0;
  if (options.compress && data.length > 0) {
    const deflated = await deflateRawAsync(data, { level: 9 });
    // Keep the smaller form: incompressible data is cheaper stored.
    if (deflated.length < data.length) {
      return {
        name,
        method: METHOD_DEFLATE,
        crc,
        size: data.length,
        data: deflated,
        align: 1,
      };
    }
  }
  return {
    name,
    method: METHOD_STORED,
    crc,
    size: data.length,
    data,
    align: options.align ?? 4,
  };
}

/** Reuse an entry of an existing archive without recompressing it. */
export function copyEntry(
  zip: ZipArchive,
  entry: ZipEntry,
  align: number,
): PreparedEntry {
  return {
    name: entry.name,
    method: entry.method,
    crc: entry.crc,
    size: entry.size,
    data: rawEntryData(zip, entry),
    align: entry.method === METHOD_STORED ? align : 1,
  };
}

export interface WrittenZip {
  /** Local headers + data for every entry (the "contents of ZIP entries" section). */
  entries: Buffer;
  centralDirectory: Buffer;
  eocd: Buffer;
}

/**
 * Lay out entries in the given order with fixed timestamps. Stored entries get
 * an alignment extra field (ID 0xd935: u16 alignment then zero padding) so
 * their data offset is a multiple of `align`.
 */
export function writeZip(prepared: readonly PreparedEntry[]): WrittenZip {
  const seen = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const e of prepared) {
    if (seen.has(e.name))
      throw new ZipFormatError(`duplicate entry name "${e.name}"`);
    seen.add(e.name);
    const name = Buffer.from(e.name, 'utf8');
    if (name.length > 0xffff)
      throw new ZipFormatError(`entry name too long: ${e.name}`);
    const utf8Flag = /[^\x20-\x7e]/.test(e.name) ? 0x0800 : 0;
    let extra = Buffer.alloc(0);
    if (e.method === METHOD_STORED && e.align > 1) {
      const base = offset + 30 + name.length + 6;
      const pad = (e.align - (base % e.align)) % e.align;
      extra = Buffer.alloc(6 + pad);
      extra.writeUInt16LE(ALIGNMENT_EXTRA_ID, 0);
      extra.writeUInt16LE(2 + pad, 2);
      extra.writeUInt16LE(e.align, 4);
    }
    if (e.data.length > 0xfffffffe || offset > 0xfffffffe)
      throw new ZipFormatError('archive too large (ZIP64 is not supported)');
    const version = e.method === METHOD_DEFLATE ? 20 : 10;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    localParts.push(local, name, extra, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(version, 4); // version made by (MS-DOS, spec 1.0/2.0)
    central.writeUInt16LE(version, 6);
    central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.size, 24);
    central.writeUInt16LE(name.length, 28);
    // extra (30), comment (32), disk (34), internal attrs (36), external attrs (38): 0
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += 30 + name.length + extra.length + e.data.length;
  }
  if (prepared.length > 0xfffe)
    throw new ZipFormatError('too many entries (ZIP64 is not supported)');
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return { entries: Buffer.concat(localParts), centralDirectory, eocd };
}

/**
 * Check alignment the way `zipalign -c -P 16 4` does: every stored entry's
 * data is 4-byte aligned, stored `.so` files are 16 KiB aligned.
 */
export function checkAlignment(
  zip: ZipArchive,
  options: { soAlign?: number } = {},
): string[] {
  const soAlign = options.soAlign ?? 16384;
  const problems: string[] = [];
  for (const e of zip.entries) {
    if (e.method !== METHOD_STORED) continue;
    const want = e.name.endsWith('.so') ? soAlign : 4;
    if (e.dataOffset % want !== 0)
      problems.push(
        `${e.name}: data at offset ${e.dataOffset} is not ${want}-byte aligned`,
      );
  }
  return problems;
}
