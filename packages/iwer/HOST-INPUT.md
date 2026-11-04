# Host input: driving IWER's input sources from real tracking

A host (for example the iwer-native Android/OpenXR runtime) can replace IWER's
emulated controllers and hands with real tracking data. `enableHostInput`
gives the host one state object for the left side and one for the right;
they are created once and live as long as host input is on. Before each XR
frame the host writes the latest tracking and button values into them, and
IWER derives the `XRInputSource`s, gamepads, hand joints,
`inputsourceschange` and select/squeeze events from what it reads there. The emulated controllers and
hands (`device.controllers`, `device.hands`) are left alone and unused while
host input is on.

## Enabling

```ts
import { XRDevice, metaQuest3, XRHostInputMode } from 'iwer';

const device = new XRDevice(metaQuest3);
const input = device.enableHostInput({
  leftMenuButton: true, // default: the left controller gamepad gets 'menu' at index 7
  onHaptic: (handedness, intensity, durationMs, frequencyHz) => {
    nativeVibrate(
      handedness === 'left' ? 0 : 1,
      intensity,
      durationMs / 1000,
      frequencyHz,
    );
  },
});

// Every XR frame, before IWER runs the frame:
const l = input.left; // XRHostInputState, also input.right / input.get('left')
l.mode = XRHostInputMode.Controller;
l.targetRay.set(record.subarray(aimOffset, aimOffset + 7)); // px py pz qx qy qz qw
l.targetRayValid = true;
l.grip.set(record.subarray(gripOffset, gripOffset + 7));
l.gripValid = true;
l.buttonValues[0] = triggerValue; // gamepad index order
l.buttonPressed[0] = triggerPressed ? 1 : 0;
l.buttonTouched[0] = triggerTouched ? 1 : 0;
l.axes[2] = stickX; // WebXR sign: +x right, +y down (toward the user)
l.axes[3] = stickY;
```

`device.hostInput` returns the `XRHostInput` (or `null`), and
`device.disableHostInput()` returns the device to its emulated inputs. The
state objects live as long as the `XRHostInput`; keep references to them.

## Coordinates

Every pose is in IWER's global space (the device's `GlobalSpace`, the root of
all of IWER's spaces). A host that reports poses in its own base space (the
OpenXR STAGE or LOCAL space) must make IWER's global space coincide with that
base space; that mapping belongs to the core host backend, not to input.
Positions are metres; orientations are unit quaternions `x y z w`.

## `XRHostInputState`

| field            | type                                                   | meaning                                                             |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `mode`           | `XRHostInputMode` (`None` 0, `Controller` 1, `Hand` 2) | which source this hand shows this frame                             |
| `targetRay`      | `Float32Array(7)`                                      | target ray (aim) pose                                               |
| `targetRayValid` | `boolean`                                              | false: `getPose(targetRaySpace, …)` is `null`                       |
| `grip`           | `Float32Array(7)`                                      | grip pose                                                           |
| `gripValid`      | `boolean`                                              | false: the grip falls back to the palm for a hand, else `null`      |
| `palm`           | `Float32Array(7)`                                      | palm pose (hands only; OpenXR `XR_HAND_JOINT_PALM_EXT`)             |
| `palmValid`      | `boolean`                                              | the palm stands in for the grip of a hand when `gripValid` is false |
| `buttonValues`   | `Float32Array(10)`                                     | button values, gamepad index order                                  |
| `buttonPressed`  | `Uint8Array(10)`                                       | 1 pressed                                                           |
| `buttonTouched`  | `Uint8Array(10)`                                       | 1 touched (pressed implies touched)                                 |
| `axes`           | `Float32Array(4)`                                      | gamepad axes; controllers only                                      |
| `joints`         | `Float32Array(25 * 8)`                                 | WebXR joints, `XRHandJoint` order: `px py pz qx qy qz qw radius`    |
| `jointValid`     | `Uint8Array(25)`                                       | 1 tracked                                                           |

Constants exported next to the class: `HOST_INPUT_BUTTONS = 10`,
`HOST_INPUT_JOINTS = 25`, `HOST_INPUT_JOINT_STRIDE = 8`,
`HOST_INPUT_POSE_STRIDE = 7`.

From OpenXR `XR_EXT_hand_tracking` (26 joints, PALM first): WebXR joint `i` is
OpenXR joint `i + 1`, and OpenXR joint 0 is the palm. The joint axis
conventions of the two specs are the same, so poses pass through unchanged.

## Gamepads

Controller (`mapping: 'xr-standard'`; profiles and button layout from the
device config's controller config, for example `meta-quest-touch-plus,
oculus-touch-v3, oculus-touch, generic-trigger-squeeze-thumbstick` with
`metaQuest3`; `controllerConfig` in the options overrides it):

| index  | 0                | 1                 | 2     | 3          | 4     | 5     | 6         | 7                                  |
| ------ | ---------------- | ----------------- | ----- | ---------- | ----- | ----- | --------- | ---------------------------------- |
| button | trigger (select) | squeeze (squeeze) | empty | thumbstick | x / a | y / b | thumbrest | menu (left only, `leftMenuButton`) |

Axes: `[touchpad x, touchpad y, thumbstick x, thumbstick y]`, all numbers;
the touchpad pair reads whatever the host writes (0 on Touch controllers).

Hand (`mapping: 'xr-standard'`, no axes, profiles `oculus-hand, generic-hand,
generic-hand-select, generic-trigger`; the layout IWER already emulates as
Quest Browser's):

| index  | 0                    | 1-3   | 4    | 5          | 6           | 7             | 8              | 9   |
| ------ | -------------------- | ----- | ---- | ---------- | ----------- | ------------- | -------------- | --- |
| button | index pinch (select) | empty | menu | swipe-left | swipe-right | swipe-forward | swipe-backward | tap |

State slots that map to an empty button (controller 2, hand 1-3) are ignored.

## Per-frame semantics

- IWER reads the states at the start of each frame (inside the device's frame
  start, before the session's `requestAnimationFrame` callbacks). Writes made
  during a frame apply to the next one.
- Buttons are taken verbatim: the host decides `pressed` (its own thresholds
  and hysteresis); IWER does not threshold host values. A change of `pressed`
  on a button with an event trigger fires `selectstart` on press and `select`
  then `selectend` on release (the trigger and the index pinch select; the
  squeeze squeezes).
- A source's buttons never fire a press on the frame the source appears: a
  trigger already held when a controller is picked up reports `selectstart`
  on the next frame, after `inputsourceschange` announced the source.
- Changing `mode` swaps the listed source on that frame: one
  `inputsourceschange` with the old source in `removed` and the new one in
  `added`. A press still held on the removed source ends with `selectend` (or
  `squeezeend`) alone, as IWER already does for removed sources.
- Hand sources are listed only when the session enabled `hand-tracking`;
  `mode = Hand` without it lists nothing for that hand.
- When the device's visibility is not `visible`, no host source is listed
  (sources are removed silently and come back without a click).
- Untracked spaces: `XRFrame.getPose` returns `null` for an untracked target
  ray, grip or joint (as space or base space); `getJointPose` returns `null`;
  `fillPoses` writes NaN for it and returns `false`; `fillJointRadii` writes
  NaN and returns `false`. Host spaces report `emulatedPosition: false`.
- `gamepad.timestamp` is the frame's `predictedDisplayTime`.
- A new session primes every source again (no click carried across sessions).

## Haptics

`gamepad.hapticActuators[i].pulse(value, duration)` and
`gamepad.vibrationActuator.playEffect('dual-rumble' | 'trigger-rumble',
params)` on a host controller call
`onHaptic(handedness, intensity, durationMs, frequencyHz)` with intensity
clamped to 0..1 and `frequencyHz = 0` (the runtime's default). If `onHaptic`
returns a promise, `pulse` resolves with its value (`playEffect` with
`'complete'`); otherwise `pulse` resolves `true` at once. Hands have no
actuators.

## Allocation

In steady state (no mode change, no button edge) a frame allocates nothing on
this path: the state objects, sources, gamepads, joint spaces and the listed
sources array are built once, and the session skips its input-source diff
while the host's list is unchanged. Mode changes and events allocate (event
objects, the added/removed arrays).
