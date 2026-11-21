/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Event, CustomEvent, EventTarget and the event types the glue itself fires, written from the DOM Living
// Standard §2 ("Events": dispatch, inner invoke, flattening options) and HTML §8.1.8 (event handler
// attributes). Written here rather than taken from event-target-shim because DOM-2 needs capture and
// bubble along a parent chain: subclasses (the DOM stand-ins) implement [GET_THE_PARENT].

import { domException } from './dom-exception.ts';
import {
  enumerable,
  setLength,
  tag,
  toDOMString,
  toUnsignedLongLong,
  toUSVString,
} from './util.ts';

export { toDOMString };

/** DOM "get the parent": a subclass returns the next target on the event path, or null. */
export const GET_THE_PARENT: unique symbol = Symbol.for(
  'iwn.event.getTheParent',
) as never;

type Listener = {
  type: string;
  callback: EventListenerLike;
  capture: boolean;
  passive: boolean | null;
  once: boolean;
  removed: boolean;
  /** Drops the `{ signal }` abort algorithm (set while the listener is registered with a signal). */
  unsubscribe: (() => void) | null;
};

export type EventListenerLike =
  | ((this: unknown, event: Event) => unknown)
  | { handleEvent(event: Event): unknown };

export interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

export interface AddEventListenerOptions {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
  signal?: unknown;
}

let clockNow: () => number = () => 0;
/** Wired by the installer to `performance.now()` so `event.timeStamp` uses the JS clock. */
export function setEventClock(now: () => number): void {
  clockNow = now;
}

let reporter: (error: unknown) => void = (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
};
/** Wired by the installer: how listener exceptions are reported ("report the exception", HTML §8.1.4.6). */
export function setExceptionReporter(report: (error: unknown) => void): void {
  reporter = report;
}
export function reportException(error: unknown): void {
  try {
    reporter(error);
  } catch {
    // A failing reporter must not break dispatch.
  }
}

// Internal access to Event state, assigned in Event's static block.
let ev!: {
  setTrusted(e: Event, v: boolean): void;
  isDispatching(e: Event): boolean;
  isInitialized(e: Event): boolean;
  begin(e: Event, target: EventTarget, path: EventTarget[]): void;
  setPhase(e: Event, phase: number, current: EventTarget | null): void;
  stopped(e: Event): boolean;
  immediateStopped(e: Event): boolean;
  setInPassive(e: Event, v: boolean): void;
  end(e: Event): void;
  canceled(e: Event): boolean;
};

export class Event {
  // Defined below as non-writable, non-configurable constants (WebIDL), not as class fields.
  declare static readonly NONE: 0;
  declare static readonly CAPTURING_PHASE: 1;
  declare static readonly AT_TARGET: 2;
  declare static readonly BUBBLING_PHASE: 3;
  declare readonly NONE: 0;
  declare readonly CAPTURING_PHASE: 1;
  declare readonly AT_TARGET: 2;
  declare readonly BUBBLING_PHASE: 3;

  #type: string;
  #bubbles = false;
  #cancelable = false;
  #composed = false;
  #trusted = false;
  #timeStamp: number;
  #target: EventTarget | null = null;
  #currentTarget: EventTarget | null = null;
  #phase = 0;
  #canceled = false;
  #inPassive = false;
  #stop = false;
  #stopImmediate = false;
  #dispatching = false;
  #initialized = true;
  #path: EventTarget[] = [];

  constructor(type: string, init?: EventInit | null) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to construct 'Event': 1 argument required, but only 0 present.",
      );
    }
    this.#type = toDOMString(type, "Failed to construct 'Event'");
    if (init != null) {
      if (typeof init !== 'object' && typeof init !== 'function') {
        throw new TypeError(
          "Failed to construct 'Event': The provided value is not of type 'EventInit'.",
        );
      }
      this.#bubbles = !!init.bubbles;
      this.#cancelable = !!init.cancelable;
      this.#composed = !!init.composed;
    }
    this.#timeStamp = clockNow();
  }

  static {
    ev = {
      setTrusted: (e, v) => {
        e.#trusted = v;
      },
      isDispatching: (e) => e.#dispatching,
      isInitialized: (e) => e.#initialized,
      begin: (e, target, path) => {
        e.#dispatching = true;
        e.#target = target;
        e.#path = path;
      },
      setPhase: (e, phase, current) => {
        e.#phase = phase;
        e.#currentTarget = current;
      },
      stopped: (e) => e.#stop,
      immediateStopped: (e) => e.#stopImmediate,
      setInPassive: (e, v) => {
        e.#inPassive = v;
      },
      end: (e) => {
        e.#dispatching = false;
        e.#phase = 0;
        e.#currentTarget = null;
        e.#path = [];
        e.#stop = false;
        e.#stopImmediate = false;
      },
      canceled: (e) => e.#canceled,
    };
  }

  get type(): string {
    return this.#type;
  }
  get target(): EventTarget | null {
    return this.#target;
  }
  get srcElement(): EventTarget | null {
    return this.#target;
  }
  get currentTarget(): EventTarget | null {
    return this.#currentTarget;
  }
  composedPath(): EventTarget[] {
    return this.#dispatching ? this.#path.slice() : [];
  }
  get eventPhase(): number {
    return this.#phase;
  }
  stopPropagation(): void {
    this.#stop = true;
  }
  get cancelBubble(): boolean {
    return this.#stop;
  }
  set cancelBubble(v: boolean) {
    if (v) this.#stop = true;
  }
  stopImmediatePropagation(): void {
    this.#stop = true;
    this.#stopImmediate = true;
  }
  get bubbles(): boolean {
    return this.#bubbles;
  }
  get cancelable(): boolean {
    return this.#cancelable;
  }
  get returnValue(): boolean {
    return !this.#canceled;
  }
  set returnValue(v: boolean) {
    if (!v) this.preventDefault();
  }
  preventDefault(): void {
    if (this.#cancelable && !this.#inPassive) this.#canceled = true;
  }
  get defaultPrevented(): boolean {
    return this.#canceled;
  }
  get composed(): boolean {
    return this.#composed;
  }
  get isTrusted(): boolean {
    return this.#trusted;
  }
  get timeStamp(): number {
    return this.#timeStamp;
  }
  initEvent(type: string, bubbles = false, cancelable = false): void {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'initEvent' on 'Event': 1 argument required, but only 0 present.",
      );
    }
    const t = toDOMString(type, "Failed to execute 'initEvent' on 'Event'");
    if (this.#dispatching) return;
    this.#initialized = true;
    this.#stop = false;
    this.#stopImmediate = false;
    this.#canceled = false;
    this.#trusted = false;
    this.#target = null;
    this.#type = t;
    this.#bubbles = !!bubbles;
    this.#cancelable = !!cancelable;
  }
}
for (const [k, v] of [
  ['NONE', 0],
  ['CAPTURING_PHASE', 1],
  ['AT_TARGET', 2],
  ['BUBBLING_PHASE', 3],
] as const) {
  // WebIDL constants: { [[Writable]]: false, [[Enumerable]]: true, [[Configurable]]: false }.
  Object.defineProperty(Event.prototype, k, {
    value: v,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(Event, k, {
    value: v,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}
tag(Event, 'Event');
setLength(Event, 1);
enumerable(Event, [
  'type',
  'target',
  'srcElement',
  'currentTarget',
  'composedPath',
  'eventPhase',
  'stopPropagation',
  'cancelBubble',
  'stopImmediatePropagation',
  'bubbles',
  'cancelable',
  'returnValue',
  'preventDefault',
  'defaultPrevented',
  'composed',
  'isTrusted',
  'timeStamp',
  'initEvent',
]);

/** Marks an event the runtime creates as trusted (`isTrusted` true), as browsers do for UA-fired events. */
export function markTrusted<E extends Event>(event: E): E {
  ev.setTrusted(event, true);
  return event;
}

function isDictionary(options: unknown): options is Record<string, unknown> {
  return (
    options !== null &&
    (typeof options === 'object' || typeof options === 'function')
  );
}

/** DOM "flatten": a dictionary's `capture`, else the (boolean or AddEventListenerOptions) value ToBoolean. */
function flattenCapture(options: unknown): boolean {
  if (isDictionary(options)) return !!options.capture;
  return !!options;
}

// Abort hook: abort.ts registers how to watch an AbortSignal without an import cycle. Called with
// NOOP_PROBE it only answers false (not a signal), 'aborted' or true; with a callback it subscribes
// and returns the unsubscribe function.
type SignalWatcher = (
  signal: unknown,
  onAbort: () => void,
) => boolean | 'aborted' | (() => void);
let watchSignal: SignalWatcher | null = null;
export function setSignalWatcher(fn: SignalWatcher): void {
  watchSignal = fn;
}

// A `{ signal }` listener's abort algorithm holds its target and listener weakly (as Chromium and
// Node do): the signal must not keep a target alive. When the target is collected first, the registry
// drops the algorithm from the signal.
const signalCleanup = new FinalizationRegistry<() => void>((unsubscribe) =>
  unsubscribe(),
);

const listenersOf = new WeakMap<EventTarget, Listener[]>();

// Told when a target's listeners change (abort.ts keeps dependent AbortSignals alive while they have
// abort listeners).
let listenerObserver: ((target: EventTarget, type: string) => void) | null =
  null;
export function setListenerObserver(
  fn: (target: EventTarget, type: string) => void,
): void {
  listenerObserver = fn;
}

/** Whether `target` has a listener for `type`. */
export function hasListeners(target: EventTarget, type: string): boolean {
  const list = listenersOf.get(target);
  if (!list) return false;
  for (const l of list) if (l.type === type) return true;
  return false;
}

export class EventTarget {
  constructor() {
    listenersOf.set(this, []);
  }

  addEventListener(
    type: string,
    callback: EventListenerLike | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (arguments.length < 2) {
      throw new TypeError(
        `Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    // WebIDL converts every argument (type, callback, options) before the null-callback early return.
    type = toDOMString(
      type,
      "Failed to execute 'addEventListener' on 'EventTarget'",
    );
    if (
      callback != null &&
      typeof callback !== 'function' &&
      typeof callback !== 'object'
    ) {
      throw new TypeError(
        "Failed to execute 'addEventListener' on 'EventTarget': parameter 2 is not of type 'Object'.",
      );
    }
    // Operations on the global object accept an undefined `this` (WebIDL "[Global]" interfaces), so
    // a bare `addEventListener(...)` works as in browsers.
    const self = (this ?? globalThis) as EventTarget;
    const list = listenersFor(self);
    const capture = flattenCapture(options);
    let once = false;
    let passive: boolean | null = null;
    let signal: unknown;
    if (isDictionary(options)) {
      once = !!options.once;
      if ('passive' in options && options.passive !== undefined) {
        passive = !!options.passive;
      }
      signal = options.signal;
      if (signal !== undefined && watchSignal && !isSignal(signal)) {
        throw new TypeError(
          "Failed to execute 'addEventListener' on 'EventTarget': member signal is not of type AbortSignal.",
        );
      }
    }
    if (callback == null) return;
    if (signal !== undefined && watchSignal && signalAborted(signal)) return;
    for (const l of list) {
      if (l.type === type && l.callback === callback && l.capture === capture) {
        return;
      }
    }
    const listener: Listener = {
      type,
      callback,
      capture,
      passive: passive ?? defaultPassive(self, type),
      once,
      removed: false,
      unsubscribe: null,
    };
    list.push(listener);
    if (signal !== undefined && watchSignal) {
      const targetRef = new WeakRef(self);
      const listenerRef = new WeakRef(listener);
      const sub = watchSignal(signal, () => {
        const t = targetRef.deref();
        const l = listenerRef.deref();
        if (t && l) removeListener(t, l);
      });
      if (typeof sub === 'function') {
        const token = {};
        listener.unsubscribe = () => {
          signalCleanup.unregister(token);
          sub();
        };
        signalCleanup.register(self, sub, token);
      }
    }
    listenerObserver?.(self, type);
  }

  removeEventListener(
    type: string,
    callback: EventListenerLike | null,
    options?: boolean | { capture?: boolean },
  ): void {
    if (arguments.length < 2) {
      throw new TypeError(
        `Failed to execute 'removeEventListener' on 'EventTarget': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    const capture = flattenCapture(options);
    type = toDOMString(
      type,
      "Failed to execute 'removeEventListener' on 'EventTarget'",
    );
    const self = (this ?? globalThis) as EventTarget;
    const list = listenersFor(self);
    for (const l of list) {
      if (l.type === type && l.callback === callback && l.capture === capture) {
        removeListener(self, l);
        return;
      }
    }
  }

  dispatchEvent(event: Event): boolean {
    if (!(event instanceof Event)) {
      throw new TypeError(
        "Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.",
      );
    }
    if (ev.isDispatching(event) || !ev.isInitialized(event)) {
      throw domException(
        "Failed to execute 'dispatchEvent' on 'EventTarget': The event is already being dispatched.",
        'InvalidStateError',
      );
    }
    ev.setTrusted(event, false);
    const self = (this ?? globalThis) as EventTarget;
    listenersFor(self);
    return dispatch(self, event);
  }
}
tag(EventTarget, 'EventTarget');
enumerable(EventTarget, [
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
]);

/**
 * Lets an object that is not an EventTarget instance (the global object) own a listener list, so the
 * EventTarget methods work on it when they are installed as own functions.
 */
export function adoptEventTarget(obj: object): void {
  if (!listenersOf.has(obj as EventTarget)) {
    listenersOf.set(obj as EventTarget, []);
  }
}

function listenersFor(target: EventTarget): Listener[] {
  const list = listenersOf.get(target);
  if (!list) throw new TypeError('Illegal invocation');
  return list;
}

function removeListener(target: EventTarget, listener: Listener): void {
  const list = listenersOf.get(target);
  if (!list) return;
  listener.removed = true;
  if (listener.unsubscribe) {
    const u = listener.unsubscribe;
    listener.unsubscribe = null;
    u();
  }
  const i = list.indexOf(listener);
  if (i >= 0) list.splice(i, 1);
  listenerObserver?.(target, listener.type);
}

// DOM §2.7: touch/wheel listeners on window/document/body default to passive; we have no such targets
// here, so the default is false. The DOM stand-ins can override with this hook.
let passiveDefault: (target: EventTarget, type: string) => boolean = () =>
  false;
function defaultPassive(target: EventTarget, type: string): boolean {
  return passiveDefault(target, type);
}
export function setDefaultPassive(
  fn: (target: EventTarget, type: string) => boolean,
): void {
  passiveDefault = fn;
}

function isSignal(signal: unknown): boolean {
  return watchSignal ? watchSignal(signal, NOOP_PROBE) !== false : true;
}
function signalAborted(signal: unknown): boolean {
  return watchSignal ? watchSignal(signal, NOOP_PROBE) === 'aborted' : false;
}
/** Passed to the watcher to ask "is this a signal / is it aborted" without subscribing. */
export const NOOP_PROBE = (): void => {};

function getTheParent(target: EventTarget, event: Event): EventTarget | null {
  const fn = (target as unknown as Record<symbol, unknown>)[GET_THE_PARENT];
  if (typeof fn === 'function') {
    const p = fn.call(target, event) as EventTarget | null | undefined;
    return p ?? null;
  }
  return null;
}

/** Dispatch without resetting `isTrusted` (used for runtime-fired events). */
export function dispatchTrusted(target: EventTarget, event: Event): boolean {
  if (ev.isDispatching(event)) {
    throw domException(
      'The event is already being dispatched.',
      'InvalidStateError',
    );
  }
  ev.setTrusted(event, true);
  return dispatch(target, event);
}

function dispatch(target: EventTarget, event: Event): boolean {
  const path: EventTarget[] = [target];
  for (
    let p = getTheParent(target, event);
    p !== null && path.length < 4096;
    p = getTheParent(p, event)
  ) {
    path.push(p);
  }
  ev.begin(event, target, path);
  try {
    // Capturing: from the outermost parent down to the target's parent.
    for (let i = path.length - 1; i >= 1; i--) {
      if (ev.stopped(event)) break;
      invoke(path[i]!, event, Event.CAPTURING_PHASE, 'capturing');
    }
    // At target: capture listeners, then non-capture listeners (DOM's two passes at the target).
    if (!ev.stopped(event)) {
      invoke(target, event, Event.AT_TARGET, 'capturing');
    }
    if (!ev.stopped(event)) {
      invoke(target, event, Event.AT_TARGET, 'bubbling');
    }
    if (event.bubbles) {
      for (let i = 1; i < path.length; i++) {
        if (ev.stopped(event)) break;
        invoke(path[i]!, event, Event.BUBBLING_PHASE, 'bubbling');
      }
    }
  } finally {
    ev.end(event);
  }
  return !ev.canceled(event);
}

function invoke(
  current: EventTarget,
  event: Event,
  phase: number,
  pass: 'capturing' | 'bubbling',
): void {
  const list = listenersOf.get(current);
  if (!list || list.length === 0) return;
  ev.setPhase(event, phase, current);
  const snapshot = list.slice();
  const type = event.type;
  for (const l of snapshot) {
    if (l.removed || l.type !== type) continue;
    if (pass === 'capturing' ? !l.capture : l.capture) continue;
    if (l.once) removeListener(current, l);
    if (l.passive) ev.setInPassive(event, true);
    try {
      const cb = l.callback;
      if (typeof cb === 'function') {
        cb.call(current, event);
      } else {
        const handleEvent = (cb as { handleEvent?: unknown }).handleEvent;
        if (typeof handleEvent !== 'function') {
          throw new TypeError(
            "'handleEvent' property of the listener is not callable.",
          );
        }
        handleEvent.call(cb, event);
      }
    } catch (error) {
      reportException(error);
    }
    ev.setInPassive(event, false);
    if (ev.immediateStopped(event)) break;
  }
  ev.setPhase(event, phase, null);
}

// ---------------------------------------------------------------------------------------------------
// Event handler attributes (HTML §8.1.8.1): the first non-null value registers one listener ("activate
// an event handler"); later non-null values keep its position. Setting null deactivates it (removes
// the listener), so a later non-null value registers again at the end of the list.

const handlerState = new WeakMap<
  object,
  Map<
    string,
    { value: unknown; listener: (this: unknown, event: Event) => void }
  >
>();

export function defineEventHandler(
  proto: object,
  type: string,
  targetOf: (self: object) => EventTarget = (self) => self as EventTarget,
): void {
  Object.defineProperty(proto, `on${type}`, {
    get(this: object) {
      return handlerState.get(targetOf(this))?.get(type)?.value ?? null;
    },
    set(this: object, value: unknown) {
      const target = targetOf(this);
      let map = handlerState.get(target);
      if (!map) {
        map = new Map();
        handlerState.set(target, map);
      }
      const v =
        typeof value === 'function' ||
        (value !== null && typeof value === 'object')
          ? value
          : null;
      const existing = map.get(type);
      if (v === null) {
        if (existing) {
          map.delete(type);
          EventTarget.prototype.removeEventListener.call(
            target,
            type,
            existing.listener,
          );
        }
        return;
      }
      if (existing) {
        existing.value = v;
        return;
      }
      const slot = {
        value: v,
        listener(this: unknown, event: Event): void {
          const h = slot.value;
          if (typeof h !== 'function') return;
          const ret: unknown =
            type === 'error' &&
            event instanceof ErrorEvent &&
            isGlobalLike(target)
              ? h.call(
                  this,
                  event.message,
                  event.filename,
                  event.lineno,
                  event.colno,
                  event.error,
                )
              : h.call(this, event);
          if (
            type === 'error' &&
            isGlobalLike(target) &&
            event instanceof ErrorEvent
          ) {
            if (ret === true) event.preventDefault();
          } else if (ret === false) {
            event.preventDefault();
          }
        },
      };
      map.set(type, slot);
      EventTarget.prototype.addEventListener.call(target, type, slot.listener);
    },
    configurable: true,
    enumerable: true,
  });
}

function isGlobalLike(target: object): boolean {
  return target === globalThis;
}

// ---------------------------------------------------------------------------------------------------
// Event subclasses the glue fires or constructs.

export interface CustomEventInit<T = unknown> extends EventInit {
  detail?: T;
}

export class CustomEvent<T = unknown> extends Event {
  #detail: T | null;
  constructor(type: string, init?: CustomEventInit<T> | null) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to construct 'CustomEvent': 1 argument required, but only 0 present.",
      );
    }
    super(type, init);
    this.#detail = init?.detail === undefined ? null : init.detail;
  }
  get detail(): T | null {
    return this.#detail;
  }
  initCustomEvent(
    type: string,
    bubbles = false,
    cancelable = false,
    detail: T | null = null,
  ): void {
    if (ev.isDispatching(this)) return;
    this.initEvent(type, bubbles, cancelable);
    this.#detail = detail;
  }
}
tag(CustomEvent, 'CustomEvent');
setLength(CustomEvent, 1);
enumerable(CustomEvent, ['detail', 'initCustomEvent']);

export interface ErrorEventInit extends EventInit {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
}

export class ErrorEvent extends Event {
  #message: string;
  #filename: string;
  #lineno: number;
  #colno: number;
  #error: unknown;
  constructor(type: string, init?: ErrorEventInit | null) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to construct 'ErrorEvent': 1 argument required, but only 0 present.",
      );
    }
    super(type, init);
    const what = "Failed to construct 'ErrorEvent'";
    this.#message =
      init?.message === undefined ? '' : toDOMString(init.message, what);
    this.#filename =
      init?.filename === undefined ? '' : toUSVString(init.filename, what);
    this.#lineno = init?.lineno === undefined ? 0 : init.lineno >>> 0;
    this.#colno = init?.colno === undefined ? 0 : init.colno >>> 0;
    this.#error = init?.error;
  }
  get message(): string {
    return this.#message;
  }
  get filename(): string {
    return this.#filename;
  }
  get lineno(): number {
    return this.#lineno;
  }
  get colno(): number {
    return this.#colno;
  }
  get error(): unknown {
    return this.#error;
  }
}
tag(ErrorEvent, 'ErrorEvent');
setLength(ErrorEvent, 1);
enumerable(ErrorEvent, ['message', 'filename', 'lineno', 'colno', 'error']);

export interface PromiseRejectionEventInit extends EventInit {
  promise: Promise<unknown>;
  reason?: unknown;
}

export class PromiseRejectionEvent extends Event {
  #promise: Promise<unknown>;
  #reason: unknown;
  constructor(type: string, init: PromiseRejectionEventInit) {
    if (arguments.length < 2) {
      throw new TypeError(
        `Failed to construct 'PromiseRejectionEvent': 2 arguments required, but only ${arguments.length} present.`,
      );
    }
    if (init == null || typeof init !== 'object' || !('promise' in init)) {
      throw new TypeError(
        "Failed to construct 'PromiseRejectionEvent': required member promise is undefined.",
      );
    }
    super(type, init);
    this.#promise = init.promise;
    this.#reason = init.reason;
  }
  get promise(): Promise<unknown> {
    return this.#promise;
  }
  get reason(): unknown {
    return this.#reason;
  }
}
tag(PromiseRejectionEvent, 'PromiseRejectionEvent');
enumerable(PromiseRejectionEvent, ['promise', 'reason']);

export interface MessageEventInit<T = unknown> extends EventInit {
  data?: T;
  origin?: string;
  lastEventId?: string;
  source?: unknown;
  ports?: unknown[];
}

export class MessageEvent<T = unknown> extends Event {
  #data: T | null;
  #origin: string;
  #lastEventId: string;
  #source: unknown;
  #ports: readonly unknown[];
  constructor(type: string, init?: MessageEventInit<T> | null) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to construct 'MessageEvent': 1 argument required, but only 0 present.",
      );
    }
    super(type, init);
    this.#data = init?.data === undefined ? null : init.data;
    const what = "Failed to construct 'MessageEvent'";
    this.#origin =
      init?.origin === undefined ? '' : toUSVString(init.origin, what);
    this.#lastEventId =
      init?.lastEventId === undefined
        ? ''
        : toDOMString(init.lastEventId, what);
    this.#source = init?.source ?? null;
    this.#ports = Object.freeze(init?.ports ? Array.from(init.ports) : []);
  }
  get data(): T | null {
    return this.#data;
  }
  get origin(): string {
    return this.#origin;
  }
  get lastEventId(): string {
    return this.#lastEventId;
  }
  get source(): unknown {
    return this.#source;
  }
  get ports(): readonly unknown[] {
    return this.#ports;
  }
}
tag(MessageEvent, 'MessageEvent');
setLength(MessageEvent, 1);
enumerable(MessageEvent, ['data', 'origin', 'lastEventId', 'source', 'ports']);

export interface ProgressEventInit extends EventInit {
  lengthComputable?: boolean;
  loaded?: number;
  total?: number;
}

export class ProgressEvent extends Event {
  #lengthComputable: boolean;
  #loaded: number;
  #total: number;
  constructor(type: string, init?: ProgressEventInit | null) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to construct 'ProgressEvent': 1 argument required, but only 0 present.",
      );
    }
    super(type, init);
    this.#lengthComputable = !!init?.lengthComputable;
    this.#loaded = toUnsignedLongLong(init?.loaded ?? 0);
    this.#total = toUnsignedLongLong(init?.total ?? 0);
  }
  get lengthComputable(): boolean {
    return this.#lengthComputable;
  }
  get loaded(): number {
    return this.#loaded;
  }
  get total(): number {
    return this.#total;
  }
}
tag(ProgressEvent, 'ProgressEvent');
setLength(ProgressEvent, 1);
enumerable(ProgressEvent, ['lengthComputable', 'loaded', 'total']);
