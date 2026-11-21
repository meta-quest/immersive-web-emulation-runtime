/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Workers for the @iwer/native runtime (spec 05, WRK-1..12): `Worker`, `MessageChannel`, `MessagePort`, and in a
// worker global `postMessage`, `close`, `importScripts`, `name`, `WorkerGlobalScope`/`DedicatedWorkerGlobalScope`.
// Written from HTML §9.4 (channel messaging), §9.3 (postMessage: StructuredSerializeWithTransfer), §10 (workers),
// §2.7 (serializable and transferable objects), WebIDL (sequence<object> conversion, DOMException names).
//
// Native side: runtime/workers (globalThis.__iwn.workers, see natives.ts). Messages are serialized natively with
// V8's ValueSerializer; platform objects implemented in JS (MessagePort, ImageBitmap, ImageData, Blob, File,
// DOMException, DOMMatrix & co.) are "host objects" that the hooks below turn into plain descriptors and back.
//
// Install after the web glue (EventTarget, MessageEvent, ErrorEvent, DOMException, Blob) and after the image prelude
// (ImageBitmap/ImageData); run it as the last runtime prelude so it sees every platform interface.

import type {
  GlueLike,
  ImageLike,
  WorkersHooks,
  WorkersInfo,
  WorkersNatives,
} from './natives.ts';

export interface InstallWorkersOptions {
  natives?: WorkersNatives;
  glue?: GlueLike;
  image?: ImageLike | null;
}

export interface WorkersRegistry {
  version: 1;
  scope: 'window' | 'worker';
  info(): WorkersInfo;
  stats(): Record<string, number>;
}

export const REGISTRY_KEY: unique symbol = Symbol.for('iwn.workers') as never;

// ECMAScript (and engine) globals: everything else that is a constructor on the global at install time is a platform
// interface, whose instances are not serializable unless handled below (HTML: platform objects without
// [Serializable] throw DataCloneError).
const ES_GLOBALS = new Set([
  'Object',
  'Function',
  'Array',
  'Number',
  'Boolean',
  'String',
  'Symbol',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'SuppressedError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'Promise',
  'Proxy',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Iterator',
  'DisposableStack',
  'AsyncDisposableStack',
  'eval',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
]);

// Serializable geometry interfaces (Geometry Interfaces §serialization): cloned through their JSON form.
const GEOMETRY = [
  'DOMPointReadOnly',
  'DOMPoint',
  'DOMRectReadOnly',
  'DOMRect',
  'DOMQuad',
  'DOMMatrixReadOnly',
  'DOMMatrix',
];

type Target = EventTarget;
type AnyRecord = Record<string | symbol, unknown>;

const INTERNAL = Symbol('iwn.workers.internal');

export function installWorkers(
  global: typeof globalThis,
  options: InstallWorkersOptions = {},
): WorkersRegistry | null {
  const g = global as unknown as AnyRecord;
  const natives =
    options.natives ??
    ((g.__iwn as AnyRecord | undefined)?.workers as WorkersNatives | undefined);
  const glue =
    options.glue ?? (g[Symbol.for('iwn.glue')] as GlueLike | undefined);
  if (!natives || !glue) return null;
  const N: WorkersNatives = natives;
  const G: GlueLike = glue;
  const image: ImageLike | null =
    options.image !== undefined
      ? options.image
      : ((g[Symbol.for('iwn.image')] as ImageLike | undefined) ?? null);
  const info = N.info();
  const isWorker = info.isWorker;

  const EventTargetCtor = g.EventTarget as typeof EventTarget;
  const MessageEventCtor = g.MessageEvent as typeof MessageEvent;
  const ErrorEventCtor =
    (g.ErrorEvent as typeof ErrorEvent | undefined) ?? null;
  const EventCtor = g.Event as typeof Event;
  const DOMExceptionCtor = g.DOMException as typeof DOMException;
  const BlobCtor = g.Blob as (new (...a: unknown[]) => Blob) | undefined;
  const FileCtor = g.File as
    | (new (bits: unknown[], name: string, opts?: object) => File)
    | undefined;
  const ImageDataCtor = g.ImageData as
    | (new (
        data: Uint8ClampedArray,
        w: number,
        h: number,
        o?: object,
      ) => object)
    | undefined;
  const coreLog = (
    (g.__iwn as AnyRecord | undefined)?.core as AnyRecord | undefined
  )?.log as ((level: number, text: string) => void) | undefined;

  const domException = (message: string, name: string): DOMException =>
    new DOMExceptionCtor(message, name);
  const dataCloneError = (message: string): DOMException =>
    domException(message, 'DataCloneError');
  const log = (level: number, text: string): void => {
    if (coreLog) coreLog(level, text);
    else if (level >= 3) (g.console as Console).error(text);
    else (g.console as Console).log(text);
  };

  const abByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
  )!.get!;
  const isArrayBuffer = (v: unknown): v is ArrayBuffer => {
    if (typeof v !== 'object' || v === null) return false;
    try {
      abByteLength.call(v);
      return true;
    } catch {
      return false;
    }
  };
  const sabByteLength =
    typeof SharedArrayBuffer === 'function'
      ? Object.getOwnPropertyDescriptor(
          SharedArrayBuffer.prototype,
          'byteLength',
        )!.get!
      : null;
  const isSharedArrayBuffer = (v: unknown): boolean => {
    if (!sabByteLength || typeof v !== 'object' || v === null) return false;
    try {
      sabByteLength.call(v);
      return true;
    } catch {
      return false;
    }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Port targets: which JS object receives the messages of each native port this global owns.

  // Started ports are held strongly (HTML: an entangled port with an enabled queue stays alive); others weakly, and
  // closed natively when collected.
  const strongTargets = new Map<number, Target>();
  const weakPorts = new Map<number, WeakRef<MessagePort>>();
  const portFinalizer = new FinalizationRegistry<number>((id) => {
    if (weakPorts.get(id)?.deref() === undefined && !strongTargets.has(id)) {
      weakPorts.delete(id);
      N.close(id);
    }
  });
  const targetOf = (port: number): Target | undefined =>
    strongTargets.get(port) ?? weakPorts.get(port)?.deref();

  // ---------------------------------------------------------------------------------------------------------------
  // MessagePort (HTML §9.4.3)

  let portState!: (p: MessagePort) => {
    id: number;
    started: boolean;
    detached: boolean;
    closed: boolean;
  };

  class MessagePort extends EventTargetCtor {
    #id: number;
    #started = false;
    #detached = false;
    #closed = false;
    static {
      portState = (p) => {
        const self = p as MessagePort;
        return {
          get id() {
            return self.#id;
          },
          get started() {
            return self.#started;
          },
          set started(v: boolean) {
            self.#started = v;
          },
          get detached() {
            return self.#detached;
          },
          set detached(v: boolean) {
            self.#detached = v;
          },
          get closed() {
            return self.#closed;
          },
          set closed(v: boolean) {
            self.#closed = v;
          },
        } as {
          id: number;
          started: boolean;
          detached: boolean;
          closed: boolean;
        };
      };
    }
    constructor(token?: unknown, id?: number) {
      if (token !== INTERNAL) throw new TypeError('Illegal constructor');
      super();
      this.#id = id as number;
      weakPorts.set(this.#id, new WeakRef(this));
      portFinalizer.register(this, this.#id);
    }
    postMessage(message: unknown, transfer: unknown = undefined): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'postMessage' on 'MessagePort': 1 argument required, but only 0 present.",
        );
      }
      if (this.#detached) return; // a transferred-away port is inert
      sendMessage(this.#id, message, transfer, this, 'MessagePort');
    }
    start(): void {
      if (this.#started || this.#detached || this.#closed) return;
      this.#started = true;
      strongTargets.set(this.#id, this);
      N.start(this.#id);
    }
    close(): void {
      if (this.#closed) return;
      this.#closed = true;
      if (!this.#detached) {
        strongTargets.delete(this.#id);
        weakPorts.delete(this.#id);
        N.close(this.#id);
      }
    }
  }
  Object.defineProperty(MessagePort.prototype, Symbol.toStringTag, {
    value: 'MessagePort',
    configurable: true,
  });
  G.events.defineEventHandler(MessagePort.prototype, 'message');
  G.events.defineEventHandler(MessagePort.prototype, 'messageerror');
  G.events.defineEventHandler(MessagePort.prototype, 'close');
  {
    // HTML: setting onmessage starts the port (implicit start()); addEventListener does not.
    const d = Object.getOwnPropertyDescriptor(
      MessagePort.prototype,
      'onmessage',
    )!;
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      get: d.get,
      set(this: MessagePort, v: unknown) {
        d.set!.call(this, v);
        if (typeof v === 'function' || (typeof v === 'object' && v !== null))
          this.start();
      },
      configurable: true,
      enumerable: true,
    });
  }

  // Wraps a port id this global just received (or created) in a MessagePort.
  const wrapPort = (id: number): MessagePort => new MessagePort(INTERNAL, id);

  // Takes a port out of this global for a transfer: the wrapper becomes inert (HTML "detached").
  const detachPort = (p: MessagePort): number => {
    const s = portState(p);
    s.detached = true;
    strongTargets.delete(s.id);
    weakPorts.delete(s.id);
    portFinalizer.unregister(p);
    return s.id;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // MessageChannel (HTML §9.4.2)

  class MessageChannel {
    #port1: MessagePort;
    #port2: MessagePort;
    constructor() {
      const [a, b] = N.channel();
      this.#port1 = wrapPort(a);
      this.#port2 = wrapPort(b);
    }
    get port1(): MessagePort {
      return this.#port1;
    }
    get port2(): MessagePort {
      return this.#port2;
    }
  }
  Object.defineProperty(MessageChannel.prototype, Symbol.toStringTag, {
    value: 'MessageChannel',
    configurable: true,
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Serialization: transfer lists and host objects (HTML §2.7.3, §9.3.3 "message port post message steps")

  interface SendState {
    ports: MessagePort[];
    bitmaps: object[];
    clonedTokens: number[];
  }
  let sending: SendState | null = null;

  const typeName = (v: object): string => {
    try {
      const tag = (v as AnyRecord)[Symbol.toStringTag];
      if (typeof tag === 'string') return tag;
    } catch {
      // ignore
    }
    return 'object';
  };

  function normalizeTransfer(transfer: unknown, where: string): object[] {
    // postMessage(message, transfer) or postMessage(message, { transfer }) (StructuredSerializeOptions).
    let list: unknown = transfer;
    if (
      transfer !== undefined &&
      transfer !== null &&
      typeof transfer === 'object' &&
      !(Symbol.iterator in transfer)
    ) {
      list = (transfer as { transfer?: unknown }).transfer;
    }
    if (list === undefined || list === null) {
      if (transfer === null)
        throw new TypeError(
          `Failed to execute 'postMessage' on '${where}': The provided value cannot be converted to a sequence.`,
        );
      return [];
    }
    if (typeof list !== 'object' || !(Symbol.iterator in list)) {
      throw new TypeError(
        `Failed to execute 'postMessage' on '${where}': The provided value cannot be converted to a sequence.`,
      );
    }
    const out: object[] = [];
    for (const item of list as Iterable<unknown>) {
      if (
        (typeof item !== 'object' && typeof item !== 'function') ||
        item === null
      ) {
        throw new TypeError(
          `Failed to execute 'postMessage' on '${where}': Value at index ${out.length} is not an object.`,
        );
      }
      out.push(item as object);
    }
    return out;
  }

  function sendMessage(
    fromPort: number,
    message: unknown,
    transferArg: unknown,
    source: MessagePort | null,
    where: string,
  ): void {
    const transfer = normalizeTransfer(transferArg, where);
    refreshPrototypes();
    const buffers: ArrayBuffer[] = [];
    const state: SendState = { ports: [], bitmaps: [], clonedTokens: [] };
    const seen = new Set<object>();
    transfer.forEach((t, i) => {
      if (seen.has(t))
        throw dataCloneError(
          `Value at index ${i} is a duplicate of an earlier value in the transfer list.`,
        );
      seen.add(t);
      if (isArrayBuffer(t)) {
        buffers.push(t);
      } else if (t instanceof MessagePort) {
        const s = portState(t);
        if (t === source)
          throw dataCloneError('Port at index ' + i + ' is the source port.');
        if (s.detached)
          throw dataCloneError(`Port at index ${i} is already detached.`);
        state.ports.push(t);
      } else if (image?.isImageBitmap(t)) {
        if (
          (t as { width: number }).width === 0 &&
          (t as { height: number }).height === 0
        ) {
          throw dataCloneError(
            `ImageBitmap at index ${i} is detached and could not be transferred.`,
          );
        }
        state.bitmaps.push(t);
      } else if (isSharedArrayBuffer(t)) {
        throw dataCloneError(
          `SharedArrayBuffer at index ${i} is not transferable (post it in the message instead).`,
        );
      } else {
        throw dataCloneError(
          `Value at index ${i} does not have a transferable type (${typeName(t)}).`,
        );
      }
    });
    sending = state;
    let pending: number;
    try {
      pending = N.serialize(message, buffers);
    } catch (e) {
      discardTokens(state.clonedTokens);
      throw e;
    } finally {
      sending = null;
    }
    // Serialization succeeded: now detach the platform transferables (nothing is detached when it throws).
    const portIds = state.ports.map(detachPort);
    const tokens = state.bitmaps
      .map((b) => image!.clone.exportBitmap(b).iwnImageBitmap)
      .concat(state.clonedTokens);
    N.post(fromPort, pending, portIds, tokens);
  }

  const discardTokens = (tokens: number[]): void => {
    const imageNatives = (
      (g.__iwn as AnyRecord | undefined)?.image as AnyRecord | undefined
    )?.discardTransfer as ((id: number) => void) | undefined;
    if (imageNatives) for (const t of tokens) imageNatives(t);
  };

  const geometryCtors = (): Map<object, string> => {
    const m = new Map<object, string>();
    for (const name of GEOMETRY) {
      const c = g[name] as unknown;
      const proto =
        typeof c === 'function'
          ? (c as { prototype?: object }).prototype
          : undefined;
      if (proto) m.set(proto, name);
    }
    return m;
  };
  const geometry = geometryCtors();

  function hostWrite(value: object): object {
    if (value instanceof MessagePort) {
      const i = sending ? sending.ports.indexOf(value) : -1;
      if (i < 0)
        throw dataCloneError(
          'A MessagePort could not be cloned because it was not transferred.',
        );
      return { t: 'port', i };
    }
    if (image?.isImageBitmap(value)) {
      if (!sending) throw dataCloneError('ImageBitmap could not be cloned.');
      const i = sending.bitmaps.indexOf(value);
      if (i >= 0) return { t: 'bitmap', i };
      // Serializable (not transferred): a new bitmap on the same pixels travels as a token.
      const token = image.clone.exportBitmap(
        image.clone.cloneBitmap(value),
      ).iwnImageBitmap;
      sending.clonedTokens.push(token);
      return {
        t: 'bitmap',
        i: sending.bitmaps.length + sending.clonedTokens.length - 1,
      };
    }
    if (ImageDataCtor && value instanceof ImageDataCtor) {
      const d = value as unknown as {
        data: Uint8ClampedArray;
        width: number;
        height: number;
        colorSpace?: string;
      };
      if (d.data.byteLength === 0 && d.width * d.height > 0)
        throw dataCloneError('ImageData is detached and could not be cloned.');
      return {
        t: 'imagedata',
        data: d.data.slice(),
        w: d.width,
        h: d.height,
        cs: d.colorSpace ?? 'srgb',
      };
    }
    if (BlobCtor && value instanceof BlobCtor) {
      const bytes = G.blobBytes(value).slice();
      const type = (value as Blob).type;
      if (FileCtor && value instanceof FileCtor) {
        const f = value as File;
        return {
          t: 'file',
          bytes,
          type,
          name: f.name,
          lastModified: f.lastModified,
        };
      }
      return { t: 'blob', bytes, type };
    }
    if (value instanceof DOMExceptionCtor) {
      const e = value as DOMException;
      return { t: 'domexception', name: e.name, message: e.message };
    }
    for (
      let p = Object.getPrototypeOf(value);
      p;
      p = Object.getPrototypeOf(p)
    ) {
      const name = geometry.get(p);
      if (name)
        return {
          t: 'geom',
          name,
          json: (value as { toJSON(): object }).toJSON(),
        };
    }
    throw dataCloneError(`${typeName(value)} object could not be cloned.`);
  }

  // Per received message: the MessagePort wrappers (created once, shared by event.ports and the data) and the
  // ImageBitmap tokens imported from it.
  const received = new WeakMap<
    object,
    { ports: MessagePort[]; imported: Set<number> }
  >();
  const receiveState = (
    portIds: number[],
  ): { ports: MessagePort[]; imported: Set<number> } => {
    let s = received.get(portIds);
    if (!s) {
      s = { ports: portIds.map(wrapPort), imported: new Set() };
      received.set(portIds, s);
    }
    return s;
  };

  function hostRead(desc: object, portIds: number[], tokens: number[]): object {
    const d = desc as AnyRecord;
    switch (d.t) {
      case 'port': {
        const p = receiveState(portIds).ports[d.i as number];
        if (!p) throw dataCloneError('A transferred MessagePort is missing.');
        return p;
      }
      case 'bitmap': {
        if (!image)
          throw dataCloneError('ImageBitmap is not available in this global.');
        const token = tokens[d.i as number];
        if (token === undefined)
          throw dataCloneError('A transferred ImageBitmap is missing.');
        receiveState(portIds).imported.add(token);
        return image.clone.importBitmap({ iwnImageBitmap: token });
      }
      case 'imagedata':
        if (!ImageDataCtor)
          throw dataCloneError('ImageData is not available in this global.');
        return new ImageDataCtor(
          d.data as Uint8ClampedArray,
          d.w as number,
          d.h as number,
          { colorSpace: d.cs },
        );
      case 'blob':
        return G.blobFromBytes(d.bytes as Uint8Array, d.type as string);
      case 'file':
        if (!FileCtor)
          return G.blobFromBytes(d.bytes as Uint8Array, d.type as string);
        return new FileCtor([d.bytes], d.name as string, {
          type: d.type,
          lastModified: d.lastModified,
        });
      case 'domexception':
        return domException(d.message as string, d.name as string);
      case 'geom': {
        const ctor = g[d.name as string] as AnyRecord | undefined;
        const from =
          ctor &&
          (ctor.fromMatrix ?? ctor.fromPoint ?? ctor.fromRect ?? ctor.fromQuad);
        if (typeof from !== 'function')
          throw dataCloneError(
            `${String(d.name)} is not available in this global.`,
          );
        return (from as (o: object) => object).call(ctor, d.json as object);
      }
      default:
        throw dataCloneError('Unknown platform object in a message.');
    }
  }

  // Platform prototypes: computed now (after the other preludes) and extended lazily with interfaces defined later
  // that carry their own Symbol.toStringTag (the WebIDL convention; app classes normally do not).
  const hostPrototypes: object[] = [];
  const known = new Set<object>();
  const addProto = (p: unknown): void => {
    if (
      p &&
      (typeof p === 'object' || typeof p === 'function') &&
      !known.has(p as object)
    ) {
      known.add(p as object);
      hostPrototypes.push(p as object);
    }
  };
  addProto(MessagePort.prototype);
  for (const name of Object.getOwnPropertyNames(global)) {
    if (
      ES_GLOBALS.has(name) ||
      name === 'WebAssembly' ||
      name === 'Intl' ||
      name === 'Atomics'
    )
      continue;
    let v: unknown;
    try {
      const desc = Object.getOwnPropertyDescriptor(global, name);
      v = desc && 'value' in desc ? desc.value : undefined;
    } catch {
      continue;
    }
    if (typeof v === 'function' && /^[A-Z]/.test(name)) {
      const proto = (v as { prototype?: unknown }).prototype;
      if (proto && typeof proto === 'object' && proto !== Object.prototype)
        addProto(proto);
    }
  }

  addProto(MessageChannel.prototype);

  const hooks: WorkersHooks = {
    dispatch,
    hostWrite,
    hostRead,
    hostPrototypes,
  };
  N.setHooks(hooks);

  // Interfaces installed after this prelude (a later prelude, a polyfill) join the list when they follow the WebIDL
  // convention of an own Symbol.toStringTag equal to the interface name. Checked before each post (cheap: the
  // global's property count is compared first).
  let globalNames = Object.getOwnPropertyNames(global).length;
  const refreshPrototypes = (): void => {
    const names = Object.getOwnPropertyNames(global);
    if (names.length === globalNames) return;
    globalNames = names.length;
    const before = hostPrototypes.length;
    for (const name of names) {
      if (ES_GLOBALS.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(global, name);
      const v = desc && 'value' in desc ? desc.value : undefined;
      if (typeof v !== 'function' || !/^[A-Z]/.test(name)) continue;
      const proto = (v as { prototype?: unknown }).prototype as
        | AnyRecord
        | undefined;
      if (!proto || typeof proto !== 'object' || known.has(proto)) continue;
      const tag = Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag);
      if (tag && tag.value === name) addProto(proto);
    }
    if (hostPrototypes.length !== before) N.setHooks(hooks);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Worker (HTML §10.2.6)

  const workers = new Map<number, Worker>();
  let workerState!: (w: Worker) => { id: number; port: number; dead: boolean };

  const baseURL = (): string => {
    if (isWorker) return info.url ?? 'about:blank';
    const loc = g.location as { href?: string } | undefined;
    return loc?.href ?? 'https://app.local/';
  };

  const deviceInfo = (): object | null => {
    const dev = (
      (g.__iwn as AnyRecord | undefined)?.device as AnyRecord | undefined
    )?.info as (() => AnyRecord) | undefined;
    let d: AnyRecord = {};
    try {
      d = { ...(dev ? dev() : {}) };
    } catch {
      d = {};
    }
    const cores =
      typeof d.hardwareConcurrency === 'number'
        ? (d.hardwareConcurrency as number)
        : 4;
    d.hardwareConcurrency = Math.max(
      1,
      Math.min(cores, info.hardwareConcurrencyCap),
    );
    return d;
  };

  class Worker extends EventTargetCtor {
    #id = 0;
    #port = 0;
    #dead = false;
    static {
      workerState = (w) => {
        const self = w as Worker;
        return {
          get id() {
            return self.#id;
          },
          get port() {
            return self.#port;
          },
          get dead() {
            return self.#dead;
          },
          set dead(v: boolean) {
            self.#dead = v;
          },
        } as { id: number; port: number; dead: boolean };
      };
    }
    constructor(
      scriptURL: string | URL,
      options: { type?: string; name?: string; credentials?: string } = {},
    ) {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to construct 'Worker': 1 argument required, but only 0 present.",
        );
      }
      super();
      const opts = options ?? {};
      const type = opts.type === undefined ? 'classic' : String(opts.type);
      if (type !== 'classic' && type !== 'module') {
        throw new TypeError(
          `Failed to construct 'Worker': The provided value '${type}' is not a valid enum value of type WorkerType.`,
        );
      }
      const name = opts.name === undefined ? '' : String(opts.name);
      let url: URL;
      try {
        url = new (g.URL as typeof URL)(String(scriptURL), baseURL());
      } catch {
        throw domException(
          `Failed to construct 'Worker': The URL '${String(scriptURL)}' is invalid.`,
          'SyntaxError',
        );
      }
      let source: Uint8Array | null = null;
      if (url.protocol === 'blob:') {
        // The creator's blob URL store resolves it now (HTML: the URL's blob entry is looked up when parsing).
        const blob = G.blobUrls.resolve(url.href);
        if (!blob) {
          // A revoked/unknown blob URL: the fetch fails, so the worker fires `error` (no exception).
          this.#dead = true;
          (g.setTimeout as (f: () => void, ms: number) => unknown)(() => {
            G.events.dispatchTrusted(this, new EventCtor('error'));
          }, 0);
          return;
        }
        source = G.blobBytes(blob);
      }
      const [id, port] = N.create(
        url.href,
        type as 'classic' | 'module',
        name,
        source,
        deviceInfo(),
      );
      this.#id = id;
      this.#port = port;
      workers.set(id, this);
      strongTargets.set(port, this);
    }
    postMessage(message: unknown, transfer: unknown = undefined): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'postMessage' on 'Worker': 1 argument required, but only 0 present.",
        );
      }
      if (this.#dead) return;
      sendMessage(this.#port, message, transfer, null, 'Worker');
    }
    terminate(): void {
      if (this.#dead) return;
      this.#dead = true;
      N.terminate(this.#id);
      workers.delete(this.#id);
      strongTargets.delete(this.#port);
    }
  }
  Object.defineProperty(Worker.prototype, Symbol.toStringTag, {
    value: 'Worker',
    configurable: true,
  });
  for (const t of ['message', 'messageerror', 'error'])
    G.events.defineEventHandler(Worker.prototype, t);

  // ---------------------------------------------------------------------------------------------------------------
  // Native events

  function reportUnhandledWorkerError(info: {
    message: string;
    filename: string;
    lineno: number;
    colno: number;
    label: string;
  }): void {
    // HTML §10.2.5: not cancelled at the Worker object -> report again one level up (this global).
    let notCancelled = true;
    if (ErrorEventCtor) {
      const ev = new ErrorEventCtor('error', {
        message: info.message,
        filename: info.filename,
        lineno: info.lineno,
        colno: info.colno,
        error: null,
        cancelable: true,
      });
      notCancelled = G.events.dispatchTrusted(
        global as unknown as EventTarget,
        ev,
      );
    }
    if (!notCancelled) return;
    if (isWorker && N.forwardError) {
      N.forwardError(info.message, info.filename, info.lineno, info.colno);
      return;
    }
    const where = info.filename
      ? `\n    at ${info.filename}:${info.lineno}:${info.colno}`
      : '';
    log(3, `[${info.label}] Uncaught ${info.message}${where}`);
  }

  function dispatch(kind: string, ...args: unknown[]): void {
    switch (kind) {
      case 'message':
      case 'messageerror': {
        const port = args[0] as number;
        const portIds = (kind === 'message' ? args[2] : args[1]) as number[];
        const tokens = (kind === 'message' ? args[3] : args[2]) as number[];
        const state = receiveState(portIds);
        const target = targetOf(port);
        if (target) {
          const init: MessageEventInit = {
            ports: state.ports as unknown as MessagePortLike[],
          } as MessageEventInit;
          if (kind === 'message') init.data = args[1];
          G.events.dispatchTrusted(target, new MessageEventCtor(kind, init));
        }
        // ImageBitmap tokens nobody imported (a bitmap in the transfer list but not in the data) are released.
        const unused = (tokens ?? []).filter((t) => !state.imported.has(t));
        if (unused.length) discardTokens(unused);
        break;
      }
      case 'error': {
        const w = workers.get(args[0] as number);
        const info = args[1] as {
          message: string;
          filename: string;
          lineno: number;
          colno: number;
          label: string;
        };
        let notCancelled = true;
        if (w && ErrorEventCtor) {
          const ev = new ErrorEventCtor('error', {
            message: info.message,
            filename: info.filename,
            lineno: info.lineno,
            colno: info.colno,
            error: null,
            cancelable: true,
          });
          notCancelled = G.events.dispatchTrusted(w, ev);
        }
        if (notCancelled) reportUnhandledWorkerError(info);
        break;
      }
      case 'loaderror': {
        const w = workers.get(args[0] as number);
        if (w) G.events.dispatchTrusted(w, new EventCtor('error'));
        break;
      }
      case 'exit': {
        const id = args[0] as number;
        const w = workers.get(id);
        if (w) {
          const s = workerState(w);
          s.dead = true;
          strongTargets.delete(s.port);
          workers.delete(id);
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Globals

  const def = (target: object, name: string, value: unknown): void => {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  def(global, 'MessagePort', MessagePort);
  def(global, 'MessageChannel', MessageChannel);
  def(global, 'Worker', Worker);

  // Cross-origin isolation is a packaging policy here (config workers.crossOriginIsolated, default true): it decides
  // whether SharedArrayBuffer can be posted between threads (WRK-5 decision in runtime/workers/README.md).
  Object.defineProperty(global, 'crossOriginIsolated', {
    get: () => info.crossOriginIsolated,
    configurable: true,
    enumerable: true,
  });

  // WRK-12: navigator.hardwareConcurrency is capped (pools sized from it stay small). The worker's navigator gets
  // the capped value through device.info(); the page's getter is wrapped here.
  const nav = g.navigator as object | undefined;
  if (nav && !isWorker) {
    for (let p: object | null = nav; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, 'hardwareConcurrency');
      if (d && d.get) {
        const orig = d.get;
        Object.defineProperty(p, 'hardwareConcurrency', {
          ...d,
          get(this: unknown) {
            const n = Number(orig.call(this));
            return Math.max(
              1,
              Math.min(Number.isFinite(n) ? n : 1, info.hardwareConcurrencyCap),
            );
          },
        });
        break;
      }
    }
  }

  if (isWorker) installWorkerScope();

  function installWorkerScope(): void {
    const insidePort = info.insidePort as number;
    // The worker global receives its implicit port's messages (HTML: the global is the port's event target).
    strongTargets.set(insidePort, global as unknown as EventTarget);

    // WorkerGlobalScope / DedicatedWorkerGlobalScope interfaces on the global's prototype chain.
    const illegal = function (): never {
      throw new TypeError('Illegal constructor');
    };
    const WorkerGlobalScope = function WorkerGlobalScope(): never {
      return illegal();
    } as unknown as { prototype: object };
    const DedicatedWorkerGlobalScope =
      function DedicatedWorkerGlobalScope(): never {
        return illegal();
      } as unknown as { prototype: object };
    const current = Object.getPrototypeOf(global) as object | null;
    const wgsProto = Object.create(current);
    const dwgsProto = Object.create(wgsProto);
    Object.defineProperty(wgsProto, 'constructor', {
      value: WorkerGlobalScope,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(wgsProto, Symbol.toStringTag, {
      value: 'WorkerGlobalScope',
      configurable: true,
    });
    Object.defineProperty(dwgsProto, 'constructor', {
      value: DedicatedWorkerGlobalScope,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(dwgsProto, Symbol.toStringTag, {
      value: 'DedicatedWorkerGlobalScope',
      configurable: true,
    });
    WorkerGlobalScope.prototype = wgsProto;
    DedicatedWorkerGlobalScope.prototype = dwgsProto;
    Object.defineProperty(WorkerGlobalScope, 'prototype', { writable: false });
    Object.defineProperty(DedicatedWorkerGlobalScope, 'prototype', {
      writable: false,
    });

    const module = info.type === 'module';
    const methods = {
      postMessage(message: unknown, transfer: unknown = undefined): void {
        if (arguments.length === 0) {
          throw new TypeError(
            "Failed to execute 'postMessage' on 'DedicatedWorkerGlobalScope': 1 argument required, but only 0 present.",
          );
        }
        sendMessage(
          insidePort,
          message,
          transfer,
          null,
          'DedicatedWorkerGlobalScope',
        );
      },
      close(): void {
        N.closeSelf!();
      },
      importScripts(...urls: unknown[]): void {
        // HTML §10.3.4: module workers throw; classic workers fetch and run each URL in order, synchronously.
        if (module) {
          throw new TypeError(
            "Failed to execute 'importScripts' on 'WorkerGlobalScope': Module scripts don't support importScripts().",
          );
        }
        const base = info.url ?? '';
        const resolved = urls.map((u) => {
          try {
            return new (g.URL as typeof URL)(String(u), base).href;
          } catch {
            throw domException(
              `Failed to execute 'importScripts' on 'WorkerGlobalScope': The URL '${String(u)}' is invalid.`,
              'SyntaxError',
            );
          }
        });
        const sources = resolved.map((href) => {
          if (href.startsWith('blob:')) {
            const blob = G.blobUrls.resolve(href);
            if (!blob) {
              throw domException(
                `Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '${href}' failed to load.`,
                'NetworkError',
              );
            }
            return new (g.TextDecoder as typeof TextDecoder)().decode(
              G.blobBytes(blob),
            );
          }
          return N.readScript!(href);
        });
        for (let i = 0; i < resolved.length; i++)
          N.evalScript!(sources[i]!, resolved[i]!);
      },
    };
    def(dwgsProto, 'postMessage', methods.postMessage);
    def(dwgsProto, 'close', methods.close);
    Object.defineProperty(dwgsProto, 'name', {
      get: () => info.name ?? '',
      configurable: true,
      enumerable: true,
    });
    def(wgsProto, 'importScripts', methods.importScripts);
    // The native stubs defined these as own properties before the preludes ran; the prototype versions replace them.
    for (const n of [
      'importScripts',
      'WorkerGlobalScope',
      'DedicatedWorkerGlobalScope',
    ])
      delete (global as AnyRecord)[n];
    // Window-only members the core bootstrap installs everywhere (HTML: requestIdleCallback is a Window API).
    for (const n of ['requestIdleCallback', 'cancelIdleCallback'])
      delete (global as AnyRecord)[n];
    def(global, 'WorkerGlobalScope', WorkerGlobalScope);
    def(global, 'DedicatedWorkerGlobalScope', DedicatedWorkerGlobalScope);
    Object.setPrototypeOf(global, dwgsProto);
  }

  const registry: WorkersRegistry = {
    version: 1,
    scope: isWorker ? 'worker' : 'window',
    info: () => N.info(),
    stats: () => N.stats(),
  };
  Object.defineProperty(global, REGISTRY_KEY, {
    value: registry,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return registry;
}

// MessageEventInit's `ports` is typed for the DOM's MessagePort; the runtime's ports are structurally compatible.
type MessagePortLike = MessagePort;
