---
'iwer': patch
---

Validate XRRigidTransform and XRRay constructor inputs in WebXR specification order. Reject invalid position or origin w values and non-finite transform or ray direction members with TypeError, reject zero-length orientations with InvalidStateError, and use JavaScript TypeError for invalid ray directions instead of a DOMException.

Keep internally generated poses valid by handling equal recorded timestamps without dividing by zero during playback.
