---
'iwer': minor
'@iwer/sem': minor
---

Add `XRDevice.shouldDrawEnvironment` (also an `XRDeviceOptions` field) so a host can skip drawing the synthetic environment on frames it does not need. IWER calls it once per immersive-ar frame, after the app's frame callbacks; returning `false` skips that frame's environment draw while the environment keeps updating. It defaults to `null`, which draws every frame. `@iwer/sem` now splits `render()` into `update()` and `draw()`, which IWER calls before and after the app's callbacks; `render()` still does both.
