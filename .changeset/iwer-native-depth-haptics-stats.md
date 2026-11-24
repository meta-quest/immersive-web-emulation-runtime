---
'iwer': patch
'@iwer/native': patch
---

WebXR depth, haptics and stats fixes from the native APK device matrix.

- iwer: `session.depthUsage` and `session.depthDataFormat` throw `InvalidStateError` on a session without 'depth-sensing' (WebXR Depth Sensing), in the emulator and in host mode; before, they returned a usage and format (the first preference, or 'cpu-optimized' / 'float32') that the session did not have. `XRFrame.getDepthInformation()` throws `InvalidStateError` on a session whose `depthUsage` is not 'cpu-optimized' (it returned null on 'gpu-optimized' sessions) and outside an animation frame callback. `XRFrame.getDepthInformation()` and `XRWebGLBinding.getDepthInformation()` throw `NotSupportedError` instead of `InvalidStateError` when 'depth-sensing' is not enabled, as the spec and Chromium do.
- iwer: `GamepadHapticActuator.effects` (`gamepad.vibrationActuator.effects`) lists `['dual-rumble', 'trigger-rumble']`, the effect types `playEffect()` plays (it had none). A 'trigger-rumble' effect now pulses at the strongest magnitude given, `leftTrigger` and `rightTrigger` included.
- @iwer/native: a required 'depth-sensing' the headset cannot serve in the usage or data format asked for (for example `usagePreference: ['cpu-optimized']`) rejects with a `NotSupportedError` that names the feature, the preference and what the headset offers, instead of IWER's generic "One or more required features are not supported by the device.".
- @iwer/native: a rejected `offerSession()` is logged once; the grant (auto-grant or `grantSession()`) no longer logs the same rejection a second time as `requestSession()`, and does not ask for permissions a second time.
- @iwer/native: when a permission denial drops optional features, one warning line names them and the permission they need.
- @iwer/native: the debug endpoint's `stats` reports the live worker count as top-level `workers` (it was always 0) and the display refresh rate as top-level `refreshRate` (it was always null), and always has `blockedOrigins`, the network origins blocked this session (`[]` when none; the key was missing).
