/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Document, XMLDocument, DOMImplementation, DOMParser, XMLSerializer, a minimal Range/Selection and TreeWalker
// (DOM-6, DOM-7, DOM-10). The page's document follows the core's lifecycle state (readyState, visibilityState,
// focus) and its URL (location); documents from DOMParser or createHTMLDocument are inert (their scripts never run).

import {
  G,
  HTML_NS,
  SVG_NS,
  XMLNS_NS,
  defineHandler,
  documentURL,
  domException,
  lifecycle,
  lower,
  str,
  warn,
} from './env.ts';
import { DOMRect, DOMRectList } from './geometry.ts';
import {
  HTMLBodyElement,
  HTMLElement,
  HTMLHeadElement,
  HTMLHtmlElement,
  HTMLTitleElement,
  HTMLUnknownElement,
  HTML_TAGS,
  GLOBAL_HANDLERS,
  PLAIN_HTML_ELEMENT_TAGS,
  SVGElement,
  SVGSVGElement,
} from './html-elements.ts';
import {
  isHeadElement,
  parseInto,
  serializeNode,
  type NodeFactory,
} from './html.ts';
import {
  ALREADY_STARTED,
  Attr,
  CDATASection,
  Comment,
  DocumentFragment,
  DocumentType,
  Element,
  HTMLCollection,
  Node,
  NodeList,
  ProcessingInstruction,
  Text,
  applyMixin,
  mixins,
  walkElements,
} from './nodes.ts';

const ELEMENT_NAME = /^[A-Za-z_:][^\s"'>/=\x00-\x1f\x7f]*$/;

function validName(name: string): string {
  if (!ELEMENT_NAME.test(name)) {
    throw domException(
      `Failed to execute 'createElement' on 'Document': The tag name provided ('${name}') is not a valid name.`,
      'InvalidCharacterError',
    );
  }
  return name;
}

export class Document extends Node {
  /** @internal */ _isHTML = true;
  /** @internal */ _defaultView: unknown = null;
  /** @internal */ _active: Element | null = null;
  /** @internal */ _currentScript: Element | null = null;
  /** @internal: scripts never run, links/styles fire nothing (DOMParser, createHTMLDocument). */
  _inert = true;
  /** @internal: while the entry document is being built (its scripts already ran). */
  _parsing = false;
  /** @internal */ _contentType = 'text/html';
  /** @internal */ _url: string | null = null;
  /** @internal */ _implementation: DOMImplementation | null = null;

  constructor() {
    super();
    this._doc = this;
  }
  override get nodeType(): number {
    return 9;
  }
  override get nodeName(): string {
    return '#document';
  }
  override get ownerDocument(): null {
    return null;
  }
  get implementation(): DOMImplementation {
    return (this._implementation ??= new DOMImplementation(this));
  }
  get URL(): string {
    return this._url ?? (this._defaultView ? documentURL() : 'about:blank');
  }
  get documentURI(): string {
    return this.URL;
  }
  override get baseURI(): string {
    const base = this.querySelector('base[href]');
    if (base) {
      try {
        return new G.URL(base.getAttribute('href'), this.URL).href;
      } catch {
        // fall through
      }
    }
    return this.URL;
  }
  get location(): unknown {
    return this._defaultView ? G.location : null;
  }
  set location(v: unknown) {
    if (this._defaultView && G.location) G.location.href = str(v);
  }
  get defaultView(): unknown {
    return this._defaultView;
  }
  get doctype(): DocumentType | null {
    for (const k of this._kids ?? []) if (k instanceof DocumentType) return k;
    return null;
  }
  get documentElement(): Element | null {
    for (const k of this._kids ?? []) if (k instanceof Element) return k;
    return null;
  }
  get head(): Element | null {
    const html = this.documentElement;
    if (!html) return null;
    for (const k of html._kids ?? [])
      if (
        k instanceof Element &&
        k.localName === 'head' &&
        k.namespaceURI === HTML_NS
      )
        return k;
    return null;
  }
  get body(): Element | null {
    const html = this.documentElement;
    if (!html) return null;
    for (const k of html._kids ?? [])
      if (
        k instanceof Element &&
        (k.localName === 'body' || k.localName === 'frameset') &&
        k.namespaceURI === HTML_NS
      )
        return k;
    return null;
  }
  set body(el: Element | null) {
    if (
      !(el instanceof HTMLElement) ||
      (el.localName !== 'body' && el.localName !== 'frameset')
    ) {
      throw domException(
        "Failed to set the 'body' property on 'Document': The new body element is of type '" +
          (el ? (el as Element).tagName : 'null') +
          "'. It must be either a 'BODY' or 'FRAMESET' element.",
        'HierarchyRequestError',
      );
    }
    const html = this.documentElement;
    if (!html)
      throw domException('No document element.', 'HierarchyRequestError');
    const old = this.body;
    if (old) html.replaceChild(el, old);
    else html.appendChild(el);
  }
  get title(): string {
    let t: Element | null = null;
    walkElements(this, (el) => {
      if (el.localName === 'title') {
        t = el;
        return true;
      }
      return false;
    });
    return t
      ? ((t as Element).textContent ?? '').replace(/[\t\n\f\r ]+/g, ' ').trim()
      : '';
  }
  set title(v: string) {
    let t: Element | null = this.querySelector('title');
    if (!t) {
      const head = this.head;
      if (!head) return;
      t = this.createElement('title');
      head.appendChild(t);
    }
    t.textContent = str(v);
  }
  get readyState(): string {
    return this._defaultView ? lifecycle().readyState : 'complete';
  }
  get visibilityState(): string {
    return this._defaultView ? lifecycle().visibilityState : 'hidden';
  }
  get hidden(): boolean {
    return this.visibilityState === 'hidden';
  }
  hasFocus(): boolean {
    return this._defaultView ? lifecycle().focused : false;
  }
  get activeElement(): Element | null {
    const a = this._active;
    if (a && a.isConnected && a._doc === this) return a;
    return this.body ?? this.documentElement;
  }
  get currentScript(): Element | null {
    return this._currentScript;
  }
  get cookie(): string {
    return '';
  }
  set cookie(_v: string) {
    // cookie-averse: a packaged app has no cookie jar (DOM-6)
  }
  get referrer(): string {
    return '';
  }
  get domain(): string {
    try {
      return new G.URL(this.URL).hostname;
    } catch {
      return '';
    }
  }
  get lastModified(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  get characterSet(): string {
    return 'UTF-8';
  }
  get charset(): string {
    return 'UTF-8';
  }
  get inputEncoding(): string {
    return 'UTF-8';
  }
  get contentType(): string {
    return this._contentType;
  }
  get compatMode(): string {
    return this.doctype || !this._isHTML ? 'CSS1Compat' : 'BackCompat';
  }
  get designMode(): string {
    return 'off';
  }
  set designMode(_v: string) {}
  get dir(): string {
    return this.documentElement?.getAttribute('dir') ?? '';
  }
  set dir(v: string) {
    this.documentElement?.setAttribute('dir', str(v));
  }
  get scrollingElement(): Element | null {
    return this.documentElement;
  }
  get fullscreenEnabled(): boolean {
    return false;
  }
  get fullscreen(): boolean {
    return false;
  }
  get fullscreenElement(): null {
    return null;
  }
  get pointerLockElement(): null {
    return null;
  }
  get pictureInPictureEnabled(): boolean {
    return false;
  }
  get pictureInPictureElement(): null {
    return null;
  }
  get styleSheets(): unknown[] {
    return [];
  }
  get adoptedStyleSheets(): unknown[] {
    return [];
  }
  set adoptedStyleSheets(_v: unknown[]) {}
  get images(): HTMLCollection {
    return this.getElementsByTagName('img');
  }
  get scripts(): HTMLCollection {
    return this.getElementsByTagName('script');
  }
  get forms(): HTMLCollection {
    return this.getElementsByTagName('form');
  }
  get embeds(): HTMLCollection {
    return this.getElementsByTagName('embed');
  }
  get plugins(): HTMLCollection {
    return this.getElementsByTagName('embed');
  }
  get links(): HTMLCollection {
    const out = new HTMLCollection();
    for (const el of this.querySelectorAll('a[href],area[href]'))
      out.push(el as Element);
    return out;
  }
  exitFullscreen(): Promise<void> {
    return Promise.resolve();
  }
  exitPointerLock(): void {}
  exitPictureInPicture(): Promise<void> {
    return Promise.resolve();
  }
  elementFromPoint(_x: number, _y: number): Element | null {
    return null;
  }
  elementsFromPoint(_x: number, _y: number): Element[] {
    return [];
  }
  caretPositionFromPoint(): null {
    return null;
  }
  getSelection(): Selection {
    return pageSelection;
  }
  hasStorageAccess(): Promise<boolean> {
    return Promise.resolve(true);
  }
  requestStorageAccess(): Promise<void> {
    return Promise.resolve();
  }
  execCommand(): boolean {
    return false;
  }
  queryCommandSupported(): boolean {
    return false;
  }
  queryCommandEnabled(): boolean {
    return false;
  }
  open(): this {
    warn(
      'document.open() ignored: the document of a packaged app is never replaced',
    );
    return this;
  }
  close(): void {}
  write(..._text: string[]): void {
    warn(
      'document.write() ignored: the document of a packaged app is never rewritten',
    );
  }
  writeln(..._text: string[]): void {
    warn(
      'document.writeln() ignored: the document of a packaged app is never rewritten',
    );
  }
  // --- factories (NodeFactory for the parser too) ---
  createElement(localName: string, _options?: unknown): Element {
    const raw = validName(str(localName));
    if (!this._isHTML && this._contentType !== 'application/xhtml+xml') {
      const el = new Element(raw, null, null);
      el._doc = this;
      return el;
    }
    const name = lower(raw);
    if (name === 'img') {
      const reg = G[Symbol.for('iwn.image')];
      if (reg?.createImageElement) {
        const img = reg.createImageElement() as Element;
        img._doc = this;
        return img;
      }
    }
    const C =
      HTML_TAGS[name] ??
      (PLAIN_HTML_ELEMENT_TAGS.has(name) || name.includes('-')
        ? HTMLElement
        : HTMLUnknownElement);
    const el = new C(name, this);
    el._doc = this;
    return el;
  }
  createElementNS(
    namespace: string | null,
    qualifiedName: string,
    _options?: unknown,
  ): Element {
    const ns = namespace || null;
    const q = validName(str(qualifiedName));
    const colon = q.indexOf(':');
    const prefix = colon > 0 ? q.slice(0, colon) : null;
    const local = colon > 0 ? q.slice(colon + 1) : q;
    let el: Element;
    if (ns === HTML_NS) {
      if (lower(local) === 'img' && !prefix) return this.createElement('img');
      const C =
        HTML_TAGS[local] ??
        (PLAIN_HTML_ELEMENT_TAGS.has(local) || local.includes('-')
          ? HTMLElement
          : HTMLUnknownElement);
      el = new C(local, this);
      el._prefix = prefix;
    } else if (ns === SVG_NS) {
      el =
        local === 'svg'
          ? new SVGSVGElement(local, this)
          : new SVGElement(local, this);
      el._prefix = prefix;
    } else {
      el = new Element(local, ns, prefix);
    }
    el._doc = this;
    return el;
  }
  createTextNode(data: string): Text {
    const t = new Text(str(data));
    t._doc = this;
    return t;
  }
  createComment(data: string): Comment {
    const c = new Comment(str(data));
    c._doc = this;
    return c;
  }
  createCDATASection(data: string): CDATASection {
    if (this._isHTML)
      throw domException(
        'This operation is not supported for HTML documents.',
        'NotSupportedError',
      );
    const c = new CDATASection(str(data));
    c._doc = this;
    return c;
  }
  createProcessingInstruction(
    target: string,
    data: string,
  ): ProcessingInstruction {
    const p = new ProcessingInstruction(str(data));
    p._target = str(target);
    p._doc = this;
    return p;
  }
  createDocumentType(
    name: string,
    publicId: string,
    systemId: string,
  ): DocumentType {
    return this.implementation.createDocumentType(name, publicId, systemId);
  }
  createDocumentFragment(): DocumentFragment {
    const f = new DocumentFragment();
    f._doc = this;
    return f;
  }
  createAttribute(name: string): Attr {
    const n = this._isHTML ? lower(str(name)) : str(name);
    const a = new Attr({
      ns: null,
      prefix: null,
      local: n,
      name: n,
      value: '',
    });
    a._doc = this;
    return a;
  }
  createAttributeNS(ns: string | null, qualifiedName: string): Attr {
    const q = str(qualifiedName);
    const colon = q.indexOf(':');
    const a = new Attr({
      ns: ns || null,
      prefix: colon > 0 ? q.slice(0, colon) : null,
      local: colon > 0 ? q.slice(colon + 1) : q,
      name: q,
      value: '',
    });
    a._doc = this;
    return a;
  }
  createEvent(interfaceName: string): unknown {
    const n = lower(str(interfaceName));
    const map: Record<string, string> = {
      event: 'Event',
      events: 'Event',
      htmlevents: 'Event',
      svgevents: 'Event',
      customevent: 'CustomEvent',
      uievent: 'UIEvent',
      uievents: 'UIEvent',
      mouseevent: 'MouseEvent',
      mouseevents: 'MouseEvent',
      keyboardevent: 'KeyboardEvent',
      keyevents: 'KeyboardEvent',
      focusevent: 'FocusEvent',
      messageevent: 'MessageEvent',
      errorevent: 'ErrorEvent',
      pointerevent: 'PointerEvent',
      wheelevent: 'WheelEvent',
      storageevent: 'StorageEvent',
      compositionevent: 'CompositionEvent',
      progressevent: 'ProgressEvent',
      hashchangeevent: 'HashChangeEvent',
      popstateevent: 'PopStateEvent',
      pagetransitionevent: 'PageTransitionEvent',
      inputevent: 'InputEvent',
    };
    const C = map[n] ? G[map[n]!] : undefined;
    if (typeof C !== 'function')
      throw domException(
        `The provided event type ('${interfaceName}') is invalid.`,
        'NotSupportedError',
      );
    return new C('');
  }
  createRange(): Range {
    return new Range(this);
  }
  createTreeWalker(
    root: Node,
    whatToShow = 0xffffffff,
    filter: unknown = null,
  ): TreeWalker {
    return new TreeWalker(root, whatToShow, filter);
  }
  createNodeIterator(
    root: Node,
    whatToShow = 0xffffffff,
    filter: unknown = null,
  ): TreeWalker {
    return new TreeWalker(root, whatToShow, filter);
  }
  importNode<T extends Node>(node: T, deep = false): T {
    if (node instanceof Document)
      throw domException(
        'The node provided is a document, which may not be imported.',
        'NotSupportedError',
      );
    const clone = cloneInto(node, this, deep);
    return clone as T;
  }
  adoptNode<T extends Node>(node: T): T {
    if (node instanceof Document)
      throw domException(
        'The node provided is a document, which may not be adopted.',
        'NotSupportedError',
      );
    node.parentNode?.removeChild(node);
    const visit = (n: Node) => {
      n._doc = this;
      for (const k of n._kids ?? []) visit(k);
    };
    visit(node);
    return node;
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
  getElementsByName(name: string): NodeList {
    const want = str(name);
    const out = new NodeList();
    walkElements(this, (el) => {
      if (el.getAttribute('name') === want) out.push(el);
      return false;
    });
    return out;
  }
  override _clone(_doc: any): Node {
    const d = this._isHTML ? new Document() : new XMLDocument();
    d._contentType = this._contentType;
    return d;
  }
  override cloneNode(deep = false): Node {
    const d = this._clone(this) as Document;
    if (deep)
      for (const k of this._kids ?? []) d.appendChild(cloneInto(k, d, true));
    return d;
  }
  override get [Symbol.toStringTag](): string {
    return this._isHTML ? 'HTMLDocument' : 'XMLDocument';
  }
}
applyMixin(Document.prototype, mixins.parentNodeMixin);
export interface Document {
  readonly children: HTMLCollection;
  readonly firstElementChild: Element | null;
  readonly lastElementChild: Element | null;
  readonly childElementCount: number;
  append(...items: unknown[]): void;
  prepend(...items: unknown[]): void;
  replaceChildren(...items: unknown[]): void;
  querySelector(selectors: string): Element | null;
  querySelectorAll(selectors: string): Element[];
  getElementsByTagName(name: string): HTMLCollection;
  getElementsByTagNameNS(ns: string | null, name: string): HTMLCollection;
  getElementsByClassName(names: string): HTMLCollection;
}
for (const t of [
  ...GLOBAL_HANDLERS,
  'readystatechange',
  'visibilitychange',
  'pointerlockchange',
  'pointerlockerror',
  'fullscreenchange',
  'fullscreenerror',
  'selectstart',
  'freeze',
  'resume',
]) {
  defineHandler(Document.prototype, t);
}

export class XMLDocument extends Document {
  constructor() {
    super();
    this._isHTML = false;
    this._contentType = 'application/xml';
  }
}

function cloneInto(node: Node, doc: Document, deep: boolean): Node {
  const c = node._clone(doc);
  c._doc = doc;
  if (deep)
    for (const k of node._kids ?? []) c.appendChild(cloneInto(k, doc, true));
  if (
    deep &&
    node instanceof Element &&
    node.localName === 'template' &&
    (node as any)._content
  ) {
    const content = (c as any).content as Node;
    for (const k of (node as any)._content._kids ?? [])
      content.appendChild(cloneInto(k, doc, true));
  }
  return c;
}

export class DOMImplementation {
  /** @internal */ _doc: Document;
  constructor(doc: Document) {
    this._doc = doc;
  }
  createDocumentType(
    name: string,
    publicId: string,
    systemId: string,
  ): DocumentType {
    const d = new DocumentType();
    d._name = str(name);
    d._publicId = str(publicId);
    d._systemId = str(systemId);
    d._doc = this._doc;
    return d;
  }
  createHTMLDocument(title?: string): Document {
    const doc = new Document();
    doc.appendChild(doc.implementation.createDocumentType('html', '', ''));
    const html = doc.createElement('html');
    const head = doc.createElement('head');
    html.appendChild(head);
    if (title !== undefined) {
      const t = doc.createElement('title');
      t.textContent = str(title);
      head.appendChild(t);
    }
    html.appendChild(doc.createElement('body'));
    doc.appendChild(html);
    return doc;
  }
  createDocument(
    namespace: string | null,
    qualifiedName: string | null,
    doctype: DocumentType | null = null,
  ): XMLDocument {
    const doc = new XMLDocument();
    if (namespace === HTML_NS) doc._contentType = 'application/xhtml+xml';
    else if (namespace === SVG_NS) doc._contentType = 'image/svg+xml';
    if (doctype) doc.appendChild(doctype);
    if (qualifiedName)
      doc.appendChild(doc.createElementNS(namespace, qualifiedName));
    return doc;
  }
  hasFeature(): boolean {
    return true;
  }
  get [Symbol.toStringTag](): string {
    return 'DOMImplementation';
  }
}

/**
 * Builds an HTML document's tree from markup: html/head/body exist afterwards, head-only elements that come
 * before any body content go to <head>, everything else to <body> (a simplification of HTML's insertion modes).
 */
export function buildHTMLDocument(doc: Document, markup: string): void {
  doc._parsing = true;
  try {
    const frag = doc.createDocumentFragment();
    parseInto(frag, markup, doc as unknown as NodeFactory);
    for (const k of [...(frag._kids ?? [])]) {
      if (k instanceof Text && k.data.trim() === '') frag.removeChild(k);
    }
    // doctype first
    const kids = [...(frag._kids ?? [])];
    let html =
      kids.find(
        (k): k is Element =>
          k instanceof Element &&
          k.localName === 'html' &&
          k.namespaceURI === HTML_NS,
      ) ?? null;
    let doctype: Node | null = null;
    const before: Node[] = [];
    for (const k of kids) {
      if (k.nodeType === 10) doctype = k;
      else if (k === html) break;
      else if (k.nodeType === 8) before.push(k);
    }
    if (!doctype) {
      const d = markup.match(/<!doctype\s+([^\s>]+)/i);
      if (d)
        doctype = doc.implementation.createDocumentType(lower(d[1]!), '', '');
    }
    if (!html) {
      html = doc.createElement('html');
      for (const k of kids)
        if (k.nodeType !== 10 && !before.includes(k)) html.appendChild(k);
    } else {
      // content outside <html> (stray nodes after it) moves into it
      for (const k of kids)
        if (k !== html && k.nodeType !== 10 && !before.includes(k))
          html.appendChild(k);
    }
    let head: Element | null = null;
    let body: Element | null = null;
    for (const k of html._kids ?? []) {
      if (k instanceof Element && k.namespaceURI === HTML_NS) {
        if (k.localName === 'head' && !head) head = k;
        else if (
          (k.localName === 'body' || k.localName === 'frameset') &&
          !body
        )
          body = k;
      }
    }
    if (!head) {
      head = doc.createElement('head');
      html.insertBefore(head, html.firstChild);
    }
    if (!body) {
      body = doc.createElement('body');
      html.appendChild(body);
    }
    let seenBodyContent = false;
    for (const k of [...(html._kids ?? [])]) {
      if (k === head || k === body) {
        if (k === body) seenBodyContent = true;
        continue;
      }
      if (k instanceof Text && k.data.trim() === '') {
        html.removeChild(k);
        continue;
      }
      if (
        !seenBodyContent &&
        k instanceof Element &&
        isHeadElement(k.localName)
      )
        head.appendChild(k);
      else if (k.nodeType === 8 && !seenBodyContent) continue;
      else {
        seenBodyContent = true;
        body.appendChild(k);
      }
    }
    // body content parsed before the <body> tag itself (no explicit body) keeps document order
    if (doctype) doc.appendChild(doctype);
    for (const c of before) doc.appendChild(c);
    doc.appendChild(html);
    for (const s of doc.getElementsByTagName('script'))
      (s as any)[ALREADY_STARTED] = true;
    for (const s of doc.querySelectorAll('link,style'))
      (s as any)[ALREADY_STARTED] = true;
  } finally {
    doc._parsing = false;
  }
}

export class DOMParser {
  parseFromString(text: string, type: string): Document {
    const t = str(type);
    if (t === 'text/html') {
      const doc = new Document();
      buildHTMLDocument(doc, str(text));
      return doc;
    }
    if (
      t === 'text/xml' ||
      t === 'application/xml' ||
      t === 'application/xhtml+xml' ||
      t === 'image/svg+xml'
    ) {
      const doc = new XMLDocument();
      doc._contentType = t;
      doc._parsing = true;
      try {
        parseInto(doc, str(text), doc as unknown as NodeFactory, { xml: true });
        for (const k of [...(doc._kids ?? [])])
          if (k instanceof Text) doc.removeChild(k);
      } finally {
        doc._parsing = false;
      }
      if (!doc.documentElement) {
        const err = doc.createElementNS(
          'http://www.mozilla.org/newlayout/xml/parsererror.xml',
          'parsererror',
        );
        err.textContent = 'XML parsing error: no root element found';
        doc.appendChild(err);
      }
      return doc;
    }
    throw new TypeError(
      `Failed to execute 'parseFromString' on 'DOMParser': The provided value '${t}' is not a valid enum value of type DOMParserSupportedType.`,
    );
  }
  get [Symbol.toStringTag](): string {
    return 'DOMParser';
  }
}

export class XMLSerializer {
  serializeToString(node: Node): string {
    if (!(node instanceof Node))
      throw new TypeError(
        "Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.",
      );
    let out = serializeNode(node as any, true);
    if (
      node instanceof Element &&
      node.namespaceURI &&
      !node.hasAttribute('xmlns') &&
      !node.getAttributeNS(XMLNS_NS, 'xmlns')
    ) {
      out = out.replace(/^<([^\s/>]+)/, `<$1 xmlns="${node.namespaceURI}"`);
    }
    return out;
  }
  get [Symbol.toStringTag](): string {
    return 'XMLSerializer';
  }
}

// --- Range / Selection / TreeWalker (minimal) ------------------------------------------------------------------------

export class Range {
  startContainer: Node;
  startOffset = 0;
  endContainer: Node;
  endOffset = 0;
  /** @internal */ _doc: Document;
  constructor(doc?: Document) {
    this._doc = doc ?? (G.document as Document);
    this.startContainer = this._doc;
    this.endContainer = this._doc;
  }
  get collapsed(): boolean {
    return (
      this.startContainer === this.endContainer &&
      this.startOffset === this.endOffset
    );
  }
  get commonAncestorContainer(): Node {
    for (let n: Node | null = this.startContainer; n; n = n.parentNode)
      if (n.contains(this.endContainer)) return n;
    return this._doc;
  }
  setStart(node: Node, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node: Node, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }
  setStartBefore(node: Node): void {
    this.setStart(node.parentNode ?? node, 0);
  }
  setEndAfter(node: Node): void {
    this.setEnd(node.parentNode ?? node, 0);
  }
  selectNode(node: Node): void {
    this.setStartBefore(node);
    this.setEndAfter(node);
  }
  selectNodeContents(node: Node): void {
    this.startContainer = this.endContainer = node;
    this.startOffset = 0;
    this.endOffset = node.childNodes.length;
  }
  collapse(toStart = false): void {
    if (toStart) {
      this.endContainer = this.startContainer;
      this.endOffset = this.startOffset;
    } else {
      this.startContainer = this.endContainer;
      this.startOffset = this.endOffset;
    }
  }
  cloneRange(): Range {
    const r = new Range(this._doc);
    r.setStart(this.startContainer, this.startOffset);
    r.setEnd(this.endContainer, this.endOffset);
    return r;
  }
  detach(): void {}
  createContextualFragment(markup: string): DocumentFragment {
    const frag = this._doc.createDocumentFragment();
    const ctx =
      this.startContainer instanceof Element ? this.startContainer : null;
    parseInto(frag, str(markup), this._doc as unknown as NodeFactory, {
      contextNs: ctx?.namespaceURI ?? HTML_NS,
    });
    return frag;
  }
  getBoundingClientRect(): DOMRect {
    return new DOMRect(0, 0, 0, 0);
  }
  getClientRects(): DOMRectList {
    return new DOMRectList();
  }
  toString(): string {
    return '';
  }
  get [Symbol.toStringTag](): string {
    return 'Range';
  }
}

export class Selection {
  get rangeCount(): number {
    return 0;
  }
  get isCollapsed(): boolean {
    return true;
  }
  get type(): string {
    return 'None';
  }
  get anchorNode(): null {
    return null;
  }
  get focusNode(): null {
    return null;
  }
  get anchorOffset(): number {
    return 0;
  }
  get focusOffset(): number {
    return 0;
  }
  addRange(_r: Range): void {}
  removeAllRanges(): void {}
  empty(): void {}
  removeRange(_r: Range): void {}
  collapse(): void {}
  collapseToStart(): void {}
  collapseToEnd(): void {}
  selectAllChildren(): void {}
  getRangeAt(_i: number): never {
    throw domException(
      'The index provided is not a valid index.',
      'IndexSizeError',
    );
  }
  containsNode(): boolean {
    return false;
  }
  toString(): string {
    return '';
  }
  get [Symbol.toStringTag](): string {
    return 'Selection';
  }
}
const pageSelection = new Selection();
export function getPageSelection(): Selection {
  return pageSelection;
}

export const NodeFilter = Object.freeze({
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff,
  SHOW_ELEMENT: 0x1,
  SHOW_ATTRIBUTE: 0x2,
  SHOW_TEXT: 0x4,
  SHOW_CDATA_SECTION: 0x8,
  SHOW_PROCESSING_INSTRUCTION: 0x40,
  SHOW_COMMENT: 0x80,
  SHOW_DOCUMENT: 0x100,
  SHOW_DOCUMENT_TYPE: 0x200,
  SHOW_DOCUMENT_FRAGMENT: 0x400,
});

/** TreeWalker / NodeIterator in document order (nextNode/previousNode, the walker's navigation methods). */
export class TreeWalker {
  readonly root: Node;
  readonly whatToShow: number;
  readonly filter: unknown;
  currentNode: Node;
  constructor(root: Node, whatToShow: number, filter: unknown) {
    this.root = root;
    this.whatToShow = whatToShow >>> 0;
    this.filter = filter;
    this.currentNode = root;
  }
  get referenceNode(): Node {
    return this.currentNode;
  }
  /** @internal */ _accept(n: Node): number {
    if (!((1 << (n.nodeType - 1)) & this.whatToShow)) return 3;
    const f = this.filter as
      | { acceptNode?: (n: Node) => number }
      | ((n: Node) => number)
      | null;
    if (!f) return 1;
    return typeof f === 'function' ? f(n) : (f.acceptNode?.(n) ?? 1);
  }
  /** @internal */ _following(n: Node): Node | null {
    if (n.firstChild) return n.firstChild;
    for (let x: Node | null = n; x && x !== this.root; x = x.parentNode)
      if (x.nextSibling) return x.nextSibling;
    return null;
  }
  /** @internal */ _preceding(n: Node): Node | null {
    if (n === this.root) return null;
    let p = n.previousSibling;
    if (!p) return n.parentNode;
    while (p.lastChild) p = p.lastChild;
    return p;
  }
  nextNode(): Node | null {
    for (let n = this._following(this.currentNode); n; n = this._following(n)) {
      if (this._accept(n) === 1) return (this.currentNode = n);
    }
    return null;
  }
  previousNode(): Node | null {
    for (let n = this._preceding(this.currentNode); n; n = this._preceding(n)) {
      if (this._accept(n) === 1) return (this.currentNode = n);
    }
    return null;
  }
  parentNode(): Node | null {
    for (
      let n = this.currentNode.parentNode;
      n && n !== this.root.parentNode;
      n = n.parentNode
    ) {
      if (this._accept(n) === 1) return (this.currentNode = n);
      if (n === this.root) break;
    }
    return null;
  }
  firstChild(): Node | null {
    for (let n = this.currentNode.firstChild; n; n = n.nextSibling)
      if (this._accept(n) === 1) return (this.currentNode = n);
    return null;
  }
  lastChild(): Node | null {
    for (let n = this.currentNode.lastChild; n; n = n.previousSibling)
      if (this._accept(n) === 1) return (this.currentNode = n);
    return null;
  }
  nextSibling(): Node | null {
    for (let n = this.currentNode.nextSibling; n; n = n.nextSibling)
      if (this._accept(n) === 1) return (this.currentNode = n);
    return null;
  }
  previousSibling(): Node | null {
    for (let n = this.currentNode.previousSibling; n; n = n.previousSibling)
      if (this._accept(n) === 1) return (this.currentNode = n);
    return null;
  }
  detach(): void {}
  get [Symbol.toStringTag](): string {
    return 'TreeWalker';
  }
}

export { HTMLBodyElement, HTMLHeadElement, HTMLHtmlElement, HTMLTitleElement };
