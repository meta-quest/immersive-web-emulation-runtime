// Runs understanding.html for every SEM environment (built-in GLTS rooms and
// the legacy scans, as a reference) and prints what each reports and any
// room understanding issues. Needs the example running (npx vite --port 5180).
//   node tools/understanding.mjs [--base http://localhost:5180] [ids...]
// Writes tools/.check/understanding/<id>.json.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, checkBudgets, labels } from './understanding-checks.js';
import { listEnvironments, understand } from './understanding-runner.js';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : 'http://localhost:5180';
const requested = args.filter(
  (arg, i) => !arg.startsWith('--') && args[i - 1] !== '--base',
);
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '.check',
  'understanding',
);
mkdirSync(out, { recursive: true });
// The same software WebGL as the Playwright tests, so hosts without a GPU
// work and the metrics match.
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const all = await listEnvironments(browser, base);
const environments = requested.length
  ? all.filter(({ id }) => requested.includes(id))
  : all;

for (const { id, kind } of environments) {
  const report = await understand(browser, base, id);
  writeFileSync(join(out, `${id}.json`), JSON.stringify(report, null, 2));

  const planes = report.planes ?? [];
  const meshes = report.meshes ?? [];
  const hits = report.hits ?? [];
  const triangles = meshes.reduce((sum, m) => sum + m.triangles, 0);
  const depth = report.depth
    ? `${report.depth.center} m (hit ${report.forward?.distance} m)`
    : 'none';
  console.log(
    `\n${id} [${kind}] planes ${planes.length}, meshes ${meshes.length} (${triangles} tris), ` +
      `hits ${hits.filter((h) => h.hit).length}/${hits.length}, depth ${depth}, ` +
      `anchor ${report.anchor?.tracked ? 'tracked' : 'no'}`,
  );
  if (report.metrics) {
    const m = report.metrics;
    console.log(
      `  cost: ${m.drawCalls} draw calls, ${m.triangles} triangles, load ${report.loadMs} ms, ${m.litLamps} lit lamps`,
    );
  }
  console.log(`  planes: ${labels(planes)}`);
  console.log(`  meshes: ${labels(meshes)}`);
  // Captured rooms are irregular, so only floor and ceiling facing is checked.
  const issues = analyze(report, { convex: kind !== 'legacy-scan' });
  if (kind === 'room') issues.push(...checkBudgets(report));
  for (const issue of issues) console.log(`  ! ${issue}`);
}
await browser.close();
