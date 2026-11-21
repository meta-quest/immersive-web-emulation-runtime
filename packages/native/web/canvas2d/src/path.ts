/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Paths (C2D-6): the CanvasPath methods (HTML §4.12.5.1.10) recorded as a flat Float32Array of
 * move/line/quad/cubic/close commands (the format runtime/canvas2d consumes), arcs and ellipses converted to
 * cubic Béziers, plus Path2D with SVG path data (SVG 2 path grammar and the arc conversion in its
 * implementation notes).
 *
 * The context's current default path stores device-space points (each point is transformed by the CTM when it
 * is added, as HTML requires); a Path2D stores its own coordinates and is transformed when used.
 */

import { VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE, VERB_QUAD } from './natives.ts';
import { type Mat, mapX, mapY } from './matrix.ts';
import { domException } from './errors.ts';

const TAU = Math.PI * 2;

/** An affine transform applied to points as they are recorded, or null for identity. */
export class PathBuilder {
  buf = new Float32Array(64);
  len = 0;
  /** Last point and subpath start, in the builder's storage space. */
  lastX = 0;
  lastY = 0;
  startX = 0;
  startY = 0;
  /** True once the path has a subpath (HTML: "the path has no subpaths" otherwise). */
  hasSubpath = false;
  /** Transform applied to incoming points (the CTM for the default path). */
  m: Mat | null = null;

  clear(): void {
    this.len = 0;
    this.hasSubpath = false;
  }

  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Float32Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  private tx(x: number, y: number): number {
    return this.m ? mapX(this.m, x, y) : x;
  }
  private ty(x: number, y: number): number {
    return this.m ? mapY(this.m, x, y) : y;
  }

  /** Appends raw commands already in storage space. */
  appendRaw(src: Float32Array, n: number): void {
    this.reserve(n);
    this.buf.set(src.subarray(0, n), this.len);
    this.len += n;
  }

  rawMove(x: number, y: number): void {
    this.reserve(3);
    const b = this.buf;
    b[this.len++] = VERB_MOVE;
    b[this.len++] = x;
    b[this.len++] = y;
    this.lastX = this.startX = x;
    this.lastY = this.startY = y;
    this.hasSubpath = true;
  }
  rawLine(x: number, y: number): void {
    this.reserve(3);
    const b = this.buf;
    b[this.len++] = VERB_LINE;
    b[this.len++] = x;
    b[this.len++] = y;
    this.lastX = x;
    this.lastY = y;
  }
  rawCubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.reserve(7);
    const b = this.buf;
    b[this.len++] = VERB_CUBIC;
    b[this.len++] = x1;
    b[this.len++] = y1;
    b[this.len++] = x2;
    b[this.len++] = y2;
    b[this.len++] = x;
    b[this.len++] = y;
    this.lastX = x;
    this.lastY = y;
  }
  rawQuad(x1: number, y1: number, x: number, y: number): void {
    this.reserve(5);
    const b = this.buf;
    b[this.len++] = VERB_QUAD;
    b[this.len++] = x1;
    b[this.len++] = y1;
    b[this.len++] = x;
    b[this.len++] = y;
    this.lastX = x;
    this.lastY = y;
  }

  // --- CanvasPath (arguments in user space) --------------------------------------------------------

  moveTo(x: number, y: number): void {
    if (!fin2(x, y)) return;
    this.rawMove(this.tx(x, y), this.ty(x, y));
  }

  /** HTML "ensure there is a subpath for (x, y)". */
  private ensure(x: number, y: number): boolean {
    if (this.hasSubpath) return false;
    this.rawMove(this.tx(x, y), this.ty(x, y));
    return true;
  }

  lineTo(x: number, y: number): void {
    if (!fin2(x, y)) return;
    if (this.ensure(x, y)) return;
    this.rawLine(this.tx(x, y), this.ty(x, y));
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!fin4(cx, cy, x, y)) return;
    this.ensure(cx, cy);
    this.rawQuad(this.tx(cx, cy), this.ty(cx, cy), this.tx(x, y), this.ty(x, y));
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!fin4(c1x, c1y, c2x, c2y) || !fin2(x, y)) return;
    this.ensure(c1x, c1y);
    this.rawCubic(this.tx(c1x, c1y), this.ty(c1x, c1y), this.tx(c2x, c2y), this.ty(c2x, c2y), this.tx(x, y), this.ty(x, y));
  }

  /** A close inside copied commands: recorded without the implicit moveTo (the source carries its own). */
  closePathRaw(): void {
    this.reserve(1);
    this.buf[this.len++] = VERB_CLOSE;
    this.lastX = this.startX;
    this.lastY = this.startY;
  }

  closePath(): void {
    if (!this.hasSubpath) return;
    this.reserve(1);
    this.buf[this.len++] = VERB_CLOSE;
    this.lastX = this.startX;
    this.lastY = this.startY;
    // HTML: the new subpath starts at the closed subpath's first point.
    this.rawMove(this.startX, this.startY);
  }

  rect(x: number, y: number, w: number, h: number): void {
    if (!fin4(x, y, w, h)) return;
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  arc(x: number, y: number, r: number, start: number, end: number, ccw = false): void {
    this.ellipse(x, y, r, r, 0, start, end, ccw);
  }

  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, ccw = false): void {
    if (!fin4(x, y, rx, ry) || !fin2(rotation, start) || !fin1(end)) return;
    if (rx < 0 || ry < 0) throw domException('The radius provided is negative.', 'IndexSizeError');
    // The work happens in ellipseFromScratch, which takes its numbers from a module scratch array: this wrapper is
    // small enough to be inlined into callers, so no double is boxed at a call boundary (C2D-12).
    EA[0] = x;
    EA[1] = y;
    EA[2] = rx;
    EA[3] = ry;
    EA[4] = rotation;
    EA[5] = start;
    EA[6] = end;
    this.ellipseFromScratch(ccw);
  }

  private ellipseFromScratch(ccw: boolean): void {
    const x = EA[0]!;
    const y = EA[1]!;
    const rx = EA[2]!;
    const ry = EA[3]!;
    const rotation = EA[4]!;
    const start = EA[5]!;
    const end = EA[6]!;
    let sweep: number;
    if (!ccw) {
      if (end - start >= TAU) sweep = TAU;
      else {
        sweep = (end - start) % TAU;
        if (sweep < 0) sweep += TAU;
      }
    } else if (start - end >= TAU) {
      sweep = -TAU;
    } else {
      sweep = (end - start) % TAU;
      if (sweep > 0) sweep -= TAU;
    }
    // Points on the ellipse: unit-circle (u, v) -> (x + ax*u + bx*v, y + ay*u + by*v), then the builder's transform;
    // written straight into the buffer (no closures, tuples or double-argument calls per segment).
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    let ax = rx * cosR;
    let ay = rx * sinR;
    let bx = -ry * sinR;
    let by = ry * cosR;
    let ox = x;
    let oy = y;
    const m = this.m;
    if (m) {
      const m0 = m[0]!;
      const m1 = m[1]!;
      const m2 = m[2]!;
      const m3 = m[3]!;
      const nax = m0 * ax + m2 * ay;
      const nay = m1 * ax + m3 * ay;
      const nbx = m0 * bx + m2 * by;
      const nby = m1 * bx + m3 * by;
      const nox = m0 * x + m2 * y + m[4]!;
      const noy = m1 * x + m3 * y + m[5]!;
      ax = nax;
      ay = nay;
      bx = nbx;
      by = nby;
      ox = nox;
      oy = noy;
    }
    const segs = sweep === 0 ? 0 : Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    this.reserve(3 + 7 * segs);
    const buf = this.buf;
    let len = this.len;
    const c00 = Math.cos(start);
    const s00 = Math.sin(start);
    const sx = ox + ax * c00 + bx * s00;
    const sy = oy + ay * c00 + by * s00;
    if (this.hasSubpath) {
      buf[len++] = VERB_LINE;
    } else {
      buf[len++] = VERB_MOVE;
      this.startX = sx;
      this.startY = sy;
      this.hasSubpath = true;
    }
    buf[len++] = sx;
    buf[len++] = sy;
    let lx = sx;
    let ly = sy;
    if (segs > 0) {
      const step = sweep / segs;
      const k = (4 / 3) * Math.tan(step / 4);
      let a0 = start;
      let c0 = c00;
      let s0 = s00;
      for (let i = 0; i < segs; i++) {
        const a1 = i === segs - 1 ? start + sweep : a0 + step;
        const c1 = Math.cos(a1);
        const s1 = Math.sin(a1);
        const u1 = c0 - k * s0;
        const v1 = s0 + k * c0;
        const u2 = c1 + k * s1;
        const v2 = s1 - k * c1;
        buf[len++] = VERB_CUBIC;
        buf[len++] = ox + ax * u1 + bx * v1;
        buf[len++] = oy + ay * u1 + by * v1;
        buf[len++] = ox + ax * u2 + bx * v2;
        buf[len++] = oy + ay * u2 + by * v2;
        lx = ox + ax * c1 + bx * s1;
        ly = oy + ay * c1 + by * s1;
        buf[len++] = lx;
        buf[len++] = ly;
        a0 = a1;
        c0 = c1;
        s0 = s1;
      }
    }
    this.len = len;
    this.lastX = lx;
    this.lastY = ly;
  }

  /**
   * arcTo. `inv` maps the stored last point back to user space (the inverse CTM for the default path; null
   * when the stored space is user space).
   */
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number, inv: Mat | null): void {
    if (!fin4(x1, y1, x2, y2) || !fin1(r)) return;
    if (r < 0) throw domException('The radius provided is negative.', 'IndexSizeError');
    if (this.ensure(x1, y1)) {
      // The subpath only has (x1, y1) now; continue with the rules below from that point.
    }
    let x0 = this.lastX;
    let y0 = this.lastY;
    if (inv) {
      const ux = mapX(inv, x0, y0);
      y0 = mapY(inv, x0, y0);
      x0 = ux;
    }
    if ((x0 === x1 && y0 === y1) || (x1 === x2 && y1 === y2) || r === 0) {
      this.lineTo(x1, y1);
      return;
    }
    const d0x = x0 - x1;
    const d0y = y0 - y1;
    const d1x = x2 - x1;
    const d1y = y2 - y1;
    const cross = d0x * d1y - d0y * d1x;
    if (Math.abs(cross) < 1e-12 * Math.hypot(d0x, d0y) * Math.hypot(d1x, d1y)) {
      this.lineTo(x1, y1);
      return;
    }
    const l0 = Math.hypot(d0x, d0y);
    const l1 = Math.hypot(d1x, d1y);
    const u0x = d0x / l0;
    const u0y = d0y / l0;
    const u1x = d1x / l1;
    const u1y = d1y / l1;
    const cosT = u0x * u1x + u0y * u1y;
    const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
    const dist = r / Math.tan(theta / 2);
    const t0x = x1 + u0x * dist;
    const t0y = y1 + u0y * dist;
    const t1x = x1 + u1x * dist;
    const t1y = y1 + u1y * dist;
    // Centre lies along the bisector at r / sin(theta/2).
    const bx = u0x + u1x;
    const by = u0y + u1y;
    const bl = Math.hypot(bx, by);
    const cd = r / Math.sin(theta / 2);
    const cx = x1 + (bx / bl) * cd;
    const cy = y1 + (by / bl) * cd;
    const a0 = Math.atan2(t0y - cy, t0x - cx);
    const a1 = Math.atan2(t1y - cy, t1x - cx);
    // Sweep the short way round (the arc is always less than pi).
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= TAU;
    while (sweep < -Math.PI) sweep += TAU;
    this.lineTo(t0x, t0y);
    this.ellipse(cx, cy, r, r, 0, a0, a0 + sweep, sweep < 0);
  }

  roundRect(x: number, y: number, w: number, h: number, radii: unknown): void {
    if (!fin4(x, y, w, h)) return;
    // Same scheme as ellipse(): the numbers go through scratch, the body below takes none as arguments.
    EA[0] = x;
    EA[1] = y;
    EA[2] = w;
    EA[3] = h;
    this.roundRectFromScratch(radii);
  }

  private roundRectFromScratch(radii: unknown): void {
    let x = EA[0]!;
    let y = EA[1]!;
    let w = EA[2]!;
    let h = EA[3]!;
    // Radii into the module scratch R (x, y per given radius); numbers and arrays of numbers/points need no
    // temporary objects (C2D-12). Other iterables are copied first.
    let count = 0;
    if (radii === undefined) {
      if (!putRadius(0, 0)) return;
      count = 1;
    } else if (typeof radii === 'number' || (typeof radii === 'object' && radii !== null && !isIterable(radii))) {
      if (!putRadius(0, radii)) return;
      count = 1;
    } else if (isIterable(radii)) {
      const list = Array.isArray(radii) ? (radii as unknown[]) : Array.from(radii as Iterable<unknown>);
      count = list.length;
      if (count < 1 || count > 4) throw new RangeError(`roundRect: radii must have 1 to 4 elements, got ${count}`);
      for (let i = 0; i < count; i++) if (!putRadius(i, list[i])) return;
    } else {
      if (!putRadius(0, Number(radii))) return;
      count = 1;
    }
    // Corner order upper-left, upper-right, lower-right, lower-left (HTML roundRect step 6).
    let ul = 0;
    let ur = 0;
    let lr = 0;
    let ll = 0;
    if (count === 4) {
      ur = 1;
      lr = 2;
      ll = 3;
    } else if (count === 3) {
      ur = ll = 1;
      lr = 2;
    } else if (count === 2) {
      ur = ll = 1;
    }
    let ulx = R[2 * ul]!;
    let uly = R[2 * ul + 1]!;
    let urx = R[2 * ur]!;
    let ury = R[2 * ur + 1]!;
    let lrx = R[2 * lr]!;
    let lry = R[2 * lr + 1]!;
    let llx = R[2 * ll]!;
    let lly = R[2 * ll + 1]!;
    let t: number;
    // Negative width/height: mirror the corners (HTML roundRect steps 9-10).
    if (w < 0) {
      x += w;
      w = -w;
      t = ulx, ulx = urx, urx = t;
      t = uly, uly = ury, ury = t;
      t = llx, llx = lrx, lrx = t;
      t = lly, lly = lry, lry = t;
    }
    if (h < 0) {
      y += h;
      h = -h;
      t = ulx, ulx = llx, llx = t;
      t = uly, uly = lly, lly = t;
      t = urx, urx = lrx, lrx = t;
      t = ury, ury = lry, lry = t;
    }
    // Scale radii down so adjacent ones never overlap.
    const scale = Math.min(w / (ulx + urx), h / (uly + lly), w / (llx + lrx), h / (ury + lry));
    if (scale < 1) {
      ulx *= scale;
      uly *= scale;
      urx *= scale;
      ury *= scale;
      lrx *= scale;
      lry *= scale;
      llx *= scale;
      lly *= scale;
    }
    this.moveTo(x + ulx, y);
    this.lineTo(x + w - urx, y);
    if (urx > 0 || ury > 0) this.ellipse(x + w - urx, y + ury, urx, ury, 0, -Math.PI / 2, 0, false);
    this.lineTo(x + w, y + h - lry);
    if (lrx > 0 || lry > 0) this.ellipse(x + w - lrx, y + h - lry, lrx, lry, 0, 0, Math.PI / 2, false);
    this.lineTo(x + llx, y + h);
    if (llx > 0 || lly > 0) this.ellipse(x + llx, y + h - lly, llx, lly, 0, Math.PI / 2, Math.PI, false);
    this.lineTo(x, y + uly);
    if (ulx > 0 || uly > 0) this.ellipse(x + ulx, y + uly, ulx, uly, 0, Math.PI, (3 * Math.PI) / 2, false);
    this.closePath();
    this.moveTo(x, y);
  }
}

// Finiteness of numbers already converted with +x: x - x is 0 exactly for finite x (NaN for NaN and infinities).
// Arithmetic instead of Number.isFinite keeps doubles unboxed in every JIT tier (C2D-12).
function fin1(a: number): boolean {
  return a - a === 0;
}
function fin2(a: number, b: number): boolean {
  return a - a === 0 && b - b === 0;
}
function fin4(a: number, b: number, c: number, d: number): boolean {
  return a - a === 0 && b - b === 0 && c - c === 0 && d - d === 0;
}

/** roundRect radius scratch: x, y for up to four radii. */
const R = new Float64Array(8);
/** ellipse()/roundRect() argument scratch (see ellipse). */
const EA = new Float64Array(7);

/** Stores radius i (a number or a DOMPointInit) in R; false = non-finite (draw nothing). Throws for negatives. */
function putRadius(i: number, r: unknown): boolean {
  let rx: number;
  let ry: number;
  if (typeof r === 'object' && r !== null) {
    const p = r as { x?: unknown; y?: unknown };
    rx = p.x === undefined ? 0 : Number(p.x);
    ry = p.y === undefined ? 0 : Number(p.y);
  } else {
    rx = ry = Number(r);
  }
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return false;
  if (rx < 0 || ry < 0) throw new RangeError('roundRect: radius is negative');
  R[2 * i] = rx;
  R[2 * i + 1] = ry;
  return true;
}

function isIterable(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

const XS = new Float64Array(6);

/** Appends `src` (user-space commands) to `dst`, mapping every point by m (null = identity). */
export function appendTransformed(dst: PathBuilder, src: PathBuilder, m: Mat | null): void {
  const b = src.buf;
  let i = 0;
  const n = src.len;
  while (i < n) {
    const verb = b[i]!;
    const pts = verb === VERB_MOVE || verb === VERB_LINE ? 1 : verb === VERB_QUAD ? 2 : verb === VERB_CUBIC ? 3 : 0;
    if (pts === 0) {
      if (dst.hasSubpath) dst.closePathRaw();
      i++;
      continue;
    }
    for (let k = 0; k < pts; k++) {
      const x = b[i + 1 + 2 * k]!;
      const y = b[i + 2 + 2 * k]!;
      XS[2 * k] = m ? mapX(m, x, y) : x;
      XS[2 * k + 1] = m ? mapY(m, x, y) : y;
    }
    if (verb === VERB_MOVE) dst.rawMove(XS[0]!, XS[1]!);
    else if (verb === VERB_LINE) dst.rawLine(XS[0]!, XS[1]!);
    else if (verb === VERB_QUAD) dst.rawQuad(XS[0]!, XS[1]!, XS[2]!, XS[3]!);
    else dst.rawCubic(XS[0]!, XS[1]!, XS[2]!, XS[3]!, XS[4]!, XS[5]!);
    i += 1 + 2 * pts;
  }
}

// --- SVG path data ---------------------------------------------------------------------------------

/**
 * Parses SVG path data into `p` (user space). On the first error the rest is ignored and what was parsed so
 * far stays (SVG 2 error handling).
 */
export function parseSvgPath(d: string, p: PathBuilder): void {
  let i = 0;
  const n = d.length;
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const skipWs = () => {
    while (i < n && isWs(d[i]!)) i++;
  };
  const skipSep = () => {
    skipWs();
    if (i < n && d[i] === ',') {
      i++;
      skipWs();
    }
  };
  const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const num = (): number | null => {
    skipWs();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return null;
    i = NUM.lastIndex;
    const v = parseFloat(m[0]);
    skipSep();
    return Number.isFinite(v) ? v : null;
  };
  const flag = (): number | null => {
    skipWs();
    if (i < n && (d[i] === '0' || d[i] === '1')) {
      const v = d[i] === '1' ? 1 : 0;
      i++;
      skipSep();
      return v;
    }
    return null;
  };
  let cx = 0;
  let cy = 0; // current point
  let sx = 0;
  let sy = 0; // subpath start
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let lastCmd = '';
  let cmd = '';
  skipWs();
  while (i < n) {
    const c = d[i]!;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      cmd = c;
      i++;
      skipWs();
    } else if (cmd === '' || cmd === 'Z' || cmd === 'z') {
      return; // numbers without a command
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    if (lastCmd === '' && cmd !== 'M' && cmd !== 'm') return; // must start with moveto
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case 'Z':
        p.closePath();
        cx = sx;
        cy = sy;
        lastCmd = cmd;
        continue;
      case 'M': {
        const x = num();
        const y = num();
        if (x === null || y === null) return;
        cx = ox + x;
        cy = oy + y;
        sx = cx;
        sy = cy;
        p.moveTo(cx, cy);
        break;
      }
      case 'L': {
        const x = num();
        const y = num();
        if (x === null || y === null) return;
        cx = ox + x;
        cy = oy + y;
        p.lineTo(cx, cy);
        break;
      }
      case 'H': {
        const x = num();
        if (x === null) return;
        cx = ox + x;
        p.lineTo(cx, cy);
        break;
      }
      case 'V': {
        const y = num();
        if (y === null) return;
        cy = oy + y;
        p.lineTo(cx, cy);
        break;
      }
      case 'C': {
        const v = [num(), num(), num(), num(), num(), num()];
        if (v.some((t) => t === null)) return;
        const [x1, y1, x2, y2, x, y] = v as number[];
        p.bezierCurveTo(ox + x1!, oy + y1!, ox + x2!, oy + y2!, ox + x!, oy + y!);
        lastCtrlX = ox + x2!;
        lastCtrlY = oy + y2!;
        cx = ox + x!;
        cy = oy + y!;
        break;
      }
      case 'S': {
        const v = [num(), num(), num(), num()];
        if (v.some((t) => t === null)) return;
        const [x2, y2, x, y] = v as number[];
        const prev = lastCmd.toUpperCase();
        const x1 = prev === 'C' || prev === 'S' ? 2 * cx - lastCtrlX : cx;
        const y1 = prev === 'C' || prev === 'S' ? 2 * cy - lastCtrlY : cy;
        p.bezierCurveTo(x1, y1, ox + x2!, oy + y2!, ox + x!, oy + y!);
        lastCtrlX = ox + x2!;
        lastCtrlY = oy + y2!;
        cx = ox + x!;
        cy = oy + y!;
        break;
      }
      case 'Q': {
        const v = [num(), num(), num(), num()];
        if (v.some((t) => t === null)) return;
        const [x1, y1, x, y] = v as number[];
        p.quadraticCurveTo(ox + x1!, oy + y1!, ox + x!, oy + y!);
        lastCtrlX = ox + x1!;
        lastCtrlY = oy + y1!;
        cx = ox + x!;
        cy = oy + y!;
        break;
      }
      case 'T': {
        const v = [num(), num()];
        if (v.some((t) => t === null)) return;
        const [x, y] = v as number[];
        const prev = lastCmd.toUpperCase();
        const x1 = prev === 'Q' || prev === 'T' ? 2 * cx - lastCtrlX : cx;
        const y1 = prev === 'Q' || prev === 'T' ? 2 * cy - lastCtrlY : cy;
        p.quadraticCurveTo(x1, y1, ox + x!, oy + y!);
        lastCtrlX = x1;
        lastCtrlY = y1;
        cx = ox + x!;
        cy = oy + y!;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const x = num();
        const y = num();
        if (rx === null || ry === null || rot === null || large === null || sweep === null || x === null || y === null) return;
        svgArc(p, cx, cy, rx, ry, rot, large === 1, sweep === 1, ox + x, oy + y);
        cx = ox + x;
        cy = oy + y;
        break;
      }
      default:
        return;
    }
    lastCmd = cmd;
    skipWs();
  }
}

/** SVG elliptical arc (endpoint parameterization) -> centre parameterization -> ellipse(). */
function svgArc(
  p: PathBuilder,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): void {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    p.lineTo(x2, y2);
    return;
  }
  const phi = ((rotDeg % 360) * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= TAU;
  else if (sweep && dtheta < 0) dtheta += TAU;
  p.ellipse(cx, cy, rx, ry, phi, theta1, theta1 + dtheta, !sweep);
}
