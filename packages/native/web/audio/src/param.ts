/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Core } from './core.ts';
import { MAX_CURVE_VALUES, Op, ParamKind } from './protocol.ts';
import { domError, finite } from './util.ts';

export const INTERNAL = Symbol('iwn.audio.internal');

export interface ParamSpec {
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'a-rate' | 'k-rate';
  /** The spec fixes the rate of AudioBufferSourceNode's playbackRate and detune. */
  fixedRate?: boolean;
}

export const FLT_MAX = 3.4028234663852886e38;
export const MOST_POSITIVE = FLT_MAX;

/**
 * AudioParam (AUD-5). Validation and exceptions happen here, synchronously; the automation itself
 * is computed by the render thread from the events this object sends. `value` reads the value the
 * render thread computed for the most recent quantum (shared memory), or the value just assigned
 * while that assignment is still in flight.
 */
export class AudioParam {
  #core: Core;
  #slot: number;
  /**
   * The AudioNode (or AudioListener) this param belongs to. Holding it keeps the node alive while
   * the app keeps the param: otherwise the node could be collected and its slot recycled, and
   * this param would then drive whichever node reuses the slot.
   */
  #owner: object;
  #spec: ParamSpec;
  #rate: 'a-rate' | 'k-rate';
  #lastSet: number;
  #pendingSeq: number;
  #setFrame = -1;
  #times: number[] = [];
  #curves: Array<[number, number]> = [];
  #pruneAt = 64;

  constructor(
    token: symbol,
    core: Core,
    slot: number,
    spec: ParamSpec,
    initial?: number,
    owner?: object,
  ) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#core = core;
    this.#slot = slot;
    this.#owner = owner ?? core;
    this.#spec = spec;
    this.#rate = spec.automationRate;
    const v = initial === undefined ? spec.defaultValue : initial;
    this.#lastSet = Math.min(spec.maxValue, Math.max(spec.minValue, v));
    // The slot may hold a previous node's value until the creating batch is applied.
    this.#pendingSeq = core.nextSeq;
    if (initial !== undefined && initial !== spec.defaultValue) {
      this.#send(ParamKind.SetValue, 0, initial, 0);
      this.#setFrame = core.frame;
    }
  }

  /** @internal */
  static slotOf(p: AudioParam): number {
    return p.#slot;
  }
  /** @internal */
  static coreOf(p: AudioParam): Core {
    return p.#core;
  }
  /** @internal */
  static ownerOf(p: AudioParam): object {
    return p.#owner;
  }

  get defaultValue(): number {
    return this.#spec.defaultValue;
  }
  get minValue(): number {
    return this.#spec.minValue;
  }
  get maxValue(): number {
    return this.#spec.maxValue;
  }

  get automationRate(): 'a-rate' | 'k-rate' {
    return this.#rate;
  }
  set automationRate(v: 'a-rate' | 'k-rate') {
    if (v !== 'a-rate' && v !== 'k-rate') return;
    if (this.#spec.fixedRate && v !== this.#spec.automationRate) {
      throw domError(
        'InvalidStateError',
        'this AudioParam has a fixed automation rate',
      );
    }
    if (v === this.#rate) return;
    this.#rate = v;
    this.#core.cmd(Op.ParamRate, this.#slot, v === 'a-rate' ? 1 : 0);
  }

  get value(): number {
    const core = this.#core;
    // The assigned value until a render quantum has computed it: while the batch is in flight,
    // and while no quantum has rendered since (a suspended or paused context keeps currentTime,
    // and the shared slot, where they are).
    if (this.#pendingSeq > core.appliedSeq || core.frame === this.#setFrame)
      return this.#lastSet;
    return core.params[this.#slot];
  }
  set value(v: number) {
    const x = finite(v, 'AudioParam.value');
    this.#lastSet = Math.min(
      this.#spec.maxValue,
      Math.max(this.#spec.minValue, x),
    );
    this.#pendingSeq = this.#core.nextSeq;
    this.#insert(ParamKind.SetValue, this.#core.currentTime, x, 0);
    this.#setFrame = this.#core.frame;
  }

  setValueAtTime(value: number, startTime: number): AudioParam {
    const v = finite(value, 'value');
    const t = this.#time(startTime, 'startTime');
    this.#insert(ParamKind.SetValue, t, v, 0);
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): AudioParam {
    const v = finite(value, 'value');
    const t = this.#time(endTime, 'endTime');
    this.#insert(ParamKind.LinearRamp, t, v, 0);
    return this;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): AudioParam {
    const v = finite(value, 'value');
    if (v === 0)
      throw new RangeError('exponentialRampToValueAtTime: value must not be 0');
    const t = this.#time(endTime, 'endTime');
    this.#insert(ParamKind.ExpRamp, t, v, 0);
    return this;
  }

  setTargetAtTime(
    target: number,
    startTime: number,
    timeConstant: number,
  ): AudioParam {
    const v = finite(target, 'target');
    const t = this.#time(startTime, 'startTime');
    const tc = finite(timeConstant, 'timeConstant');
    if (tc < 0)
      throw new RangeError('setTargetAtTime: timeConstant must be >= 0');
    this.#insert(ParamKind.SetTarget, t, v, tc);
    return this;
  }

  setValueCurveAtTime(
    values: ArrayLike<number> | Iterable<number>,
    startTime: number,
    duration: number,
  ): AudioParam {
    const list = Array.from(values as ArrayLike<number>, (x) =>
      finite(x, 'values'),
    );
    const t = this.#time(startTime, 'startTime');
    const d = finite(duration, 'duration');
    if (d <= 0)
      throw new RangeError('setValueCurveAtTime: duration must be > 0');
    if (list.length < 2)
      throw domError(
        'InvalidStateError',
        'setValueCurveAtTime: needs at least 2 values',
      );
    if (list.length > MAX_CURVE_VALUES) {
      throw domError(
        'NotSupportedError',
        `setValueCurveAtTime: more than ${MAX_CURVE_VALUES} values are not supported by this runtime`,
      );
    }
    const end = t + d;
    // Spec: events strictly inside (T, T + D) conflict; one exactly at T is allowed.
    for (const x of this.#times) {
      if (x > t && x < end)
        throw domError(
          'NotSupportedError',
          'setValueCurveAtTime overlaps another automation event',
        );
    }
    for (const [s, e] of this.#curves) {
      if (t < e && end > s)
        throw domError(
          'NotSupportedError',
          'setValueCurveAtTime overlaps another curve',
        );
    }
    this.#curves.push([t, end]);
    this.#setFrame = -1;
    this.#core.cmdWithValues(
      [
        Op.ParamEvent,
        this.#slot,
        ParamKind.SetCurve,
        t,
        0,
        d,
        this.#core.currentTime,
        list.length,
      ],
      list,
    );
    return this;
  }

  cancelScheduledValues(cancelTime: number): AudioParam {
    const t = this.#time(cancelTime, 'cancelTime');
    this.#times = this.#times.filter((x) => x < t);
    this.#curves = this.#curves.filter(([s, e]) => s < t && e <= t);
    this.#setFrame = -1;
    this.#core.cmd(Op.ParamCancel, this.#slot, t, 0);
    return this;
  }

  cancelAndHoldAtTime(cancelTime: number): AudioParam {
    const t = this.#time(cancelTime, 'cancelTime');
    this.#times = this.#times.filter((x) => x <= t);
    this.#curves = this.#curves
      .filter(([s]) => s <= t)
      .map(([s, e]): [number, number] => [s, Math.min(e, t)]);
    this.#setFrame = -1;
    this.#core.cmd(Op.ParamCancel, this.#slot, t, 1);
    return this;
  }

  #time(v: number, what: string): number {
    const t = finite(v, what);
    if (t < 0) throw new RangeError(`${what} must be >= 0`);
    return Math.max(t, this.#core.currentTime);
  }

  #insert(kind: number, t: number, v: number, extra: number): void {
    const curves = this.#curves;
    for (let k = 0; k < curves.length; k++) {
      // Spec: no event may fall in [T, T + D) of a curve.
      if (t >= curves[k][0] && t < curves[k][1]) {
        throw domError(
          'NotSupportedError',
          'automation event overlaps a setValueCurveAtTime curve',
        );
      }
    }
    this.#setFrame = -1;
    const times = this.#times;
    if (times.length === 0 || times[times.length - 1] !== t) {
      times.push(t);
      if (times.length > this.#pruneAt) {
        // Amortised, in place (no allocation in the per-frame path): past event times cannot
        // overlap a future curve.
        const now = this.#core.currentTime;
        let w = 0;
        for (let r = 0; r < times.length; r++)
          if (times[r] >= now) times[w++] = times[r];
        times.length = w;
        if (curves.length > 0)
          this.#curves = curves.filter(([, e]) => e >= now);
        this.#pruneAt = Math.max(64, w * 2);
      }
    }
    this.#send(kind, t, v, extra);
  }

  #send(kind: number, t: number, v: number, extra: number): void {
    // Written in place (no call taking doubles: those would be boxed on every automation call).
    const core = this.#core;
    if (core.dead) return;
    const w = core.words(8);
    const k = core.count;
    w[k] = Op.ParamEvent;
    w[k + 1] = this.#slot;
    w[k + 2] = kind;
    w[k + 3] = t;
    w[k + 4] = v;
    w[k + 5] = extra;
    w[k + 6] = core.currentTime;
    w[k + 7] = 0;
    core.count = k + 8;
  }
}
