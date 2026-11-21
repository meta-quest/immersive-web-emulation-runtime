/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Android binary XML (the compiled AndroidManifest.xml): decode into a small
 * tree with plain string values, edit it, encode it again.
 *
 * Format source: AOSP `libs/androidfw/include/androidfw/ResourceTypes.h`
 * (Apache-2.0; the public definition of ResChunk_header, ResStringPool,
 * ResXMLTree_* and Res_value). The encoder rebuilds the string pool from
 * scratch: attribute names that carry a framework resource ID come first, in
 * the same order as the resource map (the platform matches attributes by
 * that ID, not by name), then every other string.
 */

export class AxmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AxmlError';
  }
}

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;

const UTF8_FLAG = 0x100;
const NO_INDEX = 0xffffffff;

/** Res_value data types used in manifests. */
export const VALUE_TYPE = {
  NULL: 0x00,
  REFERENCE: 0x01,
  ATTRIBUTE: 0x02,
  STRING: 0x03,
  FLOAT: 0x04,
  DIMENSION: 0x05,
  FRACTION: 0x06,
  INT_DEC: 0x10,
  INT_HEX: 0x11,
  INT_BOOLEAN: 0x12,
} as const;

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/**
 * Framework attribute resource IDs (android.R.attr) the packer may add.
 * Values from the public Android SDK (`android.R.attr`, platforms/android-N/
 * data/res/values/public.xml).
 */
export const ANDROID_ATTR = {
  label: 0x01010001,
  icon: 0x01010002,
  name: 0x01010003,
  debuggable: 0x0101000f,
  value: 0x01010024,
  minSdkVersion: 0x0101020c,
  targetActivity: 0x01010202,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  targetSdkVersion: 0x01010270,
  backupAgent: 0x0101027f,
  glEsVersion: 0x01010281,
  required: 0x0101028e,
  version: 0x01010519,
} as const;

export type AttrValue =
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'reference'; value: number }
  /** Any other typed value, kept verbatim (raw string kept if present). */
  | { type: 'typed'; dataType: number; data: number; raw?: string };

export interface XmlAttribute {
  ns: string | null;
  name: string;
  /** Framework attribute ID from the resource map (0 when none). */
  resId: number;
  value: AttrValue;
}

export interface XmlElement {
  kind: 'element';
  ns: string | null;
  name: string;
  attributes: XmlAttribute[];
  children: XmlNode[];
  line: number;
}

export interface XmlText {
  kind: 'text';
  text: string;
  line: number;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlNamespace {
  prefix: string;
  uri: string;
}

export interface XmlDocument {
  namespaces: XmlNamespace[];
  root: XmlElement;
}

// ---- string pool ----------------------------------------------------------

/**
 * Decode a UTF-8 string-pool entry. aapt2 encodes characters outside the BMP
 * as two 3-byte surrogate sequences (CESU-8, like Java's modified UTF-8)
 * rather than one 4-byte sequence, which Buffer's UTF-8 decoder rejects;
 * both forms are accepted here.
 */
export function decodeCesu8(buf: Buffer, start: number, end: number): string {
  const units: number[] = [];
  let i = start;
  const cont = (k: number) => i + k < end && (buf[i + k] & 0xc0) === 0x80;
  while (i < end) {
    const b = buf[i];
    if (b < 0x80) {
      units.push(b);
      i += 1;
    } else if (b >= 0xc0 && b < 0xe0 && cont(1)) {
      units.push(((b & 0x1f) << 6) | (buf[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && cont(1) && cont(2)) {
      // May be a lone surrogate half; pairs recombine in fromCharCode.
      units.push(
        ((b & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f),
      );
      i += 3;
    } else if (b >= 0xf0 && b < 0xf8 && cont(1) && cont(2) && cont(3)) {
      const cp =
        ((b & 0x07) << 18) |
        ((buf[i + 1] & 0x3f) << 12) |
        ((buf[i + 2] & 0x3f) << 6) |
        (buf[i + 3] & 0x3f);
      const v = cp - 0x10000;
      units.push(0xd800 | (v >> 10), 0xdc00 | (v & 0x3ff));
      i += 4;
    } else {
      units.push(0xfffd);
      i += 1;
    }
  }
  let out = '';
  for (let k = 0; k < units.length; k += 8192)
    out += String.fromCharCode(...units.slice(k, k + 8192));
  return out;
}

function decodeStringPool(buf: Buffer, start: number): string[] {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    const offset = buf.readUInt32LE(start + headerSize + i * 4);
    let p = start + stringsStart + offset;
    if (utf8) {
      // utf16 length (1 or 2 bytes), then utf8 byte length (1 or 2 bytes).
      p += buf[p] & 0x80 ? 2 : 1;
      let len = buf[p];
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[p + 1];
        p += 2;
      } else p += 1;
      strings.push(decodeCesu8(buf, p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
        p += 4;
      } else p += 2;
      strings.push(buf.toString('utf16le', p, p + len * 2));
    }
  }
  return strings;
}

/** Encode a UTF-16 string pool (what aapt2 writes for manifests). */
function encodeStringPool(strings: readonly string[]): Buffer {
  const headerSize = 28;
  const offsets = Buffer.alloc(strings.length * 4);
  const parts: Buffer[] = [];
  let dataLen = 0;
  strings.forEach((s, i) => {
    offsets.writeUInt32LE(dataLen, i * 4);
    const units = s.length;
    let head: Buffer;
    if (units > 0x7fff) {
      if (units > 0x7fffffff) throw new AxmlError('string too long');
      head = Buffer.alloc(4);
      head.writeUInt16LE(0x8000 | (units >>> 16), 0);
      head.writeUInt16LE(units & 0xffff, 2);
    } else {
      head = Buffer.alloc(2);
      head.writeUInt16LE(units, 0);
    }
    const body = Buffer.from(s, 'utf16le');
    const item = Buffer.concat([head, body, Buffer.alloc(2)]);
    parts.push(item);
    dataLen += item.length;
  });
  const pad = (4 - (dataLen % 4)) % 4;
  if (pad) parts.push(Buffer.alloc(pad));
  const header = Buffer.alloc(headerSize);
  const total = headerSize + offsets.length + dataLen + pad;
  header.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(total, 4);
  header.writeUInt32LE(strings.length, 8);
  header.writeUInt32LE(0, 12); // styleCount
  header.writeUInt32LE(0, 16); // flags: UTF-16, not sorted
  header.writeUInt32LE(headerSize + offsets.length, 20);
  header.writeUInt32LE(0, 24); // stylesStart
  return Buffer.concat([header, offsets, ...parts]);
}

// ---- decode -----------------------------------------------------------------

export function decodeAxml(buf: Buffer): XmlDocument {
  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE)
    throw new AxmlError('not an Android binary XML document');
  const total = buf.readUInt32LE(4);
  if (total > buf.length) throw new AxmlError('truncated binary XML');
  let p = buf.readUInt16LE(2);
  let strings: string[] = [];
  let resIds: number[] = [];
  const namespaces: XmlNamespace[] = [];
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const str = (i: number): string | null => {
    if (i === NO_INDEX) return null;
    const s = strings[i];
    if (s === undefined) throw new AxmlError(`string index ${i} out of range`);
    return s;
  };

  while (p < total) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > total) throw new AxmlError('bad chunk size');
    const body = p + headerSize;
    switch (type) {
      case RES_STRING_POOL_TYPE:
        strings = decodeStringPool(buf, p);
        break;
      case RES_XML_RESOURCE_MAP_TYPE:
        resIds = [];
        for (let q = p + 8; q < p + size; q += 4)
          resIds.push(buf.readUInt32LE(q));
        break;
      case RES_XML_START_NAMESPACE_TYPE: {
        const prefix = str(buf.readUInt32LE(body)) ?? '';
        const uri = str(buf.readUInt32LE(body + 4)) ?? '';
        if (!namespaces.some((n) => n.uri === uri && n.prefix === prefix))
          namespaces.push({ prefix, uri });
        break;
      }
      case RES_XML_END_NAMESPACE_TYPE:
        break;
      case RES_XML_START_ELEMENT_TYPE: {
        const line = buf.readUInt32LE(p + 8);
        const ns = str(buf.readUInt32LE(body));
        const name = str(buf.readUInt32LE(body + 4)) ?? '';
        const attrStart = buf.readUInt16LE(body + 8);
        const attrSize = buf.readUInt16LE(body + 10);
        const attrCount = buf.readUInt16LE(body + 12);
        const attributes: XmlAttribute[] = [];
        for (let i = 0; i < attrCount; i++) {
          const a = body + attrStart + i * attrSize;
          const nameIndex = buf.readUInt32LE(a + 4);
          const rawIndex = buf.readUInt32LE(a + 8);
          const dataType = buf[a + 15];
          const data = buf.readUInt32LE(a + 16);
          attributes.push({
            ns: str(buf.readUInt32LE(a)),
            name: str(nameIndex) ?? '',
            resId: nameIndex < resIds.length ? resIds[nameIndex] : 0,
            value: decodeValue(
              dataType,
              data,
              rawIndex === NO_INDEX ? null : str(rawIndex),
              str,
            ),
          });
        }
        const element: XmlElement = {
          kind: 'element',
          ns,
          name,
          attributes,
          children: [],
          line,
        };
        if (stack.length > 0) stack[stack.length - 1].children.push(element);
        else if (root) throw new AxmlError('more than one root element');
        else root = element;
        stack.push(element);
        break;
      }
      case RES_XML_END_ELEMENT_TYPE:
        if (!stack.pop()) throw new AxmlError('unbalanced end element');
        break;
      case RES_XML_CDATA_TYPE: {
        const text = str(buf.readUInt32LE(body)) ?? '';
        stack[stack.length - 1]?.children.push({
          kind: 'text',
          text,
          line: buf.readUInt32LE(p + 8),
        });
        break;
      }
      default:
        // Unknown chunks are skipped (the format allows it).
        break;
    }
    p += size;
  }
  if (!root) throw new AxmlError('no root element');
  if (stack.length) throw new AxmlError('unclosed element');
  return { namespaces, root };
}

function decodeValue(
  dataType: number,
  data: number,
  raw: string | null,
  str: (i: number) => string | null,
): AttrValue {
  switch (dataType) {
    case VALUE_TYPE.STRING:
      return { type: 'string', value: raw ?? str(data) ?? '' };
    case VALUE_TYPE.INT_DEC:
      return { type: 'int', value: data | 0 };
    case VALUE_TYPE.INT_BOOLEAN:
      return { type: 'bool', value: data !== 0 };
    case VALUE_TYPE.REFERENCE:
      return { type: 'reference', value: data };
    default:
      return raw === null
        ? { type: 'typed', dataType, data }
        : { type: 'typed', dataType, data, raw };
  }
}

// ---- encode -----------------------------------------------------------------

class PoolBuilder {
  /** Strings with a resource ID: key "resId:text". */
  private mapped = new Map<string, number>();
  private mappedList: { text: string; resId: number }[] = [];
  private plain = new Map<string, number>();
  private plainList: string[] = [];

  addMapped(text: string, resId: number): void {
    const key = `${resId}:${text}`;
    if (this.mapped.has(key)) return;
    this.mapped.set(key, this.mappedList.length);
    this.mappedList.push({ text, resId });
  }
  addPlain(text: string): void {
    if (this.plain.has(text)) return;
    this.plain.set(text, this.plainList.length);
    this.plainList.push(text);
  }
  /** Freeze: mapped strings sorted by resource ID, then plain strings. */
  finish(): {
    strings: string[];
    resIds: number[];
    mappedIndex: (text: string, resId: number) => number;
    plainIndex: (text: string) => number;
  } {
    const mapped = [...this.mappedList].sort((a, b) => a.resId - b.resId);
    const mIndex = new Map(mapped.map((m, i) => [`${m.resId}:${m.text}`, i]));
    const pIndex = new Map(
      this.plainList.map((s, i) => [s, mapped.length + i]),
    );
    return {
      strings: [...mapped.map((m) => m.text), ...this.plainList],
      resIds: mapped.map((m) => m.resId),
      mappedIndex: (text, resId) => {
        const i = mIndex.get(`${resId}:${text}`);
        if (i === undefined) throw new AxmlError(`unpooled ${text}`);
        return i;
      },
      plainIndex: (text) => {
        const i = pIndex.get(text);
        if (i === undefined) throw new AxmlError(`unpooled ${text}`);
        return i;
      },
    };
  }
}

function walk(node: XmlNode, visit: (n: XmlNode) => void): void {
  visit(node);
  if (node.kind === 'element') for (const c of node.children) walk(c, visit);
}

/** Sort attributes the way aapt2 does: by resource ID, then unnamed by name. */
function sortedAttributes(attrs: readonly XmlAttribute[]): XmlAttribute[] {
  return [...attrs].sort((a, b) => {
    if (a.resId && b.resId) return a.resId - b.resId;
    if (a.resId) return -1;
    if (b.resId) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function encodeAxml(doc: XmlDocument): Buffer {
  const pool = new PoolBuilder();
  for (const ns of doc.namespaces) {
    pool.addPlain(ns.prefix);
    pool.addPlain(ns.uri);
  }
  walk(doc.root, (n) => {
    if (n.kind === 'text') {
      pool.addPlain(n.text);
      return;
    }
    if (n.ns !== null) pool.addPlain(n.ns);
    pool.addPlain(n.name);
    for (const a of n.attributes) {
      if (a.ns !== null) pool.addPlain(a.ns);
      if (a.resId) pool.addMapped(a.name, a.resId);
      else pool.addPlain(a.name);
      if (a.value.type === 'string') pool.addPlain(a.value.value);
      if (a.value.type === 'typed' && a.value.raw !== undefined)
        pool.addPlain(a.value.raw);
    }
  });
  const { strings, resIds, mappedIndex, plainIndex } = pool.finish();
  const nsIndex = (ns: string | null) =>
    ns === null ? NO_INDEX : plainIndex(ns);

  const chunks: Buffer[] = [];
  const node = (type: number, line: number, ext: Buffer): Buffer => {
    const header = Buffer.alloc(16);
    header.writeUInt16LE(type, 0);
    header.writeUInt16LE(16, 2);
    header.writeUInt32LE(16 + ext.length, 4);
    header.writeUInt32LE(line, 8);
    header.writeUInt32LE(NO_INDEX, 12);
    return Buffer.concat([header, ext]);
  };
  const u32s = (...values: number[]) => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
    return b;
  };

  const rootLine = doc.root.line || 1;
  for (const ns of doc.namespaces)
    chunks.push(
      node(
        RES_XML_START_NAMESPACE_TYPE,
        rootLine,
        u32s(plainIndex(ns.prefix), plainIndex(ns.uri)),
      ),
    );

  const emit = (n: XmlNode): void => {
    if (n.kind === 'text') {
      const ext = Buffer.alloc(12);
      ext.writeUInt32LE(plainIndex(n.text), 0);
      ext.writeUInt16LE(8, 4);
      ext[7] = VALUE_TYPE.STRING;
      ext.writeUInt32LE(plainIndex(n.text), 8);
      chunks.push(node(RES_XML_CDATA_TYPE, n.line, ext));
      return;
    }
    const attrs = sortedAttributes(n.attributes);
    const ext = Buffer.alloc(20 + attrs.length * 20);
    ext.writeUInt32LE(nsIndex(n.ns), 0);
    ext.writeUInt32LE(plainIndex(n.name), 4);
    ext.writeUInt16LE(20, 8); // attributeStart
    ext.writeUInt16LE(20, 10); // attributeSize
    ext.writeUInt16LE(attrs.length, 12);
    const idx = (pred: (a: XmlAttribute) => boolean) => {
      const i = attrs.findIndex(pred);
      return i < 0 ? 0 : i + 1;
    };
    ext.writeUInt16LE(
      idx((a) => a.resId === 0x010100d0),
      14,
    ); // android:id
    ext.writeUInt16LE(
      idx((a) => a.ns === null && a.name === 'class'),
      16,
    );
    ext.writeUInt16LE(
      idx((a) => a.ns === null && a.name === 'style'),
      18,
    );
    attrs.forEach((a, i) => {
      const o = 20 + i * 20;
      ext.writeUInt32LE(nsIndex(a.ns), o);
      ext.writeUInt32LE(
        a.resId ? mappedIndex(a.name, a.resId) : plainIndex(a.name),
        o + 4,
      );
      let raw = NO_INDEX;
      let dataType: number;
      let data: number;
      switch (a.value.type) {
        case 'string':
          raw = plainIndex(a.value.value);
          dataType = VALUE_TYPE.STRING;
          data = raw;
          break;
        case 'int':
          dataType = VALUE_TYPE.INT_DEC;
          data = a.value.value;
          break;
        case 'bool':
          dataType = VALUE_TYPE.INT_BOOLEAN;
          data = a.value.value ? 0xffffffff : 0;
          break;
        case 'reference':
          dataType = VALUE_TYPE.REFERENCE;
          data = a.value.value;
          break;
        case 'typed':
          dataType = a.value.dataType;
          data = a.value.data;
          if (a.value.raw !== undefined) raw = plainIndex(a.value.raw);
          break;
      }
      ext.writeUInt32LE(raw >>> 0, o + 8);
      ext.writeUInt16LE(8, o + 12);
      ext[o + 14] = 0;
      ext[o + 15] = dataType;
      ext.writeUInt32LE(data >>> 0, o + 16);
    });
    chunks.push(node(RES_XML_START_ELEMENT_TYPE, n.line, ext));
    for (const c of n.children) emit(c);
    chunks.push(
      node(
        RES_XML_END_ELEMENT_TYPE,
        n.line,
        u32s(nsIndex(n.ns), plainIndex(n.name)),
      ),
    );
  };
  emit(doc.root);
  for (const ns of [...doc.namespaces].reverse())
    chunks.push(
      node(
        RES_XML_END_NAMESPACE_TYPE,
        rootLine,
        u32s(plainIndex(ns.prefix), plainIndex(ns.uri)),
      ),
    );

  const poolChunk = encodeStringPool(strings);
  const mapChunk = Buffer.alloc(8 + resIds.length * 4);
  mapChunk.writeUInt16LE(RES_XML_RESOURCE_MAP_TYPE, 0);
  mapChunk.writeUInt16LE(8, 2);
  mapChunk.writeUInt32LE(mapChunk.length, 4);
  resIds.forEach((id, i) => mapChunk.writeUInt32LE(id, 8 + i * 4));
  const bodyParts = [poolChunk, mapChunk, ...chunks];
  const bodyLen = bodyParts.reduce((n, b) => n + b.length, 0);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(RES_XML_TYPE, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + bodyLen, 4);
  return Buffer.concat([header, ...bodyParts]);
}

// ---- helpers for editing ----------------------------------------------------

export function childElements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement =>
      c.kind === 'element' && (name === undefined || c.name === name),
  );
}

export function findAttr(
  el: XmlElement,
  name: string,
  ns: string | null = ANDROID_NS,
): XmlAttribute | undefined {
  return el.attributes.find((a) => a.name === name && a.ns === ns);
}

/** Set (or add) an attribute; android-namespaced names get their resource ID. */
export function setAttr(
  el: XmlElement,
  name: string,
  value: AttrValue,
  ns: string | null = ANDROID_NS,
): void {
  const existing = findAttr(el, name, ns);
  if (existing) {
    existing.value = value;
    return;
  }
  let resId = 0;
  if (ns === ANDROID_NS) {
    resId = (ANDROID_ATTR as Record<string, number>)[name] ?? 0;
    if (!resId) throw new AxmlError(`no known resource ID for android:${name}`);
  }
  el.attributes.push({ ns, name, resId, value });
}

export function removeAttr(
  el: XmlElement,
  name: string,
  ns: string | null = ANDROID_NS,
): void {
  el.attributes = el.attributes.filter(
    (a) => !(a.name === name && a.ns === ns),
  );
}

export function attrString(
  el: XmlElement,
  name: string,
  ns: string | null = ANDROID_NS,
): string | undefined {
  const a = findAttr(el, name, ns);
  if (!a) return undefined;
  switch (a.value.type) {
    case 'string':
      return a.value.value;
    case 'int':
      return String(a.value.value);
    case 'bool':
      return String(a.value.value);
    case 'reference':
      return `@0x${a.value.value.toString(16).padStart(8, '0')}`;
    case 'typed':
      return a.value.raw ?? `0x${a.value.data.toString(16)}`;
  }
}

/** A new element with android-namespaced attributes. */
export function element(
  name: string,
  attrs: Record<string, AttrValue> = {},
  line = 0,
): XmlElement {
  const el: XmlElement = {
    kind: 'element',
    ns: null,
    name,
    attributes: [],
    children: [],
    line,
  };
  for (const [k, v] of Object.entries(attrs)) setAttr(el, k, v);
  return el;
}

/** Render a document as text XML (for snapshots, diagnostics, `pack --print-manifest`). */
export function axmlToText(doc: XmlDocument): string {
  const prefixOf = (uri: string | null) => {
    if (uri === null) return '';
    const ns = doc.namespaces.find((n) => n.uri === uri);
    return ns ? `${ns.prefix}:` : `{${uri}}`;
  };
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const lines: string[] = [];
  const out = (n: XmlNode, depth: number, isRoot: boolean) => {
    const pad = '  '.repeat(depth);
    if (n.kind === 'text') {
      lines.push(pad + esc(n.text));
      return;
    }
    const attrs = n.attributes.map((a) => {
      let v: string;
      switch (a.value.type) {
        case 'string':
          v = a.value.value;
          break;
        case 'reference':
          v = `@0x${a.value.value.toString(16).padStart(8, '0')}`;
          break;
        default:
          v = attrString(n, a.name, a.ns) ?? '';
      }
      return `${prefixOf(a.ns)}${a.name}="${esc(v)}"`;
    });
    if (isRoot)
      attrs.unshift(
        ...doc.namespaces.map((ns) => `xmlns:${ns.prefix}="${esc(ns.uri)}"`),
      );
    const open = `${pad}<${prefixOf(n.ns)}${n.name}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
    if (n.children.length === 0) {
      lines.push(`${open}/>`);
      return;
    }
    lines.push(`${open}>`);
    for (const c of n.children) out(c, depth + 1, false);
    lines.push(`${pad}</${prefixOf(n.ns)}${n.name}>`);
  };
  out(doc.root, 0, true);
  return lines.join('\n') + '\n';
}
