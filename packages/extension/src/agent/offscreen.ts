/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Offscreen document: owns the durable WebSocket to the local
 * @iwer/extension-bridge daemon (an MV3 service worker is too short-lived to
 * hold it). It dials a FIXED loopback endpoint with no token — control is gated
 * browser-side by a per-tab consent gesture. Sends a hello on connect, a ~20s
 * heartbeat to keep the channel alive (Chrome 116+ resets the SW idle timer on
 * WS traffic), and reconnects with 1–30s backoff. No eval / new Function
 * anywhere (MV3 CSP).
 */

import {
  DEFAULT_PORT,
  HELLO_TYPE,
  MSG,
  PING_TYPE,
  PONG_TYPE,
  PROTOCOL_VERSION,
  WS_PATH,
} from './protocol.js';

interface Config {
  host: string;
  port: number;
}

let ws: WebSocket | null = null;
let config: Config | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let manualClose = false;

function reportStatus(connected: boolean, error?: string): void {
  chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STATUS, connected, error });
}

function clearTimers(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (manualClose || !config) return;
  attempt += 1;
  const delay = Math.min(30_000, 1_000 * attempt);
  reconnectTimer = setTimeout(connect, delay);
}

function connect(): void {
  const cfg = config;
  if (!cfg) return;
  clearTimers(); // never leak a prior connection's timers
  const url = `ws://${cfg.host}:${cfg.port}${WS_PATH}`;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.addEventListener('open', () => {
    if (ws !== sock) return; // superseded by a newer connection
    attempt = 0;
    sock.send(
      JSON.stringify({
        type: HELLO_TYPE,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    clearTimers();
    heartbeat = setInterval(() => {
      if (ws === sock && sock.readyState === WebSocket.OPEN)
        sock.send(JSON.stringify({ type: PING_TYPE }));
    }, 20_000);
    reportStatus(true);
  });

  sock.addEventListener('message', (event: MessageEvent) => {
    if (ws !== sock) return; // ignore frames from a superseded socket
    if (typeof event.data !== 'string') return;
    let msg: {
      type?: string;
      id?: string;
      method?: string;
      params?: Record<string, unknown>;
    } | null;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.type === PONG_TYPE || msg.type === 'iwer_hello_ack') return;
    if (typeof msg.method === 'string' && typeof msg.id === 'string') {
      chrome.runtime.sendMessage({
        type: MSG.AGENT_REQUEST_FROM_DAEMON,
        data: { id: msg.id, method: msg.method, params: msg.params ?? {} },
      });
    }
  });

  sock.addEventListener('close', () => {
    if (ws !== sock) return; // a superseded socket closing must not touch the live one
    clearTimers();
    reportStatus(false);
    if (!manualClose) scheduleReconnect();
  });

  sock.addEventListener('error', () => {
    // A 'close' event follows; reconnect is handled there.
  });
}

function disconnect(): void {
  manualClose = true;
  clearTimers();
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  reportStatus(false);
}

chrome.runtime.onMessage.addListener(
  (message: {
    type?: string;
    host?: string;
    port?: number;
    data?: unknown;
  }) => {
    switch (message?.type) {
      case MSG.OFFSCREEN_CONNECT:
        disconnect();
        config = {
          host: message.host ?? '127.0.0.1',
          port: message.port ?? DEFAULT_PORT,
        };
        manualClose = false;
        attempt = 0;
        connect();
        break;
      case MSG.OFFSCREEN_DISCONNECT:
        disconnect();
        break;
      case MSG.AGENT_RESPONSE_TO_DAEMON:
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify(message.data));
        break;
    }
    return undefined;
  },
);

// Auto-connect to the fixed loopback endpoint on load (no token). The service
// worker only has to create this document; the reconnect backoff keeps trying
// until the daemon appears. Tests may override host/port via OFFSCREEN_CONNECT.
config = { host: '127.0.0.1', port: DEFAULT_PORT };
connect();
