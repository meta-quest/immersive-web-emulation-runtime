/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * MCP bridge end-to-end test (real chain, no mocks):
 *
 *   MCP client ──stdio──► @iwer/extension-bridge daemon ──ws://127.0.0.1──► IWE extension
 *     (offscreen WS client → service worker → content bridge → MAIN-world shim
 *      → real IWER device.remote) ──► a real WebXR page that enters a session.
 *
 * Launches a clean Chrome for Testing with the unpacked extension, serves a
 * contained WebXR page, offers + accepts an XR session, and drives the MVP exit
 * sequence (get_session_status → get_device_state → accept_session → look_at →
 * select → browser_screenshot), asserting real state changes + a real image.
 *
 * Run: pnpm --filter @iwer/extension-bridge test:e2e
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const REPO = path.resolve(PKG, '..', '..', '..'); // webxr-dev-platform
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
const PAGE_HTML = fs.readFileSync(path.join(HERE, 'webxr-page.html'), 'utf8');

const PORT_WS = 8765;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (res) =>
  (res.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const jsonOf = (res) => {
  try {
    return JSON.parse(textOf(res).replace(/^WARNING:.*\n/, ''));
  } catch {
    return null;
  }
};
const imageOf = (res) => (res.content || []).find((c) => c.type === 'image');

async function main() {
  if (!fs.existsSync(CFT))
    throw new Error(`Chrome for Testing missing at ${CFT}`);
  if (!fs.existsSync(path.join(EXT, 'build', 'iwe.min.js')))
    throw new Error(
      'Extension not built — run `pnpm --filter @iwer/extension run build` first.',
    );

  // 1. Serve the contained WebXR page.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE_HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pagePort = server.address().port;
  const pageUrl = `http://localhost:${pagePort}/`;
  console.log(`[e2e] serving WebXR page at ${pageUrl}`);

  // 2. Launch clean Chrome for Testing with the extension.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwe-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CFT,
    headless: process.env.IWER_E2E_HEADLESS === '1',
    args: [
      ...EXTRA_CHROME_ARGS,
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });
  console.log('[e2e] launched Chrome for Testing + extension');

  let client;
  let transport;
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log(`[e2e] extension service worker up; id=${extId}`);

    // 3. Register prefs seeder (ISOLATED), IWER (MAIN), and content bridge
    // (ISOLATED) at document_start for localhost.
    await sw.evaluate(async () => {
      const matches = ['http://localhost/*'];
      await chrome.storage.local.set({
        'iwe-prefs:v1': {
          version: 1,
          origins: {
            localhost: {
              device: 'metaQuest2',
              environment: 'office_small',
              inputMode: 'hand',
              ipd: 0.063,
            },
          },
        },
      });
      // Register under the SAME script IDs the service worker uses for an
      // emulated domain, so its hasRegisteredScript('localhost') recognizes the
      // tab as emulated (the consent gate validates the target tab that way).
      const ids = [
        'iwe-prefs-seeder-localhost',
        'iwe-injection-localhost',
        'iwe-bridge-localhost',
      ];
      try {
        await chrome.scripting.unregisterContentScripts({ ids });
      } catch {}
      await chrome.scripting.registerContentScripts([
        {
          id: 'iwe-prefs-seeder-localhost',
          matches,
          js: ['build/prefs-seeder.min.js'],
          allFrames: true,
          runAt: 'document_start',
        },
        {
          id: 'iwe-injection-localhost',
          matches,
          js: ['build/iwe.min.js'],
          allFrames: true,
          runAt: 'document_start',
          world: 'MAIN',
        },
        {
          id: 'iwe-bridge-localhost',
          matches,
          js: ['build/content-bridge.min.js'],
          allFrames: true,
          runAt: 'document_start',
        },
      ]);
    });

    // 4. Open the page; IWER injects at document_start.
    const page = await ctx.newPage();
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.CustomWebXRPolyfill === true, {
      timeout: 10000,
    });
    console.log('[e2e] IWER injected into the page (navigator.xr is emulated)');
    const seeded = await page.evaluate(() => ({
      deviceName: window.__IWE_XR_DEVICE__?.name,
      inputMode: window.__IWE_XR_DEVICE__?.primaryInputMode,
      ipd: window.__IWE_XR_DEVICE__?.ipd,
      prefs: window.__IWE_PREFS__,
    }));
    check(
      'seeded prefs selected Meta Quest 2',
      /quest 2/i.test(seeded.deviceName || ''),
      JSON.stringify(seeded),
    );
    check(
      'seeded prefs selected hand input mode',
      seeded.inputMode === 'hand' &&
        seeded.prefs?.environment === 'office_small',
      JSON.stringify(seeded),
    );
    check(
      'seeded environment did not fetch unpkg',
      !requests.some((url) => url.includes('unpkg.com')),
      requests.filter((url) => url.includes('unpkg.com')).join(', '),
    );

    // 5. Find the chrome tabId for this page (the bound tab).
    const boundTabId = await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return (tabs.find((t) => t.url && t.url.startsWith(url)) || {}).id;
    }, pageUrl);
    if (boundTabId == null) throw new Error('could not resolve bound tabId');

    // 6. Start the real daemon over stdio + connect an MCP client.
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DAEMON, 'serve'],
      env: {
        ...process.env,
        IWER_MCP_PORT: String(PORT_WS),
      },
      stderr: 'ignore',
    });
    client = new Client(
      { name: 'emulator-extension-e2e', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    console.log('[e2e] daemon up; MCP client connected');

    // 7. Spawn the offscreen WS client and point it at the daemon (no token).
    await sw.evaluate(
      async ({ port }) => {
        const has = (await chrome.offscreen.hasDocument?.()) ?? false;
        if (!has)
          await chrome.offscreen.createDocument({
            url: 'build/offscreen.html',
            reasons: ['WORKERS'],
            justification: 'e2e bridge',
          });
        chrome.runtime.sendMessage({
          type: 'iwer-offscreen-connect',
          host: '127.0.0.1',
          port,
        });
      },
      { port: PORT_WS },
    );
    console.log('[e2e] offscreen created; waiting for the WS to connect…');

    // 8. Wait until the offscreen WS is connected (SW records it in session storage).
    let connected = false;
    for (let i = 0; i < 40; i++) {
      connected = await sw.evaluate(
        async () =>
          (await chrome.storage.session.get('connected')).connected === true,
      );
      if (connected) break;
      await sleep(500);
    }
    check('extension connected to daemon (full chain live)', connected);
    if (!connected) throw new Error('extension never connected');

    // 8b. Consent gate: with no Allow yet and a non-emulated tab focused, there
    // is no consented/eligible tab, so a request is refused fast (nothing is
    // served without consent). Uses a throwaway active tab to avoid triggering
    // the in-page overlay (which would cover the page and block later clicks).
    const blank = await ctx.newPage();
    await blank.bringToFront();
    const gateRes = await client.callTool({
      name: 'xr_get_session_status',
      arguments: {},
    });
    check(
      'request is refused when no tab has consented',
      gateRes.isError === true,
      textOf(gateRes),
    );
    await blank.close();
    await page.bringToFront();

    // 8c. Simulate the user clicking Allow on the overlay (designate the tab).
    await sw.evaluate(
      (tabId) =>
        chrome.storage.session.set({
          agentTab: { tabId, domain: 'localhost' },
        }),
      boundTabId,
    );
    console.log('[e2e] consent granted for the tab');

    console.log(
      '\n[e2e] === driving the MVP exit sequence over the real chain ===',
    );

    // get_session_status
    const status = await client.callTool({
      name: 'xr_get_session_status',
      arguments: {},
    });
    const st = jsonOf(status);
    check(
      'xr_get_session_status returns real device',
      st && /quest/i.test(st.deviceName || ''),
      JSON.stringify(st),
    );
    check(
      'no session active before Enter XR',
      st && st.sessionActive === false,
    );

    // get_device_state (real IWER pose)
    const ds0 = jsonOf(
      await client.callTool({ name: 'xr_get_device_state', arguments: {} }),
    );
    check(
      'xr_get_device_state returns headset pose',
      ds0 && typeof ds0.headset?.position?.y === 'number',
      JSON.stringify(ds0?.headset),
    );

    // Enter XR via a real user click on the page's button (requestSession).
    await page.bringToFront();
    await page.click('#enter');
    await page
      .waitForFunction(() => window.__iwerE2E?.sessionActive === true, {
        timeout: 10000,
      })
      .catch(() => {});
    await page
      .waitForFunction(() => (window.__iwerE2E?.frames || 0) > 3, {
        timeout: 10000,
      })
      .catch(() => {});
    const pageState = await page.evaluate(() => window.__iwerE2E);
    check(
      'clicking "Enter XR" started a real session + frame loop',
      pageState.sessionActive === true && pageState.frames > 3,
      JSON.stringify(pageState),
    );

    const statusAfter = jsonOf(
      await client.callTool({ name: 'xr_get_session_status', arguments: {} }),
    );
    check(
      'agent sees the session active after Enter XR',
      statusAfter && statusAfter.sessionActive === true,
      JSON.stringify(statusAfter),
    );

    // look_at (session-required, processed by the live frame loop)
    const beforeQuat = jsonOf(
      await client.callTool({
        name: 'xr_get_transform',
        arguments: { device: 'headset' },
      }),
    );
    await client.callTool({
      name: 'xr_look_at',
      arguments: { device: 'headset', target: { x: 1, y: 1.6, z: -2 } },
    });
    const afterQuat = jsonOf(
      await client.callTool({
        name: 'xr_get_transform',
        arguments: { device: 'headset' },
      }),
    );
    const moved =
      beforeQuat &&
      afterQuat &&
      JSON.stringify(beforeQuat.orientation) !==
        JSON.stringify(afterQuat.orientation);
    check(
      'xr_look_at changed the headset orientation',
      !!moved,
      `before=${JSON.stringify(beforeQuat?.orientation)} after=${JSON.stringify(afterQuat?.orientation)}`,
    );

    // select
    const select = await client.callTool({
      name: 'xr_select',
      arguments: { device: 'controller-right' },
    });
    check('xr_select completed', !select.isError, textOf(select));

    // screenshot → real image
    const shot = await client.callTool({
      name: 'browser_screenshot',
      arguments: {},
    });
    const img = imageOf(shot);
    check(
      'browser_screenshot returned an image',
      !!img && typeof img.data === 'string' && img.data.length > 100,
      img ? `${img.mimeType} ${img.data.length}b64` : 'no image',
    );
    if (img) {
      const out = path.join(
        HERE,
        `last-screenshot.${img.mimeType.split('/')[1] || 'png'}`,
      );
      fs.writeFileSync(out, Buffer.from(img.data, 'base64'));
      console.log(`[e2e] saved screenshot → ${out}`);
    }

    console.log('');
  } finally {
    try {
      if (client) await client.close();
    } catch {}
    try {
      await ctx.close();
    } catch {}
    server.close();
  }

  console.log(
    failures === 0
      ? '\n[e2e] ALL CHECKS PASSED ✅'
      : `\n[e2e] ${failures} CHECK(S) FAILED ❌`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[e2e] ERROR', e);
  process.exit(1);
});
