---
'iwer': minor
---

Host mode: `new XRDevice(config, { host })` with an `XRHostBackend` lets a native XR runtime drive IWER. The host calls `device.runHostFrame(frame)` once per displayed frame with that frame's predicted time, per-eye poses and asymmetric fields of view, and the swapchain image to render into; IWER runs the page's XR callbacks (and, through the backend, the window's animation frame) before returning. The device creates no DOM and emulates no headset pose.

- Rendering: `XRWebGLLayer` renders side by side into the host's swapchain, and `XRWebGLBinding.createProjectionLayer` (texture or texture-array) gives three.js real projection layers; `renderState.layers`, fixed foveation and `passthroughFullyObscured` are supported.
- Reference spaces: `local`, `local-floor` and `bounded-floor` (`XRBoundedReferenceSpace` with the stage outline) follow the host's spaces; a host recentre fires `reset` on requested and offset spaces. `getOffsetReferenceSpace` accepts an `XRRigidTransform`.
- Frame rate (`updateTargetFrameRate`, `frameratechange`), visibility, plane and mesh detection from the host, and `XRSession.trackedSources`.
- Exceptions thrown during a host frame go to `XRHostBackend.reportError` with their source (`xr-frame-callback`, `window-frame`, `layer`, `host-hook`); the other callbacks still run.
- A required feature the device lacks now rejects `requestSession` with a `NotSupportedError` DOMException.
