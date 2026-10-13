---
'iwer': patch
'@iwer/sem': patch
---

Fix room understanding for the built-in captures: `XRPlane.orientation` now follows the plane's normal (screens were reported as horizontal) and updates, with `lastChangedTime`, when a plane turns between horizontal and vertical, captured planes report normals facing into the room (they pointed out of it, so floors faced down), and office_large's room mesh is reported as 'global mesh'. `@iwer/sem` also ships each capture once instead of four times (no JSON copies in `lib/`, and the prebuilt bundles fetch captures instead of embedding them), shrinking the package from 7.4 MB to 2.5 MB.
