---
'iwer': minor
---

Host input: a native host can drive IWER's input sources from real tracking. `device.enableHostInput(options)` returns an `XRHostInput` with one `XRHostInputState` per hand (typed arrays the host rewrites before every frame: mode, target ray, grip, palm, buttons, axes, 25 hand joints). IWER derives the `XRInputSource`s, gamepads, hand joints, `inputsourceschange` and select/squeeze events from it; `disableHostInput()` returns to the emulated controllers and hands. See `HOST-INPUT.md` for the contract.

- `XRFrame.getPose` and `getJointPose` return `null` for a space that is not tracked (as in the WebXR IDL); `fillPoses` and `fillJointRadii` write NaN for it and return `false`. `getPose` is now typed `XRPose | null`.
- Gamepad haptics: `GamepadHapticActuator.pulse` reaches the host through `onHaptic`; `playEffect('dual-rumble' | 'trigger-rumble')` and `reset()` are added.
