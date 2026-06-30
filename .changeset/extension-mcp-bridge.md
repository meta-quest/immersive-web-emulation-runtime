---
'@iwer/extension-bridge': minor
---

feat: @iwer/extension-bridge — drive any WebXR page from a coding agent over MCP

New package: a local stdio MCP server + loopback (127.0.0.1) WebSocket relay that
bridges coding agents (Claude Code, Codex, Cursor, …) to the Immersive Web
Emulator browser extension, forwarding a 20-tool device-control catalog to IWER's
`device.remote` in any page (no dev server required). `browser_screenshot` is a
browser-host tool serviced by the extension (`captureVisibleTab`), not
`device.remote`. Security: 127.0.0.1-only bind, per-session token, and
Origin/Host validation. Includes an `install` command that writes the stdio MCP
config for Claude Code / Cursor / Copilot / Codex / Windsurf.
