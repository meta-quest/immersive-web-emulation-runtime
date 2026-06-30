# How I E2E-tested the IWE extension in a Playwright-driven browser

A faithful, reproducible record of the steps used to load the **real unpacked extension** into a Playwright-controlled Chrome and drive the full MCP bridge chain end-to-end — MCP client → `@iwer/extension-bridge` daemon → `ws://127.0.0.1` → extension offscreen → service worker → content bridge → MAIN-world shim → real IWER `device.remote` → a real WebXR session on a real page.

The committed harness is `immersive-web-emulation-runtime/packages/extension-bridge/e2e/bridge.e2e.mjs` (clean contained page) and `e2e/look-around.mjs` (public third-party page). This doc explains what those scripts do, in order, and the non-obvious decisions behind each step.

---

## 0. Why not vanilla Playwright Chromium (the setup that actually works)

Three dead ends, and the fix for each — worth knowing before you copy a generic "load an extension in Playwright" snippet:

1. **Playwright's bundled Chromium is `headless_shell`, which cannot load MV3 extensions.** You need a _full_ Chrome binary.
2. **Playwright's own browser downloader hung at 100%** (reproduced on Node 24 **and** 26) — so `npx playwright install chromium` was not a usable path in this environment.
3. **Corp/managed Chrome blocks unpacked extensions** (the profile policy loads 0 extensions, silently).

**Fix:** download **Chrome for Testing (CfT)** directly with `curl` (bypassing Playwright's downloader) and point Playwright at that binary via `executablePath`. CfT is an unmanaged, full Chrome with no corp policy. _(On a managed machine you may still get a one-time OS/corp prompt the first time the binary launches — allow it.)_

### One-time: fetch Chrome for Testing

```bash
cd immersive-web-emulation-runtime
curl -fL -o /tmp/cft.zip "$(curl -s https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.channels.Stable.downloads.chrome.find(x=>x.platform==='mac-arm64').url)})")" \
  && mkdir -p packages/e2e/.cft && (cd packages/e2e/.cft && unzip -qo /tmp/cft.zip)
```

This lands the binary at:
`packages/e2e/.cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
(the exact path `bridge.e2e.mjs` references as `CFT`).
Set `IWER_E2E_CHROME=/absolute/path/to/Chrome` to use another full Chrome binary.
Set `IWER_E2E_CHROME_ARGS="--flag=value ..."` for environment-specific launch flags. `bridge.e2e.mjs` also accepts `IWER_E2E_HEADLESS=1` for machines that cannot launch a foreground app, though headed mode remains the default and most faithful path.

### One-time: build the extension

The harness loads `packages/extension/` as an unpacked extension, so its `build/*.min.js` + HTML pages must exist first:

```bash
cd immersive-web-emulation-runtime
pnpm --filter @iwer/extension run build
```

The harness hard-fails early if `build/iwe.min.js` is missing.

---

## 1. Serve a contained WebXR page (loopback HTTP)

Rather than depend on a public site, the harness serves a **minimal fixture** (`e2e/webxr-page.html`) from an in-process `http.createServer` bound to `127.0.0.1` on a random port (`server.listen(0, '127.0.0.1')`). The page is deliberately tiny: an **"Enter XR" button** (`#enter`) that calls `navigator.xr.requestSession(...)` and a `window.__iwerE2E` telemetry object exposing `{ sessionActive, frames }` so the test can assert a real session + frame loop started.

> Why loopback HTTP, not `file://`: extensions/content-scripts and WebXR behave correctly on an `http(s)` origin; `file://` is a different, restricted case.

## 2. Launch Chrome for Testing with the extension

The key call — a **persistent context** (not `chromium.launch()`), **headed** (`headless:false`), pointed at the CfT binary, with the two extension-loading flags:

```js
const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CFT, // the curl-downloaded Chrome for Testing
  headless: false, // MV3 + extension UI require headful
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`, // EXT = absolute path to packages/extension/
  ],
});
```

- **Persistent context** is required: extensions only load against a real on-disk profile (`userDataDir`, a fresh `mkdtemp`). `launch()` + `newContext()` will not load extensions.
- **`headless:false`** — both because MV3 extensions don't load in old headless, and because `browser_screenshot` (`chrome.tabs.captureVisibleTab`) needs a real composited, focused tab.

## 3. Get a handle to the extension's service worker

The MV3 service worker is the control point. Grab it from the context (it may already be running, or wait for it), and derive the extension id from its URL:

```js
let sw =
  ctx.serviceWorkers()[0] ??
  (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const extId = new URL(sw.url()).host; // chrome-extension://<extId>/...
```

`sw.evaluate(fn)` then lets the test run code **inside the extension's SW context** with full `chrome.*` access — this is how the test stands in for the popup UI in the steps below.

## 4. Register the content scripts for the test origin

Normally the toolbar popup's **"Emulate WebXR on this site"** toggle (`TOGGLE_EMULATION`) registers the scripts. To keep the test from driving popup UI, the harness registers them directly via the SW, at **`document_start`**, for `http://localhost/*`:

```js
await sw.evaluate(async () => {
  await chrome.scripting.registerContentScripts([
    {
      id: 'iwe-e2e-main',
      matches: ['http://localhost/*'],
      js: ['build/iwe.min.js'],
      allFrames: true,
      runAt: 'document_start',
      world: 'MAIN',
    }, // the emulator shim
    {
      id: 'iwe-e2e-bridge',
      matches: ['http://localhost/*'],
      js: ['build/content-bridge.min.js'],
      allFrames: true,
      runAt: 'document_start',
    }, // ISOLATED relay (default world)
  ]);
});
```

Two scripts, two worlds: `iwe.min.js` runs in **MAIN** (it must touch page `navigator.xr`), `content-bridge.min.js` runs in **ISOLATED** (it bridges page ↔ service worker).

## 5. Open the page and confirm the emulator injected

```js
const page = await ctx.newPage();
await page.goto(pageUrl, { waitUntil: 'load' });
await page.waitForFunction(() => window.CustomWebXRPolyfill === true, {
  timeout: 10000,
});
```

`window.CustomWebXRPolyfill === true` is the proof the MAIN-world shim ran and **`navigator.xr` is now the emulator**, not native WebXR.

> **Bug this step caught:** on modern Chrome the emulator silently no-opped — `device.remote` worked but the page stayed on _native_ `navigator.xr`. Cause: IWER ≥2.3 skips overriding `navigator.xr` when native WebXR is present. **Fix:** the extension now calls `installRuntime({ forceInstall: true })` (`src/index.ts`). Without it, this `waitForFunction` times out.

## 6. Resolve the bound chrome tab id

The daemon binds one tab. Find its `tabId` via the SW:

```js
const boundTabId = await sw.evaluate(async (url) => {
  const tabs = await chrome.tabs.query({});
  return (tabs.find((t) => t.url?.startsWith(url)) || {}).id;
}, pageUrl);
```

## 7. Start the real daemon over stdio + connect a real MCP client

No mocks — the actual `@iwer/extension-bridge` daemon is spawned over stdio (the universal MCP transport), and a real `@modelcontextprotocol/sdk` `Client` connects to it:

```js
transport = new StdioClientTransport({
  command: process.execPath,
  args: [DAEMON, 'serve'], // bin/iwer-bridge.mjs serve
  env: {
    ...process.env,
    IWER_MCP_PORT: '8765', // fixed loopback WS port for the test
    IWER_MCP_TOKEN: 'e2e-token-abc123', // fixed per-session token
    IWER_MCP_NO_SESSION_FILE: '1', // don't touch ~/.iwer/session.json
  },
  stderr: 'ignore',
});
client = new Client(
  { name: 'emulator-extension-e2e', version: '0.0.0' },
  { capabilities: {} },
);
await client.connect(transport);
```

## 8. Pair — without touching the popup

The popup's Connect/Allow flow is replaced by writing the pairing state straight into the SW, creating the offscreen document, and telling it to dial the daemon's loopback WS:

```js
await sw.evaluate(
  async ({ port, token, tabId }) => {
    await chrome.storage.session.set({
      pairing: {
        host: '127.0.0.1',
        port,
        token,
        boundTabId: tabId,
        boundDomain: 'localhost',
      },
    });
    if (!(await chrome.offscreen.hasDocument?.()))
      await chrome.offscreen.createDocument({
        url: 'build/offscreen.html',
        reasons: ['WORKERS'],
        justification: 'e2e bridge',
      });
    chrome.runtime.sendMessage({
      type: 'iwer-offscreen-connect',
      host: '127.0.0.1',
      port,
      token,
    });
  },
  { port: 8765, token: 'e2e-token-abc123', tabId: boundTabId },
);
```

The **offscreen document** holds the durable WebSocket (the SW alone would die after ~30s idle); it authenticates to the daemon with the token over `ws://127.0.0.1:8765`.

## 9. Wait for the full chain to come live

Poll an immediate tool until it stops erroring with NoBrowser — meaning MCP client → daemon → WS → offscreen → SW → content-bridge → MAIN shim → `device.remote` is end-to-end connected:

```js
for (let i = 0; i < 40; i++) {
  const r = await client.callTool({
    name: 'xr_get_session_status',
    arguments: {},
  });
  if (!r.isError) {
    connected = true;
    break;
  }
  await sleep(500);
}
check('extension connected to daemon (full chain live)', connected);
```

## 10. Drive the sequence and assert real state changes

The 8 checks the harness makes, each over the real chain:

1. `xr_get_session_status` → returns a real device (name matches `/quest/i`), `sessionActive === false`.
2. `xr_get_device_state` → real headset pose (`headset.position.y` is a number).
3. **Real "Enter XR" click on the page** (`page.bringToFront(); page.click('#enter')`) → `requestSession`; wait for `window.__iwerE2E.sessionActive === true` and `frames > 3` (a real frame loop).
4. `xr_get_session_status` again → the **agent** now sees `sessionActive === true`.
5. `xr_look_at` (target `{1,1.6,-2}`) → compare `xr_get_transform` before/after → orientation **changed**.
6. `xr_select` (controller-right) → completes without error.
7. `browser_screenshot` → returns a real base64 image (`length > 100`), saved to `e2e/last-screenshot.jpeg`.

`page.bringToFront()` before the screenshot matters: `captureVisibleTab` captures the **focused** tab.

> **Bug this step caught:** `browser_screenshot` returned a black frame on WebGL pages. Cause: the old `capture_canvas` did `canvas.toDataURL()` on a context without `preserveDrawingBuffer`. **Fix:** `browser_screenshot` is now a _browser-host_ tool — the SW captures the composited tab via `chrome.tabs.captureVisibleTab()` + `OffscreenCanvas` (works on any page). It needs `<all_urls>` host permission, because the `activeTab` gesture isn't available in this scripted harness.

## 11. Teardown

`client.close()` → `ctx.close()` → `server.close()`. The temp `userDataDir` is a throwaway `mkdtemp`.

---

## Running it

```bash
# one-time: §0 (fetch CfT) + build the extension
pnpm --filter @iwer/extension run build

# the real-browser E2E (clean contained page):
pnpm --filter @iwer/extension-bridge build
pnpm --filter @iwer/extension-bridge test:e2e          # runs e2e/bridge.e2e.mjs → "ALL CHECKS PASSED ✅"
```

### Variant: a real public third-party page

`e2e/look-around.mjs` reuses the same harness (§0–§9) but:

- `page.goto('https://immersive-web.github.io/webxr-samples/immersive-vr-session.html')`,
- clicks the sample's own **"Enter VR"** button,
- drives `xr_animate_to` to turn the headset left/right/up/down,
- `browser_screenshot` at each angle, saving `look/bridge-*.jpeg` (bridge captures) and `look/view-*.png` (Playwright viewport) — all distinct frames, confirming the headset actually turns and the screenshot reflects it.

---

## Gotchas, condensed (each cost real time)

| Symptom                                                   | Cause                                            | Fix                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Playwright Chromium download hangs at 100% (Node 24 & 26) | Playwright's downloader                          | `curl` Chrome for Testing directly (§0)                                             |
| 0 extensions loaded                                       | Corp/managed Chrome policy blocks unpacked       | Use CfT (unmanaged); allow the one-time corp launch prompt                          |
| Extension won't load even headless                        | `headless_shell` can't load MV3                  | `headless:false` + `launchPersistentContext` (§2)                                   |
| `waitForFunction(CustomWebXRPolyfill)` times out          | IWER ≥2.3 won't override native `navigator.xr`   | `installRuntime({ forceInstall: true })`                                            |
| `browser_screenshot` is black                             | `toDataURL` on WebGL w/o `preserveDrawingBuffer` | host-side `captureVisibleTab` + `OffscreenCanvas`; needs `<all_urls>` + focused tab |
| Screenshot empty in harness                               | `activeTab` gesture unavailable when scripted    | `<all_urls>` host permission                                                        |

## Limitation worth noting

This harness drives the extension via its **service worker + content scripts** (`sw.evaluate`, `chrome.scripting`, `chrome.storage`), which is the load-bearing path. It does **not** automate the popup or a DevTools panel — Playwright can't click extension popup chrome or DevTools panels directly. Popup/panel logic is best tested by loading their HTML as a normal page with `chrome.*` shimmed (relevant to the upcoming settings-panel work — see `iwe-settings-panel-plan.md` §11).
