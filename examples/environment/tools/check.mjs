// Checks a built room in the running example (npx vite --port 5180):
// page errors, load time, the metrics of room-metrics.js (draw calls,
// triangles, lit lamps, planes/meshes by label, overlapping furniture
// volumes, objects outside the room), and screenshots from views computed
// from the room bounds (without and with the app's outlines).
//
//   node tools/check.mjs home_office [--base http://localhost:5180]
//     [--view name:px,py,pz:tx,ty,tz ...]
// Writes tools/.check/<id>/summary.json and *.png, and prints the summary.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const id = args.find(
  (arg) =>
    !arg.startsWith('--') && !args[args.indexOf(arg) - 1]?.startsWith('--'),
);
const option = (name) => {
  const values = [];
  args.forEach((arg, i) => arg === `--${name}` && values.push(args[i + 1]));
  return values;
};
const base = option('base')[0] ?? 'http://localhost:5180';
if (!id) throw new Error('usage: node tools/check.mjs <room-id>');
const out = join(dirname(fileURLToPath(import.meta.url)), '.check', id);
mkdirSync(out, { recursive: true });

async function open(browser, outlines) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors = [];
  const warnings = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.goto(`${base}/?room=${id}${outlines ? '' : '&outlines=0'}`);
  await page.getByRole('button', { name: 'Enter AR' }).click();
  await page.waitForFunction(() => (window.xrState?.frames ?? 0) > 30, null, {
    timeout: 120000,
  });
  // Hide DevUI (canvas and panels) for clean screenshots.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      if (['3', '5'].includes(el.style.zIndex)) el.style.display = 'none';
    }
  });
  return { page, errors, warnings };
}

async function look(page, [px, py, pz], [tx, ty, tz]) {
  await page.evaluate(
    async ([p, t]) => {
      const remote = window.xrDevice.remote;
      await remote.dispatch('set_transform', {
        device: 'headset',
        position: { x: p[0], y: p[1], z: p[2] },
      });
      await remote.dispatch('look_at', {
        device: 'headset',
        target: { x: t[0], y: t[1], z: t[2] },
      });
    },
    [
      [px, py, pz],
      [tx, ty, tz],
    ],
  );
  await page.waitForTimeout(350);
}

// The same software WebGL as the Playwright tests, so hosts without a GPU
// work and the metrics match.
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const clean = await open(browser, false);
const report = await clean.page.evaluate(async () => {
  const { roomMetrics } = await import('/tools/room-metrics.js');
  return {
    loadMs: Math.round(window.environmentLoadMs),
    reported: {
      planes: window.xrState.planes.length,
      meshes: window.xrState.meshes.length,
    },
    ...roomMetrics(window.xrDevice.sem),
  };
});

const { x0, x1, z0, z1, height } = report.bounds;
const zc = (z0 + z1) / 2;
const eye = Math.min(1.6, height - 0.4);
const views = {
  back: [
    [0, eye, z1 - 0.5],
    [0, 1.1, z0],
  ],
  front: [
    [0, eye, z0 + 0.5],
    [0, 1.1, z1],
  ],
  left: [
    [x1 - 0.5, eye, zc],
    [x0, 1.1, zc],
  ],
  right: [
    [x0 + 0.5, eye, zc],
    [x1, 1.1, zc],
  ],
  cornerFR: [
    [x1 - 0.35, eye + 0.1, z1 - 0.35],
    [x0 + 0.6, 0.8, z0 + 0.6],
  ],
  cornerBL: [
    [x0 + 0.35, eye + 0.1, z0 + 0.35],
    [x1 - 0.6, 0.8, z1 - 0.6],
  ],
};
for (const spec of option('view')) {
  const [name, p, t] = spec.split(':');
  views[name] = [p.split(',').map(Number), t.split(',').map(Number)];
}
const screenshots = [];
for (const [name, [p, t]] of Object.entries(views)) {
  await look(clean.page, p, t);
  const file = join(out, `${name}.png`);
  await clean.page.screenshot({ path: file });
  screenshots.push(file);
}
const outlined = await open(browser, true);
for (const name of ['back', 'cornerFR']) {
  await look(outlined.page, ...views[name]);
  const file = join(out, `outlines-${name}.png`);
  await outlined.page.screenshot({ path: file });
  screenshots.push(file);
}
await browser.close();

const summary = {
  id,
  ...report,
  errors: [...clean.errors, ...outlined.errors],
  warnings: [...new Set([...clean.warnings, ...outlined.warnings])],
  screenshots,
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
