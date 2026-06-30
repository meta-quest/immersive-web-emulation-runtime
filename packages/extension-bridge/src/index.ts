/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Library surface for @iwer/extension-bridge (the CLI lives in cli.ts / bin/iwer-bridge.mjs).
 */

export { VERSION } from './version.js';
export * from './constants.js';
export {
  TOOLS,
  TOOL_BY_MCP_NAME,
  MCP_TO_METHOD,
  KNOWN_METHODS,
  SCREENSHOT_TOOL,
  CATALOG_VERSION,
  type ToolDef,
} from './contract.js';
export {
  createRelayHandler,
  WS_OPEN,
  type RelayHandler,
  type RelayWebSocket,
  type RelayOptions,
} from './relay.js';
export {
  BrowserHub,
  NoBrowserError,
  BrowserTimeoutError,
  type DispatchResponse,
  type BrowserHubOptions,
} from './hub.js';
export {
  createWsServer,
  originAllowed,
  hostAllowed,
  type WsServerOptions,
  type WsServerHandle,
} from './ws-server.js';
export {
  buildMcpServer,
  handleCall,
  type BuildMcpServerOptions,
} from './mcp-server.js';
export { serve, type ServeOptions } from './serve.js';
export {
  createTabTracker,
  type TabTracker,
  type TabMeta,
} from './tab-tracker.js';
export {
  toImageContent,
  isOverCeiling,
  planReducedParams,
  mergeCaptureParams,
  enforceImageCeiling,
  DEFAULT_CAPTURE_PARAMS,
  MAX_IMAGE_BASE64_BYTES,
  type CaptureParams,
  type CaptureResult,
} from './screenshot.js';
