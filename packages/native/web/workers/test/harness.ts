/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Headless test harness for the workers prelude: every global (the page, each worker) is a fresh `vm` context with
// the real core bootstrap (runtime/core/js/bootstrap.js, over fake core natives), the shipped web glue bundle and
// the workers bundle, as on the device. A fake `__iwn.workers` emulates the native module in JS:
//   * ports: the same semantics as runtime/workers' PortHub (entangled pairs, queued until started, one delivery
//     task per message, transfer keeps the queue, close disentangles);
//   * workers: a new realm per Worker; scripts come from a virtual dist (`files`), data: URLs or blob bytes;
//   * serialization: host objects (found through hostPrototypes) go through the realm's hostWrite/hostRead hooks
//     like the native ValueSerializer delegate; the rest of the graph crosses realms with the glue's own
//     structuredClone (transfer detaches the sender's ArrayBuffers). SharedArrayBuffer and wasm modules are not
//     emulated (device tests cover them).
// Deliveries and timers run on Node's event loop (setImmediate / setTimeout), so tests await `settle()`.

import { randomFillSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance as hostPerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const nativeRoot = join(here, '../../..');
const BOOTSTRAP = readFileSync(
  join(nativeRoot, 'runtime/core/js/bootstrap.js'),
  'utf8',
);
const GLUE = new vm.Script(
  readFileSync(join(nativeRoot, 'web/glue/dist/glue.min.js'), 'utf8'),
  { filename: 'glue.min.js' },
);

let workersScript: vm.Script | null = null;
async function workersBundle(): Promise<vm.Script> {
  if (!workersScript) {
    const opts = (await import(join(here, '../build.mjs'))) as {
      buildOptions: Record<string, unknown>;
    };
    const r = await build({
      ...opts.buildOptions,
      minify: true,
      write: false,
      outfile: 'workers.min.js',
    } as never);
    workersScript = new vm.Script(r.outputFiles![0]!.text, {
      filename: 'workers.min.js',
    });
  }
  return workersScript;
}

export type G = typeof globalThis & Record<string, any>;

interface Port {
  peer: number;
  owner: Realm | null;
  queue: Msg[];
  started: boolean;
  scheduled: boolean;
}
interface Msg {
  inter: unknown;
  portIds: number[];
  tokens: number[];
  delivered: boolean;
}

export class World {
  ports = new Map<number, Port>();
  nextPort = 1;
  nextWorker = 1;
  live = 0;
  maxWorkers = 32;
  files: Record<string, string> = {};
  realms: Realm[] = [];
  logs: { realm: string; level: number; text: string }[] = [];
  crossOriginIsolated = true;
  posted = 0;
  delivered = 0;

  constructor(
    opts: { files?: Record<string, string>; maxWorkers?: number } = {},
  ) {
    this.files = opts.files ?? {};
    this.maxWorkers = opts.maxWorkers ?? 32;
  }

  pair(a: Realm | null, b: Realm | null): [number, number] {
    const x = this.nextPort++;
    const y = this.nextPort++;
    this.ports.set(x, {
      peer: y,
      owner: a,
      queue: [],
      started: false,
      scheduled: false,
    });
    this.ports.set(y, {
      peer: x,
      owner: b,
      queue: [],
      started: false,
      scheduled: false,
    });
    return [x, y];
  }
  schedule(id: number): void {
    const p = this.ports.get(id);
    if (!p || p.scheduled || !p.started || !p.owner || p.queue.length === 0)
      return;
    p.scheduled = true;
    const owner = p.owner;
    setImmediate(() => owner.deliver(id));
  }
  post(from: number, m: Msg): boolean {
    const p = this.ports.get(from);
    const peer = p && p.peer ? this.ports.get(p.peer) : undefined;
    if (!p || !peer) {
      this.dropMessage(m);
      return false;
    }
    this.posted++;
    peer.queue.push(m);
    this.schedule(p.peer);
    return true;
  }
  pop(id: number, owner: Realm): Msg | null {
    const p = this.ports.get(id);
    if (!p) return null;
    p.scheduled = false;
    if (p.owner !== owner || !p.started || p.queue.length === 0) return null;
    const m = p.queue.shift()!;
    this.delivered++;
    this.schedule(id);
    return m;
  }
  start(id: number): void {
    const p = this.ports.get(id);
    if (!p) return;
    p.started = true;
    this.schedule(id);
  }
  close(id: number): void {
    const p = this.ports.get(id);
    if (!p) return;
    const peer = p.peer ? this.ports.get(p.peer) : undefined;
    if (peer) peer.peer = 0;
    this.ports.delete(id);
    for (const m of p.queue) this.dropMessage(m);
  }
  dropMessage(m: Msg): void {
    if (m.delivered) return;
    for (const id of m.portIds) this.close(id);
  }
  log(realm: string, level: number, text: string): void {
    this.logs.push({ realm, level, text });
  }
}

interface WorkerSpec {
  id: number;
  name: string;
  url: string;
  type: 'classic' | 'module';
  insidePort: number;
  parent: Realm;
  source: string | null;
  deviceInfo: Record<string, unknown> | null;
}

export class Realm {
  ctx: vm.Context;
  g: G;
  hooks: any = null;
  coreHooks: any = null;
  blobResolver:
    | ((url: string) => { bytes: Uint8Array; type: string } | null)
    | null = null;
  dead = false;
  closing = false;
  timers = new Map<number, ReturnType<typeof setTimeout>>();
  nextTimer = 1;
  pending = new Map<number, Msg>();
  nextPending = 1;
  children = new Map<number, Realm>();
  label: string;

  readonly world: World;
  readonly spec: WorkerSpec | null;
  constructor(world: World, spec: WorkerSpec | null) {
    this.world = world;
    this.spec = spec;
    this.label = spec
      ? spec.name
        ? `worker ${spec.id} '${spec.name}'`
        : `worker ${spec.id}`
      : 'main';
    this.ctx = vm.createContext({});
    this.g = vm.runInContext('globalThis', this.ctx) as G;
    world.realms.push(this);
  }

  async boot(): Promise<void> {
    const g = this.g;
    const spec = this.spec;
    const self = this;
    const url = spec ? spec.url : 'https://app.local/';
    const core = {
      log: (level: number, text: string) =>
        self.world.log(self.label, level, text),
      timerAdd(timeout: number, repeat: boolean) {
        const id = self.nextTimer++;
        const ms = timeout < 0 ? 0 : timeout;
        const fire = () => {
          if (self.dead || self.closing) return;
          try {
            self.coreHooks?.timer(id);
          } catch (e) {
            self.reportException(e);
          }
        };
        const h = repeat ? setInterval(fire, ms) : setTimeout(fire, ms);
        h.unref(); // a test's leftover worker timers must not keep the process alive
        self.timers.set(id, h);
        return id;
      },
      timerClear(id: number) {
        const h = self.timers.get(id);
        clearTimeout(h);
        clearInterval(h);
        self.timers.delete(id);
      },
      requestFrame() {},
      setHooks(h: unknown) {
        self.coreHooks = h;
      },
      setBlobResolver(
        fn: (url: string) => { bytes: Uint8Array; type: string } | null,
      ) {
        self.blobResolver = fn;
      },
      invokeCallback(
        fn: (...a: unknown[]) => unknown,
        thisArg: unknown,
        ...args: unknown[]
      ) {
        try {
          return fn.apply(thisArg, args);
        } catch (e) {
          self.reportException(e);
          return undefined;
        }
      },
      enqueueMicrotask: (fn: () => void) => queueMicrotask(fn),
      reportException: (e: unknown) =>
        self.world.log(self.label, 3, 'Uncaught ' + String(e)),
      reportError: (e: unknown) => self.reportException(e),
      lifecycleState: () => ({
        visibilityState: 'visible',
        focused: !spec,
        readyState: 'complete',
      }),
      reload() {},
      close() {},
      inspectorSessions: () => 0,
      runtimeVersion: '0.0.0',
      v8Version: '15.5',
      origin: 'https://app.local',
      documentUrl: url,
      isWorker: !!spec,
      workerName: spec ? spec.name || `worker ${spec.id}` : undefined,
    };
    const natives: Record<string, unknown> = {
      core,
      clock: {
        now: () => hostPerformance.now(),
        timeOrigin: () => hostPerformance.timeOrigin,
      },
      loop: { queueMicrotask: (fn: () => void) => queueMicrotask(fn) },
      crypto: { random: (b: Uint8Array) => randomFillSync(b) },
      device: {
        info: () =>
          spec?.deviceInfo ?? {
            model: 'Quest 3',
            androidRelease: '14',
            languages: ['en-US'],
            hardwareConcurrency: 8,
            onLine: true,
          },
      },
      config: spec ? { scope: 'worker', url } : { url },
      workers: this.workersNatives(),
    };
    g.__iwn = natives;
    const boot = vm.runInContext(BOOTSTRAP, this.ctx, {
      filename: 'iwn-runtime:///core/bootstrap.js',
    }) as (n: unknown, g: unknown) => void;
    boot(natives, g);
    if (spec) {
      vm.runInContext(
        '(function(g){const d=(n,v)=>Object.defineProperty(g,n,{value:v,writable:true,configurable:true});' +
          "d('WorkerGlobalScope',function WorkerGlobalScope(){});d('DedicatedWorkerGlobalScope',function DedicatedWorkerGlobalScope(){});" +
          "d('importScripts',function importScripts(){throw new TypeError('stub')});})(globalThis)",
        this.ctx,
      );
    }
    GLUE.runInContext(this.ctx);
    (await workersBundle()).runInContext(this.ctx);
  }

  run<T = any>(code: string, filename = 'test.js'): T {
    return vm.runInContext(code, this.ctx, { filename }) as T;
  }

  /** Evaluates `code` and returns its JSON round trip (plain test-realm values for deepEqual). */
  json<T = any>(code: string): T {
    return JSON.parse(
      vm.runInContext(`JSON.stringify(${code})`, this.ctx) as string,
    ) as T;
  }

  reportException(e: unknown, filename = '', lineno = 0, colno = 0): void {
    const message =
      e instanceof this.g.Error ||
      (e && typeof e === 'object' && 'message' in (e as object))
        ? `${(e as Error).name}: ${(e as Error).message}`
        : String(e);
    let notCancelled = true;
    if (this.coreHooks?.error)
      notCancelled =
        this.coreHooks.error(
          e,
          'Uncaught ' + message,
          filename,
          lineno,
          colno,
        ) !== false;
    if (!notCancelled) return;
    const spec = this.spec;
    if (spec && !spec.parent.dead) {
      const parent = spec.parent;
      setImmediate(() =>
        parent.dispatch('error', spec.id, {
          message: 'Uncaught ' + message,
          filename,
          lineno,
          colno,
          label: this.label,
        }),
      );
    } else {
      this.world.log(this.label, 3, 'Uncaught ' + message);
    }
  }

  dispatch(kind: string, ...args: unknown[]): void {
    if (this.dead || !this.hooks) return;
    try {
      this.hooks.dispatch(kind, ...args);
    } catch (e) {
      this.reportException(e);
    }
  }

  deliver(port: number): void {
    if (this.dead || this.closing) return;
    const m = this.world.pop(port, this);
    if (!m) return;
    for (const id of m.portIds) {
      const p = this.world.ports.get(id);
      if (p) p.owner = this;
    }
    m.delivered = true;
    const portIds = this.g.Array.from(m.portIds) as number[];
    const tokens = this.g.Array.from(m.tokens) as number[];
    let value: unknown;
    try {
      value = this.revive(this.g.structuredClone(m.inter), portIds, tokens);
    } catch {
      this.dispatch('messageerror', port, portIds, tokens);
      return;
    }
    this.dispatch('message', port, value, portIds, tokens);
  }

  // --- serialization emulation ---
  isHost(v: object): boolean {
    const protos: object[] = this.hooks?.hostPrototypes ?? [];
    for (let p = Object.getPrototypeOf(v); p; p = Object.getPrototypeOf(p)) {
      if (protos.includes(p)) return true;
    }
    return false;
  }

  serialize(value: unknown, transfer: ArrayBuffer[]): number {
    const g = this.g;
    for (const ab of transfer) {
      if ((ab as ArrayBuffer).detached)
        throw new g.DOMException(
          'ArrayBuffer is already detached.',
          'DataCloneError',
        );
    }
    const memo = new Map<unknown, unknown>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'function')
        throw new g.DOMException(
          'function could not be cloned.',
          'DataCloneError',
        );
      if (typeof v === 'symbol')
        throw new g.DOMException(
          'Symbol could not be cloned.',
          'DataCloneError',
        );
      if (typeof v !== 'object' || v === null) return v;
      if (memo.has(v)) return memo.get(v);
      if (this.isHost(v)) {
        const box: Record<string, unknown> = {};
        memo.set(v, box);
        box.__iwnHost = walk(this.hooks.hostWrite(v));
        return box;
      }
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        memo.set(v, out);
        for (let i = 0; i < v.length; i++) out[i] = walk(v[i]);
        return out;
      }
      const tag = Object.prototype.toString.call(v);
      if (tag === '[object Map]') {
        const out = new Map();
        memo.set(v, out);
        for (const [k, x] of v as Map<unknown, unknown>)
          out.set(walk(k), walk(x));
        return out;
      }
      if (tag === '[object Set]') {
        const out = new Set();
        memo.set(v, out);
        for (const x of v as Set<unknown>) out.add(walk(x));
        return out;
      }
      if (tag === '[object Object]') {
        const out: Record<string, unknown> = {};
        memo.set(v, out);
        for (const k of Object.keys(v))
          out[k] = walk((v as Record<string, unknown>)[k]);
        return out;
      }
      return v; // ArrayBuffer, views, Date, RegExp, Error, boxed primitives: the glue's structuredClone handles them
    };
    const copy = walk(value);
    const inter = g.structuredClone(copy, { transfer });
    const id = this.nextPending++;
    this.pending.set(id, { inter, portIds: [], tokens: [], delivered: false });
    return id;
  }

  revive(v: unknown, portIds: number[], tokens: number[]): unknown {
    const memo = new Map<unknown, unknown>();
    const fix = (x: unknown): unknown => {
      if (typeof x !== 'object' || x === null) return x;
      if (memo.has(x)) return memo.get(x);
      if (
        Object.prototype.hasOwnProperty.call(x, '__iwnHost') &&
        Object.keys(x).length === 1
      ) {
        const desc = fix((x as Record<string, unknown>).__iwnHost) as object;
        const obj = this.hooks.hostRead(desc, portIds, tokens);
        memo.set(x, obj);
        return obj;
      }
      memo.set(x, x);
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) x[i] = fix(x[i]);
      } else if (x instanceof this.g.Map) {
        const entries = [...(x as Map<unknown, unknown>)];
        (x as Map<unknown, unknown>).clear();
        for (const [k, val] of entries)
          (x as Map<unknown, unknown>).set(fix(k), fix(val));
      } else if (x instanceof this.g.Set) {
        const items = [...(x as Set<unknown>)];
        (x as Set<unknown>).clear();
        for (const it of items) (x as Set<unknown>).add(fix(it));
      } else if (Object.prototype.toString.call(x) === '[object Object]') {
        for (const k of Object.keys(x))
          (x as Record<string, unknown>)[k] = fix(
            (x as Record<string, unknown>)[k],
          );
      }
      return x;
    };
    return fix(v);
  }

  // --- worker lifecycle ---
  async startWorker(spec: WorkerSpec): Promise<void> {
    await this.boot();
    if (this.dead) return;
    let source = spec.source;
    if (source === null)
      source = this.world.files[spec.url.split('#')[0]!] ?? null;
    if (source === null && spec.url.startsWith('data:'))
      source = decodeDataURL(spec.url);
    if (source === null) {
      this.world.log(this.label, 3, `failed to load worker script ${spec.url}`);
      setImmediate(() =>
        spec.parent.dispatch('loaderror', spec.id, 'not found'),
      );
      this.end();
      return;
    }
    try {
      vm.runInContext(source, this.ctx, { filename: spec.url });
    } catch (e) {
      this.reportException(e, spec.url);
    }
    this.world.start(spec.insidePort);
  }

  end(): void {
    if (this.dead) return;
    this.dead = true;
    for (const h of this.timers.values()) {
      clearTimeout(h);
      clearInterval(h);
    }
    for (const c of this.children.values()) c.end();
    for (const [id, p] of [...this.world.ports])
      if (p.owner === this) this.world.close(id);
    const spec = this.spec;
    if (spec) {
      this.world.live--;
      setImmediate(() => spec.parent.dispatch('exit', spec.id));
    }
  }

  workersNatives(): Record<string, unknown> {
    const self = this;
    const world = this.world;
    const spec = this.spec;
    const n: Record<string, unknown> = {
      setHooks(h: unknown) {
        self.hooks = h;
      },
      info() {
        return {
          isWorker: !!spec,
          id: spec?.id,
          name: spec?.name,
          url: spec?.url,
          type: spec?.type,
          insidePort: spec?.insidePort,
          origin:
            spec && spec.url.startsWith('data:') ? 'null' : 'https://app.local',
          maxWorkers: world.maxWorkers,
          live: world.live,
          crossOriginIsolated: world.crossOriginIsolated,
          hardwareConcurrencyCap: 4,
        };
      },
      create(
        url: string,
        type: 'classic' | 'module',
        name: string,
        source: Uint8Array | null,
        deviceInfo: Record<string, unknown> | null,
      ) {
        const g = self.g;
        if (!/^(https:\/\/app\.local\/|data:|blob:)/.test(url)) {
          throw new g.DOMException(
            `Script at '${url}' cannot be accessed from origin 'https://app.local'.`,
            'SecurityError',
          );
        }
        if (world.live >= world.maxWorkers) {
          throw new g.DOMException(
            `at most ${world.maxWorkers} workers can run at once`,
            'NotSupportedError',
          );
        }
        world.live++;
        const id = world.nextWorker++;
        const [outside, inside] = world.pair(self, null);
        world.start(outside);
        const childSpec: WorkerSpec = {
          id,
          name,
          url,
          type,
          insidePort: inside,
          parent: self,
          source: source ? new TextDecoder().decode(source) : null,
          deviceInfo: deviceInfo ? { ...deviceInfo } : null,
        };
        const child = new Realm(world, childSpec);
        world.ports.get(inside)!.owner = child;
        self.children.set(id, child);
        setImmediate(() => void child.startWorker(childSpec));
        return [id, outside];
      },
      terminate(id: number) {
        const c = self.children.get(id);
        if (!c) return;
        self.children.delete(id);
        world.close(c.spec!.insidePort - 1); // the outside port is created right before the inside one
        c.end();
      },
      channel() {
        return world.pair(self, self);
      },
      serialize(value: unknown, transfer: ArrayBuffer[]) {
        return self.serialize(value, transfer);
      },
      post(port: number, pending: number, portIds: number[], tokens: number[]) {
        const m = self.pending.get(pending);
        if (!m)
          throw new self.g.DOMException(
            'unknown serialized message',
            'InvalidStateError',
          );
        self.pending.delete(pending);
        m.portIds = [...portIds];
        m.tokens = [...tokens];
        for (const id of m.portIds) {
          const p = world.ports.get(id);
          if (p && p.owner === self) {
            p.owner = null;
            p.started = false;
            p.scheduled = false;
          }
        }
        return world.post(port, m);
      },
      discard(pending: number) {
        self.pending.delete(pending);
      },
      start(port: number) {
        world.start(port);
      },
      close(port: number) {
        world.close(port);
      },
      stats() {
        return {
          live: world.live,
          posted: world.posted,
          delivered: world.delivered,
          ports: world.ports.size,
        };
      },
    };
    if (spec) {
      n.readScript = (url: string) => {
        const s =
          world.files[url] ??
          (url.startsWith('data:') ? decodeDataURL(url) : null);
        if (s === null)
          throw new self.g.DOMException(
            `The script at '${url}' failed to load.`,
            'NetworkError',
          );
        return s;
      };
      n.evalScript = (source: string, url: string) =>
        vm.runInContext(source, self.ctx, { filename: url });
      n.closeSelf = () => {
        self.closing = true;
        setImmediate(() => self.end());
      };
      n.forwardError = (
        message: string,
        filename: string,
        lineno: number,
        colno: number,
      ) => {
        const parent = spec.parent;
        setImmediate(() =>
          parent.dispatch('error', spec.id, {
            message,
            filename,
            lineno,
            colno,
            label: self.label,
          }),
        );
      };
    }
    return n;
  }
}

function decodeDataURL(url: string): string | null {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  return m[2]
    ? Buffer.from(m[3]!, 'base64').toString('utf8')
    : decodeURIComponent(m[3]!);
}

/** Creates the page realm of a new world. */
export async function createPage(
  opts: { files?: Record<string, string>; maxWorkers?: number } = {},
): Promise<{ world: World; page: Realm }> {
  const world = new World(opts);
  const page = new Realm(world, null);
  await page.boot();
  return { world, page };
}

/** Waits until Node's queues drain a few times (deliveries, timers of 0 ms). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Polls until `fn()` is truthy (bounded). */
export async function until(fn: () => unknown, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}
