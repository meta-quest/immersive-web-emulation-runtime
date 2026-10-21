---
'iwer': minor
'@iwer/devui': minor
'@iwer/extension-bridge': minor
---

Add a library of base hand poses (open, flat, fist, thumbs-up, finger-gun, peace, three, four, ok, rock, call, pinch-middle, pinch-ring, pinch-pinky, tripod, key-pinch, grip, claw, hook, cup) built on the captured Quest skeleton, and per-finger pose blending through `XRHandInput.setFingerPose()`. The DevUI pose stepper and hotkey cycle through `default`, `point`, `fist`, `open` and `thumbs-up` (`pinch` is left to the pinch control), and the label shows a pose set through remote control, with `*` for finger blends. `xr_set_hand_pose` lists the poses with a short description of each, notes that poses never select, accepts per-finger overrides, and rejects unknown pose ids.
