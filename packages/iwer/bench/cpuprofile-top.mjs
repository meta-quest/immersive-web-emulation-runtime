/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Prints the functions with the most self time in a .cpuprofile written by
// `node --cpu-prof` (see host-bench.mjs).
//
//   node bench/cpuprofile-top.mjs /tmp/prof/CPU.*.cpuprofile [count]

import { readFileSync } from 'node:fs';

const [file, countArg] = process.argv.slice(2);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const deltas = profile.timeDeltas;
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const node = byId.get(profile.samples[i]);
  const dt = deltas[i] ?? 0;
  total += dt;
  const f = node.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + dt);
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
for (const [key, us] of rows.slice(0, Number(countArg ?? 30))) {
  console.log(`${((100 * us) / total).toFixed(1).padStart(5)}%  ${key}`);
}
