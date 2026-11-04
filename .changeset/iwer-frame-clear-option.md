---
'iwer': minor
---

Add `XRDevice.frameClearEnabled` (also an `XRDeviceOptions` field) to turn off the per-frame base-layer clear in immersive sessions. It defaults to `true`, so behavior is unchanged unless a host opts out, for example a headless automation browser that draws only on demand.
