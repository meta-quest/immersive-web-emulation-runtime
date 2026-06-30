/**
 * Dev helper: capture screenshots of EVERY IWE UI surface for design review.
 * Launches Chrome for Testing with the unpacked @iwer/extension, injects the
 * DevUI on a WebXR page, and screenshots the in-page overlay (out- and
 * in-session), the toolbar popup, the DevTools "WebXR" panel, and the welcome
 * page. Writes PNGs to /tmp/iwe-ui-capture. Not a test.
 *
 * Run: node packages/extension-bridge/e2e/capture-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const EXT = path.join(REPO, 'immersive-web-emulation-runtime/packages/extension');
const CFT = path.join(
  REPO,
  'immersive-web-emulation-runtime/packages/e2e/.cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);
const OUT = '/tmp/iwe-ui-capture';
const WEBXR_URL =
  'https://threejs.org/examples/webxr_xr_dragging.html';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(CFT)) throw new Error(`Chrome for Testing missing at ${CFT}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwe-cap-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CFT,
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const sw =
  ctx.serviceWorkers()[0] ??
  (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const extId = new URL(sw.url()).host;
const domain = new URL(WEBXR_URL).hostname;
console.error(`[cap] extension id: ${extId}`);

// Register the content scripts (DevUI injection) for the WebXR domain.
await sw.evaluate(async (d) => {
  const matches = [`https://${d}/*`, `http://${d}/*`];
  const ids = [`iwe-prefs-seeder-${d}`, `iwe-injection-${d}`, `iwe-bridge-${d}`];
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch {}
  await chrome.scripting.registerContentScripts([
    { id: `iwe-prefs-seeder-${d}`, matches, js: ['build/prefs-seeder.min.js'], allFrames: true, runAt: 'document_start' },
    { id: `iwe-injection-${d}`, matches, js: ['build/iwe.min.js'], allFrames: true, runAt: 'document_start', world: 'MAIN' },
    { id: `iwe-bridge-${d}`, matches, js: ['build/content-bridge.min.js'], allFrames: true, runAt: 'document_start' },
  ]);
}, domain);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- DevUI overlay (out of session) ---
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(WEBXR_URL, { waitUntil: 'load' }).catch(() => {});
await page.bringToFront().catch(() => {});
await sleep(3500);
await page.screenshot({ path: path.join(OUT, '01-devui-overlay.png') });
console.error('[cap] 01-devui-overlay.png');

// Try to expand/interact: click the IWE toolbar device buttons if present, then
// enter a session to reveal the in-session controls.
try {
  await page.getByText(/enter (vr|xr)/i).first().click({ timeout: 4000 });
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, '02-devui-insession.png') });
  console.error('[cap] 02-devui-insession.png');
  await page
    .screenshot({
      path: path.join(OUT, '06-controller.png'),
      clip: { x: 0, y: 455, width: 380, height: 425 },
    })
    .catch(() => {});
  console.error('[cap] 06-controller.png');
  await page
    .screenshot({
      path: path.join(OUT, '06b-controller-right.png'),
      clip: { x: 1060, y: 455, width: 380, height: 425 },
    })
    .catch(() => {});
  console.error('[cap] 06b-controller-right.png');
  await page.getByTitle(/change key bindings/).first().click({ timeout: 3000 }).catch(() => {});
  await sleep(700);
  await page
    .screenshot({
      path: path.join(OUT, '06d-config.png'),
      clip: { x: 0, y: 180, width: 340, height: 720 },
    })
    .catch(() => {});
  console.error('[cap] 06d-config.png');
  await page.getByTitle(/close key bindings/).first().click({ timeout: 3000 }).catch(() => {});
  await sleep(500);
  await page.getByTitle(/change key bindings/).last().click({ timeout: 3000 }).catch(() => {});
  await sleep(700);
  await page
    .screenshot({
      path: path.join(OUT, '06e-config-right.png'),
      clip: { x: 1100, y: 120, width: 340, height: 780 },
    })
    .catch(() => {});
  console.error('[cap] 06e-config-right.png');
  await page.getByTitle(/close key bindings/).last().click({ timeout: 3000 }).catch(() => {});
  await sleep(500);
  await page
    .screenshot({
      path: path.join(OUT, '07-top.png'),
      clip: { x: 0, y: 0, width: 900, height: 210 },
    })
    .catch(() => {});
  console.error('[cap] 07-top.png');
  // Hand panel: toggle input mode to hands, capture the bottom-left panel so we
  // can review the Pose stepper / Pinch field column alignment.
  await page.getByTitle('Toggle input mode').first().click({ timeout: 3000 }).catch(() => {});
  await sleep(900);
  await page
    .screenshot({
      path: path.join(OUT, '06c-hand.png'),
      clip: { x: 0, y: 600, width: 300, height: 300 },
    })
    .catch(() => {});
  console.error('[cap] 06c-hand.png');
  // Toggle back to controllers for the remaining captures.
  await page.getByTitle('Toggle input mode').first().click({ timeout: 3000 }).catch(() => {});
  await sleep(700);
  await page.getByTitle('Headset position').first().click({ timeout: 3000 }).catch(() => {});
  await sleep(600);
  await page
    .screenshot({ path: path.join(OUT, '08-headset.png'), clip: { x: 0, y: 0, width: 900, height: 280 } })
    .catch(() => {});
  console.error('[cap] 08-headset.png');
  await page.getByTitle('Play mode (lock pointer)').first().click({ timeout: 3000 }).catch(() => {});
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, '09-collapsed.png') }).catch(() => {});
  console.error('[cap] 09-collapsed.png');
} catch (e) {
  console.error('[cap] in-session capture skipped:', e.message);
}

// --- Toolbar popup ---
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 400, height: 640 });
await popup.goto(`chrome-extension://${extId}/build/popup.html`, { waitUntil: 'load' }).catch(() => {});
await sleep(1200);
await popup.screenshot({ path: path.join(OUT, '03-popup.png'), fullPage: true });
console.error('[cap] 03-popup.png');

// --- Welcome / whats-new ---
const welcome = await ctx.newPage();
await welcome.setViewportSize({ width: 1100, height: 850 });
await welcome.goto(`chrome-extension://${extId}/build/whats-new.html?mode=welcome`, { waitUntil: 'load' }).catch(() => {});
await sleep(1200);
await welcome.screenshot({ path: path.join(OUT, '04-whats-new.png'), fullPage: true });
console.error('[cap] 04-whats-new.png');

// --- DevTools "WebXR" panel (rendered standalone) ---
const panel = await ctx.newPage();
await panel.setViewportSize({ width: 760, height: 900 });
await panel.goto(`chrome-extension://${extId}/build/panel.html`, { waitUntil: 'load' }).catch(() => {});
await sleep(1500);
await panel.screenshot({ path: path.join(OUT, '05-panel.png'), fullPage: true });
console.error('[cap] 05-panel.png');

console.error(`\n[cap] done — screenshots in ${OUT}`);
await ctx.close();
console.error('[cap] browser closed.');
