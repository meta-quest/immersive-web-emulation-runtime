/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A small Selectors Level 4 subset for querySelector(All), matches and closest over the stand-in tree (DOM-6,
// DOM-8): type and universal selectors, #id, .class, attribute selectors (= ~= |= ^= $= *=, quoted or not, `i`
// flag), the combinators ' ' '>' '+' '~', selector lists, and the structural pseudo-classes :not() :is() :where()
// :first-child :last-child :only-child :nth-child() :nth-last-child() :first-of-type :last-of-type :root :scope
// :empty :checked :disabled :enabled. User-action pseudo-classes (:hover, :focus, ...) never match: nothing is
// rendered or pointed at. Anything else is a SyntaxError, as in browsers.

import { domException, lower } from './env.ts';

/** The element surface the matcher reads (implemented by nodes.ts Element). */
export interface MatchElement {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly parentNode: unknown;
  readonly parentElement: MatchElement | null;
  readonly previousElementSibling: MatchElement | null;
  readonly nextElementSibling: MatchElement | null;
  readonly firstChild: unknown;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  readonly id: string;
  readonly childNodes: ArrayLike<unknown>;
}

type Attr = { name: string; op: string; value: string; ci: boolean };
type Pseudo = {
  name: string;
  arg?: string;
  list?: Complex[];
  a?: number;
  b?: number;
};
interface Compound {
  tag: string | null; // null = any
  ids: string[];
  classes: string[];
  attrs: Attr[];
  pseudos: Pseudo[];
}
type Combinator = ' ' | '>' | '+' | '~';
interface Complex {
  compounds: Compound[];
  combinators: Combinator[]; // combinators[i] sits between compounds[i] and compounds[i + 1]
}

const cache = new Map<string, Complex[]>();

function syntaxError(sel: string): Error {
  return domException(`'${sel}' is not a valid selector.`, 'SyntaxError');
}

const IDENT = /^-?(?:[_a-zA-Z\u00a0-\uffff]|\\.)(?:[-\w\u00a0-\uffff]|\\.)*/;

function unescape(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, e: string) =>
    /^[0-9a-fA-F]/.test(e) ? String.fromCodePoint(parseInt(e, 16)) : e,
  );
}

class Parser {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  ws(): boolean {
    const start = this.i;
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
    return this.i > start;
  }
  ident(): string | null {
    const m = IDENT.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return unescape(m[0]);
  }
  list(stopAtParen = false): Complex[] {
    const out: Complex[] = [];
    for (;;) {
      this.ws();
      out.push(this.complex());
      this.ws();
      if (this.s[this.i] === ',') {
        this.i++;
        continue;
      }
      if (stopAtParen && this.s[this.i] === ')') return out;
      if (this.i >= this.s.length && !stopAtParen) return out;
      throw syntaxError(this.s);
    }
  }
  complex(): Complex {
    const compounds: Compound[] = [this.compound()];
    const combinators: Combinator[] = [];
    for (;;) {
      const hadWs = this.ws();
      const c = this.s[this.i];
      if (c === '>' || c === '+' || c === '~') {
        this.i++;
        this.ws();
        combinators.push(c);
        compounds.push(this.compound());
      } else if (hadWs && c !== undefined && c !== ',' && c !== ')') {
        combinators.push(' ');
        compounds.push(this.compound());
      } else return { compounds, combinators };
    }
  }
  compound(): Compound {
    const c: Compound = {
      tag: null,
      ids: [],
      classes: [],
      attrs: [],
      pseudos: [],
    };
    const start = this.i;
    if (this.s[this.i] === '*') {
      this.i++;
    } else {
      const t = this.ident();
      if (t !== null) c.tag = lower(t);
    }
    for (;;) {
      const ch = this.s[this.i];
      if (ch === '#') {
        this.i++;
        const id = this.ident();
        if (id === null) throw syntaxError(this.s);
        c.ids.push(id);
      } else if (ch === '.') {
        this.i++;
        const cls = this.ident();
        if (cls === null) throw syntaxError(this.s);
        c.classes.push(cls);
      } else if (ch === '[') {
        this.i++;
        c.attrs.push(this.attr());
      } else if (ch === ':') {
        this.i++;
        if (this.s[this.i] === ':') throw syntaxError(this.s); // pseudo-elements never match an element
        c.pseudos.push(this.pseudo());
      } else break;
    }
    if (this.i === start) throw syntaxError(this.s);
    return c;
  }
  attr(): Attr {
    this.ws();
    const name = this.ident();
    if (name === null) throw syntaxError(this.s);
    this.ws();
    let op = '';
    let value = '';
    let ci = false;
    const m = /^([~|^$*]?=)/.exec(this.s.slice(this.i));
    if (m) {
      op = m[1]!;
      this.i += op.length;
      this.ws();
      const q = this.s[this.i];
      if (q === '"' || q === "'") {
        let j = this.i + 1;
        let v = '';
        while (j < this.s.length && this.s[j] !== q) {
          if (this.s[j] === '\\') {
            v += this.s[j + 1] ?? '';
            j += 2;
          } else v += this.s[j++];
        }
        if (j >= this.s.length) throw syntaxError(this.s);
        value = v;
        this.i = j + 1;
      } else {
        const id = this.ident();
        if (id === null) {
          const num = /^[-\w]+/.exec(this.s.slice(this.i));
          if (!num) throw syntaxError(this.s);
          value = num[0];
          this.i += value.length;
        } else value = id;
      }
      this.ws();
      const f = this.s[this.i];
      if (f === 'i' || f === 'I' || f === 's' || f === 'S') {
        ci = f === 'i' || f === 'I';
        this.i++;
        this.ws();
      }
    }
    if (this.s[this.i] !== ']') throw syntaxError(this.s);
    this.i++;
    return { name: lower(name), op, value, ci };
  }
  pseudo(): Pseudo {
    const name = this.ident();
    if (name === null) throw syntaxError(this.s);
    const n = lower(name);
    if (this.s[this.i] !== '(') {
      if (!SIMPLE_PSEUDOS.has(n)) throw syntaxError(this.s);
      return { name: n };
    }
    this.i++;
    if (n === 'not' || n === 'is' || n === 'where' || n === 'matches') {
      const list = this.list(true);
      this.i++; // ')'
      return { name: n === 'matches' ? 'is' : n, list };
    }
    const close = this.s.indexOf(')', this.i);
    if (close < 0) throw syntaxError(this.s);
    const arg = this.s.slice(this.i, close).trim();
    this.i = close + 1;
    if (
      n === 'nth-child' ||
      n === 'nth-last-child' ||
      n === 'nth-of-type' ||
      n === 'nth-last-of-type'
    ) {
      const ab = parseNth(arg);
      if (!ab) throw syntaxError(this.s);
      return { name: n, a: ab[0], b: ab[1] };
    }
    throw syntaxError(this.s);
  }
}

const SIMPLE_PSEUDOS = new Set([
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'root',
  'scope',
  'empty',
  'checked',
  'disabled',
  'enabled',
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'visited',
  'link',
  'any-link',
  'target',
  'defined',
  'required',
  'optional',
  'read-only',
  'read-write',
  'placeholder-shown',
  'fullscreen',
  'indeterminate',
]);

function parseNth(arg: string): [number, number] | null {
  const s = arg.replace(/\s+/g, '').toLowerCase();
  if (s === 'odd') return [2, 1];
  if (s === 'even') return [2, 0];
  const m = /^([+-]?\d*)?n([+-]\d+)?$/.exec(s);
  if (m) {
    const a =
      m[1] === undefined || m[1] === '' || m[1] === '+'
        ? 1
        : m[1] === '-'
          ? -1
          : parseInt(m[1], 10);
    return [a, m[2] ? parseInt(m[2], 10) : 0];
  }
  if (/^[+-]?\d+$/.test(s)) return [0, parseInt(s, 10)];
  return null;
}

export function parseSelector(selector: string): Complex[] {
  let parsed = cache.get(selector);
  if (!parsed) {
    if (selector.trim() === '') throw syntaxError(selector);
    parsed = new Parser(selector).list();
    if (cache.size > 512) cache.clear();
    cache.set(selector, parsed);
  }
  return parsed;
}

function isHTMLElement(el: MatchElement): boolean {
  return el.namespaceURI === 'http://www.w3.org/1999/xhtml';
}

function attrMatches(el: MatchElement, a: Attr): boolean {
  const v = el.getAttribute(a.name);
  if (v === null) return false;
  if (!a.op) return true;
  const have = a.ci ? v.toLowerCase() : v;
  const want = a.ci ? a.value.toLowerCase() : a.value;
  switch (a.op) {
    case '=':
      return have === want;
    case '~=':
      return (
        want !== '' && !/\s/.test(want) && have.split(/\s+/).includes(want)
      );
    case '|=':
      return have === want || have.startsWith(`${want}-`);
    case '^=':
      return want !== '' && have.startsWith(want);
    case '$=':
      return want !== '' && have.endsWith(want);
    case '*=':
      return want !== '' && have.includes(want);
    default:
      return false;
  }
}

function elementIndex(
  el: MatchElement,
  fromEnd: boolean,
  ofType: boolean,
): number {
  let n = 1;
  for (
    let s = fromEnd ? el.nextElementSibling : el.previousElementSibling;
    s;
    s = fromEnd ? s.nextElementSibling : s.previousElementSibling
  ) {
    if (
      !ofType ||
      (s.localName === el.localName && s.namespaceURI === el.namespaceURI)
    )
      n++;
  }
  return n;
}

function nthMatches(index: number, a: number, b: number): boolean {
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

function pseudoMatches(
  el: MatchElement,
  p: Pseudo,
  scope: MatchElement | null,
): boolean {
  switch (p.name) {
    case 'not':
      return !p.list!.some((c) => matchComplex(el, c, scope));
    case 'is':
    case 'where':
      return p.list!.some((c) => matchComplex(el, c, scope));
    case 'first-child':
      return !el.previousElementSibling;
    case 'last-child':
      return !el.nextElementSibling;
    case 'only-child':
      return !el.previousElementSibling && !el.nextElementSibling;
    case 'first-of-type':
      return elementIndex(el, false, true) === 1;
    case 'last-of-type':
      return elementIndex(el, true, true) === 1;
    case 'only-of-type':
      return (
        elementIndex(el, false, true) === 1 &&
        elementIndex(el, true, true) === 1
      );
    case 'nth-child':
      return nthMatches(elementIndex(el, false, false), p.a!, p.b!);
    case 'nth-last-child':
      return nthMatches(elementIndex(el, true, false), p.a!, p.b!);
    case 'nth-of-type':
      return nthMatches(elementIndex(el, false, true), p.a!, p.b!);
    case 'nth-last-of-type':
      return nthMatches(elementIndex(el, true, true), p.a!, p.b!);
    case 'root': {
      const parent = el.parentNode as { nodeType?: number } | null;
      return !!parent && parent.nodeType === 9;
    }
    case 'scope':
      return scope ? el === scope : pseudoMatches(el, { name: 'root' }, null);
    case 'empty': {
      const kids = el.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i] as { nodeType: number; data?: string };
        if (
          k.nodeType === 1 ||
          ((k.nodeType === 3 || k.nodeType === 4) && k.data !== '')
        )
          return false;
      }
      return true;
    }
    case 'checked':
      return el.hasAttribute('checked') || el.hasAttribute('selected');
    case 'disabled':
      return el.hasAttribute('disabled');
    case 'enabled':
      return (
        /^(button|input|select|textarea|option|optgroup|fieldset)$/.test(
          el.localName,
        ) && !el.hasAttribute('disabled')
      );
    case 'required':
      return el.hasAttribute('required');
    case 'optional':
      return (
        /^(input|select|textarea)$/.test(el.localName) &&
        !el.hasAttribute('required')
      );
    case 'link':
    case 'any-link':
      return (
        (el.localName === 'a' || el.localName === 'area') &&
        el.hasAttribute('href')
      );
    case 'defined':
      return true;
    default:
      return false; // user-action and UI-state pseudo-classes: nothing is rendered or pointed at
  }
}

function matchCompound(
  el: MatchElement,
  c: Compound,
  scope: MatchElement | null,
): boolean {
  if (c.tag !== null) {
    const name = isHTMLElement(el) ? el.localName : el.localName;
    if (
      isHTMLElement(el)
        ? name !== c.tag
        : name !== c.tag && lower(name) !== c.tag
    )
      return false;
  }
  for (const id of c.ids) if (el.id !== id) return false;
  if (c.classes.length) {
    const cls = el.getAttribute('class');
    if (cls === null) return false;
    const list = cls.split(/[\t\n\f\r ]+/);
    for (const k of c.classes) if (!list.includes(k)) return false;
  }
  for (const a of c.attrs) if (!attrMatches(el, a)) return false;
  for (const p of c.pseudos) if (!pseudoMatches(el, p, scope)) return false;
  return true;
}

function matchAt(
  el: MatchElement,
  cx: Complex,
  i: number,
  scope: MatchElement | null,
): boolean {
  if (!matchCompound(el, cx.compounds[i]!, scope)) return false;
  if (i === 0) return true;
  const comb = cx.combinators[i - 1]!;
  switch (comb) {
    case '>': {
      const p = el.parentElement;
      return !!p && matchAt(p, cx, i - 1, scope);
    }
    case ' ': {
      for (let p = el.parentElement; p; p = p.parentElement)
        if (matchAt(p, cx, i - 1, scope)) return true;
      return false;
    }
    case '+': {
      const s = el.previousElementSibling;
      return !!s && matchAt(s, cx, i - 1, scope);
    }
    case '~': {
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling)
        if (matchAt(s, cx, i - 1, scope)) return true;
      return false;
    }
  }
  return false;
}

function matchComplex(
  el: MatchElement,
  cx: Complex,
  scope: MatchElement | null,
): boolean {
  return matchAt(el, cx, cx.compounds.length - 1, scope);
}

/** Element.matches(): does `el` match any selector in the list? */
export function matchesSelector(
  el: MatchElement,
  selector: string,
  scope: MatchElement | null = null,
): boolean {
  const list = parseSelector(selector);
  for (const cx of list) if (matchComplex(el, cx, scope)) return true;
  return false;
}

/** A fast path for a lone `#id` selector (the common querySelector use). */
export function simpleIdSelector(selector: string): string | null {
  const m = /^\s*#((?:[-\w\u00a0-\uffff])+)\s*$/.exec(selector);
  return m ? m[1]! : null;
}
