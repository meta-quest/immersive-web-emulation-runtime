/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CSSStyleDeclaration stand-in (CSSOM §6.6, DOM-8): accepts any property, through setProperty/getPropertyValue/
// removeProperty/cssText and the camelCase / dashed named properties (`style.backgroundColor`, `style['z-index']`).
// Values are stored as given (no parsing, no computed values: nothing is rendered). An element's declaration
// mirrors its `style` attribute both ways.

import { str } from './env.ts';

interface Entry {
  value: string;
  important: boolean;
}

const STATE = Symbol('iwn.css.state');

interface State {
  map: Map<string, Entry>;
  /** Called after every change with the new cssText (the element's style attribute); null for read-only copies. */
  onchange: ((cssText: string) => void) | null;
  readOnly: boolean;
}

/** `backgroundColor` -> `background-color`, `webkitTransform` -> `-webkit-transform`, `cssFloat` -> `float`. */
export function cssName(prop: string): string {
  if (prop.startsWith('--')) return prop;
  if (prop === 'cssFloat') return 'float';
  if (prop.includes('-')) return prop.toLowerCase();
  let out = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  if (/^(webkit|moz|ms|o)-/.test(out)) out = `-${out}`;
  return out;
}

function parseDeclarations(text: string): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = [];
  // Split on ';' outside parentheses and quotes.
  let depth = 0;
  let quote = '';
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  for (const part of parts) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    let important = false;
    const m = /!\s*important\s*$/i.exec(value);
    if (m) {
      important = true;
      value = value.slice(0, m.index).trim();
    }
    if (name && value)
      out.push([
        name.startsWith('--') ? name : name.toLowerCase(),
        value,
        important,
      ]);
  }
  return out;
}

export class CSSStyleDeclaration {
  declare [STATE]: State;

  constructor() {
    throw new TypeError('Illegal constructor');
  }

  get cssText(): string {
    const parts: string[] = [];
    for (const [k, e] of this[STATE].map)
      parts.push(`${k}: ${e.value}${e.important ? ' !important' : ''};`);
    return parts.join(' ');
  }
  set cssText(v: string) {
    const s = this[STATE];
    if (s.readOnly)
      throw new Error(
        'NoModificationAllowedError: the declaration is read-only',
      );
    s.map.clear();
    for (const [k, value, important] of parseDeclarations(str(v)))
      s.map.set(k, { value, important });
    s.onchange?.(this.cssText);
  }
  get length(): number {
    return this[STATE].map.size;
  }
  get parentRule(): null {
    return null;
  }
  item(index: number): string {
    const i = Number(index) >>> 0;
    let n = 0;
    for (const k of this[STATE].map.keys()) if (n++ === i) return k;
    return '';
  }
  getPropertyValue(property: string): string {
    return this[STATE].map.get(cssName(str(property)))?.value ?? '';
  }
  getPropertyPriority(property: string): string {
    return this[STATE].map.get(cssName(str(property)))?.important
      ? 'important'
      : '';
  }
  setProperty(property: string, value: unknown, priority = ''): void {
    const s = this[STATE];
    if (s.readOnly)
      throw new Error(
        'NoModificationAllowedError: the declaration is read-only',
      );
    const name = cssName(str(property));
    const v = value === null || value === undefined ? '' : str(value).trim();
    if (v === '') {
      if (s.map.delete(name)) s.onchange?.(this.cssText);
      return;
    }
    const p = str(priority).toLowerCase();
    if (p !== '' && p !== 'important') return;
    s.map.set(name, { value: v, important: p === 'important' });
    s.onchange?.(this.cssText);
  }
  removeProperty(property: string): string {
    const s = this[STATE];
    if (s.readOnly)
      throw new Error(
        'NoModificationAllowedError: the declaration is read-only',
      );
    const name = cssName(str(property));
    const old = s.map.get(name)?.value ?? '';
    if (s.map.delete(name)) s.onchange?.(this.cssText);
    return old;
  }
  *[Symbol.iterator](): IterableIterator<string> {
    yield* this[STATE].map.keys();
  }
  get [Symbol.toStringTag](): string {
    return 'CSSStyleDeclaration';
  }
}

const PROTO = CSSStyleDeclaration.prototype as unknown as Record<
  PropertyKey,
  unknown
>;

/** A new declaration; `onchange` receives the cssText after each change (null: detached). */
export function createStyle(
  initial: string,
  onchange: ((cssText: string) => void) | null,
  readOnly = false,
): CSSStyleDeclaration {
  const target = Object.create(
    CSSStyleDeclaration.prototype,
  ) as CSSStyleDeclaration;
  const state: State = { map: new Map(), onchange: null, readOnly: false };
  Object.defineProperty(target, STATE, { value: state });
  for (const [k, value, important] of parseDeclarations(initial))
    state.map.set(k, { value, important });
  state.onchange = onchange;
  state.readOnly = readOnly;
  return new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key !== 'string' || key in PROTO || key === 'constructor')
        return Reflect.get(t, key, receiver);
      if (/^\d+$/.test(key)) return t.item(Number(key)) || undefined;
      return state.map.get(cssName(key))?.value ?? '';
    },
    set(t, key, value, receiver) {
      if (typeof key !== 'string' || key in PROTO)
        return Reflect.set(t, key, value, receiver);
      if (state.readOnly) return true;
      t.setProperty(key, value);
      return true;
    },
    has(t, key) {
      if (typeof key !== 'string') return Reflect.has(t, key);
      return (
        key in PROTO || state.map.has(cssName(key)) || /^[a-zA-Z-]+$/.test(key)
      );
    },
  });
}

/** Re-parses a declaration from its owner's attribute without calling back. */
export function resetStyle(decl: CSSStyleDeclaration, cssText: string): void {
  const s = (decl as unknown as { [STATE]: State })[STATE];
  s.map.clear();
  for (const [k, value, important] of parseDeclarations(cssText))
    s.map.set(k, { value, important });
}
