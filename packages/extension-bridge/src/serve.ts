/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * `iwer-bridge` (bare) / `iwer-bridge serve` — spawned by the coding agent over
 * stdio. Also opens the loopback WS server the extension dials into. There is no
 * token: the extension connects on a FIXED loopback port and control is gated
 * browser-side by a per-tab consent gesture. All human output goes to STDERR
 * (stdout is the MCP stdio channel and must stay clean).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  SERVER_NAME,
  WS_PATH,
} from './constants.js';
import { BrowserHub } from './hub.js';
import { buildMcpServer } from './mcp-server.js';
import { VERSION } from './version.js';
import { createWsServer, type WsServerHandle } from './ws-server.js';

export interface ServeOptions {
  host?: string;
  port?: number;
  /** stderr logger (never stdout). */
  log?: (message: string) => void;
}

function stderr(message: string): void {
  process.stderr.write(`[iwer-bridge] ${message}\n`);
}

function isAddrInUse(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'EADDRINUSE'
  );
}

export async function serve(
  opts: ServeOptions = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const log = opts.log ?? stderr;
  const host = opts.host ?? process.env.IWER_MCP_HOST ?? DEFAULT_HOST;
  const port =
    opts.port ??
    (process.env.IWER_MCP_PORT
      ? Number.parseInt(process.env.IWER_MCP_PORT, 10)
      : DEFAULT_PORT);

  const hub = new BrowserHub({ onLog: log });

  // Bind the FIXED port. The extension can only find the daemon at a known port
  // (no token/pairing carries a dynamic one), so we do NOT fall back to an
  // ephemeral port — on a collision, another bridge is already running.
  let wsHandle: WsServerHandle;
  try {
    wsHandle = await createWsServer({ host, port, hub, onLog: log });
  } catch (err) {
    hub.close();
    if (isAddrInUse(err)) {
      log(
        `port ${port} is already in use — another iwer-bridge is likely running. ` +
          `Stop it (or set IWER_MCP_PORT) and retry.`,
      );
    }
    throw err;
  }

  log(`listening on ws://${host}:${wsHandle.port}${WS_PATH}`);
  log('');
  log('  Connect the Immersive Web Emulator:');
  log('    1) Open a WebXR page and enable IWE on it (toolbar icon).');
  log(
    '    2) When the agent first acts on the page, click Allow in the prompt.',
  );
  log('');

  const server = buildMcpServer({ hub, name: SERVER_NAME, version: VERSION });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const close = async (): Promise<void> => {
    hub.close();
    await wsHandle.close();
  };

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { port: wsHandle.port, close };
}
