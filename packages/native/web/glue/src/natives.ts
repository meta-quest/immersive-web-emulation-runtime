/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The native hooks the web glue consumes, as seen from JS on `globalThis.__iwn`.
 *
 * Every hook is optional so the glue boots in a plain V8 context (tests, the headless runner with fake
 * natives, early bring-up). A missing hook falls back to a JS implementation, except where the fallback
 * would be unsafe (no CSPRNG: `crypto.getRandomValues` throws instead of using `Math.random`).
 *
 * Native modules install these on the per-context natives object with
 * `iwn_register_<module>(isolate, ctx, natives)` (the native module contract in the stream brief).
 */
export interface GlueNatives {
  /** `runtime/crypto`: fill `bytes` in place from the OS CSPRNG (getrandom(2) / arc4random_buf). */
  crypto?: {
    random(bytes: Uint8Array): void;
  };
  /**
   * The JS clock (TMR-4). `now()` is milliseconds since the process's JS clock zero, monotonic
   * (CLOCK_MONOTONIC), as a double with sub-microsecond resolution. The event loop uses the same clock
   * for timers and rAF time. `timeOrigin()` is the Unix-epoch time (ms) of that zero.
   */
  clock?: {
    now(): number;
    timeOrigin(): number;
  };
  /**
   * Optional UTF-8 fast paths (`runtime/encoding`, e.g. over `v8::String::NewFromUtf8` /
   * `String::WriteUtf8V2`). `decodeUtf8` must follow the WHATWG UTF-8 decoder (U+FFFD per maximal
   * subpart) and must not strip a BOM (JS does that); when `fatal` is true it returns `null` on the
   * first error instead of a string. `encodeUtf8` replaces lone surrogates with U+FFFD.
   */
  encoding?: {
    decodeUtf8(bytes: Uint8Array, fatal: boolean): string | null;
    encodeUtf8(text: string): Uint8Array;
  };
  /**
   * Optional `structuredClone` over `v8::ValueSerializer` (the same serializer workers use, WRK-5).
   * Throws a `DataCloneError` DOMException for uncloneable input, and detaches nothing then.
   * `transfer` holds only ArrayBuffers. (A host that loses the exception and returns undefined, as
   * core's clone.cc did with its TryCatch still in scope, still gives callers a DataCloneError: the glue
   * treats undefined for a non-undefined value as a failed clone.)
   *
   * Host objects: the hook needs no ValueSerializer::Delegate host-object support. The glue scans the
   * value first and keeps graphs that hold registered platform objects (Blob, File, DOMException,
   * ImageData, ImageBitmap, URL, EventTarget, ...) or non-ArrayBuffer transfers on its JS path, so this
   * hook only ever sees plain data.
   */
  clone?: {
    structuredClone(value: unknown, transfer: readonly unknown[]): unknown;
  };
  /** Optional: enqueue on V8's microtask queue (`Isolate::EnqueueMicrotask`). */
  loop?: {
    queueMicrotask?(callback: () => void): void;
  };
  /**
   * Optional process-wide blob URL store (NET-15) so `blob:` URLs resolve across the main thread and
   * workers. Without it the store is per global.
   *
   * `register()` must keep the bytes for the entry's lifetime, independent of the calling context: copy
   * them, or retain the view's `BackingStore` (std::shared_ptr) together with its byteOffset/byteLength,
   * since `bytes` may be a subarray of a larger buffer. The glue never mutates them after registering.
   * `resolve()` returns bytes the glue may wrap in a Blob without copying (it treats them as immutable).
   */
  blobUrls?: {
    register(url: string, bytes: Uint8Array, type: string): void;
    revoke(url: string): void;
    resolve(url: string): { bytes: Uint8Array; type: string } | null;
  };
  /** Device facts for `navigator` (DOM-4). All fields optional. */
  device?: {
    info(): DeviceInfo;
  };
  /**
   * App lifecycle hooks (PROC-8). `reload(url)` restarts JS with `url`, the current document URL with its query and
   * fragment, as the document URL (`location.reload()`). `navigate(url)` restarts it at another same-origin document URL
   * (`location.assign()`, `location.search = ...`); the glue only navigates to another document when
   * the host has it, and otherwise logs a warning and stays (it never calls `reload()` for that, which
   * would reload the current URL and loop on a conditional redirect).
   */
  app?: {
    reload?(url?: string): void;
    navigate?(url: string): void;
  };
  /**
   * The core's natives (runtime/core). The glue registers the `blob:` resolver the module loader and
   * worker loading use (NET-14): `resolver(url)` returns `{ bytes, type }` for a live blob URL (bytes
   * are the Blob's own bytes, not a copy; the loader copies them) or `null`.
   */
  core?: {
    setBlobResolver?(resolver: (url: string) => { bytes: Uint8Array; type: string } | null): void;
  };
  /**
   * The generated app config's glue section (an object or a JSON string), set by the host before the
   * glue bundle runs. See {@link GlueConfig}.
   */
  config?: GlueConfig | string;
}

export interface DeviceInfo {
  /** `Build.MODEL`, e.g. "Quest 3". */
  model?: string;
  /** `Build.VERSION.RELEASE`, e.g. "14". */
  androidRelease?: string;
  /** BCP 47 tags, most preferred first (from the device locale list). */
  languages?: string[];
  /** Cores worker pools may use (WRK-12). */
  hardwareConcurrency?: number;
  /** Physical device memory in GiB (the glue rounds it to the nearest power of two, as the Device Memory spec). */
  deviceMemory?: number;
  /** Connectivity (NET-8). */
  onLine?: boolean;
  /**
   * PermissionName values the app holds right now through Android runtime grants (e.g. `microphone`
   * after RECORD_AUDIO was granted). `navigator.permissions.query` reports them `granted` (DOM-4).
   */
  grantedPermissions?: string[];
}

export interface GlueConfig {
  /** The app URL (DOM-5): origin + path + query + hash. Default `https://app.local/`. */
  url?: string;
  /**
   * `navigator.userAgent` policy (DOM-4, open question 2): `honest` (default) or `quest-browser`
   * (adds `OculusBrowser/<v>` and `Chrome/<v>` tokens), or a literal string used as is.
   */
  userAgent?: 'honest' | 'quest-browser' | { literal: string };
  /** Runtime version that goes into the user agent. */
  runtimeVersion?: string;
  /** Fixed window size in CSS px used by `matchMedia` when `innerWidth/innerHeight` are absent (DOM-3). */
  viewport?: { width: number; height: number };
  /**
   * `crypto.subtle` exposure (NET-STORE-4: absent unless a sample needs it). `digest` installs
   * SubtleCrypto with `digest` only (SHA-1/256/384/512); `false` or absent (default) omits it.
   */
  subtle?: 'digest' | false;
  /**
   * The kind of global this context is: `window` (default) or `worker` (WRK-2: `self` and a
   * WorkerLocation of `url`, no window/history/matchMedia/devicePixelRatio). For a worker, `url` is the
   * worker script URL.
   */
  scope?: 'window' | 'worker';
  /**
   * DOM-4: PermissionName values `navigator.permissions.query` reports `granted` because the package
   * already holds the feature (the packager derives them from the manifest). Default
   * `['xr-spatial-tracking']`; everything else is `prompt` unless `device.info().grantedPermissions`
   * lists it.
   */
  permissions?: { granted?: string[] };
}
