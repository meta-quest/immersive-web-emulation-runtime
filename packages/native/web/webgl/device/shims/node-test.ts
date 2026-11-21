/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `node:test` for the on-device bundle: collects test() calls; device/main.ts runs them in order.
export interface Case {
  name: string;
  skip: string | false;
  fn: () => unknown;
}
export const cases: Case[] = [];

export function test(name: string, a?: unknown, b?: unknown): void {
  const fn = (typeof a === 'function' ? a : b) as () => unknown;
  const opts = (typeof a === 'object' && a ? a : {}) as { skip?: string | boolean };
  cases.push({ name, skip: opts.skip ? String(opts.skip) : false, fn });
}
