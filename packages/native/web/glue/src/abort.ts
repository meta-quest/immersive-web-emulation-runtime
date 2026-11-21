/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// AbortController / AbortSignal (DOM Living Standard §3.1-3.2), including `timeout()` and `any()`
// (DOM-10). Other glue code (fetch, FileReader) subscribes with `addAbortAlgorithm`.

import { type DOMException, domException } from './dom-exception.ts';
import {
  defineEventHandler,
  dispatchTrusted,
  Event,
  EventTarget,
  hasListeners,
  NOOP_PROBE,
  reportException,
  setListenerObserver,
  setSignalWatcher,
} from './events.ts';
import { enumerable, illegalConstructor, INTERNAL, tag } from './util.ts';

type SignalState = {
  aborted: boolean;
  reason: unknown;
  algorithms: Set<() => void>;
  /**
   * For `any()`: every dependent signal, held weakly so a long-lived source does not keep a dependent
   * nobody listens to alive. `held` keeps the dependents that have abort listeners or abort algorithms
   * strongly reachable, as the DOM Standard requires ("an AbortSignal object must not be garbage
   * collected while its source signals is non-empty and it has registered event listeners for its
   * abort event or its abort algorithms is non-empty").
   */
  dependents: Set<WeakRef<AbortSignal>>;
  held: Set<AbortSignal>;
  pruneAt: number;
  dependent: boolean;
  sources: AbortSignal[];
  /** This signal's own WeakRef in its sources' `dependents`. */
  ref: WeakRef<AbortSignal> | null;
};

const states = new WeakMap<AbortSignal, SignalState>();
const MAX_TIMER_DELAY = 0x7fffffff;

function stateOf(signal: AbortSignal): SignalState {
  const s = states.get(signal);
  if (!s) throw new TypeError('Illegal invocation');
  return s;
}

function defaultReason(): DOMException {
  return domException('signal is aborted without reason', 'AbortError');
}

/** Holds a dependent signal from its sources while it has abort listeners or algorithms. */
function updateHold(signal: AbortSignal): void {
  const s = states.get(signal);
  if (!s || !s.dependent || s.aborted) return;
  const want = s.algorithms.size > 0 || hasListeners(signal, 'abort');
  for (const src of s.sources) {
    const ss = stateOf(src);
    if (want) ss.held.add(signal);
    else ss.held.delete(signal);
  }
}

/** Removes a dependent from its sources (it aborted, so it no longer needs them). */
function detachFromSources(signal: AbortSignal): void {
  const s = stateOf(signal);
  for (const src of s.sources) {
    const ss = stateOf(src);
    if (s.ref) ss.dependents.delete(s.ref);
    ss.held.delete(signal);
  }
  s.sources = [];
}

export class AbortSignal extends EventTarget {
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw illegalConstructor();
    super();
    states.set(this, {
      aborted: false,
      reason: undefined,
      algorithms: new Set(),
      dependents: new Set(),
      held: new Set(),
      pruneAt: 64,
      dependent: false,
      sources: [],
      ref: null,
    });
  }

  get aborted(): boolean {
    return stateOf(this).aborted;
  }
  get reason(): unknown {
    return stateOf(this).reason;
  }
  throwIfAborted(): void {
    const s = stateOf(this);
    if (s.aborted) throw s.reason;
  }

  static abort(reason?: unknown): AbortSignal {
    const signal = new AbortSignal(INTERNAL);
    const s = stateOf(signal);
    s.aborted = true;
    s.reason = reason === undefined ? defaultReason() : reason;
    return signal;
  }

  static timeout(milliseconds: number): AbortSignal {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'timeout' on 'AbortSignal': 1 argument required, but only 0 present.");
    }
    // WebIDL [EnforceRange] unsigned long long: ToNumber, reject non-finite, truncate, then range-check.
    const n = Number(milliseconds);
    const ms = Number.isFinite(n) ? Math.trunc(n) : NaN;
    if (!(ms >= 0 && ms <= Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(
        "Failed to execute 'timeout' on 'AbortSignal': Value is outside the 'unsigned long long' value range.",
      );
    }
    const signal = new AbortSignal(INTERNAL);
    const setTimer = (globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown })
      .setTimeout;
    if (typeof setTimer !== 'function') {
      throw domException('AbortSignal.timeout needs timers', 'NotSupportedError');
    }
    // Timer delays are WebIDL `long` (the core's setTimeout wraps them to int32, so 2^31 ms would fire
    // at once); wait in chunks of at most 2^31 - 1 ms.
    const wait = (remaining: number): void => {
      const step = Math.min(remaining, MAX_TIMER_DELAY);
      setTimer(() => {
        if (remaining > step) wait(remaining - step);
        else signalAbort(signal, domException('signal timed out', 'TimeoutError'));
      }, step);
    };
    wait(ms);
    return signal;
  }

  static any(signals: Iterable<AbortSignal>): AbortSignal {
    // WebIDL sequence<AbortSignal>: an object with @@iterator (array-likes are rejected).
    if (
      signals === null ||
      (typeof signals !== 'object' && typeof signals !== 'function') ||
      typeof (signals as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError(
        "Failed to execute 'any' on 'AbortSignal': The provided value cannot be converted to a sequence.",
      );
    }
    const list = Array.from(signals);
    for (const s of list) {
      if (!(s instanceof AbortSignal)) {
        throw new TypeError(
          "Failed to execute 'any' on 'AbortSignal': Failed to convert value to 'AbortSignal'.",
        );
      }
    }
    const result = new AbortSignal(INTERNAL);
    const rs = stateOf(result);
    for (const s of list) {
      const ss = stateOf(s);
      if (ss.aborted) {
        rs.aborted = true;
        rs.reason = ss.reason;
        return result;
      }
    }
    rs.dependent = true;
    const ref = new WeakRef(result);
    rs.ref = ref;
    for (const s of list) {
      const ss = stateOf(s);
      const roots = ss.dependent ? ss.sources : [s];
      for (const root of roots) {
        if (rs.sources.includes(root)) continue;
        rs.sources.push(root);
        const rootState = stateOf(root);
        rootState.dependents.add(ref);
        if (rootState.dependents.size >= rootState.pruneAt) {
          // Drop entries for dependents that were collected, so a long-lived source does not grow.
          for (const r of rootState.dependents) if (r.deref() === undefined) rootState.dependents.delete(r);
          rootState.pruneAt = Math.max(64, rootState.dependents.size * 2);
        }
      }
    }
    return result;
  }
}
tag(AbortSignal, 'AbortSignal');
enumerable(AbortSignal, ['aborted', 'reason', 'throwIfAborted']);
defineEventHandler(AbortSignal.prototype, 'abort');

/** Runs `algorithm` once when `signal` aborts. Returns an unsubscribe function. */
export function addAbortAlgorithm(
  signal: AbortSignal,
  algorithm: () => void,
): () => void {
  const s = stateOf(signal);
  if (s.aborted) return () => {};
  s.algorithms.add(algorithm);
  updateHold(signal);
  return () => {
    s.algorithms.delete(algorithm);
    updateHold(signal);
  };
}

/** Diagnostics: how many dependent-signal entries `signal` holds (collected ones until pruned). */
export function dependentCount(signal: AbortSignal): number {
  return stateOf(signal).dependents.size;
}

/** DOM "signal abort". */
export function signalAbort(signal: AbortSignal, reason?: unknown): void {
  const s = stateOf(signal);
  if (s.aborted) return;
  s.aborted = true;
  s.reason = reason === undefined ? defaultReason() : reason;
  const toRun: AbortSignal[] = [];
  for (const ref of s.dependents) {
    const d = ref.deref();
    if (!d) continue;
    const ds = stateOf(d);
    if (!ds.aborted) {
      ds.aborted = true;
      ds.reason = s.reason;
      toRun.push(d);
    }
  }
  s.dependents.clear();
  s.held.clear();
  if (s.dependent) detachFromSources(signal);
  for (const d of toRun) detachFromSources(d);
  runAbortSteps(signal);
  for (const d of toRun) runAbortSteps(d);
}

function runAbortSteps(signal: AbortSignal): void {
  const s = stateOf(signal);
  const algorithms = Array.from(s.algorithms);
  s.algorithms.clear();
  // Abort algorithms come from other runtime code (fetch, FileReader, listeners' {signal}); one that
  // throws must not stop the others or the abort event.
  for (const a of algorithms) {
    try {
      a();
    } catch (e) {
      reportException(e);
    }
  }
  dispatchTrusted(signal, new Event('abort'));
}

export class AbortController {
  #signal: AbortSignal;
  constructor() {
    this.#signal = new AbortSignal(INTERNAL);
  }
  get signal(): AbortSignal {
    return this.#signal;
  }
  abort(reason?: unknown): void {
    signalAbort(this.#signal, reason);
  }
}
tag(AbortController, 'AbortController');
enumerable(AbortController, ['signal', 'abort']);

// Lets EventTarget.addEventListener honour `{ signal }` (DOM "add an event listener", step 2 and 6).
// With a real callback it subscribes and returns the unsubscribe function (events.ts calls it when the
// listener is removed, so a long-lived signal does not keep removed listeners alive).
setSignalWatcher((signal, onAbort) => {
  if (!(signal instanceof AbortSignal)) return false;
  const s = stateOf(signal);
  if (s.aborted) return 'aborted';
  if (onAbort === NOOP_PROBE) return true;
  return addAbortAlgorithm(signal, onAbort);
});

// Re-evaluates whether a dependent signal must be held when its abort listeners change.
setListenerObserver((target, type) => {
  if (type === 'abort' && target instanceof AbortSignal) updateHold(target);
});
