/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A small TrueType reader and anti-aliased rasterizer, enough to draw one line
 * of an app name into the generated splash image (splash.ts) with the font the
 * template already ships (Roboto). Written from the OpenType specification
 * (table directory, head, hhea, hmtx, maxp, OS/2, loca, glyf simple and
 * composite glyphs, cmap formats 4 and 12). No hinting, no kerning, no shaping:
 * glyphs are placed by their advance widths, which is what a single Latin line
 * needs. The rasterizer computes exact signed-area coverage per pixel.
 */

export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontError';
  }
}

interface Point {
  x: number;
  y: number;
  on: boolean;
}

/** One glyph outline: contours of on/off-curve points, font units, y up. */
export type Contours = Point[][];

export interface TrueTypeFont {
  unitsPerEm: number;
  ascender: number;
  descender: number; // negative below the baseline
  capHeight: number;
  numGlyphs: number;
  /** Glyph id for a code point (0 = missing). */
  glyphId(codePoint: number): number;
  advance(glyph: number): number;
  outline(glyph: number): Contours;
}

export function parseTrueType(buf: Buffer): TrueTypeFont {
  if (buf.length < 12) throw new FontError('not a font file');
  const version = buf.readUInt32BE(0);
  if (version !== 0x00010000 && version !== 0x74727565)
    throw new FontError(
      'only TrueType outlines (glyf) are supported, not CFF or collections',
    );
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (o + 16 > buf.length) throw new FontError('truncated table directory');
    const offset = buf.readUInt32BE(o + 8);
    const length = buf.readUInt32BE(o + 12);
    if (offset + length > buf.length)
      throw new FontError('table outside the file');
    tables.set(buf.toString('latin1', o, o + 4), { offset, length });
  }
  const table = (tag: string) => {
    const t = tables.get(tag);
    if (!t) throw new FontError(`missing ${tag} table`);
    return t;
  };
  const head = table('head').offset;
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const longLoca = buf.readInt16BE(head + 50) === 1;
  const numGlyphs = buf.readUInt16BE(table('maxp').offset + 4);
  const hhea = table('hhea').offset;
  const ascender = buf.readInt16BE(hhea + 4);
  const descender = buf.readInt16BE(hhea + 6);
  const numberOfHMetrics = buf.readUInt16BE(hhea + 34);
  const hmtx = table('hmtx').offset;
  let capHeight = Math.round(ascender * 0.75);
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 90 && buf.readUInt16BE(os2.offset) >= 2)
    capHeight = buf.readInt16BE(os2.offset + 88);
  const loca = table('loca').offset;
  const glyf = table('glyf');

  const glyphRange = (g: number): [number, number] => {
    if (g < 0 || g >= numGlyphs) return [0, 0];
    const a = longLoca
      ? buf.readUInt32BE(loca + g * 4)
      : buf.readUInt16BE(loca + g * 2) * 2;
    const b = longLoca
      ? buf.readUInt32BE(loca + g * 4 + 4)
      : buf.readUInt16BE(loca + g * 2 + 2) * 2;
    if (b <= a || glyf.offset + b > glyf.offset + glyf.length) return [0, 0];
    return [glyf.offset + a, glyf.offset + b];
  };

  const cmapLookup = buildCmap(buf, table('cmap').offset);

  const outline = (g: number, depth = 0): Contours => {
    const [start, end] = glyphRange(g);
    if (end - start < 10 || depth > 8) return [];
    const n = buf.readInt16BE(start);
    if (n >= 0) return simpleGlyph(buf, start, end, n);
    return compositeGlyph(buf, start, end, (id) => outline(id, depth + 1));
  };

  return {
    unitsPerEm,
    ascender,
    descender,
    capHeight,
    numGlyphs,
    glyphId: cmapLookup,
    advance: (g) => {
      if (g < 0 || g >= numGlyphs) return 0;
      const i = Math.min(g, numberOfHMetrics - 1);
      return buf.readUInt16BE(hmtx + i * 4);
    },
    outline: (g) => outline(g),
  };
}

function buildCmap(buf: Buffer, cmap: number): (cp: number) => number {
  const n = buf.readUInt16BE(cmap + 2);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < n; i++) {
    const o = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(o);
    const encoding = buf.readUInt16BE(o + 2);
    const sub = cmap + buf.readUInt32BE(o + 4);
    const format = buf.readUInt16BE(sub);
    const unicode =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12 && format12 < 0) format12 = sub;
    if (format === 4 && format4 < 0) format4 = sub;
  }
  if (format12 >= 0) {
    const groups = buf.readUInt32BE(format12 + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const o = format12 + 16 + mid * 12;
        const startCode = buf.readUInt32BE(o);
        const endCode = buf.readUInt32BE(o + 4);
        if (cp < startCode) hi = mid - 1;
        else if (cp > endCode) lo = mid + 1;
        else return buf.readUInt32BE(o + 8) + (cp - startCode);
      }
      return 0;
    };
  }
  if (format4 >= 0) {
    const segX2 = buf.readUInt16BE(format4 + 6);
    const ends = format4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < segX2; i += 2) {
        const end = buf.readUInt16BE(ends + i);
        if (cp > end) continue;
        const start = buf.readUInt16BE(starts + i);
        if (cp < start) return 0;
        const delta = buf.readUInt16BE(deltas + i);
        const rangeOffset = buf.readUInt16BE(ranges + i);
        if (rangeOffset === 0) return (cp + delta) & 0xffff;
        const at = ranges + i + rangeOffset + (cp - start) * 2;
        if (at + 2 > buf.length) return 0;
        const g = buf.readUInt16BE(at);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
      return 0;
    };
  }
  throw new FontError('no Unicode cmap (format 4 or 12)');
}

function simpleGlyph(
  buf: Buffer,
  start: number,
  end: number,
  contours: number,
): Contours {
  let p = start + 10;
  const endPts: number[] = [];
  for (let i = 0; i < contours; i++, p += 2) endPts.push(buf.readUInt16BE(p));
  const points = contours ? endPts[contours - 1] + 1 : 0;
  const instructions = buf.readUInt16BE(p);
  p += 2 + instructions;
  const flags: number[] = [];
  while (flags.length < points) {
    if (p >= end) throw new FontError('truncated glyph flags');
    const f = buf[p++];
    flags.push(f);
    if (f & 8) {
      const repeat = buf[p++];
      for (let r = 0; r < repeat; r++) flags.push(f);
    }
  }
  const coords = (shortBit: number, sameBit: number): number[] => {
    const out: number[] = [];
    let v = 0;
    for (let i = 0; i < points; i++) {
      const f = flags[i];
      if (f & shortBit) {
        const d = buf[p++];
        v += f & sameBit ? d : -d;
      } else if (!(f & sameBit)) {
        v += buf.readInt16BE(p);
        p += 2;
      }
      out.push(v);
    }
    return out;
  };
  const xs = coords(2, 16);
  const ys = coords(4, 32);
  const out: Contours = [];
  let first = 0;
  for (const last of endPts) {
    const c: Point[] = [];
    for (let i = first; i <= last; i++)
      c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
    if (c.length > 0) out.push(c);
    first = last + 1;
  }
  return out;
}

function compositeGlyph(
  buf: Buffer,
  start: number,
  end: number,
  component: (glyph: number) => Contours,
): Contours {
  const out: Contours = [];
  let p = start + 10;
  for (;;) {
    if (p + 4 > end) break;
    const flags = buf.readUInt16BE(p);
    const glyph = buf.readUInt16BE(p + 2);
    p += 4;
    let dx = 0;
    let dy = 0;
    if (flags & 1) {
      dx = buf.readInt16BE(p);
      dy = buf.readInt16BE(p + 2);
      p += 4;
    } else {
      dx = buf.readInt8(p);
      dy = buf.readInt8(p + 1);
      p += 2;
    }
    if (!(flags & 2)) dx = dy = 0; // point-matched components: not used by the fonts we ship
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    const f2dot14 = (o: number) => buf.readInt16BE(o) / 16384;
    if (flags & 8) {
      a = d = f2dot14(p);
      p += 2;
    } else if (flags & 0x40) {
      a = f2dot14(p);
      d = f2dot14(p + 2);
      p += 4;
    } else if (flags & 0x80) {
      a = f2dot14(p);
      b = f2dot14(p + 2);
      c = f2dot14(p + 4);
      d = f2dot14(p + 6);
      p += 8;
    }
    for (const contour of component(glyph))
      out.push(
        contour.map((pt) => ({
          x: a * pt.x + c * pt.y + dx,
          y: b * pt.x + d * pt.y + dy,
          on: pt.on,
        })),
      );
    if (!(flags & 0x20)) break;
  }
  return out;
}

/** A coverage mask: one byte per pixel, 255 = fully inside. */
export interface CoverageMask {
  width: number;
  height: number;
  data: Uint8Array;
}

type Segment = [number, number, number, number];

/**
 * Flatten contours (font units, y up) to line segments in pixel space, with
 * `scale` pixels per font unit and the origin (baseline start) at (ox, oy),
 * y down.
 */
export function flatten(
  contours: Contours,
  scale: number,
  ox: number,
  oy: number,
  out: Segment[] = [],
): Segment[] {
  const tx = (x: number) => ox + x * scale;
  const ty = (y: number) => oy - y * scale;
  for (const contour of contours) {
    const n = contour.length;
    if (n < 2) continue;
    // Start at an on-curve point (or the midpoint of two off-curve points).
    let startIndex = contour.findIndex((pt) => pt.on);
    let start: { x: number; y: number };
    if (startIndex < 0) {
      start = {
        x: (contour[0].x + contour[1].x) / 2,
        y: (contour[0].y + contour[1].y) / 2,
      };
      startIndex = 0;
    } else {
      start = contour[startIndex];
    }
    let cx = tx(start.x);
    let cy = ty(start.y);
    const sx = cx;
    const sy = cy;
    let control: { x: number; y: number } | null = null;
    const lineTo = (x: number, y: number) => {
      out.push([cx, cy, x, y]);
      cx = x;
      cy = y;
    };
    const quadTo = (qx: number, qy: number, x: number, y: number) => {
      // Subdivide so the chord error stays under ~0.1 px.
      const dd = Math.abs(cx - 2 * qx + x) + Math.abs(cy - 2 * qy + y);
      const steps = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(dd * 2.5))));
      const x0 = cx;
      const y0 = cy;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const mt = 1 - t;
        lineTo(
          mt * mt * x0 + 2 * mt * t * qx + t * t * x,
          mt * mt * y0 + 2 * mt * t * qy + t * t * y,
        );
      }
    };
    for (let k = 1; k <= n; k++) {
      const pt = contour[(startIndex + k) % n];
      const px = tx(pt.x);
      const py = ty(pt.y);
      if (pt.on) {
        if (control) quadTo(control.x, control.y, px, py);
        else lineTo(px, py);
        control = null;
      } else if (control) {
        const mx = (control.x + px) / 2;
        const my = (control.y + py) / 2;
        quadTo(control.x, control.y, mx, my);
        control = { x: px, y: py };
      } else {
        control = { x: px, y: py };
      }
    }
    if (control) quadTo(control.x, control.y, sx, sy);
    else if (cx !== sx || cy !== sy) lineTo(sx, sy);
  }
  return out;
}

/**
 * Exact-area anti-aliased fill of closed polylines (non-zero for the
 * non-overlapping contours fonts use: |winding area| clamped to 1).
 */
export function rasterize(
  segments: Segment[],
  width: number,
  height: number,
): CoverageMask {
  const stride = width + 2;
  const acc = new Float32Array(stride * height);
  const add = (row: number, h: number, mid: number) => {
    // A piece of edge of signed height h whose mean x is `mid`, inside pixel column floor(mid) of this row: the part
    // of that pixel right of the edge is covered, and every pixel further right fully (prefix sums turn this into
    // coverage).
    const base = row * stride;
    if (mid < 0) {
      acc[base] += h;
      return;
    }
    if (mid >= width) return;
    const c = Math.floor(mid);
    const f = mid - c;
    acc[base + c] += h * (1 - f);
    acc[base + c + 1] += h * f;
  };
  for (const [x0, y0, x1, y1] of segments) {
    if (y0 === y1) continue;
    const dir = y1 > y0 ? 1 : -1;
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    const xAt = (y: number) => x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
    const r0 = Math.max(0, Math.floor(ya));
    const r1 = Math.min(height - 1, Math.ceil(yb) - 1);
    for (let r = r0; r <= r1; r++) {
      const top = Math.max(r, ya);
      const bot = Math.min(r + 1, yb);
      const dy = bot - top;
      if (dy <= 0) continue;
      const xa = xAt(top);
      const xb = xAt(bot);
      const lo = Math.min(xa, xb);
      const hi = Math.max(xa, xb);
      if (Math.floor(lo) === Math.floor(hi) || hi - lo < 1e-9) {
        add(r, dir * dy, (xa + xb) / 2);
        continue;
      }
      // Split at pixel column boundaries; each piece's height is its share of the x extent.
      let u = lo;
      while (u < hi) {
        const next = Math.min(hi, Math.floor(u) + 1);
        const share = (next - u) / (hi - lo);
        add(r, dir * dy * share, (u + next) / 2);
        u = next;
      }
    }
  }
  const data = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += acc[r * stride + x];
      const v = Math.min(1, Math.abs(sum));
      data[r * width + x] = Math.round(v * 255);
    }
  }
  return { width, height, data };
}

/** Code points of a string (surrogate pairs combined). */
export function codePoints(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0) ?? 0);
}

/** Width in pixels of `text` at `sizePx` (advance widths; no kerning). */
export function measureText(
  font: TrueTypeFont,
  text: string,
  sizePx: number,
): number {
  const scale = sizePx / font.unitsPerEm;
  let w = 0;
  for (const cp of codePoints(text))
    w += font.advance(font.glyphId(cp)) * scale;
  return w;
}

/** Code points the font has no glyph for (whitespace and controls excepted). */
export function missingGlyphs(font: TrueTypeFont, text: string): string[] {
  const missing = new Set<string>();
  for (const cp of codePoints(text)) {
    if (cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0)) continue;
    if (font.glyphId(cp) === 0) missing.add(String.fromCodePoint(cp));
  }
  return [...missing];
}

/**
 * Coverage of `text` drawn with its baseline at (x, baseline) in a mask of
 * width x height pixels.
 */
export function drawText(
  font: TrueTypeFont,
  text: string,
  sizePx: number,
  x: number,
  baseline: number,
  width: number,
  height: number,
): CoverageMask {
  const scale = sizePx / font.unitsPerEm;
  const segments: Segment[] = [];
  let pen = x;
  for (const cp of codePoints(text)) {
    const g = font.glyphId(cp);
    flatten(font.outline(g), scale, pen, baseline, segments);
    pen += font.advance(g) * scale;
  }
  return rasterize(segments, width, height);
}
