---
'iwer': minor
'@iwer/devui': patch
'@iwer/extension-bridge': patch
---

Select and squeeze events follow the WebXR order: `selectstart` on press, then `select` and `selectend` on release (previously `select` fired with `selectstart` on press). The emulated runtime, the native override and ActionPlayer replays share one button-edge path, so the gamepad `pressed` flag and the events always change on the same frame.

Behaviour changes:

- A hand selects when its pinch reaches 0.9 and lets go at 0.7 (`XRHandInputConfig.pinchThresholds`, which must satisfy `0 < release < press <= 1`), so a partial pinch such as `set_select_value 0.5` no longer selects, and the gamepad `pressed` flag follows the same levels.
- Cancelling an interaction (`forceRelease`, the `set_device_state` reset, `setPinchValueImmediate(0)` / `setButtonValueImmediate(…, 0)` on a held button, an ActionPlayer loop, seek, restart or stop mid-press, or a recording that ends mid-press) fires `selectend`/`squeezeend` without `select`/`squeeze`. An input source that disconnects or leaves the primary input mode mid-press does the same, before `inputsourceschange`. A cancelling immediate write keeps the value it asked for (a partial pinch stays partial), and a press written while a cancel is still to be reported waits for the next frame.
- Buttons held when a session ends start the next session released, with no events.
- Recorded hand pinches now fire select events on replay, and a replay only ends actions whose start it sent.
- `set_select_value` rejects out-of-range and NaN values instead of warning and reporting success.
- Remote control rejects queued commands only when no frame arrives for `ACTION_TIMEOUT_MS`, and then also cancels held buttons; a long animation no longer times out the commands behind it. A press and the release queued behind it always land on different frames (a second write to the same device waits for the next frame; writes to different devices share one), `set_input_mode`, `set_connected` and `set_device_state` end the queue's work for their frame, and one stalled frame advances remote control by at most 100 ms.
- DevUI: a gaze click whose release is still waiting for the next frame stays a click (`select` + `selectend`) when the window blurs, remote control takes over, or the gaze mode or commit hand changes; a gaze press still held at that moment is cancelled.
- The `xr_select` and `xr_set_select_value` tool descriptions give the WebXR event order and the hand pinch levels.
