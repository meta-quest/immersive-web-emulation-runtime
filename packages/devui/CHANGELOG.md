# @iwer/devui

## 2.6.0

### Minor Changes

- f4e1156: Add eight built-in GLTS rooms to `@iwer/sem` (`sunlit_living_room`, `home_office`, `conference_room`, `open_office`, `kitchen`, `bedroom`, `music_studio`, `open_studio`), each within Quest's 10 x 10 m room-scan limit and reported like a scanned room. `sem.environments` lists them first and `sem.environmentInfo(id)` tells rooms, added environments and legacy scans apart; the DevUI environment menu lists the room captures under "Legacy scans". The iwer `SyntheticEnvironmentModule` interface gains an optional `environmentInfo`. The rooms add about 0.3 MB to the package (2.8 MB packed); apps load only the room they pick.
- 65a4c51: Add GLTS environments: `sem.addEnvironment(id, url)` registers a `.glts` file (a procedural, possibly dynamic three.js scene) that `loadDefaultEnvironment(id)` loads like the built-in captures, and `sem.environments` lists both; the DevUI environment menu now shows that list. Meshes tagged with `userData.xrPlane` / `userData.xrMesh` become XRPlanes / XRMeshes, and the DevUI plane / bounding-box / mesh toggles work for these environments. Like a scanned room on Quest, a GLTS environment also reports its static geometry as one 'global mesh' XRMesh (tag moving objects with `userData.xrGlobalMesh = false`), and hit tests ignore invisible detection proxies. Plane and mesh spaces now follow moving objects, and `lastChangedTime` no longer changes every frame. The iwer `SyntheticEnvironmentModule` interface gains optional `addEnvironment` and `environments` members, so modules without GLTS support still fit. `@drawcall/glts` needs Node 22.18+ to install.

## 2.5.0

### Minor Changes

- 57c1b41: Add continuous gaze input emulation to the full and native WebXR runtimes,
  including an additive native gaze-only mode, gaze-plus-pinch DevUI controls,
  gaze-aware remote-control contracts, and native session-offer interception so
  gaze remains attached across automatic re-entry and page reloads.
- 9ae262f: Add a measured Meta VR Glasses field-of-view mask for desktop XR testing, an in-page
  DevUI comparison toggle, and persistent per-site and all-sites browser-extension
  controls.

## 2.4.0

### Minor Changes

- Versioned in lockstep with `iwer` 2.4.0; no package-specific behavior changes.

## 2.3.0

### Minor Changes

- Add the preference bridge used by browser-extension shells to seed and persist
  DevUI-controlled settings without importing private component modules.
- Export `DEFAULT_KEYMAP`, `useKeyMapStore`, and preference postMessage helpers.
- Emit storage-agnostic preference patches for keymap, input mode, FOV,
  environment, hand pose, and saved default pose interactions.

### Patch Changes

- Fix pointer-lock cleanup and reduce render churn in the live control overlay.
- Clear the offer-session interval on disposal and avoid listener leaks.
- Reduce transform-sync allocations by reusing shared quaternion scratch state.
- Keep the hidden offer-session/Enter XR control fully outside unsupported
  pages until a session is actually offered.
