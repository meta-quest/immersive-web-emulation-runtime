/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * The loopback WebSocket server the extension dials into. Bound to 127.0.0.1
 * only, path `/__iwer_mcp`, with two checks:
 *   1. Origin must be a browser-extension origin (or null).
 *   2. Host header must be loopback (anti-DNS-rebind).
 * There is no token: control is gated browser-side by a per-tab consent gesture
 * (the user clicks Allow before any agent request reaches a page). The first
 * hello frame is used only for protocol-version negotiation.
 */

import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { CATALOG_VERSION } from './contract.js';
import {
  ALLOWED_HOSTS,
  CLOSE_POLICY_VIOLATION,
  HELLO_TYPE,
  PING_TYPE,
  PONG_TYPE,
  PROTOCOL_VERSION,
  WS_PATH,
} from './constants.js';
import type { BrowserHub } from './hub.js';
import type { RelayWebSocket } from './relay.js';

/** True for extension origins (or a null/absent origin from extension contexts). */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true;
  return (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://')
  );
}

/** True only for loopback Host headers (strips the port; handles IPv6 brackets). */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host: string;
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    host = end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  } else {
    host = hostHeader.split(':')[0];
  }
  return ALLOWED_HOSTS.has(host);
}

export interface WsServerOptions {
  host: string;
  port: number;
  hub: BrowserHub;
  verbose?: boolean;
  onLog?: (message: string) => void;
}

export interface WsServerHandle {
  port: number;
  close(): Promise<void>;
}

export function createWsServer(opts: WsServerOptions): Promise<WsServerHandle> {
  const log = opts.onLog ?? (() => {});
  return new Promise<WsServerHandle>((resolve, reject) => {
    const wss = new WebSocketServer({
      host: opts.host,
      port: opts.port,
      path: WS_PATH,
    });

    wss.on('error', (err) => reject(err));

    wss.on('listening', () => {
      const address = wss.address() as AddressInfo | string | null;
      const boundPort =
        address && typeof address === 'object' ? address.port : opts.port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) {
              try {
                client.terminate();
              } catch {
                /* ignore */
              }
            }
            wss.close(() => res());
          }),
      });
    });

    wss.on('connection', (ws: WebSocket, req) => {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (!originAllowed(origin) || !hostAllowed(host)) {
        log(
          `rejected WS: origin=${origin ?? '<none>'} host=${host ?? '<none>'}`,
        );
        ws.close(CLOSE_POLICY_VIOLATION, 'forbidden origin/host');
        return;
      }

      const relayWs = ws as unknown as RelayWebSocket;
      opts.hub.addBrowser(relayWs);
      log('browser connected');

      ws.on('message', (raw) => {
        let msg: { type?: string; id?: string } | null = null;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === HELLO_TYPE) {
          ws.send(
            JSON.stringify({
              type: 'iwer_hello_ack',
              protocolVersion: PROTOCOL_VERSION,
              catalogVersion: CATALOG_VERSION,
            }),
          );
          return;
        }
        if (msg.type === PING_TYPE) {
          ws.send(JSON.stringify({ type: PONG_TYPE }));
          return;
        }

        // Otherwise treat as a response frame and feed it to the relay.
        opts.hub.onBrowserMessage(relayWs, raw.toString());
      });

      ws.on('close', () => {
        opts.hub.removeBrowser(relayWs);
      });
      ws.on('error', () => {
        opts.hub.removeBrowser(relayWs);
      });
    });
  });
}
