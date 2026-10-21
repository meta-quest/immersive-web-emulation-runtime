# @iwer/extension-bridge

Local **MCP daemon** that lets a coding agent (Claude Code, Codex, Cursor, Copilot, Windsurf, Cline, …) drive **any WebXR page** through the [Immersive Web Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik) browser extension — no dev server required.

This package provides the dev-server-free extension MCP bridge (see `packages/extension/extension-mcp-bridge-plan.md`). It complements IWSDK's project-scoped `iwsdk dev` MCP bridge.

## How it works

```
Coding agent ──stdio (MCP)──► @iwer/extension-bridge daemon ──ws://127.0.0.1──► IWE extension ──► IWER device.remote
```

- The agent spawns `iwer-bridge serve` over **stdio** (the universal MCP transport).
- The daemon also hosts a **loopback WebSocket server** (an MV3 extension can only be a WS client, never a server).
- The extension dials in and relays each tool call to the in-page IWER `device.remote`.

Security: bound to `127.0.0.1` only, Origin/Host validated, and control is gated browser-side by a per-tab **Allow** prompt before any agent request reaches a page.

## Use

Published package:

```bash
claude mcp add --scope user iwer -- npx -y @iwer/extension-bridge serve
```

Local unpublished checkout:

```bash
pnpm --filter @iwer/extension-bridge run build
```

Then use the committed project config at the repository root, `.mcp.json`, or manually point your agent at:

```json
{
  "mcpServers": {
    "iwer": {
      "command": "node",
      "args": ["packages/extension-bridge/bin/iwer-bridge.mjs", "serve"]
    }
  }
}
```

Restart your agent, open a WebXR page, enable Immersive Web Emulator from the toolbar, and click **Allow** when the agent first acts on the page.

## Tools

21 tools mapping 1:1 onto IWER `device.remote` methods — session (`xr_accept_session`, `xr_get_session_status`, …), transform (`xr_set_transform`, `xr_look_at`, `xr_animate_to`), input (`xr_select`, `xr_set_input_mode`, gamepad), hands (`xr_set_hand_pose`, `xr_get_hand_state`, plus `anchor`, hand directions and timed pinches on the transform and input tools), state, SEM world queries (`xr_get_world_state`, `xr_get_objects`), and `browser_screenshot` (returned as a downscaled image). Tools added or changed in catalog version 3 reject unknown parameters instead of dropping them. See `src/contract.ts` and IWER's [Scripting Hand Interactions](https://meta-quest.github.io/immersive-web-emulation-runtime/scripting-hands.html) guide.

## Commands

- `iwer-bridge serve` — run the daemon (your agent spawns this).
- `iwer-bridge help` — show CLI help.

## License

MIT.
