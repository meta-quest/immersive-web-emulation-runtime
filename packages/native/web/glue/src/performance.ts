/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `performance` (W3C High Resolution Time 3 + User Timing 3), TMR-4: now() and timeOrigin from the
// native JS clock, mark/measure/getEntries*/clear*. No observers, no resource/navigation timing.

import { domException } from './dom-exception.ts';
import { EventTarget } from './events.ts';
import type { GlueNatives } from './natives.ts';
import { enumerable, illegalConstructor, INTERNAL, setLength, tag } from './util.ts';

export interface Clock {
  now(): number;
  timeOrigin: number;
}

/**
 * The JS clock. With the native hook, `now()` is the native monotonic clock (shared with timers and
 * rAF). Without it (plain V8 contexts) it is Date.now() made non-decreasing, which is coarse (1 ms)
 * and only good enough for tests.
 */
export function createClock(native: GlueNatives['clock'] | undefined): Clock {
  if (native) {
    return { now: () => native.now(), timeOrigin: native.timeOrigin() };
  }
  const origin = Date.now();
  let last = 0;
  return {
    now() {
      const t = Date.now() - origin;
      if (t > last) last = t;
      return last;
    },
    timeOrigin: origin,
  };
}

let cloneDetail: (v: unknown) => unknown = (v) => v;
export function setDetailCloner(fn: (v: unknown) => unknown): void {
  cloneDetail = fn;
}

/** PerformanceMeasureOptions.duration is a DOMHighResTimeStamp (WebIDL `double`): a string is a number, not a mark name. */
function toDuration(v: unknown): number {
  if (typeof v === 'symbol' || typeof v === 'bigint') {
    throw new TypeError("Failed to execute 'measure' on 'Performance': Cannot convert a " + typeof v + ' value to a number');
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new TypeError("Failed to execute 'measure' on 'Performance': Failed to read the 'duration' property from 'PerformanceMeasureOptions': The provided double value is non-finite.");
  }
  return n;
}

let entryInit!: (e: PerformanceEntry, name: string, type: string, start: number, duration: number) => void;

export class PerformanceEntry {
  #name = '';
  #entryType = '';
  #startTime = 0;
  #duration = 0;
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw illegalConstructor();
  }
  static {
    entryInit = (e, name, type, start, duration) => {
      e.#name = name;
      e.#entryType = type;
      e.#startTime = start;
      e.#duration = duration;
    };
  }
  get name(): string {
    return this.#name;
  }
  get entryType(): string {
    return this.#entryType;
  }
  get startTime(): number {
    return this.#startTime;
  }
  get duration(): number {
    return this.#duration;
  }
  toJSON(): Record<string, unknown> {
    return {
      name: this.#name,
      entryType: this.#entryType,
      startTime: this.#startTime,
      duration: this.#duration,
    };
  }
}
tag(PerformanceEntry, 'PerformanceEntry');
enumerable(PerformanceEntry, ['name', 'entryType', 'startTime', 'duration', 'toJSON']);

let currentClock: Clock = createClock(undefined);

export interface PerformanceMarkOptions {
  detail?: unknown;
  startTime?: number;
}

export class PerformanceMark extends PerformanceEntry {
  #detail: unknown;
  constructor(markName: string, markOptions?: PerformanceMarkOptions | null) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to construct 'PerformanceMark': 1 argument required, but only 0 present.",
      );
    }
    super(INTERNAL);
    let start: number;
    if (markOptions?.startTime !== undefined) {
      start = Number(markOptions.startTime);
      if (!Number.isFinite(start)) {
        throw new TypeError("Failed to construct 'PerformanceMark': The provided double value is non-finite.");
      }
      if (start < 0) {
        throw new TypeError("Failed to construct 'PerformanceMark': 'startTime' cannot be negative.");
      }
    } else {
      start = currentClock.now();
    }
    this.#detail = markOptions?.detail === undefined ? null : cloneDetail(markOptions.detail);
    entryInit(this, String(markName), 'mark', start, 0);
  }
  get detail(): unknown {
    return this.#detail;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), detail: this.#detail };
  }
}
tag(PerformanceMark, 'PerformanceMark');
setLength(PerformanceMark, 1);
enumerable(PerformanceMark, ['detail']);

let measureDetail!: (m: PerformanceMeasure, d: unknown) => void;
export class PerformanceMeasure extends PerformanceEntry {
  #detail: unknown = null;
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw illegalConstructor();
    super(INTERNAL);
  }
  static {
    measureDetail = (m, d) => {
      m.#detail = d;
    };
  }
  get detail(): unknown {
    return this.#detail;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), detail: this.#detail };
  }
}
tag(PerformanceMeasure, 'PerformanceMeasure');
enumerable(PerformanceMeasure, ['detail']);

interface MeasureOptions {
  detail?: unknown;
  start?: string | number;
  duration?: number;
  end?: string | number;
}

export class Performance extends EventTarget {
  #clock: Clock;
  #entries: PerformanceEntry[] = [];

  constructor(token?: unknown, clock?: Clock) {
    if (token !== INTERNAL) throw illegalConstructor();
    super();
    this.#clock = clock!;
    currentClock = clock!;
  }

  now(): number {
    return this.#clock.now();
  }
  get timeOrigin(): number {
    return this.#clock.timeOrigin;
  }
  toJSON(): Record<string, unknown> {
    return { timeOrigin: this.#clock.timeOrigin };
  }

  mark(markName: string, markOptions?: PerformanceMarkOptions | null): PerformanceMark {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'mark' on 'Performance': 1 argument required, but only 0 present.",
      );
    }
    const m = new PerformanceMark(markName, markOptions);
    this.#entries.push(m);
    return m;
  }

  measure(
    measureName: string,
    startOrMeasureOptions?: string | MeasureOptions | null,
    endMark?: string,
  ): PerformanceMeasure {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'measure' on 'Performance': 1 argument required, but only 0 present.",
      );
    }
    const opts =
      startOrMeasureOptions !== null &&
      typeof startOrMeasureOptions === 'object'
        ? (startOrMeasureOptions as MeasureOptions)
        : null;
    const nonEmpty =
      opts !== null &&
      (opts.start !== undefined ||
        opts.end !== undefined ||
        opts.duration !== undefined ||
        opts.detail !== undefined);
    if (nonEmpty) {
      if (endMark !== undefined) {
        throw new TypeError(
          "Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, |end_mark| must not be passed.",
        );
      }
      if (opts!.start === undefined && opts!.end === undefined) {
        throw new TypeError(
          "Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, at least one of its 'start' or 'end' properties must be present.",
        );
      }
      if (opts!.start !== undefined && opts!.duration !== undefined && opts!.end !== undefined) {
        throw new TypeError(
          "Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, it must not have all of its 'start', 'duration', and 'end' properties defined",
        );
      }
    }
    let end: number;
    if (endMark !== undefined) end = this.#toTimestamp(endMark);
    else if (nonEmpty && opts!.end !== undefined) end = this.#toTimestamp(opts!.end);
    else if (nonEmpty && opts!.start !== undefined && opts!.duration !== undefined) {
      end = this.#toTimestamp(opts!.start) + this.#toTimestamp(toDuration(opts!.duration));
    } else end = this.#clock.now();
    let start: number;
    if (nonEmpty && opts!.start !== undefined) start = this.#toTimestamp(opts!.start);
    else if (nonEmpty && opts!.duration !== undefined && opts!.end !== undefined) {
      start = end - this.#toTimestamp(toDuration(opts!.duration));
    } else if (typeof startOrMeasureOptions === 'string' || (startOrMeasureOptions != null && opts === null)) {
      start = this.#toTimestamp(String(startOrMeasureOptions));
    } else start = 0;
    const m = new PerformanceMeasure(INTERNAL);
    entryInit(m, String(measureName), 'measure', start, end - start);
    measureDetail(m, nonEmpty && opts!.detail !== undefined ? cloneDetail(opts!.detail) : null);
    this.#entries.push(m);
    return m;
  }

  #toTimestamp(mark: string | number): number {
    if (typeof mark === 'number') {
      if (mark < 0) {
        throw new TypeError("Failed to execute 'measure' on 'Performance': A negative time stamp is not allowed.");
      }
      return mark;
    }
    const name = String(mark);
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const e = this.#entries[i]!;
      if (e.entryType === 'mark' && e.name === name) return e.startTime;
    }
    throw domException(
      `Failed to execute 'measure' on 'Performance': The mark '${name}' does not exist.`,
      'SyntaxError',
    );
  }

  getEntries(): PerformanceEntry[] {
    return sortByStart(this.#entries.slice());
  }
  getEntriesByType(type: string): PerformanceEntry[] {
    const t = String(type);
    return sortByStart(this.#entries.filter((e) => e.entryType === t));
  }
  getEntriesByName(name: string, type?: string): PerformanceEntry[] {
    const n = String(name);
    const t = type === undefined ? undefined : String(type);
    return sortByStart(
      this.#entries.filter((e) => e.name === n && (t === undefined || e.entryType === t)),
    );
  }
  clearMarks(markName?: string): void {
    this.#clear('mark', markName);
  }
  clearMeasures(measureName?: string): void {
    this.#clear('measure', measureName);
  }
  clearResourceTimings(): void {}
  setResourceTimingBufferSize(): void {}

  #clear(type: string, name?: string): void {
    const n = name === undefined ? undefined : String(name);
    this.#entries = this.#entries.filter(
      (e) => e.entryType !== type || (n !== undefined && e.name !== n),
    );
  }
}
tag(Performance, 'Performance');
enumerable(Performance, [
  'now',
  'timeOrigin',
  'toJSON',
  'mark',
  'measure',
  'getEntries',
  'getEntriesByType',
  'getEntriesByName',
  'clearMarks',
  'clearMeasures',
  'clearResourceTimings',
  'setResourceTimingBufferSize',
]);

function sortByStart(list: PerformanceEntry[]): PerformanceEntry[] {
  // Array.prototype.sort is stable, so equal start times keep insertion order.
  return list.sort((a, b) => a.startTime - b.startTime);
}

export function createPerformance(clock: Clock): Performance {
  return new Performance(INTERNAL, clock);
}
