/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { AudioNatives, WebAudioOptions } from './natives.ts';
import {
  ARG_COUNT,
  EventType,
  FIRST_NODE_ID,
  LISTENER_SLOTS,
  NODE_CAPACITY,
  Op,
  PARAM_CAPACITY,
  Shared,
} from './protocol.ts';
import { domError, reportError } from './util.ts';

/** What a context needs from the event hub. */
export interface CoreOwner {
  onState(state: number, requestId: number): void;
  onRenderDone(bufferId: number): void;
}

export interface EndedTarget {
  dispatchEnded(): void;
}

export interface DecodeRequest {
  resolve(bufferId: number): void;
  reject(message: string): void;
}

/** Per-install environment shared by every object the install creates. */
export interface Env {
  natives: AudioNatives;
  log: (message: string) => void;
  urlOf: (data: ArrayBuffer) => string | undefined;
  now: () => number;
  hub: Hub;
  /** Wraps native buffer storage in the install's AudioBuffer class. */
  wrapBuffer: (native: [number, number, number, number, ...Float32Array[]]) => unknown;
  /** Called once when the first AudioContext of this install is created. */
  onFirstContext?: () => unknown;
  /** The install's AudioBuffer class (what apps see as `AudioBuffer`). */
  AudioBuffer: new (options: { numberOfChannels?: number; length: number; sampleRate: number }) => unknown;
}

export function makeEnv(natives: AudioNatives, options: WebAudioOptions = {}): Env {
  const env = {
    natives,
    log: options.log ?? ((m: string) => console.warn(m)),
    urlOf:
      options.urlOf ??
      ((data: ArrayBuffer) => {
        const map = (globalThis as { __iwnResourceUrls?: WeakMap<object, string> }).__iwnResourceUrls;
        return map?.get(data);
      }),
    now: options.now ?? (() => globalThis.performance.now()),
    hub: undefined as unknown as Hub,
    wrapBuffer: () => {
      throw new Error('wrapBuffer not installed');
    },
    AudioBuffer: undefined as unknown as Env['AudioBuffer'],
  } as Env;
  env.hub = new Hub(env);
  return env;
}

/**
 * JS side of one native context: batches control messages per task (one natives.submit per
 * task, flushed from a microtask: AUD-10/AUD-11), allocates node ids and param slots, and keeps
 * playing sources alive until they end.
 */
export class Core {
  readonly env: Env;
  readonly id: number;
  readonly sampleRate: number;
  readonly shared: Float64Array;
  readonly params: Float32Array;
  readonly offline: boolean;
  owner: CoreOwner | null = null;
  /**
   * Set once the native side will never consume another batch (close() requested, offline
   * rendering finished): graph changes are dropped instead of queueing natively forever.
   */
  dead = false;
  /** natives.releaseContext was called. */
  released = false;
  /** Number of batches submitted so far; the batch being built gets seq + 1. */
  seq = 0;
  playing = new Map<number, EndedTarget>();
  pendingState = 0;
  rendering = false;
  pendingFrees = 0;

  #words = new Float64Array(1024);
  /** Words used in the batch being built (see words()). */
  count = 0;
  #flushQueued = false;
  #nextId = FIRST_NODE_ID;
  #freeIds: number[] = [];
  #nextSlot = LISTENER_SLOTS;
  #freeSlots = new Map<number, number[]>();
  #nodeSlots = new Map<number, number>(); // id -> slotBase * 64 + count
  /** Bumped when a param slot is recycled, so stale connection keys cannot match a new param. */
  readonly slotGeneration = new Uint16Array(PARAM_CAPACITY);
  readonly #flushBound = (): void => this.flush();

  constructor(env: Env, created: [number, number, Float64Array, Float32Array], offline: boolean) {
    this.env = env;
    this.id = created[0];
    this.sampleRate = created[1];
    this.shared = created[2];
    this.params = created[3];
    this.offline = offline;
  }

  get frame(): number {
    return this.shared[Shared.Frame];
  }
  get currentTime(): number {
    return this.shared[Shared.Frame] / this.sampleRate;
  }
  get appliedSeq(): number {
    return this.shared[Shared.AppliedSeq];
  }
  get nextSeq(): number {
    return this.seq + 1;
  }

  /**
   * Room for `n` more words: returns the batch array; the caller writes at [count, count + n) and
   * then advances `count`. Lets per-frame paths (AudioParam automation) store doubles straight
   * into the Float64Array instead of passing them through a call, which boxes them.
   */
  words(n: number): Float64Array {
    return this.#reserve(n);
  }

  #reserve(n: number): Float64Array {
    const need = this.count + n;
    if (need > this.#words.length) {
      let len = this.#words.length * 2;
      while (len < need) len *= 2;
      const grown = new Float64Array(len);
      grown.set(this.#words.subarray(0, this.count));
      this.#words = grown;
    }
    if (!this.#flushQueued) {
      this.#flushQueued = true;
      queueMicrotask(this.#flushBound);
    }
    return this.#words;
  }

  /**
   * Appends one command (op + its fixed arguments, ARG_COUNT) to the current batch. Positional
   * arguments instead of a rest array: automation calls run every frame (three.js issues 9 ramps
   * per frame for its AudioListener) and must not allocate (PERF-ALLOC-1).
   */
  cmd(op: number, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0, j = 0): void {
    if (this.dead) return;
    const n = ARG_COUNT[op];
    const w = this.#reserve(1 + n);
    const k = this.count;
    w[k] = op;
    if (n > 0) w[k + 1] = a;
    if (n > 1) w[k + 2] = b;
    if (n > 2) w[k + 3] = c;
    if (n > 3) w[k + 4] = d;
    if (n > 4) w[k + 5] = e;
    if (n > 5) w[k + 6] = f;
    if (n > 6) w[k + 7] = g;
    if (n > 7) w[k + 8] = h;
    if (n > 8) w[k + 9] = i;
    if (n > 9) w[k + 10] = j;
    this.count = k + 1 + n;
  }

  /** A command whose last fixed argument is followed by trailing values (curves, periodic waves). */
  cmdWithValues(head: ArrayLike<number>, values: ArrayLike<number>, values2?: ArrayLike<number>): void {
    if (this.dead) return;
    const total = head.length + values.length + (values2 ? values2.length : 0);
    const w = this.#reserve(total);
    let k = this.count;
    for (let x = 0; x < head.length; x++) w[k++] = head[x];
    for (let x = 0; x < values.length; x++) w[k++] = values[x];
    if (values2) for (let x = 0; x < values2.length; x++) w[k++] = values2[x];
    this.count = k;
  }

  flush(): void {
    this.#flushQueued = false;
    const count = this.count;
    // Reset first: a batch the native side rejects must not be resubmitted with every later one.
    this.count = 0;
    if (count === 0 || this.dead) return;
    this.seq = this.env.natives.submit(this.id, this.#words, count);
  }

  /** Param slot base of the node allocNode() returned last (no result object per node: AUD-11). */
  allocatedSlot = 0;

  /** Allocates a node id (returned) and its param slots (base in `allocatedSlot`). */
  allocNode(paramCount: number): number {
    let id = this.#freeIds.pop();
    if (id === undefined) {
      if (this.#nextId >= NODE_CAPACITY) {
        throw domError('NotSupportedError', 'too many live AudioNodes in this context');
      }
      id = this.#nextId++;
    }
    let slot = 0;
    if (paramCount > 0) {
      const free = this.#freeSlots.get(paramCount);
      const reused = free?.pop();
      if (reused !== undefined) {
        slot = reused;
      } else {
        if (this.#nextSlot + paramCount > PARAM_CAPACITY) {
          this.#freeIds.push(id);
          throw domError('NotSupportedError', 'too many live AudioParams in this context');
        }
        slot = this.#nextSlot;
        this.#nextSlot += paramCount;
      }
      this.#nodeSlots.set(id, slot * 64 + paramCount);
    }
    this.allocatedSlot = slot;
    return id;
  }

  // Collected JS nodes -> ReleaseNode. One registry per context, so the held value is just the id
  // (no object per node). If the context itself is collected, its native side goes with it.
  #nodeRegistry: FinalizationRegistry<number> | null = null;
  /** Releases node `id` on the render side once `node` is garbage collected. */
  trackNode(node: object, id: number): void {
    (this.#nodeRegistry ??= new FinalizationRegistry<number>((freedId) => this.release(freedId))).register(node, id);
  }

  /** The JS node object was garbage collected. */
  release(id: number): void {
    if (this.dead) return;
    this.cmd(Op.ReleaseNode, id);
    this.pendingFrees++;
    this.env.hub.kick();
  }

  /** The render side removed the node: its id and param slots can be reused. */
  freed(id: number): void {
    this.pendingFrees = Math.max(0, this.pendingFrees - 1);
    const s = this.#nodeSlots.get(id);
    if (s !== undefined) {
      this.#nodeSlots.delete(id);
      const count = s % 64;
      const base = (s - count) / 64;
      for (let k = 0; k < count; k++) this.slotGeneration[base + k] = (this.slotGeneration[base + k] + 1) & 0xffff;
      let list = this.#freeSlots.get(count);
      if (!list) this.#freeSlots.set(count, (list = []));
      list.push(base);
    }
    this.#freeIds.push(id);
  }

  waiting(): boolean {
    return this.playing.size > 0 || this.pendingState > 0 || this.rendering || this.pendingFrees > 0;
  }
}

/** BaseAudioContext -> Core (lets nodes reach their context's core without importing context.ts). */
const contextCores = new WeakMap<object, Core>();

export function bindContext(context: object, core: Core): void {
  contextCores.set(context, core);
}

export function coreOf(context: unknown): Core {
  const core = typeof context === 'object' && context !== null ? contextCores.get(context) : undefined;
  if (!core) throw new TypeError('argument is not a BaseAudioContext');
  return core;
}


/**
 * Receives native events (pushed as tasks when the host provides hooks, otherwise polled while
 * something is outstanding) and routes them to contexts, sources and decode requests.
 */
export class Hub {
  readonly env: Env;
  /**
   * Live contexts by id, held weakly: the Hub lives as long as the install, and a strong map would
   * keep every context (and its ~2.5 MB native graph) alive until reload. Contexts that must stay
   * alive (running AudioContexts, offline renders in progress) are in `strong`.
   */
  readonly cores = new Map<number, WeakRef<Core>>();
  /** Contexts that must stay alive while running (an unclosed AudioContext is never collected). */
  readonly strong = new Set<object>();
  readonly decodes = new Map<number, DecodeRequest>();
  nextRequest = 1;
  #push = false;
  #installed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerRefed = false;

  constructor(env: Env) {
    this.env = env;
  }

  ensureInstalled(): void {
    if (this.#installed) return;
    this.#installed = true;
    this.#push = this.env.natives.setEventHandler((ev) => this.dispatch(ev));
  }

  get pushMode(): boolean {
    return this.#push;
  }

  register(core: Core): void {
    this.ensureInstalled();
    this.cores.set(core.id, new WeakRef(core));
  }

  core(id: number): Core | undefined {
    return this.cores.get(id)?.deref();
  }

  /**
   * Frees a context's native side once it can never render again (closed, offline render done,
   * or collected). JS objects may outlive it: the core is dead, so nothing reaches the native
   * context any more (graph changes are dropped, analyser reads leave their arrays alone).
   */
  releaseCore(core: Core): void {
    core.dead = true;
    core.playing.clear();
    core.pendingFrees = 0;
    if (this.cores.get(core.id)?.deref() === core) this.cores.delete(core.id);
    if (core.released) return;
    core.released = true;
    try {
      this.env.natives.releaseContext(core.id);
    } catch {
      // already gone
    }
  }

  #liveCores(): Core[] {
    const out: Core[] = [];
    for (const [id, ref] of this.cores) {
      const c = ref.deref();
      if (c) out.push(c);
      else this.cores.delete(id);
    }
    return out;
  }

  /** Called whenever something starts waiting for an event. */
  kick(): void {
    if (this.#push) return;
    if (this.#timer !== null) {
      // A timer scheduled while nothing promise-backed was waiting is unref'd: a promise wait that
      // starts now must keep the host loop alive until it settles.
      if (!this.#timerRefed && this.#promiseWaiting()) {
        (this.#timer as { ref?: () => void }).ref?.();
        this.#timerRefed = true;
      }
      return;
    }
    this.#schedule(4);
  }

  #schedule(ms: number): void {
    const t = setTimeout(() => this.#tick(), ms);
    // Waiting only for ended events / node frees must not keep a host event loop alive by itself
    // (Node); promise-backed waits (decode, state change, offline render) do.
    this.#timerRefed = this.#promiseWaiting();
    if (!this.#timerRefed) (t as { unref?: () => void }).unref?.();
    this.#timer = t;
  }

  #tick(): void {
    this.#timer = null;
    this.poll();
    if (this.#waiting()) this.#schedule(8);
  }

  #promiseWaiting(): boolean {
    if (this.decodes.size > 0) return true;
    for (const c of this.#liveCores()) if (c.pendingState > 0 || c.rendering) return true;
    return false;
  }

  #waiting(): boolean {
    if (this.#promiseWaiting()) return true;
    for (const c of this.#liveCores()) if (c.waiting()) return true;
    return false;
  }

  poll(): void {
    const ev = this.env.natives.poll();
    if (ev) this.dispatch(ev);
  }

  dispatch(ev: Array<number | string | null>): void {
    for (let i = 0; i + 4 < ev.length; i += 5) {
      const type = ev[i] as number;
      const ctx = ev[i + 1] as number;
      const a = ev[i + 2] as number;
      const b = ev[i + 3] as number;
      const msg = ev[i + 4] as string | null;
      try {
        this.#route(type, ctx, a, b, msg);
      } catch (e) {
        reportError(e);
      }
    }
  }

  #route(type: number, ctx: number, a: number, b: number, msg: string | null): void {
    if (type === EventType.DecodeDone || type === EventType.DecodeError) {
      const req = this.decodes.get(a);
      if (!req) {
        if (type === EventType.DecodeDone) this.env.natives.releaseBuffer(b);
        return;
      }
      this.decodes.delete(a);
      if (type === EventType.DecodeDone) req.resolve(b);
      else req.reject(msg ?? 'decode failed');
      return;
    }
    const core = this.core(ctx);
    if (!core) {
      if (type === EventType.RenderDone) this.env.natives.releaseBuffer(a);
      return;
    }
    switch (type) {
      case EventType.Ended: {
        const src = core.playing.get(a);
        if (src) {
          core.playing.delete(a);
          src.dispatchEnded();
        }
        break;
      }
      case EventType.NodeFreed:
        core.freed(a);
        break;
      case EventType.State:
        core.owner?.onState(a, b);
        break;
      case EventType.RenderDone:
        core.rendering = false;
        core.owner?.onRenderDone(a);
        break;
    }
  }
}
