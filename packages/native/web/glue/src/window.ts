/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Window-level glue: matchMedia (CSSOM View §4.2 + Media Queries 4/5 features, evaluated against the
// fixed window of DOM-3), `location` (HTML §7.2.4, DOM-5) and `history` (HTML §7.2.2, same-document
// entries only). There is one document and no navigation: a same-origin navigation to another
// document asks the host to reload with the new URL (PROC-8); cross-origin navigation logs and is
// ignored.

import { domException } from './dom-exception.ts';
import {
  defineEventHandler,
  dispatchTrusted,
  Event,
  type EventInit,
  EventTarget,
} from './events.ts';
import { enumerable, illegalConstructor, INTERNAL, setLength, tag, toDOMString } from './util.ts';

// ---------------------------------------------------------------------------------------------------
// matchMedia

export interface MediaEnv {
  width(): number;
  height(): number;
  dpr(): number;
}

const PX_PER: Record<string, number> = {
  px: 1,
  em: 16,
  rem: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

function parseLength(v: string): number | null {
  const m = /^(-?[\d.]+(?:e[+-]?\d+)?)([a-z]*)$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === '') return n === 0 ? 0 : null;
  const f = PX_PER[m[2]!];
  return f === undefined ? null : n * f;
}

function parseResolution(v: string): number | null {
  const m = /^([\d.]+)(dppx|x|dpi|dpcm)$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'dppx':
    case 'x':
      return n;
    case 'dpi':
      return n / 96;
    case 'dpcm':
      return (n * 2.54) / 96;
  }
  return null;
}

function parseRatio(v: string): number | null {
  const m = /^([\d.]+)\s*(?:\/\s*([\d.]+))?$/.exec(v);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? 1 : Number(m[2]);
  return b === 0 ? Infinity : a / b;
}

const DISCRETE: Record<string, string> = {
  'prefers-color-scheme': 'dark',
  'prefers-reduced-motion': 'no-preference',
  'prefers-reduced-transparency': 'no-preference',
  'prefers-reduced-data': 'no-preference',
  'prefers-contrast': 'no-preference',
  'forced-colors': 'none',
  'inverted-colors': 'none',
  pointer: 'fine',
  'any-pointer': 'fine',
  hover: 'hover',
  'any-hover': 'hover',
  'display-mode': 'fullscreen',
  scripting: 'enabled',
  update: 'fast',
  'dynamic-range': 'standard',
  'video-dynamic-range': 'standard',
  'color-gamut': 'srgb',
};

/** Range-capable features: their current value and how to parse a value written for them. */
function rangeFeature(name: string, env: MediaEnv): { actual: number; parse: (v: string) => number | null } | null {
  const int = (v: string): number | null => (/^\d+$/.test(v) ? Number(v) : null);
  switch (name) {
    case 'width':
    case 'device-width':
      return { actual: env.width(), parse: parseLength };
    case 'height':
    case 'device-height':
      return { actual: env.height(), parse: parseLength };
    case 'aspect-ratio':
    case 'device-aspect-ratio':
      return { actual: env.width() / env.height(), parse: parseRatio };
    case 'resolution':
      return { actual: env.dpr(), parse: parseResolution };
    case 'color':
      return { actual: 8, parse: int };
    case 'color-index':
    case 'monochrome':
      return { actual: 0, parse: int };
  }
  return null;
}

const RANGE_RE = /^([^<>=]+?)\s*(<=|>=|<|>|=)\s*([^<>=]+?)(?:\s*(<=|>=|<|>)\s*([^<>=]+?))?$/;
const compare = (a: number, op: string, b: number): boolean => {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b + 1e-9;
    case '>':
      return a > b;
    case '>=':
      return a >= b - 1e-9;
    default:
      return Math.abs(a - b) < 1e-9;
  }
};

/** Media Queries 4 range syntax: `(width >= 600px)`, `(600px <= width)`, `(400px < width <= 2000px)`. */
function evalRange(text: string, env: MediaEnv): boolean | null {
  const m = RANGE_RE.exec(text);
  if (!m) return null;
  const [, a, op1, b, op2, c] = m as unknown as [string, string, string, string, string | undefined, string | undefined];
  if (op2 !== undefined) {
    // value op name op value: both operators must point the same way.
    const lt = (o: string): boolean => o === '<' || o === '<=';
    if (op1 === '=' || lt(op1) !== lt(op2)) return null;
    const f = rangeFeature(b.trim(), env);
    if (!f) return null;
    const lo = f.parse(a.trim());
    const hi = f.parse(c!.trim());
    if (lo === null || hi === null) return null;
    return compare(lo, op1, f.actual) && compare(f.actual, op2, hi);
  }
  const left = rangeFeature(a.trim(), env);
  if (left) {
    const v = left.parse(b.trim());
    return v === null ? null : compare(left.actual, op1, v);
  }
  const right = rangeFeature(b.trim(), env);
  if (right) {
    const v = right.parse(a.trim());
    return v === null ? null : compare(v, op1, right.actual);
  }
  return null;
}

/** Evaluates one `(feature[: value])` or range; returns null for unknown or malformed features. */
function evalFeature(text: string, env: MediaEnv): boolean | null {
  if (/[<>=]/.test(text)) return evalRange(text, env);
  const colon = text.indexOf(':');
  const rawName = (colon < 0 ? text : text.slice(0, colon)).trim();
  const value = colon < 0 ? null : text.slice(colon + 1).trim();
  let prefix: '' | 'min' | 'max' = '';
  let name = rawName;
  const webkit = /^-webkit-(min|max)-(.*)$/.exec(name);
  if (webkit) {
    prefix = webkit[1] as 'min' | 'max';
    name = `-webkit-${webkit[2]!}`;
  } else if (name.startsWith('min-')) {
    prefix = 'min';
    name = name.slice(4);
  } else if (name.startsWith('max-')) {
    prefix = 'max';
    name = name.slice(4);
  }
  if (prefix && value === null) return null;
  const cmp = (actual: number, wanted: number | null): boolean | null => {
    if (wanted === null) return null;
    if (prefix === 'min') return actual >= wanted;
    if (prefix === 'max') return actual <= wanted;
    return Math.abs(actual - wanted) < 1e-9;
  };
  const w = env.width();
  const h = env.height();
  switch (name) {
    case 'width':
    case 'device-width':
      return value === null ? w !== 0 : cmp(w, parseLength(value));
    case 'height':
    case 'device-height':
      return value === null ? h !== 0 : cmp(h, parseLength(value));
    case 'aspect-ratio':
    case 'device-aspect-ratio':
      return value === null ? true : cmp(w / h, parseRatio(value));
    case 'resolution':
      return value === null ? true : cmp(env.dpr(), parseResolution(value));
    case '-webkit-device-pixel-ratio':
      return value === null ? true : cmp(env.dpr(), value === '' ? null : Number(value));
    case 'color':
      return value === null ? true : cmp(8, Number.isInteger(Number(value)) ? Number(value) : null);
    case 'color-index':
    case 'monochrome':
    case 'grid':
      return value === null ? false : cmp(0, Number.isInteger(Number(value)) ? Number(value) : null);
    case 'orientation':
      if (prefix || value === null) return value === null ? true : null;
      return value === (h >= w ? 'portrait' : 'landscape');
    default:
      if (prefix) return null;
      if (name in DISCRETE) {
        const actual = DISCRETE[name]!;
        if (value === null) return actual !== 'none' && actual !== 'no-preference';
        return value === actual;
      }
      return null;
  }
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

// Media Queries 4 three-valued logic: an unknown feature is "unknown", which stays unknown under not(),
// and the whole query is false (but valid) when the result is unknown.
const UNKNOWN = 'unknown';
type Tri = boolean | typeof UNKNOWN;

/** Evaluates a condition: features joined by `and` / `or`, `not (…)`, nested parentheses. null = invalid. */
function evalCondition(cond: string, env: MediaEnv): Tri | null {
  const s = cond.trim();
  if (s.startsWith('not ') || s.startsWith('not(')) {
    const r = evalCondition(s.slice(3), env);
    return r === null ? null : r === UNKNOWN ? UNKNOWN : !r;
  }
  // Split on top-level "and"/"or".
  const parts: string[] = [];
  const ops: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) {
      const rest = s.slice(i);
      const m = /^\s+(and|or)\s+/.exec(rest);
      if (m) {
        parts.push(s.slice(start, i));
        ops.push(m[1]!);
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(s.slice(start));
  if (ops.length > 0 && new Set(ops).size > 1) return null; // mixing and/or without parens is invalid
  const values: Tri[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t.startsWith('(') || !t.endsWith(')')) return null;
    const inner = t.slice(1, -1).trim();
    let r: Tri | null;
    if (inner.startsWith('(') || inner.startsWith('not ') || inner.startsWith('not(')) {
      r = evalCondition(inner, env);
      if (r === null) r = UNKNOWN; // <general-enclosed>
    } else {
      r = evalFeature(inner, env) ?? UNKNOWN; // unknown feature: unknown, the query stays valid
    }
    values.push(r);
  }
  if (ops[0] === 'or') return values.includes(true) ? true : values.includes(UNKNOWN) ? UNKNOWN : false;
  return values.includes(false) ? false : values.includes(UNKNOWN) ? UNKNOWN : true;
}

const MEDIA_TYPES: Record<string, boolean> = {
  all: true,
  screen: true,
  print: false,
  speech: false,
  tty: false,
  tv: false,
  projection: false,
  handheld: false,
  braille: false,
  embossed: false,
  aural: false,
};

function evalQuery(q: string, env: MediaEnv): boolean | null {
  let s = q.trim();
  if (s === '') return null;
  let negate = false;
  const m = /^(not|only)\s+/.exec(s);
  if (m && !s.startsWith('not (') && !s.startsWith('not(')) {
    negate = m[1] === 'not';
    s = s.slice(m[0].length);
  }
  if (s.startsWith('(') || s.startsWith('not ') || s.startsWith('not(')) {
    if (negate) return null;
    const r = evalCondition(s, env);
    return r === null ? null : r === true;
  }
  const t = /^([a-z-]+)(?:\s+and\s+(.*))?$/.exec(s);
  if (!t) return null;
  const typeMatch = MEDIA_TYPES[t[1]!] ?? false;
  let cond = true;
  if (t[2] !== undefined) {
    const r = evalCondition(t[2], env);
    if (r === null) return null;
    cond = r === true;
  }
  const r = typeMatch && cond;
  return negate ? !r : r;
}

/** Normalised serialisation of a media query list (approximates CSSOM's "serialize a media query list"). */
function serializeMedia(query: string): string {
  return splitTopLevel(query, ',')
    .map((q) => {
      const n = q
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\(\s*/g, '(')
        .replace(/\s*\)/g, ')')
        .replace(/\s*:\s*/g, ': ');
      return n;
    })
    .join(', ');
}

export function evaluateMediaQueryList(query: string, env: MediaEnv): { media: string; matches: boolean } {
  const lower = String(query).toLowerCase();
  if (lower.trim() === '') return { media: '', matches: true };
  const queries = splitTopLevel(lower, ',');
  let any = false;
  const media: string[] = [];
  for (const q of queries) {
    const r = evalQuery(q, env);
    if (r === null) {
      media.push('not all');
    } else {
      media.push(serializeMedia(q));
      if (r) any = true;
    }
  }
  return { media: media.join(', '), matches: any };
}

export class MediaQueryListEvent extends Event {
  #media: string;
  #matches: boolean;
  constructor(type: string, init?: (EventInit & { media?: string; matches?: boolean }) | null) {
    super(type, init);
    this.#media = init?.media === undefined ? '' : String(init.media);
    this.#matches = !!init?.matches;
  }
  get media(): string {
    return this.#media;
  }
  get matches(): boolean {
    return this.#matches;
  }
}
tag(MediaQueryListEvent, 'MediaQueryListEvent');
setLength(MediaQueryListEvent, 1);
enumerable(MediaQueryListEvent, ['media', 'matches']);

export class MediaQueryList extends EventTarget {
  #query: string;
  #env: MediaEnv;
  constructor(token?: unknown, query?: string, env?: MediaEnv) {
    if (token !== INTERNAL) throw illegalConstructor();
    super();
    this.#query = query!;
    this.#env = env!;
  }
  get media(): string {
    return evaluateMediaQueryList(this.#query, this.#env).media;
  }
  get matches(): boolean {
    return evaluateMediaQueryList(this.#query, this.#env).matches;
  }
  addListener(callback: ((e: Event) => void) | null): void {
    this.addEventListener('change', callback);
  }
  removeListener(callback: ((e: Event) => void) | null): void {
    this.removeEventListener('change', callback);
  }
}
tag(MediaQueryList, 'MediaQueryList');
enumerable(MediaQueryList, ['media', 'matches', 'addListener', 'removeListener']);
defineEventHandler(MediaQueryList.prototype, 'change');

export function createMatchMedia(env: MediaEnv): (query: string) => MediaQueryList {
  return function matchMedia(query: string): MediaQueryList {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'matchMedia' on 'Window': 1 argument required, but only 0 present.",
      );
    }
    return new MediaQueryList(INTERNAL, String(query), env);
  };
}

// ---------------------------------------------------------------------------------------------------
// Location and History

export class PopStateEvent extends Event {
  #state: unknown;
  #hasUAVisualTransition: boolean;
  constructor(type: string, init?: (EventInit & { state?: unknown; hasUAVisualTransition?: boolean }) | null) {
    super(type, init);
    this.#state = init?.state === undefined ? null : init.state;
    this.#hasUAVisualTransition = !!init?.hasUAVisualTransition;
  }
  get state(): unknown {
    return this.#state;
  }
  get hasUAVisualTransition(): boolean {
    return this.#hasUAVisualTransition;
  }
}
tag(PopStateEvent, 'PopStateEvent');
setLength(PopStateEvent, 1);
enumerable(PopStateEvent, ['state', 'hasUAVisualTransition']);

export class HashChangeEvent extends Event {
  #oldURL: string;
  #newURL: string;
  constructor(type: string, init?: (EventInit & { oldURL?: string; newURL?: string }) | null) {
    super(type, init);
    this.#oldURL = init?.oldURL === undefined ? '' : String(init.oldURL);
    this.#newURL = init?.newURL === undefined ? '' : String(init.newURL);
  }
  get oldURL(): string {
    return this.#oldURL;
  }
  get newURL(): string {
    return this.#newURL;
  }
}
tag(HashChangeEvent, 'HashChangeEvent');
setLength(HashChangeEvent, 1);
enumerable(HashChangeEvent, ['oldURL', 'newURL']);

type URLCtor = new (url: string, base?: string) => URL;

interface Entry {
  url: string;
  state: unknown;
}

/** Shared state behind `location` and `history`. */
export interface Navigation {
  readonly URL: URLCtor;
  current(): URL;
  /** Same-document URL change without events (pushState/replaceState). */
  setURL(url: string): void;
  entries: Entry[];
  index: number;
  windowTarget: EventTarget;
  clone(v: unknown): unknown;
  reload(url?: string): void;
  warn(msg: string): void;
}

function queueTask(fn: () => void): void {
  const st = (globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown }).setTimeout;
  if (typeof st === 'function') st(fn, 0);
  else Promise.resolve().then(fn);
}

function withoutFragment(u: URL): string {
  const h = u.href.indexOf('#');
  return h < 0 ? u.href : u.href.slice(0, h);
}

/** Session history cap (Chromium keeps 50 entries); the oldest entries are dropped beyond it. */
export const MAX_HISTORY_ENTRIES = 50;

function pushEntry(nav: Navigation, entry: Entry): void {
  nav.entries.splice(nav.index + 1);
  nav.entries.push(entry);
  nav.index++;
  if (nav.entries.length > MAX_HISTORY_ENTRIES) {
    const drop = nav.entries.length - MAX_HISTORY_ENTRIES;
    nav.entries.splice(0, drop);
    nav.index -= drop;
  }
}

/** HTML "navigate" restricted to what a single packaged document can do. */
function navigate(nav: Navigation, target: string, replace: boolean): void {
  const cur = nav.current();
  let next: URL;
  try {
    next = new nav.URL(target, cur.href);
  } catch {
    throw domException(`Failed to execute 'assign' on 'Location': '${target}' is not a valid URL.`, 'SyntaxError');
  }
  if (next.origin !== cur.origin) {
    nav.warn(`[iwer-native] navigation to another origin is ignored: ${next.href}`);
    return;
  }
  // HTML navigate: navigating to the current URL replaces the entry instead of pushing one.
  if (next.href === cur.href) replace = true;
  if (withoutFragment(next) === withoutFragment(cur) && next.href.includes('#')) {
    // Navigate to a fragment: same document. popstate (state null) fires during the navigation,
    // hashchange in a later task when the fragment changed (HTML "update document for history step
    // application").
    const oldURL = cur.href;
    if (replace) {
      nav.entries[nav.index] = { url: next.href, state: null };
    } else {
      pushEntry(nav, { url: next.href, state: null });
    }
    nav.setURL(next.href);
    dispatchTrusted(nav.windowTarget, new PopStateEvent('popstate', { state: null }));
    if (oldURL !== next.href) {
      queueTask(() => {
        dispatchTrusted(nav.windowTarget, new HashChangeEvent('hashchange', { oldURL, newURL: next.href }));
      });
    }
    return;
  }
  // Another document of the same app: the runtime restarts JS with the new URL (PROC-8).
  nav.reload(next.href);
}

const EMPTY_ORIGINS = Object.freeze({ length: 0, item: (_i: number): null => null, contains: (_s: string): boolean => false });

let locNav!: (l: Location) => Navigation;
export class Location {
  #nav: Navigation;
  constructor(token?: unknown, nav?: Navigation) {
    if (token !== INTERNAL) throw illegalConstructor();
    this.#nav = nav!;
  }
  static {
    locNav = (l) => l.#nav;
  }
  get href(): string {
    return this.#nav.current().href;
  }
  set href(v: string) {
    navigate(this.#nav, String(v), false);
  }
  get origin(): string {
    return this.#nav.current().origin;
  }
  get protocol(): string {
    return this.#nav.current().protocol;
  }
  set protocol(v: string) {
    this.#set('protocol', v);
  }
  get host(): string {
    return this.#nav.current().host;
  }
  set host(v: string) {
    this.#set('host', v);
  }
  get hostname(): string {
    return this.#nav.current().hostname;
  }
  set hostname(v: string) {
    this.#set('hostname', v);
  }
  get port(): string {
    return this.#nav.current().port;
  }
  set port(v: string) {
    this.#set('port', v);
  }
  get pathname(): string {
    return this.#nav.current().pathname;
  }
  set pathname(v: string) {
    this.#set('pathname', v);
  }
  get search(): string {
    return this.#nav.current().search;
  }
  set search(v: string) {
    this.#set('search', v);
  }
  get hash(): string {
    return this.#nav.current().hash;
  }
  set hash(v: string) {
    // HTML Location hash setter: navigate to the fragment (even an empty one), but return early when
    // the fragment would not change, so content that keeps re-setting the hash does not grow history.
    const cur = this.#nav.current();
    const u = new this.#nav.URL(cur.href);
    let h = String(v);
    if (h.startsWith('#')) h = h.slice(1);
    u.hash = h;
    const href = u.href.includes('#') ? u.href : `${u.href}#`;
    // "If copyURL's fragment is this's url's fragment, then return", where a null fragment is ''.
    const fragmentOf = (s: string): string => {
      const i = s.indexOf('#');
      return i < 0 ? '' : s.slice(i + 1);
    };
    if (fragmentOf(href) === fragmentOf(cur.href)) return;
    navigate(this.#nav, href, false);
  }
  // [SameObject]: one empty DOMStringList-like object (a packaged app has no ancestors).
  get ancestorOrigins(): { length: number; item(i: number): null; contains(s: string): boolean } {
    return EMPTY_ORIGINS;
  }
  assign(url: string): void {
    navigate(this.#nav, String(url), false);
  }
  replace(url: string): void {
    navigate(this.#nav, String(url), true);
  }
  reload(): void {
    this.#nav.reload();
  }
  toString(): string {
    return this.href;
  }
  valueOf(): this {
    return this;
  }
  #set(part: 'protocol' | 'host' | 'hostname' | 'port' | 'pathname' | 'search', v: string): void {
    const u = new this.#nav.URL(this.#nav.current().href);
    (u as unknown as Record<string, string>)[part] = String(v);
    navigate(this.#nav, u.href, false);
  }
}
tag(Location, 'Location');
enumerable(Location, [
  'href',
  'origin',
  'protocol',
  'host',
  'hostname',
  'port',
  'pathname',
  'search',
  'hash',
  'ancestorOrigins',
  'assign',
  'replace',
  'reload',
  'toString',
]);

export class History {
  #nav: Navigation;
  #scrollRestoration = 'auto';
  constructor(token?: unknown, nav?: Navigation) {
    if (token !== INTERNAL) throw illegalConstructor();
    this.#nav = nav!;
  }
  get length(): number {
    return this.#nav.entries.length;
  }
  get state(): unknown {
    return this.#nav.entries[this.#nav.index]?.state ?? null;
  }
  get scrollRestoration(): string {
    return this.#scrollRestoration;
  }
  set scrollRestoration(v: string) {
    if (v === 'auto' || v === 'manual') this.#scrollRestoration = v;
  }
  pushState(data: unknown, unused: string, url?: string | null): void {
    historyArgs('pushState', arguments.length, unused);
    this.#update(data, url, false, unused);
  }
  replaceState(data: unknown, unused: string, url?: string | null): void {
    historyArgs('replaceState', arguments.length, unused);
    this.#update(data, url, true, unused);
  }
  back(): void {
    this.go(-1);
  }
  forward(): void {
    this.go(1);
  }
  go(delta = 0): void {
    const nav = this.#nav;
    const d = Math.trunc(Number(delta)) || 0;
    if (d === 0) {
      nav.reload();
      return;
    }
    queueTask(() => {
      const target = nav.index + d;
      if (target < 0 || target >= nav.entries.length) return;
      const oldURL = nav.current().href;
      nav.index = target;
      const entry = nav.entries[target]!;
      nav.setURL(entry.url);
      dispatchTrusted(nav.windowTarget, new PopStateEvent('popstate', { state: entry.state }));
      const newU = new nav.URL(entry.url);
      const oldU = new nav.URL(oldURL);
      if (newU.hash !== oldU.hash && withoutFragment(newU) === withoutFragment(oldU)) {
        dispatchTrusted(nav.windowTarget, new HashChangeEvent('hashchange', { oldURL, newURL: entry.url }));
      }
    });
  }
  #update(data: unknown, url: string | null | undefined, replace: boolean, _unused: string): void {
    const nav = this.#nav;
    const state = nav.clone(data);
    let href = nav.current().href;
    // HTML "shared history push/replace state steps": a null or empty url keeps the document URL.
    if (url !== undefined && url !== null && String(url) !== '') {
      let next: URL;
      try {
        next = new nav.URL(String(url), href);
      } catch {
        throw domException(
          `Failed to execute '${replace ? 'replaceState' : 'pushState'}' on 'History': '${String(url)}' is not a valid URL.`,
          'SecurityError',
        );
      }
      const cur = nav.current();
      if (next.origin !== cur.origin || next.protocol !== cur.protocol) {
        throw domException(
          `Failed to execute '${replace ? 'replaceState' : 'pushState'}' on 'History': A history state object with URL '${next.href}' cannot be created in a document with origin '${cur.origin}'.`,
          'SecurityError',
        );
      }
      href = next.href;
    }
    if (replace) {
      nav.entries[nav.index] = { url: href, state };
    } else {
      pushEntry(nav, { url: href, state });
    }
    nav.setURL(href);
  }
}
tag(History, 'History');

/** WebIDL steps of pushState/replaceState: two arguments required, `unused` is a DOMString. */
function historyArgs(op: string, count: number, unused: unknown): void {
  if (count < 2) {
    throw new TypeError(`Failed to execute '${op}' on 'History': 2 arguments required, but only ${count} present.`);
  }
  toDOMString(unused, `Failed to execute '${op}' on 'History'`);
}
enumerable(History, [
  'length',
  'state',
  'scrollRestoration',
  'pushState',
  'replaceState',
  'back',
  'forward',
  'go',
]);

export function createNavigation(opts: {
  URL: URLCtor;
  initialURL: string;
  windowTarget: EventTarget;
  clone: (v: unknown) => unknown;
  reload: (url?: string) => void;
  warn: (msg: string) => void;
}): { navigation: Navigation; location: Location; history: History } {
  let current = new opts.URL(opts.initialURL);
  const navigation: Navigation = {
    URL: opts.URL,
    current: () => current,
    setURL: (url) => {
      current = new opts.URL(url);
    },
    entries: [{ url: current.href, state: null }],
    index: 0,
    windowTarget: opts.windowTarget,
    clone: opts.clone,
    reload: opts.reload,
    warn: opts.warn,
  };
  return {
    navigation,
    location: new Location(INTERNAL, navigation),
    history: new History(INTERNAL, navigation),
  };
}

/** For other glue (document.URL/baseURI): the navigation behind a Location. */
export function navigationOf(location: Location): Navigation {
  return locNav(location);
}

// ---------------------------------------------------------------------------------------------------
// WorkerLocation (HTML §10.3.3): the worker's URL, read-only.

let workerLocationURL!: (l: WorkerLocation) => URL;
export class WorkerLocation {
  #url: URL;
  constructor(token?: unknown, url?: URL) {
    if (token !== INTERNAL) throw illegalConstructor();
    this.#url = url!;
  }
  static {
    workerLocationURL = (l) => l.#url;
  }
  get href(): string {
    return this.#url.href;
  }
  get origin(): string {
    return this.#url.origin;
  }
  get protocol(): string {
    return this.#url.protocol;
  }
  get host(): string {
    return this.#url.host;
  }
  get hostname(): string {
    return this.#url.hostname;
  }
  get port(): string {
    return this.#url.port;
  }
  get pathname(): string {
    return this.#url.pathname;
  }
  get search(): string {
    return this.#url.search;
  }
  get hash(): string {
    return this.#url.hash;
  }
  toString(): string {
    return this.#url.href;
  }
}
tag(WorkerLocation, 'WorkerLocation');
enumerable(WorkerLocation, ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'toString']);

/** For other glue: the URL behind a WorkerLocation. */
export function workerLocationHref(location: WorkerLocation): string {
  return workerLocationURL(location).href;
}
