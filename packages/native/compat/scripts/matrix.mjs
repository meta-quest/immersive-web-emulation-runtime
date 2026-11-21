#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Build the compat matrix from sweep traces.
 *
 *   node compat/scripts/matrix.mjs --traces <dir of <sample>.json> --out <file.md>
 *        [--json <file.json>] [--iwer-host <iwer-host.module.js>] [--title ...]
 *        [--preamble-file <md>] [--inventory-out <file.json>]
 *        [--samples <dir of sample projects>]   (adds each sample's iwsdk.config.json and own-source
 *                                                signals, and the headset-only code path, as rows)
 *
 * The inventory (what the package provides today) is measured from this
 * package's built layers each time the script runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..');
const { buildInventory } = await import(
  path.join(here, '..', 'src', 'inventory.ts')
);
const { measuredSurface, iwerHostSurface } = await import(
  path.join(here, '..', 'src', 'providers.ts')
);
const { buildMatrix, matrixMarkdown, matrixJson } = await import(
  path.join(here, '..', 'src', 'matrix.ts')
);
const { projectSignals } = await import(
  path.join(here, '..', 'src', 'project.ts')
);

const { values } = parseArgs({
  options: {
    traces: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'string' },
    'iwer-host': { type: 'string' },
    title: { type: 'string' },
    'preamble-file': { type: 'string' },
    'inventory-out': { type: 'string' },
    samples: { type: 'string' },
  },
});
if (!values.traces || !values.out) {
  console.error(
    'usage: matrix.mjs --traces <dir> --out <file.md> [--json <file>] [--iwer-host <file>]',
  );
  process.exit(2);
}
const inv = buildInventory(pkgRoot);
if (values['inventory-out'])
  fs.writeFileSync(values['inventory-out'], JSON.stringify(inv, null, 1));
const iwerHost =
  values['iwer-host'] ??
  path.resolve(pkgRoot, '../iwer/build/iwer-host.module.js');
const iwer = fs.existsSync(iwerHost)
  ? await iwerHostSurface(iwerHost)
  : new Set();
if (!iwer.size)
  console.error(
    `warning: no IWER host build at ${iwerHost}; XR rows will read as gaps`,
  );
const surface = measuredSurface(inv, iwer);
const traces = fs
  .readdirSync(values.traces)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(values.traces, f), 'utf8'));
    t.sample ??= f.replace(/\.json$/, '');
    return t;
  });
let app;
if (values.samples) {
  app = {};
  for (const t of traces) {
    const dir = path.join(path.resolve(values.samples), t.sample);
    if (fs.existsSync(dir)) app[t.sample] = projectSignals(dir);
  }
}
const m = buildMatrix(traces, surface, { app });
const layers = inv.layers
  .map(
    (l) =>
      `\`${l.layer}\` (${l.how}${l.error ? `: ${l.error.slice(0, 80)}` : ''}, ${l.globals.length} globals, ${l.members.length} members${l.tokens?.length ? (l.how === 'eval' ? `, ${l.tokens.length} extension names` : `, ${l.tokens.length} source tokens`) : ''})`,
  )
  .join('; ');
const trimmed = traces.filter(
  (t) => Array.isArray(t.removed) && t.removed.length,
);
const preamble = [
  values['preamble-file']
    ? fs.readFileSync(values['preamble-file'], 'utf8').trim()
    : '',
  trimmed.length
    ? `${trimmed.length} of ${traces.length} traces ran with the headset trim: ${trimmed[0].removed.length} globals and navigator/crypto members the headset lacks by design (WebGPU, WebCodecs, media streams, BroadcastChannel, SharedWorker, clipboard, crypto.subtle, ...) were removed before the app ran, so feature detection took the headset's path (a guarded use shows as a \`miss:\` probe or not at all, an unguarded one as an uncaught error), and \`getContext\` returned null for context types the runtime never offers.${traces.some((t) => t.emulateAR) ? " The emulated device offered immersive-ar (the headset does for apps that declare passthrough, XR-AR-1), so the AR samples' XR-phase use is recorded." : ''}`
    : '',
  `Inventory measured ${inv.generatedAt} from ${path.relative(process.cwd(), pkgRoot) || '.'}: ${layers}. IWER host mode: ${iwer.size} classes+members from \`${path.basename(iwerHost)}\`.`,
]
  .filter(Boolean)
  .join('\n\n');
fs.writeFileSync(
  values.out,
  matrixMarkdown(m, { title: values.title, preamble }) + '\n',
);
if (values.json)
  fs.writeFileSync(values.json, JSON.stringify(matrixJson(m), null, 1));
const counts = {};
for (const r of m.rows)
  counts[r.resolution.status] = (counts[r.resolution.status] ?? 0) + 1;
console.error(
  `${m.rows.length} APIs over ${m.samples.length} samples: ${JSON.stringify(counts)}`,
);
