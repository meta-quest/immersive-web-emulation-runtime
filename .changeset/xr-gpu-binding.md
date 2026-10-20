---
'iwer': minor
---

Add WebGPU support through the WebXR/WebGPU binding. Immersive sessions can request the `'webgpu'` feature when the browser can provide a WebGPU adapter, and `XRGPUBinding` creates a projection layer that IWER draws to the page, so WebGPU apps such as three.js `WebGPURenderer` can enter XR without a native `XRGPUBinding`. Only a single projection layer is emulated; WebGL sessions are unchanged.
