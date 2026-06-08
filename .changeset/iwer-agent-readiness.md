---
'iwer': minor
'@iwer/devui': minor
'@iwer/sem': minor
---

feat: agent-readiness features for programmatic control

- RemoteControlInterface: world/scene queries (get_world_state, get_objects), set_hand_pose, a runtime capability manifest (listMethods()/describe()), an opt-in transport bridge (connectTransport), a tainted-canvas error for capture_canvas, and a fix for get_session_status reporting sessionMode undefined.
- ActionRecorder.getRecording()/toJSON() expose recordings programmatically (with the recording type exported); ActionPlayer gains seek()/stepFrames()/duration/currentTime, a loop flag, a playbackRate, and optional select/squeeze event dispatch during playback.
- index.ts exports the Meta controller configs + config types and a new generic-trigger-squeeze-thumbstick controller config; haptics are wired through (working stub GamepadHapticActuators + non-null vibrationActuator).
- XRDevice.installRuntime gains uninstallRuntime(), native-XR detection (isNativeXRAvailable / forceInstall), WebGL1 makeXRCompatible, a configurable userAgent override, and tighter add-on types.
- @iwer/sem: typed loadEnvironment with an 'environmentchange' event, awaitable loadDefaultEnvironment that rejects on failure, and deterministic per-entity material colors.
