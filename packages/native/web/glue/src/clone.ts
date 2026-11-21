/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// structuredClone (HTML §2.7.3-2.7.10: StructuredSerializeWithTransfer + StructuredDeserializeWithTransfer
// in one realm), TMR-3 / WRK-5's value set: primitives, boxed primitives, Date, RegExp, ArrayBuffer
// (resizable too), typed arrays, DataView, Map, Set, Error types (name, message, cause, stack),
// arrays (holes kept), plain objects, cycles; platform objects through a registry (Blob, File and
// DOMException here; ImageData / ImageBitmap / MessagePort register from their own modules).
// Transfer detaches ArrayBuffers; nothing is detached when serialization throws.
//
// With a host `__iwn.clone` (v8::ValueSerializer, no host-object delegate) the global structuredClone
// uses it for graphs of plain data and keeps this implementation for graphs holding platform objects
// (createStructuredClone below).
//
// Known gaps of the JS path: a live Proxy is cloned through its traps (JS cannot detect a Proxy; V8's
// serializer throws DataCloneError, and so does the global structuredClone whenever the native hook is
// there, see createStructuredClone); an object made with
// Object.create() from a refused built-in's prototype (Promise, an iterator) throws DataCloneError
// where V8 clones `{}` (no side-effect-free brand check exists); a Map/Set/ArrayBuffer whose prototype was
// replaced clones as a plain object; a length-tracking view on a resizable buffer comes back
// fixed-length; WebAssembly.Module comes back as the same object; a non-detachable buffer in the
// transfer list is found only after earlier entries were detached.

import { type DOMException, domException } from './dom-exception.ts';

/** A platform object type the glue (or another stream) makes serializable. */
export interface CloneableType {
  is(value: object): boolean;
  /** Returns the copy; `inner` clones nested values with the same memory. */
  clone(value: object, inner: (v: unknown) => unknown): unknown;
}

/** A platform object type that can be transferred (e.g. ImageBitmap, MessagePort). */
export interface TransferableType {
  is(value: object): boolean;
  /** Detaches `value` and returns the object the receiver gets. Throws DataCloneError if detached. */
  transfer(value: object): unknown;
}

const cloneables: CloneableType[] = [];
const transferables: TransferableType[] = [];
const nonSerializable: ((value: object) => boolean)[] = [];

export const cloneRegistry = {
  registerCloneable(t: CloneableType): void {
    cloneables.push(t);
  },
  registerTransferable(t: TransferableType): void {
    transferables.push(t);
  },
  /** Marks platform objects that must throw DataCloneError (DOM stand-ins, EventTargets, ...). */
  registerNonSerializable(test: (value: object) => boolean): void {
    nonSerializable.push(test);
  },
};

function dataCloneError(what: string): DOMException {
  return domException(
    `Failed to execute 'structuredClone' on 'Window': ${what} could not be cloned.`,
    'DataCloneError',
  );
}

// Brand checks: each one calls an intrinsic that throws on the wrong receiver. Throwing is slow
// (~4 µs), so serialize() first narrows the candidate with Object.prototype.toString / ArrayBuffer.isView
// and only calls the matching check, which then succeeds and is cheap.
const brand =
  (fn: (v: unknown) => unknown): ((v: unknown) => boolean) =>
  (v) => {
    try {
      fn(v);
      return true;
    } catch {
      return false;
    }
  };
const getter = (
  proto: object,
  name: string | symbol,
): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(proto, name)!.get! as (
    this: unknown,
  ) => unknown;

const abByteLength = getter(ArrayBuffer.prototype, 'byteLength');
const isArrayBuffer = brand((v) => abByteLength.call(v));
const sabByteLength =
  typeof SharedArrayBuffer === 'function'
    ? getter(SharedArrayBuffer.prototype, 'byteLength')
    : null;
const isSharedArrayBuffer = sabByteLength
  ? brand((v) => sabByteLength.call(v))
  : () => false;
const isBoolean = brand((v) => Boolean.prototype.valueOf.call(v));
const isNumber = brand((v) => Number.prototype.valueOf.call(v));
const isString = brand((v) => String.prototype.valueOf.call(v));
const isBigInt = brand((v) => BigInt.prototype.valueOf.call(v));
const isSymbolObject = brand((v) => Symbol.prototype.valueOf.call(v));
const isDate = brand((v) => Date.prototype.getTime.call(v));
const regexpFlags = getter(RegExp.prototype, 'flags');
const regexpSource = getter(RegExp.prototype, 'source');
const isRegExp = (v: object): boolean =>
  v !== RegExp.prototype && brand((x) => regexpSource.call(x))(v);
const mapSize = getter(Map.prototype, 'size');
const isMap = brand((v) => mapSize.call(v));
const setSize = getter(Set.prototype, 'size');
const isSet = brand((v) => setSize.call(v));
// Returns the typed array's name, or undefined (no throw) for anything else, including DataView.
const typedArrayTag = getter(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag,
);
const isErrorIntrinsic = (Error as { isError?: (v: unknown) => boolean })
  .isError;
const wasmModuleExports = (
  globalThis as { WebAssembly?: { Module?: { exports(m: unknown): unknown } } }
).WebAssembly?.Module?.exports;
const isWasmModule = (v: object): boolean =>
  !!wasmModuleExports && brand((x) => wasmModuleExports(x))(v);
const objectToString = Object.prototype.toString;
const objectTag = (v: object): string =>
  (objectToString.call(v) as string).slice(8, -1);
const getProto = Object.getPrototypeOf;
const OBJECT_PROTO = Object.prototype;
const ARRAY_PROTO = Array.prototype;
const ERROR_NAMES = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
// Objects with internal slots V8's serializer refuses (it throws DataCloneError for them, as browsers do).
const NO_SLOTS_TAGS = new Set([
  'Promise',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'Generator',
  'AsyncGenerator',
  'AsyncFunction',
  'GeneratorFunction',
  'Iterator Helper',
  'Module',
  'WebAssembly.Instance',
  'WebAssembly.Memory',
  'WebAssembly.Table',
  'WebAssembly.Global',
  'WebAssembly.Tag',
  'WebAssembly.Exception',
]);
// Tag-gated forms that do not throw for the common non-matching case.
const isAB = (v: object): boolean =>
  objectTag(v) === 'ArrayBuffer' && isArrayBuffer(v);
const isSAB = (v: object): boolean =>
  objectTag(v) === 'SharedArrayBuffer' && isSharedArrayBuffer(v);
const isCandidateTag = (t: string): boolean =>
  NO_SLOTS_TAGS.has(t) ||
  t.startsWith('Intl.') ||
  t.endsWith(' Iterator') ||
  t.startsWith('Temporal.');

// The built-in prototypes that own those tags. A tag only means "V8 refuses this object" when it comes
// from one of them: a plain object with its own `Symbol.toStringTag` (a Rollup namespace object, a
// user "Foo Iterator") is ordinary data that V8 clones property by property.
const TAG_OWNERS = new Map<object, ((v: object) => boolean) | null>();
// Built-in prototypes without a @@toStringTag whose objects V8 refuses, with their brand checks.
const TAGLESS = new Map<object, (v: object) => boolean>();
{
  const G = globalThis as unknown as Record<string, unknown>;
  const owner = (
    proto: unknown,
    check: ((v: object) => boolean) | null = null,
  ): void => {
    if (proto !== null && typeof proto === 'object')
      TAG_OWNERS.set(proto, check);
  };
  const protoOf = (C: unknown): unknown =>
    typeof C === 'function'
      ? (C as { prototype: unknown }).prototype
      : undefined;
  const tryGet = (f: () => unknown): unknown => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  owner(Promise.prototype);
  owner(
    WeakMap.prototype,
    brand((v) =>
      WeakMap.prototype.has.call(v as WeakMap<object, unknown>, OBJECT_PROTO),
    ),
  );
  owner(
    WeakSet.prototype,
    brand((v) =>
      WeakSet.prototype.has.call(v as WeakSet<object>, OBJECT_PROTO),
    ),
  );
  const WR = G.WeakRef as { prototype: { deref(): unknown } } | undefined;
  if (WR)
    owner(
      WR.prototype,
      brand((v) => WR.prototype.deref.call(v)),
    );
  const FR = G.FinalizationRegistry as
    | { prototype: { unregister(t: object): boolean } }
    | undefined;
  if (FR)
    owner(
      FR.prototype,
      brand((v) => FR.prototype.unregister.call(v, {})),
    );
  // %GeneratorFunction.prototype%.prototype is %GeneratorPrototype% (owns the 'Generator' tag).
  owner(
    tryGet(
      () => (getProto(function* () {}) as { prototype: unknown }).prototype,
    ),
  );
  owner(
    tryGet(
      () =>
        (getProto(async function* () {}) as { prototype: unknown }).prototype,
    ),
  );
  owner(getProto([][Symbol.iterator]()));
  owner(getProto(new Map().entries()));
  owner(getProto(new Set().values()));
  owner(getProto(''[Symbol.iterator]()));
  owner(tryGet(() => getProto(/a/g[Symbol.matchAll]('a'))));
  const It = G.Iterator as
    | {
        prototype?: {
          map?: (this: unknown, f: (x: unknown) => unknown) => unknown;
        };
      }
    | undefined;
  if (typeof It?.prototype?.map === 'function')
    owner(
      tryGet(() =>
        getProto(It.prototype!.map!.call([][Symbol.iterator](), (x) => x)),
      ),
    );
  const Intl = G.Intl as Record<string, unknown> | undefined;
  if (Intl) {
    for (const k of Object.getOwnPropertyNames(Intl)) {
      const P = protoOf(Intl[k]) as
        | { resolvedOptions?: (this: unknown) => unknown }
        | undefined;
      if (P && typeof P.resolvedOptions === 'function') {
        const ro = P.resolvedOptions;
        owner(
          P,
          brand((v) => ro.call(v)),
        );
      }
    }
    const Seg = Intl.Segmenter as
      | (new () => { segment(s: string): Iterable<unknown> })
      | undefined;
    if (typeof Seg === 'function') {
      owner(tryGet(() => getProto(new Seg().segment('')[Symbol.iterator]())));
      // %IntlSegmentsPrototype% has no @@toStringTag (its objects read as "Object"): TAGLESS below.
      const SP = tryGet(() => getProto(new Seg().segment(''))) as
        | { containing?: (this: unknown, i: number) => unknown }
        | undefined;
      if (SP && typeof SP.containing === 'function') {
        const containing = SP.containing;
        TAGLESS.set(
          SP,
          brand((v) => containing.call(v, 0)),
        );
      }
    }
  }
  const WA = G.WebAssembly as Record<string, unknown> | undefined;
  if (WA)
    for (const k of [
      'Instance',
      'Memory',
      'Table',
      'Global',
      'Tag',
      'Exception',
    ])
      owner(protoOf(WA[k]));
  const T = G.Temporal as Record<string, unknown> | undefined;
  if (T) for (const k of Object.getOwnPropertyNames(T)) owner(protoOf(T[k]));
}

/**
 * A module namespace object (V8 refuses it): its own tag 'Module' is non-writable and non-configurable,
 * it has a null prototype, is not extensible, and its exports read as writable, non-configurable data
 * properties (an uninitialized export throws ReferenceError). A frozen Rollup/esbuild namespace object
 * has non-writable exports (or accessors), so it stays plain data.
 */
function isModuleNamespace(v: object): boolean {
  if (getProto(v) !== null || Object.isExtensible(v)) return false;
  const t = Object.getOwnPropertyDescriptor(v, Symbol.toStringTag);
  if (!t || t.writable || t.configurable || t.value !== 'Module') return false;
  for (const k of Object.getOwnPropertyNames(v)) {
    let d: PropertyDescriptor | undefined;
    try {
      d = Object.getOwnPropertyDescriptor(v, k);
    } catch {
      return true; // an export still in its temporal dead zone
    }
    if (!d || !('value' in d) || !d.writable || d.configurable) return false;
  }
  return true;
}

/** Whether some object on `v`'s prototype chain (or `v`) has an own Symbol.toStringTag property. */
function hasTagProperty(v: object): boolean {
  for (let o: object | null = v; o !== null; o = getProto(o) as object | null) {
    if (Object.getOwnPropertyDescriptor(o, Symbol.toStringTag)) return true;
  }
  return false;
}

/**
 * Whether V8's serializer refuses `v`: an object whose tag is one of NO_SLOTS_TAGS, Intl.*, ... from
 * the built-in that owns it, an arguments object (builtin tag "Arguments", no @@toStringTag anywhere
 * on its chain), or an Intl Segments object.
 */
function isUnserializable(v: object, tagName: string): boolean {
  if (tagName === 'Arguments') return !hasTagProperty(v);
  if (tagName === 'Object') {
    const check = TAGLESS.get(getProto(v) as object);
    return !!check && check(v);
  }
  if (!isCandidateTag(tagName)) return false;
  if (tagName === 'Module') return isModuleNamespace(v);
  let o: object | null = v;
  while (o !== null) {
    if (Object.getOwnPropertyDescriptor(o, Symbol.toStringTag)) {
      if (!TAG_OWNERS.has(o)) return false;
      const check = TAG_OWNERS.get(o);
      return check ? check(v) : true;
    }
    o = getProto(o) as object | null;
  }
  return false;
}

type Rec =
  | { t: 'prim'; v: unknown }
  | { t: 'ref'; id: number }
  | { t: 'box'; id: number; v: unknown }
  | { t: 'date'; id: number; v: number }
  | { t: 're'; id: number; source: string; flags: string }
  | { t: 'ab'; id: number; bytes: ArrayBuffer }
  | { t: 'abx'; id: number; index: number }
  | {
      t: 'view';
      id: number;
      kind: string;
      buffer: Rec;
      offset: number;
      length: number | null;
    }
  | { t: 'map'; id: number; entries: [Rec, Rec][] }
  | { t: 'set'; id: number; values: Rec[] }
  | {
      t: 'err';
      id: number;
      name: string;
      message?: string;
      cause?: Rec;
      hasCause: boolean;
      stack?: string;
    }
  | { t: 'arr'; id: number; length: number; props: [string, Rec][] }
  | { t: 'obj'; id: number; props: [string, Rec][] }
  | { t: 'host'; id: number; type: CloneableType; value: object }
  | { t: 'hostx'; id: number; index: number }
  | { t: 'same'; id: number; value: object };

function serialize(
  value: unknown,
  memory: Map<object, number>,
  transferIndex: Map<object, number>,
): Rec {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    if (typeof value === 'symbol') throw dataCloneError(String(value));
    return { t: 'prim', v: value };
  }
  if (typeof value === 'function')
    throw dataCloneError(`${String(value).slice(0, 60)}`);
  const obj = value as object;
  const seen = memory.get(obj);
  if (seen !== undefined) return { t: 'ref', id: seen };
  const id = memory.size;
  memory.set(obj, id);
  const ti = transferIndex.get(obj);
  if (ti !== undefined) {
    return isAB(obj)
      ? { t: 'abx', id, index: ti }
      : { t: 'hostx', id, index: ti };
  }

  // Fast paths: plain objects and arrays (the bulk of cloned data) skip the registry and brand checks.
  let proto: object | null;
  try {
    proto = getProto(obj) as object | null;
  } catch {
    // Only a Proxy (a revoked one, or a throwing getPrototypeOf trap) throws here, and V8 refuses
    // every Proxy with DataCloneError.
    throw dataCloneError('A Proxy');
  }
  if (proto === ARRAY_PROTO && Array.isArray(obj))
    return serializeArray(obj as unknown[], id, memory, transferIndex);
  const tagName = objectTag(obj);
  if ((proto === OBJECT_PROTO || proto === null) && tagName === 'Object')
    return serializeObject(obj, id, memory, transferIndex);

  // Typed arrays and DataViews (exact, non-throwing check) are never platform objects.
  if (ArrayBuffer.isView(obj)) {
    const view = obj as ArrayBufferView;
    const kind = (typedArrayTag.call(obj) as string | undefined) ?? 'DataView';
    if (isSAB(view.buffer)) throw dataCloneError('SharedArrayBuffer');
    const buffer = serialize(view.buffer, memory, transferIndex);
    const length =
      kind === 'DataView' ? view.byteLength : (view as Uint8Array).length;
    return { t: 'view', id, kind, buffer, offset: view.byteOffset, length };
  }
  if (tagName !== 'ArrayBuffer' || !isArrayBuffer(obj)) {
    for (const c of cloneables)
      if (c.is(obj)) return { t: 'host', id, type: c, value: obj };
    for (const test of nonSerializable)
      if (test(obj)) throw dataCloneError(`#<${tagName}>`);
  }

  switch (tagName) {
    case 'Boolean':
      if (isBoolean(obj))
        return { t: 'box', id, v: Boolean.prototype.valueOf.call(obj) };
      break;
    case 'Number':
      if (isNumber(obj))
        return { t: 'box', id, v: Number.prototype.valueOf.call(obj) };
      break;
    case 'BigInt':
      if (isBigInt(obj))
        return { t: 'box', id, v: BigInt.prototype.valueOf.call(obj) };
      break;
    case 'String':
      if (isString(obj))
        return { t: 'box', id, v: String.prototype.valueOf.call(obj) };
      break;
    case 'Symbol':
      if (isSymbolObject(obj)) throw dataCloneError('Symbol object');
      break;
    case 'Date':
      if (isDate(obj))
        return { t: 'date', id, v: Date.prototype.getTime.call(obj) };
      break;
    case 'RegExp':
      if (isRegExp(obj)) {
        return {
          t: 're',
          id,
          source: regexpSource.call(obj) as string,
          flags: regexpFlags.call(obj) as string,
        };
      }
      break;
    case 'SharedArrayBuffer':
      // crossOriginIsolated is false in this runtime (DOM-1), so SharedArrayBuffer is not serializable.
      if (isSharedArrayBuffer(obj)) throw dataCloneError('SharedArrayBuffer');
      break;
    case 'ArrayBuffer':
      if (isArrayBuffer(obj)) {
        const ab = obj as ArrayBuffer;
        if (ab.detached) throw dataCloneError('A detached ArrayBuffer');
        let copy: ArrayBuffer;
        if (ab.resizable) {
          copy = new ArrayBuffer(ab.byteLength, {
            maxByteLength: ab.maxByteLength,
          });
          new Uint8Array(copy).set(new Uint8Array(ab));
        } else {
          copy = ab.slice(0);
        }
        return { t: 'ab', id, bytes: copy };
      }
      break;
    case 'Map':
      if (isMap(obj)) {
        const copied = Array.from(
          Map.prototype.entries.call(obj as Map<unknown, unknown>),
        );
        const entries: [Rec, Rec][] = [];
        for (const [k, v] of copied)
          entries.push([
            serialize(k, memory, transferIndex),
            serialize(v, memory, transferIndex),
          ]);
        return { t: 'map', id, entries };
      }
      break;
    case 'Set':
      if (isSet(obj)) {
        const copied = Array.from(
          Set.prototype.values.call(obj as Set<unknown>),
        );
        const values: Rec[] = [];
        for (const v of copied)
          values.push(serialize(v, memory, transferIndex));
        return { t: 'set', id, values };
      }
      break;
    case 'Error':
      // [[ErrorData]] objects only (Object.create(Error.prototype) has tag "Object" and clones as one).
      if (!isErrorIntrinsic || isErrorIntrinsic(obj))
        return serializeError(obj, id, memory, transferIndex);
      break;
    case 'WebAssembly.Module':
      // Known gap: browsers and V8 give a new Module sharing the compiled code; JS cannot make one
      // without the bytes, so the same object is returned (the native clone path does it properly).
      if (isWasmModule(obj)) return { t: 'same', id, value: obj };
      break;
    default:
      // An Error with its own Symbol.toStringTag is still an Error to V8 (Error.isError checks the slot).
      if (isErrorIntrinsic?.(obj))
        return serializeError(obj, id, memory, transferIndex);
      if (isUnserializable(obj, tagName)) throw dataCloneError(`#<${tagName}>`);
  }
  if (Array.isArray(obj))
    return serializeArray(obj as unknown[], id, memory, transferIndex);
  return serializeObject(obj, id, memory, transferIndex);
}

/** Object.keys; it throws only for a Proxy (a throwing ownKeys or getOwnPropertyDescriptor trap), which V8 refuses. */
function ownKeys(obj: object): string[] {
  try {
    return Object.keys(obj);
  } catch {
    throw dataCloneError('A Proxy');
  }
}

/** Object.hasOwn; like Object.keys it throws only for a Proxy (getOwnPropertyDescriptor trap). */
function hasOwn(obj: object, k: string): boolean {
  try {
    return Object.hasOwn(obj, k);
  } catch {
    throw dataCloneError('A Proxy');
  }
}

function serializeError(
  obj: object,
  id: number,
  memory: Map<object, number>,
  transferIndex: Map<object, number>,
): Rec {
  const nameProp = (obj as Error).name;
  const name =
    typeof nameProp === 'string' && ERROR_NAMES.has(nameProp)
      ? nameProp
      : 'Error';
  const msgDesc = Object.getOwnPropertyDescriptor(obj, 'message');
  const causeDesc = Object.getOwnPropertyDescriptor(obj, 'cause');
  const rec: Rec = {
    t: 'err',
    id,
    name,
    hasCause: !!causeDesc && 'value' in causeDesc,
  };
  if (msgDesc && 'value' in msgDesc) rec.message = String(msgDesc.value);
  if (rec.hasCause)
    rec.cause = serialize(causeDesc!.value, memory, transferIndex);
  const stack = (obj as Error).stack;
  if (typeof stack === 'string') rec.stack = stack;
  return rec;
}

function serializeArray(
  arr: unknown[],
  id: number,
  memory: Map<object, number>,
  transferIndex: Map<object, number>,
): Rec {
  const length = arr.length;
  const props: [string, Rec][] = [];
  for (const k of ownKeys(arr)) {
    if (hasOwn(arr, k))
      props.push([
        k,
        serialize(
          (arr as unknown as Record<string, unknown>)[k],
          memory,
          transferIndex,
        ),
      ]);
  }
  return { t: 'arr', id, length, props };
}

function serializeObject(
  obj: object,
  id: number,
  memory: Map<object, number>,
  transferIndex: Map<object, number>,
): Rec {
  const props: [string, Rec][] = [];
  // HTML: EnumerableOwnProperties, then skip keys an earlier getter deleted (HasOwnProperty).
  for (const k of ownKeys(obj)) {
    if (hasOwn(obj, k))
      props.push([
        k,
        serialize((obj as Record<string, unknown>)[k], memory, transferIndex),
      ]);
  }
  return { t: 'obj', id, props };
}

const VIEW_CTORS: Record<
  string,
  new (b: ArrayBuffer, o: number, l?: number) => ArrayBufferView
> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};
if (
  typeof (globalThis as { Float16Array?: unknown }).Float16Array === 'function'
) {
  VIEW_CTORS.Float16Array = (
    globalThis as unknown as { Float16Array: (typeof VIEW_CTORS)[string] }
  ).Float16Array;
}

function deserialize(
  rec: Rec,
  memory: Map<number, unknown>,
  transferred: unknown[],
): unknown {
  switch (rec.t) {
    case 'prim':
      return rec.v;
    case 'ref':
      return memory.get(rec.id);
    case 'box': {
      const v = Object(rec.v);
      memory.set(rec.id, v);
      return v;
    }
    case 'date': {
      const v = new Date(rec.v);
      memory.set(rec.id, v);
      return v;
    }
    case 're': {
      const v = new RegExp(rec.source, rec.flags);
      memory.set(rec.id, v);
      return v;
    }
    case 'ab':
      memory.set(rec.id, rec.bytes);
      return rec.bytes;
    case 'abx':
    case 'hostx': {
      const v = transferred[rec.index];
      memory.set(rec.id, v);
      return v;
    }
    case 'view': {
      const buffer = deserialize(
        rec.buffer,
        memory,
        transferred,
      ) as ArrayBuffer;
      const C = VIEW_CTORS[rec.kind];
      if (!C) throw dataCloneError(rec.kind);
      const v = new C(buffer, rec.offset, rec.length ?? undefined);
      memory.set(rec.id, v);
      return v;
    }
    case 'map': {
      const v = new Map();
      memory.set(rec.id, v);
      for (const [k, val] of rec.entries)
        v.set(
          deserialize(k, memory, transferred),
          deserialize(val, memory, transferred),
        );
      return v;
    }
    case 'set': {
      const v = new Set();
      memory.set(rec.id, v);
      for (const x of rec.values) v.add(deserialize(x, memory, transferred));
      return v;
    }
    case 'err': {
      const Ctor =
        (globalThis as unknown as Record<string, ErrorConstructor>)[rec.name] ??
        Error;
      const v = new Ctor();
      memory.set(rec.id, v);
      if (rec.message !== undefined) {
        Object.defineProperty(v, 'message', {
          value: rec.message,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
      if (rec.stack !== undefined) {
        Object.defineProperty(v, 'stack', {
          value: rec.stack,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
      if (rec.hasCause) {
        Object.defineProperty(v, 'cause', {
          value: deserialize(rec.cause!, memory, transferred),
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
      return v;
    }
    case 'arr': {
      const v: unknown[] = new Array(rec.length);
      memory.set(rec.id, v);
      for (const [k, r] of rec.props)
        createDataProperty(v, k, deserialize(r, memory, transferred));
      return v;
    }
    case 'obj': {
      const v: Record<string, unknown> = {};
      memory.set(rec.id, v);
      for (const [k, r] of rec.props)
        createDataProperty(v, k, deserialize(r, memory, transferred));
      return v;
    }
    case 'host': {
      const v = rec.type.clone(rec.value, (x) => structuredCloneInner(x));
      memory.set(rec.id, v);
      return v;
    }
    case 'same':
      memory.set(rec.id, rec.value);
      return rec.value;
  }
}

/**
 * CreateDataProperty: plain assignment is equivalent for fresh objects except for an own "__proto__"
 * key, which assignment would turn into the clone's [[Prototype]].
 */
function createDataProperty(target: object, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    (target as Record<string, unknown>)[key] = value;
  }
}

function structuredCloneInner(value: unknown): unknown {
  const rec = serialize(value, new Map(), new Map());
  return deserialize(rec, new Map(), []);
}

function checkOptions(options: unknown): void {
  if (
    options != null &&
    typeof options !== 'object' &&
    typeof options !== 'function'
  ) {
    throw new TypeError(
      "Failed to execute 'structuredClone' on 'Window': The provided value is not of type 'StructuredSerializeOptions'.",
    );
  }
}

/** StructuredSerializeOptions.transfer: `sequence<object>` (default []); null and non-iterables are a TypeError. */
function transferListOf(
  options: { transfer?: Iterable<unknown> } | null | undefined,
): unknown[] {
  if (options == null) return [];
  const t = options.transfer as unknown;
  if (t === undefined) return [];
  if (
    t === null ||
    (typeof t !== 'object' && typeof t !== 'function') ||
    typeof (t as { [Symbol.iterator]?: unknown })[Symbol.iterator] !==
      'function'
  ) {
    throw new TypeError(
      "Failed to execute 'structuredClone' on 'Window': Failed to read the 'transfer' property from 'StructuredSerializeOptions': The provided value cannot be converted to a sequence.",
    );
  }
  return Array.from(t as Iterable<unknown>);
}

/** The glue's own structuredClone (no native hook). */
export function structuredClone(
  value: unknown,
  options?: { transfer?: Iterable<unknown> } | null,
): unknown {
  if (arguments.length === 0) {
    throw new TypeError(
      "Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.",
    );
  }
  checkOptions(options);
  return cloneWithTransfer(value, transferListOf(options));
}

function cloneWithTransfer(value: unknown, list: unknown[]): unknown {
  const transferIndex = new Map<object, number>();
  const kinds: (TransferableType | 'ab')[] = [];
  list.forEach((t, i) => {
    if (t === null || (typeof t !== 'object' && typeof t !== 'function')) {
      throw new TypeError(
        "Failed to execute 'structuredClone' on 'Window': Failed to read the 'transfer' property from 'StructuredSerializeOptions': Failed to convert value to 'object'.",
      );
    }
    if (transferIndex.has(t))
      throw domException(
        `Failed to execute 'structuredClone' on 'Window': ArrayBuffer at index ${i} is a duplicate of an earlier ArrayBuffer.`,
        'DataCloneError',
      );
    if (isSAB(t)) throw dataCloneError('SharedArrayBuffer');
    if (isAB(t)) {
      if ((t as ArrayBuffer).detached) {
        throw domException(
          `Failed to execute 'structuredClone' on 'Window': ArrayBuffer at index ${i} is already detached.`,
          'DataCloneError',
        );
      }
      kinds.push('ab');
    } else {
      const k = transferables.find((x) => x.is(t));
      if (!k) {
        throw domException(
          `Failed to execute 'structuredClone' on 'Window': Value at index ${i} does not have a transferable type.`,
          'DataCloneError',
        );
      }
      kinds.push(k);
    }
    transferIndex.set(t, i);
  });
  const rec = serialize(value, new Map(), transferIndex);
  // Transfer only after serialization succeeded.
  // Known gap: a buffer that cannot be detached (WebAssembly.Memory's) is only found out here, after
  // earlier entries were detached; the native clone path checks IsDetachable() up front.
  const transferred = list.map((t, i) => {
    const k = kinds[i]!;
    try {
      return k === 'ab'
        ? (t as ArrayBuffer).transfer()
        : k.transfer(t as object);
    } catch (e) {
      if (e instanceof TypeError) {
        throw domException(
          `Failed to execute 'structuredClone' on 'Window': Value at index ${i} could not be transferred.`,
          'DataCloneError',
        );
      }
      throw e;
    }
  });
  return deserialize(rec, new Map(), transferred);
}

// ---------------------------------------------------------------------------------------------------
// Native fast path

/** `__iwn.clone.structuredClone`: a v8::ValueSerializer round trip (no host-object delegate). */
export type NativeClone = (
  value: unknown,
  transfer: readonly unknown[],
) => unknown;

/**
 * Whether a clone must take the JS path because V8's serializer would get it wrong: the graph holds a
 * registered platform object (Blob, File, DOMException, ImageData, ImageBitmap, ...; V8 would copy
 * them as `{}` or a plain Error), a non-serializable platform object (V8 would copy `{}` instead of
 * throwing), a SharedArrayBuffer (not serializable here, crossOriginIsolated is false), an accessor
 * property, array element included (the serializer would run the getter a second time), or the
 * transfer list holds anything but ArrayBuffers (ImageBitmap, MessagePort: only the JS path can
 * transfer them). The scan reads property descriptors, never values through [[Get]], so it runs no
 * getters (Proxy traps aside). Tags are only trusted after the matching brand check, so a spoofed
 * `Symbol.toStringTag` cannot hide properties from it.
 *
 * Arrays: indices are walked densely (no string per element) until holes outnumber the elements found
 * by HOLE_BUDGET, then the existing keys are visited instead (a sparse array with length 1e8 costs only
 * its own keys). Non-index properties of a densely walked array are scanned when it has at most
 * NAMED_SCAN elements. Known limit: on a longer, densely walked array they are not (finding them means
 * Object.keys over every element), so a platform object stored as `bigArray.name` takes the native path.
 */
const KNOWN_SCAN_TAGS = new Set([
  'SharedArrayBuffer',
  'Map',
  'Set',
  'Error',
  'Boolean',
  'Number',
  'BigInt',
  'String',
  'Date',
  'RegExp',
  'ArrayBuffer',
  'WebAssembly.Module',
]);
const HOLE_BUDGET = 4096;
const NAMED_SCAN = 4096;
function needsGluePath(value: unknown, transfer: readonly unknown[]): boolean {
  for (const t of transfer) {
    if (t === null || typeof t !== 'object' || !isAB(t)) return true;
  }
  if (value === null || typeof value !== 'object') return false;
  const gopd = Object.getOwnPropertyDescriptor;
  const keys = Object.keys;
  const seen = new Set<object>();
  const stack: object[] = [value];
  let d: PropertyDescriptor | undefined;
  while (stack.length > 0) {
    const v = stack.pop()!;
    if (seen.has(v)) continue;
    seen.add(v);
    const proto = getProto(v);
    const isArr = Array.isArray(v);
    const tagName = isArr && proto === ARRAY_PROTO ? 'Array' : objectTag(v);
    if (
      !(isArr && proto === ARRAY_PROTO) &&
      !((proto === OBJECT_PROTO || proto === null) && tagName === 'Object')
    ) {
      for (const c of cloneables) if (c.is(v)) return true;
      for (const test of nonSerializable) if (test(v)) return true;
      if (ArrayBuffer.isView(v)) {
        if (isSAB((v as ArrayBufferView).buffer)) return true;
        continue;
      }
      let leaf = false;
      // An Error with its own Symbol.toStringTag is an Error to V8 too: scan it as one.
      const caseTag =
        isErrorIntrinsic && !KNOWN_SCAN_TAGS.has(tagName) && isErrorIntrinsic(v)
          ? 'Error'
          : tagName;
      switch (caseTag) {
        case 'SharedArrayBuffer':
          if (isSharedArrayBuffer(v)) return true;
          break;
        case 'Map':
          if (isMap(v)) {
            Map.prototype.forEach.call(
              v as Map<unknown, unknown>,
              (val, key) => {
                if (key !== null && typeof key === 'object') stack.push(key);
                if (val !== null && typeof val === 'object') stack.push(val);
              },
            );
            continue;
          }
          break;
        case 'Set':
          if (isSet(v)) {
            Set.prototype.forEach.call(v as Set<unknown>, (val) => {
              if (val !== null && typeof val === 'object') stack.push(val);
            });
            continue;
          }
          break;
        case 'Error':
          if (!isErrorIntrinsic || isErrorIntrinsic(v)) {
            d = gopd(v, 'cause');
            if (d && (d.get || d.set)) return true;
            if (d && d.value !== null && typeof d.value === 'object')
              stack.push(d.value);
            // Without Error.isError the brand is unknown: scan the own properties as well.
            if (isErrorIntrinsic) continue;
          }
          break;
        case 'Boolean':
          leaf = isBoolean(v);
          break;
        case 'Number':
          leaf = isNumber(v);
          break;
        case 'BigInt':
          leaf = isBigInt(v);
          break;
        case 'String':
          leaf = isString(v);
          break;
        case 'Date':
          leaf = isDate(v);
          break;
        case 'RegExp':
          leaf = isRegExp(v);
          break;
        case 'ArrayBuffer':
          leaf = isArrayBuffer(v);
          break;
        case 'WebAssembly.Module':
          leaf = isWasmModule(v);
          break;
        default:
          // V8 throws DataCloneError for the real ones; a spoofed tag is scanned as plain data below.
          leaf = isUnserializable(v, tagName);
      }
      if (leaf) continue;
    }
    if (isArr) {
      const a = v as unknown[];
      const len = a.length;
      let found = 0;
      let enumerable = 0;
      let holes = 0;
      let i = 0;
      for (; i < len; i++) {
        d = gopd(a, i);
        if (d === undefined) {
          if (++holes > found + HOLE_BUDGET) break;
          continue;
        }
        found++;
        if (d.enumerable) enumerable++;
        if (d.get || d.set) return true;
        const x = d.value;
        if (x !== null && typeof x === 'object') stack.push(x);
      }
      if (i === len) {
        if (len <= NAMED_SCAN) {
          // Object.keys lists the enumerable indices first (ascending), then the named properties.
          const ks = keys(a);
          for (let j = enumerable; j < ks.length; j++) {
            d = gopd(a, ks[j]!);
            if (d === undefined) continue;
            if (d.get || d.set) return true;
            const x = d.value;
            if (x !== null && typeof x === 'object') stack.push(x);
          }
        }
        continue;
      }
      // Mostly holes: visit the keys that exist (indices below i again, harmlessly) and named ones.
    }
    for (const k of keys(v)) {
      d = gopd(v, k);
      if (d === undefined) continue;
      if (d.get || d.set) return true;
      const x = d.value;
      if (x !== null && typeof x === 'object') stack.push(x);
    }
  }
  return false;
}

/**
 * The global `structuredClone`: the native ValueSerializer path when the host has one and the value
 * holds nothing it would mishandle (see needsGluePath), the JS implementation otherwise.
 */
export function createStructuredClone(
  native?: NativeClone,
): typeof structuredClone {
  if (!native) return structuredClone;
  return function structuredClone(
    value: unknown,
    options?: { transfer?: Iterable<unknown> } | null,
  ): unknown {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.",
      );
    }
    checkOptions(options);
    const list = transferListOf(options);
    let js: boolean;
    try {
      js = needsGluePath(value, list);
    } catch {
      // Only a Proxy trap (or a revoked Proxy) throws here, and V8 refuses every Proxy.
      throw dataCloneError('#<Object>');
    }
    if (js) return cloneWithTransfer(value, list);
    const out = native(value, list);
    if (out === undefined && value !== undefined) {
      // The hook must throw DataCloneError, but a host that loses its exception (core clone.cc while
      // its TryCatch is in scope) returns undefined. Nothing was transferred then (the serializer fails
      // before any detach), so find the error on the JS path (functions, symbols, Promise, WeakMap,
      // arguments, ...), or report the one only V8 can see (a Proxy).
      serialize(value, new Map(), new Map());
      throw dataCloneError('#<Object>');
    }
    return out;
  };
}
