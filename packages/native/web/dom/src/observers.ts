/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Observers (DOM-10). MutationObserver produces real records for childList / attributes / characterData changes of
// the stand-in tree (DOM §4.3, delivered in a microtask, subtree, attributeFilter, oldValue options).
// ResizeObserver fires once per observed element with the fixed window size (nothing is ever resized: DOM-3);
// elements with no box (0x0) do not fire, as in browsers. IntersectionObserver fires once with
// isIntersecting: true (there is no viewport to scroll out of).

import {
  BaseEventTarget,
  G,
  queueMicro,
  queueTask,
  reportException,
  viewport,
} from './env.ts';
import { DOMRectReadOnly } from './geometry.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface MOOptions {
  childList: boolean;
  attributes: boolean;
  characterData: boolean;
  subtree: boolean;
  attributeOldValue: boolean;
  characterDataOldValue: boolean;
  attributeFilter: string[] | null;
}

interface Registration {
  observer: MutationObserver;
  options: MOOptions;
}

const registrations = new WeakMap<object, Registration[]>();
let registrationCount = 0;
const pendingObservers = new Set<MutationObserver>();
let deliveryQueued = false;
let observerSeq = 0;

export class MutationRecord {
  readonly type: string;
  readonly target: unknown;
  readonly addedNodes: unknown[];
  readonly removedNodes: unknown[];
  readonly previousSibling: unknown;
  readonly nextSibling: unknown;
  readonly attributeName: string | null;
  readonly attributeNamespace: string | null;
  readonly oldValue: string | null;
  constructor(
    init: Partial<MutationRecord> & { type: string; target: unknown },
  ) {
    this.type = init.type;
    this.target = init.target;
    this.addedNodes = makeList(init.addedNodes ?? []);
    this.removedNodes = makeList(init.removedNodes ?? []);
    this.previousSibling = init.previousSibling ?? null;
    this.nextSibling = init.nextSibling ?? null;
    this.attributeName = init.attributeName ?? null;
    this.attributeNamespace = init.attributeNamespace ?? null;
    this.oldValue = init.oldValue ?? null;
  }
  get [Symbol.toStringTag](): string {
    return 'MutationRecord';
  }
}

let NodeListCtor: (new () => unknown[]) | null = null;
export function setNodeListClass(ctor: new () => unknown[]): void {
  NodeListCtor = ctor;
}
function makeList(nodes: unknown[]): unknown[] {
  if (!NodeListCtor) return [...nodes];
  const l = new NodeListCtor();
  for (const n of nodes) l.push(n);
  return l;
}

export class MutationObserver {
  /** @internal */ _callback: (
    records: MutationRecord[],
    observer: MutationObserver,
  ) => unknown;
  /** @internal */ _records: MutationRecord[] = [];
  /** @internal */ _targets = new Set<object>();
  /** @internal */ _seq = ++observerSeq;
  constructor(
    callback: (
      records: MutationRecord[],
      observer: MutationObserver,
    ) => unknown,
  ) {
    if (typeof callback !== 'function')
      throw new TypeError(
        "Failed to construct 'MutationObserver': parameter 1 is not of type 'MutationCallback'.",
      );
    this._callback = callback;
  }
  observe(
    target: object,
    init: Partial<Record<keyof MOOptions, unknown>> = {},
  ): void {
    if (
      !target ||
      typeof target !== 'object' ||
      typeof (target as { nodeType?: unknown }).nodeType !== 'number'
    ) {
      throw new TypeError(
        "Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.",
      );
    }
    const o: MOOptions = {
      childList: !!init.childList,
      attributes: !!init.attributes,
      characterData: !!init.characterData,
      subtree: !!init.subtree,
      attributeOldValue: !!init.attributeOldValue,
      characterDataOldValue: !!init.characterDataOldValue,
      attributeFilter: Array.isArray(init.attributeFilter)
        ? (init.attributeFilter as unknown[]).map(String)
        : null,
    };
    if (
      init.attributes === undefined &&
      (init.attributeOldValue !== undefined ||
        init.attributeFilter !== undefined)
    )
      o.attributes = true;
    if (
      init.characterData === undefined &&
      init.characterDataOldValue !== undefined
    )
      o.characterData = true;
    if (!o.childList && !o.attributes && !o.characterData) {
      throw new TypeError(
        "Failed to execute 'observe' on 'MutationObserver': The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.",
      );
    }
    if (o.attributeOldValue && !o.attributes)
      throw new TypeError(
        "The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.",
      );
    if (o.attributeFilter && !o.attributes)
      throw new TypeError(
        "The options object may only set 'attributeFilter' when 'attributes' is true or not present.",
      );
    if (o.characterDataOldValue && !o.characterData)
      throw new TypeError(
        "The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.",
      );
    let list = registrations.get(target);
    if (!list) {
      list = [];
      registrations.set(target, list);
    }
    const existing = list.find((r) => r.observer === this);
    if (existing) existing.options = o;
    else {
      list.push({ observer: this, options: o });
      registrationCount++;
      this._targets.add(target);
    }
  }
  disconnect(): void {
    for (const t of this._targets) {
      const list = registrations.get(t);
      if (!list) continue;
      const i = list.findIndex((r) => r.observer === this);
      if (i >= 0) {
        list.splice(i, 1);
        registrationCount--;
      }
    }
    this._targets.clear();
    this._records = [];
    pendingObservers.delete(this);
  }
  takeRecords(): MutationRecord[] {
    const r = this._records;
    this._records = [];
    return r;
  }
  get [Symbol.toStringTag](): string {
    return 'MutationObserver';
  }
}

function deliver(): void {
  deliveryQueued = false;
  const observers = [...pendingObservers].sort((a, b) => a._seq - b._seq);
  pendingObservers.clear();
  for (const mo of observers) {
    const records = mo.takeRecords();
    if (!records.length) continue;
    try {
      mo._callback.call(mo, records, mo);
    } catch (e) {
      reportException(e);
    }
  }
}

/** DOM "queue a mutation record" (§4.3.2). */
function queueRecord(
  type: 'childList' | 'attributes' | 'characterData',
  target: any,
  name: string | null,
  ns: string | null,
  oldValue: string | null,
  added: unknown[],
  removed: unknown[],
  prev: unknown,
  next: unknown,
): void {
  if (registrationCount === 0) return;
  const interested = new Map<MutationObserver, string | null>();
  for (let node = target; node; node = node._parent ?? null) {
    const list = registrations.get(node);
    if (!list) continue;
    for (const { observer, options } of list) {
      if (node !== target && !options.subtree) continue;
      if (type === 'attributes') {
        if (!options.attributes) continue;
        if (
          options.attributeFilter &&
          (ns !== null || !options.attributeFilter.includes(name!))
        )
          continue;
      }
      if (type === 'characterData' && !options.characterData) continue;
      if (type === 'childList' && !options.childList) continue;
      const wantsOld =
        (type === 'attributes' && options.attributeOldValue) ||
        (type === 'characterData' && options.characterDataOldValue);
      if (!interested.has(observer) || wantsOld)
        interested.set(
          observer,
          wantsOld ? oldValue : (interested.get(observer) ?? null),
        );
    }
  }
  for (const [observer, old] of interested) {
    observer._records.push(
      new MutationRecord({
        type,
        target,
        attributeName: name,
        attributeNamespace: ns,
        oldValue: old,
        addedNodes: added as never[],
        removedNodes: removed as never[],
        previousSibling: prev,
        nextSibling: next,
      }),
    );
    pendingObservers.add(observer);
  }
  if (interested.size && !deliveryQueued) {
    deliveryQueued = true;
    queueMicro(deliver);
  }
}

export function notifyChildList(
  target: unknown,
  added: unknown[],
  removed: unknown[],
  prev: unknown,
  next: unknown,
): void {
  if (registrationCount === 0) return;
  queueRecord(
    'childList',
    target,
    null,
    null,
    null,
    added,
    removed,
    prev,
    next,
  );
}
export function notifyAttribute(
  target: unknown,
  name: string,
  ns: string | null,
  oldValue: string | null,
): void {
  if (registrationCount === 0) return;
  queueRecord('attributes', target, name, ns, oldValue, [], [], null, null);
}
export function notifyCharacterData(target: unknown, oldValue: string): void {
  if (registrationCount === 0) return;
  queueRecord(
    'characterData',
    target,
    null,
    null,
    oldValue,
    [],
    [],
    null,
    null,
  );
}

// --- ResizeObserver ----------------------------------------------------------------------------------------------

export class ResizeObserverSize {
  readonly inlineSize: number;
  readonly blockSize: number;
  constructor(inline: number, block: number) {
    this.inlineSize = inline;
    this.blockSize = block;
  }
  get [Symbol.toStringTag](): string {
    return 'ResizeObserverSize';
  }
}

export class ResizeObserverEntry {
  readonly target: unknown;
  readonly contentRect: DOMRectReadOnly;
  readonly borderBoxSize: ResizeObserverSize[];
  readonly contentBoxSize: ResizeObserverSize[];
  readonly devicePixelContentBoxSize: ResizeObserverSize[];
  constructor(target: unknown, width: number, height: number) {
    this.target = target;
    this.contentRect = new DOMRectReadOnly(0, 0, width, height);
    const dpr = typeof G.devicePixelRatio === 'number' ? G.devicePixelRatio : 1;
    this.borderBoxSize = Object.freeze([
      new ResizeObserverSize(width, height),
    ]) as ResizeObserverSize[];
    this.contentBoxSize = Object.freeze([
      new ResizeObserverSize(width, height),
    ]) as ResizeObserverSize[];
    this.devicePixelContentBoxSize = Object.freeze([
      new ResizeObserverSize(width * dpr, height * dpr),
    ]) as ResizeObserverSize[];
  }
  get [Symbol.toStringTag](): string {
    return 'ResizeObserverEntry';
  }
}

function boxOf(target: any): { width: number; height: number } {
  try {
    const r = target?.getBoundingClientRect?.();
    if (r) return { width: r.width, height: r.height };
  } catch {
    // fall through
  }
  return viewport();
}

export class ResizeObserver {
  /** @internal */ _callback: (
    entries: ResizeObserverEntry[],
    observer: ResizeObserver,
  ) => unknown;
  /** @internal */ _observed = new Set<object>();
  /** @internal */ _pending = new Set<object>();
  /** @internal */ _scheduled = false;
  constructor(
    callback: (
      entries: ResizeObserverEntry[],
      observer: ResizeObserver,
    ) => unknown,
  ) {
    if (typeof callback !== 'function')
      throw new TypeError(
        "Failed to construct 'ResizeObserver': parameter 1 is not of type 'ResizeObserverCallback'.",
      );
    this._callback = callback;
  }
  observe(target: object, _options?: unknown): void {
    if (!target || typeof target !== 'object')
      throw new TypeError(
        "Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'.",
      );
    if (this._observed.has(target)) return;
    this._observed.add(target);
    this._pending.add(target);
    if (!this._scheduled) {
      this._scheduled = true;
      queueTask(() => this._flush());
    }
  }
  unobserve(target: object): void {
    this._observed.delete(target);
    this._pending.delete(target);
  }
  disconnect(): void {
    this._observed.clear();
    this._pending.clear();
  }
  /** @internal */ _flush(): void {
    this._scheduled = false;
    const entries: ResizeObserverEntry[] = [];
    for (const t of this._pending) {
      const { width, height } = boxOf(t);
      if (width === 0 && height === 0) continue;
      entries.push(new ResizeObserverEntry(t, width, height));
    }
    this._pending.clear();
    if (!entries.length) return;
    try {
      this._callback.call(this, entries, this);
    } catch (e) {
      reportException(e);
    }
  }
  get [Symbol.toStringTag](): string {
    return 'ResizeObserver';
  }
}

// --- IntersectionObserver ------------------------------------------------------------------------------------------

export class IntersectionObserverEntry {
  readonly time: number;
  readonly rootBounds: DOMRectReadOnly | null;
  readonly boundingClientRect: DOMRectReadOnly;
  readonly intersectionRect: DOMRectReadOnly;
  readonly isIntersecting = true;
  readonly intersectionRatio = 1;
  readonly target: unknown;
  constructor(target: unknown) {
    const v = viewport();
    const { width, height } = boxOf(target);
    this.time =
      typeof G.performance?.now === 'function' ? G.performance.now() : 0;
    this.rootBounds = new DOMRectReadOnly(0, 0, v.width, v.height);
    this.boundingClientRect = new DOMRectReadOnly(0, 0, width, height);
    this.intersectionRect = new DOMRectReadOnly(0, 0, width, height);
    this.target = target;
  }
  get [Symbol.toStringTag](): string {
    return 'IntersectionObserverEntry';
  }
}

export class IntersectionObserver {
  readonly root: unknown;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  /** @internal */ _callback: (
    entries: IntersectionObserverEntry[],
    observer: IntersectionObserver,
  ) => unknown;
  /** @internal */ _observed = new Set<object>();
  /** @internal */ _pending: IntersectionObserverEntry[] = [];
  /** @internal */ _scheduled = false;
  constructor(
    callback: (
      entries: IntersectionObserverEntry[],
      observer: IntersectionObserver,
    ) => unknown,
    options: {
      root?: unknown;
      rootMargin?: string;
      threshold?: number | number[];
    } = {},
  ) {
    if (typeof callback !== 'function')
      throw new TypeError(
        "Failed to construct 'IntersectionObserver': parameter 1 is not of type 'IntersectionObserverCallback'.",
      );
    this._callback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px 0px 0px 0px';
    const t = options.threshold ?? 0;
    this.thresholds = Object.freeze(
      (Array.isArray(t) ? t : [t]).map(Number).sort((a, b) => a - b),
    );
  }
  observe(target: object): void {
    if (this._observed.has(target)) return;
    this._observed.add(target);
    this._pending.push(new IntersectionObserverEntry(target));
    if (!this._scheduled) {
      this._scheduled = true;
      queueTask(() => {
        this._scheduled = false;
        const entries = this.takeRecords();
        if (!entries.length) return;
        try {
          this._callback.call(this, entries, this);
        } catch (e) {
          reportException(e);
        }
      });
    }
  }
  unobserve(target: object): void {
    this._observed.delete(target);
    this._pending = this._pending.filter((e) => e.target !== target);
  }
  disconnect(): void {
    this._observed.clear();
    this._pending = [];
  }
  takeRecords(): IntersectionObserverEntry[] {
    const r = this._pending;
    this._pending = [];
    return r;
  }
  get [Symbol.toStringTag](): string {
    return 'IntersectionObserver';
  }
}

void BaseEventTarget;
