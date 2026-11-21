/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Fetch §5.2 Headers class (NET-9): header list in insertion order, case-insensitive names, combined
// values, sort-and-combine iteration with set-cookie kept separate, guards (immutable, request,
// response) and the forbidden request/response header rules.

export type HeadersGuard =
  | 'none'
  | 'request'
  | 'request-no-cors'
  | 'response'
  | 'immutable';
export type HeadersInitLike =
  | Headers
  | Iterable<Iterable<string>>
  | Record<string, string>;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Leading/trailing HTTP whitespace: U+0009, U+000A, U+000D, U+0020.
const TRIM = /^[\t\n\r ]+|[\t\n\r ]+$/g;

const FORBIDDEN_REQUEST = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

export function isForbiddenRequestHeader(
  lowerName: string,
  value?: string,
): boolean {
  if (FORBIDDEN_REQUEST.has(lowerName)) return true;
  if (lowerName.startsWith('proxy-') || lowerName.startsWith('sec-'))
    return true;
  if (
    value !== undefined &&
    (lowerName === 'x-http-method' ||
      lowerName === 'x-http-method-override' ||
      lowerName === 'x-method-override')
  ) {
    return value
      .split(',')
      .some((m) =>
        ['CONNECT', 'TRACE', 'TRACK'].includes(m.trim().toUpperCase()),
      );
  }
  return false;
}

export function isForbiddenResponseHeader(lowerName: string): boolean {
  return lowerName === 'set-cookie' || lowerName === 'set-cookie2';
}

function normalizeValue(v: unknown): string {
  return String(v).replace(TRIM, '');
}

function validate(name: string, value: string): void {
  if (!TOKEN.test(name)) throw new TypeError(`Invalid header name: "${name}"`);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0 || c === 0x0a || c === 0x0d || c > 0xff)
      throw new TypeError(`Invalid value for header "${name}"`);
  }
}

const GUARD = Symbol('guard');
const LIST = Symbol('list');

export class Headers {
  [LIST]: Array<[string, string]> = [];
  [GUARD]: HeadersGuard = 'none';

  constructor(init?: HeadersInitLike) {
    if (init !== undefined && init !== null) fillHeaders(this, init);
  }

  append(name: string, value: string): void {
    appendHeader(this, String(name), normalizeValue(value));
  }

  delete(name: string): void {
    name = String(name);
    if (!TOKEN.test(name))
      throw new TypeError(`Invalid header name: "${name}"`);
    if (!checkGuard(this, name.toLowerCase(), '')) return;
    const lower = name.toLowerCase();
    this[LIST] = this[LIST].filter(([n]) => n !== lower);
  }

  get(name: string): string | null {
    name = String(name);
    if (!TOKEN.test(name))
      throw new TypeError(`Invalid header name: "${name}"`);
    const lower = name.toLowerCase();
    const values = this[LIST].filter(([n]) => n === lower).map(([, v]) => v);
    return values.length ? values.join(', ') : null;
  }

  getSetCookie(): string[] {
    return this[LIST].filter(([n]) => n === 'set-cookie').map(([, v]) => v);
  }

  has(name: string): boolean {
    name = String(name);
    if (!TOKEN.test(name))
      throw new TypeError(`Invalid header name: "${name}"`);
    const lower = name.toLowerCase();
    return this[LIST].some(([n]) => n === lower);
  }

  set(name: string, value: string): void {
    name = String(name);
    const v = normalizeValue(value);
    validate(name, v);
    const lower = name.toLowerCase();
    if (!checkGuard(this, lower, v)) return;
    const list = this[LIST];
    const first = list.findIndex(([n]) => n === lower);
    if (first < 0) {
      list.push([lower, v]);
      return;
    }
    list[first] = [lower, v];
    this[LIST] = list.filter(([n], i) => i <= first || n !== lower);
  }

  forEach(
    callback: (value: string, name: string, parent: Headers) => void,
    thisArg?: unknown,
  ): void {
    for (const [n, v] of sortAndCombine(this))
      callback.call(thisArg, v, n, this);
  }

  *entries(): IterableIterator<[string, string]> {
    // Live per spec: re-sort on each step only if the list changed; a snapshot per step is equivalent
    // for all practical uses and keeps iteration well-defined.
    const sorted = sortAndCombine(this);
    for (let i = 0; i < sorted.length; i++) yield sorted[i];
  }

  *keys(): IterableIterator<string> {
    for (const [n] of this.entries()) yield n;
  }

  *values(): IterableIterator<string> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'Headers';
  }
}

function checkGuard(h: Headers, lower: string, value: string): boolean {
  const guard = h[GUARD];
  if (guard === 'immutable') throw new TypeError('Headers are immutable');
  if (guard === 'request' && isForbiddenRequestHeader(lower, value))
    return false;
  if (guard === 'response' && isForbiddenResponseHeader(lower)) return false;
  return true;
}

function appendHeader(h: Headers, name: string, value: string): void {
  validate(name, value);
  const lower = name.toLowerCase();
  if (!checkGuard(h, lower, value)) return;
  h[LIST].push([lower, value]);
}

function sortAndCombine(h: Headers): Array<[string, string]> {
  const names = [...new Set(h[LIST].map(([n]) => n))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out: Array<[string, string]> = [];
  for (const n of names) {
    if (n === 'set-cookie') {
      for (const [ln, v] of h[LIST]) if (ln === n) out.push([n, v]);
    } else {
      out.push([
        n,
        h[LIST].filter(([ln]) => ln === n)
          .map(([, v]) => v)
          .join(', '),
      ]);
    }
  }
  return out;
}

export function fillHeaders(h: Headers, init: HeadersInitLike): void {
  if (init instanceof Headers) {
    for (const [n, v] of init[LIST]) appendHeader(h, n, v);
    return;
  }
  if (typeof init !== 'object')
    throw new TypeError(
      "Failed to construct 'Headers': The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.",
    );
  const iter = (init as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  if (typeof iter === 'function') {
    for (const pair of init as Iterable<Iterable<string>>) {
      const arr = typeof pair === 'string' ? null : [...pair];
      if (!arr || arr.length !== 2)
        throw new TypeError("Failed to construct 'Headers': Invalid value");
      appendHeader(h, String(arr[0]), normalizeValue(arr[1]));
    }
    return;
  }
  for (const key of Reflect.ownKeys(init)) {
    const desc = Reflect.getOwnPropertyDescriptor(init, key);
    if (!desc || !desc.enumerable) continue;
    if (typeof key === 'symbol')
      throw new TypeError('Header names must be strings');
    appendHeader(h, key, normalizeValue((init as Record<string, string>)[key]));
  }
}

// Internal accessors for Request/Response/fetch.
export function headerList(h: Headers): Array<[string, string]> {
  return h[LIST];
}
export function setGuard(h: Headers, guard: HeadersGuard): void {
  h[GUARD] = guard;
}
export function getGuard(h: Headers): HeadersGuard {
  return h[GUARD];
}
/** Builds response headers from native (lower-cased) pairs without guard checks. */
export function headersFromPairs(
  flat: readonly string[],
  guard: HeadersGuard,
): Headers {
  const h = new Headers();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const n = flat[i].toLowerCase();
    if (guard === 'response' && isForbiddenResponseHeader(n)) continue;
    h[LIST].push([n, flat[i + 1]]);
  }
  h[GUARD] = guard;
  return h;
}
export function cloneHeaders(h: Headers, guard?: HeadersGuard): Headers {
  const c = new Headers();
  c[LIST] = h[LIST].map(([n, v]) => [n, v] as [string, string]);
  c[GUARD] = guard ?? h[GUARD];
  return c;
}
