/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Runs the host-mode benchmark suite: every scenario in its own process,
// repeated, for one or more IWER builds (interleaved, so an A/B comparison
// sees the same machine load), on one or more Node binaries. Writes the
// aggregated result as JSON.
//
//   node bench/run.mjs [--build label=dir]... [--node path]... [--repeat N]
//                      [--frames N] [--scenarios a,b] [--out file.json]
//
// A build dir holds iwer-host.module.js and iwer.module.js (the package's
// build/ folder; default: label "current" = ./build). Per scenario and
// build the report keeps the median over repeats of each run's median and
// p95 ns/frame and its median bytes allocated per frame.

import { spawnSync } from 'node:child_process';
import { writeFileSync, statSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const opts = {
  builds: [],
  nodes: [],
  repeat: 5,
  frames: 30000,
  scenarios: [
    'core',
    'controllers',
    'hands',
    'mixed',
    'edges',
    'scene',
    'session',
    'emulator',
  ],
  out: null,
};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  const next = () => process.argv[++i];
  if (key === '--build') {
    const [label, dir] = next().split('=');
    opts.builds.push({ label, dir: resolve(dir) });
  } else if (key === '--node') opts.nodes.push(next());
  else if (key === '--repeat') opts.repeat = Number(next());
  else if (key === '--frames') opts.frames = Number(next());
  else if (key === '--scenarios') opts.scenarios = next().split(',');
  else if (key === '--out') opts.out = resolve(next());
  else throw new Error(`unknown option ${key}`);
}
if (!opts.builds.length)
  opts.builds.push({ label: 'current', dir: resolve(here, '../build') });
if (!opts.nodes.length) opts.nodes.push(process.execPath);

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

function runOne(node, build, scenario) {
  const script =
    scenario === 'emulator'
      ? [
          join(here, 'emulator-bench.mjs'),
          '--bundle',
          join(build.dir, 'iwer.module.js'),
          '--frames',
          String(Math.max(opts.frames, 40000)),
          // the emulator's frame has a wide spread (jsdom, remote control):
          // a long warmup and run keep its p95 comparable between runs
          '--warmup',
          '20000',
        ]
      : [
          join(here, 'host-bench.mjs'),
          '--bundle',
          join(build.dir, 'iwer-host.module.js'),
          '--scenario',
          scenario,
          '--frames',
          String(opts.frames),
        ];
  const r = spawnSync(node, ['--expose-gc', ...script], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${scenario} on ${build.label} failed:\n${r.stderr}`);
  }
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function bundleSizes(dir) {
  const sizes = {};
  for (const f of [
    'iwer-host.module.js',
    'iwer-host.module.min.js',
    'iwer.module.js',
    'iwer.module.min.js',
  ]) {
    const p = join(dir, f);
    sizes[f] = {
      bytes: statSync(p).size,
      gzip: gzipSync(readFileSync(p), { level: 9 }).length,
    };
  }
  return sizes;
}

const report = {
  date: new Date().toISOString(),
  repeat: opts.repeat,
  frames: opts.frames,
  runtimes: [],
};
for (const node of opts.nodes) {
  const v8 = spawnSync(
    node,
    ['-p', 'process.versions.v8 + " " + process.version'],
    { encoding: 'utf8' },
  ).stdout.trim();
  const runtime = { node, v8, builds: {} };
  for (const build of opts.builds)
    runtime.builds[build.label] = {
      sizes: bundleSizes(build.dir),
      scenarios: {},
    };
  for (const scenario of opts.scenarios) {
    const runs = Object.fromEntries(opts.builds.map((b) => [b.label, []]));
    for (let rep = 0; rep < opts.repeat; rep++) {
      for (const build of opts.builds)
        runs[build.label].push(runOne(node, build, scenario));
    }
    for (const build of opts.builds) {
      const rs = runs[build.label];
      const alloc = (r) =>
        (r.allocBytesPerFrame ?? r.allocBytesPerCycle)?.median ?? null;
      runtime.builds[build.label].scenarios[scenario] = {
        nsMedian: median(rs.map((r) => r.ns.median)),
        nsP95: median(rs.map((r) => r.ns.p95)),
        nsMeanUntimed: median(rs.map((r) => r.nsMeanUntimed ?? null)),
        allocBytes: median(rs.map(alloc)),
        unit: scenario === 'session' ? 'per session cycle' : 'per frame',
        runs: rs.map((r) => ({
          nsMedian: r.ns.median,
          nsP95: r.ns.p95,
          allocBytes: alloc(r),
        })),
      };
      const s = runtime.builds[build.label].scenarios[scenario];
      console.error(
        `${v8.split(' ')[0].padEnd(22)} ${build.label.padEnd(10)} ${scenario.padEnd(12)} median ${s.nsMedian?.toFixed(0).padStart(7)} ns  p95 ${s.nsP95?.toFixed(0).padStart(7)} ns  alloc ${s.allocBytes?.toFixed(1).padStart(8)} B ${s.unit}`,
      );
    }
  }
  report.runtimes.push(runtime);
}
const json = JSON.stringify(report, null, 2);
if (opts.out) writeFileSync(opts.out, json + '\n');
else process.stdout.write(json + '\n');
