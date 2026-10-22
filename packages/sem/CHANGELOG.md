# @iwer/sem

## 2.7.0

## 2.6.0

### Minor Changes

- f4e1156: Add eight built-in GLTS rooms to `@iwer/sem` (`sunlit_living_room`, `home_office`, `conference_room`, `open_office`, `kitchen`, `bedroom`, `music_studio`, `open_studio`), each within Quest's 10 x 10 m room-scan limit and reported like a scanned room. `sem.environments` lists them first and `sem.environmentInfo(id)` tells rooms, added environments and legacy scans apart; the DevUI environment menu lists the room captures under "Legacy scans". The iwer `SyntheticEnvironmentModule` interface gains an optional `environmentInfo`. The rooms add about 0.3 MB to the package (2.8 MB packed); apps load only the room they pick.
- 65a4c51: Add GLTS environments: `sem.addEnvironment(id, url)` registers a `.glts` file (a procedural, possibly dynamic three.js scene) that `loadDefaultEnvironment(id)` loads like the built-in captures, and `sem.environments` lists both; the DevUI environment menu now shows that list. Meshes tagged with `userData.xrPlane` / `userData.xrMesh` become XRPlanes / XRMeshes, and the DevUI plane / bounding-box / mesh toggles work for these environments. Like a scanned room on Quest, a GLTS environment also reports its static geometry as one 'global mesh' XRMesh (tag moving objects with `userData.xrGlobalMesh = false`), and hit tests ignore invisible detection proxies. Plane and mesh spaces now follow moving objects, and `lastChangedTime` no longer changes every frame. The iwer `SyntheticEnvironmentModule` interface gains optional `addEnvironment` and `environments` members, so modules without GLTS support still fit. `@drawcall/glts` needs Node 22.18+ to install.

### Patch Changes

- 0b2eba7: Fix room understanding for the built-in captures: `XRPlane.orientation` now follows the plane's normal (screens were reported as horizontal) and updates, with `lastChangedTime`, when a plane turns between horizontal and vertical, captured planes report normals facing into the room (they pointed out of it, so floors faced down), and office_large's room mesh is reported as 'global mesh'. `@iwer/sem` also ships each capture once instead of four times (no JSON copies in `lib/`, and the prebuilt bundles fetch captures instead of embedding them), shrinking the package from 7.4 MB to 2.5 MB.

## 2.5.0

### Patch Changes

- 8f8dbf5: Correct synthetic depth decoding for small near clip planes and render
  environment depth from both sides so one-sided room surfaces occlude from
  either viewing direction.

## 2.4.0

### Minor Changes

- Versioned in lockstep with `iwer` 2.4.0; no package-specific behavior changes.

## 2.3.0

### Minor Changes

- Add typed environment loading with an `environmentchange` event.
- Make `loadDefaultEnvironment()` awaitable and reject when loading fails.
- Use deterministic per-entity material colors for stable synthetic-environment
  rendering and debugging.

### Patch Changes

- Improve SEM hit testing to raycast planes and boxes in addition to meshes.
- Use `Uint32Array` mesh indices when triangle meshes exceed 65k vertices.
- Tear down the prior native entity when replacing an entity with a duplicate
  UUID.
- Reduce allocation churn by reusing scratch color state and avoiding an
  unnecessary triangle-mesh array round trip.
- Improve package hygiene with pnpm monorepo support, clean builds, generated
  version stamping, `sideEffects: false`, and removal of unused generated
  protobuf output from the published build.
