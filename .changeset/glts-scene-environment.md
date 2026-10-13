---
'@iwer/sem': minor
'iwer': minor
'@iwer/devui': minor
---

Add GLTS environments: `sem.addEnvironment(id, url)` registers a `.glts` file (a procedural, possibly dynamic three.js scene) that `loadDefaultEnvironment(id)` loads like the built-in captures, and `sem.environments` lists both; the DevUI environment menu now shows that list. Meshes tagged with `userData.xrPlane` / `userData.xrMesh` become XRPlanes / XRMeshes, and the DevUI plane / bounding-box / mesh toggles work for these environments. Like a scanned room on Quest, a GLTS environment also reports its static geometry as one 'global mesh' XRMesh (tag moving objects with `userData.xrGlobalMesh = false`), and hit tests ignore invisible detection proxies. Plane and mesh spaces now follow moving objects, and `lastChangedTime` no longer changes every frame. The iwer `SyntheticEnvironmentModule` interface gains optional `addEnvironment` and `environments` members, so modules without GLTS support still fit. `@drawcall/glts` needs Node 22.18+ to install.
