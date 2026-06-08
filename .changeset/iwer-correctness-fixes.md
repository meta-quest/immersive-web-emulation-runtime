---
'iwer': patch
'@iwer/devui': patch
'@iwer/sem': patch
---

fix: correct session lifecycle, action playback, remote-control, and scene bugs

- XRSession.end() now sets the `ended` flag and clears the device frame handle, so a second end() no longer re-runs teardown and post-end rAF/updateRenderState behave per spec.
- updateRenderState/XRRenderState merges use nullish coalescing so a legitimate `0` (e.g. inlineVerticalFieldOfView) is no longer dropped.
- ActionPlayer no longer crashes on single-frame recordings or reads past the end of a recording, and validates recorded gamepad data up front.
- RemoteControlInterface: queued actions time out instead of hanging forever when the render loop stalls; dispatch() no longer mutates the caller's params; device transforms are validated and applied atomically (no NaN/half-applied poses); gamepad success counts reflect values actually applied; forceRelease also resets hand pinch, thumbsticks, and the full button set; the `select` default duration is a single shared constant.
- @iwer/sem: triangle-mesh geometry indices use Uint32 when needed (no silent truncation for >65k-vertex meshes) and replacing an entity with a duplicate uuid tears down the prior native entity.
- DevUI: removed dead Map iteration in the pointer-lock handler and hoisted a shared quaternion-inverse scratch in syncFromDevice.
