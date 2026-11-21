/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regression tests: the core's blob: resolver (NET-14), the clone
// routing scan, `{ signal }` listener retention, long AbortSignal.timeout() on the core's int32 timers,
// window/self after the core bootstrap, the Location hash setter, navigation to another document,
// WebIDL string/integer conversions, large-input codec speed, the subtle prelude split, and WebIDL
// shape details. Several run on a device-like boot: the real runtime/core/js/bootstrap.js, then the glue.

import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { describe, test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { build } from 'esbuild';
import {
  createDeviceContext,
  createGlueContext,
  fakeNatives,
} from './harness.ts';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const REG = `globalThis[Symbol.for('iwn.glue')]`;

async function collect(): Promise<void> {
  await tick();
  gc();
  await tick();
  gc();
}

function nativeCloneNatives(): {
  natives: Record<string, unknown>;
  seen: unknown[];
} {
  const seen: unknown[] = [];
  const { natives } = fakeNatives({
    clone: {
      structuredClone(v: unknown, transfer: unknown[]) {
        seen.push(v);
        return structuredClone(v, { transfer: transfer as never });
      },
    },
  });
  return { natives, seen };
}

describe('blob: URLs for the core module loader (NET-14)', () => {
  test('the glue registers __iwn.core.setBlobResolver; it resolves live URLs and returns null after revoke', async () => {
    const { run, calls } = await createDeviceContext();
    assert.equal(calls.setBlobResolver, 1);
    const url = run<string>(
      `globalThis.u = URL.createObjectURL(new Blob(['export default 42;'], { type: 'text/javascript' })); u`,
    );
    const r = calls.resolver!(url);
    assert.ok(r);
    assert.equal(
      Object.prototype.toString.call(r.bytes),
      '[object Uint8Array]',
    );
    assert.equal(Buffer.from(r.bytes).toString(), 'export default 42;');
    assert.equal(r.type, 'text/javascript');
    // The fragment is ignored (File API "resolve a blob URL").
    assert.equal(
      Buffer.from(calls.resolver!(`${url}#frag`)!.bytes).toString(),
      'export default 42;',
    );
    assert.equal(
      calls.resolver!(
        'blob:https://app.local/00000000-0000-4000-8000-000000000000',
      ),
      null,
    );
    run(`URL.revokeObjectURL(u)`);
    assert.equal(calls.resolver!(url), null);
  });
});

describe('structuredClone routing scan (TMR-3)', () => {
  test('an array index getter runs once with the native hook (the scan reads descriptors)', async () => {
    const { natives } = nativeCloneNatives();
    const { run } = await createGlueContext({ natives });
    assert.equal(
      run(
        `let n = 0; const a = [0, 1]; Object.defineProperty(a, 1, { get() { n++; return 7; }, enumerable: true }); const c = structuredClone(a); [n, c[1]].join()`,
      ),
      '1,7',
    );
  });

  test('a huge sparse array is scanned by its keys, not up to its length', async () => {
    const { natives, seen } = nativeCloneNatives();
    const { run } = await createGlueContext({ natives });
    // Relative bound: walking every index of a 1e8-length array would cost ~100x a routed clone of a
    // dense 1e6-number array (which walks 1e6 indices), measured in the same run.
    const [len, sparseMs, denseMs] = run<[number, number, number]>(`
      const a = []; a.length = 1e8; a[3] = { x: 1 }; a[5e7] = 2;
      const dense = Array.from({ length: 1e6 }, (_, i) => i);
      structuredClone(dense);
      let t0 = Date.now(); const n = structuredClone(a).length; const sparseMs = Date.now() - t0;
      t0 = Date.now(); structuredClone(dense); const denseMs = Date.now() - t0;
      [n, sparseMs, denseMs];
    `);
    assert.equal(len, 1e8);
    assert.ok(
      sparseMs <= Math.max(denseMs, 5) * 3,
      `sparse scan ${sparseMs} ms vs dense 1e6 ${denseMs} ms: it should not walk every index`,
    );
    assert.equal(seen.length, 3, 'plain data still goes to the native hook');
    // A Blob in a long array (index or non-index key) is found.
    assert.equal(
      run(
        `const b = []; b.length = 70000; b[69999] = new Blob(['q']); structuredClone(b)[69999] instanceof Blob`,
      ),
      true,
    );
    assert.equal(
      run(
        `const c = []; c.length = 70000; c.blob = new Blob(['q']); structuredClone(c).blob instanceof Blob`,
      ),
      true,
    );
  });

  test('a spoofed Symbol.toStringTag does not hide a platform object from the scan', async () => {
    const { natives } = nativeCloneNatives();
    const { run } = await createGlueContext({ natives });
    const out = run<string[]>(`
      ['Date', 'RegExp', 'Number', 'ArrayBuffer', 'Module', 'Error', 'Array Iterator', 'Promise', 'Intl.Collator', 'WebAssembly.Module'].map((tag) => {
        const o = { [Symbol.toStringTag]: tag, b: new Blob(['xyz'], { type: 'a/b' }) };
        try { const c = structuredClone(o); return tag + ':' + Object.prototype.toString.call(c.b) + ':' + c.b.size; } catch (e) { return tag + ':' + e.name; }
      });
    `);
    for (const line of Array.from(out))
      assert.match(line, /:\[object Blob\]:3$/, line);
  });

  test('objects that only carry a built-in tag clone as plain data on both paths (matches Node)', async () => {
    const body = `
      const out = [];
      const ns = Object.freeze(Object.defineProperty({ __proto__: null, a: 1, b: [2] }, Symbol.toStringTag, { value: 'Module' }));
      const tries = [
        ns,
        { [Symbol.toStringTag]: 'Array Iterator', a: 1 },
        { [Symbol.toStringTag]: 'Intl.Collator', a: 2 },
        { [Symbol.toStringTag]: 'Promise', a: 3 },
        { [Symbol.toStringTag]: 'Error', a: 4, message: 'm' },
        { [Symbol.toStringTag]: 'WebAssembly.Module', a: 5 },
        new (class Foo { get [Symbol.toStringTag]() { return 'Foo Iterator'; } constructor() { this.a = 6; } })(),
      ];
      for (const v of tries) {
        try { const c = structuredClone(v); out.push(JSON.stringify(c), Object.prototype.toString.call(c)); } catch (e) { out.push('throws ' + e.name); }
      }
      for (const v of [Promise.resolve(), new WeakMap(), [1][Symbol.iterator](), new Intl.Collator(), (function* () {})(), new Map().keys()]) {
        try { structuredClone(v); out.push('cloned'); } catch (e) { out.push(e.name); }
      }
      return out;
    `;
    const node = await (vm.runInThisContext(
      `(async () => {${body}})()`,
    ) as Promise<string[]>);
    const js = await createGlueContext();
    const withHook = await createGlueContext({
      natives: nativeCloneNatives().natives,
    });
    assert.deepEqual(
      Array.from(await js.run<Promise<string[]>>(`(async () => {${body}})()`)),
      node,
    );
    assert.deepEqual(
      Array.from(
        await withHook.run<Promise<string[]>>(`(async () => {${body}})()`),
      ),
      node,
    );
  });

  test('a namespace-shaped object (null proto, non-extensible, writable non-configurable exports) throws on the JS path', async () => {
    const { run } = await createGlueContext();
    assert.equal(
      run(`
        const o = Object.create(null);
        Object.defineProperty(o, 'a', { value: 1, writable: true, enumerable: true, configurable: false });
        Object.defineProperty(o, Symbol.toStringTag, { value: 'Module' });
        Object.preventExtensions(o);
        try { structuredClone(o); 'cloned'; } catch (e) { e.name; }
      `),
      'DataCloneError',
    );
  });

  test('a transfer list with a registered transferable takes the JS path even with the native hook', async () => {
    const { natives, seen } = nativeCloneNatives();
    const { run } = await createGlueContext({ natives });
    const out = run<unknown[]>(`
      class Port { constructor(id) { this.id = id; this.detached = false; } }
      ${REG}.cloneRegistry.registerTransferable({
        is: (v) => v instanceof Port,
        transfer: (v) => { if (v.detached) throw new DOMException('detached', 'DataCloneError'); v.detached = true; return new Port(v.id); },
      });
      const p = new Port(9);
      const c = structuredClone({ p, n: [1, 2] }, { transfer: [p] });
      [c.p instanceof Port, c.p.id, p.detached, c.p !== p, c.n[1]];
    `);
    assert.deepEqual(Array.from(out), [true, 9, true, true, 2]);
    assert.equal(seen.length, 0);
  });

  test('routing costs at most a few times the plain clone for 20k plain objects', async () => {
    const { natives, seen } = nativeCloneNatives();
    const { g, run } = await createGlueContext({ natives });
    run(
      `globalThis.data = Array.from({ length: 20000 }, (_, i) => ({ a: i, b: 'x' + i, c: [i, i + 1], d: { e: i } }))`,
    );
    g.__hostClone = (v: unknown) => structuredClone(v);
    // Relative bound against the bare hook on the same data (best of three each; measured ~2x).
    const [routed, bare] = run<[number, number]>(`
      structuredClone(data);
      const best = (f) => { let m = Infinity; for (let k = 0; k < 3; k++) { const t0 = Date.now(); f(); m = Math.min(m, Date.now() - t0); } return m; };
      [best(() => structuredClone(data)), best(() => __hostClone(data))];
    `);
    assert.equal(seen.length, 4);
    assert.ok(
      routed <= 6 * Math.max(bare, 5),
      `routing + clone took ${routed} ms vs ${bare} ms for the bare clone`,
    );
  });
});

describe('AbortSignal bookkeeping (DOM-10)', () => {
  test('a long-lived source prunes entries of collected AbortSignal.any() dependents', async () => {
    const { run } = await createGlueContext();
    run(
      `globalThis.src = new AbortController(); for (let i = 0; i < 1000; i++) AbortSignal.any([src.signal]);`,
    );
    assert.ok(run<number>(`${REG}.abort.dependentCount(src.signal)`) >= 1000);
    await collect();
    run(`for (let i = 0; i < 2000; i++) AbortSignal.any([src.signal]);`);
    await collect();
    run(`AbortSignal.any([src.signal])`);
    // Without pruning the set would hold ~3001 entries.
    assert.ok(
      run<number>(`${REG}.abort.dependentCount(src.signal)`) < 2100,
      String(run(`${REG}.abort.dependentCount(src.signal)`)),
    );
  });

  test('a removed { signal } listener does not keep its target alive while the signal lives', async () => {
    const { run } = await createGlueContext();
    run(`
      globalThis.ac = new AbortController();
      globalThis.refs = [];
      for (let i = 0; i < 50; i++) {
        const t = new EventTarget();
        const big = new Uint8Array(1 << 16);
        const f = () => big.length;
        t.addEventListener('x', f, { signal: ac.signal });
        t.removeEventListener('x', f);
        refs.push(new WeakRef(t));
      }
      // Dropped without removal: the target is collectable too (the abort algorithm holds it weakly).
      for (let i = 0; i < 50; i++) {
        const t = new EventTarget();
        t.addEventListener('x', () => {}, { signal: ac.signal });
        refs.push(new WeakRef(t));
      }
      globalThis.kept = new EventTarget();
      globalThis.hits = 0;
      kept.addEventListener('x', () => hits++, { signal: ac.signal });
    `);
    await collect();
    assert.equal(run(`refs.filter((r) => r.deref() !== undefined).length`), 0);
    run(
      `kept.dispatchEvent(new Event('x')); ac.abort(); kept.dispatchEvent(new Event('x'))`,
    );
    assert.equal(run(`hits`), 1, 'abort still removes a live listener');
  });

  test('a dependent signal whose only { signal } listener was removed is no longer held by its sources', async () => {
    const { run } = await createGlueContext();
    run(`
      globalThis.src = new AbortController();
      (() => {
        const d = AbortSignal.any([src.signal]);
        // A long-lived target: only removeEventListener (not the target's collection) can drop the
        // abort algorithm that holds d on its source.
        globalThis.target = new EventTarget();
        const f = () => {};
        target.addEventListener('x', f, { signal: d });
        target.removeEventListener('x', f);
        globalThis.ref = new WeakRef(d);
      })();
    `);
    await collect();
    assert.equal(run(`ref.deref() === undefined`), true);
  });

  test('AbortSignal.timeout(ms >= 2^31) waits in int32 chunks on the core timers', async () => {
    const { run, calls } = await createDeviceContext();
    run(
      `globalThis.fired = []; for (const ms of [2 ** 31, 3e9, 2 ** 32 + 5]) { const s = AbortSignal.timeout(ms); s.onabort = () => fired.push(ms); }`,
    );
    await tick(50);
    assert.deepEqual(Array.from(run<number[]>(`fired`)), []);
    assert.ok(
      calls.timerAdd.every((t) => t > 0 && t <= 0x7fffffff),
      String(calls.timerAdd),
    );
  });

  test('the chunks add up to the requested delay', async () => {
    const delays: number[] = [];
    const pending: (() => void)[] = [];
    const { run, g } = await createGlueContext({ timers: false });
    (g as Record<string, unknown>).setTimeout = (
      cb: () => void,
      ms: number,
    ) => {
      delays.push(ms);
      pending.push(cb);
      return pending.length;
    };
    run(`globalThis.s = AbortSignal.timeout(2 ** 32 + 5)`);
    while (pending.length > 0) pending.shift()!();
    assert.deepEqual(delays, [0x7fffffff, 0x7fffffff, 7]);
    assert.equal(run(`s.aborted && s.reason.name`), 'TimeoutError');
  });
});

describe('globals after the core bootstrap (DOM-1, WRK-2)', () => {
  test('window is read-only and self [Replaceable] on device, as in the glue-only context', async () => {
    const { run } = await createDeviceContext();
    const d = run<{ get: string; set: string }>(
      `(() => { const x = Object.getOwnPropertyDescriptor(globalThis, 'window'); return { get: typeof x.get, set: typeof x.set }; })()`,
    );
    assert.equal(d.get, 'function');
    assert.equal(d.set, 'undefined');
    assert.equal(run(`window = 5; typeof window`), 'object');
    assert.equal(run(`window === globalThis`), true);
    assert.equal(run(`self = 3; self`), 3);
  });

  test('in a worker, self is read-only and window is gone', async () => {
    const { run } = await createDeviceContext({
      config: { scope: 'worker', url: 'https://app.local/w.js' },
    });
    assert.equal(run(`typeof window`), 'undefined');
    assert.equal(run(`self = 5; self === globalThis`), true);
    assert.equal(
      run(`typeof Object.getOwnPropertyDescriptor(globalThis, 'self').set`),
      'undefined',
    );
  });

  test('globalThis is an EventTarget (window and worker); WorkerNavigator; Permissions/StorageManager do not clone', async () => {
    const w = await createDeviceContext();
    assert.equal(w.run(`globalThis instanceof EventTarget`), true);
    const k = await createDeviceContext({
      config: { scope: 'worker', url: 'https://app.local/w.js' },
    });
    assert.equal(k.run(`globalThis instanceof EventTarget`), true);
    assert.deepEqual(
      Array.from(
        k.run<unknown[]>(
          `[Object.prototype.toString.call(navigator), WorkerNavigator.name, navigator instanceof WorkerNavigator, 'vendor' in navigator, 'sendBeacon' in navigator, typeof navigator.userAgent, navigator.hardwareConcurrency, navigator.deviceMemory, typeof Navigator]`,
        ),
      ),
      [
        '[object WorkerNavigator]',
        'WorkerNavigator',
        true,
        false,
        false,
        'string',
        4,
        8,
        'undefined',
      ],
    );
    const plain = await createGlueContext();
    assert.equal(
      plain.run(
        `globalThis instanceof EventTarget && addEventListener === EventTarget.prototype.addEventListener`,
      ),
      true,
    );
    const names = plain.run<string[]>(
      `[navigator.permissions, navigator.storage, navigator].map((v) => { try { structuredClone(v); return 'cloned'; } catch (e) { return e.name; } })`,
    );
    assert.deepEqual(Array.from(names), [
      'DataCloneError',
      'DataCloneError',
      'DataCloneError',
    ]);
  });
});

describe('location (DOM-5)', () => {
  test("location.hash = '' on a URL without a fragment returns early; with one it navigates to '#'", async () => {
    const { run } = await createGlueContext();
    const out = run<string[]>(`
      const out = [];
      addEventListener('popstate', () => out.push('popstate'));
      location.hash = '';
      out.push(location.href, String(history.length));
      location.hash = '#x';
      location.hash = '';
      out.push(location.href, String(history.length));
      out;
    `);
    assert.deepEqual(Array.from(out), [
      'https://app.local/',
      '1',
      'popstate',
      'popstate',
      'https://app.local/#',
      '3',
    ]);
  });

  test('another same-origin document needs app.navigate; without it the glue warns and stays', async () => {
    const warnings: string[] = [];
    const reloads: unknown[] = [];
    const { natives } = fakeNatives({
      app: { reload: (...a: unknown[]) => reloads.push(a) },
    });
    const { run } = await createGlueContext({
      natives,
      preset: {
        console: { warn: (m: string) => warnings.push(m), error() {} },
      },
    });
    run(`location.search = '?x=1'; location.assign('other.html')`);
    assert.deepEqual(reloads, []);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /not supported by this host.*\?x=1/);
    assert.equal(run(`location.href`), 'https://app.local/');
    run(`history.replaceState(null, '', '?level=2#spawn')`);
    run(`location.reload()`);
    // the host restarts with the current URL, query and fragment included
    assert.deepEqual(reloads, [['https://app.local/?level=2#spawn']]);
  });
});

describe('WebIDL conversions', () => {
  test('DOMString/USVString arguments throw TypeError for a Symbol (matches Node)', async () => {
    const body = `
      const out = [];
      for (const f of [
        () => new Blob([Symbol()]),
        () => new TextEncoder().encode(Symbol()),
        () => new TextEncoder().encodeInto(Symbol(), new Uint8Array(4)),
        () => btoa(Symbol()),
        () => atob(Symbol()),
        () => new File([], Symbol()),
        () => new ErrorEvent('e', { message: Symbol() }),
        () => new MessageEvent('m', { origin: Symbol() }),
        () => new MessageEvent('m', { lastEventId: Symbol() }),
        () => new TextDecoder(Symbol()),
        () => new Blob([], { type: Symbol() }),
      ]) {
        try { f(); out.push('ok'); } catch (e) { out.push(e.constructor.name); }
      }
      out.push(new File([], 'a\\uD800b').name === 'a\\uFFFDb');
      return out;
    `;
    const node = await (vm.runInThisContext(
      `(async () => {${body}})()`,
    ) as Promise<unknown[]>);
    const { run } = await createGlueContext();
    const glue = Array.from(
      await run<Promise<unknown[]>>(`(async () => {${body}})()`),
    );
    // Node has no ErrorEvent (index 6: ReferenceError there); everything else matches Node.
    assert.equal(node[6], 'ReferenceError');
    assert.deepEqual(
      glue.filter((_, i) => i !== 6),
      node.filter((_, i) => i !== 6),
    );
    assert.ok(glue.slice(0, 11).every((x) => x === 'TypeError'));
  });

  test('ProgressEvent loaded/total use the unsigned long long conversion', async () => {
    const { run } = await createGlueContext();
    assert.deepEqual(
      Array.from(
        run<number[]>(
          `[new ProgressEvent('p', { loaded: 1.5, total: -1 }), new ProgressEvent('p', { loaded: NaN, total: 2 ** 64 + 4096 }), new ProgressEvent('p', { loaded: -0.5 })].flatMap((e) => [e.loaded, e.total])`,
        ),
      ),
      [1, 18446744073709552000, 0, 4096, 0, 0],
    );
  });
});

describe('codec speed on large inputs (NET-16, NET-14)', () => {
  test('atob/btoa/readAsDataURL match Node on random data, padding and whitespace cases', async () => {
    const { run, g } = await createGlueContext();
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 257, 10000, 100001]) {
      const bytes = randomFillSync(new Uint8Array(n));
      const bin = Buffer.from(bytes).toString('latin1');
      const b64 = Buffer.from(bytes).toString('base64');
      (g as Record<string, unknown>).bin = bin;
      assert.equal(run(`btoa(bin)`), b64, `btoa ${n}`);
      (g as Record<string, unknown>).b64 = b64;
      assert.equal(run(`atob(b64)`), bin, `atob ${n}`);
      const url = await run<Promise<string>>(
        `new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))])); })`,
      );
      assert.equal(url, `data:application/octet-stream;base64,${b64}`);
    }
    for (const s of [
      'YQ',
      'YQ=',
      'YQ==',
      'YWI',
      'YWI=',
      ' Y W I = ',
      'Y',
      'YQ===',
      'Y=Q=',
      'YR==',
      'YWé=',
      '====',
    ]) {
      const node = (() => {
        try {
          return atob(s);
        } catch (e) {
          return (e as Error).name;
        }
      })();
      (g as Record<string, unknown>).s = s;
      assert.equal(
        run(
          `(() => { try { return atob(s); } catch (e) { return e.name; } })()`,
        ),
        node,
        JSON.stringify(s),
      );
    }
  });

  test('8 MB of ASCII decodes, and 4 MB of base64 round-trips, correctly (speed: npm run perf)', async () => {
    const { run } = await createGlueContext();
    run(
      `globalThis.ascii = new Uint8Array(8 << 20).fill(97); globalThis.bin = String.fromCharCode(...new Uint8Array(4096).map((_, i) => i & 255)).repeat(1024);`,
    );
    // Speed is measured by `npm run perf` (absolute bounds flake on a shared machine); here only the
    // results are checked.
    assert.equal(run(`new TextDecoder().decode(ascii).length`), 8 << 20);
    assert.equal(run(`atob(btoa(bin)) === bin`), true);
    // An ASCII prefix followed by multi-byte text and a split sequence across stream chunks.
    assert.equal(
      run(
        `const d = new TextDecoder(); const head = 'a'.repeat(100); const enc = new TextEncoder().encode(head + 'é€😀'); d.decode(enc.subarray(0, 102), { stream: true }) + d.decode(enc.subarray(102))`,
      ),
      `${'a'.repeat(100)}é€😀`,
    );
  });
});

describe('crypto.subtle prelude (NET-STORE-4)', () => {
  test('the main bundle has no @noble/hashes; the prelude installs subtle only when config enables it', async () => {
    const buildScript = new URL('../build.mjs', import.meta.url).href;
    const { buildOptions, subtleBuildOptions } = (await import(
      buildScript
    )) as Record<string, Record<string, unknown>>;
    const inputsOf = async (
      opts: Record<string, unknown>,
    ): Promise<string[]> => {
      const r = await build({
        ...opts,
        minify: true,
        write: false,
        metafile: true,
        outfile: 'x.js',
      } as never);
      const out = r.metafile!.outputs[Object.keys(r.metafile!.outputs)[0]!]!;
      return Object.entries(out.inputs)
        .filter(([, v]) => v.bytesInOutput > 0)
        .map(([k]) => k);
    };
    // The package is the one after the last node_modules/: pnpm's folder names carry peer suffixes
    // (.pnpm/whatwg-url@17.3.0_@noble+hashes@2.4.0/node_modules/whatwg-url/...).
    const noble = (k: string) =>
      k.slice(k.lastIndexOf('node_modules/') + 13).startsWith('@noble/');
    assert.equal((await inputsOf(buildOptions)).some(noble), false);
    assert.equal((await inputsOf(subtleBuildOptions)).some(noble), true);
    const off = await createGlueContext();
    assert.equal(
      off.run(`'subtle' in crypto || typeof SubtleCrypto`),
      'undefined',
    );
    assert.equal(
      off.run(`${REG}.installSubtle(function SubtleCrypto() {}, {})`),
      false,
    );
    const on = await createGlueContext({ config: { subtle: 'digest' } });
    assert.equal(
      on.run(
        `crypto.subtle instanceof SubtleCrypto && Object.prototype.toString.call(crypto.subtle)`,
      ),
      '[object SubtleCrypto]',
    );
    assert.equal(
      await on.run<Promise<string>>(
        `crypto.subtle.digest('SHA-1', new Uint8Array(0)).catch((e) => e.name).then(() => crypto.subtle.digest({ name: 'MD5' }, new Uint8Array(0))).catch((e) => e instanceof DOMException && e.name)`,
      ),
      'NotSupportedError',
    );
    assert.throws(() => on.run(`structuredClone(crypto.subtle)`), {
      name: 'DataCloneError',
    });
  });
});

describe('Intl check (JS-6)', () => {
  test('verifyIntl flags an ICU without the CJ dictionary (one segment per Han character), as seen on device', async () => {
    const { run } = await createGlueContext();
    assert.equal(run(`${REG}.verifyIntl().ok`), true);
    const problems = run<string[]>(`(() => {
      class Seg extends Intl.Segmenter {
        constructor(locale, opts) { super(locale, opts); this.loc = locale; }
        segment(s) {
          // Simulate a dictionary-less ICU for Chinese: split every Han character.
          if (this.loc !== 'zh') return super.segment(s);
          return Array.from(s, (c, i) => ({ segment: c, index: i, isWordLike: true }));
        }
      }
      const fake = Object.assign(Object.create(Intl), { Segmenter: Seg });
      return ${REG}.verifyIntl.call(null, fake);
    })().problems`);
    assert.ok(
      Array.from(problems).some((p) => /Chinese dictionary/.test(p)),
      JSON.stringify(problems),
    );
  });
});
