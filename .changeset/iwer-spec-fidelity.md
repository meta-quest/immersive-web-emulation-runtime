---
'iwer': patch
'@iwer/sem': patch
---

fix: tighten WebXR spec fidelity for transforms, depth, hit-test, and event handlers

- XRRigidTransform builds its position/orientation DOMPointReadOnly once and returns cached instances (stable reference-equality, no per-read allocation).
- XRCPUDepthInformation exposes the spec `dataFormat` getter.
- XRWebGLBinding.getDepthInformation throws InvalidStateError on inactive frame / depth-sensing disabled / non-gpu-optimized usage instead of silently returning null.
- XRSession and XRReferenceSpace event-handler getters return the backing handler (null when unset) instead of a freshly-allocated noop, so `if (session.onend)` round-trips.
- XRHitTestOptionsInit.offsetRay is optional and gains entityTypes; SEM hit-testing now raycasts planes and boxes in addition to meshes.
