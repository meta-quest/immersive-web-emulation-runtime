/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Test harness: builds the shipped glue bundle (minified, as the APK gets it) and evaluates it in a
// fresh `vm` context. A plain vm context has only V8's builtins (no URL, TextEncoder, structuredClone,
// EventTarget, ...), the same starting point as the runtime's V8 isolate, so the polyfills are what
// gets tested. `both()` runs one scenario in Node's own realm (V8 + Node's web APIs) and in the glue
// realm and returns comparable snapshots: the conformance check against Node/V8 behaviour.

import { randomFillSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance as hostPerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let bundlePromise: Promise<vm.Script> | null = null;
let subtlePromise: Promise<vm.Script> | null = null;

async function buildScript(
  which: 'buildOptions' | 'subtleBuildOptions',
  filename: string,
): Promise<vm.Script> {
  const opts = (await import(join(root, 'build.mjs'))) as Record<
    string,
    Record<string, unknown>
  >;
  const r = await build({
    ...opts[which],
    minify: true,
    write: false,
    outfile: filename,
  } as never);
  return new vm.Script(r.outputFiles![0]!.text, { filename });
}

export function glueScript(): Promise<vm.Script> {
  bundlePromise ??= buildScript('buildOptions', 'glue.min.js');
  return bundlePromise;
}

/** The opt-in crypto.subtle prelude (a no-op unless config `subtle` is 'digest'). */
export function subtleScript(): Promise<vm.Script> {
  subtlePromise ??= buildScript('subtleBuildOptions', 'glue-subtle.min.js');
  return subtlePromise;
}

export interface FakeNativeCalls {
  random: number;
  decodeUtf8: number;
  encodeUtf8: number;
  clone: number;
  microtask: number;
  reload: (string | undefined)[];
  navigate: string[];
}

export function fakeNatives(overrides: Record<string, unknown> = {}): {
  natives: Record<string, unknown>;
  calls: FakeNativeCalls;
} {
  const calls: FakeNativeCalls = {
    random: 0,
    decodeUtf8: 0,
    encodeUtf8: 0,
    clone: 0,
    microtask: 0,
    reload: [],
    navigate: [],
  };
  const natives: Record<string, unknown> = {
    crypto: {
      random(bytes: Uint8Array) {
        calls.random++;
        randomFillSync(bytes);
      },
    },
    clock: {
      now: () => hostPerformance.now(),
      timeOrigin: () => hostPerformance.timeOrigin,
    },
    device: {
      info: () => ({
        model: 'Quest 3',
        androidRelease: '14',
        languages: ['en-US', 'de-DE'],
        hardwareConcurrency: 4,
        deviceMemory: 7.5,
        onLine: true,
      }),
    },
    app: {
      reload(url?: string) {
        calls.reload.push(url);
      },
      navigate(url: string) {
        calls.navigate.push(url);
      },
    },
    ...overrides,
  };
  return { natives, calls };
}

export type GlueGlobal = typeof globalThis & Record<string, unknown>;

/**
 * A fresh V8 context with the glue installed. `natives` becomes `globalThis.__iwn`. Host timers are
 * provided (the event-loop stream owns them on device) so FileReader / AbortSignal.timeout work.
 */
export async function createGlueContext(
  opts: {
    natives?: Record<string, unknown>;
    config?: unknown;
    preset?: Record<string, unknown>;
    timers?: boolean;
  } = {},
): Promise<{
  g: GlueGlobal;
  ctx: vm.Context;
  run: <T = unknown>(code: string) => T;
}> {
  const script = await glueScript();
  const subtle = await subtleScript();
  const sandbox: Record<string, unknown> = { ...(opts.preset ?? {}) };
  const ctx = vm.createContext(sandbox);
  const g = vm.runInContext('globalThis', ctx) as GlueGlobal;
  const natives = { ...(opts.natives ?? fakeNatives().natives) };
  if (opts.config !== undefined) natives.config = opts.config;
  g.__iwn = natives;
  if (opts.timers !== false) {
    const host = g as Record<string, unknown>;
    host.setTimeout = (cb: () => void, ms?: number) => setTimeout(cb, ms);
    host.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  }
  script.runInContext(ctx);
  // As the APK does when it ships both preludes: glue.min.js, then glue-subtle.min.js.
  subtle.runInContext(ctx);
  return { g, ctx, run: <T>(code: string) => vm.runInContext(code, ctx) as T };
}

let messageCompare = false;
/** Compare error messages in snapshots (for scenarios whose messages the test controls). */
export function compareMessages(on: boolean): void {
  messageCompare = on;
}

/** A JSON-able snapshot of a value, the same for equivalent values from different realms. */
export function snap(v: unknown, seen = new Set<unknown>()): unknown {
  if (v === undefined) return { $: 'undefined' };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'NaN' };
    if (Object.is(v, -0)) return { $: '-0' };
    if (!Number.isFinite(v)) return { $: String(v) };
    return v;
  }
  if (typeof v === 'bigint') return { $: 'bigint', v: String(v) };
  if (typeof v === 'symbol') return { $: 'symbol', v: String(v) };
  if (typeof v === 'function') return { $: 'function' };
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return { $: 'cycle' };
  seen.add(v);
  try {
    const tagName = Object.prototype.toString.call(v).slice(8, -1);
    if (ArrayBuffer.isView(v)) {
      const arr = Array.from(v as unknown as ArrayLike<number | bigint>, (x) =>
        snap(x),
      );
      return { $: tagName, v: arr };
    }
    if (tagName === 'ArrayBuffer')
      return {
        $: 'ArrayBuffer',
        v: Array.from(new Uint8Array(v as ArrayBuffer)),
      };
    if (
      tagName === 'Error' ||
      tagName === 'DOMException' ||
      v instanceof Error
    ) {
      const e = v as { name?: unknown; message?: unknown; code?: unknown };
      // Messages are compared only for errors this suite builds itself (not engine/Node wording).
      return {
        $: 'error',
        name: e.name,
        code: e.code,
        message: messageCompare ? e.message : undefined,
      };
    }
    if (Array.isArray(v))
      return Array.from(v as unknown[], (x) => snap(x, seen));
    if (tagName === 'Map')
      return {
        $: 'Map',
        v: Array.from(v as Map<unknown, unknown>, ([a, b]) => [
          snap(a, seen),
          snap(b, seen),
        ]),
      };
    if (tagName === 'Set')
      return {
        $: 'Set',
        v: Array.from(v as Set<unknown>, (a) => snap(a, seen)),
      };
    if (tagName === 'Date') return { $: 'Date', v: (v as Date).getTime() };
    if (tagName === 'RegExp') return { $: 'RegExp', v: String(v) };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v))
      out[k] = snap((v as Record<string, unknown>)[k], seen);
    return out;
  } finally {
    seen.delete(v);
  }
}

/** Runs `body` (an async function body; `return` the result) in a realm and snapshots it. */
async function runIn(
  evaluate: (code: string) => unknown,
  body: string,
): Promise<unknown> {
  try {
    const value = await (evaluate(
      `(async () => {\n${body}\n})()`,
    ) as Promise<unknown>);
    return snap(value);
  } catch (e) {
    return { thrown: snap(e) };
  }
}

/** The same scenario in Node's realm and in the glue realm. */
export async function both(
  body: string,
  ctxOpts?: Parameters<typeof createGlueContext>[0],
): Promise<{ node: unknown; glue: unknown }> {
  const node = await runIn((c) => vm.runInThisContext(c), body);
  const { run } = await createGlueContext(ctxOpts);
  const glue = await runIn(run, body);
  return { node, glue };
}

export const BOOTSTRAP_PATH = join(root, '../../runtime/core/js/bootstrap.js');

export interface DeviceCalls {
  setBlobResolver: number;
  resolver:
    | ((url: string) => { bytes: Uint8Array; type: string } | null)
    | null;
  timerAdd: number[];
  /** Errors the real bootstrap's reportError handed to core.reportError (listener exceptions, ...). */
  reported: unknown[];
}

/**
 * A device-like boot, as runtime/core does it: the real core bootstrap (runtime/core/js/bootstrap.js)
 * with a fake `__iwn.core` (timers follow the core: the bootstrap passes `Number(t) | 0`, negative means
 * 0), then glue.min.js and glue-subtle.min.js.
 */
export async function createDeviceContext(
  opts: {
    natives?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {},
): Promise<{
  g: GlueGlobal;
  ctx: vm.Context;
  run: <T = unknown>(code: string) => T;
  calls: DeviceCalls;
  logs: unknown[][];
}> {
  const ctx = vm.createContext({});
  const g = vm.runInContext('globalThis', ctx) as GlueGlobal;
  const calls: DeviceCalls = {
    setBlobResolver: 0,
    resolver: null,
    timerAdd: [],
    reported: [],
  };
  const logs: unknown[][] = [];
  let hooks: { timer(id: number): void } | null = null;
  let nextId = 1;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  const config = (opts.config ?? {}) as { scope?: string };
  const core = {
    log: (level: unknown, text: unknown) => logs.push([level, text]),
    timerAdd(timeout: number, repeat: boolean) {
      calls.timerAdd.push(timeout);
      const id = nextId++;
      const ms = timeout < 0 ? 0 : timeout;
      const fire = () => hooks?.timer(id);
      const h = repeat ? setInterval(fire, ms) : setTimeout(fire, ms);
      h.unref(); // long timers (AbortSignal.timeout tests) must not keep the test process alive
      handles.set(id, h);
      return id;
    },
    timerClear(id: number) {
      clearTimeout(handles.get(id));
      clearInterval(handles.get(id));
      handles.delete(id);
    },
    requestFrame() {},
    setHooks(h: { timer(id: number): void }) {
      hooks = h;
    },
    setBlobResolver(fn: DeviceCalls['resolver']) {
      calls.setBlobResolver++;
      calls.resolver = fn;
    },
    runMicrotasks() {},
    enqueueMicrotask: (fn: () => void) => queueMicrotask(fn),
    reportException: (e: unknown) => logs.push(['uncaught', e]),
    reportError: (e: unknown) => {
      calls.reported.push(e);
      logs.push(['reportError', e]);
    },
    lifecycleState: () => ({
      visibilityState: 'visible',
      focused: true,
      readyState: 'loading',
    }),
    reload() {},
    close() {},
    inspectorSessions: () => 0,
    runtimeVersion: '0.0.0',
    v8Version: '15.5',
    origin: 'https://app.local',
    documentUrl: 'https://app.local/',
    isWorker: config.scope === 'worker',
  };
  const base = opts.natives ?? fakeNatives().natives;
  const natives: Record<string, unknown> = {
    ...base,
    core,
    loop: { queueMicrotask: (fn: () => void) => queueMicrotask(fn) },
    config: {
      url: 'https://app.local/',
      runtimeVersion: '0.0.0',
      ...(opts.config ?? {}),
    },
  };
  g.__iwn = natives;
  const boot = vm.runInContext(readFileSync(BOOTSTRAP_PATH, 'utf8'), ctx, {
    filename: 'bootstrap.js',
  }) as (n: unknown, g: unknown) => void;
  boot(natives, g);
  (await glueScript()).runInContext(ctx);
  (await subtleScript()).runInContext(ctx);
  return {
    g,
    ctx,
    run: <T>(code: string) => vm.runInContext(code, ctx) as T,
    calls,
    logs,
  };
}
