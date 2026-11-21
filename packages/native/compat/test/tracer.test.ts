/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The tracer in a vm context with a few browser-shaped interfaces. Script file
 * names decide attribution (app vs injected tooling), as in the page.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { tracerScript, type TraceDump } from '../src/tracer.ts';

const ORIGIN = 'http://127.0.0.1:9';
const PRELUDE = `(() => {
class EventTarget { addEventListener(type, cb) { (this.__l ??= []).push([type, cb]); } }
class Node extends EventTarget { appendChild(c) { return c; } }
class HTMLCanvasElement extends Node {
  constructor() { super(); this._w = 300; }
  get width() { return this._w; }
  set width(v) { this._w = v; }
  getContext(type) { return type === 'webgl2' ? new WebGL2RenderingContext() : null; }
}
class OVRExt { framebufferTextureMultiviewOVR() { return 1; } }
class WebGL2RenderingContext {
  drawElements() {}
  getExtension(name) { return name === 'OVR_multiview2' ? new OVRExt() : null; }
}
class GamepadButton { get value() { return 1; } get pressed() { return true; } }
class Gamepad { get buttons() { return [new GamepadButton()]; } get axes() { return [0, 0]; } }
class XRInputSource { get gamepad() { return this._g ??= new Gamepad(); } }
globalThis.XRInputSource = XRInputSource;
class Navigator {}
Object.defineProperty(Navigator.prototype, 'platform', { get() { return 'Linux'; }, configurable: true });
globalThis.Navigator = Navigator;
globalThis.navigator = new Navigator();
globalThis.EventTarget = EventTarget;
globalThis.Node = Node;
globalThis.HTMLCanvasElement = HTMLCanvasElement;
globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
globalThis.fetch = function fetch(u) { return Promise.resolve(u); };
globalThis.location = { href: '${ORIGIN}/', origin: '${ORIGIN}' };
})();`;

function setup() {
  const ctx = vm.createContext({
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    console,
  });
  vm.runInContext(PRELUDE, ctx, {
    filename: `${ORIGIN}/__iwn_compat/prelude.js`,
  });
  vm.runInContext(
    tracerScript({
      role: 'main',
      toolMarker: '/__iwn_compat/',
      selfMarker: '/__iwn_compat/tracer',
    }),
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/tracer.js` },
  );
  const app = (code: string) =>
    vm.runInContext(code, ctx, { filename: `${ORIGIN}/assets/index-abc.js` });
  const tool = (code: string) =>
    vm.runInContext(code, ctx, { filename: `${ORIGIN}/__iwn_compat/iwer.js` });
  const dumpIt = () =>
    vm.runInContext('__iwnCompat.dump()', ctx, {
      filename: `${ORIGIN}/__iwn_compat/driver.js`,
    }) as TraceDump;
  return { ctx, app, tool, dump: dumpIt };
}

test('records app calls with call sites and argument details', () => {
  const t = setup();
  t.app(`
    const c = new HTMLCanvasElement();
    c.width = 640;
    const w = c.width;
    const gl = c.getContext('webgl2');
    gl.drawElements(); gl.drawElements();
    const ext = gl.getExtension('OVR_multiview2');
    ext.framebufferTextureMultiviewOVR();
    gl.getExtension('EXT_nope');
    c.addEventListener('pointerdown', () => {});
    fetch('https://cdn.example.net/a/model.glb');
    fetch('./local.json');
  `);
  const d = t.dump();
  const a = d.apis;
  assert.equal(a['new HTMLCanvasElement']?.app, 1);
  assert.equal(a['HTMLCanvasElement.width=']?.app, 1);
  assert.equal(a['HTMLCanvasElement.width']?.app, 1);
  assert.equal(a['HTMLCanvasElement.getContext("webgl2")']?.app, 1);
  assert.equal(a['WebGL2RenderingContext.drawElements()']?.calls, 2);
  assert.match(
    a['WebGL2RenderingContext.drawElements()']!.site!,
    /^\/assets\/index-abc\.js:\d+:\d+$/,
  );
  assert.equal(a['WebGL.getExtension("OVR_multiview2")']?.app, 1);
  assert.equal(a['WebGL.getExtension("EXT_nope") -> null']?.app, 1);
  assert.equal(
    a['ext:OVR_multiview2.framebufferTextureMultiviewOVR()']?.app,
    1,
  );
  assert.equal(a['on:HTMLCanvasElement.pointerdown']?.app, 1);
  assert.equal(a['fetch(cross-origin https://cdn.example.net .glb)']?.app, 1);
  assert.equal(a['fetch(same-origin .json)']?.app, 1);
  assert.equal(a['HTMLCanvasElement']?.app, 1); // the global read of the interface object
});

test('calls made by injected tooling are not attributed to the app', () => {
  const t = setup();
  t.tool(
    `const c = new HTMLCanvasElement(); c.getContext('webgl2').drawElements();`,
  );
  const a = t.dump().apis;
  assert.equal(a['WebGL2RenderingContext.drawElements()']?.app, 0);
  assert.equal(a['WebGL2RenderingContext.drawElements()']?.tool, 1);
  // a tool function called by the app still counts as tool for what it does inside
  t.tool(
    `globalThis.toolHelper = () => new HTMLCanvasElement().getContext('webgl2');`,
  );
  t.app(`toolHelper();`);
  assert.equal(t.dump().apis['HTMLCanvasElement.getContext()']?.app, 0);
});

test('wrapped members keep identity, shape and native-looking toString', () => {
  const t = setup();
  const r = t.app(`
    const d = Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype, 'drawElements');
    const c = new HTMLCanvasElement();
    [
      WebGL2RenderingContext.prototype.drawElements === WebGL2RenderingContext.prototype.drawElements,
      d.value.name,
      d.value.length,
      Function.prototype.toString.call(d.value).includes('drawElements() {}'),
      c instanceof HTMLCanvasElement,
      c.constructor === HTMLCanvasElement,
      new (class extends HTMLCanvasElement {})() instanceof HTMLCanvasElement,
    ];
  `);
  assert.deepEqual(Array.from(r as unknown[]), [
    true,
    'drawElements',
    0,
    true,
    true,
    true,
    true,
  ]);
});

test('setPhase and xr counts; navigator instance members through the prototype', () => {
  const t = setup();
  t.app(`navigator.platform;`);
  vm.runInContext(`__iwnCompat.setPhase('xr')`, t.ctx, {
    filename: `${ORIGIN}/__iwn_compat/driver.js`,
  });
  t.app(
    `const gl = new HTMLCanvasElement().getContext('webgl2'); for (let i = 0; i < 5; i++) gl.drawElements();`,
  );
  const d = t.dump();
  assert.equal(d.phase, 'xr');
  assert.equal(d.apis['WebGL2RenderingContext.drawElements()']?.xrCalls, 5);
  assert.equal(d.apis['WebGL2RenderingContext.drawElements()']?.phase, 'xr');
  assert.equal(d.apis['Navigator.platform']?.app, 1);
});

test('the tracer leaves prototype identity and constructibility as they were', () => {
  const t = setup();
  const r = t.app(`
    const c = new HTMLCanvasElement();
    const gc = HTMLCanvasElement.prototype.getContext;
    let threw = '';
    try { new gc(); } catch (e) { threw = e.constructor.name; }
    [
      c instanceof EventTarget,
      c instanceof Node,
      EventTarget.prototype.isPrototypeOf(c),
      navigator instanceof Object,
      'prototype' in gc,
      threw,
      typeof c.nope,
    ];
  `);
  assert.deepEqual(Array.from(r as unknown[]), [
    true,
    true,
    true,
    true,
    false,
    'TypeError',
    'undefined',
  ]);
  assert.ok((t.dump().apis['miss:HTMLCanvasElement.nope']?.app ?? 0) > 0); // the miss probe still sees it
});

test('detail rows get the call site of their own call, also past the sampling window', () => {
  const t = setup();
  t.app(
    `for (let i = 0; i < 70; i++) new HTMLCanvasElement().getContext('webgl2');`,
  );
  t.app(`\n\nnew HTMLCanvasElement().getContext('2d');`);
  const a = t.dump().apis;
  assert.equal(a['HTMLCanvasElement.getContext("webgl2")']?.app, 70);
  // the fake canvas has no 2d context: the detail row says it came back null
  assert.match(
    a['HTMLCanvasElement.getContext("2d") -> null']!.site!,
    /index-abc\.js:3:/,
  );
});

test('objects of non-global classes returned by getters are traced (IWER gamepads)', () => {
  const t = setup();
  t.app(
    `const s = new XRInputSource(); const g = s.gamepad; g.buttons[0].value; g.axes; g.buttons[0].pressed;`,
  );
  const a = t.dump().apis;
  assert.equal(a['XRInputSource.gamepad']?.app, 1);
  assert.equal(a['Gamepad.buttons']?.app, 2);
  assert.equal(a['Gamepad.axes']?.app, 1);
  assert.equal(a['GamepadButton.value']?.app, 1);
  assert.equal(a['GamepadButton.pressed']?.app, 1);
});

test('worker role: detail hooks match the global-scope-prefixed members', () => {
  const ctx = vm.createContext({
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    console,
  });
  vm.runInContext(
    `(() => {
    class WorkerGlobalScope {}
    WorkerGlobalScope.prototype.fetch = function fetch(u) { return Promise.resolve(u); };
    Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);
    globalThis.WorkerGlobalScope = WorkerGlobalScope;
    globalThis.location = { href: '${ORIGIN}/w.js', origin: '${ORIGIN}' };
  })();`,
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/prelude.js` },
  );
  vm.runInContext(
    tracerScript({
      role: 'worker',
      toolMarker: '/__iwn_compat/',
      selfMarker: '/__iwn_compat/tracer',
    }),
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/tracer.js` },
  );
  vm.runInContext(`fetch('https://cdn.example.net/x.wasm');`, ctx, {
    filename: `${ORIGIN}/assets/worker.js`,
  });
  const a = (
    vm.runInContext('__iwnCompat.dump()', ctx, {
      filename: `${ORIGIN}/__iwn_compat/driver.js`,
    }) as TraceDump
  ).apis;
  assert.equal(a['WorkerGlobalScope.fetch()']?.app, 1);
  assert.equal(a['fetch(cross-origin https://cdn.example.net .wasm)']?.app, 1);
});

test('an app call is recorded even after a long run of tool calls of the same API', () => {
  const t = setup();
  t.tool(
    `const c = new HTMLCanvasElement(); for (let i = 0; i < 200; i++) c.width;`,
  );
  t.app(`\nnew HTMLCanvasElement().width;`);
  const a = t.dump().apis;
  assert.equal(a['HTMLCanvasElement.width']?.app, 1);
  assert.match(a['HTMLCanvasElement.width']!.site!, /index-abc\.js:2:/);
  assert.equal(a['HTMLCanvasElement.width']?.calls, 201);
});

test('listeners on app subclasses of EventTarget record EventTarget; IWER XR classes keep their names', () => {
  const t = setup();
  t.app(`
    class MyTarget extends EventTarget { get [Symbol.toStringTag]() { return 'EventTarget'; } }
    class XRThing extends EventTarget { get [Symbol.toStringTag]() { return 'EventTarget'; } }
    new MyTarget().addEventListener('ping', () => {});
    // an app class that happens to be named XR*: an EventTarget subclass like any other
    new XRThing().addEventListener('select', () => {});
  `);
  // a real XR interface (a global, as IWER installs them) keeps its name
  t.tool(
    `class XRSession extends EventTarget { get [Symbol.toStringTag]() { return 'EventTarget'; } } globalThis.XRSession = XRSession;`,
  );
  t.tool(`__iwnCompat.wrapLate(['XRSession']);`);
  t.app(`new XRSession().addEventListener('end', () => {});`);
  const a = t.dump().apis;
  assert.equal(a['on:EventTarget.ping']?.app, 1);
  assert.equal(a['on:EventTarget.select']?.app, 1);
  assert.equal(a['on:XRThing.select'], undefined);
  assert.equal(a['on:XRSession.end']?.app, 1);
  assert.equal(a['on:MyTarget.ping'], undefined);
});

test('constructor detail rows get the site of their own construction', () => {
  const t = setup();
  t.app(`
    globalThis.AudioContext = class AudioContext {};
    globalThis.WebSocket = class WebSocket { constructor(u) { this.u = u; } };
  `);
  t.tool(`__iwnCompat.wrapLate(['AudioContext', 'WebSocket']);`);
  // an unrelated detail call first: its site must not leak into the constructor rows
  t.app(
    `new HTMLCanvasElement().getContext('webgl2');\n\nnew AudioContext({ latencyHint: 'interactive' });\nnew WebSocket('wss://game.example-mp.net/room');`,
  );
  const a = t.dump().apis;
  assert.match(
    a['new AudioContext({latencyHint: interactive})']!.site!,
    /index-abc\.js:3:/,
  );
  assert.match(
    a['new WebSocket(cross-origin wss://game.example-mp.net)']!.site!,
    /index-abc\.js:4:/,
  );
});

test('the tracer does not count its own reads (busy guard), in the page and in workers', () => {
  // main: fetch details parse the URL against location (a wrapped accessor here); those reads are the tracer's
  const ctx = vm.createContext({
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    console,
  });
  vm.runInContext(
    `(() => {
    class WorkerGlobalScope {}
    WorkerGlobalScope.prototype.fetch = function fetch(u) { return Promise.resolve({ text: () => Promise.resolve('{}') }); };
    let timers = 0;
    WorkerGlobalScope.prototype.setTimeout = function setTimeout(f, ms) { timers++; return timers; };
    WorkerGlobalScope.prototype.setInterval = function setInterval(f, ms) { return 1; };
    Object.defineProperty(WorkerGlobalScope.prototype, 'location', { get() { return { href: '${ORIGIN}/w.js', origin: '${ORIGIN}' }; }, configurable: true });
    Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);
    globalThis.WorkerGlobalScope = WorkerGlobalScope;
  })();`,
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/prelude.js` },
  );
  vm.runInContext(
    tracerScript({
      role: 'worker',
      toolMarker: '/__iwn_compat/',
      selfMarker: '/__iwn_compat/tracer',
      reportUrl: `${ORIGIN}/__iwn_compat/report`,
      flushMs: 500,
    }),
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/tracer.js` },
  );
  vm.runInContext(
    `fetch('https://cdn.example.net/x.wasm'); fetch('./y.json');`,
    ctx,
    { filename: `${ORIGIN}/assets/worker.js` },
  );
  const a = (
    vm.runInContext('__iwnCompat.dump()', ctx, {
      filename: `${ORIGIN}/__iwn_compat/driver.js`,
    }) as TraceDump
  ).apis;
  assert.equal(a['WorkerGlobalScope.fetch()']?.calls, 2);
  // the worker's own flush timers and the URL parsing's location reads are not app (or any) calls
  assert.equal(a['WorkerGlobalScope.setTimeout()'], undefined);
  assert.equal(a['WorkerGlobalScope.location'], undefined);
});

test('headset trim: absent globals and navigator members are gone, unsupported contexts return null', () => {
  const ctx = vm.createContext({
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    console,
  });
  vm.runInContext(PRELUDE, ctx, {
    filename: `${ORIGIN}/__iwn_compat/prelude.js`,
  });
  vm.runInContext(
    `globalThis.VideoDecoder = class VideoDecoder {}; globalThis.BroadcastChannel = class BroadcastChannel {}; globalThis.caches = {};
    Object.defineProperty(Navigator.prototype, 'gpu', { get() { return { requestAdapter() {} }; }, configurable: true });
    // a canvas that offers every context type, so the trim's filter is what makes 'webgpu' null
    HTMLCanvasElement.prototype.getContext = function getContext(type) { return { type }; };`,
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/prelude2.js` },
  );
  const trim = {
    absent: [
      '^(VideoDecoder)\\b',
      '^(Navigator\\.gpu|BroadcastChannel|caches)\\b',
    ],
    keep: ['caches'],
    contexts: ['2d', 'webgl', 'webgl2'],
  };
  vm.runInContext(
    tracerScript({
      role: 'main',
      toolMarker: '/__iwn_compat/',
      selfMarker: '/__iwn_compat/tracer',
      trim,
    }),
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/tracer.js` },
  );
  const r = vm.runInContext(
    `[typeof VideoDecoder, 'BroadcastChannel' in globalThis, typeof caches, navigator.gpu === undefined, 'gpu' in navigator, new HTMLCanvasElement().getContext('webgpu'), String(HTMLCanvasElement.prototype.getContext).includes('return { type }'), new HTMLCanvasElement().getContext('webgl2').type]`,
    ctx,
    { filename: `${ORIGIN}/assets/index-abc.js` },
  );
  assert.deepEqual(Array.from(r as unknown[]), [
    'undefined',
    false,
    'object',
    true,
    false,
    null,
    true,
    'webgl2',
  ]);
  const d = vm.runInContext('__iwnCompat.dump()', ctx, {
    filename: `${ORIGIN}/__iwn_compat/driver.js`,
  }) as TraceDump;
  assert.deepEqual([...(d.removed ?? [])].sort(), [
    'BroadcastChannel',
    'Navigator.gpu',
    'VideoDecoder',
  ]);
  // the app's probes of the removed navigator member are recorded; the context request is a null detail row
  assert.ok((d.apis['miss:Navigator.gpu']?.app ?? 0) > 0);
  assert.ok((d.apis['miss:gpu (in, Navigator chain)']?.app ?? 0) > 0);
  assert.equal(
    d.apis['HTMLCanvasElement.getContext("webgpu") -> null']?.app,
    1,
  );
});

test('wrapLate traces what IWER installs on the navigator instance and the WebGL prototypes', () => {
  const t = setup();
  // IWER's installRuntime: an own data property shadowing Navigator.prototype.userAgent, and a new makeXRCompatible
  t.tool(`Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 OculusBrowser', writable: false, configurable: true, enumerable: true });
    WebGL2RenderingContext.prototype.makeXRCompatible = function makeXRCompatible() { return Promise.resolve(); };
    __iwnCompat.wrapLate([]);`);
  const r = t.app(
    `[/OculusBrowser/.test(navigator.userAgent), typeof new HTMLCanvasElement().getContext('webgl2').makeXRCompatible()]`,
  );
  assert.deepEqual(Array.from(r as unknown[]), [true, 'object']);
  const a = t.dump().apis;
  assert.equal(a['Navigator.userAgent']?.app, 1);
  assert.equal(a['WebGL2RenderingContext.makeXRCompatible()']?.app, 1);
});

test('WebSocket gating: blocked origins are redirected to the refusing endpoint, own and allowlisted ones are not', () => {
  const ctx = vm.createContext({
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    console,
  });
  vm.runInContext(PRELUDE, ctx, {
    filename: `${ORIGIN}/__iwn_compat/prelude.js`,
  });
  vm.runInContext(
    `globalThis.WebSocket = class WebSocket extends EventTarget { constructor(u) { super(); this.u = String(u); } };`,
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/prelude2.js` },
  );
  // the runtime matches ws(s) against the http(s) origin, and the config only accepts http(s) entries: a wss://
  // entry (which `validate` rejects) covers nothing
  const wsBlock = {
    url: 'ws://127.0.0.1:9/__iwn_compat/ws-blocked?u=',
    allow: [
      'https://ok.example.net',
      'https://*.allowed.net',
      'wss://wss-entry.example.net',
      'http://plain.example.net',
    ],
  };
  vm.runInContext(
    tracerScript({
      role: 'main',
      toolMarker: '/__iwn_compat/',
      selfMarker: '/__iwn_compat/tracer',
      wsBlock,
    }),
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/tracer.js` },
  );
  const r = vm.runInContext(
    `['wss://game.example-mp.net/room', 'wss://ok.example.net/a', 'wss://eu.allowed.net/b', '/live', 'https://game.example-mp.net/x', 'wss://wss-entry.example.net/c', 'ws://plain.example.net/d', 'wss://plain.example.net/e', 'ftp://game.example-mp.net/x', 'wss://game.example-mp.net/room#frag'].map((u) => new WebSocket(u).u)`,
    ctx,
    { filename: `${ORIGIN}/assets/index-abc.js` },
  );
  const blocked = (u: string) =>
    `ws://127.0.0.1:9/__iwn_compat/ws-blocked?u=${encodeURIComponent(u)}`;
  assert.deepEqual(Array.from(r as unknown[]), [
    blocked('wss://game.example-mp.net/room'),
    'wss://ok.example.net/a',
    'wss://eu.allowed.net/b',
    '/live',
    blocked('wss://game.example-mp.net/x'),
    blocked('wss://wss-entry.example.net/c'),
    'ws://plain.example.net/d',
    blocked('wss://plain.example.net/e'),
    // what the constructor rejects with SyntaxError reaches it unchanged (the fake here does not validate)
    'ftp://game.example-mp.net/x',
    'wss://game.example-mp.net/room#frag',
  ]);
  const a = (
    vm.runInContext('__iwnCompat.dump()', ctx, {
      filename: `${ORIGIN}/__iwn_compat/driver.js`,
    }) as TraceDump
  ).apis;
  assert.equal(
    a['new WebSocket(cross-origin wss://game.example-mp.net)']?.app,
    2,
  ); // the rows keep the app's URLs (/room and /room#frag)
});

test('headset trim: an absent member a runtime layer stubs throws NotSupportedError, and the call is recorded', () => {
  const ctx = vm.createContext({
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    console,
  });
  vm.runInContext(PRELUDE, ctx, {
    filename: `${ORIGIN}/__iwn_compat/prelude.js`,
  });
  vm.runInContext(
    `class DOMException extends Error { constructor(m, n) { super(m); this.name = n; } }
    globalThis.DOMException = DOMException;
    class BaseAudioContext { createScriptProcessor() { return { ok: true }; } createGain() { return { gain: 1 }; } }
    globalThis.BaseAudioContext = BaseAudioContext; globalThis.AudioContext = class AudioContext extends BaseAudioContext {};`,
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/prelude2.js` },
  );
  const trim = {
    absent: [
      '^(ScriptProcessorNode|BaseAudioContext\\.createScriptProcessor)\\b',
    ],
    keep: ['BaseAudioContext.createGain'],
    contexts: ['2d', 'webgl', 'webgl2'],
    stubs: ['BaseAudioContext.createScriptProcessor'],
  };
  vm.runInContext(
    tracerScript({
      role: 'main',
      toolMarker: '/__iwn_compat/',
      selfMarker: '/__iwn_compat/tracer',
      trim,
    }),
    ctx,
    { filename: `${ORIGIN}/__iwn_compat/tracer.js` },
  );
  const r = vm.runInContext(
    `const c = new AudioContext(); let e = 'none'; try { c.createScriptProcessor(1024, 1, 1); } catch (x) { e = x.name; } ['createScriptProcessor' in c, e, c.createGain().gain]`,
    ctx,
    { filename: `${ORIGIN}/assets/index-abc.js` },
  );
  assert.deepEqual(Array.from(r as unknown[]), [true, 'NotSupportedError', 1]);
  const d = vm.runInContext('__iwnCompat.dump()', ctx, {
    filename: `${ORIGIN}/__iwn_compat/driver.js`,
  }) as TraceDump;
  assert.ok(
    !(d.removed ?? []).includes('BaseAudioContext.createScriptProcessor'),
  );
  assert.equal(d.apis['BaseAudioContext.createScriptProcessor()']?.app, 1);
});
