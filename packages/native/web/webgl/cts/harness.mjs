#!/usr/bin/env node
// Khronos WebGL conformance subset runner (spec GL-CTS-1) for the @iwer/native WebGL binding.
//
// Runs the official test pages (sdk/tests/**.html) without a browser: each page gets a fresh V8 context
// (node:vm) with a minimal DOM (document / elements / canvas.getContext -> the binding over the host GL addon,
// script loading, load events, timers, synchronous file XHR), the binding's prelude bundle (dist/webgl.js)
// evaluated inside it, and the CTS harness hook (window.parent.webglTestHarness) collecting PASS/FAIL.
//
//   node cts/harness.mjs [--root <sdk/tests>] [--list cts/subset.txt] [--filter <regex>] [--json out.json]
//                        [--timeout 30000] [--verbose] [--webgl 2|1|both]
//
// Test selection follows the official runner (webgl-conformance-tests.html): each subset directory expands
// through its 00_test_list.txt files, honouring --min-version / --max-version. The WebGL 2 pass (suite version
// 2.0.1) runs conformance/ and conformance2/ pages with ?webglVersion=2, so conformance/ tests create WebGL 2
// contexts, as in the official WebGL 2 run; the WebGL 1 pass (1.0.4) runs conformance/ pages on WebGL 1.
// Default: both passes. Exclusions: "!path reason" (both passes), "!v1:path reason", "!v2:path reason"; "!host:..." /
// "!device:..." limit one to this harness or to the device run (cts/device-run.mjs).
//
// The CTS itself is not checked in: cts/fetch-cts.sh downloads it (Khronos, chromium.googlesource.com mirror)
// to ~/.cache/iwn-webgl-cts/sdk-tests. The binding bundle comes from `node build.mjs`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Mesa's GLSL compiler recurses deeply on the large generated shaders of some GLSL pages and overflows the default
// 8 MB main-thread stack (SIGSEGV inside libgallium). Re-run this script with a 256 MB stack limit.
if (!process.env.IWN_CTS_BIG_STACK) {
  const { spawnSync } = await import('node:child_process');
  const quoted = [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)]
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const r = spawnSync('/bin/sh', ['-c', `ulimit -s 262144 2>/dev/null; exec ${quoted}`], {
    stdio: 'inherit',
    env: { ...process.env, IWN_CTS_BIG_STACK: '1' },
  });
  process.exit(r.status ?? 1);
}
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--verbose') args.verbose = true;
  else args[a.replace(/^--/, '')] = process.argv[++i];
}
const ROOT = args.root ?? path.join(os.homedir(), '.cache/iwn-webgl-cts/sdk-tests');
const LIST = args.list ?? path.join(here, 'subset.txt');
const TIMEOUT = Number(args.timeout ?? 30000);
const PASSES = args.webgl === '1' ? [1] : args.webgl === '2' ? [2] : [2, 1];
let webglVersion = 2; // current pass
const BUNDLE = fs.readFileSync(path.join(here, '..', 'dist', 'webgl.js'), 'utf8');
const require = createRequire(import.meta.url);
const addonPath = process.env.IWN_GL_ADDON ?? fileURLToPath(new URL('../../../build/gl/host/iwn_gl.node', import.meta.url));
const natives = require(addonPath).gl;

let setCurrentPage = () => {};
// Memory guard: some GLSL pages (deeply nested / huge shaders) make a driver compiler grow without bound inside
// one synchronous native call, where no JS timer runs. A worker thread watches the process RSS and kills the run
// above --max-rss-mb (default 8192), reporting the page that was running.
{
  const { Worker } = await import('node:worker_threads');
  const maxRss = Number(args['max-rss-mb'] ?? 8192) * 1024 * 1024;
  const current = new Uint8Array(new SharedArrayBuffer(1024)); // name of the running page (NUL-terminated)
  setCurrentPage = (name) => {
    const b = new TextEncoder().encode(name).subarray(0, 1023);
    current.fill(0);
    current.set(b);
  };
  const w = new Worker(
    `const { workerData } = require('node:worker_threads');
     const fs = require('node:fs');
     setInterval(() => {
       const m = /VmRSS:\\s+(\\d+) kB/.exec(fs.readFileSync('/proc/' + workerData.pid + '/status', 'utf8'));
       if (m && Number(m[1]) * 1024 > workerData.maxRss) {
         const c = workerData.current;
         const page = Buffer.from(c.subarray(0, Math.max(0, c.indexOf(0)))).toString();
         fs.writeSync(2, 'CTS memory guard: RSS ' + (Number(m[1]) >> 10) + ' MB > limit while running ' + page + '; killing the run\\n');
         process.kill(workerData.pid, 'SIGKILL');
       }
     }, 200);`,
    { eval: true, workerData: { pid: process.pid, maxRss, current } },
  );
  w.unref();
}

// ------------------------------------------------------------------------------------------- page loading

const { runPage: runPageIn } = await import('./page.mjs');

// A page's async failure must not take the runner down (set before any page runs).
let currentResults = null;

function runPage(testRel) {
  const file = path.join(ROOT, testRel);
  const ctx = vm.createContext({});
  const win = vm.runInContext('globalThis', ctx);
  return runPageIn({
    win,
    testRel,
    html: fs.readFileSync(file, 'utf8'),
    webglVersion,
    timeout: TIMEOUT,
    readText: (rel) => {
      try {
        return fs.readFileSync(path.join(ROOT, rel), 'utf8');
      } catch {
        return null;
      }
    },
    evalScript: (code, filename) => vm.runInContext(code, ctx, { filename }),
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    now: () => performance.now(),
    globals: { URL, URLSearchParams, TextEncoder, TextDecoder, queueMicrotask },
    installBinding: () => vm.runInContext(BUNDLE, ctx, { filename: 'webgl.js' }),
    natives,
    webglOptions: process.env.IWN_WEBGL_DEBUG
      ? { debugErrors: true, log: (m) => console.error(`[${testRel}] ${m.split('\n').slice(0, 3).join(' | ')}`) }
      : {},
    logError: (...a) => args.verbose && console.error(...a),
    onResults: (r) => (currentResults = r),
    maxFailures: Number(process.env.IWN_CTS_MAX_FAILURES ?? 20),
  });
}

// ---------------------------------------------------------------------------------------------- main

const { expandList, SUITE_VERSION } = await import('./list.mjs');

process.on('uncaughtException', (e) => {
  if (currentResults) currentResults.errors.push(`uncaught: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
});
process.on('unhandledRejection', (e) => {
  if (currentResults) currentResults.errors.push(`unhandled rejection: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
});

const report = { root: ROOT, started: new Date().toISOString(), passes: [], tests: [] };
let passed = 0;
let failed = 0;
let excluded = 0;
let total = 0;
const byDir = new Map();
for (const pass of PASSES) {
  webglVersion = pass;
  const { tests, exclude } = expandList(ROOT, LIST, pass, args.filter);
  total += tests.length;
  const counts = { webgl: pass, suiteVersion: SUITE_VERSION[pass], passed: 0, failed: 0, excluded: 0, total: tests.length };
  report.passes.push(counts);
  for (const t of tests) {
    const dir = `v${pass} ${path.dirname(t)}`;
    const d = byDir.get(dir) ?? { pass: 0, fail: 0, excluded: 0 };
    byDir.set(dir, d);
    const why = exclude.get(t) ?? [...exclude.entries()].find(([k]) => k.endsWith('/') && t.startsWith(k))?.[1];
    if (why !== undefined) {
      excluded++;
      counts.excluded++;
      d.excluded++;
      report.tests.push({ webgl: pass, test: t, status: 'excluded', reason: why });
      continue;
    }
    setCurrentPage(`[v${pass}] ${t}`);
    const r = await runPage(t);
    const ok = r.finished && r.fail === 0 && r.errors.length === 0 && r.pass > 0;
    if (ok) {
      passed++;
      counts.passed++;
      d.pass++;
    } else {
      failed++;
      counts.failed++;
      d.fail++;
    }
    report.tests.push({ webgl: pass, test: t, status: ok ? 'pass' : 'fail', subtests: { pass: r.pass, fail: r.fail }, timedOut: r.timedOut, failures: r.failures, errors: r.errors });
    const line = `${ok ? 'PASS' : 'FAIL'} [v${pass}] ${t} (${r.pass}/${r.pass + r.fail})${r.timedOut ? ' TIMEOUT' : ''}`;
    console.log(line);
    if (!ok && args.verbose) {
      for (const f of r.failures.slice(0, 5)) console.log(`    - ${f}`);
      for (const e of r.errors.slice(0, 3)) console.log(`    ! ${e}`);
    }
  }
}
console.log('\nper directory:');
for (const [dir, d] of [...byDir].sort()) console.log(`  ${dir}: pass ${d.pass}, fail ${d.fail}, excluded ${d.excluded}`);
for (const c of report.passes) console.log(`WebGL ${c.webgl} pass (suite ${c.suiteVersion}): ${c.passed} passed, ${c.failed} failed, ${c.excluded} excluded (of ${c.total})`);
console.log(`\nCTS subset: ${passed} passed, ${failed} failed, ${excluded} excluded (of ${total})`);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
