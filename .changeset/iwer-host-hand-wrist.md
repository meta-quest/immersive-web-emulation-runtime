---
'iwer': patch
---

Host input: a hand is listed only while its wrist is tracked (`jointValid` of the wrist is 1). A hand without a tracked wrist is not tracked (WebXR Hand Input), so `mode = Hand` lists nothing until the wrist is valid again, and the hand comes and goes with `inputsourceschange`, as browsers do. Horizon OS can report a hand it does not see with an aim pose and no joints; listed, such a hand made apps aim and raycast with it every frame.
