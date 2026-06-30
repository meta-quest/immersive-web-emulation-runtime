/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Wire-protocol version carried in the browser hello frame. */
export const PROTOCOL_VERSION = 1;

/** WebSocket path the extension dials (reuses the IWSDK convention). */
export const WS_PATH = '/__iwer_mcp';

/** Fixed loopback port the daemon binds and the extension dials (no pairing). */
export const DEFAULT_PORT = 8723;

/** Loopback-only bind. Never 0.0.0.0 (plan §6). */
export const DEFAULT_HOST = '127.0.0.1';

/** Hosts allowed in the WS upgrade Host header (anti-DNS-rebind). */
export const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Message envelope discriminators. */
export const HELLO_TYPE = 'iwer_browser_hello';
export const PING_TYPE = 'ping';
export const PONG_TYPE = 'pong';

/** Logical MCP server name (also the key written into agent config files). */
export const SERVER_NAME = 'iwer';

/** How long the daemon waits for the browser to answer a tool call. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Pending relay/request entries older than this are swept. */
export const STALE_REQUEST_MS = 60_000;

/** WS close codes the daemon uses for auth failures. */
export const CLOSE_POLICY_VIOLATION = 1008;
