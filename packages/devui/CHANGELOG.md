# @iwer/devui

## 2.4.0

### Minor Changes

- Versioned in lockstep with `iwer` 2.4.0; no package-specific behavior changes.

## 2.3.0

### Minor Changes

- Add the preference bridge used by browser-extension shells to seed and persist
  DevUI-controlled settings without importing private component modules.
- Export `DEFAULT_KEYMAP`, `useKeyMapStore`, and preference postMessage helpers.
- Emit storage-agnostic preference patches for keymap, input mode, FOV,
  environment, hand pose, and saved default pose interactions.

### Patch Changes

- Fix pointer-lock cleanup and reduce render churn in the live control overlay.
- Clear the offer-session interval on disposal and avoid listener leaks.
- Reduce transform-sync allocations by reusing shared quaternion scratch state.
- Keep the hidden offer-session/Enter XR control fully outside unsupported
  pages until a session is actually offered.
