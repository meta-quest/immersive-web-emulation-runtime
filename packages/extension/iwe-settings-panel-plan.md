# Repurpose the DevTools Panel as the IWE Persistent-Settings + Migration-Explainer + AI-Agent-Config Home

**Status:** Plan / ready to implement
**Owner:** Felix Zhang (fe1ix@meta.com)
**Date:** 2026-06-15
**Companion docs:** `iwe-feature-parity.md` (the gap analysis this builds on), `extension-mcp-bridge-plan.md` (the shipped MCP/agent feature).

**Repos touched:**

- Extension shell: `/Users/fe1ix/Projects/webxr-dev-platform/immersive-web-emulation-runtime/packages/extension` (the MV3 extension package)
- Workspace libs: `/Users/fe1ix/Projects/webxr-dev-platform/immersive-web-emulation-runtime` (`packages/devui`, `packages/iwer`, `packages/sem`, `packages/extension-bridge`)
- Classic read-only reference: `/Users/fe1ix/Projects/iwe-classic` (v1.5.0 @ `7abf503a`)

**Chosen architecture (C+B merge):** a vanilla, dependency-light DevTools panel (kept under the classic name **"WebXR"**) as the **Phase-1** primary surface, with an **options-page mirror** added as a designed-in **Phase-2** fallback (reachable when DevTools is closed). Candidate A (sharing `@iwer/devui` React components into the panel) is **rejected**: it would force React/JSX/styled-components into the extension page bundles, require refactoring the _published_ `@iwer/devui`, and rely on fragile tree-shaking to keep three.js out of the panel bundle — for a settings form that is selects + toggles + two sliders + static docs.

> **This is the reconciled plan.** It incorporates the design review: **two blockers** (cross-world write-back, environment fetch) and the **majors** (live-apply has no receiver, hydrate race, scope-visibility UI, keymap vendoring, classic-import, clear-all) are resolved below. Where the review and the draft disagreed, the review wins.

---

## 0. Decisions locked by the review (read first)

These supersede any looser statement later in the doc:

1. **All panel/options edits are reload-to-apply in v1.** No live `PREFS_APPLY` path ships in v1 — there is no guaranteed ISOLATED receiver on emulated-but-unpaired tabs, and a half-live/half-reload form is unpredictable. One consistent model: edit → "Reload page to apply." Live-apply is a later, free enhancement. _(resolves MV3-major "PREFS_APPLY has no receiver" + product-minor "apply-now coherence")_
2. **Write-back from the overlay crosses worlds via `window.postMessage` with a channel tag — NOT `CustomEvent`.** A MAIN-world `CustomEvent`'s `detail` is **not** exposed to ISOLATED-world listeners (it arrives `null`); only structured-cloned `postMessage` survives the hop. Reuse the existing agent-bridge `PAGE_CHANNEL` idiom (`src/agent/bridge-page.ts` ↔ `content-bridge.ts`). _(resolves MV3-blocker #1)_
3. **Environments stay statically bundled.** The shell is built UMD, and `sem.loadDefaultEnvironment(id)` takes the UMD branch that `fetch()`es from `unpkg.com` — breaking offline, adding latency, and exposed to the page's `connect-src` CSP. Statically `import` all 5 capture JSONs into the shell and call `sem.loadEnvironment(MAP[id])`. Never `loadDefaultEnvironment` in the shell. _(resolves MV3-blocker #2)_
4. **`DEFAULT_KEYMAP` is vendored** (a frozen copy in `prefs.ts`) with a unit test asserting equality against `@iwer/devui`. A re-export barrel can't keep React/styled-components/three.js out of the vanilla panel bundle (devui modules have top-level side effects and no `sideEffects:false`/exports map). _(resolves MV3-major "keymap barrel")_
5. **Hydrate uses a dedicated ISOLATED `document_start` prefs-seeder content script**, registered in the **same** `registerContentScripts` call ordered **before** `iwe.min.js`, that reads `chrome.storage.local` and `postMessage`s prefs into MAIN; `injectRuntime()` awaits the seed (one message / microtask, with a short timeout → DEFAULTS). Re-register all scripts on `chrome.runtime.onStartup` (fixes the `persistAcrossSessions:false` restart gap) and cache the registered-domain set in `chrome.storage.local` to avoid a per-navigation `getRegisteredContentScripts()` round-trip. _(resolves MV3-major "hydrate race / wrong gating")_
6. **Scope is visible and editable.** The panel shows a per-field inheritance badge (_Default · from all-sites_ vs _Overridden for this site_) and a top-of-form **"Editing: [This site] · [All sites (default)]"** selector. A per-origin override is written **only when the value differs from the inherited one** — merely opening the panel on a site must not silently promote it to a configured override. _(resolves product-major "scope not visible")_
7. **Reset/clear is at parity+:** footer offers **"Reset this site"**, **"Reset all-sites defaults"**, and **"Clear ALL emulator settings"** (wipes the whole blob, with confirm), plus the manifest **version** shown in the panel. _(resolves product-major "clear-all weaker than classic")_
8. **Classic settings are NOT migrated (Felix's call, 2026-06-15).** A returning v1.5.0 user starts from fresh defaults. This is a deliberate decision, not an oversight: the whats-new page states "settings reset in 2.0 — set them once here and they'll persist." No classic-import code, no `CLASSIC_KEY` read. _(addresses product-major "classic blob ignored" by making the non-import explicit + user-visible)_

---

## 1. Goal & non-goals

### Goal

Re-introduce a Chrome DevTools panel (named **"WebXR"** — the discoverability anchor for returning v1.5.0 users) and **repurpose** it as the durable home for three things 2.0 has no home for:

1. **Persistent settings** (survive reloads, set once): device/headset, default environment, input mode, key bindings, stereo/IPD/FOV, hand poses (+ schema-reserved future controls). Today **nothing persists** — `src/index.ts` hardcodes `metaQuest3` + `living_room`.
2. **A migration / onboarding explainer** ("where did my controls go?") — veterans will look in the panel for the live controls and find them gone (they moved to the in-page overlay).
3. **AI-agent (MCP bridge) configuration** — the durable what/why/how of driving the emulator from a coding agent, plus install commands and pairing instructions. The live _connect_ gesture stays in the toolbar popup.

### Non-goals (explicit)

- **The panel does NOT host live controls or the 3D inspector.** Those stay in the in-page React overlay (`@iwer/devui`, mounted by `xrDevice.installDevUI(DevUI)`). Panel = set-once config + docs.
- **The panel is NOT the durable store and NOT the hydrator.** A DevTools panel exists only while DevTools is open. Store = `chrome.storage.local`; hydrator = a `document_start` ISOLATED seeder (§7).
- **The panel does NOT mint agent sessions.** No Connect/Allow/Disconnect buttons. The "Allow this agent session" gesture stays a trusted user gesture in the toolbar popup (mints a per-tab token kept out of the page). The panel mirrors status read-only and instructs.
- **No React in the extension shell.** `tsconfig.json` has no `jsx`; extension page bundles are plain-TS IIFEs (`popup.ts`, `content-bridge.ts`, `offscreen.ts`). The panel follows that idiom.

### Deliberately out of scope for v1 (named, not silently dropped)

- **Environment authoring** (classic `userObjects`: create/delete/show-hide planes & meshes with semantic labels) — SEM only _loads_ prebuilt captures today; there is no authoring engine. Deferred (parity roadmap #11, **L**).
- **`roomDimension`** — **schema-reserved** in the COULD tier (3 numbers; persist the value now even though room editing isn't surfaced) so a returning user's expectation is partially met and no migration is needed when it lands.
- **Import/Export + multi-origin management table** — deferred to the **Phase-2 options page** (the natural home, since it isn't bound to a single inspected tab). Cheap to add there (one `JSON.stringify` / file input through `mergePrefs`).

---

## 2. Architecture overview

### 2.1 The four surfaces

```
                       chrome.storage.local['iwe-prefs:v1']   <-- THE durable store
                       { version, global, ui, origins:{etld1:{...}} }
                                    ▲          ▲
                          (edit)    │          │   (resolve + seed at load)
                                    │          │
   ┌──────────────────────┐        │          │        ┌──────────────────────────┐
   │ DevTools "WebXR"      │  PREFS_READ/WRITE │        │ SERVICE WORKER (router)   │
   │ panel  (EDITOR)       │────────┘          └────────│ - resolve(domain) cascade │
   │ - migration explainer │  (chrome.runtime.sendMessage)  - PREFS_READ/WRITE      │
   │ - persistent settings │◀───────── STATUS ──────────│ - STATUS (eTLD+1, paired) │
   │ - AI-agent docs       │   (read-only status mirror) │ - onInstalled (whats-new, │
   │ - empty state         │                             │   badge)                  │
   └──────────────────────┘                              │ - registers seeder+shell  │
        (exists only while DevTools open)                └────────────┬─────────────┘
                                                                       │ registerContentScripts (ordered)
   ┌──────────────────────┐                                           │  [1] prefs-seeder (ISOLATED, document_start)
   │ TOOLBAR POPUP         │   PAIR/UNPAIR/TOGGLE_EMULATION            │  [2] iwe.min.js   (MAIN,     document_start)
   │ - emulation toggle    │──────────────────────────────────────────┘
   │ - paste code + Allow  │                                              │ seeder reads chrome.storage.local,
   │ - disconnect          │                                              │ window.postMessage({channel:'iwer-prefs-seed', prefs})
   │ - "Set up an AI agent"│                                              ▼
   │   (install docs)      │                              ┌──────────────────────────┐
   └──────────────────────┘                              │ PAGE (MAIN world)         │
                                                          │ build/iwe.min.js          │
   write-back from overlay:                               │ injectRuntime():          │
   DevUI window.postMessage({channel:'iwer-prefs',patch}) │  awaits seed msg,         │
        │ (debounced)                                     │  new XRDevice(cfg,opts),  │
        ▼                                                 │  installRuntime/DevUI/SEM,│
   content-bridge.ts (ISOLATED) ── MSG.PREFS_WRITE ──────▶│  loadEnvironment(MAP[id]),│
        (validates channel + event.source===window)       │  seed keymap/poses,        │
                                                          │  installAgentBridge        │
                                                          └──────────────────────────┘
```

- **Durable store** = `chrome.storage.local`, one key `iwe-prefs:v1`, keyed per-origin by eTLD+1 (`tldts`), with a `global` fallback layer (§3).
- **Hydrator** = ISOLATED `document_start` seeder content script reads storage and `postMessage`s into MAIN before `injectRuntime()` builds the device (§7).
- **Panel/options** = editors that talk to the SW (`PREFS_READ`/`PREFS_WRITE`) and mirror `STATUS` read-only. All edits reload-to-apply.
- **Popup** = the live, per-tab connect/disconnect gesture + an install-docs collapsible (so non-DevTools users get the agent install half on day one).

### 2.2 MV3 caveats (load-bearing constraints)

| #   | Caveat                                                                                                                                                            | Consequence                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A DevTools panel exists **only while DevTools is open**; destroyed on close, fresh JS on reopen.                                                                  | Panel is never the store or hydrator. Phase 2 options page exists precisely to reach DevTools-closed users.                                                                                                        |
| 2   | Service worker **evicted after ~30s idle**.                                                                                                                       | Prefs + seen-flags in `chrome.storage.local`; pairing in `chrome.storage.session` (already so). `PREFS_*`/`STATUS` handlers `return true` for async.                                                               |
| 3   | **Cross-world boundary:** a MAIN `CustomEvent.detail` is invisible to ISOLATED listeners.                                                                         | Overlay write-back uses `window.postMessage` + channel tag (Decision #2), not `CustomEvent`.                                                                                                                       |
| 4   | **UMD shell + `loadDefaultEnvironment` ⇒ `fetch(unpkg)`.**                                                                                                        | Statically bundle all 5 captures; `loadEnvironment(MAP[id])` only (Decision #3).                                                                                                                                   |
| 5   | **`document_start` ordering race:** an `executeScript` from `onCommitted` is not guaranteed to beat a `document_start` registered script, and the SW may be cold. | Use an ISOLATED `document_start` seeder registered **before** the shell in one `registerContentScripts` call; `injectRuntime()` awaits the seed with a timeout fallback; re-register on `onStartup` (Decision #5). |
| 6   | `DevUI` ctor **zeroes `xrDevice.ipd`** on `installDevUI`.                                                                                                         | Apply `ipd` **after** `installDevUI(...)` (§7.1) or it silently no-ops. Code comment + ordering test.                                                                                                              |
| 7   | `inspectedWindow.tabId` can be `chrome://`, `about:blank`, or the undocked DevTools window.                                                                       | Panel guards and still renders (a) explainer + (c) AI docs with an empty (b). Options page has no inspected tab → origin picker / `?domain=` deep-link.                                                            |
| 8   | Domain keying must be **byte-identical** to the SW's `tldts`.                                                                                                     | All domain resolution goes through `MSG.STATUS` (one `extractDomain` site). Free-text origins in options normalize through the same path.                                                                          |
| 9   | CSP `extension_pages = "script-src 'self'; object-src 'self'"`.                                                                                                   | No inline `<script>`/`onclick`/`eval`. Bundled `<script src>` + inline `<style>` only. **No `web_accessible_resources`** (devtools/panel/options/whats-new are extension pages).                                   |
| 10  | `chrome.storage.onChanged` fires in the panel.                                                                                                                    | Debounce + skip the panel's own last write or it render-loops.                                                                                                                                                     |
| 11  | The panel **cannot open the action popup**.                                                                                                                       | Instruct "click the toolbar icon to connect" — never a Connect button (also a security requirement).                                                                                                               |
| 12  | `onInstalled` fires on unpacked reload with `previousVersion === current` (spurious "update").                                                                    | Migration notice gates only on a genuine 1.x→2.x crossing, at most once, flag in `chrome.storage.local`.                                                                                                           |
| 13  | `options_ui { open_in_tab:true }` can steal focus from the dev's app tab.                                                                                         | "Use my current tab" captures the active tab at open time; prefer popup deep-link `?domain=<etld1>`.                                                                                                               |

---

## 3. Persistence framework

### 3.1 New shared module: `src/agent/prefs.ts`

Imported by `panel.ts`, the options host, `service-worker.ts`, the prefs-seeder, and `src/index.ts` — **one** cascade and **one** catalog. No rollup entry of its own (tree-shaken into each bundle). **Side-effect-free** (no React/zustand/three imports) so it can ride into the vanilla bundles.

Contents:

- `STORAGE_KEY = 'iwe-prefs:v1'`. (No classic-key read — classic settings are not migrated, Decision #8.)
- Types: `PrefsBlob`, `OriginPrefs`, `GlobalPrefs`, `UiPrefs`.
- `DEFAULTS` mirroring iwer's own (`ipd: 0.063`, `fovy: Math.PI/2`, `stereoEnabled: false`, `device: 'metaQuest3'`, `environment: 'living_room'`, `inputMode: 'controller'`, `handPoses: {left:'default',right:'default'}`).
- `DEVICE_CATALOG = ['oculusQuest1','metaQuest2','metaQuestPro','metaQuest3']`.
- `ENVIRONMENT_CATALOG = ['living_room','meeting_room','music_room','office_large','office_small','none']`.
- `DEFAULT_KEYMAP` — **vendored frozen copy** of `@iwer/devui`'s (Decision #4), plus `KeyMapType` (erased type, safe to re-declare).
- `resolve(blob, domain, key)`: `origins[domain]?.[key] ?? global?.[key] ?? DEFAULTS[key]`, deep-merge for `keymap` (`DEFAULT_KEYMAP ⊐ global.keymap ⊐ origins[domain].keymap`).
- `resolveAll(blob, domain)`: full resolved `OriginPrefs` for the seeder.
- `mergePrefs(blob, scope, domain, patch)`: merges into `global`/`ui`/`origins[domain]`; **prunes** an origin key whose value equals the inherited (global/DEFAULT) value, so opening the panel never silently creates an override (Decision #6).
- `isOverridden(blob, domain, key)`: for the per-field inheritance badge.

### 3.2 The `chrome.storage.local` JSON schema (versioned)

```jsonc
{
  "version": 1, // migration guard; cold-falls-back to DEFAULTS if missing/unknown
  "global": {
    // "all-sites defaults" fallback for any unset origin
    "device": "metaQuest3",
    "environment": "living_room",
    "inputMode": "controller",
    "stereoEnabled": false,
    "ipd": 0.063,
    "fovy": 1.5707963267948966,
    "keymap": {
      /* KeyMapType; omit => DEFAULT_KEYMAP */
    },
    "handPoses": { "left": "default", "right": "default" },
    "roomDimension": null, // schema-reserved (COULD); no editor yet
    "triggerMode": "normal", // schema-reserved (no engine yet)
    "joystickSticky": false, // schema-reserved (no engine yet)
    "actionMappingOn": true,
  },
  "ui": {
    // global-only
    "seenWhatsNew": false,
    "seenWelcome": false,
    "lastInstallClient": "claude",
  },
  "origins": {
    "example.com": {
      // keyed by eTLD+1 (tldts .domain); only DIFFERING values stored
      "device": "metaQuest2",
      "environment": "office_small",
      "inputMode": "hand",
      "keymap": { "left": { "trigger": "KeyG" } }, // partial overrides ok
      "defaultPose": {
        /* per-input transforms; OPT-IN, present only if user saved one */
      },
    },
  },
}
```

Effective value = `origins[domain]?.[k] ?? global?.[k] ?? DEFAULTS[k]`. Strict superset of classic (which was global-only): `global` = "set once, applies everywhere"; `origins` = per-site overrides.

### 3.3 Read/write API in the service worker

Add to `MSG` (`src/agent/protocol.ts`):

```ts
PREFS_READ:      'iwer-prefs-read',     // panel/options -> SW: return {blob, resolved}
PREFS_WRITE:     'iwer-prefs-write',    // panel/options/content-bridge -> SW: merge + persist (+ optional reload)
CLEAR_NEW_BADGE: 'iwer-clear-new-badge',// any surface -> SW: clear NEW action badge
```

(No `PREFS_APPLY` in v1 — see Decision #1.)

SW cases (sketch):

```ts
case MSG.PREFS_READ: {
  (async () => {
    const { domain } = message;
    const blob = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? { version: 1 };
    sendResponse({ blob, resolved: domain ? resolveAll(blob, domain) : null });
  })();
  return true;
}
case MSG.PREFS_WRITE: {
  (async () => {
    const { scope, patch, tabId, reload } = message;        // scope: 'origin'|'global'|'ui'; clear ops are patches
    // content-bridge omits domain -> resolve from sender.tab.url; panel/options pass STATUS-derived domain
    const domain = message.domain ?? (sender.tab?.url ? extractDomain(sender.tab.url) : undefined);
    const blob = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? { version: 1 };
    const next = mergePrefs(blob, scope, domain, patch);     // prunes no-op overrides
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    if (reload && tabId != null) chrome.tabs.reload(tabId, { bypassCache: true });
    sendResponse({ ok: true });
  })();
  return true;
}
case MSG.CLEAR_NEW_BADGE: { chrome.action.setBadgeText({ text: '' }); return false; }
```

The SW is the single domain-resolution site. `MSG.STATUS` already returns the canonical eTLD+1 `domain`; editors never compute domains themselves.

### 3.4 Write-back from the overlay (cross-world, via postMessage)

1. DevUI emits a debounced `window.postMessage({ channel: 'iwer-prefs', patch, scope: 'origin' }, '*')` on a value change (§5).
2. ISOLATED `content-bridge.ts` adds a `'message'` listener that validates `event.source === window` and `data.channel === 'iwer-prefs'` (the existing agent-bridge hardening), then `chrome.runtime.sendMessage({ type: MSG.PREFS_WRITE, scope:'origin', patch })` (omitting `domain`; SW resolves from `sender.tab.url`).
3. SW merges into `origins[etld1]` and persists. The panel reflects it via `chrome.storage.onChanged` (debounced, own-write-guarded).

The content-bridge must be present on **all emulated tabs** for write-back to work (today it's only registered for _paired_ tabs). Register the ISOLATED bridge for every emulated domain (it already only forwards into MAIN via `postMessage`). This dovetails with the seeder registration (§7.2).

### 3.5 Versioning (no classic import)

- `version: 1` guards shape; unknown/missing → cold DEFAULTS (never bricks).
- Future shape change: bump `version`, run a one-shot migrator in `onInstalled` `update` (or lazily on first `PREFS_READ`).
- **No classic import (Decision #8):** the classic `immersive-web-emulator-settings` blob is intentionally ignored — returning v1.5.0 users start fresh. The whats-new page states this plainly ("settings reset in 2.0 — set them once and they persist") so it isn't a silent surprise. No `CLASSIC_KEY` read anywhere.

---

## 4. Settings catalog (panel)

Priority: **MUST** (parity headline / explicit ask), **SHOULD**, **COULD** (schema-reserve now). **All apply on reload in v1.**

| Setting                    | Type                                     | Default               | Scope      | Pri        | Hydrate path                                                                                                                    |
| -------------------------- | ---------------------------------------- | --------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `device`                   | enum (4)                                 | `metaQuest3`          | per-origin | **MUST**   | `new XRDevice(CATALOG[prefs.device] ?? metaQuest3)`. Replaces hardcode `src/index.ts`.                                          |
| `environment`              | 5 ids + `none`                           | `living_room`         | per-origin | **MUST**   | static `MAP[id]` → `sem.loadEnvironment(MAP[id])`; `none` → skip. **Never `loadDefaultEnvironment`** (Decision #3).             |
| `inputMode`                | `controller`\|`hand`                     | `controller`          | per-origin | **MUST**   | `xrDevice.primaryInputMode = prefs.inputMode` at construction; DevUI self-seeds from device.                                    |
| `keymap`                   | `KeyMapType`                             | `DEFAULT_KEYMAP`      | per-origin | **MUST**   | `useKeyMapStore.setState({ keyMap: resolved })` before render. Panel shows read-only + "Edit in overlay" + "Reset to defaults". |
| `fovy`                     | rad (UI °)                               | `Math.PI/2`           | per-origin | **MUST**   | `{ fovy }` device option; `headset.tsx` slider seeds from device.                                                               |
| `stereoEnabled`            | bool                                     | `false`               | per-origin | **MUST**   | `{ stereoEnabled }` device option. NEW panel toggle (no overlay control).                                                       |
| `ipd`                      | m                                        | `0.063`               | per-origin | **MUST**   | `xrDevice.ipd = prefs.ipd` **AFTER** `installDevUI` (caveat #6). NEW panel slider.                                              |
| `handPoses`                | `{left,right}` ∈ `default\|pinch\|point` | `{default,default}`   | per-origin | **SHOULD** | `xrDevice.hands.{left,right}.poseId = ...` post-construct. Cycler stays in overlay.                                             |
| enabled-domain durability  | per-origin flag                          | off                   | per-origin | **MUST**   | mirror enabled set into `chrome.storage.local`; re-register on `onStartup`. Today `persistAcrossSessions:false`.                |
| `defaultPose`              | per-input transforms                     | construction defaults | per-origin | **SHOULD** | **net-new code** (§5/§10-Q1): applied at load **iff the user saved one for this origin**.                                       |
| `agentAutoEnableEmulation` | bool                                     | `false`               | per-origin | **SHOULD** | SW auto-registers emulation on this origin at load (surfaced in AI section).                                                    |
| `actionMappingOn`          | bool                                     | `true`                | per-origin | **COULD**  | seed a DevUI flag.                                                                                                              |
| `roomDimension`            | `{x,y,z}`                                | `null`                | per-origin | **COULD**  | **schema-reserve** (no editor yet).                                                                                             |
| `triggerMode`              | `slow\|normal\|fast\|turbo`              | `normal`              | per-origin | **COULD**  | **schema-reserve**; greyed "coming soon" (no engine).                                                                           |
| `joystickSticky`           | bool                                     | `false`               | per-origin | **COULD**  | **schema-reserve**; greyed.                                                                                                     |

Sharp edges: **`ipd` must be set after `installDevUI`** (caveat #6); **environment is statically bundled** (Decision #3); **`triggerMode`/`joystickSticky`/`roomDimension` are stored but inert** until their engines land.

---

## 5. DevUI changes (storage-agnostic)

Principle: **DevUI never touches `chrome.storage`.** It accepts an initial value (existing zustand `setState` / device-property seeding) and **emits `window.postMessage({channel:'iwer-prefs', patch})`** (debounced) on change. No structural API change.

| Store / value                  | File           | INIT                                                                       | EMIT (NEW)                                                                                             |
| ------------------------------ | -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `useInputModeStore`            | `controls.tsx` | self-seeds from `xrDevice.primaryInputMode` (no change)                    | `zustand.subscribe` in `index.tsx` → debounced `postMessage {patch:{inputMode}}`                       |
| `useKeyMapStore`               | `mapper.tsx`   | `useKeyMapStore.setState({ keyMap })` from shell (no component API change) | `subscribe((s)=>s.keyMap)` → `postMessage {patch:{keymap}}`                                            |
| FOV (`fovy`)                   | `headset.tsx`  | seeded from device (no change)                                             | slider change handler also `postMessage {patch:{fovy}}`                                                |
| Hand pose (`poseId`)           | `pose.tsx`     | seeded from device (no change)                                             | `postMessage` in `cyclePose`; optionally expand cycle to `default\|pinch\|point`                       |
| Environment                    | `header.tsx`   | loaded on click                                                            | env-button click also `postMessage {patch:{environment}}`; add `None`                                  |
| `defaultPose`                  | `scene.ts`     | **net-new** (see below)                                                    | new "Save current pose as default" overlay button → `postMessage {patch:{defaultPose:<captured rig>}}` |
| `useHeaderStateStore`          | `header.tsx`   | transient                                                                  | **do not persist**                                                                                     |
| `stereoEnabled`/`ipd`/`device` | —              | —                                                                          | **no DevUI work** (panel-only; shell applies at hydrate)                                               |

**`defaultPose` is greenfield, not a hookup.** The current `scene.ts:resetDeviceTransforms()` reads only `headsetDefaultPosition/Quaternion` and handle `userData.defaultPosition` — it has no prefs input, and there is no save-pose capture today. New work: (1) overlay capture button → `postMessage` patch; (2) a new `scene.ts` param / `applyDefaultPose(transforms)` consuming seeded transforms; (3) shell hydrate applying it after device construction.

**`DEFAULT_KEYMAP`:** vendor a frozen copy into `prefs.ts` (Decision #4) + a Node unit test asserting equality with `@iwer/devui` (tests import devui freely; the panel bundle does not).

---

## 6. The panel UI

Plain TS + DOM/`<template>`, modeled on `src/agent/popup.ts` (`$()` helper, `chrome.runtime.sendMessage`, `chrome.storage.onChanged`). HTML like `popup.html` (inline `<style>`, external `<script src="panel.min.js">`). Factor the body into `mountSettings(root, originProvider)` from day one so the Phase-2 options page is cheap.

### (a) Migration explainer — always present, audience-aware

Persistent section leads with the **forward-looking** truth (shown to everyone, incl. 2.0-native users):

> **Where are the live controls?**
> The headset, controller, and hand controls are now a **floating overlay on the WebXR page itself**. Turn on emulation from the toolbar icon, open a WebXR page, and the controls appear over the content.
> **This panel** is for things you set once and keep: default device and environment, input mode, key bindings, and AI-agent (MCP bridge) setup. Changes here are saved per site and survive reloads.

The **DevTools-history framing** ("in older versions the controls lived in a _WebXR_ tab inside DevTools") appears **only** in the one-time version-gated banner and an **auto-collapsed "Coming from the old version?" expander** that defaults open _only_ when `ui.seenWhatsNew` was just set by the 1.x→2.x path — never as permanent chrome for 2.0-native users _(resolves product-minor "over-targets veterans")_.

One-time banner (`role="status"`, has `Got it` / `×`): names the old **"WebXR" DevTools tab** in quotes, pairs _what's gone_ with _where it went_, and states plainly that **settings reset in 2.0** ("set your defaults once here and they'll persist") — no silent surprise (Decision #8). Any acknowledgement (or touching a control) sets `ui.seenWhatsNew = true` and fires `CLEAR_NEW_BADGE`.

### (b) Persistent settings (per-origin, scope-legible)

Top of form: **"Editing: [This site: example.com] · [All sites (default)]"** segmented selector (the latter resolves `domain=null` and edits `blob.global`) _(Decision #6)_. Each field carries an inheritance badge — _Default · from all-sites_ vs _Overridden for this site_ — with a per-field **"Reset to all-sites default"** (deletes just that key from `origins[domain]`).

Fields, in order: **Device** select · **Environment** select (+None) · **Input mode** toggle · **Stereo** toggle (NEW) · **IPD** slider (NEW) · **FOV** slider · **Key bindings** (read-only + "Edit in overlay" + "Reset to defaults") · **Default pose** ("saved ✓ / [Clear]" only) · **Trigger mode** / **Joystick sticky** (greyed "Coming soon").

Because all edits reload-to-apply, show a **persistent "Changes pending — Reload page to apply" bar** at the top of the form whenever any field is dirty (not just a quiet label) _(resolves product-minor "apply coherence")_.

Footer: **"Reset this site"** · **"Reset all-sites defaults"** · **"Clear ALL emulator settings"** (confirm; wipes the whole blob) · **"Reload page to apply"** (`chrome.tabs.reload(tabId,{bypassCache:true})`) · a small **version stamp** (`chrome.runtime.getManifest().version`) _(Decision #7)_.

Bootstrap (mirrors `popup.ts:refresh`):

```ts
const tabId = chrome.devtools.inspectedWindow.tabId;
let url = '';
try {
  url = (await chrome.tabs.get(tabId)).url ?? '';
} catch {}
if (!/^https?:/.test(url)) {
  renderUnsupported();
  return;
} // still show (a)+(c)
const status = await chrome.runtime.sendMessage({ type: MSG.STATUS, url }); // single domain source
const { resolved, blob } = await chrome.runtime.sendMessage({
  type: MSG.PREFS_READ,
  domain: status.domain,
});
renderSettings({
  domain: status.domain,
  resolved,
  blob,
  tabId,
  url,
  emulationOn: status.emulationEnabled,
});
chrome.storage.onChanged.addListener((c, a) => {
  if (a === 'local' && c[STORAGE_KEY]) rerenderGuarded(c[STORAGE_KEY].newValue);
}); // debounce + skip own write
chrome.devtools.network.onNavigated.addListener(reinit);
```

### (c) AI-agent setup (MCP bridge)

- **What is this** (always visible): drive this page from your coding agent (Claude Code/Cursor/Codex/Copilot/Windsurf) over MCP.
- **Step 1 — install the bridge:** client picker (`claude | cursor | copilot | codex | windsurf | all`) swapping a copy `npx @iwer/extension-bridge install --client <id>` + the resolved config path per client (from `config-targets.ts`). Persist choice to `ui.lastInstallClient`.
- **Step 2 — connect this tab** (instructional + read-only status mirror): `npx @iwer/extension-bridge pair` copy box; "enable emulation"; "click the **toolbar icon**, paste the code, **Allow this agent session**." Explicit: **"Pairing happens in the toolbar popup — not here — for security. This panel can't connect for you."** + a **"Why?"** expander (per-session token stays in the extension, never readable by the page; DNS-rebinding/cross-origin risk).
- **Step 3 — try it:** an example prompt.
- **Tool catalog** (collapsible): **generated from `packages/extension-bridge/src/contract.ts` `TOOLS`** (`mcpName`/`title`/`description`/`readOnlyHint`), grouped, with a "read-only" badge — plus a **"Tools for @iwer/extension-bridge vX.Y"** version stamp so a stale extension vs newer daemon is diagnosable _(resolves product-minor)_. Never hand-copy a third list.
- **Read-only status mirror** for the inspected tab (`STATUS`, kept fresh via `onChanged` on session keys + refresh on focus). No Connect/Allow/Disconnect buttons.

The **install half also lives in the popup** as a collapsible "Set up an AI agent" (the always-reachable surface), so non-DevTools users get install on day one _(resolves product-minor "install unreachable without DevTools")_.

### (d) New-user empty state

When the inspected tab has emulation OFF or is non-http: steps to open a WebXR page + turn on emulation + Enter XR, noting controls are an overlay and this panel is for persistent setup.

State machine: Emulation OFF → (d); Emulation ON + polyfill → (a)+(b)+(c); `chrome://`/store/`file://` → "can't run here" + (a)/(c) docs. WebXR-presence probe via `chrome.devtools.inspectedWindow.eval("!!(window.CustomWebXRPolyfill)")` (the shell sets `window.CustomWebXRPolyfill = true`); optionally add a `navigator.xr.__iwer` sentinel.

### One-time notice (`onInstalled`)

```ts
const WHATS_NEW_FLAG = 'iwe:seenWhatsNew:v2',
  WELCOME_FLAG = 'iwe:seenWelcome';
const majorOf = (v) => parseInt(String(v).split('.')[0] ?? '', 10) || 0;
chrome.runtime.onInstalled.addListener(async (d) => {
  const current = chrome.runtime.getManifest().version;
  const get = async (k) => (await chrome.storage.local.get(k))[k] === true;
  const mark = (k) => chrome.storage.local.set({ [k]: true });
  const setNewBadge = () => {
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  };
  if (d.reason === 'install') {
    if (!(await get(WELCOME_FLAG))) {
      await mark(WELCOME_FLAG);
      setNewBadge();
      chrome.tabs.create({
        url: chrome.runtime.getURL('build/whats-new.html?mode=welcome'),
      });
    }
    return;
  }
  if (d.reason === 'update') {
    const prev = d.previousVersion ?? '';
    if (!prev || prev === current) return; // dev-reload trap (caveat #12)
    if (!(majorOf(prev) < 2 && majorOf(current) >= 2)) return; // only 1.x -> 2.x
    // NOTE: classic settings are intentionally NOT imported (Decision #8) — fresh start.
    if (await get(WHATS_NEW_FLAG)) return;
    await mark(WHATS_NEW_FLAG);
    setNewBadge();
    chrome.tabs.create({
      url: chrome.runtime.getURL(
        `build/whats-new.html?from=${encodeURIComponent(prev)}&to=${encodeURIComponent(current)}`,
      ),
    });
  }
});
```

Badge clears on first acknowledgement from any surface. `whats-new.html` is a bundled extension page.

---

## 7. Lift the hardcodes in `src/index.ts`

### 7.1 De-hardcode `injectRuntime()`

```ts
import {
  XRDevice,
  metaQuest2,
  metaQuest3,
  metaQuestPro,
  oculusQuest1,
} from 'iwer';
import { DevUI, useKeyMapStore } from '@iwer/devui';
import { SyntheticEnvironmentModule } from '@iwer/sem';
import { installAgentBridge } from './agent/bridge-page.js';
import { awaitSeed } from './agent/seed-client.js'; // resolves window.__IWE_PREFS__ (postMessage) or times out
import living_room from '@iwer/sem/captures/living_room.json';
import meeting_room from '@iwer/sem/captures/meeting_room.json';
import music_room from '@iwer/sem/captures/music_room.json';
import office_large from '@iwer/sem/captures/office_large.json';
import office_small from '@iwer/sem/captures/office_small.json';

const DEVICE_CONFIGS = { oculusQuest1, metaQuest2, metaQuestPro, metaQuest3 };
const ENV_MAP = {
  living_room,
  meeting_room,
  music_room,
  office_large,
  office_small,
};

export const injectRuntime = async () => {
  // @ts-ignore
  window.CustomWebXRPolyfill = true;
  const prefs = await awaitSeed(); // {} on timeout -> DEFAULTS path

  const cfg = DEVICE_CONFIGS[prefs.device] ?? metaQuest3;
  const xrDevice = new XRDevice(cfg, {
    stereoEnabled: prefs.stereoEnabled,
    fovy: prefs.fovy,
  });
  if (prefs.inputMode) xrDevice.primaryInputMode = prefs.inputMode;

  xrDevice.installRuntime({ forceInstall: true });
  xrDevice.installDevUI(DevUI); // zeroes ipd (caveat #6)
  if (prefs.ipd != null) xrDevice.ipd = prefs.ipd; // MUST be after installDevUI

  xrDevice.installSEM(SyntheticEnvironmentModule);
  if (prefs.environment !== 'none') {
    xrDevice.sem?.loadEnvironment(ENV_MAP[prefs.environment] ?? living_room); // static; never loadDefaultEnvironment
  }

  if (prefs.keymap) useKeyMapStore.setState({ keyMap: prefs.keymap });
  if (prefs.handPoses) {
    if (xrDevice.hands?.left) xrDevice.hands.left.poseId = prefs.handPoses.left;
    if (xrDevice.hands?.right)
      xrDevice.hands.right.poseId = prefs.handPoses.right;
  }
  if (prefs.defaultPose) applyDefaultPose(xrDevice, prefs.defaultPose); // net-new (§5)

  installAgentBridge(xrDevice);
};
```

### 7.2 The seeder + registration (Decision #5)

- New ISOLATED `document_start` content script `src/agent/prefs-seeder.ts`: reads `chrome.storage.local[STORAGE_KEY]`, `resolveAll(blob, location-domain)`, then `window.postMessage({ channel:'iwer-prefs-seed', prefs }, '*')`. (eTLD+1 in-page: it can ship `tldts` or post the raw host and let the SW resolve — prefer pre-resolving in the SW at registration time and embedding per-domain, but the simplest correct path is the seeder reads storage and resolves with a vendored `tldts` already used at `service-worker.ts`.)
- `service-worker.ts` registers, per emulated domain, **one** `registerContentScripts` call with `js: ['build/prefs-seeder.min.js', 'build/iwe.min.js']` — wait: the seeder is ISOLATED and the shell is MAIN, which are separate `world` registrations, so register them as **two** scripts both at `document_start`, seeder first. The MAIN shell's `awaitSeed()` listens for the `iwer-prefs-seed` message (≤ a few ms, with a ~50ms timeout → `{}`), removing the ordering dependency.
- Register the **content-bridge** (ISOLATED) for all emulated domains too (write-back, §3.4).
- **`chrome.runtime.onStartup`**: re-register all enabled domains (fixes the `persistAcrossSessions:false` restart gap).
- Cache the enabled-domain set in `chrome.storage.local` to avoid `getRegisteredContentScripts()` on the hot path.

### 7.3 `seed-client.ts` (`awaitSeed`)

A tiny MAIN-world helper: returns a Promise that resolves with the first `message` whose `data.channel === 'iwer-prefs-seed'` (validate `event.source === window`), or `{}` after a short timeout. This makes hydration **synchronous-enough** and race-free without relying on executeScript ordering.

---

## 8. Build / manifest changes

### 8.1 `manifest.json`

- Add `"devtools_page": "build/devtools.html"`.
- **No new permissions** (DevTools APIs need none; `webNavigation`/`storage`/`scripting`/`activeTab` already present).
- **No `web_accessible_resources`** (caveat #9).
- **Phase 2:** `"options_ui": { "page": "build/options.html", "open_in_tab": true }`.

### 8.2 New source files (under `src/agent/` → `copy-pages.mjs` needs no change)

| File                                            | Output                    | Purpose                                                                                                   |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `devtools.html` / `devtools.ts`                 | copy / `devtools.min.js`  | `chrome.devtools.panels.create('WebXR','icons/default128.png','build/panel.html')` once                   |
| `panel.html` / `panel.ts`                       | copy / `panel.min.js`     | the editor (vanilla; calls `mountSettings`)                                                               |
| `prefs.ts`                                      | (tree-shaken in)          | schema, DEFAULTS, catalogs, vendored `DEFAULT_KEYMAP`, `resolve`/`resolveAll`/`mergePrefs`/`isOverridden` |
| `prefs-seeder.ts`                               | `prefs-seeder.min.js`     | ISOLATED `document_start` seeder → `postMessage`                                                          |
| `seed-client.ts`                                | (tree-shaken into shell)  | MAIN `awaitSeed()`                                                                                        |
| `whats-new.html` / `whats-new.ts`               | copy / `whats-new.min.js` | welcome + moved variants; sets seen-flag + clears badge                                                   |
| **Phase 2:** `options.html` / `options-host.ts` | copy / `options.min.js`   | `PickerOriginProvider` + `mountSettings`, plus Configured-sites table + Export/Import                     |

### 8.3 `rollup.config.js` (IIFE entries via shared `extPlugins`)

```js
{ input:'lib/agent/devtools.js',     plugins:extPlugins, output:{file:'build/devtools.min.js',    format:'iife', plugins:[terser()]} },
{ input:'lib/agent/panel.js',        plugins:extPlugins, output:{file:'build/panel.min.js',       format:'iife', plugins:[terser()]} },
{ input:'lib/agent/prefs-seeder.js', plugins:extPlugins, output:{file:'build/prefs-seeder.min.js',format:'iife', plugins:[terser()]} },
{ input:'lib/agent/whats-new.js',    plugins:extPlugins, output:{file:'build/whats-new.min.js',   format:'iife', plugins:[terser()]} },
// Phase 2:
{ input:'lib/agent/options-host.js', plugins:extPlugins, output:{file:'build/options.min.js',     format:'iife', plugins:[terser()]} },
```

### 8.4 Tool-catalog generation (build-ordered)

`scripts/gen-tool-catalog.mjs` imports `TOOLS` from the **built** mcp output (`packages/extension-bridge/lib/.../contract.js`) or runs via `tsx` (not raw `.ts`), emits `src/agent/tool-catalog.generated.json`. **Run before `tsc`** (panel imports the JSON; `resolveJsonModule` + `include:['src/**/*']` means it must exist first): build script becomes `node scripts/gen-tool-catalog.mjs && tsc && rollup -c && node scripts/copy-pages.mjs`. **Commit a fallback JSON** so a clean checkout type-checks. A contract-drift test runs in CI (§11).

---

## 9. Phased task breakdown

Effort: **S** ≤ half day · **M** ~1–2 days · **L** ~3–5 days.

### Sprint 1 — Foundation + panel skeleton + migration explainer

| #   | Task                                                                                                                                       | Eff |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| 1.1 | `prefs.ts`: types, DEFAULTS, catalogs, vendored `DEFAULT_KEYMAP`, `resolve`/`resolveAll`/`mergePrefs` (with no-op pruning)/`isOverridden`  | M   |
| 1.2 | `protocol.ts`: `PREFS_READ`/`PREFS_WRITE`/`CLEAR_NEW_BADGE`                                                                                | S   |
| 1.3 | `service-worker.ts`: PREFS cases + `CLEAR_NEW_BADGE` (§3.3)                                                                                | M   |
| 1.4 | `manifest.json` `devtools_page`; rollup `devtools`+`panel` entries                                                                         | S   |
| 1.5 | `devtools.{html,ts}`: register "WebXR" panel once                                                                                          | S   |
| 1.6 | `panel.{html,ts}` + `mountSettings(root, originProvider)` skeleton: bootstrap, non-http guard, debounced `onChanged`, `onNavigated` reinit | M   |
| 1.7 | Section (a): audience-aware explainer + one-time banner                                                                                    | S   |
| 1.8 | `onInstalled` (welcome/moved gating) + NEW badge + `whats-new.{html,ts}` (states "settings reset in 2.0"; no classic import)               | M   |
| 1.9 | Unit tests: cascade, `mergePrefs` (+ keymap deep-merge + pruning), `majorOf`, onInstalled gating, **`DEFAULT_KEYMAP` equality vs devui**   | S   |

### Sprint 2 — Hydrate path + de-hardcode the shell (gates everything persistent)

| #   | Task                                                                                                                                                            | Eff |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 2.1 | `prefs-seeder.ts` (ISOLATED document_start) + `seed-client.ts` `awaitSeed()`                                                                                    | M   |
| 2.2 | `service-worker.ts`: register seeder + shell (ordered, two worlds) + content-bridge for all emulated domains; `onStartup` re-register; cache enabled-domain set | M   |
| 2.3 | `src/index.ts`: async `injectRuntime`, `awaitSeed`, static ENV_MAP, device/inputMode/stereo/fovy, **ipd-after-installDevUI** (§7.1)                             | M   |
| 2.4 | E2E (substrate): `PREFS_WRITE` device=metaQuest2 + env=office_small → reload → assert via `page.evaluate`                                                       | M   |

### Sprint 3 — Panel settings forms + DevUI emit/seed

| #   | Task                                                                                                                                                               | Eff |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| 3.1 | Section (b): device/env/inputMode/stereo/ipd/fovy + scope selector + inheritance badges + pending-changes bar + footer (reset-site/reset-global/clear-all/version) | M   |
| 3.2 | DevUI emit hooks via **`window.postMessage`** (inputMode, keymap, fovy, pose, environment)                                                                         | M   |
| 3.3 | `content-bridge.ts`: `'message'` listener (channel `iwer-prefs`, `event.source===window`) → `MSG.PREFS_WRITE`                                                      | S   |
| 3.4 | DevUI seed hooks: `useKeyMapStore.setState`, handPoses                                                                                                             | S   |
| 3.5 | Keymap read-only display + "Edit in overlay" + "Reset to defaults"                                                                                                 | S   |
| 3.6 | E2E: remap a key in overlay → assert persisted; panel reflects via `onChanged` (no loop)                                                                           | M   |

### Sprint 4 — AI-agent setup

| #   | Task                                                                                                                                        | Eff |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 4.1 | `scripts/gen-tool-catalog.mjs` (built mcp output) + build-order + fallback JSON                                                             | S   |
| 4.2 | Section (c): what/why, client picker + copy + resolved paths, pair instructions, security expander, version stamp                           | M   |
| 4.3 | Collapsible tool catalog from generated JSON                                                                                                | S   |
| 4.4 | Read-only status mirror                                                                                                                     | S   |
| 4.5 | Popup: collapsible "Set up an AI agent" (install docs) + "Setup & docs: open DevTools → WebXR panel"; fire `CLEAR_NEW_BADGE` on `refresh()` | S   |

### Sprint 5 — Empty state + default-pose + polish

| #   | Task                                                                                                                 | Eff |
| --- | -------------------------------------------------------------------------------------------------------------------- | --- |
| 5.1 | Section (d) empty-state + state machine + WebXR probe                                                                | S   |
| 5.2 | Overlay "Save current pose as default" + `scene.ts` `applyDefaultPose`/restore + panel "saved ✓ / [Clear]" (net-new) | M   |
| 5.3 | Enabled-domain durability mirror + `onStartup` re-register                                                           | M   |
| 5.4 | Schema-reserved `triggerMode`/`joystickSticky`/`roomDimension` greyed controls; `agentAutoEnableEmulation` toggle    | S   |

### Sprint 6 — Phase 2: options-page mirror

| #   | Task                                                                                                                                                              | Eff |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 6.1 | (already factored) wire `mountSettings` into options host                                                                                                         | S   |
| 6.2 | `options.{html,ts}` `PickerOriginProvider` (use-current-tab / configured-sites dropdown / free-text via STATUS) + **Configured-sites table + Export/Import JSON** | M   |
| 6.3 | `options_ui` manifest + rollup entry + popup "Open full settings" deep-link `?domain=`                                                                            | S   |
| 6.4 | Render explainer + AI-config in options page                                                                                                                      | S   |

**Critical path:** Sprint 1 → Sprint 2. Sprints 3/4/5 parallelize after 2. Sprint 6 deferred. **Prerequisite for real extension E2E:** productionize an extension-loading Playwright harness (§11) — the committed `packages/e2e` suite does not load the extension, and the `pw-*.mjs` files are untracked scratch.

---

## 10. Open questions & recommendations

**Q1 — "Save as default pose" in the panel? → NO; capture in the overlay.** A default pose is _captured_ live, not _typed_; capture stays in the overlay where posing happens. Persist to `origins[domain].defaultPose`; the panel shows only a read-only "saved ✓ / [Clear]" row. **Restore rule (reconciled):** auto-apply on load **iff the user explicitly saved a default pose for this origin** (opt-in by the act of saving) — classic-compatible for anyone who saved one, no surprise for those who didn't. _This is net-new code, not a `scene.ts` hookup (§5)._

**Q2 — Panel-only-when-DevTools-open → add options-page fallback as Phase 2.** Ship the panel first (the literal ask); the whats-new tab + NEW badge reach non-DevTools users in the interim; Phase 2 closes the gap with the same `mountSettings` app. The install docs also living in the popup (4.5) means the agent-setup half is reachable without DevTools on day one.

**Q3 — Apply now vs reload → all reload-to-apply in v1** (Decision #1), with a prominent pending-changes bar. Live-apply is a later free enhancement where a receiver is guaranteed.

**Q4 — `triggerMode`/`joystickSticky`/`roomDimension` → schema-reserve now, behavior later.** Stable stored shape; no migration when the engines land.

**Q5 — `DEFAULT_KEYMAP` source → vendor a frozen copy in `prefs.ts`** (Decision #4) + equality test. A re-export barrel drags React/three into the vanilla panel bundle.

**Q6 — Classic settings → DECIDED: not migrated** (Felix, 2026-06-15). Returning v1.5.0 users start fresh; the whats-new page states settings reset in 2.0. (The import-once-into-`global` alternative was considered and declined.)

---

## 11. Acceptance criteria & test note

**Acceptance (testable):**

1. Opening DevTools on an http(s) tab shows a top-level **"WebXR"** panel.
2. Panel's first section is the forward-looking explainer; DevTools-history framing only appears in the one-time banner / "Coming from the old version?" expander (never permanent for 2.0-native users).
3. `onInstalled` `update` from `1.5.0` opens whats-new (which states settings reset; no classic import runs); from `2.0.0` (same major) or `previousVersion===current` does nothing; fresh `install` opens `?mode=welcome`.
4. NEW badge shows after install/update, clears on first acknowledgement from any surface.
5. Setting `device=metaQuest2`+`environment=office_small` for `example.com` writes only those keys under `origins['example.com']` (no-op fields pruned).
6. Reloading emulated `example.com` constructs `new XRDevice(metaQuest2)` (assert `xrDevice.name`) and loads `office_small` from a **statically bundled** capture (no network request to unpkg). Hardcodes no longer take effect when prefs are present.
7. With `ipd=0.063` persisted, post-reload `xrDevice.ipd === 0.063` (set ran after `installDevUI`'s zeroing).
8. Cascade: `global.device='metaQuest3'` + no origin override → resolves Quest 3; adding an origin override wins; "Use these as my defaults" copies origin→global; scope selector edits `global` directly.
9. Domain keying equals the SW's `extractDomain`: `www.example.com`/`app.example.com` both key `example.com` (via `MSG.STATUS`).
10. Remapping a key in the overlay **crosses worlds via postMessage**, persists to `origins[domain].keymap`, and the panel reflects it via `onChanged` without a render loop. (A test asserts a patch with non-empty `detail`-equivalent survives the world hop.)
11. AI section: install picker swaps command + correct path per client; tool catalog count/names match `contract.ts` `TOOLS` (generated) and shows the `@iwer/extension-bridge` version; no Connect/Allow/Disconnect buttons; status mirror read-only.
12. Non-http inspected tab: panel renders (a)+(c) and the (d)/blocked empty-state without throwing.
13. No-prefs: emulation, overlay, and pairing behave exactly as before (defaults metaQuest3 + living_room).
14. CSP clean: no inline `<script>`/`onclick`/`eval`; all JS bundled.

**Test note:** DevTools panels aren't directly Playwright-automatable — test (a) the **substrate** end-to-end (write `iwe-prefs:v1` via `PREFS_WRITE`, reload a fixture, assert device/env via `page.evaluate`) and (b) the panel **logic** by loading `build/panel.html` as a normal extension page with `chrome.devtools.inspectedWindow` shimmed. Add pure-function unit tests for `prefs.ts` and `onInstalled` gating; a contract-drift test asserting `tool-catalog.generated.json` matches `contract.ts` `TOOLS` and that `protocol.ts` `ALLOWED_METHODS ⊇` the non-browser-host tools. **Prerequisite:** commit a real extension-loading harness (load unpacked from `build/`, persistent context, SW access) — do not cite the untracked `pw-*.mjs` scratch files as the harness.
