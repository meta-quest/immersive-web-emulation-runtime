/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The contract with the native workers module (runtime/workers, globalThis.__iwn.workers). The same functions exist
// in the page and in every worker global; the worker-only ones are marked. Tests use a fake with the same shape
// (test/fake-natives.ts).

/** What `info()` reports about this global. */
export interface WorkersInfo {
  isWorker: boolean;
  /** Worker globals: this worker's id, name, URL, type and the port behind the global's postMessage/onmessage. */
  id?: number;
  name?: string;
  url?: string;
  type?: 'classic' | 'module';
  insidePort?: number;
  /** This global's origin ("https://app.local", or "null" in a data: worker). */
  origin?: string;
  maxWorkers: number;
  live: number;
  /** Policy (config workers.crossOriginIsolated): SharedArrayBuffer may be posted between threads. */
  crossOriginIsolated: boolean;
  /** WRK-12 cap for navigator.hardwareConcurrency. */
  hardwareConcurrencyCap: number;
}

/** The JS functions native code calls (`setHooks`). */
export interface WorkersHooks {
  /**
   * Native events for this global:
   *   ('message', port, data, portIds, bitmapTokens)   a message arrived at one of this global's ports
   *   ('messageerror', port, portIds, bitmapTokens)    one could not be deserialized here
   *   ('error', workerId, {message, filename, lineno, colno, label})  uncaught error a child worker did not handle
   *   ('loaderror', workerId, message)                 a child's script failed to load
   *   ('exit', workerId)                               a child worker ended (close(), terminate(), out of memory)
   */
  dispatch(kind: string, ...args: unknown[]): void;
  /** Serializer: a platform object found in a message -> a plain descriptor (or throw DataCloneError). */
  hostWrite(value: object): object;
  /** Deserializer: a descriptor -> the platform object in this realm. */
  hostRead(descriptor: object, portIds: number[], bitmapTokens: number[]): object;
  /** Objects whose instances are platform objects (checked natively along the prototype chain). */
  hostPrototypes: object[];
}

export interface WorkersNatives {
  setHooks(hooks: WorkersHooks): void;
  info(): WorkersInfo;
  /**
   * Starts a worker on its own thread and isolate. `url` is absolute (same-origin, data: or blob:); for blob: URLs the
   * creator passes the bytes it resolved in its own blob store. Throws NotSupportedError past the worker limit
   * (WRK-9), SecurityError for other origins. Returns [workerId, outsidePort].
   */
  create(url: string, type: 'classic' | 'module', name: string, source: Uint8Array | null, deviceInfo: object | null): [number, number];
  terminate(workerId: number): void;
  /** A new entangled pair owned by this global. */
  channel(): [number, number];
  /** Structured serialization with the ArrayBuffers to transfer; returns a pending id for post(). */
  serialize(value: unknown, transfer: ArrayBuffer[]): number;
  /** Sends a serialized message from `port` to its peer, with the transferred ports and ImageBitmap tokens. */
  post(port: number, pending: number, portIds: number[], bitmapTokens: number[]): boolean;
  discard(pending: number): void;
  start(port: number): void;
  close(port: number): void;
  stats(): Record<string, number>;
  /** Worker only: the source of a same-origin or data: classic script (throws NetworkError). */
  readScript?(url: string): string;
  /** Worker only: evaluates a classic script in this global; exceptions propagate. */
  evalScript?(source: string, url: string): unknown;
  /** Worker only: self.close(). */
  closeSelf?(): void;
  /** Worker only: an error a child worker raised and this global did not handle goes to this worker's creator. */
  forwardError?(message: string, filename: string, lineno: number, colno: number): void;
}

/** The parts of the glue registry (globalThis[Symbol.for('iwn.glue')]) used here. */
export interface GlueLike {
  blobUrls: { resolve(url: string): object | null };
  blobBytes(blob: object): Uint8Array;
  blobFromBytes(bytes: Uint8Array, type?: string): object;
  events: {
    dispatchTrusted(target: EventTarget, event: Event): boolean;
    defineEventHandler(proto: object, type: string, targetOf?: (self: object) => EventTarget): void;
    reportException(error: unknown): void;
  };
  scope: 'window' | 'worker';
}

/** The parts of the image registry (globalThis[Symbol.for('iwn.image')]) used here. */
export interface ImageLike {
  isImageBitmap(v: unknown): boolean;
  clone: {
    cloneBitmap(b: object): object;
    exportBitmap(b: object): { iwnImageBitmap: number };
    importBitmap(token: { iwnImageBitmap: number }): object;
  };
}
