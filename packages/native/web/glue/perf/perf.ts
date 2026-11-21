/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `npm run perf`: absolute timings of the glue's heavy paths on this machine (best of five), with the
// budgets measured on an idle development machine. Not part of `npm run verify`: absolute bounds
// flake on a shared, loaded host. Exit code 1 when a budget is exceeded.

import { createGlueContext, fakeNatives } from '../test/harness.ts';

const { natives } = fakeNatives({
  clone: {
    structuredClone: (v: unknown, t: unknown[]) =>
      structuredClone(v, { transfer: t as never }),
  },
});
const { run } = await createGlueContext({ natives });
run(`
  globalThis.ascii = new Uint8Array(8 << 20).fill(97);
  globalThis.mixed = new TextEncoder().encode('héllo wörld 漢字 😀 '.repeat(400000));
  globalThis.bin = String.fromCharCode(...new Uint8Array(4096).map((_, i) => i & 255)).repeat(1024);
  globalThis.b64 = btoa(bin);
  globalThis.objs = Array.from({ length: 20000 }, (_, i) => ({ a: i, b: 'x' + i, c: [i, i + 1], d: { e: i } }));
  globalThis.nums = Array.from({ length: 1e6 }, (_, i) => i);
  globalThis.sparse = []; sparse.length = 1e8; sparse[3] = { x: 1 }; sparse[5e7] = 2;
  globalThis.blob16 = new Blob([new Uint8Array(16 << 20)]);
  globalThis.best = (f) => { let m = Infinity; for (let k = 0; k < 5; k++) { const t0 = performance.now(); f(); m = Math.min(m, performance.now() - t0); } return Math.round(m * 10) / 10; };
`);
const cases: [string, string, number][] = [
  ['decode 8 MB ASCII', `new TextDecoder().decode(ascii)`, 150],
  ['decode mixed UTF-8', `new TextDecoder().decode(mixed)`, 300],
  ['btoa 4 MB', `btoa(bin)`, 250],
  ['atob 4 MB', `atob(b64)`, 250],
  ['structuredClone 20k objects (routed)', `structuredClone(objs)`, 150],
  ['structuredClone 1e6 numbers (routed)', `structuredClone(nums)`, 250],
  [
    '  reference: bare hook, 20k objects',
    `__iwn.clone.structuredClone(objs, [])`,
    Infinity,
  ],
  [
    '  reference: bare hook, 1e6 numbers',
    `__iwn.clone.structuredClone(nums, [])`,
    Infinity,
  ],
  ['structuredClone sparse length 1e8', `structuredClone(sparse)`, 50],
  [
    'structuredClone 20k objects (JS path)',
    `structuredClone([objs, new Blob([])])`,
    300,
  ],
];
let failed = 0;
for (const [name, code, budget] of cases) {
  const ms = run<number>(`best(() => ${code})`);
  const ok = ms <= budget;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'SLOW'} ${name}: ${ms} ms (budget ${budget} ms)`,
  );
}
process.exitCode = failed ? 1 : 0;
