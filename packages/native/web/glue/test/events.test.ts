/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// DOM-2 (events subset), DOM-10 (DOMException, AbortController/AbortSignal), TMR-3 (queueMicrotask),
// LOOP-4's reporting path (reportError → window `error`). Conformance against Node's EventTarget,
// AbortController and DOMException where Node implements them.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { both, createGlueContext, fakeNatives, glueScript } from './harness.ts';

describe('Event / EventTarget (DOM-2)', () => {
  test('listener semantics match Node', async () => {
    const r = await both(`
      const log = [];
      const t = new EventTarget();
      const a = (e) => log.push(['a', e.type, e.eventPhase, e.target === t, e.currentTarget === t, this === undefined]);
      t.addEventListener('x', a);
      t.addEventListener('x', a); // duplicate ignored
      t.addEventListener('x', { handleEvent(e) { log.push(['obj', this.tag]); }, tag: 7 });
      t.addEventListener('x', () => log.push('once'), { once: true });
      t.addEventListener('x', (e) => { e.preventDefault(); log.push(['passive', e.defaultPrevented]); }, { passive: true });
      t.addEventListener('x', null);
      const ev = new Event('x', { cancelable: true });
      log.push(t.dispatchEvent(ev), ev.defaultPrevented, ev.eventPhase, ev.currentTarget, ev.target === t);
      log.push(t.dispatchEvent(new Event('x')));
      t.removeEventListener('x', a, { capture: false });
      log.push(t.dispatchEvent(new Event('x')));
      // stopImmediatePropagation
      const u = new EventTarget();
      u.addEventListener('y', (e) => { log.push('y1'); e.stopImmediatePropagation(); });
      u.addEventListener('y', () => log.push('y2'));
      u.dispatchEvent(new Event('y'));
      // cancelable + returnValue
      const c = new Event('z', { cancelable: true });
      u.addEventListener('z', (e) => { e.returnValue = false; });
      log.push(u.dispatchEvent(c), c.returnValue, c.defaultPrevented);
      // non-cancelable preventDefault does nothing
      const d = new Event('z');
      log.push(u.dispatchEvent(d), d.defaultPrevented);
      // removing a later listener during dispatch prevents it from running
      const w = new EventTarget();
      const l2 = () => log.push('w2');
      w.addEventListener('q', () => { log.push('w1'); w.removeEventListener('q', l2); });
      w.addEventListener('q', l2);
      w.dispatchEvent(new Event('q'));
      // adding during dispatch does not run in the same dispatch
      w.addEventListener('r', () => { log.push('r1'); w.addEventListener('r', () => log.push('r-late')); });
      w.dispatchEvent(new Event('r'));
      return log;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  // Node's EventTarget has no capture phase at the target and throws its own ERR_EVENT_RECURSION, so
  // these follow DOM §2.9 (and Chromium) instead of Node.
  test('at-target capture listeners run first; re-dispatch throws InvalidStateError (DOM, not Node)', async () => {
    const { run } = await createGlueContext();
    const log = run<unknown[]>(`
      const log = [];
      const t = new EventTarget();
      t.addEventListener('x', (e) => log.push('bubble:' + e.eventPhase));
      t.addEventListener('x', (e) => log.push('capture:' + e.eventPhase + ':' + (e.currentTarget === t)), true);
      t.addEventListener('s', (e) => { try { t.dispatchEvent(e); } catch (err) { log.push(err.name, err.code, err instanceof DOMException); } });
      t.dispatchEvent(new Event('x'));
      t.dispatchEvent(new Event('s'));
      // removeEventListener matches on capture too.
      const f = () => log.push('f');
      t.addEventListener('r', f);
      t.removeEventListener('r', f, true);
      t.dispatchEvent(new Event('r'));
      const e = new Event('t');
      log.push(e.BUBBLING_PHASE, e.NONE, Event.CAPTURING_PHASE);
      log;
    `);
    assert.deepEqual(Array.from(log), ['capture:2:true', 'bubble:2', 'InvalidStateError', 11, true, 'f', 3, 0, 1]);
  });

  test('Event and CustomEvent fields match Node', async () => {
    const r = await both(`
      const e = new Event('t', { bubbles: true, cancelable: true, composed: true });
      const out = [e.type, e.bubbles, e.cancelable, e.composed, e.isTrusted, e.eventPhase, e.defaultPrevented, e.cancelBubble,
        typeof e.timeStamp, e.composedPath().length, e.target, e.srcElement, Event.AT_TARGET,
        Object.prototype.toString.call(e)];
      e.cancelBubble = true; out.push(e.cancelBubble);
      e.stopPropagation(); out.push(e.cancelBubble);
      const c = new CustomEvent('c', { detail: { a: 1 } });
      out.push(c.detail, new CustomEvent('c').detail, c instanceof Event, Object.prototype.toString.call(c));
      try { new Event(); } catch (err) { out.push(err.name); }
      try { new EventTarget().dispatchEvent({}); } catch (err) { out.push(err.name); }
      try { new EventTarget().addEventListener('x'); } catch (err) { out.push(err.name); }
      out.push(typeof Event.prototype.initEvent, Object.keys(Event.prototype).length > 0);
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('capture and bubble along a parent chain (GET_THE_PARENT hook for DOM stand-ins)', async () => {
    const { run } = await createGlueContext();
    const log = run<string[]>(`
      const P = globalThis[Symbol.for('iwn.glue')].events.GET_THE_PARENT;
      class Node extends EventTarget {
        constructor(name, parent) { super(); this.name = name; this.parent = parent; }
        [P]() { return this.parent ?? null; }
      }
      const root = new Node('root'), mid = new Node('mid', root), leaf = new Node('leaf', mid);
      const log = [];
      for (const n of [root, mid, leaf]) {
        n.addEventListener('e', (e) => log.push('cap:' + n.name + ':' + e.eventPhase), true);
        n.addEventListener('e', (e) => log.push('bub:' + n.name + ':' + e.eventPhase));
      }
      leaf.dispatchEvent(new Event('e', { bubbles: true }));
      log.push('|');
      leaf.dispatchEvent(new Event('e'));
      log.push('|');
      mid.addEventListener('stop', (e) => { log.push('mid-stop'); e.stopPropagation(); }, true);
      leaf.addEventListener('stop', () => log.push('leaf-should-not-run'));
      const ev = new Event('stop', { bubbles: true });
      leaf.dispatchEvent(ev);
      log.push(String(ev.composedPath().length));
      log;
    `);
    assert.deepEqual(Array.from(log), [
      'cap:root:1', 'cap:mid:1', 'cap:leaf:2', 'bub:leaf:2', 'bub:mid:3', 'bub:root:3', '|',
      'cap:root:1', 'cap:mid:1', 'cap:leaf:2', 'bub:leaf:2', '|',
      'mid-stop', '0',
    ]);
  });

  test('listener exceptions are reported to window error, then the next listener runs', async () => {
    const { run } = await createGlueContext();
    const out = run<string[]>(`
      const out = [];
      globalThis.console = { error: (...a) => out.push('console:' + a.map(String).join(' ')) };
      addEventListener('error', (e) => { out.push('error:' + e.message + ':' + (e.error instanceof Error) + ':' + e.isTrusted); });
      const t = new EventTarget();
      t.addEventListener('x', () => { throw new Error('boom'); });
      t.addEventListener('x', () => out.push('second'));
      t.dispatchEvent(new Event('x'));
      // A cancelled error event suppresses the console line.
      onerror = () => true;
      t.dispatchEvent(new Event('x'));
      out;
    `);
    assert.deepEqual(Array.from(out), [
      'error:Uncaught Error: boom:true:true',
      'console:Uncaught Error: boom',
      'second',
      'error:Uncaught Error: boom:true:true',
      'second',
    ]);
    // An error handler that throws is logged, not re-dispatched.
    const again = run<string[]>(`
      const again = [];
      globalThis.console = { error: (...a) => again.push('console:' + a.map(String).join(' ')) };
      onerror = null;
      let n = 0;
      addEventListener('error', () => { n++; throw new Error('in-handler'); });
      reportError(new Error('first'));
      again.push(String(n));
      again;
    `);
    assert.deepEqual(Array.from(again), ['console:Uncaught Error: in-handler', 'console:Uncaught Error: first', '1']);
  });

  test('on<event> handler attributes keep registration order and honour return false', async () => {
    const { run } = await createGlueContext();
    const out = run<string[]>(`
      const out = [];
      const ac = new AbortController();
      ac.signal.addEventListener('abort', () => out.push('listener1'));
      ac.signal.onabort = () => out.push('handler-v1');
      ac.signal.addEventListener('abort', () => out.push('listener2'));
      ac.signal.onabort = function (e) { out.push('handler-v2:' + (this === ac.signal) + ':' + e.type); };
      ac.abort();
      out.push(String(ac.signal.onabort !== null));
      ac.signal.onabort = 5; out.push(String(ac.signal.onabort));
      out;
    `);
    assert.deepEqual(Array.from(out), ['listener1', 'handler-v2:true:abort', 'listener2', 'true', 'null']);
  });

  test('window is an EventTarget; ErrorEvent / PromiseRejectionEvent / MessageEvent / ProgressEvent fields (HTML, XHR)', async () => {
    const { run } = await createGlueContext();
    const out = run<unknown[]>(`
      const out = [];
      const ee = new ErrorEvent('error', { message: 'm', filename: 'f.js', lineno: 3, colno: 4, error: 1 });
      out.push(ee.message, ee.filename, ee.lineno, ee.colno, ee.error, Object.prototype.toString.call(ee));
      const p = Promise.reject(1); p.catch(() => {});
      const pr = new PromiseRejectionEvent('unhandledrejection', { promise: p, reason: 'r', cancelable: true });
      out.push(pr.promise === p, pr.reason, pr.cancelable);
      try { new PromiseRejectionEvent('x', {}); } catch (e) { out.push(e.name); }
      const me = new MessageEvent('message', { data: 'd', origin: 'o', lastEventId: 'l' });
      out.push(me.data, me.origin, me.lastEventId, me.source, me.ports.length);
      const pe = new ProgressEvent('progress', { lengthComputable: true, loaded: 5, total: 10 });
      out.push(pe.lengthComputable, pe.loaded, pe.total);
      out.push(typeof globalThis.addEventListener, typeof globalThis.dispatchEvent, window === globalThis, self === globalThis);
      let got = 0;
      addEventListener('ping', () => got++);
      out.push(dispatchEvent(new Event('ping')), got);
      out;
    `);
    assert.deepEqual(Array.from(out), [
      'm', 'f.js', 3, 4, 1, '[object ErrorEvent]', true, 'r', true, 'TypeError',
      'd', 'o', 'l', null, 0, true, 5, 10, 'function', 'function', true, true, true, 1,
    ]);
  });

  test('MessageEvent fields match Node', async () => {
    const r = await both(`
      const me = new MessageEvent('message', { data: { x: 1 }, origin: 'o', lastEventId: 'l' });
      return [me.type, me.data, me.origin, me.lastEventId, me.source, me.ports.length, me instanceof Event];
    `);
    assert.deepEqual(r.glue, r.node);
  });
});

describe('DOMException (DOM-10)', () => {
  test('names, codes, constants and prototype chain match Node', async () => {
    const r = await both(`
      const names = ['IndexSizeError','HierarchyRequestError','WrongDocumentError','InvalidCharacterError','NoModificationAllowedError',
        'NotFoundError','NotSupportedError','InUseAttributeError','InvalidStateError','SyntaxError','InvalidModificationError','NamespaceError',
        'InvalidAccessError','TypeMismatchError','SecurityError','NetworkError','AbortError','URLMismatchError','QuotaExceededError',
        'TimeoutError','InvalidNodeTypeError','DataCloneError','EncodingError','NotReadableError','UnknownError','ConstraintError',
        'DataError','TransactionInactiveError','ReadOnlyError','VersionError','OperationError','NotAllowedError','Custom'];
      const out = names.map((n) => { const e = new DOMException('msg', n); return [e.name, e.message, e.code]; });
      const d = new DOMException();
      out.push([d.name, d.message, d.code, d instanceof Error, String(d), Object.prototype.toString.call(d), typeof d.stack]);
      out.push([DOMException.DATA_CLONE_ERR, DOMException.prototype.ABORT_ERR, DOMException.INDEX_SIZE_ERR, DOMException.VALIDATION_ERR]);
      out.push(Object.getOwnPropertyNames(d).filter((k) => k !== 'stack'));
      out.push(Object.getPrototypeOf(DOMException.prototype) === Error.prototype);
      const withCause = new DOMException('m', { name: 'AbortError', cause: 1 });
      out.push([withCause.name, withCause.cause, withCause.code]);
      return out;
    `);
    // Node accepts a { name, cause } options object; WebIDL (and browsers) stringify the second argument.
    const glue = r.glue as unknown[];
    const node = r.node as unknown[];
    assert.deepEqual(glue.slice(0, -1), node.slice(0, -1));
    assert.deepEqual(glue.at(-1), ['[object Object]', { $: 'undefined' }, 0]);
  });

  test('the stack header carries the message; message stays a prototype accessor', async () => {
    // V8 15.5 (device) writes the stack header from the message passed to Error's constructor; Node's V8 reads the
    // accessor lazily, so the header alone passes here either way. Record what reaches Error itself.
    const ctx = vm.createContext({});
    vm.runInContext(
      `globalThis.__errorArgs = []; const E = Error;
       globalThis.Error = new Proxy(E, { construct(t, a, nt) { __errorArgs.push(a[0]); return Reflect.construct(t, a, nt); } });`,
      ctx,
    );
    (vm.runInContext('globalThis', ctx) as Record<string, unknown>).__iwn = fakeNatives().natives;
    (await glueScript()).runInContext(ctx);
    const r = vm.runInContext(
      `(() => {
        const e = new DOMException('The requested XRSession mode is not supported.', 'NotSupportedError');
        const empty = new DOMException('', 'AbortError');
        const d = Object.getOwnPropertyDescriptor(DOMException.prototype, 'message');
        return {
          passed: __errorArgs.includes('The requested XRSession mode is not supported.'),
          head: e.stack.split('\\n')[0],
          emptyHead: empty.stack.split('\\n')[0],
          own: Object.getOwnPropertyNames(e).filter((k) => k !== 'stack').join(','),
          accessor: typeof d.get === 'function' && !('value' in d),
          message: e.message,
          str: String(e),
        };
      })()`,
      ctx,
    ) as Record<string, unknown>;
    assert.deepEqual({ ...r }, {
      passed: true,
      head: 'NotSupportedError: The requested XRSession mode is not supported.',
      emptyHead: 'AbortError',
      own: '',
      accessor: true,
      message: 'The requested XRSession mode is not supported.',
      str: 'NotSupportedError: The requested XRSession mode is not supported.',
    });
  });
});

describe('AbortController / AbortSignal (DOM-10)', () => {
  test('abort, reasons, any() and listener removal match Node', async () => {
    const r = await both(`
      const out = [];
      const ac = new AbortController();
      const s = ac.signal;
      let calls = 0;
      const t = new EventTarget();
      t.addEventListener('x', () => calls++, { signal: s });
      t.dispatchEvent(new Event('x'));
      s.addEventListener('abort', (e) => out.push(['abort-event', e.type, e.isTrusted, s.aborted]));
      out.push(s.aborted, s.reason);
      ac.abort();
      ac.abort('again');
      t.dispatchEvent(new Event('x'));
      out.push(calls, s.aborted, s.reason.name, s.reason.code, s.reason instanceof DOMException);
      try { s.throwIfAborted(); } catch (e) { out.push(['thrown', e.name]); }
      const ac2 = new AbortController(); ac2.abort('why'); out.push(ac2.signal.reason);
      out.push(AbortSignal.abort().reason.name, AbortSignal.abort(42).reason);
      // already-aborted signal: listener not added
      t.addEventListener('y', () => out.push('should-not'), { signal: AbortSignal.abort() });
      t.dispatchEvent(new Event('y'));
      const a = new AbortController(), b = new AbortController();
      const any = AbortSignal.any([a.signal, b.signal]);
      const anyOfAny = AbortSignal.any([any]);
      any.onabort = () => out.push('any-abort');
      anyOfAny.addEventListener('abort', () => out.push('any-of-any'));
      b.abort('b-reason');
      out.push(any.aborted, any.reason, anyOfAny.reason, a.signal.aborted);
      out.push(AbortSignal.any([AbortSignal.abort('pre')]).reason);
      try { new AbortSignal(); } catch (e) { out.push(e.name); }
      try { AbortSignal.any([{}]); } catch (e) { out.push(e.name); }
      out.push(Object.prototype.toString.call(s), Object.prototype.toString.call(ac));
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('AbortSignal.timeout rejects with TimeoutError', async () => {
    const r = await both(`
      const s = AbortSignal.timeout(5);
      const first = s.aborted;
      await new Promise((res) => s.addEventListener('abort', res));
      return [first, s.aborted, s.reason.name, s.reason.code];
    `);
    assert.deepEqual(r.glue, r.node);
  });
});

describe('queueMicrotask (TMR-3)', () => {
  test('ordering and errors match Node; exceptions are reported, not rejected', async () => {
    const r = await both(`
      const log = [];
      queueMicrotask(() => log.push(1));
      Promise.resolve().then(() => log.push(2));
      queueMicrotask(() => { log.push(3); queueMicrotask(() => log.push(5)); });
      log.push(0);
      await new Promise((res) => setTimeout(res, 0));
      try { queueMicrotask(1); } catch (e) { log.push(e.name); }
      return log;
    `);
    assert.deepEqual(r.glue, r.node);
    const { run } = await createGlueContext();
    const out = await run<Promise<string[]>>(`
      (async () => {
        const out = [];
        addEventListener('error', (e) => { e.preventDefault(); out.push('reported:' + e.error.message); });
        queueMicrotask(() => { throw new Error('mt'); });
        await new Promise((r) => setTimeout(r, 0));
        return out;
      })()
    `);
    assert.deepEqual(Array.from(out), ['reported:mt']);
  });

  test('uses the native microtask hook when present', async () => {
    let n = 0;
    const { natives } = await import('./harness.ts').then((h) => h.fakeNatives({
      loop: { queueMicrotask: (cb: () => void) => { n++; queueMicrotask(cb); } },
    }));
    const { run } = await createGlueContext({ natives });
    await run<Promise<void>>(`new Promise((r) => queueMicrotask(r))`);
    assert.equal(n, 1);
  });
});
