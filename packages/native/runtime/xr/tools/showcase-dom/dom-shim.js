/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// TEST SCAFFOLDING, NOT SHIPPED. A minimal DOM stand-in (document, Node/Element/HTMLElement and the element
// interfaces, observers, getComputedStyle, UI event constructors) so the M3 device check can boot
// proto-showcase-vr before the DOM module of docs/spec/12 (DOM-*) exists. Written from the DOM and HTML Living
// Standards for the subset the showcase touches (measured by grepping its dist: createElement(NS), getElementById,
// querySelector(All), getElementsByTagName, body/head append/remove, style, getComputedStyle, pointer lock,
// MutationObserver). Element ids found in the app's index.html body are created at boot by build-showcase-apk.mjs
// (it prepends `globalThis.__iwnDomBody = [...]`). It stands down when a real `document` exists.
(() => {
  const g = globalThis;
  if (g.document) return;
  const ET = g.EventTarget;
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const TAG_OF_INTERFACE = {
    HTMLImageElement: 'img',
    HTMLCanvasElement: 'canvas',
    HTMLVideoElement: 'video',
    HTMLAudioElement: 'audio',
  };
  const WIDTH = 1280;
  const HEIGHT = 720;

  // MutationObserver registry (declared first: the initial tree below already queues mutations)
  const mutationObservers = new Set();
  function queueMutation(target, type) {
    if (!mutationObservers.size) return;
    for (const mo of mutationObservers) mo._consider(target, type);
  }

  // --- CSSStyleDeclaration stand-in: any property, cssText, get/set/removeProperty ---------------------------------
  function makeStyle() {
    const values = new Map();
    const target = {
      setProperty(k, v) {
        values.set(String(k), String(v));
      },
      getPropertyValue(k) {
        return values.get(String(k)) ?? '';
      },
      removeProperty(k) {
        const v = values.get(String(k)) ?? '';
        values.delete(String(k));
        return v;
      },
      get cssText() {
        return [...values].map(([k, v]) => `${k}: ${v};`).join(' ');
      },
      set cssText(t) {
        values.clear();
        for (const part of String(t).split(';')) {
          const i = part.indexOf(':');
          if (i > 0)
            values.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
        }
      },
      get length() {
        return values.size;
      },
    };
    return new Proxy(target, {
      get(t, k) {
        if (k in t) return Reflect.get(t, k);
        if (typeof k === 'string')
          return (
            values.get(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())) ??
            values.get(k) ??
            ''
          );
        return undefined;
      },
      set(t, k, v) {
        if (k in t) return Reflect.set(t, k, v);
        values.set(
          String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()),
          String(v),
        );
        return true;
      },
    });
  }

  class DOMTokenList {
    constructor(el, attr) {
      this._el = el;
      this._attr = attr;
    }
    _list() {
      return (this._el.getAttribute(this._attr) || '')
        .split(/\s+/)
        .filter(Boolean);
    }
    _set(l) {
      this._el.setAttribute(this._attr, l.join(' '));
    }
    get length() {
      return this._list().length;
    }
    get value() {
      return this._el.getAttribute(this._attr) || '';
    }
    item(i) {
      return this._list()[i] ?? null;
    }
    contains(t) {
      return this._list().includes(String(t));
    }
    add(...ts) {
      const l = this._list();
      for (const t of ts) if (!l.includes(t)) l.push(t);
      this._set(l);
    }
    remove(...ts) {
      this._set(this._list().filter((t) => !ts.includes(t)));
    }
    toggle(t, force) {
      const has = this.contains(t);
      const want = force === undefined ? !has : !!force;
      if (want && !has) this.add(t);
      if (!want && has) this.remove(t);
      return want;
    }
    replace(a, b) {
      if (!this.contains(a)) return false;
      this._set(this._list().map((t) => (t === a ? b : t)));
      return true;
    }
    supports(t) {
      return (
        this._attr === 'rel' &&
        ['modulepreload', 'preload', 'stylesheet', 'icon'].includes(String(t))
      );
    } // REG-4
    [Symbol.iterator]() {
      return this._list()[Symbol.iterator]();
    }
    toString() {
      return this.value;
    }
  }

  // --- simple selectors: tag, #id, .class, [attr], [attr=value], descendant combinator, comma lists ----------------
  function parseCompound(s) {
    const c = { tag: null, id: null, classes: [], attrs: [] };
    const re =
      /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]|\*/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1]) c.tag = m[1].toLowerCase();
      else if (m[2]) c.id = m[2];
      else if (m[3]) c.classes.push(m[3]);
      else if (m[4]) c.attrs.push([m[4], m[5], m[6]]);
    }
    return c;
  }
  function matchCompound(el, c) {
    if (!(el instanceof Element)) return false;
    if (c.tag && el.localName !== c.tag) return false;
    if (c.id && el.id !== c.id) return false;
    for (const k of c.classes) if (!el.classList.contains(k)) return false;
    for (const [name, op, value] of c.attrs) {
      if (!el.hasAttribute(name)) return false;
      if (op === '=' && el.getAttribute(name) !== value) return false;
    }
    return true;
  }
  function matches(el, selector) {
    return String(selector)
      .split(',')
      .some((sel) => {
        const parts = sel.trim().split(/\s+/).map(parseCompound);
        if (!matchCompound(el, parts[parts.length - 1])) return false;
        let node = el.parentNode;
        for (let i = parts.length - 2; i >= 0; i--) {
          while (node && !matchCompound(node, parts[i])) node = node.parentNode;
          if (!node) return false;
          node = node.parentNode;
        }
        return true;
      });
  }
  function* descendants(node) {
    for (const c of node.childNodes) {
      yield c;
      yield* descendants(c);
    }
  }

  // --- Node / Element -------------------------------------------------------------------------------------------
  class Node extends ET {
    constructor() {
      super();
      this.childNodes = [];
      this.parentNode = null;
    }
    get ownerDocument() {
      return document;
    }
    get parentElement() {
      return this.parentNode instanceof Element ? this.parentNode : null;
    }
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    get lastChild() {
      return this.childNodes[this.childNodes.length - 1] ?? null;
    }
    get nextSibling() {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.childNodes.indexOf(this);
      return p.childNodes[i + 1] ?? null;
    }
    get previousSibling() {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.childNodes.indexOf(this);
      return i > 0 ? p.childNodes[i - 1] : null;
    }
    get isConnected() {
      let n = this;
      while (n.parentNode) n = n.parentNode;
      return n === document;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(t) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      if (t !== '' && t != null)
        this.appendChild(document.createTextNode(String(t)));
    }
    hasChildNodes() {
      return this.childNodes.length > 0;
    }
    contains(n) {
      while (n) {
        if (n === this) return true;
        n = n.parentNode;
      }
      return false;
    }
    appendChild(c) {
      return this.insertBefore(c, null);
    }
    insertBefore(c, ref) {
      if (c instanceof DocumentFragment) {
        for (const k of [...c.childNodes]) this.insertBefore(k, ref);
        return c;
      }
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(c);
      else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      if (c instanceof HTMLScriptElement) c._connected();
      if (c instanceof HTMLLinkElement || c instanceof HTMLStyleElement)
        c._connected();
      queueMutation(this, 'childList');
      return c;
    }
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i < 0) throw new DOMException('not a child', 'NotFoundError');
      this.childNodes.splice(i, 1);
      c.parentNode = null;
      queueMutation(this, 'childList');
      return c;
    }
    replaceChild(n, old) {
      this.insertBefore(n, old);
      return this.removeChild(old);
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    append(...ns) {
      for (const n of ns)
        this.appendChild(
          typeof n === 'string' ? document.createTextNode(n) : n,
        );
    }
    prepend(...ns) {
      const first = this.firstChild;
      for (const n of ns)
        this.insertBefore(
          typeof n === 'string' ? document.createTextNode(n) : n,
          first,
        );
    }
    replaceWith(...ns) {
      const p = this.parentNode;
      if (!p) return;
      for (const n of ns) p.insertBefore(n, this);
      this.remove();
    }
    cloneNode(deep) {
      const c = this._shallowClone();
      if (deep)
        for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
      return c;
    }
    _shallowClone() {
      return new this.constructor();
    }
  }
  class Text extends Node {
    constructor(data = '') {
      super();
      this.data = String(data);
    }
    get textContent() {
      return this.data;
    }
    set textContent(t) {
      this.data = String(t);
    }
    get nodeType() {
      return 3;
    }
    _shallowClone() {
      return new Text(this.data);
    }
  }
  class DocumentFragment extends Node {
    get nodeType() {
      return 11;
    }
  }

  class Element extends Node {
    constructor(localName, ns = HTML_NS) {
      super();
      // Per-instance state lives in _fields behind prototype accessors: interface subclasses from other runtime
      // layers (the image module's HTMLImageElement) add their own accessors only for names the base prototype
      // lacks, and an instance property would collide with them.
      this._ns = ns;
      this._qname = String(
        localName ??
          TAG_OF_INTERFACE[new.target?.prototype?.[Symbol.toStringTag]] ??
          'div',
      );
      this._attrs = new Map();
      this.scrollTop = 0;
      this.scrollLeft = 0;
    }
    get style() {
      return (this._style ??= makeStyle());
    }
    set style(v) {
      this.style.cssText = String(v);
    }
    get classList() {
      return (this._classList ??= new DOMTokenList(this, 'class'));
    }
    get dataset() {
      return (this._dataset ??= {});
    }
    get nodeType() {
      return 1;
    }
    get namespaceURI() {
      return this._ns;
    }
    get localName() {
      return this._ns === HTML_NS
        ? this._qname.toLowerCase()
        : this._qname.replace(/^.*:/, '');
    }
    get tagName() {
      return this._ns === HTML_NS ? this._qname.toUpperCase() : this._qname;
    }
    get nodeName() {
      return this.tagName;
    }
    get id() {
      return this.getAttribute('id') || '';
    }
    set id(v) {
      this.setAttribute('id', v);
    }
    get className() {
      return this.getAttribute('class') || '';
    }
    set className(v) {
      this.setAttribute('class', v);
    }
    get children() {
      return this.childNodes.filter((c) => c instanceof Element);
    }
    get childElementCount() {
      return this.children.length;
    }
    get firstElementChild() {
      return this.children[0] ?? null;
    }
    get lastElementChild() {
      const c = this.children;
      return c[c.length - 1] ?? null;
    }
    get attributes() {
      return [...this._attrs].map(([name, value]) => ({ name, value }));
    }
    getAttribute(k) {
      return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null;
    }
    setAttribute(k, v) {
      this._attrs.set(String(k), String(v));
      queueMutation(this, 'attributes');
    }
    hasAttribute(k) {
      return this._attrs.has(String(k));
    }
    removeAttribute(k) {
      this._attrs.delete(String(k));
      queueMutation(this, 'attributes');
    }
    getAttributeNS(_ns, k) {
      return this.getAttribute(k);
    }
    setAttributeNS(_ns, k, v) {
      this.setAttribute(k, v);
    }
    toggleAttribute(k, force) {
      const want = force === undefined ? !this.hasAttribute(k) : !!force;
      if (want) this.setAttribute(k, '');
      else this.removeAttribute(k);
      return want;
    }
    matches(s) {
      return matches(this, s);
    }
    closest(s) {
      let n = this;
      while (n instanceof Element) {
        if (matches(n, s)) return n;
        n = n.parentNode;
      }
      return null;
    }
    querySelector(s) {
      for (const n of descendants(this))
        if (n instanceof Element && matches(n, s)) return n;
      return null;
    }
    querySelectorAll(s) {
      const out = [];
      for (const n of descendants(this))
        if (n instanceof Element && matches(n, s)) out.push(n);
      return out;
    }
    getElementsByTagName(t) {
      t = String(t).toLowerCase();
      return [...descendants(this)].filter(
        (n) => n instanceof Element && (t === '*' || n.localName === t),
      );
    }
    getElementsByClassName(c) {
      return [...descendants(this)].filter(
        (n) => n instanceof Element && n.classList.contains(c),
      );
    }
    get innerHTML() {
      return this._html ?? this.textContent;
    }
    set innerHTML(v) {
      this.textContent = '';
      this._html = String(v);
    }
    get outerHTML() {
      return `<${this.localName}>${this.innerHTML}</${this.localName}>`;
    }
    getBoundingClientRect() {
      const full =
        this instanceof HTMLCanvasElement ||
        this === document.body ||
        this === document.documentElement;
      const w = full ? WIDTH : 0,
        h = full ? HEIGHT : 0;
      return new DOMRect(0, 0, w, h);
    }
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
    get clientWidth() {
      return this.getBoundingClientRect().width;
    }
    get clientHeight() {
      return this.getBoundingClientRect().height;
    }
    get offsetWidth() {
      return this.clientWidth;
    }
    get offsetHeight() {
      return this.clientHeight;
    }
    get offsetLeft() {
      return 0;
    }
    get offsetTop() {
      return 0;
    }
    get offsetParent() {
      return this.parentElement;
    }
    focus() {}
    blur() {}
    click() {
      this.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    scrollIntoView() {}
    requestPointerLock() {
      return Promise.resolve();
    }
    requestFullscreen() {
      return Promise.resolve();
    }
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() {
      return false;
    }
    attachShadow() {
      return new DocumentFragment();
    }
    _shallowClone() {
      const c = new this.constructor(this._qname, this._ns);
      for (const [k, v] of this._attrs) c._attrs.set(k, v);
      return c;
    }
  }
  class HTMLElement extends Element {
    get hidden() {
      return this.hasAttribute('hidden');
    }
    set hidden(v) {
      this.toggleAttribute('hidden', !!v);
    }
    get tabIndex() {
      return Number(this.getAttribute('tabindex') ?? -1);
    }
    set tabIndex(v) {
      this.setAttribute('tabindex', v);
    }
    get title() {
      return this.getAttribute('title') || '';
    }
    set title(v) {
      this.setAttribute('title', v);
    }
  }
  const simple = (name) => ({ [name]: class extends HTMLElement {} })[name];
  const HTMLDivElement = simple('HTMLDivElement');
  const HTMLSpanElement = simple('HTMLSpanElement');
  const HTMLBodyElement = simple('HTMLBodyElement');
  const HTMLHeadElement = simple('HTMLHeadElement');
  const HTMLHtmlElement = simple('HTMLHtmlElement');
  const HTMLParagraphElement = simple('HTMLParagraphElement');
  const HTMLButtonElement = simple('HTMLButtonElement');
  const HTMLMetaElement = simple('HTMLMetaElement');
  const HTMLTitleElement = simple('HTMLTitleElement');
  class HTMLCanvasElement extends HTMLElement {} // canvas2d's prelude adds width/height/getContext/toDataURL/toBlob
  class HTMLInputElement extends HTMLElement {
    constructor(...a) {
      super(...a);
      this.value = '';
      this.type = 'text';
    }
    select() {}
    setSelectionRange() {}
  }
  class HTMLTextAreaElement extends HTMLElement {
    constructor(...a) {
      super(...a);
      this.value = '';
    }
    select() {}
    setSelectionRange() {}
  }
  class HTMLLinkElement extends HTMLElement {
    constructor(...a) {
      super(...a);
      this.relList = new DOMTokenList(this, 'rel');
    }
    get rel() {
      return this.getAttribute('rel') || '';
    }
    set rel(v) {
      this.setAttribute('rel', v);
    }
    get href() {
      return this.getAttribute('href') || '';
    }
    set href(v) {
      this.setAttribute('href', v);
    }
    _connected() {
      setTimeout(() => this.dispatchEvent(new Event('load')), 0);
    } // DOM-9: accepted, no styling
  }
  class HTMLStyleElement extends HTMLElement {
    _connected() {
      setTimeout(() => this.dispatchEvent(new Event('load')), 0);
    }
  }
  class HTMLScriptElement extends HTMLElement {
    get src() {
      return this.getAttribute('src') || '';
    }
    set src(v) {
      this.setAttribute('src', v);
    }
    get type() {
      return this.getAttribute('type') || '';
    }
    set type(v) {
      this.setAttribute('type', v);
    }
    _connected() {
      if (!this.src) return;
      const url = new URL(this.src, document.baseURI).href;
      // DOM-9 (approximation): modules through dynamic import; classic scripts are not evaluated here
      const run =
        this.type === 'module'
          ? import(url)
          : Promise.reject(
              new Error(
                'classic <script src> is not supported by the test DOM',
              ),
            );
      run.then(
        () => this.dispatchEvent(new Event('load')),
        () => this.dispatchEvent(new Event('error')),
      );
    }
  }
  class HTMLMediaElement extends HTMLElement {
    constructor(...a) {
      super(...a);
      this.paused = true;
      this.currentTime = 0;
      this.muted = false;
      this.volume = 1;
      this.readyState = 0;
    }
    canPlayType() {
      return '';
    }
    play() {
      return Promise.reject(
        new DOMException(
          'media playback is not supported',
          'NotSupportedError',
        ),
      );
    }
    pause() {}
    load() {}
  }
  const HTMLVideoElement = {
    HTMLVideoElement: class extends HTMLMediaElement {
      constructor(...a) {
        super(...a);
        this.videoWidth = 0;
        this.videoHeight = 0;
      }
    },
  }.HTMLVideoElement;
  const HTMLAudioElement = {
    HTMLAudioElement: class extends HTMLMediaElement {},
  }.HTMLAudioElement;

  const TAGS = {
    div: HTMLDivElement,
    span: HTMLSpanElement,
    body: HTMLBodyElement,
    head: HTMLHeadElement,
    html: HTMLHtmlElement,
    p: HTMLParagraphElement,
    button: HTMLButtonElement,
    meta: HTMLMetaElement,
    title: HTMLTitleElement,
    canvas: HTMLCanvasElement,
    input: HTMLInputElement,
    textarea: HTMLTextAreaElement,
    link: HTMLLinkElement,
    style: HTMLStyleElement,
    script: HTMLScriptElement,
    video: HTMLVideoElement,
    audio: HTMLAudioElement,
  };

  // --- Document -------------------------------------------------------------------------------------------------
  class Document extends Node {
    constructor() {
      super();
      this.cookie = '';
      this.referrer = '';
      this.currentScript = null;
      this.fullscreenElement = null;
      this.pointerLockElement = null;
      this.characterSet = 'UTF-8';
      this.compatMode = 'CSS1Compat';
      this.contentType = 'text/html';
    }
    get nodeType() {
      return 9;
    }
    get defaultView() {
      return g;
    }
    get documentElement() {
      return this.childNodes[0];
    }
    get head() {
      return (
        this.documentElement.childNodes.find(
          (c) => c instanceof HTMLHeadElement,
        ) ?? null
      );
    }
    get body() {
      return (
        this.documentElement.childNodes.find(
          (c) => c instanceof HTMLBodyElement,
        ) ?? null
      );
    }
    get activeElement() {
      return this.body;
    }
    get readyState() {
      return g.__iwn?.core?.lifecycleState?.().readyState ?? 'complete';
    }
    get visibilityState() {
      return g.__iwn?.core?.lifecycleState?.().visibilityState ?? 'visible';
    }
    get hidden() {
      return this.visibilityState === 'hidden';
    }
    hasFocus() {
      return g.__iwn?.core?.lifecycleState?.().focused ?? true;
    }
    get URL() {
      return String(g.location?.href ?? 'https://app.local/');
    }
    get documentURI() {
      return this.URL;
    }
    get baseURI() {
      return this.URL;
    }
    get title() {
      return this._title ?? '';
    }
    set title(v) {
      this._title = String(v);
    }
    createElement(tag) {
      const t = String(tag).toLowerCase();
      if (t === 'img') {
        const reg = g[Symbol.for('iwn.image')];
        if (reg?.createImageElement) return reg.createImageElement();
        if (typeof g.Image === 'function') return new g.Image();
      }
      const C = TAGS[t] ?? HTMLElement;
      return new C(t);
    }
    createElementNS(ns, tag) {
      return ns === HTML_NS || ns == null
        ? this.createElement(tag)
        : new Element(String(tag), ns);
    }
    createTextNode(t) {
      return new Text(t);
    }
    createDocumentFragment() {
      return new DocumentFragment();
    }
    createComment() {
      return new Text('');
    }
    createEvent() {
      return new Event('');
    }
    getElementById(id) {
      for (const n of descendants(this))
        if (n instanceof Element && n.id === String(id)) return n;
      return null;
    }
    querySelector(s) {
      for (const n of descendants(this))
        if (n instanceof Element && matches(n, s)) return n;
      return null;
    }
    querySelectorAll(s) {
      const out = [];
      for (const n of descendants(this))
        if (n instanceof Element && matches(n, s)) out.push(n);
      return out;
    }
    getElementsByTagName(t) {
      return this.documentElement
        .getElementsByTagName(t)
        .concat(
          String(t).toLowerCase() === 'html' ? [this.documentElement] : [],
        );
    }
    getElementsByClassName(c) {
      return this.documentElement.getElementsByClassName(c);
    }
    exitFullscreen() {
      return Promise.resolve();
    }
    exitPointerLock() {}
    elementFromPoint() {
      return null;
    }
  }

  const document = new Document();
  const html = new HTMLHtmlElement('html');
  document.childNodes.push(html);
  html.parentNode = document;
  const head = new HTMLHeadElement('head');
  const body = new HTMLBodyElement('body');
  html.appendChild(head);
  html.appendChild(body);
  for (const spec of g.__iwnDomBody ?? []) {
    // DOM-7 (approximation): ids and classes of the index.html body
    const el = document.createElement(spec.tag || 'div');
    if (spec.id) el.id = spec.id;
    if (spec.className) el.className = spec.className;
    body.appendChild(el);
  }

  // --- observers, geometry, UI events ---------------------------------------------------------------------------
  class MutationObserver {
    constructor(cb) {
      this._cb = cb;
      this._targets = [];
      this._records = [];
    }
    observe(target, options = {}) {
      this._targets.push([target, options]);
      mutationObservers.add(this);
    }
    disconnect() {
      this._targets = [];
      mutationObservers.delete(this);
    }
    takeRecords() {
      const r = this._records;
      this._records = [];
      return r;
    }
    _consider(target, type) {
      for (const [t, o] of this._targets) {
        const inTree = t === target || (o.subtree && t.contains(target));
        if (!inTree) continue;
        if (
          (type === 'childList' && o.childList) ||
          (type === 'attributes' && o.attributes)
        ) {
          this._records.push({ type, target });
          if (this._records.length === 1)
            queueMicrotask(() => {
              const r = this.takeRecords();
              if (r.length) this._cb(r, this);
            });
        }
      }
    }
  }
  class ResizeObserver {
    constructor(cb) {
      this._cb = cb;
    }
    observe(target) {
      setTimeout(() => {
        const rect = target.getBoundingClientRect
          ? target.getBoundingClientRect()
          : new DOMRect(0, 0, WIDTH, HEIGHT);
        const size = [{ inlineSize: rect.width, blockSize: rect.height }];
        this._cb(
          [
            {
              target,
              contentRect: rect,
              contentBoxSize: size,
              borderBoxSize: size,
              devicePixelContentBoxSize: size,
            },
          ],
          this,
        );
      }, 0);
    }
    unobserve() {}
    disconnect() {}
  }
  class IntersectionObserver {
    constructor(cb) {
      this._cb = cb;
    }
    observe(target) {
      setTimeout(
        () =>
          this._cb(
            [{ target, isIntersecting: true, intersectionRatio: 1 }],
            this,
          ),
        0,
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  class DOMRectReadOnly {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
    get left() {
      return Math.min(this.x, this.x + this.width);
    }
    get right() {
      return Math.max(this.x, this.x + this.width);
    }
    get top() {
      return Math.min(this.y, this.y + this.height);
    }
    get bottom() {
      return Math.max(this.y, this.y + this.height);
    }
    toJSON() {
      return {
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        top: this.top,
        left: this.left,
        right: this.right,
        bottom: this.bottom,
      };
    }
    static fromRect(r = {}) {
      return new this(r.x, r.y, r.width, r.height);
    }
  }
  class DOMRect extends DOMRectReadOnly {}
  const BaseEvent = g.Event;
  class UIEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.view = init.view ?? null;
      this.detail = init.detail ?? 0;
    }
  }
  class MouseEvent extends UIEvent {
    constructor(type, init = {}) {
      super(type, init);
      for (const k of [
        'screenX',
        'screenY',
        'clientX',
        'clientY',
        'movementX',
        'movementY',
        'button',
        'buttons',
      ])
        this[k] = init[k] ?? 0;
      for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'])
        this[k] = !!init[k];
      this.relatedTarget = init.relatedTarget ?? null;
    }
    get pageX() {
      return this.clientX;
    }
    get pageY() {
      return this.clientY;
    }
    get offsetX() {
      return this.clientX;
    }
    get offsetY() {
      return this.clientY;
    }
    getModifierState() {
      return false;
    }
  }
  class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? '';
      this.isPrimary = !!init.isPrimary;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.pressure = init.pressure ?? 0;
    }
    getCoalescedEvents() {
      return [];
    }
    getPredictedEvents() {
      return [];
    }
  }
  class WheelEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.deltaX = init.deltaX ?? 0;
      this.deltaY = init.deltaY ?? 0;
      this.deltaZ = init.deltaZ ?? 0;
      this.deltaMode = init.deltaMode ?? 0;
    }
  }
  class KeyboardEvent extends UIEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.key = init.key ?? '';
      this.code = init.code ?? '';
      this.repeat = !!init.repeat;
      for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'])
        this[k] = !!init[k];
    }
    getModifierState() {
      return false;
    }
  }
  class FocusEvent extends UIEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.relatedTarget = init.relatedTarget ?? null;
    }
  }

  // --- DOMParser (DOM-10, SHOULD): a small XML/HTML tokenizer into stand-in elements (three's SVGLoader parses UI
  // icons with it) ---------------------------------------------------------------------------------------------------
  const ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  const decode = (t) =>
    t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#')
        return String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X'
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10),
        );
      return ENTITIES[e] ?? m;
    });
  const VOID = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'source',
    'track',
    'wbr',
  ]);
  class XMLDocumentStandIn extends Node {
    get nodeType() {
      return 9;
    }
    get documentElement() {
      return this.childNodes.find((c) => c instanceof Element) ?? null;
    }
    getElementById(id) {
      for (const n of descendants(this))
        if (n instanceof Element && n.id === String(id)) return n;
      return null;
    }
    querySelector(s) {
      for (const n of descendants(this))
        if (n instanceof Element && matches(n, s)) return n;
      return null;
    }
    querySelectorAll(s) {
      const out = [];
      for (const n of descendants(this))
        if (n instanceof Element && matches(n, s)) out.push(n);
      return out;
    }
    getElementsByTagName(t) {
      return [...descendants(this)].filter(
        (n) =>
          n instanceof Element &&
          (t === '*' || n.localName === t || n.tagName === t),
      );
    }
  }
  class DOMParser {
    parseFromString(text, type = 'text/html') {
      const html = String(type) === 'text/html';
      const doc = new XMLDocumentStandIn();
      const nsOf = (name, attrs, parent) => {
        const prefix = name.includes(':') ? name.split(':')[0] : '';
        const decl = attrs.get(prefix ? `xmlns:${prefix}` : 'xmlns');
        if (decl) return decl;
        if (parent instanceof Element) return parent.namespaceURI;
        if (html)
          return name.toLowerCase() === 'svg'
            ? 'http://www.w3.org/2000/svg'
            : HTML_NS;
        return null;
      };
      const stack = [doc];
      const src = String(text);
      const re =
        /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
      let m;
      while ((m = re.exec(src))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) top.appendChild(new Text(m[1]));
        else if (m[2]) {
          for (let i = stack.length - 1; i > 0; i--)
            if (
              stack[i].tagName === m[2] ||
              stack[i].localName === m[2].toLowerCase()
            ) {
              stack.length = i;
              break;
            }
        } else if (m[3]) {
          const attrs = new Map();
          for (const a of (m[4] || '').matchAll(
            /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
          ))
            attrs.set(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
          const ns = nsOf(m[3], attrs, top);
          const el =
            ns === HTML_NS
              ? document.createElement(m[3])
              : new Element(m[3], ns);
          for (const [k, v] of attrs) el.setAttribute(k, v);
          top.appendChild(el);
          if (!m[5] && !(html && VOID.has(m[3].toLowerCase()))) stack.push(el);
        } else if (m[6] !== undefined && m[6].trim() !== '')
          top.appendChild(new Text(decode(m[6])));
      }
      return doc;
    }
  }

  const define = (name, value) =>
    Object.defineProperty(g, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  for (const [name, value] of Object.entries({
    Node,
    Text,
    DocumentFragment,
    Element,
    HTMLElement,
    Document,
    DOMTokenList,
    MutationObserver,
    ResizeObserver,
    IntersectionObserver,
    DOMRectReadOnly,
    DOMRect,
    DOMParser,
    UIEvent,
    MouseEvent,
    PointerEvent,
    WheelEvent,
    KeyboardEvent,
    FocusEvent,
    HTMLDivElement,
    HTMLSpanElement,
    HTMLBodyElement,
    HTMLHeadElement,
    HTMLHtmlElement,
    HTMLParagraphElement,
    HTMLButtonElement,
    HTMLMetaElement,
    HTMLTitleElement,
    HTMLCanvasElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLLinkElement,
    HTMLStyleElement,
    HTMLScriptElement,
    HTMLMediaElement,
    HTMLVideoElement,
    HTMLAudioElement,
  }))
    if (typeof g[name] !== 'function') define(name, value);
  define('document', document);
  const win = {
    innerWidth: WIDTH,
    innerHeight: HEIGHT,
    outerWidth: WIDTH,
    outerHeight: HEIGHT,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    screenX: 0,
    screenY: 0,
    screenLeft: 0,
    screenTop: 0,
    screen: {
      width: WIDTH,
      height: HEIGHT,
      availWidth: WIDTH,
      availHeight: HEIGHT,
      colorDepth: 24,
      pixelDepth: 24,
      orientation: {
        type: 'landscape-primary',
        angle: 0,
        addEventListener() {},
        removeEventListener() {},
      },
    },
  };
  for (const [k, v] of Object.entries(win)) if (!(k in g)) define(k, v);
  for (const [k, fn] of Object.entries({
    getComputedStyle: (el) => (el && el.style) || makeStyle(),
    scrollTo() {},
    scrollBy() {},
    scroll() {},
    focus() {},
    blur() {},
    print() {},
    alert: (m) => console.log('alert:', m),
    confirm: () => false,
    prompt: () => null,
    open: () => null,
  }))
    if (typeof g[k] !== 'function') define(k, fn);
  if (!g.visualViewport)
    define('visualViewport', {
      width: WIDTH,
      height: HEIGHT,
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      addEventListener() {},
      removeEventListener() {},
    });
})();
