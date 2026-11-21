#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Write compat/data/static-baseline.json: static-scan signals and origins that
 * every IWSDK build carries in library code (IWSDK core and the three.js it
 * bundles: IWSDK's camera utilities carry getUserMedia and a <video>, its AR
 * and layer systems the AR strings and quad layers) without the app executing
 * them. It applies to IWSDK apps only (the checker's CLI decides). The checker reports static-only hits of these as info, so
 * a plain IWSDK app does not warn about getUserMedia or <video> it never runs.
 *
 *   node compat/scripts/baseline.mjs --dist <minimal app dist> [--dist ...] --traces <sweep traces dir>
 *        [--iwsdk <version>] [--out <file>]
 *
 * The dists should be minimal apps (the create templates), each traced by the
 * sweep under its project directory name. A signal is baseline when a template
 * mentions it and that template's trace never called it; an origin likewise.
 * Trace keys are mapped into the static scan's vocabulary first (the trace
 * records `offerSession("immersive-ar")` and `(required)` features; the scan
 * names `requestSession("immersive-ar")` and `(optional)`), and each baseline
 * key carries the most times a template mentions it (`counts`): a bundle that
 * mentions it more often has app code of its own that does.
 *
 * `iwsdk` records the IWSDK version the baseline describes; the checker compares it with each app's
 * @iwsdk/core (check.ts baselineDrift). It defaults to the templates' installed @iwsdk/core. Pass --iwsdk when
 * the templates were built from IWSDK sources that will ship under another version (tarballs of an unreleased
 * IWSDK carry the previous release's version until its release prep bumps it). Make the baseline again whenever
 * the IWSDK version that @iwer/native's README names changes (RELEASE.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { scanDist } = await import(path.join(here, '..', 'src', 'scan.ts'));
const { normaliseKey } = await import(path.join(here, '..', 'src', 'matrix.ts'));
const { values } = parseArgs({ options: { dist: { type: 'string', multiple: true }, traces: { type: 'string' }, out: { type: 'string' }, iwsdk: { type: 'string' } } });
if (!values.dist?.length || !values.traces) {
  console.error('usage: baseline.mjs --dist <dir> [--dist <dir>] --traces <dir> [--iwsdk <version>] [--out <file>]');
  process.exit(2);
}
if (values.iwsdk !== undefined && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.test(values.iwsdk)) {
  console.error(`--iwsdk wants a version like 1.2.0 (got "${values.iwsdk}")`);
  process.exit(2);
}
const scans = values.dist.map((d) => scanDist(path.resolve(d)));
// the given dists are minimal apps (the create templates): whatever they mention is library code
const union = (sets) => [...new Set(sets.flatMap((s) => [...s]))];
const keys = union(scans.map((s) => new Set(s.hits.map((h) => h.key))));
const counts = {};
for (const s of scans) for (const h of s.hits) counts[h.key] = Math.max(counts[h.key] ?? 0, h.count);
/** A trace key in the static scan's vocabulary. */
const toStatic = (k) =>
  normaliseKey(k)
    .replace(/^XRSystem\.(offerSession|requestSession)\("([^"]*)"\)$/, 'XRSystem.requestSession("$2")')
    .replace(/^XRSystem\.offerSession\(\)$/, 'XRSystem.offerSession()')
    .replace(/^(XR feature \S+) \((required|optional)\)$/, '$1 (optional)');
const origins = union(scans.map((s) => new Set(s.origins.map((o) => o.origin))));
const traced = new Set();
const requested = new Set();
let samples = 0;
// only the templates' own traces: what a minimal app mentions but does not run is dormant library code
const names = new Set(values.dist.map((d) => path.basename(path.dirname(path.resolve(d)))));
for (const f of fs.readdirSync(values.traces).filter((x) => x.endsWith('.json') && names.has(x.replace(/\.json$/, '')))) {
  const t = JSON.parse(fs.readFileSync(path.join(values.traces, f), 'utf8'));
  samples++;
  for (const d of [t.main, ...(t.workers ?? [])]) {
    if (!d) continue;
    for (const [k, r] of Object.entries(d.apis)) {
      if (r.app <= 0) continue;
      traced.add(normaliseKey(k));
      traced.add(toStatic(k));
      const m = /cross-origin (https?:\/\/[^ )]+)/.exec(k);
      if (m) requested.add(m[1]);
    }
  }
  for (const b of [...(t.blockedRequests ?? []), ...(t.mirroredRequests ?? [])]) requested.add(b.split(' ')[0]);
}
/** @iwsdk/core version the templates were built with (the checker compares it with the app's), unless --iwsdk. */
const { createRequire } = await import('node:module');
function installedIwsdk() {
  for (const d of values.dist) {
    try {
      const req = createRequire(path.join(path.dirname(path.resolve(d)), 'package.json'));
      return JSON.parse(fs.readFileSync(req.resolve('@iwsdk/core/package.json'), 'utf8')).version;
    } catch {
      /* next */
    }
  }
  return undefined;
}
const iwsdk = values.iwsdk ?? installedIwsdk();
const baseline = {
  generatedAt: new Date().toISOString(),
  iwsdk,
  source: `${values.dist.map((d) => path.basename(path.dirname(path.resolve(d)))).join(', ')}; ${samples} traced samples`,
  keys: keys.filter((k) => !traced.has(k)).sort(),
  counts: Object.fromEntries(keys.filter((k) => !traced.has(k)).sort().map((k) => [k, counts[k]])),
  origins: origins.filter((o) => !requested.has(o)).sort(),
};
const out = values.out ?? path.join(here, '..', 'data', 'static-baseline.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(baseline, null, 1)}\n`);
console.error(`wrote ${out}: ${baseline.keys.length} keys, ${baseline.origins.length} origins, IWSDK ${baseline.iwsdk ?? 'unknown'}`);
