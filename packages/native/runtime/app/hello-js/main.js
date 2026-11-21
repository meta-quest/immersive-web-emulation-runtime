/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// hello-js: the M1 exit-check bundle (milestone M1; spec HL-4 device suite, first part). Exercises ES modules,
// timers, the event loop, console, microtasks, error reporting and engine features, then publishes the results as
// globalThis.__hello (read through the debug endpoint) and logs one summary line: "HELLO-JS PASS n/n".
import { add } from './lib/math.js';
import { rootValue } from '/lib/root.js';
import under from './_app/under.js';
import dataValue from 'data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgNDI7';
import { pct } from 'data:text/javascript,export%20const%20pct%20%3D%20%27percent%27%3B';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ' (' + detail + ')' : ''}`,
  );
}

globalThis.__order.push('module');

// --- modules (MOD-1..6, NET-12, REG-3) ------------------------------------------------------------------------------
check(
  'classic script ran once, before the module (MOD-1)',
  globalThis.__classicRuns === 1 && __order.join() === 'classic,module',
  __order.join(),
);
check('relative import (MOD-2)', add(2, 3) === 5);
check(
  'root-relative import + diamond evaluates once (MOD-4)',
  rootValue === 'root' && globalThis.__mathEvals === 1,
  globalThis.__mathEvals,
);
check("'_'-prefixed folder survives packaging (REG-3)", under === 'under');
check(
  'data: imports, base64 and percent-encoded (NET-12)',
  dataValue === 42 && pct === 'percent',
);
check(
  'import.meta.url is the app URL (MOD-3)',
  import.meta.url === 'https://app.local/main.js',
  import.meta.url,
);
check(
  'import.meta.resolve (MOD-3)',
  import.meta.resolve('./lib/x.js') === 'https://app.local/lib/x.js',
  import.meta.resolve('./lib/x.js'),
);

await new Promise((r) => setTimeout(r, 5)); // top-level await
check('top-level await', true);

const lazy = await import('./lib/lazy.js');
check(
  'dynamic import() (MOD-5)',
  lazy.value === 'lazy' && lazy.url === 'https://app.local/lib/lazy.js',
  lazy.url,
);
const again = await import('/lib/lazy.js');
check('module map keyed by URL: same namespace twice (MOD-4)', again === lazy);
const fromEval = await (0, eval)("import('./lib/lazy.js')");
check(
  "import() from eval'd code resolves against the document (MOD-5)",
  fromEval === lazy,
);

async function rejects(spec) {
  try {
    await import(spec);
    return null;
  } catch (e) {
    return e;
  }
}
const bare = await rejects('lodash');
check(
  'bare specifier rejects with a TypeError naming it (MOD-2)',
  bare instanceof TypeError && /lodash/.test(bare.message),
  bare && bare.message,
);
const missing = await rejects('./missing.js');
check(
  'missing module rejects with its URL (MOD-6)',
  missing instanceof TypeError && /missing\.js/.test(missing.message),
  missing && missing.message,
);
const broken = await rejects('./lib/broken.js');
check(
  'syntax error is a SyntaxError (MOD-6)',
  broken instanceof SyntaxError,
  broken && broken.message,
);
const broken2 = await rejects('./lib/broken.js');
check(
  'failed module fails every importer with the same error (MOD-4)',
  broken2 === broken,
);
const remote = await rejects('https://cdn.example.org/x.js');
check(
  'cross-origin module without allowlist rejects (MOD-2)',
  remote instanceof TypeError,
  remote && remote.message,
);

// --- event loop and timers (LOOP-1, TMR-1..5) -----------------------------------------------------------------------
const order = await new Promise((resolve) => {
  const o = [];
  setTimeout(() => {
    o.push('timer1');
    Promise.resolve().then(() => o.push('micro1'));
  }, 0);
  setTimeout(() => {
    o.push('timer2');
    resolve(o);
  }, 0);
});
check(
  'timer1, micro1, timer2 (LOOP-1)',
  order.join() === 'timer1,micro1,timer2',
  order.join(),
);

const qm = await new Promise((resolve) => {
  const o = [];
  queueMicrotask(() => o.push('qm'));
  Promise.resolve().then(() => o.push('then'));
  setTimeout(() => resolve(o), 0);
});
check('queueMicrotask ordering (TMR-3)', qm.join() === 'qm,then', qm.join());

const argsOk = await new Promise((r) =>
  setTimeout(
    function (a, b) {
      r(a === 1 && b === 'x' && this === globalThis);
    },
    0,
    1,
    'x',
  ),
);
check('timer arguments and this (TMR-1)', argsOk);

const ticks = await new Promise((resolve) => {
  let n = 0;
  const id = setInterval(() => {
    if (++n === 3) {
      clearInterval(id);
      setTimeout(() => resolve(n), 40);
    }
  }, 5);
});
check(
  'setInterval + clearInterval inside the callback (TMR-1)',
  ticks === 3,
  ticks,
);

const early = await new Promise((resolve) => {
  const start = performance.now();
  setTimeout(() => resolve(performance.now() - start), 25);
});
check(
  'a timer never fires early (TMR-2)',
  early >= 25,
  early.toFixed(2) + ' ms',
);

const nested = await new Promise((resolve) => {
  const start = performance.now();
  let n = 0;
  const f = () =>
    ++n === 12 ? resolve(performance.now() - start) : setTimeout(f, 0);
  setTimeout(f, 0);
});
check(
  'nesting clamp: 4 ms after level 5 (TMR-2)',
  nested >= 6 * 4 - 1,
  nested.toFixed(1) + ' ms',
);

const rafs = await new Promise((resolve) => {
  const ts = [];
  const f = (t) => {
    ts.push([t, performance.now()]);
    if (ts.length < 31) requestAnimationFrame(f);
    else resolve(ts);
  };
  requestAnimationFrame(f);
});
const span = rafs[rafs.length - 1][0] - rafs[0][0];
const fps = (1000 * (rafs.length - 1)) / span;
check(
  'window rAF at ~60 Hz without XR (TMR-5)',
  fps > 50 && fps < 70,
  fps.toFixed(1) + ' Hz',
);
check(
  'rAF time <= performance.now() at entry (TMR-4)',
  rafs.every(([t, n]) => t <= n),
);

const snapshot = await new Promise((resolve) => {
  const seen = [];
  requestAnimationFrame(() => {
    seen.push('a');
    requestAnimationFrame(() => {
      seen.push('next');
      resolve(seen);
    });
  });
  requestAnimationFrame(() => seen.push('b'));
});
check(
  'rAF callbacks snapshotted per frame (TMR-5)',
  snapshot.join() === 'a,b,next',
  snapshot.join(),
);

let mono = true;
let prev = performance.now();
for (let i = 0; i < 10000; i++) {
  const t = performance.now();
  if (t < prev) mono = false;
  prev = t;
}
check(
  'performance.now() monotonic over 10,000 calls (TMR-4)',
  mono && performance.timeOrigin > 1.6e12,
);

const idle = await new Promise((r) =>
  requestIdleCallback((d) => r(d.timeRemaining())),
);
check(
  'requestIdleCallback deadline (TMR-3)',
  idle >= 0 && idle <= 50,
  idle.toFixed(1),
);

const ab = new ArrayBuffer(16);
const cloned = structuredClone(
  { ab, m: new Map([[1, 2]]), d: new Date(0) },
  { transfer: [ab] },
);
check(
  'structuredClone with transfer (TMR-3)',
  ab.byteLength === 0 &&
    cloned.ab.byteLength === 16 &&
    cloned.m.get(1) === 2 &&
    cloned.d.getTime() === 0,
);

// --- engine (JS-1, JS-6) --------------------------------------------------------------------------------------------
check(
  'V8 15.5 (JS-1)',
  __iwn.core.v8Version.startsWith('15.5'),
  __iwn.core.v8Version,
);
const simd = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 8, 1, 6,
  0, 65, 0, 253, 15, 11,
]);
check('WebAssembly SIMD validates (JS-1)', WebAssembly.validate(simd));
const addWasm = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7,
  7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11,
]);
const { instance } = await WebAssembly.instantiate(addWasm);
check('WebAssembly add(2, 3) = 5', instance.exports.add(2, 3) === 5);
const graphemes = [
  ...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment('é👍🏽漢字'),
].length;
const words = [
  ...new Intl.Segmenter('en', { granularity: 'word' }).segment(
    'hello brave world',
  ),
].filter((s) => s.isWordLike).length;
check(
  'Intl.Segmenter grapheme + word (JS-6)',
  graphemes === 4 && words === 3,
  `${graphemes} graphemes, ${words} words`,
);

// --- console and error reporting (CON-1, CON-2, LOOP-4) ------------------------------------------------------------
console.log('%d px', 3.7); // logcat shows "3 px"
console.info(
  'object one level deep:',
  { a: 1, nested: { deep: { deeper: true } } },
  [1, 2, 3],
  new Map([['k', 'v']]),
);
console.warn('a warning line');
console.debug('a debug line');
console.error('an error line (expected)');
console.log('long line split, not truncated: ' + 'x'.repeat(9000) + ' END');
Promise.reject(new Error('expected unhandled rejection (LOOP-4 check)'));
setTimeout(() => {
  throw new Error('expected uncaught error in a timer (LOOP-4 check)');
}, 0);

// Lifecycle probes (PROC-6): without the web glue there is no EventTarget; on<type> handlers still fire.
globalThis.__lifecycle = [];
for (const type of ['blur', 'focus', 'pagehide', 'load', 'pageshow']) {
  globalThis['on' + type] = () => {
    __lifecycle.push(type);
    console.log('lifecycle event: ' + type);
  };
}
if (typeof document === 'undefined') {
  globalThis.document = {
    get visibilityState() {
      return __iwn.core.lifecycleState().visibilityState;
    },
    onvisibilitychange() {
      __lifecycle.push('visibilitychange:' + document.visibilityState);
      console.log(
        'lifecycle event: visibilitychange -> ' + document.visibilityState,
      );
    },
    onDOMContentLoaded() {
      __lifecycle.push('DOMContentLoaded');
    },
  };
}

const passed = results.filter((r) => r.ok).length;
globalThis.__hello = {
  passed,
  total: results.length,
  failed: results.filter((r) => !r.ok),
};
console.log(
  `HELLO-JS ${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length}`,
);
// A slow heartbeat keeps a timer alive for idle-loop checks (LOOP-3) and shows timers keep running across pause.
setInterval(() => {
  globalThis.__heartbeat = (globalThis.__heartbeat || 0) + 1;
}, 1000);
