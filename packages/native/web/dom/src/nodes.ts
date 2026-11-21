/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The node tree (DOM Living Standard §4, DOM-6/DOM-8): Node, CharacterData/Text/Comment/CDATASection/
// ProcessingInstruction, DocumentType, DocumentFragment, Attr/NamedNodeMap, NodeList/HTMLCollection, Element
// (attributes, classList, dataset, style, innerHTML, queries, geometry) and DOMTokenList. Nodes subclass the web
// glue's EventTarget and give it their parent chain (GET_THE_PARENT), so events capture and bubble through the
// tree to the document and the window. No layout: geometry is the fixed window rect of DOM-3 for the canvas, the
// body/html elements and ancestors of a connected canvas, zeros otherwise.

import { createStyle, resetStyle, type CSSStyleDeclaration } from './css.ts';
import {
  BaseEventTarget,
  G,
  GET_THE_PARENT,
  HTML_NS,
  XMLNS_NS,
  XML_NS,
  domException,
  lower,
  str,
  viewport,
} from './env.ts';
import { DOMRect, DOMRectList } from './geometry.ts';
import {
  parseInto,
  serializeChildren,
  serializeNode,
  type NodeFactory,
} from './html.ts';
import {
  notifyAttribute,
  notifyCharacterData,
  notifyChildList,
} from './observers.ts';
import {
  matchesSelector,
  parseSelector,
  simpleIdSelector,
  type MatchElement,
} from './selectors.ts';

// --- owner document --------------------------------------------------------------------------------------------

let defaultDocument: any = null;
/** The document new nodes belong to when created with a constructor (`new Text()`): the page's. */
export function setDefaultDocument(doc: unknown): void {
  defaultDocument = doc;
}
export function getDefaultDocument(): any {
  return defaultDocument;
}

// --- connected canvases (for getBoundingClientRect) ---------------------------------------------------------------

const connectedCanvases = new Set<Element>();
export function canvasConnected(el: Element, connected: boolean): void {
  if (connected) connectedCanvases.add(el);
  else connectedCanvases.delete(el);
}

// --- NodeList / HTMLCollection -----------------------------------------------------------------------------------

export class NodeList extends Array<Node> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }
  item(index: number): Node | null {
    return this[Number(index) >>> 0] ?? null;
  }
  override forEach(
    cb: (value: Node, index: number, list: Node[]) => void,
    thisArg?: unknown,
  ): void {
    for (let i = 0; i < this.length; i++) cb.call(thisArg, this[i]!, i, this);
  }
  get [Symbol.toStringTag](): string {
    return 'NodeList';
  }
}

export class HTMLCollection extends Array<Element> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }
  item(index: number): Element | null {
    return this[Number(index) >>> 0] ?? null;
  }
  namedItem(name: string): Element | null {
    const n = str(name);
    for (const el of this)
      if (el.id === n || el.getAttribute('name') === n) return el;
    return null;
  }
  get [Symbol.toStringTag](): string {
    return 'HTMLCollection';
  }
}

function collection(items: Element[]): HTMLCollection {
  const c = new HTMLCollection();
  for (const e of items) c.push(e);
  return c;
}

// --- Node ----------------------------------------------------------------------------------------------------

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_TYPE_NODE = 10;
const DOCUMENT_FRAGMENT_NODE = 11;

export class Node extends BaseEventTarget {
  static readonly ELEMENT_NODE = 1;
  static readonly ATTRIBUTE_NODE = 2;
  static readonly TEXT_NODE = 3;
  static readonly CDATA_SECTION_NODE = 4;
  static readonly ENTITY_REFERENCE_NODE = 5;
  static readonly ENTITY_NODE = 6;
  static readonly PROCESSING_INSTRUCTION_NODE = 7;
  static readonly COMMENT_NODE = 8;
  static readonly DOCUMENT_NODE = 9;
  static readonly DOCUMENT_TYPE_NODE = 10;
  static readonly DOCUMENT_FRAGMENT_NODE = 11;
  static readonly NOTATION_NODE = 12;
  static readonly DOCUMENT_POSITION_DISCONNECTED = 0x01;
  static readonly DOCUMENT_POSITION_PRECEDING = 0x02;
  static readonly DOCUMENT_POSITION_FOLLOWING = 0x04;
  static readonly DOCUMENT_POSITION_CONTAINS = 0x08;
  static readonly DOCUMENT_POSITION_CONTAINED_BY = 0x10;
  static readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 0x20;

  /** @internal */ _parent: Node | null = null;
  /** @internal */ _kids: NodeList | null = null;
  /** @internal */ _doc: any;

  constructor() {
    super();
    this._doc = defaultDocument;
  }

  get nodeType(): number {
    return 0;
  }
  get nodeName(): string {
    return '';
  }
  get nodeValue(): string | null {
    return null;
  }
  set nodeValue(_v: string | null) {
    // no-op for elements, documents and fragments
  }
  get ownerDocument(): any {
    return this.nodeType === DOCUMENT_NODE ? null : this._doc;
  }
  get parentNode(): Node | null {
    return this._parent;
  }
  get parentElement(): Element | null {
    return this._parent instanceof Element ? this._parent : null;
  }
  get childNodes(): NodeList {
    return (this._kids ??= new NodeList());
  }
  get firstChild(): Node | null {
    return this._kids?.[0] ?? null;
  }
  get lastChild(): Node | null {
    const k = this._kids;
    return k && k.length ? k[k.length - 1]! : null;
  }
  get previousSibling(): Node | null {
    const p = this._parent;
    if (!p || !p._kids) return null;
    const i = p._kids.indexOf(this);
    return i > 0 ? p._kids[i - 1]! : null;
  }
  get nextSibling(): Node | null {
    const p = this._parent;
    if (!p || !p._kids) return null;
    const i = p._kids.indexOf(this);
    return i >= 0 ? (p._kids[i + 1] ?? null) : null;
  }
  get isConnected(): boolean {
    return this.getRootNode().nodeType === DOCUMENT_NODE;
  }
  get baseURI(): string {
    const d = this.nodeType === DOCUMENT_NODE ? (this as any) : this._doc;
    return d ? String(d.baseURI) : '';
  }
  get textContent(): string | null {
    if (this.nodeType === DOCUMENT_NODE || this.nodeType === DOCUMENT_TYPE_NODE)
      return null;
    let out = '';
    const walk = (n: Node) => {
      const k = n._kids;
      if (!k) return;
      for (const c of k) {
        if (c instanceof CharacterData) {
          if (
            c.nodeType !== COMMENT_NODE &&
            c.nodeType !== PROCESSING_INSTRUCTION_NODE
          )
            out += c.data;
        } else walk(c);
      }
    };
    walk(this);
    return out;
  }
  set textContent(v: string | null) {
    if (this.nodeType === DOCUMENT_NODE || this.nodeType === DOCUMENT_TYPE_NODE)
      return;
    const text = v === null || v === undefined ? '' : str(v);
    replaceAll(this, text === '' ? null : this._doc.createTextNode(text));
  }
  getRootNode(_options?: unknown): Node {
    let n: Node = this;
    while (n._parent) n = n._parent;
    return n;
  }
  hasChildNodes(): boolean {
    return !!this._kids && this._kids.length > 0;
  }
  contains(other: Node | null): boolean {
    for (let n: Node | null = other; n; n = n._parent)
      if (n === this) return true;
    return false;
  }
  compareDocumentPosition(other: Node): number {
    if (other === this) return 0;
    if (this.getRootNode() !== other.getRootNode()) return 0x01 | 0x20 | 0x02;
    if (this.contains(other)) return 0x10 | 0x04;
    if (other.contains(this)) return 0x08 | 0x02;
    // Compare tree order through the first differing ancestors.
    const path = (n: Node) => {
      const p: Node[] = [];
      for (let x: Node | null = n; x; x = x._parent) p.unshift(x);
      return p;
    };
    const a = path(this);
    const b = path(other);
    let i = 0;
    while (a[i] === b[i]) i++;
    const parent = a[i - 1]!;
    return parent._kids!.indexOf(a[i]!) < parent._kids!.indexOf(b[i]!)
      ? 0x04
      : 0x02;
  }
  isEqualNode(other: Node | null): boolean {
    if (
      !other ||
      other.nodeType !== this.nodeType ||
      other.nodeName !== this.nodeName
    )
      return false;
    if (
      this instanceof CharacterData &&
      (other as CharacterData).data !== this.data
    )
      return false;
    if (this instanceof Element) {
      const o = other as Element;
      if (
        o.namespaceURI !== this.namespaceURI ||
        o._attrs.length !== this._attrs.length
      )
        return false;
      for (const a of this._attrs)
        if (o.getAttributeNS(a.ns, a.local) !== a.value) return false;
    }
    const ka = this._kids ?? [];
    const kb = other._kids ?? [];
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++)
      if (!ka[i]!.isEqualNode(kb[i]!)) return false;
    return true;
  }
  isSameNode(other: Node | null): boolean {
    return other === this;
  }
  lookupNamespaceURI(prefix: string | null): string | null {
    if (prefix === 'xml') return XML_NS;
    if (prefix === 'xmlns') return XMLNS_NS;
    for (let n: Node | null = this; n; n = n._parent) {
      if (n instanceof Element) {
        if (n.namespaceURI && (n.prefix ?? null) === (prefix || null))
          return n.namespaceURI;
        const v = prefix
          ? n.getAttributeNS(XMLNS_NS, prefix)
          : n.getAttributeNS(XMLNS_NS, 'xmlns');
        if (v !== null) return v || null;
      }
    }
    return null;
  }
  lookupPrefix(_namespace: string | null): string | null {
    return null;
  }
  isDefaultNamespace(namespace: string | null): boolean {
    return this.lookupNamespaceURI(null) === (namespace || null);
  }
  normalize(): void {
    const kids = this._kids;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (k.nodeType === TEXT_NODE) {
        let data = (k as Text).data;
        while (kids[i + 1]?.nodeType === TEXT_NODE) {
          data += (kids[i + 1] as Text).data;
          this.removeChild(kids[i + 1]!);
        }
        if (data === '') {
          this.removeChild(k);
          i--;
        } else (k as Text).data = data;
      } else k.normalize();
    }
  }
  appendChild<T extends Node>(node: T): T {
    return insert(this, node, null) as T;
  }
  insertBefore<T extends Node>(node: T, child: Node | null): T {
    return insert(this, node, child ?? null) as T;
  }
  removeChild<T extends Node>(child: T): T {
    if (!child || child._parent !== this)
      throw domException(
        "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
        'NotFoundError',
      );
    remove(child, true);
    return child;
  }
  replaceChild<T extends Node>(node: Node, child: T): T {
    if (!child || child._parent !== this)
      throw domException(
        "Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.",
        'NotFoundError',
      );
    if (node === child) return child;
    const next =
      child.nextSibling === node ? node.nextSibling : child.nextSibling;
    remove(child, true);
    insert(this, node, next);
    return child;
  }
  cloneNode(deep = false): Node {
    const c = this._clone(this._doc);
    if (deep)
      for (const k of this._kids ?? []) c.appendChild(k.cloneNode(true));
    return c;
  }
  /** @internal */ _clone(_doc: any): Node {
    return new (this.constructor as new () => Node)();
  }
  /** @internal: called when this node (or an ancestor) becomes connected / disconnected. */
  _connectedChanged(_connected: boolean): void {}
  get [Symbol.toStringTag](): string {
    return 'Node';
  }
}

// DOM "get the parent": the parent node; a document's is its window, except for `load` (HTML §8.1.8.4 / DOM §4.4).
Object.defineProperty(Node.prototype, GET_THE_PARENT, {
  value: function getTheParent(
    this: Node,
    event: { type?: string } | undefined,
  ): unknown {
    if (this._parent) return this._parent;
    if (this.nodeType === DOCUMENT_NODE && event?.type !== 'load')
      return (this as any)._defaultView ?? null;
    return null;
  },
  configurable: true,
  writable: true,
});

for (const [k, v] of Object.entries({
  ELEMENT_NODE,
  ATTRIBUTE_NODE: 2,
  TEXT_NODE,
  CDATA_SECTION_NODE,
  ENTITY_REFERENCE_NODE: 5,
  ENTITY_NODE: 6,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_TYPE_NODE,
  DOCUMENT_FRAGMENT_NODE,
  NOTATION_NODE: 12,
  DOCUMENT_POSITION_DISCONNECTED: 1,
  DOCUMENT_POSITION_PRECEDING: 2,
  DOCUMENT_POSITION_FOLLOWING: 4,
  DOCUMENT_POSITION_CONTAINS: 8,
  DOCUMENT_POSITION_CONTAINED_BY: 16,
  DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
})) {
  Object.defineProperty(Node.prototype, k, { value: v, enumerable: true });
}

function isConnectedTree(node: Node): boolean {
  return node.getRootNode().nodeType === DOCUMENT_NODE;
}

function forEachInclusiveDescendant(node: Node, fn: (n: Node) => void): void {
  fn(node);
  const k = node._kids;
  if (k)
    for (let i = 0; i < k.length; i++) forEachInclusiveDescendant(k[i]!, fn);
}

function adopt(node: Node, doc: any): void {
  if (!doc || node._doc === doc) return;
  forEachInclusiveDescendant(node, (n) => {
    n._doc = doc;
  });
}

/** Pre-insert (DOM §4.2.3), simplified: hierarchy checks, fragments, connection hooks, mutation records. */
function insert(parent: Node, node: Node, child: Node | null): Node {
  if (!(node instanceof Node))
    throw new TypeError(
      "Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.",
    );
  const pt = parent.nodeType;
  if (
    pt !== DOCUMENT_NODE &&
    pt !== DOCUMENT_FRAGMENT_NODE &&
    pt !== ELEMENT_NODE
  ) {
    throw domException(
      'This node type does not support children.',
      'HierarchyRequestError',
    );
  }
  if (node.contains(parent))
    throw domException(
      'The new child element contains the parent.',
      'HierarchyRequestError',
    );
  if (child && child._parent !== parent) {
    throw domException(
      "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
      'NotFoundError',
    );
  }
  if (node.nodeType === DOCUMENT_NODE)
    throw domException(
      'A document cannot be inserted.',
      'HierarchyRequestError',
    );
  const nodes: Node[] =
    node.nodeType === DOCUMENT_FRAGMENT_NODE ? [...(node._kids ?? [])] : [node];
  if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
    for (const n of nodes) remove(n, false);
    if (nodes.length) notifyChildList(node, [], nodes, null, null);
  } else if (node._parent) {
    if (child === node) child = node.nextSibling;
    remove(node, true);
  }
  if (!nodes.length) return node;
  const kids = (parent._kids ??= new NodeList());
  let index = child ? kids.indexOf(child) : kids.length;
  if (index < 0) index = kids.length;
  const prev = index > 0 ? kids[index - 1]! : null;
  const doc = parent.nodeType === DOCUMENT_NODE ? parent : parent._doc;
  for (const n of nodes) {
    adopt(n, doc);
    kids.splice(index++, 0, n);
    n._parent = parent;
  }
  notifyChildList(parent, nodes, [], prev, child);
  if (isConnectedTree(parent))
    for (const n of nodes)
      forEachInclusiveDescendant(n, (d) => d._connectedChanged(true));
  return node;
}

function remove(node: Node, notify: boolean): void {
  const parent = node._parent;
  if (!parent || !parent._kids) return;
  const wasConnected = isConnectedTree(parent);
  const kids = parent._kids;
  const i = kids.indexOf(node);
  const prev = i > 0 ? kids[i - 1]! : null;
  const next = kids[i + 1] ?? null;
  kids.splice(i, 1);
  node._parent = null;
  if (notify) notifyChildList(parent, [], [node], prev, next);
  if (wasConnected)
    forEachInclusiveDescendant(node, (d) => d._connectedChanged(false));
}

/** Replace all children with `node` (or nothing): textContent / innerHTML setters. */
function replaceAll(parent: Node, node: Node | null): void {
  const removed = [...(parent._kids ?? [])];
  const wasConnected = isConnectedTree(parent);
  for (const k of removed) k._parent = null;
  if (parent._kids) parent._kids.length = 0;
  const added: Node[] = [];
  if (node) {
    const nodes =
      node.nodeType === DOCUMENT_FRAGMENT_NODE
        ? [...(node._kids ?? [])]
        : [node];
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE && node._kids) {
      for (const n of nodes) n._parent = null;
      node._kids.length = 0;
    }
    const kids = (parent._kids ??= new NodeList());
    const doc = parent.nodeType === DOCUMENT_NODE ? parent : parent._doc;
    for (const n of nodes) {
      adopt(n, doc);
      kids.push(n);
      n._parent = parent;
      added.push(n);
    }
  }
  if (removed.length || added.length)
    notifyChildList(parent, added, removed, null, null);
  if (wasConnected)
    for (const r of removed)
      forEachInclusiveDescendant(r, (d) => d._connectedChanged(false));
  if (isConnectedTree(parent))
    for (const a of added)
      forEachInclusiveDescendant(a, (d) => d._connectedChanged(true));
}

function toNodes(doc: any, items: unknown[]): Node {
  if (items.length === 1 && items[0] instanceof Node) return items[0];
  const frag = doc.createDocumentFragment() as Node;
  for (const it of items)
    frag.appendChild(it instanceof Node ? it : doc.createTextNode(str(it)));
  return frag;
}

// ParentNode / ChildNode mixins (DOM §4.2.6-4.2.8).
const parentNodeMixin = {
  get children(): HTMLCollection {
    const self = this as unknown as Node;
    return collection(
      ([...(self._kids ?? [])] as Node[]).filter(
        (k) => k instanceof Element,
      ) as Element[],
    );
  },
  get firstElementChild(): Element | null {
    const self = this as unknown as Node;
    for (const k of self._kids ?? []) if (k instanceof Element) return k;
    return null;
  },
  get lastElementChild(): Element | null {
    const k = (this as unknown as Node)._kids ?? [];
    for (let i = k.length - 1; i >= 0; i--)
      if (k[i] instanceof Element) return k[i] as Element;
    return null;
  },
  get childElementCount(): number {
    let n = 0;
    for (const k of (this as unknown as Node)._kids ?? [])
      if (k instanceof Element) n++;
    return n;
  },
  append(this: Node, ...items: unknown[]): void {
    insert(
      this,
      toNodes(this.nodeType === DOCUMENT_NODE ? this : this._doc, items),
      null,
    );
  },
  prepend(this: Node, ...items: unknown[]): void {
    insert(
      this,
      toNodes(this.nodeType === DOCUMENT_NODE ? this : this._doc, items),
      this.firstChild,
    );
  },
  replaceChildren(this: Node, ...items: unknown[]): void {
    const doc = this.nodeType === DOCUMENT_NODE ? this : this._doc;
    replaceAll(this, items.length ? toNodes(doc, items) : null);
  },
  querySelector(this: Node, selectors: string): Element | null {
    const sel = str(selectors);
    const id = simpleIdSelector(sel);
    let found: Element | null = null;
    walkElements(
      this,
      (el) => {
        if (
          id !== null
            ? el.id === id
            : matchesSelector(
                el as unknown as MatchElement,
                sel,
                this instanceof Element
                  ? (this as unknown as MatchElement)
                  : null,
              )
        ) {
          found = el;
          return true;
        }
        return false;
      },
      () => parseSelector(sel),
    );
    return found;
  },
  querySelectorAll(this: Node, selectors: string): NodeList {
    const sel = str(selectors);
    const out = new NodeList();
    walkElements(
      this,
      (el) => {
        if (
          matchesSelector(
            el as unknown as MatchElement,
            sel,
            this instanceof Element ? (this as unknown as MatchElement) : null,
          )
        )
          out.push(el);
        return false;
      },
      () => parseSelector(sel),
    );
    return out;
  },
  getElementsByTagName(this: Node, qualifiedName: string): HTMLCollection {
    const q = str(qualifiedName);
    const lq = lower(q);
    const out: Element[] = [];
    walkElements(this, (el) => {
      if (
        q === '*' ||
        (el.namespaceURI === HTML_NS
          ? el.localName === lq || el.tagName === q
          : el.tagName === q || el.localName === q)
      )
        out.push(el);
      return false;
    });
    return collection(out);
  },
  getElementsByTagNameNS(
    this: Node,
    ns: string | null,
    localName: string,
  ): HTMLCollection {
    const out: Element[] = [];
    walkElements(this, (el) => {
      if (
        (ns === '*' || el.namespaceURI === (ns || null)) &&
        (localName === '*' || el.localName === localName)
      )
        out.push(el);
      return false;
    });
    return collection(out);
  },
  getElementsByClassName(this: Node, classNames: string): HTMLCollection {
    const want = str(classNames)
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    const out: Element[] = [];
    if (!want.length) return collection(out);
    walkElements(this, (el) => {
      const have = (el.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/);
      if (want.every((w) => have.includes(w))) out.push(el);
      return false;
    });
    return collection(out);
  },
};

const childNodeMixin = {
  before(this: Node, ...items: unknown[]): void {
    const p = this._parent;
    if (p) insert(p, toNodes(this._doc, items), this);
  },
  after(this: Node, ...items: unknown[]): void {
    const p = this._parent;
    if (p) insert(p, toNodes(this._doc, items), this.nextSibling);
  },
  replaceWith(this: Node, ...items: unknown[]): void {
    const p = this._parent;
    if (!p) return;
    const next = this.nextSibling;
    const frag = toNodes(this._doc, items);
    remove(this, true);
    insert(p, frag, next && next._parent === p ? next : null);
  },
  remove(this: Node): void {
    if (this._parent) remove(this, true);
  },
};

const nonDocumentTypeChildMixin = {
  get previousElementSibling(): Element | null {
    for (
      let s = (this as unknown as Node).previousSibling;
      s;
      s = s.previousSibling
    )
      if (s instanceof Element) return s;
    return null;
  },
  get nextElementSibling(): Element | null {
    for (let s = (this as unknown as Node).nextSibling; s; s = s.nextSibling)
      if (s instanceof Element) return s;
    return null;
  },
};

export function applyMixin(target: object, mixin: object): void {
  for (const key of Object.getOwnPropertyNames(mixin)) {
    const d = Object.getOwnPropertyDescriptor(mixin, key)!;
    Object.defineProperty(target, key, {
      ...d,
      enumerable: true,
      configurable: true,
    });
  }
}

/** Depth-first pre-order walk of the element descendants of `root`; `fn` returns true to stop. */
function walkElements(
  root: Node,
  fn: (el: Element) => boolean,
  validate?: () => unknown,
): void {
  validate?.();
  const stack: Node[] = [];
  const k = root._kids;
  if (k) for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]!);
  while (stack.length) {
    const n = stack.pop()!;
    if (n instanceof Element && fn(n)) return;
    const kids =
      n instanceof Element && n.localName === 'template' && (n as any)._content
        ? null
        : n._kids;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}

// --- CharacterData -----------------------------------------------------------------------------------------------

export class CharacterData extends Node {
  /** @internal */ _data: string;
  constructor(data = '') {
    super();
    this._data = str(data);
  }
  get data(): string {
    return this._data;
  }
  set data(v: string) {
    const old = this._data;
    this._data = v === null ? '' : str(v);
    notifyCharacterData(this, old);
  }
  override get nodeValue(): string {
    return this._data;
  }
  override set nodeValue(v: string | null) {
    this.data = v ?? '';
  }
  override get textContent(): string {
    return this._data;
  }
  override set textContent(v: string | null) {
    this.data = v ?? '';
  }
  get length(): number {
    return this._data.length;
  }
  substringData(offset: number, count: number): string {
    return this._data.substr(offset, count);
  }
  appendData(data: string): void {
    this.data = this._data + str(data);
  }
  insertData(offset: number, data: string): void {
    this.data =
      this._data.slice(0, offset) + str(data) + this._data.slice(offset);
  }
  deleteData(offset: number, count: number): void {
    this.data = this._data.slice(0, offset) + this._data.slice(offset + count);
  }
  replaceData(offset: number, count: number, data: string): void {
    this.data =
      this._data.slice(0, offset) +
      str(data) +
      this._data.slice(offset + count);
  }
  override _clone(_doc: any): Node {
    return new (this.constructor as new (d: string) => Node)(this._data);
  }
  override get [Symbol.toStringTag](): string {
    return 'CharacterData';
  }
}
applyMixin(CharacterData.prototype, childNodeMixin);
applyMixin(CharacterData.prototype, nonDocumentTypeChildMixin);

export class Text extends CharacterData {
  override get nodeType(): number {
    return TEXT_NODE;
  }
  override get nodeName(): string {
    return '#text';
  }
  get wholeText(): string {
    return this._data;
  }
  splitText(offset: number): Text {
    const rest = new Text(this._data.slice(offset));
    rest._doc = this._doc;
    this.data = this._data.slice(0, offset);
    if (this._parent) insert(this._parent, rest, this.nextSibling);
    return rest;
  }
  override get [Symbol.toStringTag](): string {
    return 'Text';
  }
}

export class CDATASection extends Text {
  override get nodeType(): number {
    return CDATA_SECTION_NODE;
  }
  override get nodeName(): string {
    return '#cdata-section';
  }
  override get [Symbol.toStringTag](): string {
    return 'CDATASection';
  }
}

export class Comment extends CharacterData {
  override get nodeType(): number {
    return COMMENT_NODE;
  }
  override get nodeName(): string {
    return '#comment';
  }
  override get [Symbol.toStringTag](): string {
    return 'Comment';
  }
}

export class ProcessingInstruction extends CharacterData {
  /** @internal */ _target = '';
  get target(): string {
    return this._target;
  }
  override get nodeType(): number {
    return PROCESSING_INSTRUCTION_NODE;
  }
  override get nodeName(): string {
    return this._target;
  }
  override _clone(_doc: any): Node {
    const c = new ProcessingInstruction(this._data);
    c._target = this._target;
    return c;
  }
  override get [Symbol.toStringTag](): string {
    return 'ProcessingInstruction';
  }
}

export class DocumentType extends Node {
  /** @internal */ _name = '';
  /** @internal */ _publicId = '';
  /** @internal */ _systemId = '';
  get name(): string {
    return this._name;
  }
  get publicId(): string {
    return this._publicId;
  }
  get systemId(): string {
    return this._systemId;
  }
  override get nodeType(): number {
    return DOCUMENT_TYPE_NODE;
  }
  override get nodeName(): string {
    return this._name;
  }
  override _clone(_doc: any): Node {
    const c = new DocumentType();
    c._name = this._name;
    c._publicId = this._publicId;
    c._systemId = this._systemId;
    return c;
  }
  override get [Symbol.toStringTag](): string {
    return 'DocumentType';
  }
}
applyMixin(DocumentType.prototype, childNodeMixin);

export class DocumentFragment extends Node {
  override get nodeType(): number {
    return DOCUMENT_FRAGMENT_NODE;
  }
  override get nodeName(): string {
    return '#document-fragment';
  }
  getElementById(id: string): Element | null {
    const want = str(id);
    let found: Element | null = null;
    walkElements(this, (el) => {
      if (el.id === want) {
        found = el;
        return true;
      }
      return false;
    });
    return found;
  }
  override _clone(_doc: any): Node {
    const f = new DocumentFragment();
    f._doc = _doc;
    return f;
  }
  override get [Symbol.toStringTag](): string {
    return 'DocumentFragment';
  }
}
applyMixin(DocumentFragment.prototype, parentNodeMixin);

export class ShadowRoot extends DocumentFragment {
  /** @internal */ _host: Element | null = null;
  /** @internal */ _mode = 'open';
  get host(): Element | null {
    return this._host;
  }
  get mode(): string {
    return this._mode;
  }
  get innerHTML(): string {
    return serializeChildren(this as any);
  }
  set innerHTML(v: string) {
    const frag = this._doc.createDocumentFragment();
    parseInto(frag, str(v), this._doc as NodeFactory);
    replaceAll(this, frag);
  }
  override get [Symbol.toStringTag](): string {
    return 'ShadowRoot';
  }
}

// --- Attr / NamedNodeMap -----------------------------------------------------------------------------------------

export interface AttrRecord {
  ns: string | null;
  prefix: string | null;
  local: string;
  /** Qualified name. */
  name: string;
  value: string;
}

export class Attr extends Node {
  /** @internal */ _rec: AttrRecord;
  /** @internal */ _owner: Element | null;
  constructor(rec?: AttrRecord, owner: Element | null = null) {
    super();
    this._rec = rec ?? {
      ns: null,
      prefix: null,
      local: '',
      name: '',
      value: '',
    };
    this._owner = owner;
  }
  override get nodeType(): number {
    return 2;
  }
  override get nodeName(): string {
    return this._rec.name;
  }
  get name(): string {
    return this._rec.name;
  }
  get localName(): string {
    return this._rec.local;
  }
  get namespaceURI(): string | null {
    return this._rec.ns;
  }
  get prefix(): string | null {
    return this._rec.prefix;
  }
  get value(): string {
    return this._owner
      ? (this._owner.getAttributeNS(this._rec.ns, this._rec.local) ??
          this._rec.value)
      : this._rec.value;
  }
  set value(v: string) {
    if (this._owner)
      this._owner.setAttributeNS(this._rec.ns, this._rec.name, str(v));
    else this._rec.value = str(v);
  }
  override get nodeValue(): string {
    return this.value;
  }
  override get textContent(): string {
    return this.value;
  }
  get ownerElement(): Element | null {
    return this._owner;
  }
  get specified(): boolean {
    return true;
  }
  override get [Symbol.toStringTag](): string {
    return 'Attr';
  }
}

export class NamedNodeMap extends Array<Attr> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }
  /** @internal */ declare _owner: Element;
  item(i: number): Attr | null {
    return this[Number(i) >>> 0] ?? null;
  }
  getNamedItem(name: string): Attr | null {
    return this._owner.getAttributeNode(name);
  }
  getNamedItemNS(ns: string | null, local: string): Attr | null {
    return this._owner.getAttributeNodeNS(ns, local);
  }
  setNamedItem(attr: Attr): Attr | null {
    return this._owner.setAttributeNode(attr);
  }
  removeNamedItem(name: string): Attr {
    const a = this._owner.getAttributeNode(name);
    if (!a)
      throw domException(
        `No item with name '${name}' was found.`,
        'NotFoundError',
      );
    this._owner.removeAttribute(name);
    return a;
  }
  get [Symbol.toStringTag](): string {
    return 'NamedNodeMap';
  }
}

// --- DOMTokenList -----------------------------------------------------------------------------------------------

export class DOMTokenList {
  /** @internal */ _el: Element;
  /** @internal */ _attr: string;
  /** @internal */ _supported: Set<string> | null;
  constructor(el: Element, attr: string, supported: string[] | null = null) {
    this._el = el;
    this._attr = attr;
    this._supported = supported ? new Set(supported) : null;
  }
  /** @internal */ _tokens(): string[] {
    const v = this._el.getAttribute(this._attr);
    if (!v) return [];
    const out: string[] = [];
    for (const t of v.split(/[\t\n\f\r ]+/))
      if (t && !out.includes(t)) out.push(t);
    return out;
  }
  /** @internal */ _write(tokens: string[]): void {
    this._el.setAttribute(this._attr, tokens.join(' '));
  }
  /** @internal */ _check(t: string): string {
    const s = str(t);
    if (s === '')
      throw domException(
        'The token provided must not be empty.',
        'SyntaxError',
      );
    if (/[\t\n\f\r ]/.test(s))
      throw domException(
        `The token provided ('${s}') contains HTML space characters, which are not valid in tokens.`,
        'InvalidCharacterError',
      );
    return s;
  }
  get length(): number {
    return this._tokens().length;
  }
  get value(): string {
    return this._el.getAttribute(this._attr) ?? '';
  }
  set value(v: string) {
    this._el.setAttribute(this._attr, str(v));
  }
  item(i: number): string | null {
    return this._tokens()[Number(i) >>> 0] ?? null;
  }
  contains(token: string): boolean {
    return this._tokens().includes(str(token));
  }
  add(...tokens: string[]): void {
    const checked = tokens.map((t) => this._check(t));
    const list = this._tokens();
    for (const t of checked) if (!list.includes(t)) list.push(t);
    this._write(list);
  }
  remove(...tokens: string[]): void {
    const checked = tokens.map((t) => this._check(t));
    this._write(this._tokens().filter((t) => !checked.includes(t)));
  }
  toggle(token: string, force?: boolean): boolean {
    const t = this._check(token);
    const list = this._tokens();
    const has = list.includes(t);
    if (has && force !== true) {
      this._write(list.filter((x) => x !== t));
      return false;
    }
    if (!has && force !== false) {
      list.push(t);
      this._write(list);
      return true;
    }
    return has;
  }
  replace(token: string, newToken: string): boolean {
    const a = this._check(token);
    const b = this._check(newToken);
    const list = this._tokens();
    const i = list.indexOf(a);
    if (i < 0) return false;
    if (list.includes(b)) list.splice(i, 1);
    else list[i] = b;
    this._write(list);
    return true;
  }
  supports(token: string): boolean {
    if (!this._supported)
      throw new TypeError(`DOMTokenList has no supported tokens.`);
    return this._supported.has(lower(str(token)));
  }
  forEach(
    cb: (value: string, index: number, list: DOMTokenList) => void,
    thisArg?: unknown,
  ): void {
    this._tokens().forEach((t, i) => cb.call(thisArg, t, i, this));
  }
  keys(): IterableIterator<number> {
    return this._tokens().keys();
  }
  values(): IterableIterator<string> {
    return this._tokens().values();
  }
  entries(): IterableIterator<[number, string]> {
    return this._tokens().entries();
  }
  [Symbol.iterator](): IterableIterator<string> {
    return this._tokens()[Symbol.iterator]();
  }
  toString(): string {
    return this.value;
  }
  get [Symbol.toStringTag](): string {
    return 'DOMTokenList';
  }
}

// --- Element ------------------------------------------------------------------------------------------------------

const NAME_RE = /^[^\s"'>/=\x00-\x1f\x7f]+$/;

/** Interface name -> local name, for `new HTMLImageElement()`-style construction by other runtime layers. */
const TAG_OF_INTERFACE: Record<string, string> = {
  HTMLImageElement: 'img',
  HTMLCanvasElement: 'canvas',
  HTMLVideoElement: 'video',
  HTMLAudioElement: 'audio',
  HTMLDivElement: 'div',
  HTMLSpanElement: 'span',
  HTMLInputElement: 'input',
  HTMLAnchorElement: 'a',
  HTMLScriptElement: 'script',
  HTMLLinkElement: 'link',
  HTMLStyleElement: 'style',
  HTMLButtonElement: 'button',
  HTMLTextAreaElement: 'textarea',
  HTMLParagraphElement: 'p',
  HTMLBodyElement: 'body',
  HTMLHeadElement: 'head',
  HTMLHtmlElement: 'html',
  HTMLTemplateElement: 'template',
  HTMLIFrameElement: 'iframe',
  HTMLSelectElement: 'select',
  HTMLOptionElement: 'option',
  HTMLLabelElement: 'label',
  HTMLFormElement: 'form',
  HTMLMetaElement: 'meta',
  HTMLTitleElement: 'title',
  HTMLSourceElement: 'source',
  HTMLPreElement: 'pre',
  HTMLUListElement: 'ul',
  HTMLOListElement: 'ol',
  HTMLLIElement: 'li',
  HTMLTableElement: 'table',
  HTMLBRElement: 'br',
  HTMLHRElement: 'hr',
};

const dataKey = (prop: string) =>
  `data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
const dataProp = (attr: string) =>
  attr.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export class Element extends Node {
  /** @internal */ _ns: string | null;
  /** @internal */ _prefix: string | null;
  /** @internal */ _local: string;
  /** @internal */ _attrs: AttrRecord[] = [];
  /** @internal */ _style: CSSStyleDeclaration | null = null;
  /** @internal */ _styleSync = false;
  /** @internal */ _classList: DOMTokenList | null = null;
  /** @internal */ _dataset: Record<string, string> | null = null;
  /** @internal */ _shadow: ShadowRoot | null = null;
  scrollTop = 0;
  scrollLeft = 0;

  constructor(
    localName?: string,
    namespace?: string | null,
    prefix?: string | null,
  ) {
    super();
    const fromInterface = (new.target as { name?: string }).name ?? '';
    const tag = (new.target.prototype as unknown as Record<symbol, unknown>)[
      Symbol.toStringTag
    ];
    const name =
      localName ??
      TAG_OF_INTERFACE[fromInterface] ??
      (typeof tag === 'string' ? TAG_OF_INTERFACE[tag] : undefined) ??
      'div';
    this._ns = namespace === undefined ? HTML_NS : namespace;
    this._prefix = prefix ?? null;
    this._local = name;
  }
  override get nodeType(): number {
    return ELEMENT_NODE;
  }
  override get nodeName(): string {
    return this.tagName;
  }
  get namespaceURI(): string | null {
    return this._ns;
  }
  get prefix(): string | null {
    return this._prefix;
  }
  get localName(): string {
    return this._local;
  }
  get tagName(): string {
    const q = this._prefix ? `${this._prefix}:${this._local}` : this._local;
    return this._ns === HTML_NS && this._isHTMLDocument() ? q.toUpperCase() : q;
  }
  /** @internal */ _isHTMLDocument(): boolean {
    return !this._doc || this._doc._isHTML !== false;
  }
  /** @internal */ _attrName(name: string): string {
    return this._ns === HTML_NS && this._isHTMLDocument() ? lower(name) : name;
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  set id(v: string) {
    this.setAttribute('id', str(v));
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(v: string) {
    this.setAttribute('class', str(v));
  }
  get slot(): string {
    return this.getAttribute('slot') ?? '';
  }
  set slot(v: string) {
    this.setAttribute('slot', str(v));
  }
  get classList(): DOMTokenList {
    return (this._classList ??= new DOMTokenList(this, 'class'));
  }
  set classList(v: string) {
    this.setAttribute('class', str(v));
  }
  get dataset(): Record<string, string> {
    if (this._dataset) return this._dataset;
    const el = this;
    this._dataset = new Proxy({} as Record<string, string>, {
      get(_t, key) {
        if (typeof key !== 'string') return undefined;
        return el.getAttribute(dataKey(key)) ?? undefined;
      },
      set(_t, key, value) {
        if (typeof key !== 'string') return false;
        el.setAttribute(dataKey(key), str(value));
        return true;
      },
      deleteProperty(_t, key) {
        if (typeof key === 'string') el.removeAttribute(dataKey(key));
        return true;
      },
      has(_t, key) {
        return typeof key === 'string' && el.hasAttribute(dataKey(key));
      },
      ownKeys() {
        return el._attrs
          .filter((a) => a.ns === null && a.name.startsWith('data-'))
          .map((a) => dataProp(a.name));
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key !== 'string' || !el.hasAttribute(dataKey(key)))
          return undefined;
        return {
          value: el.getAttribute(dataKey(key)),
          writable: true,
          enumerable: true,
          configurable: true,
        };
      },
    });
    return this._dataset;
  }
  get style(): CSSStyleDeclaration {
    if (!this._style) {
      this._style = createStyle(this.getAttribute('style') ?? '', (css) => {
        this._styleSync = true;
        try {
          if (css === '') this.removeAttribute('style');
          else this.setAttribute('style', css);
        } finally {
          this._styleSync = false;
        }
      });
    }
    return this._style;
  }
  set style(v: string) {
    this.style.cssText = str(v);
  }
  get attributes(): NamedNodeMap {
    const m = new NamedNodeMap();
    Object.defineProperty(m, '_owner', { value: this });
    for (const a of this._attrs) m.push(new Attr(a, this));
    return m;
  }
  hasAttributes(): boolean {
    return this._attrs.length > 0;
  }
  getAttributeNames(): string[] {
    return this._attrs.map((a) => a.name);
  }
  /** @internal */ _find(name: string): AttrRecord | undefined {
    const n = this._attrName(name);
    for (const a of this._attrs) if (a.name === n) return a;
    return undefined;
  }
  /** @internal */ _findNS(
    ns: string | null,
    local: string,
  ): AttrRecord | undefined {
    const want = ns || null;
    for (const a of this._attrs)
      if (a.ns === want && a.local === local) return a;
    return undefined;
  }
  getAttribute(name: string): string | null {
    return this._find(str(name))?.value ?? null;
  }
  getAttributeNS(ns: string | null, local: string): string | null {
    return this._findNS(ns, str(local))?.value ?? null;
  }
  hasAttribute(name: string): boolean {
    return this._find(str(name)) !== undefined;
  }
  hasAttributeNS(ns: string | null, local: string): boolean {
    return this._findNS(ns, str(local)) !== undefined;
  }
  setAttribute(name: string, value: string): void {
    const raw = str(name);
    if (!NAME_RE.test(raw))
      throw domException(
        `Failed to execute 'setAttribute' on 'Element': '${raw}' is not a valid attribute name.`,
        'InvalidCharacterError',
      );
    const n = this._attrName(raw);
    const v = str(value);
    const rec = this._find(n);
    const old = rec ? rec.value : null;
    if (rec) rec.value = v;
    else
      this._attrs.push({ ns: null, prefix: null, local: n, name: n, value: v });
    this._attributeChanged(n, null, old, v);
  }
  setAttributeNS(
    ns: string | null,
    qualifiedName: string,
    value: string,
  ): void {
    const q = str(qualifiedName);
    if (!NAME_RE.test(q))
      throw domException(
        `'${q}' is not a valid attribute name.`,
        'InvalidCharacterError',
      );
    const colon = q.indexOf(':');
    const prefix = colon > 0 ? q.slice(0, colon) : null;
    const local = colon > 0 ? q.slice(colon + 1) : q;
    const namespace = ns || null;
    const v = str(value);
    const rec = this._findNS(namespace, local);
    const old = rec ? rec.value : null;
    if (rec) {
      rec.value = v;
      rec.prefix = prefix;
      rec.name = q;
    } else
      this._attrs.push({ ns: namespace, prefix, local, name: q, value: v });
    this._attributeChanged(local, namespace, old, v);
  }
  removeAttribute(name: string): void {
    const n = this._attrName(str(name));
    const i = this._attrs.findIndex((a) => a.name === n);
    if (i < 0) return;
    const old = this._attrs[i]!.value;
    this._attrs.splice(i, 1);
    this._attributeChanged(n, null, old, null);
  }
  removeAttributeNS(ns: string | null, local: string): void {
    const want = ns || null;
    const i = this._attrs.findIndex((a) => a.ns === want && a.local === local);
    if (i < 0) return;
    const old = this._attrs[i]!.value;
    this._attrs.splice(i, 1);
    this._attributeChanged(local, want, old, null);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const n = str(name);
    const has = this.hasAttribute(n);
    if (has && force !== true) {
      this.removeAttribute(n);
      return false;
    }
    if (!has && force !== false) {
      this.setAttribute(n, '');
      return true;
    }
    return has;
  }
  getAttributeNode(name: string): Attr | null {
    const r = this._find(str(name));
    return r ? new Attr(r, this) : null;
  }
  getAttributeNodeNS(ns: string | null, local: string): Attr | null {
    const r = this._findNS(ns, str(local));
    return r ? new Attr(r, this) : null;
  }
  setAttributeNode(attr: Attr): Attr | null {
    const old = this.getAttributeNode(attr.name);
    if (attr.namespaceURI)
      this.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    else this.setAttribute(attr.name, attr.value);
    attr._owner = this;
    return old;
  }
  setAttributeNodeNS(attr: Attr): Attr | null {
    return this.setAttributeNode(attr);
  }
  removeAttributeNode(attr: Attr): Attr {
    this.removeAttributeNS(attr.namespaceURI, attr.localName);
    return attr;
  }
  /** @internal: reflection and mutation records for every attribute change. */
  _attributeChanged(
    local: string,
    ns: string | null,
    old: string | null,
    value: string | null,
  ): void {
    if (local === 'style' && ns === null && this._style && !this._styleSync)
      resetStyle(this._style, value ?? '');
    notifyAttribute(this, local, ns, old);
    this._reflect(local, ns, old, value);
  }
  /** @internal: subclasses react to their own attributes (src, width, ...). */
  _reflect(
    _local: string,
    _ns: string | null,
    _old: string | null,
    _value: string | null,
  ): void {}

  matches(selectors: string): boolean {
    return matchesSelector(
      this as unknown as MatchElement,
      str(selectors),
      this as unknown as MatchElement,
    );
  }
  webkitMatchesSelector(selectors: string): boolean {
    return this.matches(selectors);
  }
  closest(selectors: string): Element | null {
    const sel = str(selectors);
    parseSelector(sel);
    for (let n: Node | null = this; n instanceof Element; n = n._parent) {
      if (
        matchesSelector(
          n as unknown as MatchElement,
          sel,
          this as unknown as MatchElement,
        )
      )
        return n;
    }
    return null;
  }
  get innerHTML(): string {
    return serializeChildren(
      this as any,
      !this._isHTMLDocument() || this._ns !== HTML_NS,
    );
  }
  set innerHTML(v: string) {
    const doc = this._doc;
    const frag = doc.createDocumentFragment();
    const res = parseInto(frag, v === null ? '' : str(v), doc as NodeFactory, {
      xml: !this._isHTMLDocument(),
      contextNs: this._ns,
    });
    markParserScripts(res.scripts);
    // a template's markup replaces its contents (HTML innerHTML setter), not its children
    const target =
      this.localName === 'template' &&
      this._ns === HTML_NS &&
      (this as any).content
        ? (this as any).content
        : this;
    replaceAll(target, frag);
  }
  get outerHTML(): string {
    return serializeNode(
      this as any,
      !this._isHTMLDocument() || this._ns !== HTML_NS,
    );
  }
  set outerHTML(v: string) {
    const p = this._parent;
    if (!p) return;
    if (p.nodeType === DOCUMENT_NODE)
      throw domException(
        'This element has no parent element.',
        'NoModificationAllowedError',
      );
    const frag = this._doc.createDocumentFragment();
    markParserScripts(
      parseInto(frag, str(v), this._doc as NodeFactory, {
        contextNs: (p as Element)._ns ?? HTML_NS,
      }).scripts,
    );
    const next = this.nextSibling;
    remove(this, true);
    insert(p, frag, next);
  }
  insertAdjacentHTML(position: string, text: string): void {
    const frag = this._doc.createDocumentFragment();
    markParserScripts(
      parseInto(frag, str(text), this._doc as NodeFactory, {
        contextNs: this._ns,
      }).scripts,
    );
    this._insertAdjacent(position, frag);
  }
  insertAdjacentElement(position: string, el: Element): Element | null {
    return this._insertAdjacent(position, el) ? el : null;
  }
  insertAdjacentText(position: string, data: string): void {
    this._insertAdjacent(position, this._doc.createTextNode(str(data)));
  }
  /** @internal */ _insertAdjacent(position: string, node: Node): boolean {
    switch (lower(str(position))) {
      case 'beforebegin':
        if (!this._parent) return false;
        insert(this._parent, node, this);
        return true;
      case 'afterbegin':
        insert(this, node, this.firstChild);
        return true;
      case 'beforeend':
        insert(this, node, null);
        return true;
      case 'afterend':
        if (!this._parent) return false;
        insert(this._parent, node, this.nextSibling);
        return true;
      default:
        throw domException(
          `The value provided ('${position}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`,
          'SyntaxError',
        );
    }
  }
  get innerText(): string {
    return this.textContent ?? '';
  }
  set innerText(v: string) {
    this.textContent = v;
  }
  get outerText(): string {
    return this.textContent ?? '';
  }
  attachShadow(init: { mode?: string } = {}): ShadowRoot {
    if (this._shadow)
      throw domException(
        'Shadow root cannot be created on a host which already hosts a shadow tree.',
        'NotSupportedError',
      );
    const root = new ShadowRoot();
    root._doc = this._doc;
    root._host = this;
    root._mode = init.mode === 'closed' ? 'closed' : 'open';
    this._shadow = root;
    return root;
  }
  get shadowRoot(): ShadowRoot | null {
    return this._shadow && this._shadow._mode === 'open' ? this._shadow : null;
  }
  // Geometry (CSSOM View, DOM-8): no layout. The window rect for the canvas and what holds it, zeros otherwise.
  /** @internal */ _fillsWindow(): boolean {
    if (this.localName === 'canvas' && this._ns === HTML_NS) return true;
    if (
      this._ns === HTML_NS &&
      (this.localName === 'body' || this.localName === 'html')
    )
      return true;
    for (const c of connectedCanvases) if (this.contains(c)) return true;
    return false;
  }
  getBoundingClientRect(): DOMRect {
    if (!this._fillsWindow()) return new DOMRect(0, 0, 0, 0);
    const v = viewport();
    return new DOMRect(0, 0, v.width, v.height);
  }
  getClientRects(): DOMRectList {
    const l = new DOMRectList();
    if (this._fillsWindow()) l.push(this.getBoundingClientRect());
    return l;
  }
  get clientWidth(): number {
    return this._fillsWindow() ? viewport().width : 0;
  }
  get clientHeight(): number {
    return this._fillsWindow() ? viewport().height : 0;
  }
  get clientTop(): number {
    return 0;
  }
  get clientLeft(): number {
    return 0;
  }
  get scrollWidth(): number {
    return this.clientWidth;
  }
  get scrollHeight(): number {
    return this.clientHeight;
  }
  scrollTo(..._args: unknown[]): void {}
  scrollBy(..._args: unknown[]): void {}
  scroll(..._args: unknown[]): void {}
  scrollIntoView(_arg?: unknown): void {}
  // Pointer capture / lock / fullscreen: accepted, nothing to capture without a 2D page (DOM-8).
  setPointerCapture(_id: number): void {}
  releasePointerCapture(_id: number): void {}
  hasPointerCapture(_id: number): boolean {
    return false;
  }
  requestPointerLock(_options?: unknown): Promise<void> {
    return Promise.resolve();
  }
  requestFullscreen(_options?: unknown): Promise<void> {
    return Promise.resolve();
  }
  animate(): {
    cancel(): void;
    finished: Promise<void>;
    play(): void;
    pause(): void;
  } {
    return { cancel() {}, finished: Promise.resolve(), play() {}, pause() {} };
  }
  getAnimations(): unknown[] {
    return [];
  }
  override _clone(doc: any): Node {
    const c = doc.createElementNS(
      this._ns,
      this._prefix ? `${this._prefix}:${this._local}` : this._local,
    ) as Element;
    for (const a of this._attrs) c._attrs.push({ ...a });
    for (const a of this._attrs) c._reflect(a.local, a.ns, null, a.value);
    return c;
  }
  override get [Symbol.toStringTag](): string {
    return 'Element';
  }
}
applyMixin(Element.prototype, parentNodeMixin);
applyMixin(Element.prototype, childNodeMixin);
applyMixin(Element.prototype, nonDocumentTypeChildMixin);

export interface Element {
  readonly children: HTMLCollection;
  readonly firstElementChild: Element | null;
  readonly lastElementChild: Element | null;
  readonly childElementCount: number;
  readonly previousElementSibling: Element | null;
  readonly nextElementSibling: Element | null;
  append(...items: unknown[]): void;
  prepend(...items: unknown[]): void;
  replaceChildren(...items: unknown[]): void;
  querySelector(selectors: string): Element | null;
  querySelectorAll(selectors: string): NodeList;
  getElementsByTagName(name: string): HTMLCollection;
  getElementsByClassName(names: string): HTMLCollection;
  before(...items: unknown[]): void;
  after(...items: unknown[]): void;
  replaceWith(...items: unknown[]): void;
  remove(): void;
}
export interface DocumentFragment {
  readonly children: HTMLCollection;
  querySelector(selectors: string): Element | null;
  querySelectorAll(selectors: string): NodeList;
  append(...items: unknown[]): void;
}

/** Scripts the parser created never run (the core already ran the entry document's; innerHTML scripts never run). */
export const ALREADY_STARTED = Symbol('iwn.dom.alreadyStarted');
function markParserScripts(scripts: unknown[]): void {
  for (const s of scripts)
    (s as Record<symbol, boolean>)[ALREADY_STARTED] = true;
}
export { markParserScripts };

export const mixins = {
  parentNodeMixin,
  childNodeMixin,
  nonDocumentTypeChildMixin,
};
export {
  insert as insertNode,
  replaceAll as replaceAllChildren,
  walkElements,
  forEachInclusiveDescendant,
};

/** For tests and diagnostics. */
export function connectedCanvasCount(): number {
  return connectedCanvases.size;
}

void G;
