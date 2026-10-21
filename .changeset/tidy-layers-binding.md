---
'iwer': patch
---

Preserve the WebXR layers polyfill's XRWebGLBinding API alongside GPU depth sensing when polyfillLayers is enabled. Restore application WebGL state around the polyfill's rendering passes so layers do not break subsequent frames.
