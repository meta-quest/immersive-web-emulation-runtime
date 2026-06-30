/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * MAIN-world bridge shim (runs inside iwe.min.js, alongside IWER). Wires
 * `device.remote.connectTransport(port)` to a `window.postMessage` channel that
 * the ISOLATED content script relays to the extension. Hardened: exact channel
 * tag, `event.source === window`, and a method allow-list — so a hostile page
 * can't inject arbitrary device-control messages into this (MAIN) world.
 */

import {
  ALLOWED_METHODS,
  type AgentRequest,
  type AgentResponse,
  PAGE_CHANNEL,
} from './protocol.js';
import type { XRDevice } from 'iwer';

// The exact port shape IWER's connectTransport expects, derived from iwer so it
// never drifts from the runtime contract.
type ConnectPort = Parameters<XRDevice['remote']['connectTransport']>[0];
type MessageListener = Parameters<ConnectPort['addEventListener']>[1];

function tabIdentity(): { tabId: string; tabGeneration: number } {
  const idKey = 'iwer-bridge-tab-id';
  const genKey = 'iwer-bridge-tab-gen';
  let tabId: string;
  try {
    tabId = sessionStorage.getItem(idKey) ?? '';
    if (!tabId) {
      tabId = `tab-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      sessionStorage.setItem(idKey, tabId);
    }
    const gen = Number.parseInt(sessionStorage.getItem(genKey) ?? '0', 10) + 1;
    sessionStorage.setItem(genKey, String(gen));
    return { tabId, tabGeneration: gen };
  } catch {
    // sessionStorage can be unavailable (sandboxed frames) — fall back.
    return { tabId: `tab-${Date.now().toString(36)}`, tabGeneration: 1 };
  }
}

/** Install the agent bridge against a live IWER device. Safe to call once. */
export function installAgentBridge(device: XRDevice): void {
  const { tabId, tabGeneration } = tabIdentity();
  const listeners: MessageListener[] = [];

  const port: ConnectPort = {
    postMessage(message: unknown) {
      const response: AgentResponse = {
        ...(message as AgentResponse),
        _tabId: tabId,
        _tabGeneration: tabGeneration,
      };
      // targetOrigin '*' (not location.origin, which is the string "null" on
      // opaque-origin/sandboxed frames and would drop the message). Safe: the
      // content-bridge validates event.source===window + the channel tag.
      window.postMessage(
        { channel: PAGE_CHANNEL, dir: 'response', data: response },
        '*',
      );
    },
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener);
    },
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return; // block iframe / cross-window spoofing
    const msg = event.data as {
      channel?: string;
      dir?: string;
      data?: AgentRequest;
    } | null;
    if (!msg || msg.channel !== PAGE_CHANNEL || msg.dir !== 'request') return;
    const req = msg.data;
    if (!req || typeof req.method !== 'string' || typeof req.id !== 'string')
      return;
    if (!ALLOWED_METHODS.has(req.method)) {
      port.postMessage({
        id: req.id,
        error: `method '${req.method}' is not in the IWER agent allow-list`,
      });
      return;
    }
    listeners.forEach((listener) => listener({ data: req }));
  });

  device.remote.connectTransport(port);
}
