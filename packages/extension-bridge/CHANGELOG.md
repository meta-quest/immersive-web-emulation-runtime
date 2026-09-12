# @iwer/extension-bridge

## 2.4.0

### Minor Changes

- Versioned in lockstep with `iwer` 2.4.0; no package-specific behavior changes.

## 2.3.0

Initial npm release.

### Minor Changes

- Add `@iwer/extension-bridge`, a local stdio MCP daemon that lets coding agents
  drive any WebXR page through the Immersive Web Emulator browser extension.
- Relay MCP requests over a loopback `127.0.0.1` WebSocket to the extension,
  which forwards calls to the in-page IWER `device.remote` surface.
- Ship a 20-tool control catalog covering XR session status/entry, headset and
  input transforms, select/gamepad/hand controls, device state, SEM world/object
  queries, and browser screenshots.
- Serve screenshots from the browser extension via `captureVisibleTab` rather
  than from `device.remote`, so screenshots work for real page rendering.
- Gate tab control browser-side with an on-page per-tab Allow prompt before any
  agent request reaches a page.
- Provide the `iwer-bridge` CLI with `serve` and `help` commands for MCP client
  configuration.
