#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Runs the XR pipeline test app (xr-test-app/main.js) in Quest Browser, for A/B comparisons with the runtime on the
// same headset (colour parity XR-COL-1, foveation GPU savings XR-FOV-1). Drives only a tab it creates, over the
// browser's DevTools port forwarded to 127.0.0.1:<cdp> (adb forward tcp:<cdp> localabstract:chrome_devtools_remote).
//
//   node browser-ab.mjs --cdp 9509 open [url]     open our own tab on an https origin whose page DevTools serves
//   node browser-ab.mjs --cdp 9509 inject         run main.js in it and enter XR (requestSession with a user gesture)
//   node browser-ab.mjs --cdp 9509 eval '<expr>'  evaluate in our tab (e.g. __xrtest.layerObject.fixedFoveation = 1)
//   node browser-ab.mjs --cdp 9509 close          end the session and close our tab
//
// Our tab is recognised by the marker in its URL fragment (#iwn-xr-ab).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let cdp = 9509;
if (args[0] === '--cdp') {
  cdp = Number(args[1]);
  args.splice(0, 2);
}
const MARK = '#iwn-xr-ab';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((r) => {
            const i = ++id;
            pending.set(i, r);
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

async function ourTab() {
  const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
  return list.find(
    (t) =>
      t.type === 'page' && typeof t.url === 'string' && t.url.endsWith(MARK),
  );
}

async function evaluate(expression, userGesture = false) {
  const tab = await ourTab();
  if (!tab) throw new Error('our tab is not open (run: open)');
  const c = await connect(tab.webSocketDebuggerUrl);
  const r = await c.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  c.close();
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
}

const [cmd, arg] = args;
if (cmd === 'open') {
  // A secure context with no network: our tab navigates to an https origin of its own whose document DevTools
  // serves (Fetch domain), so no server and no extra port is needed.
  const version = await (
    await fetch(`http://127.0.0.1:${cdp}/json/version`)
  ).json();
  const b = await connect(version.webSocketDebuggerUrl);
  const r = await b.send('Target.createTarget', { url: 'about:blank' });
  b.close();
  const targetId = r.result?.targetId;
  await sleep(1000);
  const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
  const tab = list.find((t) => t.id === targetId);
  if (!tab) throw new Error('the new tab did not appear');
  const url = (arg ?? 'https://iwn-xr-ab.test/') + MARK;
  const origin = new URL(url).origin;
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>iwer-native XR A/B</title></head><body></body></html>';
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let id = 0;
    const send = (method, params = {}) =>
      ws.send(JSON.stringify({ id: ++id, method, params }));
    const timer = setTimeout(
      () => reject(new Error('navigation timed out')),
      20000,
    );
    ws.onopen = () => {
      send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*` }] });
      send('Page.enable');
      send('Page.navigate', { url });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Fetch.requestPaused') {
        send('Fetch.fulfillRequest', {
          requestId: m.params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          ],
          body: Buffer.from(html).toString('base64'),
        });
      } else if (m.method === 'Page.loadEventFired') {
        send('Fetch.disable');
        clearTimeout(timer);
        setTimeout(() => {
          ws.close();
          resolve();
        }, 200);
      }
    };
    ws.onerror = reject;
  });
  console.log(
    JSON.stringify({ target: targetId, url, browser: version.Browser }),
  );
} else if (cmd === 'inject') {
  const src = readFileSync(path.join(here, 'xr-test-app/main.js'), 'utf8');
  // No hand tracking requested: Quest Browser would ask for permission in its own UI, which this tool never touches.
  const wrapped = `globalThis.__xrtestMode = 'request'; globalThis.__xrtestInit = { requiredFeatures: ['local-floor'], optionalFeatures: ['layers'] };
(async () => {\n${src}\n})().then(() => 'injected', (e) => 'error: ' + e)`;
  console.log(await evaluate(wrapped, true));
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await evaluate(
      'JSON.stringify({ frames: __xrtest.xrFrames, layer: __xrtest.layer, errors: __xrtest.errors })',
    );
    if (JSON.parse(s).frames > 30 || JSON.parse(s).errors.length) {
      console.log(s);
      break;
    }
  }
} else if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(arg)));
} else if (cmd === 'close') {
  try {
    await evaluate(
      '__xrtest.sessionObject ? __xrtest.sessionObject.end().then(() => "ended") : "no session"',
    );
  } catch {
    // no session
  }
  const tab = await ourTab();
  if (tab) {
    const version = await (
      await fetch(`http://127.0.0.1:${cdp}/json/version`)
    ).json();
    const b = await connect(version.webSocketDebuggerUrl);
    await b.send('Target.closeTarget', { targetId: tab.id });
    b.close();
  }
  console.log('closed');
} else {
  console.error(
    'usage: browser-ab.mjs [--cdp 9509] open [url] | inject | eval <expr> | close',
  );
  process.exit(2);
}
