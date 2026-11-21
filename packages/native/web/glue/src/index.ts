/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The web glue installer: puts the non-DOM web platform globals an IWSDK / three.js bundle needs on a
// V8 global, from established libraries where they fit (whatwg-url: URL, URLSearchParams; @noble/hashes:
// digests; punycode: IDNA labels) and small spec-derived modules otherwise (THIRD_PARTY.md lists what was
// considered and why core-js / event-target-shim / text-encoding were not used).
// Spec IDs: DOM-1 (aliases), DOM-2 (events, partial), DOM-3 (matchMedia, devicePixelRatio, history),
// DOM-4 (navigator basics), DOM-5 (location), DOM-10 (DOMException, AbortController/AbortSignal),
// DOM-12, TMR-3 (queueMicrotask, structuredClone), TMR-4 (performance), NET-13, NET-14, NET-15
// (store interface), NET-16, NET-STORE-4, JS-6 (Intl check).

import whatwgURL from 'whatwg-url/webidl2js-wrapper.js';
import { atob, btoa } from './base64.ts';
import { cloneRegistry, createStructuredClone } from './clone.ts';
import { AbortController, AbortSignal, addAbortAlgorithm, dependentCount, signalAbort } from './abort.ts';
import {
  base64Encode,
  Blob,
  blobBytes,
  blobFromBytes,
  type BlobURLStore,
  createBlobURLStore,
  File,
  FileReader,
} from './blob.ts';
import { attachSubtle, createCrypto, Crypto, hasRandomSource, randomUUID, setRandomSource } from './crypto.ts';
import { DOMException } from './dom-exception.ts';
import { setNativeEncoding, TextDecoder, TextEncoder, utf8Encode } from './encoding.ts';
import {
  adoptEventTarget,
  CustomEvent,
  defineEventHandler,
  dispatchTrusted,
  ErrorEvent,
  Event,
  EventTarget,
  GET_THE_PARENT,
  markTrusted,
  MessageEvent,
  ProgressEvent,
  PromiseRejectionEvent,
  reportException,
  setEventClock,
  setExceptionReporter,
} from './events.ts';
import { type IntlReport, verifyIntl } from './intl.ts';
import type { DeviceInfo, GlueConfig, GlueNatives } from './natives.ts';
import { createNavigator, Navigator, Permissions, PermissionStatus, StorageManager, WorkerNavigator } from './navigator.ts';
import {
  type Clock,
  createClock,
  createPerformance,
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  setDetailCloner,
} from './performance.ts';
import { defineGlobal, defineGlobalGetter, type GlobalSetter, type InstallMode, INTERNAL, toDOMString } from './util.ts';
import {
  createMatchMedia,
  createNavigation,
  HashChangeEvent,
  History,
  Location,
  MediaQueryList,
  MediaQueryListEvent,
  type Navigation,
  PopStateEvent,
  WorkerLocation,
} from './window.ts';

export type { BlobURLStore, GlueConfig, GlueNatives, DeviceInfo, IntlReport, InstallMode };
export type GlueScope = 'window' | 'worker';

export const GLUE_VERSION = '0.0.0';
export const DEFAULT_URL = 'https://app.local/';
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
export const REGISTRY_KEY: unique symbol = Symbol.for('iwn.glue') as never;

/**
 * What other runtime JS (fetch, images, workers, DOM stand-ins, the headless runner) reads from the
 * glue: published at `globalThis[Symbol.for('iwn.glue')]`.
 */
export interface GlueRegistry {
  version: string;
  /** Names of the globals this install defined. */
  installed: string[];
  /** The blob URL store fetch/image/module/worker loading consult (NET-14/15). */
  blobUrls: BlobURLStore;
  /** Bytes of a Blob without copying (do not mutate). */
  blobBytes(blob: Blob): Uint8Array;
  /** Wrap bytes (ownership passes to the Blob) as a Blob. */
  blobFromBytes(bytes: Uint8Array, type?: string): Blob;
  utf8Encode(text: string): Uint8Array;
  base64Encode(bytes: Uint8Array): string;
  clock: Clock;
  /** Event plumbing for DOM stand-ins and runtime-fired events. */
  events: {
    GET_THE_PARENT: typeof GET_THE_PARENT;
    dispatchTrusted: typeof dispatchTrusted;
    markTrusted: typeof markTrusted;
    defineEventHandler: typeof defineEventHandler;
    adoptEventTarget: typeof adoptEventTarget;
    reportException: typeof reportException;
  };
  /** `dependentCount` is diagnostics (AbortSignal.any() bookkeeping of a source signal). */
  abort: { addAbortAlgorithm: typeof addAbortAlgorithm; signalAbort: typeof signalAbort; dependentCount: typeof dependentCount };
  /**
   * Makes platform objects serializable/transferable in structuredClone (ImageData, ImageBitmap,
   * MessagePort, ...) or marks them as throwing DataCloneError. Registered types always take the JS
   * clone path (V8's serializer has no host-object delegate here).
   */
  cloneRegistry: typeof cloneRegistry;
  /** Which global this install shaped. */
  scope: GlueScope;
  /**
   * Called by the glue-subtle prelude (dist/glue-subtle.min.js) with its SubtleCrypto. Installs it as
   * `crypto.subtle` when config `subtle` is 'digest'; returns false (and does nothing) otherwise.
   */
  installSubtle(ctor: Function, instance: object): boolean;
  /** The URL behind `location` (window scope only; null in a worker). */
  navigation: Navigation | null;
  /** The JS-6 report on this global's Intl (or on `intl`, for tests). */
  verifyIntl(intl?: unknown): IntlReport;
}

export interface InstallOptions {
  natives?: GlueNatives;
  config?: GlueConfig;
  /** `missing` (default) keeps globals the engine already has; `all` replaces them. */
  mode?: InstallMode;
  /** Logging sink for runtime warnings (default: console.warn). */
  warn?: (message: string) => void;
  /** `window` (default) or `worker` (WRK-2: no window/document/history/matchMedia; WorkerLocation). */
  scope?: GlueScope;
}

function parseConfig(c: GlueConfig | string | undefined, warn: (m: string) => void): GlueConfig {
  if (c === undefined || c === null) return {};
  if (typeof c === 'string') {
    try {
      return JSON.parse(c) as GlueConfig;
    } catch (e) {
      warn(`[iwer-native] glue config is not valid JSON (${String((e as Error)?.message ?? e)}); using defaults`);
      return {};
    }
  }
  return c;
}

/** Globals the core bootstrap pre-installs in a minimal form that the glue replaces even in `missing` mode. */
const SUPERSEDED = new Set(['structuredClone', 'performance']);

const WORKER_EVENTS = ['error', 'unhandledrejection', 'rejectionhandled', 'message', 'messageerror', 'online', 'offline', 'languagechange'];

const WINDOW_EVENTS = [
  'error',
  'unhandledrejection',
  'rejectionhandled',
  'message',
  'messageerror',
  'hashchange',
  'popstate',
  'load',
  'unload',
  'beforeunload',
  'pagehide',
  'pageshow',
  'online',
  'offline',
  'languagechange',
  'focus',
  'blur',
  'resize',
  'storage',
];

let uuidSeq = 0;
/** A v4-shaped id unique within this process (time + counter), for blob URLs without a CSPRNG. */
function fallbackUUID(): string {
  uuidSeq = (uuidSeq + 1) % 0x100000000;
  const hex =
    Date.now().toString(16).padStart(12, '0').slice(-12) +
    uuidSeq.toString(16).padStart(8, '0') +
    Math.floor(Math.random() * 0x1000000000000).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function installGlue(global: typeof globalThis, options: InstallOptions = {}): GlueRegistry {
  const g = global as unknown as Record<string, unknown>;
  const natives = options.natives ?? (g.__iwn as GlueNatives | undefined) ?? {};
  const mode = options.mode ?? 'missing';
  const warn =
    options.warn ??
    ((m: string) => {
      const c = g.console as { warn?: (m: string) => void } | undefined;
      c?.warn?.(m);
    });
  const config = options.config ?? parseConfig(natives.config, warn);
  const scope: GlueScope = options.scope ?? (config.scope === 'worker' ? 'worker' : 'window');
  const isWindow = scope === 'window';
  const installed: string[] = [];
  const def = (name: string, value: unknown): void => {
    if (defineGlobal(global, name, value, SUPERSEDED.has(name) ? 'all' : mode)) installed.push(name);
  };
  const defGet = (name: string, get: () => unknown, setter: GlobalSetter = 'readonly'): void => {
    if (defineGlobalGetter(global, name, get, SUPERSEDED.has(name) ? 'all' : mode, setter)) installed.push(name);
  };
  // The core bootstrap aliases window and self to the global as plain writable data properties. Replace
  // such an alias with the WebIDL attribute even in `missing` mode (an engine-provided accessor stays).
  const isAlias = (name: string): boolean => {
    const d = Object.getOwnPropertyDescriptor(global, name);
    return !!d && 'value' in d && d.value === global && d.configurable === true;
  };
  const defAlias = (name: string, setter: GlobalSetter): void => {
    if (defineGlobalGetter(global, name, () => global, isAlias(name) ? 'all' : mode, setter)) installed.push(name);
  };

  if (isWindow) {
    // DOM-1: the global is the window. window is readonly; self is [Replaceable] on Window.
    defAlias('window', 'readonly');
    defAlias('self', 'replaceable');
  } else {
    // WRK-2: a worker global has self (readonly) and no window. The core bootstrap aliases window to
    // the global in every context; remove that alias here.
    const w = Object.getOwnPropertyDescriptor(global, 'window');
    if (w && (w.value === global || (w.get && w.get.call(global) === global)) && w.configurable) {
      delete g.window;
    }
    defAlias('self', 'readonly');
  }

  // Clock first: events stamp timeStamp with it.
  const clock = createClock(natives.clock);
  setEventClock(clock.now);
  setRandomSource(natives.crypto);
  setNativeEncoding(natives.encoding);

  // Exceptions from listeners and microtasks go through reportError (HTML "report an exception").
  setExceptionReporter((error) => {
    const report = g.reportError;
    if (typeof report === 'function') report.call(global, error);
    else (g.console as { error?: (...a: unknown[]) => void } | undefined)?.error?.('Uncaught', error);
  });

  def('DOMException', DOMException);
  def('Event', Event);
  def('EventTarget', EventTarget);
  def('CustomEvent', CustomEvent);
  def('ErrorEvent', ErrorEvent);
  def('PromiseRejectionEvent', PromiseRejectionEvent);
  def('MessageEvent', MessageEvent);
  def('ProgressEvent', ProgressEvent);
  if (isWindow) {
    def('PopStateEvent', PopStateEvent);
    def('HashChangeEvent', HashChangeEvent);
    def('MediaQueryListEvent', MediaQueryListEvent);
  }
  def('AbortController', AbortController);
  def('AbortSignal', AbortSignal);

  // The global object as an EventTarget (window.addEventListener / dispatchEvent).
  if (mode === 'all' || typeof g.addEventListener !== 'function') {
    adoptEventTarget(global);
    for (const m of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) {
      Object.defineProperty(global, m, {
        value: EventTarget.prototype[m],
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    for (const t of isWindow ? WINDOW_EVENTS : WORKER_EVENTS) {
      if (mode === 'all' || !(`on${t}` in global)) defineEventHandler(global, t, () => global as unknown as EventTarget);
    }
    installed.push('addEventListener', 'removeEventListener', 'dispatchEvent');
  }
  // Window and WorkerGlobalScope inherit from EventTarget (`globalThis instanceof EventTarget`). Insert
  // EventTarget.prototype just above Object.prototype, below the global and the prototype object of an
  // embedder's global template (an object whose only own property is `constructor`); any other chain
  // an engine or embedder set up is kept.
  if (g.EventTarget === EventTarget) {
    let link: object = global;
    let p = Object.getPrototypeOf(link) as object | null;
    if (p !== null && p !== Object.prototype) {
      const own = Object.getOwnPropertyNames(p);
      if (own.length <= 1 && own.every((n) => n === 'constructor') && Object.getOwnPropertySymbols(p).length === 0) {
        link = p;
        p = Object.getPrototypeOf(p) as object | null;
      }
    }
    if (p === Object.prototype) {
      try {
        Object.setPrototypeOf(link, EventTarget.prototype);
      } catch {
        // an immutable-prototype global: keep the own methods installed above
      }
    }
  }

  // reportError / "report an exception" (HTML §8.1.4.6): a cancelable `error` ErrorEvent on the window,
  // then the console unless a handler cancelled it. An error thrown while that event is dispatched is
  // only logged (the "errors reporting" guard), so a throwing error handler cannot recurse.
  let reporting = false;
  const logUncaught = (error: unknown): void => {
    (g.console as { error?: (...a: unknown[]) => void } | undefined)?.error?.('Uncaught', error);
  };
  def('reportError', function reportError(error: unknown): void {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'reportError' on 'Window': 1 argument required, but only 0 present.");
    }
    if (reporting) {
      logUncaught(error);
      return;
    }
    let text: string;
    try {
      text = String(error);
    } catch {
      text = Object.prototype.toString.call(error);
    }
    const event = new ErrorEvent('error', { cancelable: true, message: `Uncaught ${text}`, error });
    reporting = true;
    let notCanceled: boolean;
    try {
      notCanceled = dispatchTrusted(global as unknown as EventTarget, event);
    } finally {
      reporting = false;
    }
    if (notCanceled) logUncaught(error);
  });

  // queueMicrotask (HTML §8.1.7.3): exceptions are reported, not turned into rejections.
  const nativeQueue = natives.loop?.queueMicrotask;
  def('queueMicrotask', function queueMicrotask(callback: () => void): void {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'queueMicrotask' on 'Window': The callback provided as parameter 1 is not a function.");
    }
    const run = (): void => {
      try {
        callback();
      } catch (e) {
        reportException(e);
      }
    };
    if (nativeQueue) nativeQueue(run);
    else void Promise.resolve().then(run);
  });

  // structuredClone: the host's v8::ValueSerializer for plain data when it has one, the glue's
  // implementation for graphs holding platform objects (clone.ts createStructuredClone).
  cloneRegistry.registerCloneable({
    is: (v) => v instanceof File,
    clone: (v) => {
      const f = v as File;
      return new File([f], f.name, { type: f.type, lastModified: f.lastModified });
    },
  });
  cloneRegistry.registerCloneable({
    is: (v) => v instanceof Blob,
    clone: (v) => (v as Blob).slice(0, (v as Blob).size, (v as Blob).type),
  });
  cloneRegistry.registerCloneable({
    is: (v) => v instanceof DOMException,
    clone: (v) => {
      const e = v as DOMException;
      const c = new DOMException(e.message, e.name);
      if (typeof e.stack === 'string') Object.defineProperty(c, 'stack', { value: e.stack, writable: true, configurable: true });
      return c;
    },
  });
  const platformClasses: unknown[] = [
    Event,
    EventTarget,
    AbortController,
    Crypto,
    Location,
    WorkerLocation,
    History,
    TextEncoder,
    TextDecoder,
    FileReader,
    Performance,
    PerformanceEntry,
    Navigator,
    WorkerNavigator,
    Permissions,
    StorageManager,
  ];
  cloneRegistry.registerNonSerializable((v) => {
    for (const C of platformClasses) if (v instanceof (C as new () => object)) return true;
    return false;
  });
  const nativeClone = natives.clone?.structuredClone;
  const structuredClone = createStructuredClone(
    typeof nativeClone === 'function' ? (v, t) => nativeClone.call(natives.clone, v, t) : undefined,
  );
  def('structuredClone', structuredClone);
  setDetailCloner((v) => (structuredClone as (v: unknown) => unknown)(v));

  def('TextEncoder', TextEncoder);
  def('TextDecoder', TextDecoder);
  def('atob', atob);
  def('btoa', btoa);

  // Crypto. crypto.subtle is opt-in (`config.subtle: 'digest'`): NET-STORE-4 keeps it absent unless a
  // sample needs it, and a digest-only SubtleCrypto would defeat `if (crypto.subtle)` feature checks.
  // The SubtleCrypto itself is the glue-subtle prelude, which calls registry.installSubtle.
  const withSubtle = config.subtle === 'digest';
  const crypto = createCrypto();
  def('Crypto', Crypto);
  defGet('crypto', () => crypto);
  const installSubtle = (ctor: Function, instance: object): boolean => {
    if (!withSubtle) return false;
    def('SubtleCrypto', ctor);
    attachSubtle(crypto, instance);
    cloneRegistry.registerNonSerializable((v) => v instanceof (ctor as new () => object));
    return true;
  };

  // Performance (TMR-4).
  const performance = createPerformance(clock);
  def('Performance', Performance);
  def('PerformanceEntry', PerformanceEntry);
  def('PerformanceMark', PerformanceMark);
  def('PerformanceMeasure', PerformanceMeasure);
  defGet('performance', () => performance, 'replaceable');

  // URL + blob URLs (NET-13): whatwg-url, the URL Standard's reference implementation. Keep the
  // engine's URL if it has one and mode is `missing`.
  if (mode === 'all' || typeof g.URL !== 'function') {
    const holder: Record<string, unknown> = { Array, Object, Promise, String, TypeError };
    whatwgURL.URL.install(holder, ['Window']);
    whatwgURL.URLSearchParams.install(holder, ['Window']);
    def('URL', holder.URL);
    def('URLSearchParams', holder.URLSearchParams);
  }
  const URLCtor = g.URL as typeof URL;
  const URLSearchParamsCtor = g.URLSearchParams as typeof URLSearchParams | undefined;
  cloneRegistry.registerNonSerializable(
    (v) => v instanceof URLCtor || (typeof URLSearchParamsCtor === 'function' && v instanceof URLSearchParamsCtor),
  );

  // Location / history (DOM-5, DOM-3) on a window; WorkerLocation in a worker (WRK-2).
  let initial = DEFAULT_URL;
  try {
    initial = new URLCtor(config.url ?? DEFAULT_URL).href;
  } catch {
    warn(`[iwer-native] invalid app URL in config: ${String(config.url)}; using ${DEFAULT_URL}`);
  }
  let navigation: Navigation | null = null;
  let currentOrigin: () => string;
  if (isWindow) {
    const created = createNavigation({
      URL: URLCtor as never,
      initialURL: initial,
      windowTarget: global as unknown as EventTarget,
      clone: (v) => (structuredClone as (v: unknown) => unknown)(v),
      reload: (url) => {
        const app = natives.app;
        if (url === undefined || url === navigation?.current().href) {
          // location.reload(), or assign/replace/href/search set to the current URL (DOM-5: same
          // document reloads, PROC-8): restart with the current document URL, query and fragment included
          // (the host keeps its startup URL unless told).
          if (typeof app?.reload === 'function') app.reload(navigation?.current().href);
          else warn('[iwer-native] location.reload() is not available in this host');
          return;
        }
        // Another same-origin document. Only a host that can restart at a given URL (`app.navigate`)
        // gets it; `app.reload()` would restart the current URL, so a conditional redirect would loop.
        if (typeof app?.navigate === 'function') app.navigate(url);
        else warn(`[iwer-native] navigation to another document is not supported by this host; ignored: ${url}`);
      },
      warn,
    });
    const nav = created.navigation;
    navigation = nav;
    const { location, history } = created;
    currentOrigin = () => nav.current().origin;
    def('Location', Location);
    def('History', History);
    // [PutForwards=href]: `location = url` navigates.
    defGet('location', () => location, (v) => {
      location.href = v as string;
    });
    defGet('history', () => history);
    defGet('origin', () => nav.current().origin, 'replaceable');
    // DOM-1: a top-level browsing context with no frames: top/parent/frames are the window,
    // frameElement and opener null, name ''.
    defGet('top', () => global);
    defGet('parent', () => global, 'replaceable');
    defGet('frames', () => global, 'replaceable');
    defGet('frameElement', () => null);
    defGet('opener', () => null, 'replaceable');
    let windowName = '';
    defGet('name', () => windowName, (v) => {
      windowName = toDOMString(v, "Failed to set the 'name' property on 'Window'");
    });
  } else {
    const workerURL = new URLCtor(initial);
    const location = new WorkerLocation(INTERNAL, workerURL);
    currentOrigin = () => workerURL.origin;
    def('WorkerLocation', WorkerLocation);
    defGet('location', () => location);
    defGet('origin', () => workerURL.origin, 'replaceable');
  }
  defGet('isSecureContext', () => true);
  defGet('crossOriginIsolated', () => false);

  // Blob URL ids only need to be unique within the store, so they do not depend on the CSPRNG hook.
  const blobUrls = createBlobURLStore(
    currentOrigin,
    () => (hasRandomSource() ? randomUUID() : fallbackUUID()),
    natives.blobUrls,
  );
  // NET-14: the core's module loader (and worker loading) resolves blob: URLs through this store.
  const setBlobResolver = natives.core?.setBlobResolver;
  if (typeof setBlobResolver === 'function') {
    setBlobResolver.call(natives.core, (url: unknown) => {
      const blob = blobUrls.resolve(String(url));
      return blob ? { bytes: blobBytes(blob), type: blob.type } : null;
    });
  }
  def('Blob', Blob);
  def('File', File);
  def('FileReader', FileReader);
  const U = g.URL as unknown as Record<string, unknown>;
  if (mode === 'all' || typeof U.createObjectURL !== 'function') {
    Object.defineProperty(U, 'createObjectURL', {
      value: function createObjectURL(obj: unknown): string {
        if (!(obj instanceof Blob)) {
          throw new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.");
        }
        return blobUrls.create(obj);
      },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(U, 'revokeObjectURL', {
      value: function revokeObjectURL(url: string): void {
        if (arguments.length === 0) {
          throw new TypeError("Failed to execute 'revokeObjectURL' on 'URL': 1 argument required, but only 0 present.");
        }
        blobUrls.revoke(toDOMString(url, "Failed to execute 'revokeObjectURL' on 'URL'"));
      },
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // Navigator (DOM-4).
  const info = (): DeviceInfo => {
    try {
      return natives.device?.info() ?? {};
    } catch {
      return {};
    }
  };
  const navigator = createNavigator(config, info, !isWindow);
  if (isWindow) def('Navigator', Navigator);
  else def('WorkerNavigator', WorkerNavigator);
  def('Permissions', Permissions);
  def('PermissionStatus', PermissionStatus);
  def('StorageManager', StorageManager);
  defGet('navigator', () => navigator);

  // matchMedia / devicePixelRatio (DOM-3), window only. Size comes from innerWidth/innerHeight when the
  // DOM glue defines them, else the configured fixed viewport.
  if (isWindow) {
    const viewport = config.viewport ?? DEFAULT_VIEWPORT;
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    def('MediaQueryList', MediaQueryList);
    def(
      'matchMedia',
      createMatchMedia({
        width: () => num(g.innerWidth, viewport.width),
        height: () => num(g.innerHeight, viewport.height),
        dpr: () => num(g.devicePixelRatio, 1),
      }),
    );
    defGet('devicePixelRatio', () => 1, 'replaceable');
  }

  const registry: GlueRegistry = {
    version: GLUE_VERSION,
    installed,
    blobUrls,
    blobBytes,
    blobFromBytes,
    utf8Encode,
    base64Encode,
    clock,
    events: {
      GET_THE_PARENT,
      dispatchTrusted,
      markTrusted,
      defineEventHandler,
      adoptEventTarget,
      reportException,
    },
    abort: { addAbortAlgorithm, signalAbort, dependentCount },
    cloneRegistry,
    scope,
    installSubtle,
    navigation,
    verifyIntl: (intl?: unknown) => verifyIntl(intl ?? g.Intl),
  };
  Object.defineProperty(global, REGISTRY_KEY, {
    value: registry,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  return registry;
}
