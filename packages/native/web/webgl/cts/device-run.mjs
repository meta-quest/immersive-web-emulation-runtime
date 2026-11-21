#!/usr/bin/env node
// GL-CTS-1 on the device: drives the harness app (cts/device-build.mjs) on a headset over CDP and runs the same
// subset as the host runner (cts/subset.txt, both WebGL passes), one page per fresh page context (Page.reload).
// Each page's HTML and the files it loads go in the evaluate payload; the page's markup scripts run as classic
// scripts through Runtime.compileScript/runScript; a page that asks for a file it was not sent reports it and is
// rerun with the file added. A page that hangs or kills the app counts as FAIL and the app is
// restarted. Output: one PASS/FAIL line per page, per-directory counts, and --json (archived per run, GL-CTS-1).
//
//   node cts/device-run.mjs --serial <serial> [--apk gl-cts.apk] [--port 9502] [--list cts/subset.txt]
//        [--filter <regex>] [--webgl 2|1|both] [--timeout 30000] [--json out.json] [--keep-installed]
//        [--resume previous.json]   (keeps that report's results and runs only the tests it lacks)
//
// adb calls run `adb -s <serial>`; IWN_ADB replaces that command (split on spaces), e.g. for an adb server on another
// machine: IWN_ADB="adb -H <host> -P 5037 -s <serial>".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandList, SUITE_VERSION } from './list.mjs';
import { parseHtml, resolveRel } from './page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--keep-installed' || a === '--verbose' || a === '--keep-running') args[a.slice(2)] = true;
  else args[a.replace(/^--/, '')] = process.argv[++i];
}
if (!args.serial) {
  console.error('usage: device-run.mjs --serial <serial> [--apk gl-cts.apk] [--port 9502] [--json out.json] ...');
  process.exit(2);
}
const ROOT = args.root ?? path.join(os.homedir(), '.cache/iwn-webgl-cts/sdk-tests');
const LIST = args.list ?? path.join(here, 'subset.txt');
const PORT = Number(args.port ?? 9502);
const TIMEOUT = Number(args.timeout ?? 30000);
const PASSES = args.webgl === '1' ? [1] : args.webgl === '2' ? [2] : [2, 1];
const PKG = 'com.iwernative.glcts';
// other apps of this stream that bind the same inspector port: a leftover instance makes the harness unreachable
const OTHER_PKGS = ['com.iwernative.gltest', 'com.iwernative.glbench'];
const ACTIVITY = `${PKG}/android.app.NativeActivity`;
const ADB = process.env.IWN_ADB ? process.env.IWN_ADB.split(/\s+/) : ['adb', '-s', args.serial];

function adb(...a) {
  return execFileSync(ADB[0], [...ADB.slice(1), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ CDP session

class Cdp {
  static async connect() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page') ?? list[0];
    const url = page.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${PORT}`);
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP WebSocket error'));
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      const p = m.id !== undefined && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(`${m.error.message}`));
      else p.res(m.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.rej(new Error('CDP connection closed'));
      this.pending.clear();
    };
  }
  send(method, params = {}, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => (clearTimeout(t), res(v)),
        rej: (e) => (clearTimeout(t), rej(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeoutMs = 60000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

let cdp = null;

/** Connected to a freshly booted page whose harness is ready (reconnects as needed). */
async function readyPage(deadlineMs = 30000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < deadlineMs) {
    try {
      if (!cdp || cdp.closed) {
        cdp = await Cdp.connect();
        await cdp.send('Runtime.enable', {}, 10000); // compileScript / runScript need the Runtime agent
      }
      // __ctsStale marks the page being replaced: do not mistake it for the fresh one
      if ((await cdp.evaluate('globalThis.__ctsReady === true && globalThis.__ctsStale !== true', 5000)) === true) return;
    } catch (e) {
      last = String(e.message ?? e);
      cdp?.close();
      cdp = null;
    }
    await sleep(50);
  }
  throw new Error(`harness page not ready after ${deadlineMs} ms (${last})`);
}

async function startApp() {
  cdp?.close();
  cdp = null;
  for (const p of OTHER_PKGS) adb('shell', 'am', 'force-stop', p);
  adb('shell', 'am', 'force-stop', PKG);
  adb('shell', 'am', 'start', '-n', ACTIVITY);
  await readyPage(60000);
}

async function freshPage() {
  try {
    // The page's DOM (page.mjs) replaces window.dispatchEvent, so the runtime's pagehide never reaches the binding's
    // listener (prelude.ts): free the page's WebGL contexts and objects here, as the pagehide listener does in apps.
    await cdp.evaluate('globalThis.__ctsStale = true; globalThis.__iwnWebGL?.releaseAllContexts?.(); true', 5000);
    await cdp.send('Page.reload', {}, 10000);
    await sleep(30);
    await readyPage(20000);
  } catch {
    await startApp(); // reload failed (app gone or hung): cold start
  }
}

// ------------------------------------------------------------------------------------------------ one page

const dirDeps = new Map(); // test directory -> files pages there asked for (sent up front to the next page)

function readRoot(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

async function runOnDevice(testRel, webglVersion) {
  const html = readRoot(testRel);
  const dir = path.posix.dirname(testRel);
  const want = new Set(dirDeps.get(dir) ?? []); // files the page reads itself (XHR, dynamic <script>)
  const srcScripts = [];
  for (const it of parseHtml(html).items) if (it.tag === 'script' && it.attrs.src) srcScripts.push(resolveRel(testRel, it.attrs.src));
  for (let attempt = 0; attempt < 6; attempt++) {
    const files = {};
    for (const rel of want) {
      const t = readRoot(rel);
      if (t !== null) files[rel] = t;
    }
    await freshPage();
    const payload = { testRel, html, files, srcScripts, webglVersion, timeout: TIMEOUT };
    let r;
    try {
      const scripts = JSON.parse(await cdp.evaluate(`__ctsSetup(${JSON.stringify(payload)})`, 60000));
      // Markup scripts run as classic scripts (global declarations, "use strict" per script), in order.
      for (let i = 0; i < scripts.length; i++) {
        const { filename } = scripts[i];
        const code = scripts[i].code ?? readRoot(filename);
        if (code === null) {
          await cdp.evaluate(`__ctsScriptError(${i}, 'not found')`, 10000);
          continue;
        }
        const c = await cdp.send('Runtime.compileScript', { expression: code, sourceURL: filename, persistScript: true }, 60000);
        const run = c.exceptionDetails ? c : await cdp.send('Runtime.runScript', { scriptId: c.scriptId }, TIMEOUT + 30000);
        if (run.exceptionDetails) {
          const d = run.exceptionDetails.exception?.description ?? run.exceptionDetails.text ?? 'error';
          await cdp.evaluate(`__ctsScriptError(${i}, ${JSON.stringify(String(d))})`, 10000);
        }
      }
      r = JSON.parse(await cdp.evaluate('__ctsFinish()', TIMEOUT + 30000));
    } catch (e) {
      // hang (evaluate timed out) or crash (connection closed): restart the app for the next page
      const msg = String(e.message ?? e);
      await startApp().catch(() => {});
      return { pass: 0, fail: 0, finished: false, timedOut: /timed out/.test(msg), failures: [], errors: [`device: ${msg}`] };
    }
    const fresh = r.missing.filter((m) => !want.has(m) && readRoot(m) !== null);
    if (!fresh.length) return r;
    for (const m of fresh) want.add(m);
    dirDeps.set(dir, new Set([...(dirDeps.get(dir) ?? []), ...fresh]));
  }
  return { pass: 0, fail: 0, finished: false, failures: [], errors: ['device: page kept asking for more files'] };
}

// ------------------------------------------------------------------------------------------------ main

const device = {
  serial: args.serial,
  model: adb('shell', 'getprop', 'ro.product.model').trim(),
  build: adb('shell', 'getprop', 'ro.build.id').trim(),
  fingerprint: adb('shell', 'getprop', 'ro.build.fingerprint').trim(),
};
console.log(`device ${device.serial}: ${device.model}, ${device.build}`);
if (args.apk) {
  console.log(adb('install', '-r', '-g', args.apk).trim().split('\n').pop());
}
adb('forward', `tcp:${PORT}`, `localabstract:${PKG}_devtools_${PORT}`); // CDP-1: the inspector is an abstract socket
const report = { root: ROOT, device, started: new Date().toISOString(), passes: [], tests: [] };
let passed = 0;
let failed = 0;
let excluded = 0;
let total = 0;
const byDir = new Map();
// --resume: results of an interrupted run (device lost mid-run) are kept; only the missing tests run
const previous = new Map();
if (args.resume && fs.existsSync(args.resume)) {
  const old = JSON.parse(fs.readFileSync(args.resume, 'utf8'));
  for (const t of old.tests ?? []) if (t.status !== 'excluded' && !(t.errors ?? []).some((e) => /^device: /.test(e))) previous.set(`${t.webgl} ${t.test}`, t);
  report.resumedFrom = { file: args.resume, kept: previous.size, device: old.device };
  console.log(`resuming: ${previous.size} results kept from ${args.resume}`);
}
try {
  await startApp();
  for (const pass of PASSES) {
    const { tests, exclude } = expandList(ROOT, LIST, pass, args.filter, 'device');
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
      const prev = previous.get(`${pass} ${t}`);
      const r = prev
        ? { pass: prev.subtests?.pass ?? 0, fail: prev.subtests?.fail ?? 0, finished: prev.status === 'pass', timedOut: prev.timedOut, ms: prev.ms, failures: prev.failures ?? [], errors: prev.errors ?? [], resumed: true }
        : await runOnDevice(t, pass);
      const ok = prev ? prev.status === 'pass' : r.finished && r.fail === 0 && r.errors.length === 0 && r.pass > 0;
      if (ok) {
        passed++;
        counts.passed++;
        d.pass++;
      } else {
        failed++;
        counts.failed++;
        d.fail++;
      }
      report.tests.push({ webgl: pass, test: t, status: ok ? 'pass' : 'fail', subtests: { pass: r.pass, fail: r.fail }, timedOut: r.timedOut, ms: r.ms, failures: r.failures, errors: r.errors, ...(r.resumed ? { resumed: true } : {}) });
      if (r.resumed) continue;
      console.log(`${ok ? 'PASS' : 'FAIL'} [v${pass}] ${t} (${r.pass}/${r.pass + r.fail})${r.timedOut ? ' TIMEOUT' : ''}`);
      if (!ok && args.verbose) {
        for (const f of r.failures.slice(0, 5)) console.log(`    - ${f}`);
        for (const e of r.errors.slice(0, 3)) console.log(`    ! ${e}`);
      }
      if (args.json && report.tests.length % 25 === 0) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    }
  }
} finally {
  cdp?.close();
  try {
    if (!args['keep-running']) adb('shell', 'am', 'force-stop', PKG); // --keep-running: inspect the app afterwards
    adb('forward', '--remove', `tcp:${PORT}`);
    if (args.apk && !args['keep-installed']) adb('uninstall', PKG);
  } catch (e) {
    console.error(`cleanup: ${e.message}`);
  }
}
report.finished = new Date().toISOString();
console.log('\nper directory:');
for (const [dir, d] of [...byDir].sort()) console.log(`  ${dir}: pass ${d.pass}, fail ${d.fail}, excluded ${d.excluded}`);
for (const c of report.passes) console.log(`WebGL ${c.webgl} pass (suite ${c.suiteVersion}): ${c.passed} passed, ${c.failed} failed, ${c.excluded} excluded (of ${c.total})`);
console.log(`\nCTS subset on ${device.model} ${device.build}: ${passed} passed, ${failed} failed, ${excluded} excluded (of ${total})`);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
