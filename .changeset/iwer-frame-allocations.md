---
'iwer': patch
'@iwer/devui': patch
'@iwer/sem': patch
---

perf: cut per-frame allocations across the frame loop, inputs, action replay, and SEM

- XRSpace.calculateGlobalOffsetMatrix is iterative (no mat4 allocation per ancestor level); XRFrame.getPose/getViewerPose/fillPoses reuse scratch and hoisted constants.
- Gamepad caches its buttons array and reuses its axes array (read every frame); XRDepthInformation builds its typed-array view once.
- XRSession reads performance.now() once per frame, precomputes enabled-feature flags, caches supportedFrameRates, reuses the GPU-depth flip buffer, and tears down per-session state on end(); XRDevice.updateViews runs once per frame with scratch vectors and caches viewports; XRSystem's end listener is { once: true }.
- ActionRecorder gains frameCount/durationMs and optional recording caps and uses scratch buffers (serialized format unchanged); ActionPlayer reuses per-frame maps and merge scratch.
- DevUI fixes a dispose() listener leak, clears the offer-session interval, and reduces React/render churn; SEM reuses a scratch Color and avoids a TriangleMesh array round-trip.
