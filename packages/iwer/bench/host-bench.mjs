/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// One benchmark process: one scenario on one IWER bundle. Prints a JSON
// result on stdout. `run.mjs` drives this across scenarios, bundles and
// repeats; use it directly for profiling:
//
//   node --expose-gc bench/host-bench.mjs --scenario hands
//   node --expose-gc --cpu-prof --cpu-prof-dir=/tmp/prof bench/host-bench.mjs --scenario hands --frames 200000
//   node --expose-gc bench/host-bench.mjs --scenario hands --alloc-sites
//
// Options: --bundle <path to an ES module build of iwer/host or iwer>
// (default build/iwer-host.module.js), --scenario <name|session>,
// --frames N (timed frames), --warmup N, --block N (frames per
// allocation sample), --alloc-sites (sample allocations and print the
// top sites instead of timing).
//
// Timing: each frame is timed with performance.now() into a Float64Array
// (no allocation), after a warmup long enough for V8 to optimize the path.
// Allocation: frames run in blocks with no timing; the V8 heap's used size
// is read before and after each block, blocks during which a GC ran (used
// size went down) are dropped, and the result is bytes per frame. A
// calibration run of the host-side writes alone (the frame record and input
// state, which a native host writes without touching the JS heap) measures
// the probe's and the harness's own cost, which is subtracted.

import { getHeapStatistics } from 'node:v8';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { statSync } from 'node:fs';

import { createScenario, sessionCycle } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    bundle: resolve(here, '../build/iwer-host.module.js'),
    scenario: 'controllers',
    frames: 30000,
    warmup: 20000,
    block: 200,
    allocSites: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--bundle') args.bundle = resolve(next());
    else if (key === '--scenario') args.scenario = next();
    else if (key === '--frames') args.frames = Number(next());
    else if (key === '--warmup') args.warmup = Number(next());
    else if (key === '--block') args.block = Number(next());
    else if (key === '--alloc-sites') args.allocSites = true;
    else throw new Error(`unknown option ${key}`);
  }
  return args;
}

const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

function summarise(samples) {
  const sorted = Float64Array.from(samples).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    mean: sum / sorted.length,
  };
}

const usedHeap = () => getHeapStatistics().used_heap_size;

/** Bytes per call of `fn`, over blocks without a GC. */
function allocPerCall(fn, block, blocks) {
  const perCall = [];
  let dropped = 0;
  for (let b = 0; b < blocks; b++) {
    const before = usedHeap();
    for (let i = 0; i < block; i++) fn();
    const after = usedHeap();
    if (after < before) {
      dropped++;
      continue;
    }
    perCall.push((after - before) / block);
  }
  return { perCall, dropped };
}

async function frameBench(iwer, args) {
  const { step, writeFrame, env } = await createScenario(iwer, args.scenario);
  for (let i = 0; i < args.warmup; i++) step();

  globalThis.gc?.();
  const times = new Float64Array(args.frames);
  for (let i = 0; i < args.frames; i++) {
    const t0 = performance.now();
    step();
    times[i] = performance.now() - t0;
  }
  const ns = summarise(Array.from(times, (ms) => ms * 1e6));
  // the harness's host-side writes alone, timed the same way (reported so
  // the IWER share can be read off: ns minus this)
  for (let i = 0; i < args.frames; i++) {
    const t0 = performance.now();
    writeFrame();
    times[i] = performance.now() - t0;
  }
  const writeNs = summarise(Array.from(times, (ms) => ms * 1e6));

  // allocation: calibration (the probe itself plus the benchmark's own
  // host-side writes, which native code does without the JS heap), then
  // the frame
  globalThis.gc?.();
  const calib = allocPerCall(writeFrame, args.block, 50);
  const calibPerBlock =
    (calib.perCall.length ? summarise(calib.perCall).median : 0) * args.block;
  globalThis.gc?.();
  const blocks = Math.max(20, Math.floor(args.frames / args.block));
  const t0 = performance.now();
  const alloc = allocPerCall(step, args.block, blocks);
  const blockMs = performance.now() - t0;
  const corrected = alloc.perCall.map((v) =>
    Math.max(0, v - calibPerBlock / args.block),
  );
  const a = corrected.length ? summarise(corrected) : null;

  if (env.errors.length) {
    throw env.errors[0].error;
  }
  return {
    ns,
    nsMeanUntimed: (blockMs * 1e6) / (blocks * args.block),
    hostWritesNs: writeNs.median,
    calibrationBytesPerFrame: calibPerBlock / args.block,
    allocBytesPerFrame: a && {
      median: a.median,
      mean: a.mean,
      p95: a.p95,
      blocks: corrected.length,
      droppedForGC: alloc.dropped,
    },
    events: env.events,
  };
}

async function sessionBench(iwer, args) {
  const shared = { errors: [], sink: 0 };
  const cycles = Math.max(50, Math.floor(args.frames / 100));
  for (let i = 0; i < cycles; i++) await sessionCycle(iwer, shared);
  globalThis.gc?.();
  const times = [];
  const allocs = [];
  for (let i = 0; i < cycles; i++) {
    const before = usedHeap();
    const t0 = performance.now();
    await sessionCycle(iwer, shared);
    times.push((performance.now() - t0) * 1e6);
    const after = usedHeap();
    if (after >= before) allocs.push(after - before);
  }
  if (shared.errors.length) throw shared.errors[0].error;
  return {
    ns: summarise(times),
    allocBytesPerCycle: allocs.length ? summarise(allocs) : null,
    cycles,
  };
}

/** Samples allocations with V8's sampling heap profiler and prints the top sites. */
async function allocSites(iwer, args) {
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  const { step } = await createScenario(iwer, args.scenario);
  for (let i = 0; i < args.warmup; i++) step();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 16,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < args.frames; i++) step();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  const sites = new Map();
  const walk = (node, stack) => {
    const f = node.callFrame;
    const name = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    const here = stack.concat(name);
    if (node.selfSize > 0) {
      const key = here.slice(-4).join(' < ');
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
    }
    for (const child of node.children) walk(child, here);
  };
  walk(profile.head, []);
  const top = [...sites.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25);
  return top.map(([site, bytes]) => ({
    bytesPerFrame: bytes / args.frames,
    site,
  }));
}

const args = parseArgs(process.argv.slice(2));
const iwer = await import(pathToFileURL(args.bundle).href);
const meta = {
  v8: process.versions.v8,
  node: process.version,
  bundle: args.bundle,
  bundleBytes: statSync(args.bundle).size,
  scenario: args.scenario,
  frames: args.frames,
  warmup: args.warmup,
};
let result;
if (args.allocSites) {
  result = { sites: await allocSites(iwer, args) };
} else if (args.scenario === 'session') {
  result = await sessionBench(iwer, args);
} else {
  result = await frameBench(iwer, args);
}
process.stdout.write(JSON.stringify({ ...meta, ...result }) + '\n');
