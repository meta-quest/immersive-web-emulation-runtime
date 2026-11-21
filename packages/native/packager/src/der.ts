/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * ASN.1 DER: a small encoder and a tolerant BER/DER decoder (ITU-T X.690),
 * enough for X.509 certificates, PKCS#8, PKCS#12 and the JKS key wrapper.
 */

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  BMP_STRING: 0x1e,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerError';
  }
}

// ---- encoder ----------------------------------------------------------------

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag]),
    encodeLength(content.length),
    content,
  ]);
}

export const seq = (...items: Buffer[]): Buffer =>
  tlv(TAG.SEQUENCE, Buffer.concat(items));
export const set = (...items: Buffer[]): Buffer =>
  tlv(TAG.SET, Buffer.concat(items));
export const nul = (): Buffer => Buffer.from([TAG.NULL, 0]);
export const octets = (data: Buffer): Buffer => tlv(TAG.OCTET_STRING, data);
export const utf8 = (s: string): Buffer =>
  tlv(TAG.UTF8_STRING, Buffer.from(s, 'utf8'));
export const printable = (s: string): Buffer =>
  tlv(TAG.PRINTABLE_STRING, Buffer.from(s, 'latin1'));
/** BIT STRING with no unused bits. */
export const bits = (data: Buffer): Buffer =>
  tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0]), data]));
/** Context-specific constructed (EXPLICIT) tag. */
export const explicit = (n: number, inner: Buffer): Buffer =>
  tlv(0xa0 | n, inner);

/** INTEGER from a non-negative bigint or number (two's complement, minimal). */
export function int(value: bigint | number | Buffer): Buffer {
  let bytes: Buffer;
  if (Buffer.isBuffer(value)) {
    bytes = value;
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0 && bytes[i + 1] < 0x80) i++;
    bytes = bytes.subarray(i);
    if (bytes.length === 0) bytes = Buffer.from([0]);
  } else {
    let v = BigInt(value);
    if (v < 0n) throw new DerError('negative INTEGER not supported');
    const out: number[] = [];
    do {
      out.unshift(Number(v & 0xffn));
      v >>= 8n;
    } while (v > 0n);
    bytes = Buffer.from(out);
  }
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(TAG.INTEGER, bytes);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map((p) => BigInt(p));
  if (parts.length < 2) throw new DerError(`bad OID ${dotted}`);
  const out: number[] = [Number(parts[0] * 40n + parts[1])];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let v = part;
    do {
      chunk.unshift(Number(v & 0x7fn));
      v >>= 7n;
    } while (v > 0n);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(out));
}

/** UTCTime before 2050, GeneralizedTime from 2050 on (RFC 5280 4.1.2.5). */
export function time(date: Date): Buffer {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const y = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  if (y >= 1950 && y < 2050)
    return tlv(TAG.UTC_TIME, Buffer.from(pad(y % 100) + rest, 'latin1'));
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(pad(y, 4) + rest, 'latin1'));
}

// ---- decoder ----------------------------------------------------------------

export interface DerNode {
  tag: number;
  /** Whole TLV, header included. */
  raw: Buffer;
  /** Content octets (for indefinite-length nodes: the concatenated children). */
  content: Buffer;
  /** Children when constructed. */
  children: DerNode[];
}

export function decode(buffer: Buffer): DerNode {
  const [node, end] = decodeAt(buffer, 0);
  if (end !== buffer.length)
    throw new DerError(
      `trailing bytes after DER value (${buffer.length - end})`,
    );
  return node;
}

function decodeAt(buffer: Buffer, start: number): [DerNode, number] {
  if (start + 2 > buffer.length) throw new DerError('truncated DER');
  const tag = buffer[start];
  if ((tag & 0x1f) === 0x1f)
    throw new DerError('high tag numbers not supported');
  let p = start + 1;
  let length = buffer[p++];
  const constructed = (tag & 0x20) !== 0;
  if (length === 0x80) {
    // BER indefinite length (some PKCS#12 producers): children until 00 00.
    if (!constructed) throw new DerError('indefinite length on primitive');
    const children: DerNode[] = [];
    while (true) {
      if (p + 2 > buffer.length) throw new DerError('truncated BER');
      if (buffer[p] === 0 && buffer[p + 1] === 0) {
        p += 2;
        break;
      }
      const [child, next] = decodeAt(buffer, p);
      children.push(child);
      p = next;
    }
    return [
      {
        tag,
        raw: buffer.subarray(start, p),
        content: Buffer.concat(children.map((c) => c.raw)),
        children,
      },
      p,
    ];
  }
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n > 4 || p + n > buffer.length) throw new DerError('bad DER length');
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buffer[p++];
  }
  const end = p + length;
  if (end > buffer.length) throw new DerError('DER value runs past the buffer');
  const content = buffer.subarray(p, end);
  const children: DerNode[] = [];
  if (constructed) {
    let q = p;
    while (q < end) {
      const [child, next] = decodeAt(buffer, q);
      children.push(child);
      q = next;
    }
    if (q !== end) throw new DerError('constructed value length mismatch');
  }
  return [{ tag, raw: buffer.subarray(start, end), content, children }, end];
}

export function expect(
  node: DerNode | undefined,
  tag: number,
  what: string,
): DerNode {
  if (!node) throw new DerError(`${what}: missing`);
  if (node.tag !== tag)
    throw new DerError(
      `${what}: expected tag 0x${tag.toString(16)}, got 0x${node.tag.toString(16)}`,
    );
  return node;
}

export function readOid(node: DerNode | undefined, what = 'OID'): string {
  const n = expect(node, TAG.OID, what).content;
  if (n.length === 0) throw new DerError(`${what}: empty`);
  const first = n[0];
  const parts: bigint[] = [BigInt(Math.min(2, Math.floor(first / 40)))];
  parts.push(BigInt(first) - parts[0] * 40n);
  let v = 0n;
  for (let i = 1; i < n.length; i++) {
    v = (v << 7n) | BigInt(n[i] & 0x7f);
    if (!(n[i] & 0x80)) {
      parts.push(v);
      v = 0n;
    }
  }
  return parts.join('.');
}

export function readInt(node: DerNode | undefined, what = 'INTEGER'): bigint {
  const c = expect(node, TAG.INTEGER, what).content;
  let v = 0n;
  for (const b of c) v = (v << 8n) | BigInt(b);
  if (c.length > 0 && c[0] & 0x80) v -= 1n << BigInt(c.length * 8);
  return v;
}

/**
 * OCTET STRING content; BER constructed OCTET STRINGs (tag 0x24, or an
 * implicit context tag) are flattened.
 */
export function readOctets(
  node: DerNode | undefined,
  what = 'OCTET STRING',
): Buffer {
  if (!node) throw new DerError(`${what}: missing`);
  if (node.tag & 0x20)
    return Buffer.concat(node.children.map((c) => readOctets(c, what)));
  return node.content;
}

/** BMPString (UTF-16BE) to a JS string. */
export function readBmp(node: DerNode): string {
  const c = node.content;
  let s = '';
  for (let i = 0; i + 1 < c.length; i += 2)
    s += String.fromCharCode(c.readUInt16BE(i));
  return s;
}
