#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Device test for runtime/workers: stages the test app (app/ + vendored wasm libraries), packs an APK with the
// runtime build and the web preludes, installs it on a headset, runs it and reads the results through the
// debug endpoint (/host on the inspector port). adb calls run `adb -s <serial>`; IWN_ADB replaces that command
// (split on spaces), e.g. for an adb server on another machine: IWN_ADB="adb -H <host> -P 5037 -s <serial>".
//
//   node run.mjs --build build/android --deps <deps dir> \
//                --out <out dir> [--serial S] [--port 9510] [--keep] [--apk-only]
//
// --deps holds the extracted npm tarballs (npm pack, no install scripts): wasm-vips 0.0.19,
// @dimforge/rapier3d-simd-compat 0.21.0, @babylonjs/havok 1.3.14, comlink 4.4.2 (THIRD_PARTY.md, test-only).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeRoot = path.resolve(here, '../../../..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (['keep', 'apk-only'].includes(k)) out[k] = true;
    else out[k] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || 9510);
const outDir = path.resolve(
  args.out || path.join(os.tmpdir(), 'iwn-workers-device'),
);
fs.mkdirSync(outDir, { recursive: true });
const pkg = 'com.iwernative.workerstest';

// --- stage the dist ---
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'iwn-workers-app-'));
fs.cpSync(path.join(here, 'app'), stage, { recursive: true });
const vendor = path.join(stage, 'vendor');
fs.mkdirSync(vendor);
const deps = path.resolve(args.deps);
const copy = (rel, name = path.basename(rel)) =>
  fs.copyFileSync(path.join(deps, rel), path.join(vendor, name));
copy('dimforge-rapier3d-simd-compat-0.21.0/package/dist/rapier.mjs');
copy('babylonjs-havok-1.3.14/package/lib/esm/HavokPhysics_es.js');
copy('babylonjs-havok-1.3.14/package/lib/esm/HavokPhysics.wasm');
copy('wasm-vips-0.0.19/package/lib/vips-es6.js');
copy('wasm-vips-0.0.19/package/lib/vips.wasm');
copy('comlink-4.4.2/package/dist/esm/comlink.mjs');

// --- pack ---
const preludes = [
  'web/glue/dist/glue.min.js',
  'web/image/dist/image.min.js',
  'web/canvas2d/dist/canvas2d.min.js',
  'web/net/dist/net.min.js',
  'web/workers/dist/workers.min.js',
].map((p) => path.join(nativeRoot, p));
const extra = path.join(outDir, 'workers-test-config.json');
fs.writeFileSync(
  extra,
  JSON.stringify({ workers: { maxWorkers: 16, messageLog: 512 } }, null, 2),
);
const apk = path.join(outDir, 'workers-test.apk');
const buildArgs = [
  path.join(nativeRoot, 'runtime/app/template/build-apk.mjs'),
  '--libs',
  path.join(path.resolve(args.build), 'apk-libs.txt'),
  '--out',
  apk,
  '--dist',
  stage,
  ...preludes.flatMap((p) => ['--prelude', p]),
  '--config',
  extra,
  '--package',
  pkg,
  '--label',
  'workers-test',
  '--inspector-port',
  String(port),
];
console.log('packing', apk);
execFileSync(process.execPath, buildArgs, { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
if (args['apk-only'] || !args.serial) process.exit(0);

// --- device ---
const S = args.serial;
const ADB = process.env.IWN_ADB
  ? process.env.IWN_ADB.split(/\s+/)
  : ['adb', '-s', S];
const adb = (cmd, opts = {}) => {
  const r = spawnSync(ADB[0], [...ADB.slice(1), ...cmd], {
    encoding: 'utf8',
    timeout: opts.timeout ?? 120000,
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0 && !opts.allowFail)
    throw new Error(`adb ${cmd.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hostCall(method, params = {}, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/host`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error('debug endpoint timeout'));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ method, params, id: 1 }));
    ws.onmessage = (e) => {
      clearTimeout(t);
      ws.close();
      resolve(JSON.parse(e.data));
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('debug endpoint connection failed'));
    };
  });
}
const evalJs = async (expression, timeoutMs = 85000) =>
  (
    await hostCall(
      'eval',
      { expression, awaitPromise: true, timeoutMs },
      timeoutMs + 5000,
    )
  ).result;

console.log('device', S, adb(['shell', 'getprop', 'ro.build.fingerprint']));
adb(['install', '-r', apk], { timeout: 300000 });
adb(['forward', `tcp:${port}`, `tcp:${port}`]);
adb(
  ['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close'],
  { allowFail: true },
);
adb(['shell', 'am', 'force-stop', pkg], { allowFail: true });
adb(['logcat', '-c'], { allowFail: true });
// The main log ring is small: stream the runtime's tags to a file for the whole run.
const logFile = fs.openSync(path.join(outDir, 'logcat.txt'), 'w');
const logcatProc = spawn(
  ADB[0],
  [
    ...ADB.slice(1),
    'logcat',
    '-v',
    'threadtime',
    '-s',
    'iwn:V',
    'iwn-js:V',
    'DEBUG:V',
    'libc:F',
  ],
  {
    stdio: ['ignore', logFile, logFile],
  },
);
await sleep(1500);
adb(['shell', 'am', 'start', '-n', `${pkg}/android.app.NativeActivity`]);

let state = null;
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  await sleep(2000);
  try {
    const r = await evalJs(
      'JSON.stringify(globalThis.__workers ? { done: __workers.done, n: __workers.results.length } : null)',
    );
    const s = r && JSON.parse(r);
    if (s)
      process.stdout.write(`\r${s.n} results${s.done ? ' (done)' : ''}   `);
    if (s && s.done) {
      state = JSON.parse(await evalJs('JSON.stringify(__workers)'));
      break;
    }
  } catch {
    // not up yet
  }
}
console.log();
const pid = adb(['shell', 'pidof', pkg], { allowFail: true });
const report = { serial: S, pid, state };
if (state) {
  for (const r of state.results)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${r.name} (${r.ms} ms)${r.ok ? ' ' + JSON.stringify(r.detail ?? '') : '\n   ' + r.error}`,
    );
  console.log(state.summary);
  report.workersDebug = await hostCall('workers').catch((e) => String(e));
  report.stats = await hostCall('stats').catch((e) => String(e));
  // WRK-11 / PROC-4: thread names and nice values.
  report.threads = adb(
    ['shell', 'ps', '-T', '-o', 'TID,PRI,NI,CMD', '-p', pid],
    { allowFail: true },
  );
  report.status = adb(['shell', 'cat', `/proc/${pid}/status`], {
    allowFail: true,
  })
    .split('\n')
    .filter((l) => /^(VmRSS|VmHWM|Threads)/.test(l));

  // --- WRK-8: 500 create/message/terminate cycles: RSS growth and thread count back to baseline ---
  const proc = () => {
    const lines = adb(['shell', 'cat', `/proc/${pid}/status`], {
      allowFail: true,
    }).split('\n');
    const kb = (k) =>
      Number((lines.find((l) => l.startsWith(k)) || '0').replace(/\D+/g, ''));
    return { rssKB: kb('VmRSS'), threads: kb('Threads') };
  };
  const cycles = (n) => `(async () => {
    const live = () => __iwn.workers.info().live;
    const base = live();
    for (let i = 0; i < ${n}; i++) {
      const w = new Worker('./workers/stress.js');
      const b = new ArrayBuffer(64 << 10);
      w.postMessage(b, [b]);
      await new Promise((r) => { w.onmessage = r; setTimeout(r, 500); });
      w.terminate();
    }
    const end = performance.now() + 10000;
    while (live() !== base && performance.now() < end) await new Promise((r) => setTimeout(r, 5));
    return live() - base;
  })()`;
  await evalJs(cycles(50));
  await sleep(3000);
  const before = proc();
  const t1 = Date.now();
  const leftover = await evalJs(cycles(500));
  const cycleMs = Date.now() - t1;
  await sleep(3000);
  const after = proc();
  report.terminateCycles = {
    cycles: 500,
    ms: cycleMs,
    leftoverWorkers: leftover,
    before,
    after,
    rssGrowthKB: after.rssKB - before.rssKB,
  };
  console.log('WRK-8 500 cycles:', JSON.stringify(report.terminateCycles));

  // --- PROC-6: pause/resume (headset sleep/wake): workers keep running, state kept ---
  const ticks = async () => Number(await evalJs('__workers.ticks'));
  const k0 = await ticks();
  adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'], { allowFail: true });
  await sleep(4000);
  const visHidden = await evalJs('document.visibilityState').catch((e) =>
    String(e),
  );
  const k1 = await ticks();
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true });
  adb(
    ['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close'],
    { allowFail: true },
  );
  await sleep(3000);
  const k2 = await ticks();
  const visAfter = await evalJs('document.visibilityState').catch((e) =>
    String(e),
  );
  const doneAfter = await evalJs('__workers.done');
  report.pauseResume = {
    ticksBefore: k0,
    ticksWhilePaused: k1,
    ticksAfterResume: k2,
    visHidden,
    visAfter,
    stateKept: doneAfter,
  };
  console.log('pause/resume:', JSON.stringify(report.pauseResume));
} else {
  console.log('no results (timeout)');
}
logcatProc.kill();
fs.writeFileSync(
  path.join(outDir, 'report.json'),
  JSON.stringify(report, null, 2),
);
console.log('report:', path.join(outDir, 'report.json'));
if (!args.keep) {
  adb(['shell', 'am', 'force-stop', pkg], { allowFail: true });
  adb(['forward', '--remove', `tcp:${port}`], { allowFail: true });
}
process.exit(state && state.summary.includes('PASS') ? 0 : 1);
