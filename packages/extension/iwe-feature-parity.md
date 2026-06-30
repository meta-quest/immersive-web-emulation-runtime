# Feature-Parity Report: Classic IWE v1.5.0 vs. Current 2.0 Stack

> Baseline: classic IWE **v1.5.0** (`github.com/meta-quest/immersive-web-emulator` @ `7abf503a42ac9d235351ca84d5bf9f3e06bb65de`, the last full DevTools-panel version before the 2.0 rewrite). Current = our extension (thin shell + MCP bridge) + workspace `@iwer/devui` / `@iwer/sem` / `iwer` 2.3.0.

## 1. Executive Summary

The public `meta-quest/immersive-web-emulator` `main` (2.0) is a **thin shell** (only `src/index.ts` + `service-worker.ts`) — byte-identical in concept to our extension's base. It injects `iwer` + `@iwer/devui` + `@iwer/sem`; **every user-facing emulator feature now lives in those libraries**. The 2.0 rewrite collapsed the classic DevTools "WebXR" panel into an in-page DevUI overlay and **dropped a class of capabilities** — most importantly, all preference persistence.

**Most important gaps (classic could, we cannot):**

1. **No preference persistence of any kind.** Classic persisted ~11 fields to one global `chrome.storage.local` key (`emulatorStates.js:12,126-146`). Our stack persists nothing user-facing (only WebXR anchors at `iwer/src/anchors/XRAnchor.ts:50-104`). Every reload resets device, pose, key bindings, environment, input mode, FOV.
2. **No device/headset model picker.** Classic: 6-model dropdown persisted as `deviceKey`. Ours **hardcodes `metaQuest3`** (`immersive-web-emulator/src/index.ts:8,19`); no picker, no runtime swap.
3. **No persisted custom key bindings (confirmed the suspicion).** `useKeyMapStore` is in-memory zustand, no persist (`devui/src/components/mapper.tsx:18-76`); resets to `DEFAULT_KEYMAP` every load.
4. **No "save as default pose" / pose memory.** Classic persisted `defaultPose`; our Reset only restores construction defaults (`devui/src/scene.ts:271-285`).
5. **No persisted environment/scene selection.** Shell hardcodes `living_room.json` (`index.ts:13,25`); the 5-scene switcher resets on reload.
6. **No environment authoring.** Classic could create/delete/show-hide planes & meshes with 15 semantic labels (`inspector.jsx:239-374`); SEM only _loads_ prebuilt captures.
7. **Enabled-domain state isn't durable.** Lives in `chrome.scripting` with `persistAcrossSessions:false` (`service-worker.ts:44-99`); the declared `storage` permission is never used for `.local`/`.sync`.
8. **DevTools-panel → overlay tradeoffs** (lost the standalone orbit inspector + numeric transform tabs; gained immediacy).

**Counterweight — we're well ahead as a runtime:** agent/MCP control through the extension, real AR/MR synthetic environments (planes/meshes/anchors/hit-test/depth), WebXR persistent anchors, deterministic action record/replay API, newer device profiles. Classic had **no recording/replay** at all. The 2.0 architecture regressed only on _persisted UX_.

## 2. Parity matrix

### Headset / Transform

| Feature                                    | Classic v1.5.0               | Current                                           | Where                                            | Notes                                        |
| ------------------------------------------ | ---------------------------- | ------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Device-type select (6 models)              | Yes, persisted `deviceKey`   | **Absent**                                        | iwer configs exist; needs DevUI picker + persist | shell hardcodes metaQuest3 (`index.ts:8,19`) |
| Stereo toggle                              | Yes, persisted `stereoOn`    | **Partial** (API/remote only; DevUI forces ipd=0) | `XRDevice.stereoEnabled`                         | not surfaced/persisted                       |
| Headset 6DoF pose (drag/fly)               | orbit drag                   | **Present** (WASD + pointer-lock)                 | `devui/scene.ts:27-269`                          | better; not persisted                        |
| FOV-Y                                      | —                            | **Present (net-new)**                             | `headset.tsx:90-168`                             | in-memory                                    |
| IPD                                        | —                            | **Present (net-new, API)**                        | `XRDevice.ipd`                                   | DevUI forces 0                               |
| Exit immersive                             | Yes                          | **Present**                                       | `header.tsx:205-213`                             | on par                                       |
| Trigger auto-fire (slow/normal/fast/turbo) | Yes, persisted `triggerMode` | **Absent**                                        | devui + iwer                                     | no turbo/repeat anywhere                     |
| Settings gear (clear pose/all, version)    | Yes                          | **Partial** (About panel; nothing to clear)       | `header.tsx:224-243`                             |                                              |

### Controllers

| Feature                                                                                   | Classic | Current                                    | Notes                                                                               |
| ----------------------------------------------------------------------------------------- | ------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Thumbstick button, analog trigger/grip+slider, A/B/X/Y, numeric pos/rot, transform gizmos | Yes     | **Present**                                | `joystick.tsx`, `analog.tsx`, `binary.tsx`, `controller.tsx`+`vec3.tsx`, `scene.ts` |
| Button press modes (touch/momentary/sticky-hold)                                          | 3 modes | **Partial** (Press 250ms/Touch/Hold-latch) | `binary.tsx:31-139`; semantics differ slightly                                      |
| Controller Hide                                                                           | Yes     | **Present** (connect/disconnect)           | `controller.tsx:147-181`                                                            |
| Haptics                                                                                   | —       | **Present (net-new, API)**                 | `Gamepad.ts:86-117`; no UI                                                          |

### Hands

| Feature                               | Classic                    | Current                                                        | Notes                                                 |
| ------------------------------------- | -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| Input-mode switch                     | persisted `inputMode`      | **Partial** (not persisted)                                    | `header.tsx:140-156`                                  |
| Hand pose presets                     | 2 poses persisted per hand | **Partial** (cycles `['default','point']` only, not persisted) | `pose.tsx:33`; iwer supports custom via config, no UI |
| Pinch + slider, Hide, numeric pos/rot | Yes                        | **Present**                                                    | `pinch.tsx`, `hand.tsx`                               |

### Gamepad / Joystick

| Feature                        | Classic                   | Current                           | Notes                 |
| ------------------------------ | ------------------------- | --------------------------------- | --------------------- |
| Joystick 2D widget + axes      | Yes, sticky/auto-return   | **Partial** (fixed knob behavior) | `joystick.tsx:99-371` |
| Joystick sticky toggle + reset | Yes                       | **Absent**                        |                       |
| Physical gamepad polling       | Dead in classic (unwired) | **Absent**                        | non-regression        |

### Keyboard

| Feature                      | Classic                     | Current                                | Notes                                    |
| ---------------------------- | --------------------------- | -------------------------------------- | ---------------------------------------- |
| Action-mapping master toggle | persisted `actionMappingOn` | **Partial** (play mode; not persisted) |                                          |
| Key bindings                 | **Fixed, not remappable**   | **Present+ (fully remappable!)**       | `mapper.tsx:90-180` — we're better       |
| Persisted custom bindings    | N/A                         | **Absent**                             | **the headline gap** — resets every load |

### Poses

| Feature              | Classic                 | Current     | Notes                          |
| -------------------- | ----------------------- | ----------- | ------------------------------ |
| Save-as-default pose | persisted `defaultPose` | **Absent**  | `scene.ts:271-285` + persist   |
| Reset pose           | Yes                     | **Present** | restores construction defaults |
| Named pose library   | No                      | **Absent**  | net-new opportunity            |

### Recording / Session-player

| Feature                | Classic                       | Current                            | Notes                                                    |
| ---------------------- | ----------------------------- | ---------------------------------- | -------------------------------------------------------- |
| Record / replay / seek | **Absent** (only unused flag) | **Present/Partial (net-new, API)** | `ActionRecorder.ts`, `ActionPlayer.ts`; **no UI/remote** |

### Environment

| Feature                                                       | Classic                         | Current                        | Notes                                                     |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------ | --------------------------------------------------------- |
| Room dimension editor                                         | persisted `roomDimension`       | **Absent**                     |                                                           |
| Create plane / mesh (+15 semantic labels)                     | persisted `userObjects`         | **Absent** (SEM only loads)    | `inspector.jsx:239-374`                                   |
| Delete / show-hide object                                     | per-object                      | **Partial** (group-level only) | `sem.ts:116-138`                                          |
| Synthetic AR/MR scenes, hit-test, depth, plane/mesh detection | **Absent**                      | **Present (net-new)**          | `sem.ts`, `iwer/hittest`, `iwer/depth` — we're well ahead |
| 3D orbit inspector                                            | standalone scene + raycast pick | **Partial** (overlay preview)  | `scene.ts`                                                |

### Settings / Transport / Persistence

| Feature                         | Classic                      | Current                                                          | Notes                     |
| ------------------------------- | ---------------------------- | ---------------------------------------------------------------- | ------------------------- |
| Per-origin polyfill disable     | `polyfillExcludes` (opt-out) | **Present (different shape)** per-domain opt-in, **not durable** | `service-worker.ts:44-99` |
| Global settings blob            | Yes                          | **Absent**                                                       | we persist no prefs       |
| Per-origin/per-page preferences | **No** (classic was global)  | **Absent**                                                       | genuinely new for both    |
| Popup "send page to device"     | Yes                          | **Dropped** (popup is now agent-pairing)                         | low value                 |
| Agent/MCP remote control        | **Absent**                   | **Present (net-new)**                                            | MCP bridge           |
| WebXR persistent anchors        | **Absent**                   | **Present (net-new)**                                            | `XRAnchor.ts:50-104`      |

## 3. Persistence & per-page/per-origin preferences (deep dive)

**Classic** stored everything in ONE global `chrome.storage.local` key `immersive-web-emulator-settings` (`emulatorStates.js:12`, double-encoded JSON). Fields: `stereoOn, actionMappingOn, defaultPose, deviceKey, keyboardMappingOn, roomDimension, polyfillExcludes, inputMode, handPoses, userObjects, triggerMode`. **Scope = global across all sites** (changing device on site A changed it on B). The **only** origin-aware datum was `polyfillExcludes` (a per-origin _off-switch_). The content-script `load()`s on every page and replays via CustomEvents (`content-script.js:182-202`).

**Current:** effectively nothing user-facing. DevUI = zero storage (all in-memory zustand/React). iwer/sem = only WebXR persistent anchors (`XRAnchor.ts:50-104`). Extension = only `chrome.storage.session` keys `pairing`/`connected` (`service-worker.ts:28-34`); enabled domains are `persistAcrossSessions:false`. The shell re-hardcodes device + environment every injection (`index.ts:13,19,25`).

**Definitive answer:** No — we cannot save per-page/per-origin preferences today, and we persist no preferences at all. Two asks: (1) **restore parity** (persist prefs across reloads — classic had global), (2) **exceed** (make it **per-origin**, new for both).

**Design (per-origin persistence):** owner = the **extension** (owns `chrome.storage`, survives MAIN-world resets, already keys by domain). Keep DevUI/iwer stateless; the shell hydrates them.

- Storage: `chrome.storage.local` key `iwe-prefs:v1` = `{ global: {...}, origins: { "<eTLD+1>": { device, stereoEnabled, inputMode, keymap, fovy, ipd, handPoses, defaultPose, environment, visibility } } }` (key by eTLD+1 via existing `tldts`).
- Save: DevUI emits a debounced `prefschange` CustomEvent (extend the `environmentchange` pattern in `sem.ts:171-218`) → ISOLATED content-bridge → SW writes storage. No token/secret involved (plain prefs).
- Restore: at `document_start` before `injectRuntime()`, content-bridge reads prefs → `window.__IWE_PREFS__`; `injectRuntime()` picks `new XRDevice(prefs.device ?? metaQuest3)` (lift the hardcode), `sem.loadDefaultEnvironment(prefs.environment)`, and seeds DevUI stores from prefs instead of `DEFAULT_KEYMAP`.
- DevUI: add optional initial-state params + emit-on-change to `useKeyMapStore`/`useInputModeStore`/FOV/pose; keep storage-agnostic.
- Pose: re-add "Save as default pose" (classic `pose.jsx:22-33`); Reset restores from prefs.

Effort: **Medium** (hardest part is threading initial-state + change events into DevUI stores; the SW/storage side reuses existing domain-keying + content-bridge).

## 4. Prioritized roadmap (reach, then exceed, parity)

| #   | Item                                                                                                                                               | Packages                       | Effort  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- |
| 1   | **Per-origin preference persistence framework** (chrome.storage.local keyed by eTLD+1; SW read/write; `prefschange` emit + document_start hydrate) | extension + devui              | **M**   |
| 2   | **Durable enabled-domains** (persistAcrossSessions / mirror to storage)                                                                            | extension                      | **S**   |
| 3   | **Persist keymap + input mode** (seed stores from prefs)                                                                                           | devui                          | **S**   |
| 4   | **Device/headset picker + persist** (DevUI dropdown; runtime swap; lift hardcode)                                                                  | devui + iwer + extension       | **M**   |
| 5   | **Environment picker persist + custom-JSON load + remote method**                                                                                  | sem + devui + iwer + extension | **S–M** |
| 6   | **Save-as-default pose + persist**                                                                                                                 | devui + extension              | **S**   |
| 7   | **Surface stereo/IPD/FOV toggles + expand hand-pose cycle; persist**                                                                               | devui + extension              | **S**   |
| 8   | **Trigger auto-fire/turbo mode**                                                                                                                   | devui + iwer                   | **S**   |
| 9   | **Joystick sticky/auto-return + per-button mode parity**                                                                                           | devui                          | **S**   |
| 10  | **Recording/replay UI + remote methods** (surface existing engine)                                                                                 | iwer + devui                   | **M**   |
| 11  | **Environment authoring** (create/delete/show-hide planes & meshes, labels, room dims)                                                             | sem + devui + extension        | **L**   |
| 12  | (Optional) DevTools-panel mode alongside overlay                                                                                                   | extension + devui              | **L**   |

**Recommended first sprint:** #1 + #2 + #3 — the persistence foundation, durable domains, keymap persistence. Resolves the headline concern; everything else layers on cheaply.

Source anchors: `immersive-web-emulator/src/index.ts:8,13,19,25`; `service-worker.ts:44-99`; `packages/devui/src/components/mapper.tsx:18-76`; `packages/devui/src/index.tsx`; `packages/devui/src/scene.ts:271-285`; `packages/sem/src/sem.ts:171-262`; `packages/iwer/src/device/XRDevice.ts:817-845`; `packages/iwer/src/anchors/XRAnchor.ts:50-104` (the one persistence pattern to mirror).
