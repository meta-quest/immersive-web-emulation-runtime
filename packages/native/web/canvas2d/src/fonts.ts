/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Fonts for canvas text (C2D-9, C2D-10): FontFace and FontFaceSet (`document.fonts` / `self.fonts`) from CSS
 * Font Loading 3, and the CSS Fonts 4 §5.2 font matching that turns a parsed `font` value into the ordered
 * list of faces the native text engine shapes with (per-character fallback runs through that list, then the
 * system fallback chain natively).
 *
 * Family lookup order for each name in the font-family list: faces added to the FontFaceSet (loaded) ->
 * runtime-bundled faces (Roboto, Roboto Mono) by their family name -> system families (Android fonts.xml
 * names and aliases). Generic families map to the bundled faces (sans-serif, system-ui, monospace) or the
 * system family of that name (serif, cursive, ...), falling back to the bundled sans-serif. Unknown names are
 * skipped; if nothing matches, the bundled sans-serif is used.
 */

import { domException } from './errors.ts';
import { DEFAULT_FONT_SIZE, parseFont, type ParsedFont } from './font.ts';
import type { Canvas2DNatives, NativeFace, NativeFont } from './natives.ts';

interface FaceEntry {
  face: NativeFace;
  family: string;
  weightMin: number;
  weightMax: number;
  italic: boolean;
  oblique: boolean;
  stretch: number;
}

type FontFaceStatus = 'unloaded' | 'loading' | 'loaded' | 'error';
type BinaryData = ArrayBuffer | ArrayBufferView;

export interface FontFaceDescriptors {
  style?: string;
  weight?: string;
  stretch?: string;
  unicodeRange?: string;
  variant?: string;
  featureSettings?: string;
  variationSettings?: string;
  display?: string;
  ascentOverride?: string;
  descentOverride?: string;
  lineGapOverride?: string;
}

const STRETCH_KEYWORDS: Record<string, number> = {
  'ultra-condensed': 50,
  'extra-condensed': 62.5,
  condensed: 75,
  'semi-condensed': 87.5,
  normal: 100,
  'semi-expanded': 112.5,
  expanded: 125,
  'extra-expanded': 150,
  'ultra-expanded': 200,
};

/** Per-realm runtime (set by installCanvas2D). FontFace needs the natives to parse font data. */
export interface FontRuntime {
  natives: Canvas2DNatives;
  manager: FontManager;
  fetch?: (
    url: string,
  ) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
}
let runtime: FontRuntime | null = null;
export function setFontRuntime(r: FontRuntime | null): void {
  runtime = r;
}
export function getFontRuntime(): FontRuntime | null {
  return runtime;
}

function parseWeightRange(v: string): [number, number] | null {
  const parts = v.trim().toLowerCase().split(/\s+/);
  const one = (p: string): number | null => {
    if (p === 'normal') return 400;
    if (p === 'bold') return 700;
    const n = Number(p);
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : null;
  };
  if (parts.length === 1) {
    const w = one(parts[0]!);
    return w === null ? null : [w, w];
  }
  if (parts.length === 2) {
    const a = one(parts[0]!);
    const b = one(parts[1]!);
    if (a === null || b === null) return null;
    return a <= b ? [a, b] : [b, a];
  }
  return null;
}

function parseStretch(v: string): number | null {
  const s = v.trim().toLowerCase().split(/\s+/)[0]!;
  if (s in STRETCH_KEYWORDS) return STRETCH_KEYWORDS[s]!;
  const m = /^(\d+(?:\.\d+)?)%$/.exec(s);
  return m ? parseFloat(m[1]!) : null;
}

function toBytes(src: BinaryData): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}

const listenerSupport: { Event?: new (type: string) => object } =
  globalThis as never;

/** Minimal EventTarget behaviour (the web glue's EventTarget is not a dependency of this module). */
class SimpleEvents {
  #listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, cb: ((e: unknown) => void) | null): void {
    if (!cb) return;
    let s = this.#listeners.get(type);
    if (!s) this.#listeners.set(type, (s = new Set()));
    s.add(cb);
  }
  removeEventListener(type: string, cb: ((e: unknown) => void) | null): void {
    if (cb) this.#listeners.get(type)?.delete(cb);
  }
  dispatchEvent(event: { type: string }): boolean {
    const handler = (this as unknown as Record<string, unknown>)[
      `on${event.type}`
    ];
    if (typeof handler === 'function')
      (handler as (e: unknown) => void).call(this, event);
    for (const cb of this.#listeners.get(event.type) ?? [])
      cb.call(this, event);
    return true;
  }
  protected fire(type: string, extra: Record<string, unknown> = {}): void {
    const E = listenerSupport.Event;
    let ev: { type: string };
    try {
      ev = E ? (new E(type) as { type: string }) : { type };
    } catch {
      ev = { type };
    }
    for (const [k, v] of Object.entries(extra)) {
      try {
        Object.defineProperty(ev, k, { value: v, enumerable: true });
      } catch {
        // ignore
      }
    }
    this.dispatchEvent(ev);
  }
}

export class FontFace {
  family: string;
  style: string;
  weight: string;
  stretch: string;
  unicodeRange: string;
  variant: string;
  featureSettings: string;
  variationSettings: string;
  display: string;
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
  #status: FontFaceStatus = 'unloaded';
  #source: string | Uint8Array;
  #loaded: Promise<FontFace>;
  #resolve!: (f: FontFace) => void;
  #reject!: (e: unknown) => void;
  /** @internal native face once loaded */
  _face: NativeFace | null = null;
  /** @internal sets notified on status changes */
  _sets = new Set<FontFaceSet>();

  constructor(
    family: string,
    source: string | BinaryData,
    descriptors: FontFaceDescriptors = {},
  ) {
    this.family = String(family).replace(/^["']|["']$/g, '');
    this.style = descriptors.style ?? 'normal';
    this.weight = descriptors.weight ?? 'normal';
    this.stretch = descriptors.stretch ?? 'normal';
    this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
    this.variant = descriptors.variant ?? 'normal';
    this.featureSettings = descriptors.featureSettings ?? 'normal';
    this.variationSettings = descriptors.variationSettings ?? 'normal';
    this.display = descriptors.display ?? 'auto';
    this.ascentOverride = descriptors.ascentOverride ?? 'normal';
    this.descentOverride = descriptors.descentOverride ?? 'normal';
    this.lineGapOverride = descriptors.lineGapOverride ?? 'normal';
    this.#loaded = new Promise<FontFace>((res, rej) => {
      this.#resolve = res;
      this.#reject = rej;
    });
    this.#loaded.catch(() => {});
    if (typeof source === 'string') {
      this.#source = source;
    } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      this.#source = toBytes(source).slice();
      // Binary sources load immediately (CSS Font Loading: "if source is a BinaryData").
      this.#status = 'loading';
      this.#finishBinary(this.#source);
    } else {
      this.#source = String(source);
    }
    if (parseWeightRange(this.weight) === null)
      this.#fail(
        domException(
          `Invalid weight descriptor "${this.weight}"`,
          'SyntaxError',
        ),
      );
  }

  get status(): FontFaceStatus {
    return this.#status;
  }
  get loaded(): Promise<FontFace> {
    return this.#loaded;
  }

  #fail(err: unknown): void {
    this.#status = 'error';
    this.#reject(err);
    for (const s of this._sets) s._changed();
  }

  #finishBinary(bytes: Uint8Array): void {
    const rt = runtime;
    if (!rt) {
      this.#fail(
        domException(
          'Canvas 2D natives are not installed.',
          'NotSupportedError',
        ),
      );
      return;
    }
    const r = rt.natives.loadFace(bytes, 0);
    if (typeof r === 'string') {
      this.#fail(
        domException(`Font data could not be parsed: ${r}`, 'SyntaxError'),
      );
      return;
    }
    this._face = r;
    this.#status = 'loaded';
    this.#resolve(this);
    rt.manager.bump();
    for (const s of this._sets) s._changed();
  }

  load(): Promise<FontFace> {
    if (this.#status !== 'unloaded') return this.#loaded;
    this.#status = 'loading';
    for (const s of this._sets) s._changed();
    const src = this.#source as string;
    void this.#loadFromSrc(src);
    return this.#loaded;
  }

  async #loadFromSrc(src: string): Promise<void> {
    const rt = runtime;
    if (!rt) {
      this.#fail(
        domException(
          'Canvas 2D natives are not installed.',
          'NotSupportedError',
        ),
      );
      return;
    }
    const entries = parseSrc(src);
    if (!entries) {
      this.#fail(domException(`Invalid font source "${src}"`, 'SyntaxError'));
      return;
    }
    let lastError = '';
    for (const e of entries) {
      try {
        if (e.kind === 'local') {
          const face = rt.manager.systemFaceByName(e.value);
          if (face) {
            this._face = face;
            break;
          }
          continue;
        }
        const f =
          rt.fetch ?? (globalThis as { fetch?: FontRuntime['fetch'] }).fetch;
        if (!f) {
          lastError = 'fetch is not available';
          continue;
        }
        // Relative URLs resolve against the document (CSS Font Loading: the FontFace's base URL).
        let url = e.value;
        const base = (globalThis as { location?: { href?: string } }).location
          ?.href;
        try {
          if (base) url = new URL(e.value, base).href;
        } catch {
          // keep as written
        }
        const resp = await f(url);
        if (!resp.ok) {
          lastError = `HTTP ${(resp as { status?: number }).status ?? '?'} for ${url}`;
          continue;
        }
        const buf = await resp.arrayBuffer();
        const r = rt.natives.loadFace(new Uint8Array(buf), 0);
        if (typeof r !== 'string') {
          this._face = r;
          break;
        }
        lastError = r;
      } catch (err) {
        lastError = String(err); // try the next source
      }
    }
    if (!this._face) {
      this.#fail(
        domException(
          `Failed to load font "${this.family}" from ${src}${lastError ? ` (${lastError})` : ''}`,
          'NetworkError',
        ),
      );
      return;
    }
    this.#status = 'loaded';
    this.#resolve(this);
    rt.manager.bump();
    for (const s of this._sets) s._changed();
  }

  /** @internal descriptor values for matching */
  _entry(): FaceEntry | null {
    if (!this._face) return null;
    const w = parseWeightRange(this.weight) ?? [400, 400];
    const st = this.style.trim().toLowerCase();
    return {
      face: this._face,
      family: this.family,
      weightMin: w[0],
      weightMax: w[1],
      italic: st === 'italic',
      oblique: st.startsWith('oblique'),
      stretch: parseStretch(this.stretch) ?? 100,
    };
  }
}

function parseSrc(
  src: string,
): { kind: 'url' | 'local'; value: string }[] | null {
  const out: { kind: 'url' | 'local'; value: string }[] = [];
  const re =
    /\s*(url|local)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)(?:\s*(?:format|tech)\([^)]*\))*\s*(,|$)/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src)) !== null) {
    out.push({
      kind: m[1] === 'url' ? 'url' : 'local',
      value: (m[2] ?? m[3] ?? m[4] ?? '').trim(),
    });
    last = re.lastIndex;
    if (m[5] === '') break;
  }
  if (out.length === 0 || src.slice(last).trim() !== '') return null;
  return out;
}

export class FontFaceSet extends SimpleEvents {
  #faces = new Set<FontFace>();
  #readyResolve: ((s: FontFaceSet) => void) | null = null;
  #ready: Promise<FontFaceSet>;
  onloading: ((e: unknown) => void) | null = null;
  onloadingdone: ((e: unknown) => void) | null = null;
  onloadingerror: ((e: unknown) => void) | null = null;
  #wasLoading = false;

  constructor(initialFaces: Iterable<FontFace> = []) {
    super();
    this.#ready = Promise.resolve(this);
    for (const f of initialFaces) this.add(f);
  }

  get size(): number {
    return this.#faces.size;
  }
  get status(): 'loading' | 'loaded' {
    for (const f of this.#faces) if (f.status === 'loading') return 'loading';
    return 'loaded';
  }
  get ready(): Promise<FontFaceSet> {
    return this.#ready;
  }

  add(face: FontFace): this {
    if (!(face instanceof FontFace))
      throw new TypeError(
        "Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.",
      );
    if (this.#faces.has(face)) return this;
    this.#faces.add(face);
    face._sets.add(this);
    runtime?.manager.bump();
    this._changed();
    return this;
  }
  delete(face: FontFace): boolean {
    const had = this.#faces.delete(face);
    if (had) {
      face._sets.delete(this);
      runtime?.manager.bump();
      this._changed();
    }
    return had;
  }
  clear(): void {
    for (const f of this.#faces) f._sets.delete(this);
    this.#faces.clear();
    runtime?.manager.bump();
    this._changed();
  }
  has(face: FontFace): boolean {
    return this.#faces.has(face);
  }
  forEach(
    cb: (face: FontFace, face2: FontFace, set: FontFaceSet) => void,
    thisArg?: unknown,
  ): void {
    for (const f of [...this.#faces]) cb.call(thisArg, f, f, this);
  }
  values(): IterableIterator<FontFace> {
    return this.#faces.values();
  }
  keys(): IterableIterator<FontFace> {
    return this.#faces.values();
  }
  entries(): IterableIterator<[FontFace, FontFace]> {
    return this.#faces.entries();
  }
  [Symbol.iterator](): IterableIterator<FontFace> {
    return this.#faces.values();
  }

  /** @internal */
  _all(): FontFace[] {
    return [...this.#faces];
  }

  /** @internal status bookkeeping: ready promise and loading events. */
  _changed(): void {
    const loading = this.status === 'loading';
    if (loading && !this.#wasLoading) {
      this.#wasLoading = true;
      this.#ready = new Promise((res) => (this.#readyResolve = res));
      this.fire('loading');
    } else if (!loading && this.#wasLoading) {
      this.#wasLoading = false;
      const res = this.#readyResolve;
      this.#readyResolve = null;
      const failed = [...this.#faces].filter((f) => f.status === 'error');
      this.fire('loadingdone', {
        fontfaces: [...this.#faces].filter((f) => f.status === 'loaded'),
      });
      if (failed.length) this.fire('loadingerror', { fontfaces: failed });
      res?.(this);
    }
  }

  #matching(font: string): FontFace[] {
    const p = parseFont(font, DEFAULT_FONT_SIZE);
    if (!p) throw domException(`Could not parse font "${font}"`, 'SyntaxError');
    const names = new Set(
      p.families.filter((_, i) => !p.generic[i]).map((f) => f.toLowerCase()),
    );
    return [...this.#faces].filter((f) => names.has(f.family.toLowerCase()));
  }

  check(font: string, _text = ' '): boolean {
    return this.#matching(font).every(
      (f) => f.status === 'loaded' || f.status === 'error',
    );
  }

  load(font: string, _text = ' '): Promise<FontFace[]> {
    let faces: FontFace[];
    try {
      faces = this.#matching(font);
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.all(faces.map((f) => f.load()));
  }
}

// --- Matching --------------------------------------------------------------------------------------

function pickStretch(cands: FaceEntry[], want: number): FaceEntry[] {
  const values = [...new Set(cands.map((c) => c.stretch))];
  if (values.includes(want)) return cands.filter((c) => c.stretch === want);
  const narrower = values.filter((v) => v < want).sort((a, b) => b - a);
  const wider = values.filter((v) => v > want).sort((a, b) => a - b);
  const order = want <= 100 ? [...narrower, ...wider] : [...wider, ...narrower];
  return cands.filter((c) => c.stretch === order[0]);
}

function pickStyle(cands: FaceEntry[], style: string): FaceEntry[] {
  const kind = (c: FaceEntry) =>
    c.italic ? 'italic' : c.oblique ? 'oblique' : 'normal';
  const order =
    style === 'italic'
      ? ['italic', 'oblique', 'normal']
      : style === 'oblique'
        ? ['oblique', 'italic', 'normal']
        : ['normal', 'oblique', 'italic'];
  for (const k of order) {
    const m = cands.filter((c) => kind(c) === k);
    if (m.length) return m;
  }
  return cands;
}

function pickWeight(cands: FaceEntry[], w: number): FaceEntry {
  const exact = cands.find((c) => c.weightMin <= w && w <= c.weightMax);
  if (exact) return exact;
  const dist = (c: FaceEntry): number => {
    // CSS Fonts 4 weight matching, expressed as a sort key (smaller is better).
    const lo = c.weightMin;
    const hi = c.weightMax;
    if (w >= 400 && w <= 500) {
      if (lo > w && lo <= 500) return lo - w;
      if (hi < w) return 1000 + (w - hi);
      return 2000 + (lo - w);
    }
    if (w < 400) {
      if (hi < w) return w - hi;
      return 1000 + (lo - w);
    }
    if (lo > w) return lo - w;
    return 1000 + (w - hi);
  };
  return cands.slice().sort((a, b) => dist(a) - dist(b))[0]!;
}

export function matchFace(
  cands: FaceEntry[],
  p: { style: string; weight: number; stretchPercent: number },
): FaceEntry {
  return pickWeight(
    pickStyle(pickStretch(cands, p.stretchPercent), p.style),
    p.weight,
  );
}

const SANS_GENERICS = new Set([
  'sans-serif',
  'system-ui',
  'ui-sans-serif',
  'ui-rounded',
]);
const MONO_GENERICS = new Set(['monospace', 'ui-monospace']);

export interface FontOptions {
  kerning: boolean;
  smallCaps: boolean;
  letterSpacing: number;
  wordSpacing: number;
  stretchPercent?: number;
}

interface FastEntry {
  kerning: boolean;
  smallCaps: boolean;
  letterSpacing: number;
  wordSpacing: number;
  stretch: number;
  font: NativeFont;
}

export class FontManager {
  #n: Canvas2DNatives;
  #version = 0;
  #defaults: Map<string, FaceEntry[]> | null = null;
  #system: Map<
    string,
    { path: string; weight: number; italic: boolean; index: number }[]
  > | null = null;
  #opened = new Map<string, FaceEntry | null>();
  #openedFiles = new Map<string, NativeFace | null>();
  #cache = new Map<string, NativeFont>();
  /** Per parsed font (parsed fonts are shared through the context's font-string cache): resolved fonts by options. */
  #fast = new WeakMap<ParsedFont, FastEntry[]>();
  #sets: FontFaceSet[] = [];
  language: string;

  constructor(n: Canvas2DNatives, language = 'en') {
    this.#n = n;
    this.language = language;
  }

  addSet(s: FontFaceSet): void {
    this.#sets.push(s);
  }

  bump(): void {
    this.#version++;
    this.#cache.clear();
    this.#fast = new WeakMap();
  }

  /** Changes whenever the available faces change (contexts cache resolved fonts against it). */
  get version(): number {
    return this.#version;
  }

  #entryFor(face: NativeFace): FaceEntry {
    const info = this.#n.faceInfo(face);
    const st = info.style.toLowerCase();
    return {
      face,
      family: info.family,
      weightMin: info.weightMin,
      weightMax: info.weightMax,
      italic: info.italic && !st.includes('oblique'),
      oblique: st.includes('oblique'),
      stretch: info.stretch,
    };
  }

  #defaultsMap(): Map<string, FaceEntry[]> {
    if (this.#defaults) return this.#defaults;
    const m = new Map<string, FaceEntry[]>();
    for (const [generic, face] of this.#n.defaultFaces()) {
      const e = this.#entryFor(face);
      for (const key of [generic, e.family.toLowerCase()]) {
        const list = m.get(key) ?? [];
        list.push(e);
        m.set(key, list);
      }
    }
    this.#defaults = m;
    return m;
  }

  #systemMap(): Map<
    string,
    { path: string; weight: number; italic: boolean; index: number }[]
  > {
    if (this.#system) return this.#system;
    const m = new Map<
      string,
      { path: string; weight: number; italic: boolean; index: number }[]
    >();
    try {
      for (const fam of this.#n.systemFamilies()) {
        const key = fam.name.toLowerCase();
        m.set(key, [...(m.get(key) ?? []), ...fam.fonts]);
      }
    } catch {
      // no system fonts (host tests)
    }
    this.#system = m;
    return m;
  }

  #openSystem(name: string): FaceEntry[] {
    const fonts = this.#systemMap().get(name.toLowerCase());
    if (!fonts) return [];
    const out: FaceEntry[] = [];
    for (const f of fonts) {
      // One entry per fonts.xml <font> (weight, style), sharing the native face of its file: a variable system font
      // listed at several weights (wght axis values) is instantiated at each listed weight instead of the first
      // entry's weight plus synthetic bold.
      const key = `${f.path}#${f.index}#${f.weight}#${f.italic ? 1 : 0}`;
      let e = this.#opened.get(key);
      if (e === undefined) {
        const fileKey = `${f.path}#${f.index}`;
        let face = this.#openedFiles.get(fileKey);
        if (face === undefined) {
          face = this.#n.loadFaceFile(f.path, f.index);
          this.#openedFiles.set(fileKey, face);
        }
        e = face
          ? {
              ...this.#entryFor(face),
              weightMin: f.weight,
              weightMax: f.weight,
              italic: f.italic,
            }
          : null;
        this.#opened.set(key, e);
      }
      if (e) out.push(e);
    }
    return out;
  }

  systemFaceByName(name: string): NativeFace | null {
    const list = this.#openSystem(name);
    return list.length ? list[0]!.face : null;
  }

  #candidates(name: string, generic: boolean): FaceEntry[] {
    const low = name.toLowerCase();
    if (!generic) {
      const fromSets: FaceEntry[] = [];
      for (const s of this.#sets) {
        for (const f of s._all()) {
          if (f.family.toLowerCase() !== low) continue;
          if (f.status === 'unloaded') void f.load();
          const e = f._entry();
          if (e) fromSets.push(e);
        }
      }
      if (fromSets.length) return fromSets;
      const def = this.#defaultsMap().get(low);
      if (def && !SANS_GENERICS.has(low) && !MONO_GENERICS.has(low)) return def;
      return this.#openSystem(low);
    }
    const defaults = this.#defaultsMap();
    if (SANS_GENERICS.has(low))
      return defaults.get('sans-serif') ?? this.#openSystem('sans-serif');
    if (MONO_GENERICS.has(low))
      return defaults.get('monospace') ?? this.#openSystem('monospace');
    const sys = this.#openSystem(low === 'ui-serif' ? 'serif' : low);
    if (sys.length) return sys;
    return defaults.get('sans-serif') ?? [];
  }

  /**
   * resolve() for the hot path (fillText / measureText after a font switch): positional options and a lookup keyed by
   * the parsed font object, so a cached font is found without building a key string or an options object (C2D-12).
   */
  resolveFast(
    p: ParsedFont,
    kerning: boolean,
    smallCaps: boolean,
    letterSpacing: number,
    wordSpacing: number,
    stretch: number,
  ): NativeFont {
    let list = this.#fast.get(p);
    if (list !== undefined) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        if (
          e.kerning === kerning &&
          e.smallCaps === smallCaps &&
          e.letterSpacing === letterSpacing &&
          e.wordSpacing === wordSpacing &&
          e.stretch === stretch
        ) {
          return e.font;
        }
      }
    } else {
      list = [];
      this.#fast.set(p, list);
    }
    const font = this.resolve(p, {
      kerning,
      smallCaps,
      letterSpacing,
      wordSpacing,
      stretchPercent: stretch,
    });
    if (list.length >= 16) list.length = 0;
    list.push({
      kerning,
      smallCaps,
      letterSpacing,
      wordSpacing,
      stretch,
      font,
    });
    return font;
  }

  /** The native font for a parsed `font` and the text options. Cached until the font set changes. */
  resolve(p: ParsedFont, opts: FontOptions): NativeFont {
    const stretch = opts.stretchPercent ?? p.stretchPercent;
    const key = `${p.style}|${p.weight}|${stretch}|${p.sizePx}|${p.families.join(',')}|${p.generic.join('')}|${opts.kerning}|${opts.smallCaps || p.smallCaps}|${opts.letterSpacing}|${opts.wordSpacing}`;
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const faces: NativeFace[] = [];
    const synth: number[] = [];
    const want = { style: p.style, weight: p.weight, stretchPercent: stretch };
    const add = (cands: FaceEntry[]) => {
      if (!cands.length) return;
      const e = matchFace(cands, want);
      if (faces.includes(e.face)) return;
      faces.push(e.face);
      let s = 0;
      if (p.weight >= 600 && e.weightMax < 600) s |= 1;
      if (p.style !== 'normal' && !e.italic && !e.oblique) s |= 2;
      // The face's weight range (FontFace descriptor, fonts.xml weight or the font's own axis): a variable face is
      // instantiated at the requested weight clamped to it (natives.ts createFont).
      const lo = Math.min(1000, Math.max(1, Math.round(e.weightMin)));
      const hi = Math.min(1000, Math.max(lo, Math.round(e.weightMax)));
      s |= (lo << 8) | (hi << 18);
      synth.push(s);
    };
    p.families.forEach((name, i) => add(this.#candidates(name, p.generic[i]!)));
    if (!faces.length) add(this.#candidates('sans-serif', true));
    const font = this.#n.createFont(
      faces,
      synth,
      p.sizePx,
      p.weight,
      p.style !== 'normal',
      opts.smallCaps || p.smallCaps,
      opts.kerning,
      opts.letterSpacing,
      opts.wordSpacing,
      this.language,
    );
    if (this.#cache.size > 128) this.#cache.clear();
    this.#cache.set(key, font);
    return font;
  }
}
