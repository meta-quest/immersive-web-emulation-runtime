#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Compat sweep: build each IWSDK sample (npm install + vite build, IWER build
 * injection off) and trace it headlessly. Writes <out>/traces/<sample>.json and
 * <out>/builds/<sample>.log. Then run matrix.mjs over the traces.
 *
 *   node compat/scripts/sweep.mjs --samples <dir with sample dirs> --out <dir>
 *        [--packages <dir with <pkg>/iwsdk-<pkg>.tgz>] [--iwer <iwer.js>]
 *        [--only a,b] [--skip-build] [--jobs 4] [--trace-jobs 3]
 *        [--mirror <url prefix>=<local dir>]...   (answer a CDN from a local copy)
 *        [--xr-ms 6000] [--boot-ms 25000] [--no-trim] [--no-ar]
 *
 * Traces run with the headset trim (providers.ts headsetTrim: absent-by-design
 * APIs removed before the app runs, so feature detection takes the headset's
 * path; --no-trim shows all of Chromium) and with immersive-ar offered by the
 * emulated device, so the AR samples' XR-phase use is recorded for XR-AR-1
 * planning (--no-ar: as on the headset today, which is what `compat --trace`
 * does).
 *
 * --packages rewrites @iwsdk/* deps to local tarballs (overrides too: the
 * nested file: deps inside iwsdk-core.tgz are relative to the SDK repo); the
 * sample's own package.json and iwsdk.config.json are kept as *.iwn-orig.
 * Fetch the samples with scripts/acquire.sh.
 * Needs Node 24 (runs the package's TypeScript sources directly) and npm with
 * a reachable registry ($npm_config_registry).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { runTrace, loadPlaywright, findIwerBuild, phaseMsProblem } = await import(
  path.join(here, '..', 'src', 'trace-run.ts')
);
const { headsetTrim } = await import(path.join(here, '..', 'src', 'providers.ts'));
const { loadSurface } = await import(path.join(here, '..', 'src', 'surface.ts'));

const { values } = parseArgs({
  options: {
    samples: { type: 'string' },
    out: { type: 'string' },
    packages: { type: 'string' },
    iwer: { type: 'string' },
    only: { type: 'string' },
    'skip-build': { type: 'boolean' },
    jobs: { type: 'string', default: '4' },
    'trace-jobs': { type: 'string', default: '3' },
    'xr-ms': { type: 'string', default: '6000' },
    mirror: { type: 'string', multiple: true },
    'boot-ms': { type: 'string', default: '25000' },
    'no-trim': { type: 'boolean' },
    'no-ar': { type: 'boolean' },
  },
});
for (const k of ['boot-ms', 'xr-ms']) {
  const problem = phaseMsProblem(`--${k}`, values[k]);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
}
const trim = values['no-trim'] ? undefined : headsetTrim((await loadSurface()).surface);
if (!values.samples || !values.out) {
  console.error('usage: sweep.mjs --samples <dir> --out <dir> [--packages <dir>] [--iwer <iwer.js>]');
  process.exit(2);
}
const samplesRoot = path.resolve(values.samples);
const out = path.resolve(values.out);
fs.mkdirSync(path.join(out, 'traces'), { recursive: true });
fs.mkdirSync(path.join(out, 'builds'), { recursive: true });

let names = fs
  .readdirSync(samplesRoot)
  .filter((n) => fs.existsSync(path.join(samplesRoot, n, 'package.json')))
  .sort();
if (values.only) {
  const only = new Set(values.only.split(','));
  names = names.filter((n) => only.has(n));
}

function run(cmd, args, opts, logFile) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    log.write(`\n$ ${cmd} ${args.join(' ')}\n`);
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.pipe(log, { end: false });
    p.stderr.pipe(log, { end: false });
    p.on('close', (code) => {
      log.end(`\n[exit ${code}]\n`);
      resolve(code ?? 1);
    });
  });
}

/** Keep the sample's own file once, as <file>.iwn-orig, before the sweep rewrites it. */
function keepOriginal(file) {
  if (fs.existsSync(file) && !fs.existsSync(`${file}.iwn-orig`)) fs.copyFileSync(file, `${file}.iwn-orig`);
}

function prep(dir, pkgsRoot) {
  const pkgPath = path.join(dir, 'package.json');
  keepOriginal(pkgPath);
  keepOriginal(path.join(dir, 'iwsdk.config.json'));
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const ov = {};
  for (const p of fs.readdirSync(pkgsRoot)) {
    const tgz = path.join(pkgsRoot, p, `iwsdk-${p}.tgz`);
    if (fs.existsSync(tgz)) ov[`@iwsdk/${p}`] = 'file:' + path.relative(dir, tgz);
  }
  for (const sect of ['dependencies', 'devDependencies'])
    for (const k of Object.keys(pkg[sect] ?? {})) if (ov[k]) pkg[sect][k] = ov[k];
  pkg.overrides = { ...(pkg.overrides ?? {}), ...ov, playwright: '1.58.2', 'playwright-core': '1.58.2' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const cfgPath = path.join(dir, 'iwsdk.config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = fs.readFileSync(cfgPath, 'utf8');
    fs.writeFileSync(cfgPath, cfg.replace(/"injectOnBuild":\s*true/, '"injectOnBuild": false'));
  }
}

async function build(name) {
  const dir = path.join(samplesRoot, name);
  const logFile = path.join(out, 'builds', `${name}.log`);
  fs.writeFileSync(logFile, `build ${name} ${new Date().toISOString()}\n`);
  if (values.packages) prep(dir, path.resolve(values.packages));
  const env = { ...process.env, NODE_ENV: 'production' };
  if (!fs.existsSync(path.join(dir, 'node_modules', 'vite'))) {
    const code = await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--include=dev'], { cwd: dir, env: { ...env, NODE_ENV: 'development' } }, logFile);
    if (code !== 0) return { name, ok: false, step: 'install' };
  }
  const code = await run('npx', ['vite', 'build'], { cwd: dir, env }, logFile);
  if (code !== 0) return { name, ok: false, step: 'build' };
  return { name, ok: true };
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        results.push(await fn(item));
      }
    }),
  );
  return results;
}

const summary = { startedAt: new Date().toISOString(), samples: {} };
if (!values['skip-build']) {
  const builds = await pool(names, Number(values.jobs), async (n) => {
    const r = await build(n);
    console.error(`[build] ${n}: ${r.ok ? 'ok' : `FAILED (${r.step})`}`);
    return r;
  });
  for (const b of builds) summary.samples[b.name] = { build: b.ok ? 'ok' : `failed:${b.step}` };
}

const traced = names.filter((n) => fs.existsSync(path.join(samplesRoot, n, 'dist', 'index.html')));
await pool(traced, Number(values['trace-jobs']), async (n) => {
  const dir = path.join(samplesRoot, n);
  const pw = await loadPlaywright(dir);
  const iwerFile = values.iwer ?? findIwerBuild(dir);
  if (!pw || !iwerFile) {
    console.error(`[trace] ${n}: no playwright or iwer in its node_modules`);
    summary.samples[n] = { ...(summary.samples[n] ?? {}), trace: 'no-tooling' };
    return;
  }
  const t0 = Date.now();
  try {
    const r = await runTrace({
      distDir: path.join(dir, 'dist'),
      iwerSource: fs.readFileSync(iwerFile, 'utf8'),
      playwright: pw,
      xrMs: Number(values['xr-ms']),
      bootTimeoutMs: Number(values['boot-ms']),
      trim,
      emulateAR: !values['no-ar'],
      mirrors: (values.mirror ?? []).map((m) => {
        const i = m.indexOf('=');
        return { prefix: m.slice(0, i), dir: path.resolve(m.slice(i + 1)) };
      }),
    });
    r.sample = n;
    fs.writeFileSync(path.join(out, 'traces', `${n}.json`), JSON.stringify(r, null, 1));
    summary.samples[n] = { ...(summary.samples[n] ?? {}), trace: 'ok', trimmed: !!trim, emulateAR: !values['no-ar'], reachedXR: r.reachedXR, via: r.enteredVia, xrFrames: r.xrFrames, pageErrors: r.pageErrors.length, ...(r.hung ? { hung: r.hung } : {}), ms: Date.now() - t0 };
    console.error(`[trace] ${n}: xr=${r.reachedXR} via=${r.enteredVia} frames=${r.xrFrames} apis=${r.main ? Object.keys(r.main.apis).length : 0} workers=${r.workers.length} errors=${r.pageErrors.length}${r.hung ? ` HUNG: ${r.hung}` : ''}`);
  } catch (error) {
    summary.samples[n] = { ...(summary.samples[n] ?? {}), trace: `failed: ${String(error).slice(0, 200)}` };
    console.error(`[trace] ${n}: FAILED ${error}`);
  }
});
summary.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(out, 'sweep-summary.json'), JSON.stringify(summary, null, 2));
console.error(`wrote ${path.join(out, 'sweep-summary.json')}`);
