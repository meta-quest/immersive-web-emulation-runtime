/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Shared constants + message shapes for the extension MCP bridge inside the
 * extension. Imported by both the MAIN-world page shim and the ISOLATED content
 * script so the channel tag and method allow-list never drift.
 */

/** Channel tag stamped on every page<->content-script postMessage. */
export const PAGE_CHANNEL = 'iwer-agent';
export const PREFS_CHANNEL = 'iwer-prefs';
export const PREFS_SEED_CHANNEL = 'iwer-prefs-seed';

/** Direction discriminators on the page<->content-script channel. */
export type PageMessageDir = 'request' | 'response';

/** A request travelling agent -> device. */
export interface AgentRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** A response travelling device -> agent. */
export interface AgentResponse {
  id: string;
  result?: unknown;
  error?: string;
  _tabId?: string;
  _tabGeneration?: number;
}

/** A framed page<->content-script message. */
export interface PageMessage {
  channel: typeof PAGE_CHANNEL;
  dir: PageMessageDir;
  data: AgentRequest | AgentResponse;
}

/** chrome.runtime message types (SW <-> offscreen <-> content script <-> popup). */
export const MSG = {
  // SW -> offscreen
  OFFSCREEN_CONNECT: 'iwer-offscreen-connect',
  OFFSCREEN_DISCONNECT: 'iwer-offscreen-disconnect',
  AGENT_RESPONSE_TO_DAEMON: 'iwer-agent-response-out', // SW -> offscreen -> daemon
  // offscreen -> SW
  OFFSCREEN_STATUS: 'iwer-offscreen-status',
  AGENT_REQUEST_FROM_DAEMON: 'iwer-agent-request-in', // offscreen -> SW (-> tab)
  // SW -> content script (the agent-controlled tab)
  AGENT_REQUEST_TO_PAGE: 'iwer-agent-request',
  // content script -> SW
  AGENT_RESPONSE_FROM_PAGE: 'iwer-agent-response',
  // consent (SW <-> content bridge): per-tab agent-control gesture
  REQUEST_CONSENT: 'iwer-request-consent', // SW -> content bridge: show the overlay
  CONSENT_RESULT: 'iwer-consent-result', // content bridge -> SW: allow/deny
  // popup <-> SW
  STATUS: 'iwer-status',
  TOGGLE_EMULATION: 'iwer-toggle-emulation',
  PREFS_READ: 'iwer-prefs-read',
  PREFS_WRITE: 'iwer-prefs-write',
  CLEAR_NEW_BADGE: 'iwer-clear-new-badge',
} as const;

/**
 * The exact set of `device.remote` methods the bridge will forward. Anything
 * else posted into the page shim is rejected (ShadowPrompt hardening — plan §6).
 * Keep in sync with `@iwer/extension-bridge` `src/contract.ts`.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'get_session_status',
  'accept_session',
  'end_session',
  'get_transform',
  'set_transform',
  'look_at',
  'animate_to',
  'set_input_mode',
  'set_connected',
  'get_select_value',
  'set_select_value',
  'select',
  'get_gamepad_state',
  'set_gamepad_state',
  'get_device_state',
  'set_device_state',
  'set_hand_pose',
  'get_world_state',
  'get_objects',
  // NOTE: browser-host methods (see BROWSER_HOST_METHODS) are intentionally
  // absent — they are serviced by the service worker, never forwarded to the
  // page's device.remote.
]);

/**
 * Methods serviced by the extension host (the service worker), NOT by IWER
 * device.remote in the page. The SW intercepts these before forwarding. Mirrors
 * the daemon's `browserTool` flag in `@iwer/extension-bridge` contract.ts.
 */
export const BROWSER_HOST_METHODS: ReadonlySet<string> = new Set([
  'screenshot',
]);

/** Fixed loopback port the daemon binds and the extension dials (no pairing). */
export const DEFAULT_PORT = 8723;

export const WS_PATH = '/__iwer_mcp';
export const HELLO_TYPE = 'iwer_browser_hello';
export const PING_TYPE = 'ping';
export const PONG_TYPE = 'pong';
export const PROTOCOL_VERSION = 1;
