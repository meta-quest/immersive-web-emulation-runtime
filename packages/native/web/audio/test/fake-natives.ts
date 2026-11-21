/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A scriptable stand-in for the native audio module: records every control batch, lets tests
// advance time, apply batches, and inject events. No audio is rendered.

import type { AudioNatives, AudioStats } from '../src/natives.ts';
import { EventType, Op, PROTOCOL_VERSION, Shared } from '../src/protocol.ts';

export interface FakeContext {
  id: number;
  kind: 0 | 1;
  sampleRate: number;
  shared: Float64Array;
  params: Float32Array;
  batches: number[][];
  released: boolean;
}

export class FakeNatives implements AudioNatives {
  readonly protocolVersion = PROTOCOL_VERSION;
  contexts = new Map<number, FakeContext>();
  buffers = new Map<number, { channels: Float32Array[]; sampleRate: number }>();
  events: Array<number | string | null> = [];
  decodes: Array<{ ctx: number; data: ArrayBuffer; requestId: number; targetRate: number; bytes: Uint8Array }> = [];
  handler: ((ev: Array<number | string | null>) => void) | null = null;
  push = false;
  submits = 0;
  #nextCtx = 1;
  #nextBuf = 1;

  createContext(kind: 0 | 1, sampleRate: number, _channels: number, _length: number, _hint: number): [number, number, Float64Array, Float32Array] {
    const id = this.#nextCtx++;
    const rate = sampleRate || 48000;
    const c: FakeContext = {
      id, kind, sampleRate: rate, shared: new Float64Array(16), params: new Float32Array(65536), batches: [], released: false,
    };
    this.contexts.set(id, c);
    if (kind === 0) {
      c.shared[Shared.State] = 1;
      this.events.push(EventType.State, id, 1, 0, null);
    }
    return [id, rate, c.shared, c.params];
  }
  releaseContext(id: number): void {
    const c = this.contexts.get(id);
    if (c) c.released = true;
  }
  submit(ctx: number, words: Float64Array, count: number): number {
    const c = this.contexts.get(ctx);
    if (!c) throw new Error('unknown context');
    c.batches.push(Array.from(words.subarray(0, count)));
    this.submits++;
    return c.batches.length;
  }
  startRendering(_ctx: number): boolean {
    return true;
  }
  createBuffer(channels: number, length: number, sampleRate: number): [number, ...Float32Array[]] {
    const id = this.#nextBuf++;
    const chans = Array.from({ length: channels }, () => new Float32Array(length));
    this.buffers.set(id, { channels: chans, sampleRate });
    return [id, ...chans];
  }
  takeBuffer(id: number): [number, number, number, number, ...Float32Array[]] | null {
    const b = this.buffers.get(id);
    if (!b) return null;
    return [id, b.channels.length, b.channels[0].length, b.sampleRate, ...b.channels];
  }
  releaseBuffer(id: number): void {
    this.buffers.delete(id);
  }
  decode(ctx: number, data: ArrayBuffer, requestId: number, targetRate: number): void {
    const bytes = new Uint8Array(data.slice(0));
    // Detach like the real module.
    (data as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
    this.decodes.push({ ctx, data, requestId, targetRate, bytes });
  }
  poll(): Array<number | string | null> | undefined {
    if (this.events.length === 0) return undefined;
    const e = this.events;
    this.events = [];
    return e;
  }
  setEventHandler(fn: ((events: Array<number | string | null>) => void) | null): boolean {
    this.handler = fn;
    return this.push;
  }
  pendingWork(): boolean {
    return this.events.length > 0;
  }
  analyserTime(): void {}
  analyserFreq(): void {}
  biquadResponse(_t: number, _sr: number, _f: number, _d: number, _q: number, _g: number, freqs: Float32Array, mag: Float32Array, phase: Float32Array): void {
    mag.fill(1);
    phase.fill(0);
    void freqs;
  }
  outputTimestamp(): [number, number] | null {
    return null;
  }
  nowMs(): number {
    return performance.now() + 1000;
  }
  stats(): AudioStats {
    return { realtimeContexts: 0, offlineContexts: 0, xruns: 0, renderLoad: 0, liveNodes: 0, liveBuffers: this.buffers.size, pendingDecodes: 0, pausedReasons: 0 };
  }
  setOutputPaused(_reason: number, _paused: boolean): void {}

  // ---- test helpers ----
  ctx(id = 1): FakeContext {
    const c = this.contexts.get(id);
    if (!c) throw new Error(`no context ${id}`);
    return c;
  }
  /** Marks every submitted batch as applied and advances time by `frames`. */
  render(id: number, frames: number): void {
    const c = this.ctx(id);
    c.shared[Shared.AppliedSeq] = c.batches.length;
    c.shared[Shared.Frame] += frames;
    for (const b of c.batches) this.#ackStates(c, b);
  }
  #acked = new WeakSet<number[]>();
  #ackStates(c: FakeContext, words: number[]): void {
    if (this.#acked.has(words)) return;
    this.#acked.add(words);
    for (const cmd of commands(words)) {
      if (cmd[0] === Op.ContextState) {
        const desired = cmd[1];
        const state = desired === 2 ? 2 : desired;
        c.shared[Shared.State] = state;
        this.events.push(EventType.State, c.id, state, cmd[2], null);
      }
    }
  }
  emit(...ev: Array<number | string | null>): void {
    this.events.push(...ev);
    if (this.push && this.handler) this.handler(this.poll()!);
  }
  allCommands(id = 1): number[][] {
    return this.ctx(id).batches.flatMap((b) => commands(b));
  }
}

const ARGS: Record<number, number> = {
  [Op.CreateNode]: 10, [Op.Connect]: 4, [Op.ConnectParam]: 3, [Op.Disconnect]: 4, [Op.DisconnectParam]: 3,
  [Op.ReleaseNode]: 1, [Op.ParamEvent]: 7, [Op.ParamCancel]: 3, [Op.SetProp]: 3, [Op.SetBuffer]: 2,
  [Op.Start]: 4, [Op.Stop]: 2, [Op.PeriodicWave]: 3, [Op.ContextState]: 2, [Op.ParamRate]: 2,
};

/** Splits a word stream into commands. */
export function commands(words: number[]): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i < words.length) {
    const op = words[i];
    const argc = ARGS[op];
    if (argc === undefined) throw new Error(`bad op ${op} at ${i}`);
    let extra = 0;
    if (op === Op.ParamEvent) extra = words[i + 7];
    if (op === Op.PeriodicWave) extra = 2 * words[i + 3];
    out.push(words.slice(i, i + 1 + argc + extra));
    i += 1 + argc + extra;
  }
  return out;
}

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
export const microtask = (): Promise<void> => Promise.resolve();
