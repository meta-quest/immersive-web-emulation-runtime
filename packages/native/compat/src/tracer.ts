/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The web-API usage tracer. It is injected into a page (and into each of its
 * workers) before any app code runs, and records every web API the app touches:
 *
 * - interface members: each own method and accessor of every exposed
 *   interface prototype (`HTMLCanvasElement.getContext()`, `Node.appendChild()`,
 *   `WebGL2RenderingContext.drawElements()`, `HTMLCanvasElement.width`,
 *   `HTMLCanvasElement.width=`), wrapped through their property descriptors;
 * - global functions and accessors (`fetch()`, `innerWidth`), global reads of
 *   interface objects (`OffscreenCanvas`), construction (`new Image`) and
 *   static members (`URL.createObjectURL()`), through descriptors plus a Proxy
 *   around each interface object (apply/construct traps only);
 * - probes for things the browser does not have (`typeof VideoFrame`,
 *   `'gpu' in navigator`): a Proxy is spliced into the prototype chain of
 *   `EventTarget.prototype` and `Navigator.prototype` so failed lookups on
 *   window/navigator/document/elements are seen (`miss:VideoFrame`);
 * - argument details that decide compatibility (`getContext("webgl2")`,
 *   `getExtension("OVR_multiview2")`, `requestSession("immersive-vr")`, XR
 *   features, event types listened for, fetch schemes and cross-origin hosts,
 *   worker types, audio formats passed to `decodeAudioData`).
 *
 * Attribution: a call counts for the app only when the nearest JS frame below
 * the tracer belongs to an app script. Frames from the injected tooling (the
 * IWER emulator that provides XR frames in the headless run) are "tool"
 * calls and do not count: on device, IWER host mode is part of the runtime.
 * Stack capture runs on every call until the app has been seen using an API,
 * then it is sampled (the first 64 calls, then powers of two), so call counts
 * are exact, an app use is never missed, and app/tool splits are estimates.
 * The tracer's own internal reads are not counted.
 *
 * Headset trim (`cfg.trim`): before anything is wrapped, globals and
 * `navigator` / `crypto` members the headset lacks by design are deleted and
 * `getContext` returns null for context types the runtime never offers, so
 * the app's feature detection takes the headset path in the trace
 * (`dump().removed` lists what went).
 *
 * Blind spots (by construction): [LegacyUnforgeable] members cannot be
 * redefined, so main-thread `location.*`, `window.document` reads and
 * `Event.isTrusted` are not recorded (the static scan and DOM-11's runtime
 * miss report cover them); members of classes that are neither globals nor
 * returned by a traced getter are not wrapped; a worker terminated within
 * ~50 ms of starting may not report. Objects of non-global classes that come
 * back from getters (IWER's Gamepad, GamepadButton, GamepadHapticActuator) have
 * their prototypes wrapped on first sight.
 *
 * `installApiTracer` must stay self-contained: it is serialised with
 * `Function.prototype.toString` and evaluated in the page. No imports, no
 * references to anything outside its body.
 */

export interface TracerConfig {
  /** 'main' for the page, 'worker' for a worker global. */
  role: 'main' | 'worker';
  /** URL path fragment of injected tooling scripts (tracer, IWER, driver). */
  toolMarker: string;
  /** URL fragment of the tracer script itself (its frames are skipped). */
  selfMarker: string;
  /** Absolute URL workers load the tracer from (main role wraps `Worker`). */
  workerTracerUrl?: string;
  /** Where workers POST their records (`fetch` with the saved original). */
  reportUrl?: string;
  /** Worker report interval in ms (default 1000). */
  flushMs?: number;
  /**
   * Make the page look like the headset where feature detection looks (providers.ts headsetTrim): globals and
   * `navigator` / `crypto` members matching `absent` (and not in `keep`) are deleted before the app runs, and
   * `getContext` returns null for types not in `contexts`.
   */
  trim?: {
    absent: string[];
    keep: string[];
    contexts: string[];
    stubs?: string[];
  };
  /**
   * WebSocket gating (NET-5) without Playwright's page-side WebSocket mock (whose own calls would be charged to
   * the app): a WebSocket to an origin that is neither the page's nor in `allow` is opened to `url` + the
   * encoded original URL instead, which the compat server refuses, so the app sees the error/close events of a
   * blocked connection.
   */
  wsBlock?: { url: string; allow: string[] };
}

export interface ApiRecord {
  /** Total calls/reads (exact). */
  calls: number;
  /** Calls while the page was in the 'xr' phase (exact). */
  xrCalls: number;
  /** Sampled calls attributed to app scripts. */
  app: number;
  /** Sampled calls attributed to injected tooling (IWER emulator, driver). */
  tool: number;
  /** Sampled calls with no JS frame (called from the engine). */
  none: number;
  /** First app call site: `<script file>:<line>:<col>`. */
  site?: string;
  /** Phase of the first app call. */
  phase?: string;
}

export interface TraceDump {
  role: 'main' | 'worker';
  url: string;
  id: string;
  phase: string;
  /** Number of `XRSession.requestAnimationFrame` callbacks run in 'xr'. */
  xrFrames: number;
  apis: Record<string, ApiRecord>;
  /** Wrapping problems (members that could not be wrapped), first 50. */
  skipped: string[];
  /** What the headset trim removed (`VideoDecoder`, `Navigator.gpu`, ...). */
  removed?: string[];
}

export function installApiTracer(cfg: TracerConfig): void {
  const g = globalThis as any;
  if (g.__iwnCompat) return;
  const O = Object;
  const R = Reflect;
  const getOwn = O.getOwnPropertyDescriptor;
  const defProp = O.defineProperty;
  const getProto = O.getPrototypeOf;
  const setProto = O.setPrototypeOf;
  const ownKeys = R.ownKeys;
  const apply = R.apply;
  const construct = R.construct;
  const objToString = O.prototype.toString;
  const fnToString = Function.prototype.toString;
  const ErrorCtor = Error as any;
  const MapCtor = Map;
  const WeakMapCtor = WeakMap;
  const WeakSetCtor = WeakSet;
  const JSONstringify = JSON.stringify;
  const origFetch = g.fetch;
  const origSetInterval = g.setInterval;
  // read before the globals are wrapped, so the worker's own flush timers are not counted as app calls
  const origSetTimeout = g.setTimeout;
  const origXHR = g.XMLHttpRequest;
  const origBlob = g.Blob;
  const origCreateObjectURL = g.URL && g.URL.createObjectURL;
  const URLCtor = g.URL;
  const startedAt = Date.now();
  const id = Math.random().toString(36).slice(2, 10);

  const recs = new MapCtor<string, any>();
  const originals = new WeakMapCtor<object, any>(); // wrapper -> original
  // functions the trim replaced: toString shows the original, but the tracer still wraps them
  const shownAs = new WeakMapCtor<object, any>();
  const removed: string[] = [];
  const wrappedProtos = new WeakSetCtor<object>();
  const skipped: string[] = [];
  let busy = 0;
  let phase = 'boot';
  let xrFrames = 0;
  let lastWho = 'none';

  function rec(key: string) {
    let r = recs.get(key);
    if (!r) {
      r = {
        calls: 0,
        xrCalls: 0,
        app: 0,
        tool: 0,
        none: 0,
        site: undefined,
        phase: undefined,
      };
      recs.set(key, r);
    }
    return r;
  }

  // ---- attribution -------------------------------------------------------
  function prepare(_e: unknown, cs: unknown) {
    return cs;
  }
  function classify(): string {
    const saveP = ErrorCtor.prepareStackTrace;
    const saveL = ErrorCtor.stackTraceLimit;
    ErrorCtor.prepareStackTrace = prepare;
    ErrorCtor.stackTraceLimit = 24;
    const holder: any = {};
    ErrorCtor.captureStackTrace(holder, classify);
    const cs = holder.stack;
    ErrorCtor.prepareStackTrace = saveP;
    ErrorCtor.stackTraceLimit = saveL;
    lastSite = '';
    if (!cs || typeof cs === 'string') return 'none';
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      let file = '';
      let named = '';
      try {
        file = c.getFileName() || '';
        named = c.getScriptNameOrSourceURL() || '';
      } catch {
        file = '';
      }
      if (!file) file = named;
      if (!file) continue;
      if (
        file.indexOf(cfg.selfMarker) >= 0 ||
        named.indexOf(cfg.selfMarker) >= 0
      )
        continue;
      if (
        file.indexOf(cfg.toolMarker) >= 0 ||
        named.indexOf(cfg.toolMarker) >= 0
      )
        return 'tool';
      if (/^(https?|blob|data|file):/.test(file)) {
        let short = file;
        if (short.startsWith('data:')) short = 'data:' + short.slice(5, 30);
        else
          short = short
            .replace(/^[a-z]+:\/\/[^/]+/, '')
            .replace(/^blob:[a-z]+:\/\/[^/]+/, 'blob:');
        lastSite = short + ':' + c.getLineNumber() + ':' + c.getColumnNumber();
        return 'app';
      }
    }
    return 'none';
  }
  let lastSite = '';

  /** Site of the most recent `note` (read right after it, before any nested call can overwrite it). */
  let noteSite = '';
  /** Count one use of `r`; returns who made it ('app' | 'tool' | 'none'). `force` always captures the stack. */
  function note(r: any, force?: boolean): string {
    noteSite = '';
    // the tracer's own reads (URL parsing for fetch details, ...) are neither counted nor attributed
    if (busy) return 'tool';
    const n = ++r.calls;
    if (phase === 'xr') r.xrCalls++;
    let who: string;
    // every call is classified until the app is seen using the API, so an app call is never lost behind a long run
    // of tool calls (IWER reading XR getters every frame); after that, sampled
    if (force || r.app === 0 || n <= 64 || (n & (n - 1)) === 0) {
      busy++;
      try {
        who = classify();
      } finally {
        busy--;
      }
      noteSite = who === 'app' ? lastSite : '';
      if (who === 'app') {
        r.app++;
        if (!r.site) {
          r.site = lastSite;
          r.phase = phase;
        }
      } else if (who === 'tool') r.tool++;
      else r.none++;
      r.lastWho = who;
    } else {
      who = r.lastWho || 'none';
    }
    lastWho = who;
    return who;
  }
  /** Site of the call whose details are being recorded (set by the wrapper around the detail hook). */
  let detailSite = '';
  /** A detail key: counted with the attribution of the call it belongs to. */
  function detail(key: string, who: string) {
    const r = rec(key);
    r.calls++;
    if (phase === 'xr') r.xrCalls++;
    if (who === 'app') {
      r.app++;
      if (!r.site) {
        r.site = detailSite;
        r.phase = phase;
      }
    } else if (who === 'tool') r.tool++;
    else r.none++;
  }

  // ---- helpers -----------------------------------------------------------
  function brand(x: any): string {
    if (x === g) return cfg.role === 'main' ? 'Window' : 'WorkerGlobalScope';
    try {
      const t = apply(objToString, x, []).slice(8, -1);
      if (t && t !== 'Object' && t !== 'Function' && t !== 'EventTarget')
        return t;
      // JS subclasses of EventTarget inherit its tag. The IWER emulator's XR* classes keep their names (on the
      // headset IWER host mode defines them); any other subclass (the app's own) counts as EventTarget, since that
      // is what the runtime has to provide for it
      const c = x && x.constructor;
      if (c && typeof c.name === 'string' && /^XR/.test(c.name)) {
        // only the real XR interfaces (globals, as IWER installs them); an app class that happens to be named XR* is
        // an app subclass of EventTarget like any other
        const gv = g[c.name];
        if (
          gv &&
          (gv === c || originals.get(gv) === c || originals.get(c) === gv)
        )
          return c.name;
        return 'EventTarget';
      }
      if (t === 'EventTarget') return t;
      if (c && typeof c.name === 'string' && c.name) return c.name;
      return t || 'Object';
    } catch {
      return 'Object';
    }
  }
  function str(v: any, max = 60): string {
    try {
      return String(v).slice(0, max);
    } catch {
      return '?';
    }
  }
  function urlClass(u: any): string {
    let s = '';
    try {
      if (u && typeof u === 'object' && 'url' in u) s = String(u.url);
      else s = String(u);
    } catch {
      return 'url:?';
    }
    if (s.startsWith('data:'))
      return 'data:' + (s.slice(5).split(/[;,]/)[0] || 'text/plain');
    if (s.startsWith('blob:')) return 'blob:';
    let abs: any;
    try {
      abs = new URLCtor(s, g.location && g.location.href);
    } catch {
      return 'url:invalid';
    }
    const ext = (abs.pathname.match(/\.([a-z0-9]{1,6})$/i) || [])[1];
    const same = g.location && abs.origin === g.location.origin;
    return (
      (same ? 'same-origin' : 'cross-origin ' + abs.origin) +
      (ext ? ' .' + ext.toLowerCase() : '')
    );
  }
  function gateWebSocket(
    args: any[],
    gate: { url: string; allow: string[] },
  ): any[] {
    let u: any;
    try {
      u = new URLCtor(String(args[0]), g.location.href);
    } catch {
      return args; // the native constructor throws its SyntaxError
    }
    if (u.protocol === 'http:' || u.protocol === 'https:')
      u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    // what the WebSocket constructor rejects (a non-ws scheme, a fragment) goes to it unchanged, so it throws SyntaxError
    if (
      (u.protocol !== 'ws:' && u.protocol !== 'wss:') ||
      String(u.href).indexOf('#') >= 0
    )
      return args;
    const origin = u.origin;
    const own = String(g.location.origin).replace(/^http/, 'ws');
    if (origin === own) return args;
    // the runtime matches ws(s) URLs against the http(s) origin (runtime/net url.h, web/net allowlist.ts)
    const httpOrigin = origin.replace(/^ws/, 'http');
    const httpScheme = u.protocol === 'ws:' ? 'http' : 'https';
    for (const a of gate.allow) {
      if (a === httpOrigin) return args;
      const m = /^(https?):\/\/\*\.(.+)$/.exec(a);
      if (m && m[1] === httpScheme && u.hostname.endsWith('.' + m[2]))
        return args;
    }
    return [gate.url + encodeURIComponent(u.href), ...args.slice(1)];
  }
  function audioFormat(buf: any): string {
    try {
      const u8 =
        buf instanceof ArrayBuffer
          ? new Uint8Array(buf, 0, Math.min(12, buf.byteLength))
          : new Uint8Array(
              buf.buffer,
              buf.byteOffset,
              Math.min(12, buf.byteLength),
            );
      const s = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
      if (s === 'OggS') return 'ogg';
      if (s === 'RIFF') return 'wav';
      if (s === 'fLaC') return 'flac';
      if (
        s.slice(0, 3) === 'ID3' ||
        (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0)
      )
        return 'mp3';
      if (String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp')
        return 'mp4/aac';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ---- argument details --------------------------------------------------
  // key of the wrapped member -> fn(this, args, who, result)
  const details: Record<
    string,
    (self: any, a: any[], who: string, res: any) => void
  > = {};
  const ctxDetail =
    (base: string) => (_s: any, a: any[], who: string, res: any) =>
      detail(
        base + '("' + str(a[0]) + '")' + (res === null ? ' -> null' : ''),
        who,
      );
  details['HTMLCanvasElement.getContext()'] = ctxDetail(
    'HTMLCanvasElement.getContext',
  );
  details['OffscreenCanvas.getContext()'] = ctxDetail(
    'OffscreenCanvas.getContext',
  );
  const extDetail =
    (base: string) => (_s: any, a: any[], who: string, res: any) => {
      detail(base + '("' + str(a[0]) + '")' + (res ? '' : ' -> null'), who);
      if (res && typeof res === 'object') {
        const p = getProto(res);
        if (p && p !== O.prototype && !wrappedProtos.has(p))
          wrapProto(p, 'ext:' + str(a[0]));
      }
    };
  details['WebGLRenderingContext.getExtension()'] =
    extDetail('WebGL.getExtension');
  details['WebGL2RenderingContext.getExtension()'] =
    extDetail('WebGL.getExtension');
  details['Document.createElement()'] = (_s, a, who) =>
    detail('Document.createElement("' + str(a[0]).toLowerCase() + '")', who);
  details['Document.createElementNS()'] = (_s, a, who) =>
    detail('Document.createElementNS("' + str(a[1]) + '")', who);
  details['EventTarget.addEventListener()'] = (s, a, who) =>
    detail('on:' + brand(s) + '.' + str(a[0]), who);
  details['fetch()'] = (_s, a, who) =>
    detail('fetch(' + urlClass(a[0]) + ')', who);
  details['XMLHttpRequest.open()'] = (_s, a, who) =>
    detail('XMLHttpRequest.open(' + urlClass(a[1]) + ')', who);
  details['XMLHttpRequest.responseType='] = (_s, a, who) =>
    detail('XMLHttpRequest.responseType="' + str(a[0]) + '"', who);
  details['HTMLImageElement.src='] = (_s, a, who) =>
    detail('HTMLImageElement.src=(' + urlClass(a[0]) + ')', who);
  details['HTMLMediaElement.src='] = (s, a, who) =>
    detail(brand(s) + '.src=(' + urlClass(a[0]) + ')', who);
  details['Window.matchMedia()'] = (_s, a, who) =>
    detail('matchMedia("' + str(a[0]) + '")', who);
  details['matchMedia()'] = details['Window.matchMedia()'];
  details['Permissions.query()'] = (_s, a, who) =>
    detail('Permissions.query("' + str(a[0] && a[0].name) + '")', who);
  details['BaseAudioContext.decodeAudioData()'] = (_s, a, who) =>
    detail('decodeAudioData(' + audioFormat(a[0]) + ')', who);
  details['createImageBitmap()'] = (_s, a, who) =>
    detail(
      'createImageBitmap(' +
        brand(a[0]) +
        (a[0] && a[0].type ? ' ' + str(a[0].type) : '') +
        ')',
      who,
    );
  details['CanvasRenderingContext2D.font='] = (_s, a, who) =>
    detail(
      'CanvasRenderingContext2D.font=(' +
        str(a[0]).replace(/[0-9.]+px/, 'Npx') +
        ')',
      who,
    );
  const xrInit = (base: string) => (_s: any, a: any[], who: string) => {
    detail(base + '("' + str(a[0]) + '")', who);
    const init = a[1] || {};
    for (const k of ['requiredFeatures', 'optionalFeatures']) {
      const list = init[k];
      if (list && typeof list.length === 'number')
        for (let i = 0; i < list.length; i++)
          detail(
            'XR feature ' +
              str(list[i]) +
              (k === 'requiredFeatures' ? ' (required)' : ' (optional)'),
            who,
          );
    }
  };
  details['XRSystem.requestSession()'] = xrInit('XRSystem.requestSession');
  details['XRSystem.offerSession()'] = xrInit('XRSystem.offerSession');
  details['XRSystem.isSessionSupported()'] = (_s, a, who) =>
    detail('XRSystem.isSessionSupported("' + str(a[0]) + '")', who);
  details['XRSession.requestReferenceSpace()'] = (_s, a, who) =>
    detail('XRSession.requestReferenceSpace("' + str(a[0]) + '")', who);
  details['XRSession.updateRenderState()'] = (_s, a, who) => {
    const st = a[0] || {};
    for (const k of O.keys(st))
      detail('XRSession.updateRenderState({' + k + '})', who);
  };
  details['XRSession.requestAnimationFrame()'] = (_s, a, _who) => {
    // count XR frames: wrap the callback once per call
    const cb = a[0];
    if (typeof cb === 'function') {
      a[0] = function (this: any, ...args: any[]) {
        if (phase === 'xr') xrFrames++;
        return apply(cb, this, args);
      };
    }
  };

  // details that must see the arguments before the call (it detaches or replaces them)
  const PRE_DETAILS = new Set([
    'XRSession.requestAnimationFrame()',
    'BaseAudioContext.decodeAudioData()',
  ]);

  // ---- wrapping ----------------------------------------------------------
  function copyShape(w: any, orig: any) {
    try {
      defProp(w, 'name', { value: orig.name, configurable: true });
      defProp(w, 'length', { value: orig.length, configurable: true });
    } catch {
      /* ignore */
    }
    originals.set(w, orig);
  }
  /** Detail hooks are keyed without the global-scope prefix ('fetch()' also covers 'WorkerGlobalScope.fetch()'). */
  function detailFor(key: string) {
    return (
      details[key] ||
      details[
        key.replace(
          /^(Window|WorkerGlobalScope|DedicatedWorkerGlobalScope)\./,
          '',
        )
      ]
    );
  }
  function wrapMethod(orig: any, key: string) {
    const r = rec(key);
    const d = detailFor(key);
    const pre = PRE_DETAILS.has(key);
    // method syntax: like native methods, the wrapper is not a constructor and has no prototype
    const w = {
      m(this: any, ...args: any[]) {
        // members with detail hooks capture the stack on every call, so their detail rows are attributed exactly
        const who = note(r, !!d && !pre);
        const site = noteSite;
        if (pre && d && !busy) {
          busy++;
          detailSite = site;
          try {
            d(this, args, who, undefined);
          } catch {
            /* ignore */
          } finally {
            busy--;
          }
        }
        const res = apply(orig, this, args);
        if (d && !pre && !busy) {
          busy++;
          detailSite = site;
          try {
            d(this, args, who, res);
          } catch {
            /* ignore */
          } finally {
            busy--;
          }
        }
        return res;
      },
    }.m;
    copyShape(w, orig);
    return w;
  }
  // ES built-in prototypes: objects returned by getters with these are not platform objects
  const ES_PROTOS = new WeakSetCtor<object>();
  for (const c of [
    Object,
    Array,
    Function,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Date,
    RegExp,
    Error,
    ArrayBuffer,
    DataView,
    Float32Array,
    Float64Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
  ] as any[]) {
    if (c && c.prototype) ES_PROTOS.add(c.prototype);
  }
  /**
   * Objects of classes that are not globals (IWER's Gamepad, GamepadButton, GamepadHapticActuator) are only
   * reachable through getters: wrap their prototype the first time one comes back.
   */
  function wrapReturned(v: any) {
    if (!v || typeof v !== 'object') return;
    let o = v;
    if (Array.isArray(v) || ES_PROTOS.has(getProto(v) as object)) {
      if (!Array.isArray(v) || !v.length) return;
      o = v[0];
      if (!o || typeof o !== 'object') return;
    }
    const p = getProto(o);
    if (!p || wrappedProtos.has(p) || ES_PROTOS.has(p)) return;
    let name = '';
    try {
      const c = getOwn(p, 'constructor');
      name = c && typeof c.value === 'function' ? String(c.value.name) : '';
    } catch {
      name = '';
    }
    busy++;
    try {
      // the global read is the tracer's own: inside busy, so it is not counted
      if (
        !/^[A-Z][A-Za-z0-9]+$/.test(name) ||
        (g[name] && g[name].prototype === p)
      ) {
        wrappedProtos.add(p);
        return;
      }
      wrapProto(p, name);
    } finally {
      busy--;
    }
  }
  function wrapGetter(orig: any, key: string) {
    const r = rec(key);
    const w = {
      m(this: any) {
        note(r);
        const v = apply(orig, this, []);
        if (v && typeof v === 'object') wrapReturned(v);
        return v;
      },
    }.m;
    copyShape(w, orig);
    return w;
  }
  function wrapSetter(orig: any, key: string) {
    const r = rec(key);
    const d = detailFor(key);
    const w = {
      m(this: any, v: any) {
        const who = note(r, !!d);
        const site = noteSite;
        if (d && !busy) {
          busy++;
          detailSite = site;
          try {
            d(this, [v], who, undefined);
          } catch {
            /* ignore */
          } finally {
            busy--;
          }
        }
        return apply(orig, this, [v]);
      },
    }.m;
    copyShape(w, orig);
    return w;
  }
  function wrapMember(obj: any, prop: string, prefix: string) {
    let desc: PropertyDescriptor | undefined;
    try {
      desc = getOwn(obj, prop);
    } catch {
      return;
    }
    if (!desc || !desc.configurable) return;
    const base = prefix ? prefix + '.' + prop : prop;
    try {
      if ('value' in desc) {
        const v = desc.value;
        if (typeof v !== 'function' || originals.has(v)) return;
        if (prop === 'constructor') return;
        defProp(obj, prop, { ...desc, value: wrapMethod(v, base + '()') });
      } else {
        const nd: PropertyDescriptor = {
          configurable: true,
          enumerable: desc.enumerable,
        };
        if (desc.get)
          nd.get = originals.has(desc.get)
            ? desc.get
            : wrapGetter(desc.get, base);
        if (desc.set)
          nd.set = originals.has(desc.set)
            ? desc.set
            : wrapSetter(desc.set, base + '=');
        defProp(obj, prop, nd);
      }
    } catch (e) {
      if (skipped.length < 50) skipped.push(base + ': ' + str(e, 80));
    }
  }
  function wrapProto(proto: any, name: string) {
    if (!proto || wrappedProtos.has(proto)) return;
    wrappedProtos.add(proto);
    for (const k of ownKeys(proto)) {
      if (typeof k !== 'string') continue;
      wrapMember(proto, k, name);
    }
  }

  const ES_GLOBALS = new Set(
    (
      'Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp ' +
      'Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError SuppressedError globalThis ' +
      'JSON Math ArrayBuffer SharedArrayBuffer Atomics Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array ' +
      'Float16Array Float32Array Float64Array Uint8ClampedArray BigUint64Array BigInt64Array DataView Map BigInt Set WeakMap ' +
      'WeakSet Proxy Reflect FinalizationRegistry WeakRef decodeURI decodeURIComponent encodeURI encodeURIComponent escape ' +
      'unescape eval isFinite isNaN Iterator DisposableStack AsyncDisposableStack AsyncIterator ' +
      'window self frames top parent globalThis __iwnCompat IWER __iwnCompatDevice'
    ).split(' '),
  );
  // namespaces whose members are traced in place (no Proxy on the namespace)
  const NAMESPACES = ['Intl', 'WebAssembly', 'console', 'CSS'];

  function interfaceProxy(target: any, name: string) {
    const rNew = rec('new ' + name);
    const rCall = rec(name + '()');
    const p: any = new Proxy(target, {
      construct(t, args, nt) {
        // constructors with argument details capture the stack every time, and their detail rows get this call's site
        const withDetail =
          name === 'Worker' ||
          name === 'SharedWorker' ||
          name === 'AudioContext' ||
          name === 'webkitAudioContext' ||
          name === 'WebSocket';
        const who = note(rNew, withDetail);
        detailSite = noteSite;
        if (name === 'WebSocket') {
          busy++;
          try {
            detail(
              'new WebSocket(' + urlClass(args[0]).split(' .')[0] + ')',
              who,
            );
            if (cfg.wsBlock) args = gateWebSocket(args, cfg.wsBlock);
          } catch {
            /* ignore */
          } finally {
            busy--;
          }
        }
        if (name === 'Worker' || name === 'SharedWorker') {
          busy++;
          try {
            const opts = args[1] || {};
            detail(
              'new ' +
                name +
                '(' +
                (opts.type === 'module' ? 'module' : 'classic') +
                ', ' +
                urlClass(args[0]).split(' .')[0] +
                ')',
              who,
            );
            if (name === 'Worker') args = rewriteWorker(args);
          } catch {
            /* ignore */
          } finally {
            busy--;
          }
        }
        if (name === 'AudioContext' || name === 'webkitAudioContext') {
          busy++;
          try {
            const o = args[0] || {};
            if (o.sampleRate) detail('new AudioContext({sampleRate})', who);
            if (o.latencyHint !== undefined)
              detail(
                'new AudioContext({latencyHint: ' + str(o.latencyHint) + '})',
                who,
              );
          } catch {
            /* ignore */
          } finally {
            busy--;
          }
        }
        return construct(t, args, nt === p ? t : nt);
      },
      apply(t, self, args) {
        note(rCall);
        return apply(t, self, args);
      },
    });
    originals.set(p, target);
    try {
      if (
        target.prototype &&
        getOwn(target.prototype, 'constructor')?.configurable
      ) {
        defProp(target.prototype, 'constructor', {
          value: p,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
    } catch {
      /* ignore */
    }
    return p;
  }

  function wrapGlobal(name: string) {
    // __playwright__binding__ and friends: the harness's own globals (routeWebSocket installs a page-side mock)
    if (
      ES_GLOBALS.has(name) ||
      name.startsWith('__iwn') ||
      name.startsWith('__playwright')
    )
      return;
    let desc: PropertyDescriptor | undefined;
    try {
      desc = getOwn(g, name);
    } catch {
      return;
    }
    if (!desc) return;
    if (NAMESPACES.indexOf(name) >= 0) {
      const ns = desc.value;
      if (ns && (typeof ns === 'object' || typeof ns === 'function')) {
        for (const k of ownKeys(ns)) {
          if (typeof k !== 'string') continue;
          const v = ns[k];
          if (typeof v === 'function' && /^[A-Z]/.test(k) && v.prototype) {
            // namespaced interface (Intl.Segmenter, WebAssembly.Memory)
            wrapProto(v.prototype, name + '.' + k);
            try {
              const dk = getOwn(ns, k);
              if (dk && dk.configurable)
                defProp(ns, k, {
                  ...dk,
                  value: interfaceProxy(v, name + '.' + k),
                });
            } catch {
              /* ignore */
            }
          } else wrapMember(ns, k, name);
        }
      }
      return;
    }
    if (!desc.configurable) {
      // unforgeable (document, location, window): its interface prototype is wrapped elsewhere
      return;
    }
    if ('value' in desc) {
      const v = desc.value;
      if (typeof v === 'function') {
        const isInterface =
          /^[A-Z]/.test(name) && v.prototype && typeof v.prototype === 'object';
        if (isInterface) {
          // named constructors (Image, Audio, Option) share the prototype of their interface
          const pc = getOwn(v.prototype, 'constructor');
          const protoName =
            pc && typeof pc.value === 'function' && pc.value.name
              ? pc.value.name
              : name;
          wrapProto(v.prototype, protoName);
          for (const k of ownKeys(v))
            if (
              typeof k === 'string' &&
              k !== 'prototype' &&
              k !== 'length' &&
              k !== 'name'
            )
              wrapMember(v, k, name);
          const proxy = interfaceProxy(v, name);
          const rRead = rec(name);
          let current: any = proxy;
          try {
            defProp(g, name, {
              configurable: true,
              enumerable: desc.enumerable,
              get() {
                note(rRead);
                return current;
              },
              set(nv) {
                current = nv;
              },
            });
          } catch (e) {
            if (skipped.length < 50) skipped.push(name + ': ' + str(e, 80));
          }
        } else {
          wrapMember(g, name, '');
        }
      } else if (v && typeof v === 'object') {
        // a global instance (e.g. navigator in workers is an accessor; crypto/performance are accessors in Chrome)
        const rRead = rec(name);
        let current: any = v;
        try {
          defProp(g, name, {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
              note(rRead);
              return current;
            },
            set(nv) {
              current = nv;
            },
          });
        } catch {
          /* ignore */
        }
      }
    } else {
      wrapMember(g, name, '');
    }
  }

  function wrapAllGlobals(filter?: (name: string) => boolean) {
    busy++;
    try {
      // interface prototypes first (so instances seen through accessors are covered)
      for (const k of ownKeys(g)) {
        if (typeof k !== 'string') continue;
        if (filter && !filter(k)) continue;
        wrapGlobal(k);
      }
      // [Global] interface: Window/WorkerGlobalScope members live on the instance and on the prototypes
      let p = getProto(g);
      while (!filter && p && p !== O.prototype) {
        const c = getOwn(p, 'constructor');
        const n =
          c && typeof c.value === 'function' && c.value.name
            ? c.value.name
            : cfg.role === 'main'
              ? 'Window'
              : 'WorkerGlobalScope';
        wrapProto(p, n);
        p = getProto(p);
      }
    } finally {
      busy--;
    }
  }

  // ---- probes for missing members ----------------------------------------
  const NOISE = new Set([
    'then',
    'toJSON',
    'constructor',
    '__proto__',
    '$$typeof',
    'nodeType',
    'tagName',
    'asymmetricMatch',
    'prototype',
    'length',
    'size',
    'valueOf',
    'toString',
    'inspect',
    '_isVue',
    'isReactComponent',
  ]);
  /**
   * A probe spliced into a prototype chain: a Proxy over an empty object whose prototype is the real next
   * link, so lookups, `instanceof` and `isPrototypeOf` see the same chain as without the tracer.
   */
  function missTrap(owner: string, next: object = O.prototype) {
    return new Proxy(O.create(next), missTrapHandler(owner));
  }
  function missTrapHandler(owner: string): ProxyHandler<any> {
    return {
      get(t, k, recv) {
        if (typeof k === 'string' && !busy && !(k in t) && !NOISE.has(k)) {
          let b = '';
          busy++;
          try {
            b = recv === g ? '' : brand(recv) + '.';
          } finally {
            busy--;
          }
          note(rec('miss:' + b + k));
        }
        return R.get(t, k, recv);
      },
      has(t, k) {
        const present = k in t;
        // `typeof X` / `'x' in obj` on any object whose chain ends here; the receiver is unknown
        if (!present && typeof k === 'string' && !busy && !NOISE.has(k))
          note(rec('miss:' + k + ' (in, ' + owner + ' chain)'));
        return present;
      },
    };
  }
  function installMissProbes() {
    // EventTarget.prototype sits in the global's chain, which is immutable in Chromium; then
    // probe below Node (document, elements) instead, and globals are left to the static scan
    let probed = false;
    try {
      if (g.EventTarget && g.EventTarget.prototype) {
        setProto(
          g.EventTarget.prototype,
          missTrap(
            'EventTarget',
            getProto(g.EventTarget.prototype) || O.prototype,
          ),
        );
        probed = true;
      }
    } catch {
      probed = false;
    }
    if (!probed && g.Node && g.Node.prototype && g.EventTarget) {
      try {
        const et = g.EventTarget.prototype;
        // Node.prototype -> probe -> EventTarget.prototype (so nodes are still instanceof EventTarget)
        setProto(g.Node.prototype, missTrap('Node', et));
      } catch (e) {
        skipped.push('miss probe Node: ' + str(e, 80));
      }
    }
    for (const n of ['Navigator', 'WorkerNavigator']) {
      try {
        if (g[n] && g[n].prototype && getProto(g[n].prototype) === O.prototype)
          setProto(g[n].prototype, missTrap(n, O.prototype));
      } catch (e) {
        skipped.push('miss probe ' + n + ': ' + str(e, 80));
      }
    }
  }

  // ---- workers -----------------------------------------------------------
  function rewriteWorker(args: any[]): any[] {
    if (!cfg.workerTracerUrl || !origBlob || !origCreateObjectURL) return args;
    const opts = args[1] || {};
    let abs: string;
    try {
      abs = new URLCtor(String(args[0]), g.location.href).href;
    } catch {
      return args;
    }
    const sameOrigin = abs.startsWith(g.location.origin + '/');
    if (sameOrigin) {
      // the static server prepends the tracer to worker scripts it serves; tell it the type
      try {
        const x = new origXHR();
        x.open(
          'GET',
          cfg.toolMarker +
            'worker-type?type=' +
            (opts.type === 'module' ? 'module' : 'classic') +
            '&url=' +
            encodeURIComponent(abs),
          false,
        );
        x.send();
      } catch {
        /* ignore */
      }
      return args;
    }
    const t = JSONstringify(cfg.workerTracerUrl);
    const u = JSONstringify(abs);
    const tag = '\n//# sourceURL=' + cfg.selfMarker + '-wrapper.js\n';
    const src =
      opts.type === 'module'
        ? 'import ' + t + ';\nimport ' + u + ';' + tag
        : 'self.__iwnCompatWorkerUrl=' +
          u +
          ';importScripts(' +
          t +
          ');importScripts(' +
          u +
          ');' +
          tag;
    const blobUrl = apply(origCreateObjectURL, URLCtor, [
      new origBlob([src], { type: 'text/javascript' }),
    ]);
    return [blobUrl, ...args.slice(1)];
  }

  // ---- Function.prototype.toString keeps wrappers looking native ----------
  try {
    const ts = function toString(this: any) {
      let o = originals.get(this);
      // a traced wrapper around a trim replacement: show the native original
      while (o !== undefined && shownAs.has(o)) o = shownAs.get(o);
      if (o === undefined) o = shownAs.get(this);
      return apply(fnToString, o !== undefined ? o : this, []);
    };
    originals.set(ts, fnToString);
    defProp(Function.prototype, 'toString', {
      value: ts,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    /* ignore */
  }

  // ---- api ---------------------------------------------------------------
  function dump(): TraceDump {
    const apis: Record<string, ApiRecord> = {};
    for (const [k, r] of recs) {
      if (!r.calls) continue;
      apis[k] = {
        calls: r.calls,
        xrCalls: r.xrCalls,
        app: r.app,
        tool: r.tool,
        none: r.none,
        site: r.site,
        phase: r.phase,
      };
    }
    let url = '';
    try {
      url = String(g.__iwnCompatWorkerUrl || (g.location && g.location.href));
      if (url.startsWith('data:')) url = url.slice(0, 48) + '...';
    } catch {
      /* ignore */
    }
    return {
      role: cfg.role,
      url,
      id,
      phase,
      xrFrames,
      apis,
      skipped: skipped.slice(),
      removed: removed.slice(),
    };
  }
  g.__iwnCompat = {
    dump,
    setPhase(p: string) {
      phase = p;
    },
    /** Wrap globals installed after the tracer (the IWER emulator's XR* classes, navigator.xr). */
    wrapLate(names: string[]) {
      busy++;
      try {
        for (const n of names) {
          // a global the tracer already turned into an accessor and IWER reassigned: back to data first
          const v = g[n];
          if (v === undefined) continue;
          try {
            defProp(g, n, {
              value: originals.get(v) || v,
              writable: true,
              configurable: true,
              enumerable: false,
            });
          } catch {
            continue;
          }
          wrapGlobal(n);
        }
        const nav = g.navigator;
        const xd = nav && getOwn(nav, 'xr');
        if (xd && 'value' in xd && xd.value) {
          wrapProto(getProto(xd.value), 'XRSystem');
          const rXr = rec('Navigator.xr');
          const xrv = xd.value;
          defProp(nav, 'xr', {
            configurable: true,
            enumerable: xd.enumerable,
            get() {
              note(rXr);
              return xrv;
            },
          });
        }
        // IWER's installRuntime defines navigator.userAgent (and maybe more) as own data properties of the
        // navigator instance, which shadow the wrapped Navigator.prototype getters: trace those reads too
        if (nav) {
          for (const k of ownKeys(nav)) {
            if (typeof k !== 'string' || k === 'xr') continue;
            const d = getOwn(nav, k);
            if (!d || !('value' in d) || !d.configurable) continue;
            if (typeof d.value === 'function') {
              wrapMember(nav, k, 'Navigator');
              continue;
            }
            const r = rec('Navigator.' + k);
            let cur = d.value;
            try {
              defProp(nav, k, {
                configurable: true,
                enumerable: d.enumerable,
                get() {
                  note(r);
                  return cur;
                },
                set: d.writable
                  ? (nv: any) => {
                      cur = nv;
                    }
                  : undefined,
              });
            } catch {
              /* ignore */
            }
          }
        }
        // and it replaces makeXRCompatible on the WebGL prototypes after the tracer wrapped them
        for (const n of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
          const proto = g[n] && g[n].prototype;
          if (proto) wrapMember(proto, 'makeXRCompatible', n);
        }
      } finally {
        busy--;
      }
    },
    startedAt,
    get lastWho() {
      return lastWho;
    },
  };
  try {
    defProp(g, '__iwnCompat', { enumerable: false });
  } catch {
    /* ignore */
  }

  // ---- headset trim ------------------------------------------------------
  function trimSurface() {
    const t = cfg.trim;
    if (!t) return;
    const res = t.absent.map((src) => new RegExp(src));
    const keep = new Set(t.keep);
    const stubs = new Set(t.stubs || []);
    const absent = (base: string) =>
      !keep.has(base) && res.some((r) => r.test(base));
    // globals: the global object and its prototype chain ([Global] members live on both)
    const gone = new Set<string>();
    for (let o = g; o && o !== O.prototype; o = getProto(o)) {
      for (const k of ownKeys(o)) {
        if (typeof k !== 'string' || k.startsWith('__iwn') || !absent(k))
          continue;
        try {
          if (delete o[k]) gone.add(k);
        } catch {
          /* non-configurable: stays */
        }
      }
    }
    for (const k of gone) if (!(k in g)) removed.push(k);
    // members of navigator and crypto (prototypes and the instances)
    // (and BaseAudioContext.audioWorklet: AUD-6 has no AudioWorklet)
    for (const [ifaceNames, prefix, inst] of [
      [['Navigator', 'WorkerNavigator'], 'Navigator', 'navigator'],
      [['Crypto'], 'Crypto', 'crypto'],
      [['BaseAudioContext'], 'BaseAudioContext', ''],
    ] as Array<[string[], string, string]>) {
      const holders: any[] = [];
      for (const n of ifaceNames)
        if (g[n] && g[n].prototype) holders.push(g[n].prototype);
      try {
        if (inst && g[inst]) holders.push(g[inst]);
      } catch {
        /* ignore */
      }
      for (const h of holders) {
        for (const k of ownKeys(h)) {
          if (typeof k === 'string' && stubs.has(prefix + '.' + k)) {
            // absent by design, but a runtime layer installs a stub: the headset's method throws NotSupportedError
            const desc = getOwn(h, k);
            if (!desc || typeof desc.value !== 'function' || !desc.configurable)
              continue;
            const orig = desc.value;
            const label = prefix + '.' + k;
            const w = {
              [k](this: any) {
                const E = g.DOMException;
                throw typeof E === 'function'
                  ? new E(
                      label +
                        '() is not supported (a stub in the native runtime)',
                      'NotSupportedError',
                    )
                  : new Error('NotSupportedError: ' + label + '()');
              },
            }[k]!;
            try {
              defProp(w, 'length', { value: orig.length, configurable: true });
            } catch {
              /* ignore */
            }
            shownAs.set(w, orig);
            defProp(h, k, { ...desc, value: w });
            continue;
          }
          if (typeof k !== 'string' || !absent(prefix + '.' + k)) continue;
          try {
            if (delete h[k] && removed.indexOf(prefix + '.' + k) < 0)
              removed.push(prefix + '.' + k);
          } catch {
            /* ignore */
          }
        }
      }
    }
    // canvas context types the runtime never offers: null, as on the headset
    const ok = new Set(t.contexts);
    for (const n of ['HTMLCanvasElement', 'OffscreenCanvas']) {
      const proto = g[n] && g[n].prototype;
      const desc = proto && getOwn(proto, 'getContext');
      if (!desc || typeof desc.value !== 'function' || !desc.configurable)
        continue;
      const orig = desc.value;
      const w = {
        getContext(this: any, ...args: any[]) {
          if (!ok.has(String(args[0]))) return null;
          return apply(orig, this, args);
        },
      }.getContext;
      try {
        defProp(w, 'length', { value: orig.length, configurable: true });
      } catch {
        /* ignore */
      }
      shownAs.set(w, orig);
      defProp(proto, 'getContext', { ...desc, value: w });
    }
  }

  busy++;
  try {
    trimSurface();
    wrapAllGlobals();
    // navigator / document / location / performance instances are covered by their interface prototypes
    installMissProbes();
  } finally {
    busy--;
  }

  if (cfg.role === 'worker' && cfg.reportUrl && origFetch) {
    const takePhase = (text: string) => {
      try {
        const p = JSON.parse(text).phase;
        if (typeof p === 'string') phase = p;
      } catch {
        /* ignore */
      }
    };
    const flush = () => {
      busy++;
      try {
        (
          apply(origFetch, g, [
            cfg.reportUrl,
            { method: 'POST', body: JSONstringify(dump()) },
          ]) as Promise<any>
        )
          .then((r: any) => r.text())
          .then(takePhase)
          .catch(() => {});
      } catch {
        /* ignore */
      } finally {
        busy--;
      }
    };
    // a synchronous report for self.close(): the worker stops right after it
    const flushSync = () => {
      if (!origXHR) return;
      busy++;
      try {
        const x = new origXHR();
        x.open('POST', cfg.reportUrl, false);
        x.send(JSONstringify(dump()));
        takePhase(String(x.responseText));
      } catch {
        /* ignore */
      } finally {
        busy--;
      }
    };
    apply(origSetInterval, g, [flush, cfg.flushMs || 1000]);
    // an early report too, so short-lived workers (done or terminated within a flush interval) still report
    apply(origSetTimeout, g, [flush, 50]);
    apply(origSetTimeout, g, [flush, 200]);
    const closeDesc = getOwn(getProto(g) || {}, 'close') || getOwn(g, 'close');
    const origClose = g.close;
    if (typeof origClose === 'function') {
      try {
        const host = getOwn(g, 'close') ? g : getProto(g);
        defProp(host, 'close', {
          configurable: true,
          writable: true,
          enumerable: closeDesc ? closeDesc.enumerable : false,
          value: {
            close(this: any) {
              flushSync();
              return apply(origClose, this, []);
            },
          }.close,
        });
      } catch {
        /* ignore */
      }
    }
  }
}

/** The tracer as a script for injection: `(installApiTracer)(cfg)`. */
export function tracerScript(cfg: TracerConfig): string {
  return `;(${installApiTracer.toString()})(${JSON.stringify(cfg)});\n`;
}
