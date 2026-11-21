// Realm-agnostic part of the GL-CTS-1 runner: a minimal DOM and the page loader for one Khronos WebGL
// conformance page. The host runner (harness.mjs) uses it inside a fresh node:vm context per page; the device
// runner (device-main.mjs, bundled into a runtime app) uses it in the page context, which the host driver
// (device-run.mjs) restarts for every page over CDP. All file access, script evaluation and timers come in
// through `env`, so the same code runs in both places.

// ------------------------------------------------------------------------------------------------- tiny DOM

class Node_ {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.nodeName = this.tagName;
    this.localName = tag.toLowerCase();
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.parentNode = null;
    this._listeners = {};
    this._text = '';
    this.className = '';
    this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
  }
  get id() {
    return this.attributes.id ?? '';
  }
  set id(v) {
    this.attributes.id = String(v);
    this.ownerDocument._ids.set(String(v), this);
  }
  get children() {
    return this.childNodes;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  get type() {
    return this.attributes.type ?? '';
  }
  set type(v) {
    this.attributes.type = String(v);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    this.childNodes.push(c);
    c.parentNode = this;
    if (c.tagName === 'SCRIPT' && c.src && !c._fromMarkup) this.ownerDocument._loadScript(c);
    return c;
  }
  insertBefore(c, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(c);
    this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceChild(n, o) {
    const i = this.childNodes.indexOf(o);
    if (i >= 0) this.childNodes[i] = n;
    n.parentNode = this;
    return o;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.ownerDocument._ids.set(String(v), this);
    if ((k === 'width' || k === 'height') && this.tagName === 'CANVAS') this[k] = Number(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  hasAttribute(k) {
    return k in this.attributes;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  addEventListener(t, f) {
    (this._listeners[t] ??= []).push(f);
  }
  removeEventListener(t, f) {
    const l = this._listeners[t];
    if (l) this._listeners[t] = l.filter((x) => x !== f);
  }
  dispatchEvent(ev) {
    if (!ev.target) {
      try {
        ev.target = this;
      } catch {
        /* read-only target */
      }
    }
    for (const f of this._listeners[ev.type] ?? []) f.call(this, ev);
    const h = this['on' + ev.type];
    if (typeof h === 'function') h.call(this, ev);
    return !ev.defaultPrevented;
  }
  get textContent() {
    return this._text + this.childNodes.map((c) => c.textContent ?? '').join('');
  }
  set textContent(v) {
    this._text = String(v);
    this.childNodes = [];
  }
  get text() {
    return this.textContent;
  }
  set text(v) {
    this.textContent = v;
  }
  get innerHTML() {
    return this._text;
  }
  set innerHTML(v) {
    this._text = String(v);
    this.childNodes = [];
  }
  get innerText() {
    return this.textContent;
  }
  set innerText(v) {
    this.textContent = v;
  }
  getElementsByTagName(tag) {
    return this.ownerDocument.getElementsByTagName(tag);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.width ?? 0, bottom: this.height ?? 0, width: this.width ?? 0, height: this.height ?? 0, x: 0, y: 0 };
  }
  get clientWidth() {
    return this.width ?? 0;
  }
  get clientHeight() {
    return this.height ?? 0;
  }
}

class Canvas_ extends Node_ {
  constructor(doc) {
    super(doc, 'canvas');
    this._w = 300;
    this._h = 150;
    this._ctx = null;
    this._type = null;
  }
  get width() {
    return this._w;
  }
  set width(v) {
    this._w = Math.max(0, Number(v) | 0);
    if (this._ctx) this._ctx._dfbReady = false;
  }
  get height() {
    return this._h;
  }
  set height(v) {
    this._h = Math.max(0, Number(v) | 0);
    if (this._ctx) this._ctx._dfbReady = false;
  }
  getContext(type, attrs) {
    const t = type === 'experimental-webgl' ? 'webgl' : type;
    if (t === '2d') return scratch2d(this);
    if (t !== 'webgl' && t !== 'webgl2') return null;
    if (this._ctx) return this._type === t ? this._ctx : null;
    const api = this.ownerDocument._window.__iwnWebGL;
    this._ctx = api.createContext(this, t, attrs ?? undefined);
    this._type = t;
    if (this._ctx) this.ownerDocument._contexts.push(this._ctx);
    return this._ctx;
  }
  toDataURL() {
    return 'data:,';
  }
}

/**
 * Canvas 2D is not part of this harness (pages that draw with it are excluded in subset.txt). Some GLSL pages
 * only use a 2D canvas as scratch ImageData storage for failure diff images: this gives them that much and no
 * drawing (drawImage, fillRect, ... stay absent, so a page that needs them still fails loudly).
 */
function scratch2d(canvas) {
  const win = canvas.ownerDocument._window;
  const make = (w, h) => new win.ImageData(Math.max(1, w | 0), Math.max(1, h | 0));
  return {
    canvas,
    getImageData: (_x, _y, w, h) => make(w, h),
    createImageData: (w, h) => (typeof w === 'object' ? make(w.width, w.height) : make(w, h)),
    putImageData() {},
  };
}

class Document_ {
  constructor(win, testFile) {
    this._window = win;
    this._ids = new Map();
    this._scripts = [];
    this._contexts = [];
    this._testFile = testFile;
    this.documentElement = new Node_(this, 'html');
    this.head = new Node_(this, 'head');
    this.body = new Node_(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.title = '';
    this.readyState = 'loading';
    this._listeners = {};
  }
  createElement(tag) {
    const t = String(tag).toLowerCase();
    const el = t === 'canvas' ? new Canvas_(this) : new Node_(this, t);
    if (t === 'script') {
      el.src = '';
      this._scripts.push(el);
    }
    return el;
  }
  createElementNS(_ns, tag) {
    return this.createElement(tag);
  }
  createTextNode(t) {
    const n = new Node_(this, '#text');
    n._text = String(t);
    return n;
  }
  getElementById(id) {
    return this._ids.get(String(id)) ?? null;
  }
  getElementsByTagName(tag) {
    const t = String(tag).toUpperCase();
    if (t === 'SCRIPT') return this._scripts;
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (t === '*' || c.tagName === t) out.push(c);
        walk(c);
      }
    };
    walk(this.documentElement);
    return out;
  }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    return null;
  }
  querySelectorAll() {
    return [];
  }
  addEventListener(t, f) {
    (this._listeners[t] ??= []).push(f);
  }
  removeEventListener() {}
  dispatchEvent(ev) {
    for (const f of this._listeners[ev.type] ?? []) f.call(this, ev);
    return true;
  }
  _loadScript(el) {
    const rel = resolveRel(this._testFile, el.src);
    const text = this._env.readText(rel);
    if (text === null) {
      this._window.__missing.push(rel);
      this._window.__scriptErrors.push(`${rel}: not found`);
      el.onerror?.({ type: 'error' });
      return;
    }
    try {
      this._env.evalScript(text, rel);
      el.onload?.({ type: 'load' });
    } catch (e) {
      this._window.__scriptErrors.push(`${rel}: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
      el.onerror?.({ type: 'error' });
    }
  }
}

function makeEvent(type, extra = {}) {
  return {
    type,
    defaultPrevented: false,
    cancelable: true,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...extra,
  };
}

// -------------------------------------------------------------------------------------------- page loading

export function parseHtml(html) {
  const items = [];
  const re = /<(script|canvas|div|span|pre|img|video|textarea|p|iframe)\b([^>]*)>([\s\S]*?)<\/\1>|<(canvas|div|img)\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = (m[1] ?? m[4]).toLowerCase();
    const attrText = m[2] ?? m[5] ?? '';
    const attrs = {};
    for (const a of attrText.matchAll(/([\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5];
    for (const a of attrText.matchAll(/\s([\w-]+)(?=\s|$)/g)) if (!(a[1].toLowerCase() in attrs)) attrs[a[1].toLowerCase()] = '';
    items.push({ tag, attrs, body: m[3] ?? '' });
  }
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const bodyOnload = /<body\b[^>]*\bonload\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html);
  return { items, title, bodyOnload: bodyOnload ? (bodyOnload[2] ?? bodyOnload[3]) : null };
}

function isJsType(type) {
  return !type || /^(text|application)\/(javascript|ecmascript)$/i.test(type) || type === 'module';
}

/** ROOT-relative path of `url` referenced from the ROOT-relative page `fromRel` (query/hash dropped). */
export function resolveRel(fromRel, url) {
  const u = String(url).replace(/^file:\/\//, '').split(/[?#]/)[0];
  const parts = u.startsWith('/') ? [] : fromRel.split('/').slice(0, -1);
  for (const seg of u.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Run one CTS page in the realm whose global object is env.win (a fresh node:vm context on the host, the page
 * context itself on device). env: { win, testRel, html, webglVersion, timeout, readText(rel) -> string | null,
 * evalScript(code, filename), timers: { setTimeout, clearTimeout, setInterval, clearInterval }, now(),
 * globals (URL, TextEncoder, ... the realm lacks), installBinding(win), natives (__iwn.gl when the realm lacks
 * it), webglOptions, logError(...args), onResults(results) }. Resolves with the page's results; results.missing
 * lists files readText did not have (the device driver sends them and reruns).
 */
export function runPage(env) {
  const { win, testRel, html } = env;
  const TIMEOUT = env.timeout;
  const T = env.timers;
  const now = env.now;
  const { items, title, bodyOnload } = parseHtml(html);
  const results = { pass: 0, fail: 0, skipped: 0, failures: [], finished: false, errors: [], missing: [] };
  env.onResults?.(results);
  const doc = new Document_(win, testRel);
  doc._env = env;
  doc.title = title;
  const titleEl = doc.createElement('title');
  titleEl._text = title;
  doc.head.appendChild(titleEl);
  const timers = new Set();
  const harness = {
    reportResults(_url, success, msg, skipped) {
      if (skipped) results.skipped++;
      else if (success) results.pass++;
      else {
        results.fail++;
        if (results.failures.length < (env.maxFailures ?? 20)) {
          // the page's latest "Testing ..." debug() line says which iteration failed
          const out = doc.getElementById('console');
          let where = '';
          for (let i = (out?.childNodes.length ?? 0) - 1, n = 0; i >= 0 && n < 40; i--, n++) {
            const t = out.childNodes[i].textContent;
            if (/^\s*Testing\b/.test(t)) {
              where = ` [${t.replace(/<br\s*\/?>/g, '').trim().slice(0, 160)}]`;
              break;
            }
          }
          results.failures.push(String(msg).slice(0, 300) + where);
        }
      }
    },
    notifyFinished() {
      results.finished = true;
    },
  };
  const search = env.webglVersion === 2 ? '?webglVersion=2' : '';
  const pathname = `/sdk/tests/${testRel}`;
  const href = `file://${pathname}${search}`;
  const vars = {
    window: win,
    self: win,
    document: doc,
    parent: { webglTestHarness: harness },
    top: null,
    location: { href, pathname, search, hash: '', protocol: 'file:', host: '', hostname: '', origin: 'null', toString: () => href },
    navigator: { userAgent: 'iwer-native-cts', platform: 'Linux', hardwareConcurrency: 4, language: 'en-US' },
    console: { log() {}, info() {}, warn() {}, error: (...a) => env.logError?.(...a), debug() {}, assert() {}, time() {}, timeEnd() {} },
    performance: { now },
    ...env.globals,
    setTimeout: (f, t, ...a) => {
      const h = T.setTimeout(() => {
        timers.delete(h);
        try {
          typeof f === 'function' ? f(...a) : env.evalScript(String(f), `${testRel}#timer`);
        } catch (e) {
          win.__scriptErrors.push(`timer: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
        }
      }, t);
      timers.add(h);
      return h;
    },
    clearTimeout: (h) => {
      T.clearTimeout(h);
      timers.delete(h);
    },
    setInterval: (f, t) => {
      const h = T.setInterval(() => {
        try {
          f();
        } catch (e) {
          win.__scriptErrors.push(`interval: ${e}`);
        }
      }, t);
      timers.add(h);
      return h;
    },
    clearInterval: (h) => {
      T.clearInterval(h);
      timers.delete(h);
    },
    requestAnimationFrame: (f) =>
      win.setTimeout(() => {
        f(now());
        win.__iwnWebGL.afterAnimationFrame();
      }, 4),
    cancelAnimationFrame: (h) => win.clearTimeout(h),
    addEventListener: (t, f) => (win.__winListeners[t] ??= []).push(f),
    removeEventListener: () => {},
    dispatchEvent: (ev) => {
      for (const f of win.__winListeners[ev.type] ?? []) f.call(win, ev);
      return true;
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    postMessage: (data) => win.setTimeout(() => win.dispatchEvent(makeEvent('message', { data, source: win })), 0),
    devicePixelRatio: 1,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
    innerWidth: 1024,
    innerHeight: 768,
    Image: class {
      constructor() {
        this.complete = false;
        this.width = 0;
        this.height = 0;
      }
      set src(v) {
        this._src = v;
        win.setTimeout(() => this.onerror?.({ type: 'error' }), 0);
      }
      get src() {
        return this._src;
      }
      addEventListener(t, f) {
        if (t === 'error') this.onerror = f;
        if (t === 'load') this.onload = f;
      }
    },
    XMLHttpRequest: class {
      open(_m, url) {
        this._url = url;
      }
      overrideMimeType() {}
      setRequestHeader() {}
      send() {
        const rel = resolveRel(testRel, this._url);
        const text = env.readText(rel);
        if (text === null) {
          win.__missing.push(rel);
          this.status = 404;
          this.responseText = '';
        } else {
          this.responseText = text;
          this.status = 200;
        }
        this.readyState = 4;
        this.onreadystatechange?.();
        this.onload?.();
      }
    },
    __iwnWebGLOptions: env.webglOptions ?? {},
    __winListeners: {},
    __scriptErrors: [],
    __missing: results.missing,
  };
  if (env.natives) vars.__iwn = { gl: env.natives };
  // defineProperty, not assignment: on device some of these exist as the runtime's own (configurable) globals.
  for (const [k, v] of Object.entries(vars)) {
    try {
      Object.defineProperty(win, k, { value: v, writable: true, configurable: true, enumerable: false });
    } catch {
      win.__scriptErrors?.push(`harness: cannot set global ${k}`);
    }
  }
  win.HTMLCanvasElement = Canvas_;
  win.HTMLElement = Node_;
  win.Element = Node_;
  win.HTMLImageElement = win.Image;
  win.HTMLVideoElement = class HTMLVideoElement {};
  win.ImageData = class ImageData {
    constructor(a, b, c) {
      if (a instanceof win.Uint8ClampedArray) {
        this.data = a;
        this.width = b;
        this.height = c ?? a.length / 4 / b;
      } else {
        this.width = a;
        this.height = b;
        this.data = new win.Uint8ClampedArray(a * b * 4);
      }
    }
  };
  env.installBinding(win);
  // Elements from the markup (ids, canvases, shader sources), then scripts in document order.
  const scriptQueue = [];
  for (const it of items) {
    const el = doc.createElement(it.tag);
    for (const [k, v] of Object.entries(it.attrs)) el.setAttribute(k, v);
    if (it.tag === 'canvas') {
      if (it.attrs.width) el.width = Number(it.attrs.width);
      if (it.attrs.height) el.height = Number(it.attrs.height);
    }
    if (it.tag === 'script') {
      el._fromMarkup = true;
      el._text = it.body;
      if (it.attrs.src) el.src = it.attrs.src;
      if (isJsType(it.attrs.type) && !it.attrs.language?.startsWith('x-shader')) scriptQueue.push(el);
    } else {
      el._text = it.body;
    }
    doc.body.appendChild(el);
  }
  // Named access on the Window object: elements with an id are globals unless something else is.
  for (const [id, el] of doc._ids) if (!(id in win)) win[id] = el;
  // The markup's scripts, in document order: { filename, code } (code null: a src file readText lacks).
  const scripts = scriptQueue.map((el) => {
    if (!el.attributes.src) return { filename: `${testRel}#inline`, code: el._text, inline: true };
    const rel = resolveRel(testRel, el.src);
    const code = env.readText(rel);
    if (code === null) win.__missing.push(rel);
    return { filename: rel, code, inline: false };
  });
  const scriptError = (script, e) => {
    if (script.code === null) win.__scriptErrors.push(`${script.filename}: not found`);
    else if (script.inline) {
      win.__scriptErrors.push(`inline: ${e && e.name ? `${e.name}: ${e.message}` : String(e)} @ ${e && e.stack ? e.stack.split('\n').filter((l) => /at /.test(l)).slice(0, 2).join(' | ') : ''}`);
    } else win.__scriptErrors.push(`${script.filename}: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  };
  const page = { scripts, scriptError, finish: () => finishPage() };
  if (env.deferScripts) return page; // the caller runs page.scripts as classic scripts, then page.finish()
  for (const script of scripts) {
    try {
      if (script.code === null) throw new Error('not found');
      env.evalScript(script.code, script.filename);
    } catch (e) {
      scriptError(script, e);
    }
  }
  return finishPage();

  function finishPage() {
    doc.readyState = 'complete';
    doc.dispatchEvent(makeEvent('DOMContentLoaded'));
    win.dispatchEvent(makeEvent('load'));
    if (bodyOnload) {
      try {
        env.evalScript(bodyOnload, `${testRel}#body-onload`);
      } catch (e) {
        win.__scriptErrors.push(`body onload: ${e && e.name ? `${e.name}: ${e.message}` : e}`);
      }
    }
    if (typeof win.onload === 'function') {
      try {
        win.onload({ type: 'load' });
      } catch (e) {
        win.__scriptErrors.push(`onload: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
      }
    }
    return new Promise((resolve) => {
      const t0 = now();
      const gl = env.natives ?? win.__iwn.gl;
      const poll = () => {
        if (results.finished || now() - t0 > TIMEOUT) {
          for (const h of timers) {
            T.clearTimeout(h);
            T.clearInterval(h);
          }
          // Free the page's contexts with their GL objects (they live in the root share group: destroying only the
          // EGL contexts leaked ~0.5 GB of GPU memory over a device run and crashed the app late in the run).
          const release = win.__iwnWebGL?.releaseAllContexts;
          if (typeof release === 'function') {
            try {
              release();
            } catch {
              /* ignore */
            }
          } else {
            for (const c of doc._contexts) {
              try {
                c._lost = true;
                gl.contextDestroy(c._id);
              } catch {
                /* ignore */
              }
            }
          }
          results.errors = [...results.errors, ...win.__scriptErrors];
          results.timedOut = !results.finished;
          resolve(results);
          return;
        }
        T.setTimeout(poll, 5);
      };
      poll();
    });
  }
}
