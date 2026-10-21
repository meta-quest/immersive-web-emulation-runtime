---
'iwer': patch
---

Fix `getOffsetReferenceSpace()` to apply `XRRigidTransform` offsets instead of producing non-finite pose matrices. This restores teleportation in applications such as the three.js teleport example while preserving support for raw `mat4` offsets.
