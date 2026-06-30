# Extension MCP bridge — verification & live E2E

What the automated tests cover, and how to run the full live loop (extension + daemon + a real coding agent on a real WebXR page).

## Automated (CI-able)

- **Daemon unit + integration** (`packages/extension-bridge`, 36 tests): relay first-response-wins + cleanStale, the 20-tool catalog + Zod validation, screenshot remap + size-ceiling re-request, `127.0.0.1`/Origin/token gate (live WS), config writers (JSON merge + codex TOML, idempotent), and a **full-chain integration test** that spawns the real daemon over stdio, connects a WebSocket browser stand-in, and runs `xr_get_session_status → xr_accept_session → xr_look_at → xr_select → browser_screenshot`.
  ```bash
  pnpm --filter @iwer/extension-bridge build && pnpm --filter @iwer/extension-bridge test
  ```
- **IWER transport contract** (`packages/iwer`, 4 tests): a plain `{postMessage, addEventListener}` port drives the real `XRDevice.remote` via `connectTransport`.
  ```bash
  pnpm --filter iwer exec jest tests/remote/connectTransport.test.ts
  ```
- **Extension build** (all 5 MV3 bundles + HTML pages) and a focused bridge typecheck:
  ```bash
  pnpm --filter @iwer/extension run typecheck:bridge
  pnpm --filter @iwer/extension run build
  ```
- **Real browser end-to-end** (`packages/extension-bridge/e2e/bridge.e2e.mjs`): launches a clean **Chrome for Testing** with the _real unpacked extension_, serves a contained WebXR page (`e2e/webxr-page.html`), starts the _real daemon_ over stdio + an MCP client, registers the IWER injection, **clicks "Enter XR"** (real `requestSession`), then drives the whole chain — MCP client → daemon → WS → offscreen → service worker → content bridge → MAIN-world shim → real `device.remote` → real WebXR session — asserting the agent sees the session active, `xr_look_at` changes the headset orientation, `xr_select` completes, and `browser_screenshot` returns a real image (saved to `e2e/last-screenshot.jpeg`). All 8 checks pass.
  ```bash
  # one-time: fetch a clean Chrome (corp/managed Chrome blocks unpacked extensions;
  # the broken bit was Playwright's own downloader hanging on bleeding-edge Node):
  curl -fL -o /tmp/cft.zip "$(curl -s https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.channels.Stable.downloads.chrome.find(x=>x.platform==='mac-arm64').url)})")" \
    && mkdir -p packages/e2e/.cft && (cd packages/e2e/.cft && unzip -qo /tmp/cft.zip)
  # then:
  pnpm --filter @iwer/extension run build       # build the extension first
  pnpm --filter @iwer/extension-bridge build && pnpm --filter @iwer/extension-bridge test:e2e
  ```
  > **Bug this caught:** the extension must call `installRuntime({ forceInstall: true })`. IWER ≥2.3 skips overriding `navigator.xr` when native WebXR is present, so on modern Chrome the emulator silently no-ops (`device.remote` works but the page stays on native WebXR). Fixed in `src/index.ts`.
- **Real third-party page demo** (`packages/extension-bridge/e2e/look-around.mjs`): loads `immersive-web.github.io/webxr-samples/immersive-vr-session.html`, clicks its **Enter VR**, then drives `xr_animate_to` to turn the headset (left/right/up/down) and `browser_screenshot` at each angle. Saves both the bridge screenshots (`look/bridge-*.jpeg`) and viewport captures (`look/view-*.png`) — all distinct, confirming the headset turns and the screenshot reflects it.
  > **Architecture note:** `browser_screenshot` is a **browser-host tool**, not an IWER device method. `capture_canvas` was removed from IWER; the extension SW now captures the composited tab via `chrome.tabs.captureVisibleTab()` + `OffscreenCanvas`, so it works on any page (the old `capture_canvas` returned black on pages without `preserveDrawingBuffer`). Needs `<all_urls>` (or the `activeTab` Connect gesture) and the bound tab must be focused.

## Live E2E (manual — needs headful Chrome + a real agent)

The live loop needs a loaded extension, a real browser, and an MCP-speaking agent, so it is a manual gate rather than CI.

1. **Build everything**
   ```bash
   # in immersive-web-emulation-runtime
   pnpm build:all
   pnpm --filter @iwer/extension-bridge build
   pnpm --filter @iwer/extension run build
   ```
2. **Load the extension**: `chrome://extensions` → Developer mode → Load unpacked → select `immersive-web-emulation-runtime/packages/extension/`.
3. **Wire your agent**:
   ```bash
   node immersive-web-emulation-runtime/packages/extension-bridge/bin/iwer-bridge.mjs install --client claude
   # or: claude mcp add --scope user iwer -- node <abs>/packages/extension-bridge/bin/iwer-bridge.mjs serve
   ```
   Restart the agent so it picks up the MCP server.
4. **Open a WebXR page** (e.g. an `iwsdk.dev` example, `https://immersive-web.github.io/webxr-samples/`, or your dev server). Click the IWE toolbar icon → toggle **Emulate WebXR on this site** (the page reloads with the synthetic Quest 3 + SEM scene).
5. **Pair**: in a terminal run `node .../packages/extension-bridge/bin/iwer-bridge.mjs pair` to print the code (the daemon was started by your agent on first tool use). In the IWE popup, paste the code → **Connect** → **Allow this agent session**. The dot turns green ("Agent connected").
6. **Drive it from the agent**, e.g. _"Get the XR session status, enter XR, look at {x:0,y:1,z:-1}, pinch the right controller, then screenshot what you see."_ The agent calls `xr_get_session_status → xr_accept_session → xr_look_at → xr_select → browser_screenshot`; you should see the emulated camera/controllers move and get a downscaled JPEG back.

### Pass criteria

- Tools list shows the 20 `xr_*` / `browser_screenshot` tools.
- `xr_*` mutations visibly move the emulated headset/controllers in DevUI.
- `browser_screenshot` returns an image (downscaled; under the model image cap).
- Disconnect (popup) or closing the tab cleanly drops the session; reconnect re-pairs.

### Phase-0 spikes still to validate live (plan §8)

Offscreen-WS longevity across SW death/sleep; `capture_canvas` on a real WebGL canvas (`preserveDrawingBuffer`/in-frame readback); image token-cap calibration; Chrome Local Network Access exemption for `ws://127.0.0.1`; CWS review of the `offscreen` reason + permissions.
