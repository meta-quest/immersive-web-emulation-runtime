// Headless tests of runtime/core/js/bootstrap.js with fake natives (HL-1 style): console formatting (CON-1, CON-2),
// DevTools forwarding (CON-3/4), timers (TMR-1), window rAF snapshots (TMR-5), microtasks (LOOP-1), error and
// rejection reporting (LOOP-4), lifecycle dispatch (PROC-6). Run: node --test runtime/core/test/js/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../js/bootstrap.js', import.meta.url), 'utf8');

function harness({ sessions = 0, withEvents = false } = {}) {
  const logs = [];
  const v8calls = [];
  const reported = [];
  const cloneCalls = [];
  let now = 0;
  let nextId = 1;
  let hooks;
  let microtaskCheckpoints = 0;
  const timers = new Map();
  const state = { frameRequested: false, sessions };
  const natives = {
    core: {
      log: (level, text) => logs.push([level, text]),
      timerAdd(t, repeat) {
        const id = nextId++;
        const timeout = Math.max(0, t);
        timers.set(id, { due: now + timeout, timeout, repeat, seq: id });
        return id;
      },
      timerClear(id) {
        timers.delete(id);
      },
      requestFrame() {
        state.frameRequested = true;
      },
      setHooks(h) {
        hooks = h;
      },
      invokeCallback(fn, thisArg, ...args) {
        try {
          return fn.apply(thisArg, args);
        } catch (e) {
          reported.push(e);
          return undefined;
        }
      },
      // Like the native side: the callback runs with no JS try/catch; a throw is reported natively.
      enqueueMicrotask(fn) {
        queueMicrotask(() => {
          try {
            fn();
          } catch (e) {
            reported.push(e);
          }
        });
      },
      reportException(e) {
        reported.push(e);
      },
      reportError(e) {
        // Native "report an exception": the error hook (event), then the log unless cancelled.
        const message = 'Uncaught ' + (e && e.message);
        if (hooks.error(e, message, 'https://app.local/x.js', 1, 1)) reported.push(e);
      },
      inspectorSessions: () => state.sessions,
      isWorker: false,
    },
    clock: { now: () => now, timeOrigin: () => 1.7e12 },
    clone: {
      structuredClone(v, t) {
        cloneCalls.push([v, t]);
        return structuredClone(v);
      },
    },
  };
  const sandbox = {};
  const ctx = vm.createContext(sandbox);
  const g = vm.runInContext('globalThis', ctx);
  g.console = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'group', 'groupEnd', 'count', 'assert', 'time', 'timeEnd'].map(
      (n) => [n, (...a) => v8calls.push([n, a])],
    ),
  );
  if (withEvents) {
    // Minimal DOM-ish events from Node's EventTarget, standing in for the web glue.
    const target = new EventTarget();
    g.dispatchEvent = (ev) => target.dispatchEvent(ev);
    g.addEventListener = (...a) => target.addEventListener(...a);
    g.Event = Event;
    g.ErrorEvent = class ErrorEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        Object.assign(this, { message: init.message, filename: init.filename, lineno: init.lineno, colno: init.colno, error: init.error });
      }
    };
    g.PromiseRejectionEvent = class PromiseRejectionEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.promise = init.promise;
        this.reason = init.reason;
      }
    };
    const doc = new EventTarget();
    g.document = doc;
  }
  const fn = vm.runInContext(SRC, ctx, { filename: 'bootstrap.js' });
  fn(natives, g);
  const run = (code) => vm.runInContext(code, ctx);
  // Values from the sandbox realm, copied into this realm (cross-realm arrays fail deepEqual).
  const val = (code) => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', ctx));
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) {
        if (t.due <= target && (!next || t.due < next[1].due || (t.due === next[1].due && t.seq < next[1].seq))) next = [id, t];
      }
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.due);
      if (t.repeat) {
        t.due = now + Math.max(t.timeout, 1);
        t.seq = nextId++;
      } else {
        timers.delete(id);
      }
      hooks.timer(id);
    }
    now = target;
  }
  // Like RuntimeImpl::run_animation_frame: snapshot, then each callback called natively with a checkpoint after.
  function frame() {
    state.frameRequested = false;
    const handles = hooks.frameBegin(now);
    for (const handle of handles) {
      try {
        hooks.frameCallback(handle, now);
      } catch (e) {
        reported.push(e);
      }
      microtaskCheckpoints++;
    }
  }
  return {
    natives, g, run, val, logs, v8calls, reported, cloneCalls, state, advance, frame,
    get hooks() { return hooks; },
    get checkpoints() { return microtaskCheckpoints; },
    setNow(t) { now = t; },
    last: () => logs[logs.length - 1],
  };
}

test('console.log formats per the Console standard (CON-1)', () => {
  const h = harness();
  h.run("console.log('%d px', 3.7)");
  assert.deepEqual(h.last(), [1, '3 px']);
  h.run("console.log('%s|%i|%f|%%|%c|%o', 'a', '42.9', '1.5e1', 'color:red', [1])");
  assert.deepEqual(h.last(), [1, 'a|42|15|%||[1]']);
  h.run("console.log('extra', 1, 'two', {a: 1})");
  assert.deepEqual(h.last(), [1, "extra 1 two {a: 1}"]);
  h.run("console.log('%d', Symbol('x'))");
  assert.deepEqual(h.last(), [1, 'NaN']);
  h.run("console.log('%s and %s', 'only-one')");
  assert.deepEqual(h.last(), [1, 'only-one and %s']);
  h.run('console.log()');
  assert.deepEqual(h.last(), [1, '']);
});

test('objects render one level deep, bounded (CON-2)', () => {
  const h = harness();
  h.run("console.log({a: {b: {c: 1}}, arr: [1, [2, [3]]], s: 'x', n: -0, big: 10n})");
  assert.equal(h.last()[1], "{a: {b: [Object]}, arr: [1, [Array]], s: 'x', n: -0, big: 10n}");
  h.run('class Foo { constructor() { this.x = 1 } }; console.log(new Foo())');
  assert.equal(h.last()[1], 'Foo {x: 1}');
  h.run('const c = {}; c.self = c; console.log(c)');
  assert.equal(h.last()[1], '{self: [Circular]}');
  h.run("console.log(new Map([['k', 1]]), new Set([1, 2]), new Float32Array([1, 2.5]))");
  assert.equal(h.last()[1], "Map(1) {'k' => 1} Set(2) {1, 2} Float32Array(2) [1, 2.5]");
  h.run('console.log(function named() {}, class K {}, () => 1)');
  assert.equal(h.last()[1], '[Function: named] [class K] [Function: (anonymous)]');
  h.run("const o = {}; Object.defineProperty(o, 'g', {get() { throw new Error('no') }, enumerable: true}); console.log(o)");
  assert.equal(h.last()[1], '{g: [Getter]}');
  h.run('console.log(new Array(1000).fill(7))');
  assert.match(h.last()[1], /\.\.\. 900 more items\]$/);
  h.run("const e = new Error('boom'); console.log(e)");
  assert.match(h.last()[1], /^Error: boom\n\s+at /);
});

test('levels, assert, count, time, group, table (CON-1)', () => {
  const h = harness();
  h.run("console.debug('d'); console.info('i'); console.warn('w'); console.error('e')");
  assert.deepEqual(h.logs.slice(-4), [[0, 'd'], [1, 'i'], [2, 'w'], [3, 'e']]);
  h.run('console.assert(true, "never"); console.assert(false, "bad %d", 2)');
  assert.deepEqual(h.last(), [3, 'Assertion failed: bad 2']);
  h.run("console.count(); console.count(); console.count('x'); console.countReset(); console.count()");
  assert.deepEqual(h.logs.slice(-4).map((l) => l[1]), ['default: 1', 'default: 2', 'x: 1', 'default: 1']);
  h.run("console.countReset('nope')");
  assert.deepEqual(h.last(), [2, "Count for 'nope' does not exist"]);
  h.run("console.time('t')");
  h.setNow(12.5);
  h.run("console.timeLog('t', 'mid'); console.timeEnd('t'); console.timeEnd('t')");
  assert.deepEqual(h.logs.slice(-3), [[1, 't: 12.500 ms mid'], [1, 't: 12.500 ms'], [2, "Timer 't' does not exist"]]);
  h.run("console.group('G'); console.log('a\\nb'); console.groupEnd(); console.log('c')");
  assert.deepEqual(h.logs.slice(-3).map((l) => l[1]), ['G', '  a\n  b', 'c']);
  h.run("console.table([{a: 1, b: 'x'}, {a: 2}])");
  assert.equal(h.last()[1], "│ (index) │ a │ b   │\n│ 0       │ 1 │ 'x' │\n│ 1       │ 2 │     │");
  h.run("console.trace('here')");
  assert.match(h.last()[1], /^Trace: here\n/);
});

test('console forwards to V8 (DevTools) only while a session is attached (CON-3, CON-4)', () => {
  const h = harness();
  h.run("console.log('quiet')");
  assert.equal(h.v8calls.length, 0);
  h.state.sessions = 1;
  const obj = h.run("globalThis.__o = {x: 1}; console.log('loud', __o); __o");
  assert.equal(h.v8calls.length, 1);
  assert.equal(h.v8calls[0][0], 'log');
  assert.equal(h.v8calls[0][1][1], obj); // the real object, inspectable in DevTools
});

test('setTimeout/setInterval: args, this, clear, string handler, ToInt32 (TMR-1)', () => {
  const h = harness();
  h.run("globalThis.out = []; setTimeout(function (a, b) { out.push([a, b, this === globalThis]) }, 10, 'x', 2)");
  h.advance(9);
  assert.deepEqual(h.val('out'), []);
  h.advance(1);
  assert.deepEqual(h.val('JSON.stringify(out)'), JSON.stringify([['x', 2, true]]));
  const id = h.run("setTimeout(() => out.push('never'), 5)");
  assert.ok(Number.isInteger(id) && id > 0);
  h.run(`clearTimeout(${id}); clearTimeout(99999); clearInterval('nope')`);
  h.advance(10);
  assert.equal(h.run('out.length'), 1);
  h.run("globalThis.n = 0; const iv = setInterval(() => { if (++n === 3) clearInterval(iv) }, 5)");
  h.advance(100);
  assert.equal(h.run('n'), 3);
  h.run("setTimeout('out.push(\"str\")', 0); setTimeout('out.push(\"str2\")', 0)");
  h.advance(1);
  assert.deepEqual(h.val('out.slice(-2)'), ['str', 'str2']);
  assert.equal(h.logs.filter((l) => l[0] === 2 && /string handler/.test(l[1])).length, 1); // warned once
  // 2^31 wraps to a negative long -> 0 (fires at once), like browsers.
  h.run("setTimeout(() => out.push('wrapped'), 2 ** 31)");
  h.advance(0);
  assert.equal(h.run('out[out.length - 1]'), 'wrapped');
});

test('requestAnimationFrame snapshots per frame, cancel works mid-frame, errors do not stop the round (TMR-5)', () => {
  const h = harness();
  h.run(`globalThis.seen = [];
    requestAnimationFrame((t) => { seen.push(['a', t]); requestAnimationFrame(() => seen.push(['late'])); cancelAnimationFrame(idC); });
    requestAnimationFrame(() => { throw new Error('cb failed') });
    var idC = requestAnimationFrame(() => seen.push(['c']));
    requestAnimationFrame(() => seen.push(['d']));`);
  assert.equal(h.state.frameRequested, true);
  h.setNow(16);
  const before = h.checkpoints;
  h.frame();
  assert.deepEqual(h.val('JSON.stringify(seen)'), JSON.stringify([['a', 16], ['d']]));
  assert.equal(h.reported.length, 1);
  assert.equal(h.reported[0].message, 'cb failed');
  assert.equal(h.checkpoints - before, 4); // one checkpoint per snapshotted handle (c was cancelled: a no-op call)
  assert.equal(h.state.frameRequested, true); // 'late' asked for the next frame
  h.frame();
  assert.deepEqual(h.val('seen[seen.length - 1]'), ['late']);
  assert.throws(() => h.run('requestAnimationFrame(1)'), /not a function/);
});

test('queueMicrotask reports exceptions and rejects non-functions (TMR-3, LOOP-1)', async () => {
  const h = harness();
  h.run("globalThis.order = []; queueMicrotask(() => order.push('m1')); queueMicrotask(() => { throw new Error('mt') })");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.val('order'), ['m1']);
  assert.equal(h.reported.length, 1);
  assert.equal(h.reported[0].message, 'mt');
  assert.throws(() => h.run('queueMicrotask(null)'), { name: 'TypeError' });
});

test('structuredClone forwards the transfer list; requestIdleCallback deadlines are never negative (TMR-3)', () => {
  const h = harness();
  h.run('const ab = new ArrayBuffer(8); globalThis.copy = structuredClone({ab}, {transfer: [ab]})');
  assert.equal(h.cloneCalls.length, 1);
  assert.equal(h.cloneCalls[0][1].length, 1);
  h.run('globalThis.rem = []; requestIdleCallback((d) => rem.push(d.timeRemaining(), d.didTimeout))');
  h.advance(2);
  const [remaining, didTimeout] = h.val('rem');
  assert.ok(remaining >= 0 && remaining <= 50);
  assert.equal(didTimeout, false);
  const id = h.run("requestIdleCallback(() => rem.push('no'))");
  h.run(`cancelIdleCallback(${id})`);
  h.advance(5);
  assert.equal(h.run('rem.length'), 2);
});

test('performance.now and timeOrigin come from the native clock (TMR-4)', () => {
  const h = harness();
  h.setNow(123.25);
  assert.equal(h.run('performance.now()'), 123.25);
  assert.equal(h.run('performance.timeOrigin'), 1.7e12);
  h.run("performance.mark('a')");
  h.setNow(130);
  assert.equal(h.run("performance.measure('m', 'a').duration"), 6.75);
  assert.equal(h.run('window === globalThis && self === globalThis'), true);
});

test('error hook dispatches a cancelable ErrorEvent; preventDefault suppresses logging (LOOP-4)', () => {
  const h = harness({ withEvents: true });
  h.run("globalThis.got = []; addEventListener('error', (e) => { got.push(e.message, e.filename, e.lineno, e.error.message) })");
  const shouldLog = h.hooks.error(new Error('x'), 'Uncaught Error: x', 'https://app.local/a.js', 3, 7);
  assert.equal(shouldLog, true);
  assert.deepEqual(h.val('got'), ['Uncaught Error: x', 'https://app.local/a.js', 3, 'x']);
  h.run("addEventListener('error', (e) => e.preventDefault())");
  assert.equal(h.hooks.error(new Error('y'), 'Uncaught Error: y', '', 0, 0), false);
});

test('window.onerror without EventTarget: return true cancels (LOOP-4)', () => {
  const h = harness();
  h.run('globalThis.args = null; globalThis.onerror = (...a) => { args = a; return true }');
  assert.equal(h.hooks.error(new Error('z'), 'Uncaught Error: z', 'f.js', 1, 2), false);
  assert.equal(h.run('args[0]'), 'Uncaught Error: z');
});

test('unhandledrejection is cancelable; rejectionhandled fires (LOOP-4)', () => {
  const h = harness({ withEvents: true });
  h.run("globalThis.rej = []; addEventListener('unhandledrejection', (e) => rej.push(e.reason)); addEventListener('rejectionhandled', (e) => rej.push('handled:' + e.reason))");
  const p = Promise.reject('r1');
  p.catch(() => {});
  assert.equal(h.hooks.rejection(p, 'r1'), true);
  h.run("addEventListener('unhandledrejection', (e) => e.preventDefault())");
  assert.equal(h.hooks.rejection(p, 'r2'), false);
  h.hooks.rejectionHandled(p, 'r1');
  assert.deepEqual(h.val('rej'), ['r1', 'r2', 'handled:r1']);
});

test('lifecycle and document readiness events (PROC-6)', () => {
  const h = harness({ withEvents: true });
  h.run(`globalThis.ev = [];
    document.addEventListener('visibilitychange', (e) => ev.push('vis:' + e.bubbles));
    document.addEventListener('DOMContentLoaded', () => ev.push('dcl'));
    addEventListener('pagehide', () => ev.push('pagehide'));
    addEventListener('blur', () => ev.push('blur'));
    addEventListener('load', () => ev.push('load'));`);
  h.hooks.lifecycle('blur', 'window');
  h.hooks.lifecycle('visibilitychange', 'document');
  h.hooks.lifecycle('pagehide', 'window');
  h.hooks.documentReady('interactive');
  h.hooks.documentReady('complete');
  assert.deepEqual(h.val('ev'), ['blur', 'vis:true', 'pagehide', 'dcl', 'load']);
});

test('reportError dispatches then logs once (LOOP-4)', () => {
  const h = harness({ withEvents: true });
  h.run("globalThis.n = 0; globalThis.loc = null; addEventListener('error', (e) => { n++; loc = [e.filename, e.lineno] }); reportError(new Error('rep'))");
  assert.equal(h.run('n'), 1);
  assert.deepEqual(h.val('loc'), ['https://app.local/x.js', 1]);
  assert.equal(h.reported.length, 1);
});

test('rAF and queueMicrotask callbacks are not wrapped in a JS try/catch (CDP-5)', () => {
  const h = harness();
  // A throwing callback must propagate out of the hook so the native caller's verbose TryCatch sees it.
  h.run('globalThis.boom = () => { throw new Error("raf-throw") }; requestAnimationFrame(boom)');
  const [handle] = h.hooks.frameBegin(1);
  assert.throws(() => h.hooks.frameCallback(handle, 1), /raf-throw/);
  let enqueued = null;
  h.natives.core.enqueueMicrotask = (fn) => {
    enqueued = fn;
  };
  h.run('queueMicrotask(boom)');
  assert.equal(enqueued, h.run('boom'));
});
