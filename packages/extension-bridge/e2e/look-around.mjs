// Drive a REAL public WebXR sample via the extension MCP bridge:
// load immersive-web.github.io's immersive-vr-session sample in a clean Chrome
// + the IWE extension, click its "Enter VR" button, then use the MCP bridge to
// turn the emulated headset and look around (screenshots at each angle).
// Stays open so you can watch. Ctrl-C to quit.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const REPO = path.resolve(PKG, '..', '..', '..');
const EXT = path.join(
  REPO,
  'immersive-web-emulation-runtime/packages/extension',
);
const CFT =
  process.env.IWER_E2E_CHROME ||
  path.join(
    REPO,
    'immersive-web-emulation-runtime/packages/e2e/.cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
const EXTRA_CHROME_ARGS = (process.env.IWER_E2E_CHROME_ARGS || '')
  .split(/\s+/)
  .filter(Boolean);
const DAEMON = path.join(PKG, 'bin', 'iwer-bridge.mjs');
const SAMPLE =
  'https://immersive-web.github.io/webxr-samples/immersive-vr-session.html';
const PORT_WS = 8770;
const SHOTS = path.join(HERE, 'look');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (res) =>
  (res.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const imageOf = (res) => (res.content || []).find((c) => c.type === 'image');
const jsonOf = (res) => {
  try {
    return JSON.parse(textOf(res).replace(/^WARNING:.*\n/, ''));
  } catch {
    return null;
  }
};

async function snap(client, page, label) {
  // (a) the bridge's own screenshot tool (capture_canvas)
  const shot = await client.callTool({
    name: 'browser_screenshot',
    arguments: { maxWidth: 900, format: 'jpeg', quality: 0.8 },
  });
  const img = imageOf(shot);
  if (img)
    fs.writeFileSync(
      path.join(SHOTS, `bridge-${label}.jpeg`),
      Buffer.from(img.data, 'base64'),
    );
  // (b) the actual rendered viewport (what the human sees) — proves rotation
  await page.screenshot({ path: path.join(SHOTS, `view-${label}.png`) });
  console.log(
    `  📸 ${label}: bridge=${img ? img.data.length + 'b64' : 'NONE → ' + textOf(shot).slice(0, 180)}  viewport=view-${label}.png`,
  );
}

const ctx = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(os.tmpdir(), 'iwe-look-')),
  {
    executablePath: CFT,
    headless: false,
    args: [
      ...EXTRA_CHROME_ARGS,
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  },
);
console.log('[look] launched Chrome for Testing + extension');
let client;
try {
  let sw =
    ctx.serviceWorkers()[0] ||
    (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  await sw.evaluate(async () => {
    const m = ['https://immersive-web.github.io/*'];
    // Use the service worker's own per-domain script IDs so its
    // hasRegisteredScript() recognizes the tab as emulated (the consent gate
    // validates the target tab that way). eTLD+1 = immersive-web.github.io.
    const ids = [
      'iwe-prefs-seeder-immersive-web.github.io',
      'iwe-injection-immersive-web.github.io',
      'iwe-bridge-immersive-web.github.io',
    ];
    try {
      await chrome.scripting.unregisterContentScripts({ ids });
    } catch {}
    await chrome.scripting.registerContentScripts([
      {
        id: 'iwe-prefs-seeder-immersive-web.github.io',
        matches: m,
        js: ['build/prefs-seeder.min.js'],
        allFrames: true,
        runAt: 'document_start',
      },
      {
        id: 'iwe-injection-immersive-web.github.io',
        matches: m,
        js: ['build/iwe.min.js'],
        allFrames: true,
        runAt: 'document_start',
        world: 'MAIN',
      },
      {
        id: 'iwe-bridge-immersive-web.github.io',
        matches: m,
        js: ['build/content-bridge.min.js'],
        allFrames: true,
        runAt: 'document_start',
      },
    ]);
  });

  const page = await ctx.newPage();
  console.log(`[look] navigating to ${SAMPLE}`);
  await page.goto(SAMPLE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.CustomWebXRPolyfill === true, {
    timeout: 15000,
  });
  console.log('[look] IWER injected; navigator.xr is emulated (forceInstall)');

  const boundTabId = await sw.evaluate(
    async (u) =>
      (
        (await chrome.tabs.query({})).find(
          (t) => t.url && t.url.startsWith(u),
        ) || {}
      ).id,
    SAMPLE,
  );

  // daemon + MCP client
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DAEMON, 'serve'],
    env: {
      ...process.env,
      IWER_MCP_PORT: String(PORT_WS),
    },
    stderr: 'ignore',
  });
  client = new Client(
    { name: 'look-around', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  // Spawn the offscreen WS client (no token) and grant per-tab consent (what the
  // in-page Allow prompt would do).
  await sw.evaluate(
    async ({ port, tabId }) => {
      if (!((await chrome.offscreen.hasDocument?.()) ?? false))
        await chrome.offscreen.createDocument({
          url: 'build/offscreen.html',
          reasons: ['WORKERS'],
          justification: 'bridge',
        });
      chrome.runtime.sendMessage({
        type: 'iwer-offscreen-connect',
        host: '127.0.0.1',
        port,
      });
      await chrome.storage.session.set({
        agentTab: { tabId, domain: 'immersive-web.github.io' },
      });
    },
    { port: PORT_WS, tabId: boundTabId },
  );

  // wait for the bridge to go live
  for (let i = 0; i < 40; i++) {
    const r = await client.callTool({
      name: 'xr_get_session_status',
      arguments: {},
    });
    if (!r.isError) break;
    await sleep(500);
  }
  console.log('[look] bridge live; clicking the sample\'s "Enter VR" button…');

  // Click the sample's Enter VR button (real user gesture → requestSession).
  const btn = page.getByRole('button', { name: /enter (vr|xr)/i }).first();
  await btn.click({ timeout: 15000 }).catch(async () => {
    await page
      .locator('button', { hasText: /enter/i })
      .first()
      .click({ timeout: 8000 });
  });

  // wait until the agent sees the session active
  let active = false;
  for (let i = 0; i < 30; i++) {
    const st = jsonOf(
      await client.callTool({ name: 'xr_get_session_status', arguments: {} }),
    );
    if (st && st.sessionActive) {
      active = true;
      break;
    }
    await sleep(500);
  }
  console.log(
    active
      ? '[look] ✅ XR session active — looking around now'
      : '[look] ⚠️ session not active; will still try to drive',
  );
  await snap(client, page, '0-initial');

  // Turn the headset to look around (smooth animate_to over the sample's frame loop).
  const moves = [
    { label: '1-left', orientation: { yaw: 60 }, duration: 1.2 },
    { label: '2-right', orientation: { yaw: -60 }, duration: 1.6 },
    { label: '3-up', orientation: { yaw: 0, pitch: 30 }, duration: 1.2 },
    { label: '4-down', orientation: { yaw: 0, pitch: -30 }, duration: 1.2 },
    { label: '5-center', orientation: { yaw: 0, pitch: 0 }, duration: 1.0 },
  ];
  for (const m of moves) {
    const r = await client.callTool({
      name: 'xr_animate_to',
      arguments: {
        device: 'headset',
        orientation: m.orientation,
        duration: m.duration,
      },
    });
    const res = jsonOf(r);
    console.log(
      `  ↪ look ${m.label.split('-')[1]} (${JSON.stringify(m.orientation)}) → ${r.isError ? 'ERROR ' + textOf(r) : 'ok, quat=' + JSON.stringify(res?.orientation)}`,
    );
    await sleep(400);
    await snap(client, page, m.label);
  }

  console.log(
    '\n[look] done. Browser stays OPEN so you can watch / drive more. Ctrl-C to close.',
  );
  await new Promise(() => {});
} catch (e) {
  console.error('[look] ERROR', e);
  try {
    if (client) await client.close();
  } catch {}
  try {
    await ctx.close();
  } catch {}
  process.exit(1);
}
