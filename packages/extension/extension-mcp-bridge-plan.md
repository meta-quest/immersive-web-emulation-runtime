# Extension MCP bridge: agent-driven WebXR emulation

**Author:** Plan synthesis for Felix Zhang
**Date:** 2026-06-15
**Status:** Implementation-ready plan. Architecture is settled (Option E hybrid). Red-team fixes are incorporated and override the source drafts wherever they conflict.

> Companion to `immersive-web-sdk/iwsdk-mcp-edit-suggestions.md`. This plan covers the **dev-server-free** path: drive _any_ WebXR page via the IWE browser extension + a local MCP daemon, complementing IWSDK's project-scoped `iwsdk dev` MCP bridge.

---

## 1. Goal & outcome

A WebXR developer installs the **Immersive Web Emulator** (IWE) extension once from the Chrome Web Store. They open _any_ WebXR page in Chrome — their own dev server, a deployed `iwsdk.dev` demo, a third-party WebXR site — and click the IWE toolbar action to enable emulation on that origin (today's behavior). IWER injects into the MAIN world, the page now sees a synthetic `navigator.xr` (Quest 3 profile + SEM living-room scene), exactly as it does today.

The new capability: a small **Connect** affordance (extension popup / page-action) lets the developer pair that tab with a coding agent. Mechanically:

1. Developer runs one of (per their agent): `npx @iwer/extension-bridge install` (writes the stdio MCP config for Claude Code / Codex / Cursor / Copilot / Windsurf / Cline / Roo) or `claude mcp add --scope user iwer -- npx -y @iwer/extension-bridge serve`.
2. The agent spawns `@iwer/extension-bridge` over **stdio** (the only transport uniform across all those clients). That process also opens a **localhost WS server** on `127.0.0.1` and prints a one-time **pairing code**.
3. Developer clicks **Connect** in the IWE popup and pastes the code (or scans a deep-link). The extension's offscreen document dials into the daemon's WS, presents the token, and the relay binds that tab.
4. The developer says to the agent: _"enter XR, walk the camera to the table, pinch the blue cube, screenshot what you see."_ The agent calls `xr_accept_session`, `xr_look_at`, `xr_select`, `browser_screenshot`; each call travels agent → daemon → extension → MAIN-world IWER → `device.remote.dispatch(...)`, drives the synthetic device, and returns a result (or a downscaled JPEG for the screenshot).

End state for the developer: **no headset, no dev server requirement, no per-project MCP wiring** — emulate WebXR on any page and let an agent drive it. This is the "build and validate WebXR without a dev kit, with an agent in the loop" story that complements IWSDK's project-scoped `iwsdk dev` MCP path (which requires an IWSDK project + running Vite server).

**Non-goals (v1):** driving a _real_ headset; multi-agent fan-in to one tab; WebMCP as the primary path (forward-compat only, Phase 3).

---

## 2. Architecture (Option E hybrid)

The defining constraint: an **MV3 service worker can only be a WebSocket client, never a server**, and the extension is **filesystem-blind** (cannot read `.iwsdk/runtime/session.json` to discover a port, unlike IWSDK's CLI). Therefore the Node daemon hosts the server and the extension dials in; rendezvous is solved out-of-band via a pairing code (Section 5), not via the filesystem.

```
                          stdio (JSON-RPC, MCP)                  ws://127.0.0.1:PORT/__iwer_mcp
                          no network surface                     127.0.0.1 + token + Origin check
  ┌─────────────┐      ┌──────────────────────────────────┐    ┌──────────────────────────────────────┐
  │ Coding Agent │◄────►│         @iwer/extension-bridge  (daemon)        │◄──►│        Chrome Extension (IWE)          │
  │ Claude Code/ │ MCP  │  ┌────────────┐  ┌──────────────┐ │ WS │  ┌────────────────┐  ┌──────────────┐ │
  │ Codex/Cursor/│ tools│  │ McpServer  │  │ WS server +  │ │    │  │ Offscreen Doc  │  │ Service Worker│ │
  │ Copilot/...  │      │  │ (stdio)    │◄─┤ relay (FRW)  │ │    │  │ durable WS     │◄─┤ thin router   │ │
  └─────────────┘      │  └────────────┘  │ + token gate │ │    │  │ client +       │  │ (port msgs)   │ │
                       │   tool→method     │ + port pick  │ │    │  │ ~20s heartbeat │  └──────┬───────┘ │
                       │   capture remap   └──────────────┘ │    │  │ 1–30s backoff  │         │         │
                       └──────────────────────────────────┘    │  └────────────────┘  chrome.runtime    │
                                                                │                       message ports     │
                                                                │              ┌──────────────────────┐   │
                                                                │              │ Content script        │   │
                                                                │              │ (ISOLATED world)      │   │
                                                                │              │ CustomEvent/postMessage│  │
                                                                │              └──────────┬───────────┘   │
                                                                │       window.postMessage │ (same frame)  │
                                                                │              ┌──────────▼───────────┐   │
                                                                │              │ MAIN-world bridge shim│   │
                                                                │              │ {postMessage,         │   │
                                                                │              │  addEventListener}    │   │
                                                                │              └──────────┬───────────┘   │
                                                                │   device.remote          │              │
                                                                │   .connectTransport(port)▼              │
                                                                │              ┌──────────────────────┐   │
                                                                │              │ IWER RemoteControl    │   │
                                                                │              │ Interface.dispatch()  │   │
                                                                │              │ → synthetic XRDevice  │   │
                                                                │              └──────────────────────┘   │
                                                                └──────────────────────────────────────────┘
```

### Full message chain (one tool call) and why each hop exists

`xr_look_at` from the agent:

1. **Agent → daemon (stdio JSON-RPC, MCP `tools/call`).** _Why:_ stdio is the single transport every target agent supports without per-client networking config. No network surface here (the hardened hop).
2. **Daemon: McpServer `CallToolRequest` handler.** Maps `xr_look_at` → wsMethod `look_at` via the contract table; remaps screenshot results; injects tab-change warnings. _Why:_ the agent speaks MCP tool names + JSON Schema; IWER speaks `device.remote` method names + raw shapes. Translation lives in one place.
3. **Daemon relay → extension (WS frame `{id, method:'look_at', params}`).** First-response-wins relay (ported from `mcp-relay.ts`). _Why:_ the daemon owns the socket and gates on token/Origin; the relay deduplicates when >1 tab is connected.
4. **Offscreen doc WS `onmessage` → service worker (`chrome.runtime.sendMessage` / port).** _Why:_ the offscreen doc holds the durable socket (a SW dies in ~30s); the SW is a thin router with the `chrome.tabs`/`chrome.scripting` privileges to reach the right tab.
5. **SW → content script (ISOLATED world) via `chrome.tabs.sendMessage`.** _Why:_ only an extension context can address a specific tab; the content script is the extension's foothold in the page.
6. **Content script → MAIN-world shim (`window.postMessage` + `CustomEvent`).** _Why:_ IWER's `device.remote` lives in the MAIN world (page JS context). ISOLATED↔MAIN cannot share objects; `postMessage` is the only bridge. This is the one hop the page can observe (Section 6 addresses it).
7. **MAIN-world shim → `device.remote.dispatch('look_at', params)`** via the `connectTransport({postMessage, addEventListener})` port (`RemoteControlInterface.ts:1098`). Dispatch routes through `IMMEDIATE_METHODS` (sync) or `SESSION_REQUIRED_METHODS` (frame-queued) at `:1547`/`:1577`, applies the transform, and activates `controlMode = 'programmatic'`.
8. **Reply travels the same chain in reverse**, each hop tagging `id`; the daemon resolves the pending request and returns the MCP result.

---

## 3. Components

### 3.1 `@iwer/extension-bridge` — the daemon (NEW package)

A standalone Node CLI + library. Responsibilities:

- **stdio MCP server.** Prefer the high-level `McpServer` + `registerTool` API (SDK ≥1.24.0; target latest ~1.29.x). `inputSchema` is a **Zod raw shape**, not JSON Schema — this is the one place we diverge from IWSDK's `mcp-stdio.ts`, which uses the low-level `Server` + hand-rolled `JsonSchema`. (Red-team fix: the SDK ≥1.24.0 DNS-rebinding/Origin-validation fix is load-bearing; do not pin below it.)
- **Localhost WS server** bound to `127.0.0.1` only, path `/__iwer_mcp` (reuse the IWSDK URL convention). Validates `Origin`/`Host` headers (SDK helper + manual check), enforces the per-session token on the first frame, picks the port (Section 5).
- **Relay**, ported verbatim from `mcp-relay.ts` (first-response-wins, `cleanStale`). The daemon is itself a relay _client_ on behalf of the agent: it broadcasts requests to connected extension sockets and forwards the first matching response.
- **Tool→method translation + result remapping**, ported/adapted from `mcp-stdio.ts`: `RUNTIME_TOOL_TO_METHOD`, the `browser_screenshot`→image-content remap, the tab-change/reload warning injector (`createTabTracker`).
- **Pairing UX:** mints the token, prints the pairing code, optionally writes a discovery file for the no-extension case (not used by the extension; see Section 5 residual risk).
- **Config installer:** `@iwer/extension-bridge install [--client claude|cursor|copilot|codex|...] [--scope user|project]`, reusing `mcp-adapters.ts` + `MCP_CONFIG_TARGETS`. For the no-project case, default to **user scope** (`claude mcp add --scope user`, `~/.codex/config.toml`).

Entry points: `@iwer/extension-bridge serve` (spawned by the agent over stdio; also opens WS), `@iwer/extension-bridge install`, `@iwer/extension-bridge pair` (re-print/rotate code).

### 3.2 Extension changes (`immersive-web-emulator`)

Current state: a 23-line `injectRuntime` (`src/index.ts`) bundled as UMD `iwe.min.js` and injected into the **MAIN world** per-domain via `chrome.scripting.registerContentScripts` in the SW (`src/service-worker.ts:89`). There is **no content script in the ISOLATED world, no offscreen document, no WS client, and host_permissions are `http(s)://*/*`** (manifest). Changes:

- **MAIN-world bridge shim** (added to `iwe.min.js`): after `xrDevice.installRuntime()`, build a port `{postMessage, addEventListener}` over `window.postMessage`/`CustomEvent` with a namespaced channel tag, and call `xrDevice.remote.connectTransport(port)`. Note: `connectTransport` expects **`addEventListener('message', …)`**, not `onmessage` — the shim must expose `addEventListener`.
- **ISOLATED content script** (new bundle, `world:'MAIN'` is NOT set): relays between `window.postMessage` (page side) and `chrome.runtime` (extension side). Registered alongside the MAIN script for paired origins only.
- **Offscreen document** (new; needs `offscreen` permission + a documented reason such as `"Maintain a persistent local connection to the developer's coding-agent bridge"`). Holds the durable WS client to `ws://127.0.0.1:PORT/__iwer_mcp`: ~20s heartbeat (Chrome 116+ resets the 30s idle timer on WS traffic), 1–30s exponential backoff reconnect, presents the token on (re)connect. **Set `minimum_chrome_version` to `"116"`** (currently `"96"`). _Justification (§11):_ the SW-resident-WS cohort (Browser MCP, browsermcp-enhanced) suffers documented disconnects ("reconnection may require Chrome restart"); the `@playwright-repl/extension-bridge` ecosystem variant uses a persistent offscreen document precisely to avoid this. (Do **not** justify the offscreen doc by comparison to Playwright MCP's 20s connect-tab ping — that ping is scoped to the _approval window_, not the working session.)
- **Service worker** becomes a thin router: it owns `chrome.tabs`/`chrome.scripting`, brokers the pairing handshake, spawns/wakes the offscreen doc, and forwards `{id,method,params}` ↔ `{id,result|error}` between offscreen and the correct tab's content script. Keep the existing per-domain registration/toolbar toggle (`service-worker.ts:15-46`).
- **Popup / Connect UI** (new minimal HTML page): pair (enter code), show connection state, show which tab is bound, disconnect. This is where per-tab consent is minted (Section 6).
- **Permissions tightening** (red-team fix): add `offscreen`; add `host_permissions` for `http://127.0.0.1/*` and `ws://127.0.0.1/*`; move toward per-origin emulation grants instead of blanket `http(s)://*/*` where CWS review allows (residual risk: `registerContentScripts` with arbitrary user-entered domains still needs broad host access — gate behind `optional_host_permissions` requested at Connect time).

### 3.3 IWER core changes (`packages/iwer`)

IWER already exposes the full control surface — minimal additive changes:

- **No change** to `connectTransport`/`dispatch`/`describe`/`listMethods` semantics. They are the contract.
- **`describe()` enrichment** (additive): include per-method `description`, `inputShape`, and `readOnlyHint` so the daemon can generate the MCP catalog from the manifest rather than a hand-maintained table (today `listMethods` returns only `{method, immediate, requiresSession}` at `:1067`). This is the seam that lets the catalog be _dynamic_ (Section 4 decision).
- **`capture_canvas` REMOVED** from `RemoteControlInterface` (+ its types/exports). Screenshotting is not a device capability — it returned black on any page without `preserveDrawingBuffer`. Replaced by the browser-host `browser_screenshot` (extension `captureVisibleTab`, §4).
- **Optional WebMCP registration** (Phase 3): from the same `describe()` manifest, register `document.modelContext.registerTool(...)` when the API exists — additive, behind feature detection.

### 3.4 WebMCP surface (forward-compat only)

`document.modelContext.registerTool` (canonical; `navigator.modelContext` deprecated) is a W3C Web ML CG draft, Chrome flag-gated off by default, and **no mainstream agent consumes page-registered tools yet**. So WebMCP is _not_ a transport in v1 — it's an additive registration generated from the same manifest, so that when agents do consume it, IWER pages are already tool-exposing with zero new code. The localhost relay is the real path.

---

## 4. MCP tool catalog

**Static-vs-dynamic decision (resolved):** **Hybrid.** Ship a _static, hand-curated_ catalog (`@iwer/extension-bridge/contract.ts`, the same shape as `runtime-contract.ts`) as the source of truth for tool names, descriptions, Zod input shapes, and `readOnlyHint` — because rich descriptions and `readOnlyHint` are not derivable from `listMethods()`, and a stable catalog is what CWS review and agent UX need. At connect time, the daemon calls `device.remote.describe()` and **intersects**: it only advertises tools whose method the connected IWER build actually exposes, and logs any catalog/runtime drift. This gives curated quality + forward/backward compatibility across IWER versions (red-team fix: a purely dynamic catalog produces unstable, undescribed tools; a purely static one silently breaks when IWER drops/renames a method).

Tools below map 1:1 onto `RemoteControlInterface` methods (`IMMEDIATE_METHODS` `:1547`, `SESSION_REQUIRED_METHODS` `:1577`). `readOnlyHint` is `true` only for pure queries.

| mcpName                 | device.remote method                    | description                                                                                           | input shape (Zod)                              | readOnlyHint |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------ |
| `xr_get_session_status` | `get_session_status`                    | XR session + device status (mode, features, visibility)                                               | `{}`                                           | ✅           |
| `xr_accept_session`     | `accept_session`                        | Accept offered XR session (= click "Enter XR")                                                        | `{}`                                           | ❌           |
| `xr_end_session`        | `end_session`                           | End active XR session                                                                                 | `{}`                                           | ❌           |
| `xr_get_transform`      | `get_transform`                         | Position/orientation of a tracked device                                                              | `{device}`                                     | ✅           |
| `xr_set_transform`      | `set_transform`                         | Set position/orientation (m; quat or euler°)                                                          | `{device, position?, orientation?}`            | ❌           |
| `xr_look_at`            | `look_at`                               | Orient device toward a world point                                                                    | `{device, target:{x,y,z}, moveToDistance?}`    | ❌           |
| `xr_animate_to`         | `animate_to`                            | Smoothly animate device pose over time                                                                | `{device, position?, orientation?, duration?}` | ❌           |
| `xr_set_input_mode`     | `set_input_mode`                        | Switch controller ⇄ hand tracking                                                                     | `{mode:'controller'\|'hand'}`                  | ❌           |
| `xr_set_connected`      | `set_connected`                         | Connect/disconnect an input device                                                                    | `{device, connected:boolean}`                  | ❌           |
| `xr_get_select_value`   | `get_select_value`                      | Current select/trigger/pinch value                                                                    | `{device}`                                     | ✅           |
| `xr_set_select_value`   | `set_select_value`                      | Set select value (grab-move-release)                                                                  | `{device, value:0..1}`                         | ❌           |
| `xr_select`             | `select`                                | Full press+release (selectstart/select/selectend)                                                     | `{device, duration?}`                          | ❌           |
| `xr_get_gamepad_state`  | `get_gamepad_state`                     | All buttons/axes (0=trig,1=squeeze,2=stick,3=A/X,4=B/Y,5=rest)                                        | `{device:controller-*}`                        | ✅           |
| `xr_set_gamepad_state`  | `set_gamepad_state`                     | Set buttons/axes by index                                                                             | `{device, buttons?[], axes?[]}`                | ❌           |
| `xr_get_device_state`   | `get_device_state`                      | Full device snapshot                                                                                  | `{}`                                           | ✅           |
| `xr_set_device_state`   | `set_device_state`                      | Apply partial state; empty resets to defaults                                                         | `{state?}`                                     | ❌           |
| `xr_set_hand_pose`      | `set_hand_pose`                         | Set a named hand pose                                                                                 | `{device:hand-*, pose, ...}`                   | ❌           |
| `xr_get_world_state`    | `get_world_state`                       | SEM scene summary (plane/mesh counts + labels)                                                        | `{}`                                           | ✅           |
| `xr_get_objects`        | `get_objects`                           | SEM tracked planes/meshes w/ semantic labels                                                          | `{}`                                           | ✅           |
| `browser_screenshot`    | `screenshot` _(browser-host, not IWER)_ | Capture the **visible tab** (composited) via the extension — works on any page; returns image content | `{maxWidth?, format?, quality?}`               | ✅           |

Notes vs IWSDK's catalog: the IWSDK runtime catalog includes `browser_get_console_logs`, `browser_reload_page`, `scene_*`, and `ecs_*` — those require the Vite dev plugin / `FRAMEWORK_MCP_RUNTIME` and are **out of scope** for the extension daemon (the extension drives raw IWER on arbitrary pages, with no IWSDK framework runtime present). `xr_set_hand_pose`, `xr_get_world_state`, `xr_get_objects` are present in IWER's method sets but absent from IWSDK's catalog — include them here.

### `browser_screenshot` is a browser-host tool (revised — screenshotting is the host's job, not IWER's)

**Decision (validated live):** screenshotting is a _browser_ capability, not an XR-device capability — exactly as IWSDK serves it from its managed Playwright browser, never `device.remote`. So:

- **`capture_canvas` was removed from IWER entirely** (it was `device.remote`-served and returned a **black frame** on any page without `preserveDrawingBuffer` — i.e. essentially every third-party WebXR page). IWER controls the device; the host captures pixels.
- **`browser_screenshot` (wsMethod `screenshot`) is serviced by the extension's service worker** via `chrome.tabs.captureVisibleTab()` (the composited tab pixels — what the developer sees), then downscaled/re-encoded with `OffscreenCanvas`. It **bypasses the page entirely** (mirrors IWSDK intercepting `screenshot` at its WS server). Works on any page, immune to `preserveDrawingBuffer`/cross-origin-taint.
- The daemon still **remaps** to MCP image content `{type:'image', data:<raw base64>, mimeType}` and enforces the **size ceiling** by re-requesting at smaller `maxWidth`/`quality` (the extension re-encodes each request via `OffscreenCanvas`); defaults `format:'jpeg'`, `quality:0.7`, `maxWidth:768`.
- **Permission cost:** `captureVisibleTab` needs `<all_urls>` host permission (or an `activeTab` gesture, which the Connect-popup click grants). Added `<all_urls>` + `activeTab`. It captures the **focused** tab only — the bound tab must be active.

---

## 5. Wire protocol & the token/rendezvous solution

### Connection URL & frames

- **URL:** `ws://127.0.0.1:<PORT>/__iwer_mcp` (reuse IWSDK's path constant). `ws://` only (no `wss` — localhost extension client, no cert story; IWSDK's `wss→ws` fallback in `runtime-transport.ts:97` is for its own browser; the extension dials `ws` directly).
- **Request frame** (daemon→ext): `{id, method, params}` (matches `ws-client.ts` `MCPRequest`).
- **Response frame** (ext→daemon): `{id, result?|error?, _tabId, _tabGeneration}` (matches `ws-client.ts:320` `send()` enrichment + `runtime-transport.ts:21` `RuntimeCommandResponse`).
- **Hello frame** (ext→daemon, on open): `{type:'iwer_browser_hello', tabId, tabGeneration, token, protocolVersion}` (extends `ws-client.ts:198`).
- **Heartbeat:** ext→daemon `{type:'ping'}` every ~20s; daemon `{type:'pong'}`. WS traffic resets the SW/offscreen idle timer (Chrome ≥116).

### The token + port-discovery problem for a filesystem-blind extension (the hard one)

IWSDK's CLI reads `.iwsdk/runtime/session.json` to learn the port and bind. **The extension cannot read the filesystem.** Chosen concrete design — **fixed default port + a token-only out-of-band pairing code + a one-time human Allow gesture** (revised in §11 to match incumbent practice — the port is not a secret, and every credible incumbent has an explicit human authorization step):

1. On `@iwer/extension-bridge serve`, the daemon mints a 256-bit random **session token** and binds its WS server to **`127.0.0.1`** on a **fixed default port** (e.g. `8723`). If the default is busy it binds an alternate and surfaces that port in the pairing code as an optional override — but the common case needs no port in the code.
2. The daemon prints (to stderr, since stdout is the MCP stdio channel) a short **token-only pairing code**, e.g. `IWER-7K3F-92AB-…`, plus an optional clickable deep-link `https://emulator.iwsdk.dev/pair#code=...` that hands off to the extension's pairing page (or an `iwe://pair?...` custom scheme if registered). The port is _not_ encoded except on collision.
3. Developer pastes the code (or clicks the link) into the IWE **Connect** popup, then confirms a one-time **"Allow this agent session"** prompt that names the bound tab. The extension dials `ws://127.0.0.1:<port>/__iwer_mcp` (default port unless overridden) and sends `token` in the hello frame.
4. Daemon validates: `Origin`/`Host` header check (extension origin / loopback Host only — anti-DNS-rebind), then constant-time token compare on the first frame. On mismatch: close with code 1008. Token is **never page-readable** — it lives only in the extension's `chrome.storage.session` and the daemon process; it never enters the MAIN world.

**Why a fixed port (not scan):** the localhost-WS cohort (Browser MCP `9009`, MCP-B `9333`, ModCDP `29292`) all use a single fixed port; only the now-archived AgentDesk does a port-range scan + identity probe. A fixed default removes a discovery problem, and the _token_ (not the port) is the security-bearing secret that must travel out-of-band. **Why a human Allow gesture:** Playwright MCP (Allow dialog), Browser MCP (manual Connect click), and Chrome's `--auto-connect` (permission dialog) all gate connection on an explicit human action; the token alone is weaker HITL than the field. The Allow gesture is the deliberate human-in-the-loop authorization step (§11 change #1).

**Why not auto-discovery:** scanning localhost ports from an extension is exactly the DNS-rebinding/cross-origin attack surface we're defending against, and would itself be flagged in CWS review.

**Residual risk (flag for Felix):** the paste-the-code UX adds friction vs IWSDK's zero-touch filesystem discovery. Mitigations: (a) the deep-link path makes it one click if the daemon can open a URL; (b) once paired, persist `{port,token}` in `chrome.storage.local` so reconnect is automatic until the token rotates or the daemon restarts (new token ⇒ re-pair). A daemon restart invalidating the token is the main re-pair trigger; consider a stable per-user token cached under `~/.iwer/` so restarts don't force re-pairing (trades a small persistent-secret surface for UX — Felix's call).

### Tab identity & version handshake

- **Tab identity:** reuse `ws-client.ts:71-99` verbatim — `tabId` from `sessionStorage` (stable across reload/HMR, new on tab close), `tabGeneration` incremented per load. The MAIN-world shim generates these; they ride in the hello + every response. The daemon's `createTabTracker` (`mcp-stdio.ts:55`) emits the "active tab changed / reloaded — cached state invalid" warning to the agent.
- **Version handshake:** hello carries `protocolVersion` (wire protocol) and the daemon advertises its tool catalog version. On mismatch the daemon advertises only the intersection (Section 4) and surfaces a one-line warning in `xr_get_session_status`. IWER's own `describe()` is the runtime capability source.
- **Multi-tab:** the relay broadcasts; first-response-wins (`mcp-relay.ts:98`). v1 binds **one tab per pairing** (the tab the developer clicked Connect on) to avoid cross-tab ambiguity; Phase 2 generalizes to the IWSDK multi-tab model.

---

## 6. Security & consent model

`localhost` is **not** a trust boundary: any visited web page can attempt to reach an unauthenticated local WS via DNS-rebinding or cross-origin WS. Layered mitigations (all required):

1. **Bind `127.0.0.1` only** (never `0.0.0.0`).
2. **Origin/Host validation** on WS upgrade (SDK ≥1.24.0 fix). Reject any `Origin` that isn't the extension's `chrome-extension://<id>` (or `null`). A page's `Origin` (e.g. `https://evil.com`) is rejected.
3. **Per-session out-of-band token** (Section 5), constant-time compared, never page-readable, never in the MAIN world. This is what defeats DNS-rebinding: even if a malicious page resolves a hostname to `127.0.0.1` and opens a WS, it has no token and the wrong Origin.
4. **stdio agent hop has no network surface** — the only TCP listener is the localhost WS, fully gated above.

**Per-tab consent:** emulation is already per-origin opt-in (toolbar toggle, `service-worker.ts:15`). Agent control is a _second_ explicit opt-in: the developer clicks **Connect** in the popup, supplies the pairing code, **and confirms a one-time "Allow this agent session" prompt** (§11 change #1 — matches the human-Allow gesture every credible incumbent ships: Playwright's Allow dialog, Browser MCP's Connect click, Chrome's auto-connect permission). The bound tab shows a persistent "Agent connected" indicator. No silent attachment, no auto-connect to a tab the developer didn't authorize.

**Harden the page↔extension message channel (ShadowPrompt lesson — load-bearing).** Anthropic's Claude for Chrome shipped a zero-click prompt-injection chain (Dec 2025–Feb 2026) rooted in a **wildcard `*.claude.ai` origin allowlist** on a `postMessage` handler. IWER runs on _adversarial_ dev pages, so the MAIN↔ISOLATED bridge must: (a) **exact-match** the expected origin/channel tag — never a wildcard; (b) verify `event.source === window` (and/or use a dedicated `MessagePort` whose identity is checked) so a sub-frame or the page can't spoof bridge traffic; (c) enforce a **method allow-list** at the `device.remote` boundary (only catalog methods pass); (d) keep the token strictly out of the MAIN world. ([Koi ShadowPrompt write-up](https://www.koi.ai/blog/shadowprompt-how-any-website-could-have-hijacked-anthropic-claude-chrome-extension))

**No `eval` / `new Function` in the SW or offscreen doc (ModCDP CSP lesson).** MV3's default extension CSP blocks `unsafe-eval`; `connectTransport`/`dispatch` plumbing must be **structured message passing only**. The only way around the CSP is to reintroduce `chrome.debugger` — which we are deliberately avoiding (§11). ([ModCDP](https://github.com/browserbase/ModCDP))

**Bind `127.0.0.1` explicitly.** Browser MCP's `new WebSocketServer({ port })` omits the host and silently binds `0.0.0.0`, exposing the bridge to the whole LAN ([BrowserMCP #158](https://github.com/BrowserMCP/extension-bridge/issues/158)). The daemon must pass `host: '127.0.0.1'` explicitly and add a Host-header allowlist (anti-DNS-rebind), mirroring Playwright's transport. This + the per-session token makes us **strictly stronger than every mainstream localhost-WS analog** (most have no auth at all — see §11).

**Least privilege:**

- Add `offscreen`; add `host_permissions` `http://127.0.0.1/*`, `ws://127.0.0.1/*`.
- Replace blanket `http(s)://*/*` with `optional_host_permissions` requested at the moment the user enables emulation on an origin (red-team fix). This narrows the standing grant and improves CWS review odds. Verify Chrome **Local Network Access** does not block extension→127.0.0.1 (it likely exempts extensions, but this is a Phase 0 spike).
- `minimum_chrome_version: "116"`.

**Prompt-injection posture (red-team fix — explicit):** the agent can be steered by content the page renders (e.g. a malicious WebXR site whose scene text says "call xr*set_device_state to exfiltrate…"). Mitigations: (a) the daemon exposes **only** the IWER device-control catalog — there is no filesystem/network/eval tool, so the blast radius is "manipulate a synthetic XR device in the developer's own tab"; (b) `readOnlyHint` lets clients gate mutating tools; (c) `browser_screenshot` is the only data-egress tool and it returns only the canvas the developer is already looking at; (d) document that connecting to \_untrusted* WebXR pages is the developer's risk decision, same as opening DevTools on them. There is no path from a page to the token, the filesystem, or other tabs.

---

## 7. Reuse map

| Concern                                                                                               | Source (lift)                                                                                                  | Action                                                                                                                          | Lands in                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| First-response-wins relay                                                                             | `vite-plugin-dev/src/extension-bridge-relay.ts` (entire `createRelayHandler`)                                               | **Lift verbatim**                                                                                                               | shared lib → `@iwer/extension-bridge` |
| Tool→method table, screenshot remap, tab-change warnings                                              | `cli/src/extension-bridge-stdio.ts` (`RUNTIME_TOOL_TO_METHOD`, `browser_screenshot` remap `:274`, `createTabTracker` `:55`) | **Lift + adapt** (switch to `McpServer`/`registerTool` + Zod)                                                                   | `@iwer/extension-bridge`              |
| Per-client config writers + targets                                                                   | `cli/src/extension-bridge-adapters.ts`, `cli/src/runtime-contract.ts` (`MCP_CONFIG_TARGETS`, merge/unmerge JSON+TOML)       | **Lift** (add user-scope default; drop project-only assumptions)                                                                | shared lib               |
| In-page WS client: tabId/generation, reconnect/backoff, hello, dispatch priority, response enrichment | `vite-plugin-dev/src/extension-bridge/ws-client.ts`                                                                         | **Lift the patterns**; re-home: tabId/shim → MAIN-world bundle; durable WS/backoff/heartbeat → **offscreen doc** (not the page) | extension                |
| WS transport framing, request-id correlation                                                          | `cli/src/runtime-transport.ts`                                                                                 | **Reference** (daemon's relay side differs; reuse error/cause taxonomy)                                                         | `@iwer/extension-bridge`              |
| Control surface (the contract)                                                                        | `iwer` `RemoteControlInterface` `connectTransport`/`dispatch`/`describe`                                       | **Consume, do not fork**                                                                                                        | —                        |

**Anti-divergence decision:** factor the relay, the catalog/contract, the tool→method map, and the config writers into a **shared package** (working name `@iwer/extension-bridge-core`) that **both** `@iwer/extension-bridge` (extension daemon) and IWSDK's `@iwsdk/cli` depend on. Today these live inside `@iwsdk/cli` and `vite-plugin-dev`; without extraction the two stacks will drift (e.g. IWSDK adds a tab-warning field and the extension daemon silently lacks it). Extracting now is the cheaper time (red-team flagged divergence as the main long-term maintenance risk). The one intentional difference — low-level `Server` (IWSDK) vs high-level `McpServer`+Zod (`@iwer/extension-bridge`) — should be unified by migrating IWSDK to `McpServer` as a follow-up so both share one server builder. (Decision for Felix in §10.)

---

## 7.5 Acceptance criteria (Phase 1 MVP — definition of done)

Derived from §8 (MVP tasks + exit), §9 (tests), and §11.5 (applied changes). Each is independently verifiable.

> **Status: IMPLEMENTED ✅** — `packages/extension-bridge` (36 tests) + `packages/iwer` connectTransport test (4 tests) pass; the extension builds all 5 MV3 bundles. Verify with `pnpm --filter @iwer/extension-bridge test`, `pnpm --filter iwer exec jest tests/remote/connectTransport.test.ts`, and `cd immersive-web-emulator && npm run build`. Live-Chrome steps: `packages/extension/EXTENSION-MCP-BRIDGE-E2E.md`.

**A. `@iwer/extension-bridge` daemon (new package `packages/extension-bridge`, name `@iwer/extension-bridge`):**

- [x] **A1** Static tool catalog (`src/contract.ts`) for all 20 §4 tools: `mcpName`, `wsMethod`, description, Zod input shape, `readOnlyHint`; plus `MCP_TO_METHOD`.
- [x] **A2** `iwer-bridge serve` runs an stdio MCP server (`McpServer`/`registerTool`, `src/extension-bridge-server.ts`+`serve.ts`) that lists the catalog and forwards `tools/call` → relay → browser and back.
- [x] **A3** Localhost WS server bound to **`127.0.0.1`** at `/__iwer_mcp` (`src/ws-server.ts`), per-session **token gate** + **Origin/Host validation**; bad token/Origin/Host rejected (close 1008). _(live test in `tests/ws-gate.test.ts`)_
- [x] **A4** First-response-wins relay (`src/relay.ts` `createRelayHandler`, ported) with `cleanStale`, used by the hub (`src/hub.ts`).
- [x] **A5** `browser_screenshot` is a **browser-host tool** (wsMethod `screenshot`, `browserTool:true`) serviced by the extension SW via `captureVisibleTab` + `OffscreenCanvas`; daemon remaps to MCP image content + enforces the size ceiling by re-requesting smaller (`src/screenshot.ts`). `capture_canvas` removed from IWER. _(Validated live on `immersive-web.github.io/webxr-samples` — returns the real composited frame.)_
- [x] **A6** Token minting + fixed default port (`8723`) with ephemeral fallback; **token-only pairing code to stderr** (`src/token.ts`/`serve.ts`); session file at `~/.iwer/session.json` for `iwer-bridge pair`.
- [x] **A7** `createTabTracker` tab-change/reload warnings (`src/tab-tracker.ts`).
- [x] **A8** `iwer-bridge install [--client …] [--scope]` for claude/cursor/copilot/codex (+windsurf); idempotent; user-scope default (`src/install.ts`).
- [x] **A9** Unit tests pass (relay, tool mapping+Zod, screenshot ceiling, token+Origin gate, config-writer idempotency).

**B. Extension (`immersive-web-emulator`):**

- [x] **B1** MAIN-world bridge shim `installAgentBridge` (`src/agent/bridge-page.ts`) calls `device.remote.connectTransport({postMessage, addEventListener})` with exact channel tag + `event.source===window` + method allow-list (`src/agent/protocol.ts`).
- [x] **B2** ISOLATED content script relay (`src/agent/content-bridge.ts`).
- [x] **B3** Offscreen doc durable WS client: hello+token, 20s heartbeat, 1–30s backoff; no `eval` (`src/agent/offscreen.ts` + `offscreen.html`).
- [x] **B4** Service worker router + pairing broker + offscreen spawn (`src/service-worker.ts`).
- [x] **B5** Connect popup: paste code + one-time "Allow this agent session" + state + disconnect (`src/agent/popup.html`/`popup.ts`).
- [x] **B6** `manifest.json`: `offscreen`, `127.0.0.1` host perms, `minimum_chrome_version:"116"`, action popup.
- [x] **B7** Extension TypeScript compiles and rollup builds all 5 bundles + HTML pages (`npm run build`).

**C. IWER (`packages/iwer`):** [x] no API change; `tests/remote/connectTransport.test.ts` proves a `{postMessage, addEventListener}` port drives `device.remote.dispatch`.

**D. Integration:** [x] `packages/extension-bridge/tests/integration.test.ts` exercises the full chain — real MCP client → real daemon (stdio) → WS relay → browser stand-in → back — running `xr_get_session_status → xr_accept_session → xr_look_at → xr_select → browser_screenshot`, asserting forwarded params + image content + the no-browser error. The live-Chrome+agent loop is documented in `EXTENSION-MCP-BRIDGE-E2E.md`.

---

## 8. Phased roadmap

### Phase 0 — Spikes (validate the load-bearing unknowns first)

- [ ] **Offscreen WS longevity:** confirm an offscreen-doc WS with ~20s heartbeat survives indefinitely across SW death on Chrome ≥116; measure reconnect after laptop sleep.
- [ ] **capture_canvas on a live WebGL/WebXR canvas:** verify `toDataURL` on `device.appCanvas` returns pixels (not black) — determine whether same-frame capture is required and prototype it (`RemoteControlInterface.ts:1461`).
- [ ] **Token-cap math:** confirm `jpeg q0.7 / 768px` stays under Claude Code's ~25k image token cap on a representative scene; calibrate the daemon's hard re-encode ceiling.
- [ ] **Local Network Access / extension exemption:** verify extension→`ws://127.0.0.1` is not blocked by Chrome LNA prompts.
- [ ] **Pairing deep-link:** test `https://…/pair#code` → extension pairing page handoff and the `chrome-extension://` Origin on the WS upgrade.
- [ ] **stdio + WS in one process:** confirm `McpServer` over stdio and a `ws` server coexist without stdout contamination (all daemon logging to stderr).

### Phase 1 — MVP

**`@iwer/extension-bridge` (new):**

- [ ] Scaffold package; `McpServer` over stdio with the static catalog (§4) + Zod shapes.
- [ ] Port `createRelayHandler` from `mcp-relay.ts`; stand up `127.0.0.1` WS server with token gate + Origin check.
- [ ] Port tool→method map + screenshot remap + compression policy + `createTabTracker`.
- [ ] `@iwer/extension-bridge install` (claude/cursor/copilot/codex) reusing `mcp-adapters.ts`, **user scope default**.
- [ ] `serve` prints pairing code (port+token) to stderr.

**`immersive-web-emulator`:**

- [ ] MAIN-world bridge shim + `device.remote.connectTransport({postMessage, addEventListener})` in `iwe.min.js` (`src/index.ts`).
- [ ] ISOLATED content script relay (postMessage ⇄ chrome.runtime).
- [ ] SW router: forward `{id,method,params}` ↔ tab; spawn offscreen.
- [ ] Offscreen doc with durable WS client, hello+token, heartbeat, backoff (patterns from `ws-client.ts`).
- [ ] Connect popup: paste code, show state, disconnect.
- [ ] manifest: add `offscreen`, `127.0.0.1` host perms, `minimum_chrome_version:"116"`.

**`iwer`:**

- [ ] Confirm `connectTransport` shim contract; no API change needed for MVP.

_MVP exit:_ Claude Code drives `xr_accept_session`→`xr_look_at`→`xr_select`→`browser_screenshot` on an IWE-emulated page, one tab.

### Phase 2 — Robustness

**`@iwer/extension-bridge`:** stable per-user token cache option; reconnect/relay `cleanStale`; multi-tab fan-in + first-response-wins surfaced to agent; structured error taxonomy (reuse `RuntimeIssueCause`).
**extension:** multi-tab binding + active-tab switching with the tab-change warning; `optional_host_permissions` flow; pairing deep-link; reconnect after sleep.
**iwer:** `describe()` enrichment (descriptions, inputShape, readOnlyHint) → daemon generates catalog by intersection; same-frame `capture_canvas`.
**shared:** extract `@iwer/extension-bridge-core` (relay + catalog + adapters); repoint `@iwer/extension-bridge`.

### Phase 3 — WebMCP + convergence

**iwer:** register `document.modelContext.registerTool` from the manifest behind feature detection (additive).
**iwsdk:** migrate `@iwsdk/cli` to consume `@iwer/extension-bridge-core` (kill divergence); migrate its stdio server to `McpServer`.
**extension:** ship CWS build with tightened permissions.

---

## 9. Testing & validation

**Unit:**

- Relay: request broadcast, first-response-wins, duplicate drop, `cleanStale` (port `mcp-relay.ts` tests).
- Tool mapping: every `mcpName`→`wsMethod` resolves; Zod shapes accept valid / reject invalid; catalog↔runtime intersection drops unknown methods.
- Compression: `capture_canvas` result → MCP image; oversized frame triggers daemon re-encode under the byte ceiling.
- Config writers: JSON merge/unmerge + TOML block insert/strip idempotency (reuse `mcp-adapters` tests).
- Token gate: missing/wrong token and bad Origin both rejected; correct token + extension Origin accepted.

**E2E** (extension + daemon + sample WebXR page driven by an agent):

- Headless/headful Chrome with the unpacked extension; a fixture WebXR page (an `iwsdk.dev` example or a minimal three.js WebXR scene); spawn `@iwer/extension-bridge serve`; script the full chain agent→…→IWER for accept/look_at/select/screenshot; assert device transforms and a non-black screenshot.
- Tab-change + reload warning surfaces; reconnect after offscreen restart.
- Pairing: wrong code rejected; correct code binds the tab.

**Spikes** (also in §8 Phase 0, tracked as validation gates): offscreen WS longevity; capture_canvas token cap; LNA/extension exemption; **CWS review dry-run** of the tightened permissions + offscreen reason string (submit early — review latency is a schedule risk).

---

## 10. Risks & open decisions for Felix

1. **Package home & naming:** ship the daemon as `@iwer/extension-bridge` (under IWER) or `@iwsdk/...`? Recommendation: `@iwer/extension-bridge` — it's IWER-scoped, project-agnostic, and decouples from IWSDK release cadence. (Affects the shared-lib extraction owner.)
2. **Extract `@iwer/extension-bridge-core` now vs later?** Recommendation: extract in Phase 2 and migrate IWSDK in Phase 3 to prevent drift. Cost: touching shipped `@iwsdk/cli`. Your call on timing vs extension demo.
3. **Token/pairing UX:** grounded baseline (§11) is **fixed default port + token-only pairing code + one-time "Allow" gesture**, with deep-link as the one-click path and paste as fallback. The remaining decision is **token persistence**: ephemeral per-session (re-pair on every daemon restart, smallest surface) vs a stable per-user token cached under `~/.iwer/` (pair once, survives restarts, small persistent-secret surface). Recommendation: ephemeral for v1; offer persistent as an opt-in in Phase 2.
4. **host_permissions strategy under CWS:** can we realistically move to `optional_host_permissions` given `registerContentScripts` needs broad host access for arbitrary dev domains? If not, document why broad `host_permissions` remain and lean harder on the token+Origin layer. Needs a CWS-policy read.
5. **~~capture_canvas correctness~~ — RESOLVED:** went with option (b) — `browser_screenshot` is a browser-host tool serviced by the extension SW via `chrome.tabs.captureVisibleTab` (composited tab pixels, immune to `preserveDrawingBuffer`), and `capture_canvas` was removed from IWER entirely. Cost: `<all_urls>` capture permission and the bound tab must be the focused tab. Residual question for Felix: is `<all_urls>` acceptable for CWS, or should we lean on the `activeTab` gesture path only (requires a Connect-time click and re-capture only the gesture tab)?
6. **One tab vs multi-tab in v1:** ship single-tab binding for MVP (simpler consent story) and defer multi-tab to Phase 2 — confirm that's acceptable for the extension demo.
7. **WebMCP timing:** keep it Phase 3 forward-compat, or invest earlier if a partner agent commits to consuming page-registered tools before the extension demo? Currently no consumer exists — recommend holding.

---

## 11. Grounding in proven extension architectures

This section validates the plan against how major shipping tools actually wire the extension↔agent hop (researched 2026-06-15: Playwright MCP, Claude for Chrome + Claude Code's browser connection, chrome-devtools-mcp, Browser MCP, AgentDesk browser-tools, MCP-B/WebMCP, native-messaging extensions, OpenAI Atlas/Operator, browser-use). **Bottom line: Option E is the proven topology, not a risky bet, and our security posture is stronger than the de-facto norm.**

### 11.1 The seven canonical patterns (and where we sit)

| Pattern                           | What it is                                                                                           | Marquee users                                                                      | Us?                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **A. CDP via `chrome.debugger`**  | Extension attaches DevTools Protocol to a tab; reaches a page object only via `Runtime.evaluate`     | Playwright MCP ext-mode, Claude for Chrome (input half), Comet, Automa Debug       | **No** — banner, broad `debugger` perm, DevTools mutual-exclusion, can't natively call `device.remote`               |
| **B. CDP external/remote launch** | Node (Puppeteer/Playwright) launches or attaches to Chrome's `--remote-debugging-port`; no extension | chrome-devtools-mcp, Playwright MCP default, browser-use (`:9222`)                 | **No** — requires controlling the Chrome launch; we target the _already-open_ normal browser                         |
| **C. Native messaging**           | Chrome spawns a locally-installed host binary over stdio                                             | Claude Code↔ext leg, hangwin/extension-bridge-chrome, 1Password/KeePassXC                       | **Declined** (11.4) — per-OS install friction; does _not_ actually fix SW idle-death                                 |
| **D. Localhost-WS bridge**        | Node daemon hosts a loopback WS server; MV3 SW dials in as client                                    | Browser MCP (9009), MCP-B (9333), ModCDP (29292), Playwright ext-mode (ephemeral)  | **YES — our transport**                                                                                              |
| **E. In-extension agent**         | Agentic loop runs inside the extension, calls the model API directly                                 | Claude for Chrome side panel                                                       | No — our agent is an external CLI                                                                                    |
| **F. Full agent-browser**         | Vendor ships the whole browser                                                                       | ChatGPT Atlas, Operator, Comet, Gemini-in-Chrome, Copilot/Edge                     | No — third-party ext on arbitrary Chrome                                                                             |
| **G. In-page WebMCP**             | Page registers callable JS tools on `navigator/document.modelContext`                                | WebMCP (Chrome 149 origin trial), MCP-B, chrome-devtools-mcp `execute_webmcp_tool` | **YES — our page-side pattern** (Phase 3); `device.remote.describe()/dispatch()` already implements this abstraction |

The extension MCP bridge is a **D + G hybrid**: localhost-WS transport (D) carrying calls into an in-page tool surface (G). Both halves have shipping precedent.

### 11.2 Comparative evidence (the localhost-WS cohort)

| Tool                 | Port                         | Rendezvous                                   | Bind                                                                              | Auth                                                              |
| -------------------- | ---------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Browser MCP          | 9009 fixed                   | manual Connect click                         | **`0.0.0.0`** (LAN-exposed, [#158](https://github.com/BrowserMCP/extension-bridge/issues/158)) | **none**                                                          |
| browsermcp-enhanced  | 8765                         | —                                            | —                                                                                 | origin allowlist (`*` default), no token                          |
| AgentDesk (archived) | 3025–3035 **scan**           | `/.identity` signature (discovery, not auth) | `0.0.0.0`                                                                         | **none**, CORS open                                               |
| MCP-B local relay    | 9333 fixed                   | page dials out, `webmcp.v1` subprotocol      | `127.0.0.1`                                                                       | origin check only; docs admit "does not restrict local processes" |
| ModCDP reverse       | 29292 fixed                  | `modcdp.reverse.hello` handshake             | `127.0.0.1`                                                                       | handshake, no token                                               |
| Extension MCP bridge  | **fixed default + override** | **token-only pairing code + Allow gesture**  | **`127.0.0.1`**                                                                   | **per-session token + Origin/Host check**                         |

**Reading:** the extension-is-WS-client / Node-hosts-server topology is universal in this cohort (an MV3 SW _cannot_ host a server). Auth is essentially absent across the field, and one major tool binds all interfaces. **Our `127.0.0.1` + per-session token + Origin/Host check is strictly stronger than every mainstream analog** — a deliberate hardening, not over-engineering.

### 11.3 Key corrections from the research (fold into reasoning)

- **Claude for Chrome is a _hybrid_, and it injects a page-world JS API.** It uses `chrome.debugger`/CDP for input + screenshots, but its `read_page`/`find`/`form_input` tools inject page-world JS (`window.__generateAccessibilityTree`, `window.__claudeElementMap`). **First-party tooling driving a bespoke injected page object directly vindicates our MAIN-world `connectTransport` approach** — it is consistent with, not contrary to, how the leaders reach a page object. ([teardown](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b))
- **Claude Code's browser bridge is three transports, default _remote cloud relay_.** Extension↔host = native messaging; CLI↔host = local Unix socket; but the 2026 default routes via `wss://bridge.claudeusercontent.com/chrome/<uuid>` keyed by OAuth account. That account-routing causes real, filed bugs (wrong-Chrome-on-LAN, "user mismatch" 1008, silent Windows pairing). **Our local-only, token-keyed design structurally cannot have these** — strong evidence _for_ staying local. ([Claude Code Chrome docs](https://code.claude.com/docs/en/chrome))
- **Native messaging does not sidestep SW idle-death** — the MV3 SW still idles (~30s) and breaks the channel; Anthropic's docs say so and the remedy is manual reconnect. So it buys us nothing over Option E on lifetime, while adding per-OS install friction.
- **Playwright MCP ext-mode uses an _ephemeral_ port and launches the browser to push the relay URL** — we can't replicate that (we attach to an already-open Chrome), which is exactly the gap the out-of-band token fills. Its 20s connect-tab ping is **approval-window-scoped**, not its session keep-alive (don't cite it as our offscreen justification).
- **`chrome.debugger` keep-alive is incidental + intrusive** (carries the banner) — not a sanctioned drop-in keep-alive; the offscreen-doc WS is the right mechanism.

### 11.4 Native messaging — explicitly declined (pre-empts the review question)

Native messaging (Pattern C) is the credible competitor: Anthropic, hangwin/extension-bridge-chrome, and every password manager rely on it, and `connectNative()` is a _documented_ SW keep-alive while the port is open. We decline it for v1 because: (a) it requires a **per-OS native-host manifest install/registration** (file on mac/Linux, registry on Windows, extension-ID-pinned) — this breaks the "`npx` and go" promise that is the whole point of the no-dev-server story; (b) verified: it **does not actually solve** MV3 SW idle-death; (c) the 1 MB host→extension cap would force chunking of `capture_canvas` frames; (d) it's bug-prone even for Anthropic. Keep it documented as a **future fallback** for locked-down environments that forbid loopback servers.

### 11.5 Prioritized changes already applied / to track

Applied inline above: **(1)** one-time human "Allow this agent session" gesture (§5, §6); **(2)** token-only pairing code + fixed default port (§5); **(3)** offscreen-doc justification re-grounded (§3.2); **(4)** ShadowPrompt message-channel hardening — exact-origin, `event.source`/MessagePort identity, method allow-list (§6); **(5)** no `eval`/`new Function` in SW/offscreen (§6); **(6)** explicit `127.0.0.1` bind + Host allowlist vs Browser MCP's `0.0.0.0` (§6).

Still to track during implementation: **(7) [Med]** keep `describe()`/world-query output compact — Playwright's MCP-vs-CLI token study showed ~114k vs ~27k tokens; return minimal structured payloads. **(8) [Low]** shape `device.remote` tool descriptors to mirror WebMCP (`name`/`description`/`inputSchema`/async `execute`) for future `navigator.modelContext` + `execute_webmcp_tool` interop. **(9) [Low]** native-messaging documented as declined alternative (§11.4).

### 11.6 Where we are already aligned with — or better than — the incumbents

- **Topology** (daemon hosts WS server, extension dials in): the proven norm across the entire extension cohort + Playwright + ModCDP.
- **stdio MCP agent hop**: the universal coding-agent integration (Playwright MCP, chrome-devtools-mcp, Browser MCP, MCP-B all expose stdio).
- **Driving `device.remote` via MAIN-world inject + postMessage bridge**: canonical Chrome pattern, proven end-to-end by MCP-B's shipped `@mcp-b/transports`, and consistent with Claude for Chrome's own injected page-world API — better-positioned than CDP for an in-page object.
- **Auth (`127.0.0.1` + per-session token + Origin/Host check)**: strictly stronger than the cohort norm and than Playwright's long-lived per-profile token.
- **Local-only rendezvous** (vs account-keyed cloud relay): structurally avoids the wrong-browser/user-mismatch bugs that plague Anthropic's relay.
- **Not using `chrome.debugger` for the page layer**: avoids the recurring infobar, the broad permission, and the DevTools mutual-exclusion.

---

## Appendix — Key source references

- IWER control surface: `immersive-web-emulation-runtime/packages/iwer/src/remote/RemoteControlInterface.ts` — `connectTransport` ~:1098, `describe`/`listMethods` ~:1067, `dispatch` ~:1614, `IMMEDIATE_METHODS`/`SESSION_REQUIRED_METHODS` ~:1547/:1577, `capture_canvas` ~:1406. Types: `remote/types.ts` (`CaptureCanvasResult` ~:322). Exports: `packages/iwer/src/index.ts`.
- Extension (target of most changes): `immersive-web-emulator/src/index.ts` (`injectRuntime`), `src/service-worker.ts` (per-domain MAIN-world `registerContentScripts` :89), `manifest.json` (MV3), `rollup.config.js`.
- IWSDK reference to port: `immersive-web-sdk/packages/vite-plugin-dev/src/extension-bridge-relay.ts` (`createRelayHandler`), `packages/cli/src/extension-bridge-stdio.ts` (stdio server, `createTabTracker`), `packages/cli/src/runtime-transport.ts` (WS client), `packages/cli/src/runtime-contract.ts` (`RUNTIME_MCP_TOOLS`, `RUNTIME_TOOL_TO_METHOD`, `MCP_CONFIG_TARGETS`), `packages/cli/src/extension-bridge-adapters.ts` (config writers), `packages/vite-plugin-dev/src/extension-bridge/ws-client.ts` (in-page client, tab identity).
