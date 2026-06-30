# @iwer/extension-bridge

Local **MCP daemon** that lets a coding agent (Claude Code, Codex, Cursor, Copilot, Windsurf, Cline, …) drive **any WebXR page** through the [Immersive Web Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik) browser extension — no dev server required.

This package provides the dev-server-free extension MCP bridge (see `packages/extension/extension-mcp-bridge-plan.md`). It complements IWSDK's project-scoped `iwsdk dev` MCP bridge.

## How it works

```
Coding agent ──stdio (MCP)──► @iwer/extension-bridge daemon ──ws://127.0.0.1──► IWE extension ──► IWER device.remote
```

- The agent spawns `iwer-bridge serve` over **stdio** (the universal MCP transport).
- The daemon also hosts a **loopback WebSocket server** (an MV3 extension can only be a WS client, never a server).
- The extension dials in, authenticates with a **per-session token**, and relays each tool call to the in-page IWER `device.remote`.

Security: bound to `127.0.0.1` only, Origin/Host validated, per-session token required (stronger than the localhost-WS norm — see plan §11).

## Use

```bash
# 1. Point your agent at the daemon (writes the right config per client):
npx @iwer/extension-bridge install --client claude        # or cursor | copilot | codex | all

# 2. Restart your agent. When it first uses an iwer tool the daemon starts.
#    Get the pairing code:
npx @iwer/extension-bridge pair

# 3. In Chrome: enable the Immersive Web Emulator on a WebXR page, click the
#    IWE toolbar icon → Connect, paste the code, and Allow the session.
```

Or wire it manually, e.g. Claude Code:

```bash
claude mcp add --scope user iwer -- npx -y @iwer/extension-bridge serve
```

## Tools

20 tools mapping 1:1 onto IWER `device.remote` methods — session (`xr_accept_session`, `xr_get_session_status`, …), transform (`xr_set_transform`, `xr_look_at`, `xr_animate_to`), input (`xr_select`, `xr_set_input_mode`, gamepad), state, SEM world queries (`xr_get_world_state`, `xr_get_objects`), and `browser_screenshot` (returned as a downscaled image). See `src/contract.ts`.

## Commands

- `iwer-bridge serve` — run the daemon (your agent spawns this).
- `iwer-bridge install [--client <ids|all>] [--scope user|project] [--dry-run] [--remove]`
- `iwer-bridge pair` — print the current pairing code.

## License

MIT.
