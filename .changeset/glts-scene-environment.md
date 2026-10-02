---
'@iwer/sem': minor
'iwer': minor
'@iwer/devui': minor
---

Add GLTS environments: `sem.addEnvironment(id, url)` registers a `.glts` file (a procedural, possibly dynamic three.js scene) that `loadDefaultEnvironment(id)` loads like the built-in captures, and `sem.environments` lists both; the DevUI environment menu now shows that list. Meshes tagged with `userData.xrPlane` / `userData.xrMesh` become XRPlanes / XRMeshes, and the DevUI plane / bounding-box / mesh toggles work for these environments. Plane and mesh spaces now follow moving objects, and `lastChangedTime` no longer changes every frame. The iwer `SyntheticEnvironmentModule` interface gains `addEnvironment` and `environments`.
