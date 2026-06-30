/**
 * Dev helper: launch Chrome for Testing with the unpacked @iwer/extension loaded
 * and emulation auto-enabled on a WebXR page, then stay open until you close the
 * window. Not a test.
 *
 * Run: node packages/extension-bridge/e2e/view.mjs [url]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..'); // webxr-dev-platform
const EXT = path.join(REPO, 'immersive-web-emulation-runtime/packages/extension');
const CFT = path.join(
  REPO,
  'immersive-web-emulation-runtime/packages/e2e/.cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);
const targetUrl =
  process.argv[2] ||
  'https://immersive-web.github.io/webxr-samples/immersive-vr-session.html';

if (!fs.existsSync(CFT)) throw new Error(`Chrome for Testing missing at ${CFT}`);
if (!fs.existsSync(path.join(EXT, 'build', 'iwe.min.js')))
  throw new Error('Extension not built — run `pnpm --filter @iwer/extension run build` first.');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwe-view-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CFT,
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let sw =
  ctx.serviceWorkers()[0] ??
  (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const extId = new URL(sw.url()).host;
const domain = new URL(targetUrl).hostname;

// Enable emulation for the target domain AND spawn the offscreen WS client so
// the extension connects to the local daemon (port 8723). Register under the
// service worker's own per-domain script IDs so its hasRegisteredScript()
// recognizes the tab as emulated (the consent gate validates the tab that way).
// Consent is intentionally NOT pre-granted — when the agent first acts, the real
// in-page Allow prompt appears.
await sw.evaluate(async (d) => {
  const matches = [`https://${d}/*`, `http://${d}/*`];
  const ids = [
    `iwe-prefs-seeder-${d}`,
    `iwe-injection-${d}`,
    `iwe-bridge-${d}`,
  ];
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch {}
  await chrome.scripting.registerContentScripts([
    { id: `iwe-prefs-seeder-${d}`, matches, js: ['build/prefs-seeder.min.js'], allFrames: true, runAt: 'document_start' },
    { id: `iwe-injection-${d}`, matches, js: ['build/iwe.min.js'], allFrames: true, runAt: 'document_start', world: 'MAIN' },
    { id: `iwe-bridge-${d}`, matches, js: ['build/content-bridge.min.js'], allFrames: true, runAt: 'document_start' },
  ]);
  if (!((await chrome.offscreen.hasDocument?.()) ?? false)) {
    await chrome.offscreen.createDocument({
      url: 'build/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Connect to the local agent bridge daemon.',
    });
  }
}, domain);

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(targetUrl, { waitUntil: 'load' }).catch(() => {});
// On install the extension opens its welcome tab, which steals "active" — pull
// the WebXR page back to the foreground so it's the active emulated tab the
// agent's consent gate resolves to.
await page.bringToFront().catch(() => {});

console.error(`\n[iwe-view] Chrome for Testing is open.`);
console.error(`[iwe-view] extension id: ${extId}`);
console.error(`[iwe-view] page: ${targetUrl}`);
console.error(`[iwe-view] Emulation is on + the offscreen bridge is connecting to the daemon (:8723).`);
console.error(`[iwe-view] When the agent first acts, an "Allow agent control of this tab?" prompt`);
console.error(`[iwe-view] appears on the page — click Allow.`);
console.error(`[iwe-view] Close the browser window when you're done.\n`);

await new Promise((resolve) => ctx.on('close', resolve));
console.error('[iwe-view] browser closed.');
