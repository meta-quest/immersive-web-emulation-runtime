---
'@iwer/devui': minor
---

feat: expose and emit preference bridge state for persistent extension settings

- Export DEFAULT_KEYMAP/useKeyMapStore plus the preference postMessage helper so
  extension shells can seed and persist DevUI-controlled settings without
  importing private component modules.
- Emit storage-agnostic preference patches for keymap, input mode, FOV,
  environment, hand pose, and saved default pose interactions.
