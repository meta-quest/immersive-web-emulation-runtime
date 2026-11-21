/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `node:assert/strict` subset for the on-device bundle.
function fail(msg: string): never {
  const e = new Error(msg);
  e.name = 'AssertionError';
  throw e;
}
function show(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) =>
      ArrayBuffer.isView(x) ? Array.from(x as unknown as ArrayLike<number>) : x,
    );
  } catch {
    return String(v);
  }
}
function deep(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  )
    return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (
    ka.length !== kb.length ||
    Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)
  )
    return false;
  return ka.every((k) =>
    deep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
const assert = {
  equal(a: unknown, b: unknown, msg?: string): void {
    if (!Object.is(a, b)) fail(`${msg ?? 'equal'}: ${show(a)} !== ${show(b)}`);
  },
  notEqual(a: unknown, b: unknown, msg?: string): void {
    if (Object.is(a, b)) fail(`${msg ?? 'notEqual'}: ${show(a)}`);
  },
  deepEqual(a: unknown, b: unknown, msg?: string): void {
    if (!deep(a, b)) fail(`${msg ?? 'deepEqual'}: ${show(a)} vs ${show(b)}`);
  },
  ok(v: unknown, msg?: string): void {
    if (!v) fail(msg ?? `ok: ${show(v)}`);
  },
  throws(fn: () => unknown, check?: unknown, msg?: string): void {
    try {
      fn();
    } catch (e) {
      if (
        typeof check === 'function' &&
        check.prototype &&
        !(e instanceof (check as new () => unknown))
      ) {
        if (!(check as (e: unknown) => boolean)(e))
          fail(msg ?? `throws: wrong error ${String(e)}`);
      }
      return;
    }
    fail(msg ?? 'throws: did not throw');
  },
};
export default assert;
