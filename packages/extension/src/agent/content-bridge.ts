/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * ISOLATED-world content script. Relays between the page (MAIN-world bridge
 * shim, over window.postMessage) and the extension (service worker, over
 * chrome.runtime), and hosts the per-tab consent overlay. Because it runs in the
 * ISOLATED world, the page under test can't read, click, or hide the overlay.
 */

import {
  type AgentRequest,
  type AgentResponse,
  MSG,
  PAGE_CHANNEL,
} from './protocol.js';
import { prefsRuntimeMessageFromWindowMessage } from './prefs-message.js';

function installContentBridge(): void {
  // SW -> page: deliver a daemon request into the MAIN-world shim.
  chrome.runtime.onMessage.addListener(
    (message: { type?: string; data?: AgentRequest }) => {
      if (message?.type === MSG.AGENT_REQUEST_TO_PAGE && message.data) {
        // targetOrigin '*' (location.origin is "null" on opaque-origin frames).
        // Safe: the MAIN-world shim validates event.source===window + channel +
        // method allow-list.
        window.postMessage(
          { channel: PAGE_CHANNEL, dir: 'request', data: message.data },
          '*',
        );
      }
      return undefined;
    },
  );

  // page -> SW: forward a shim response back toward the daemon.
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as {
      channel?: string;
      dir?: string;
      data?: AgentResponse;
    } | null;
    if (
      !msg ||
      msg.channel !== PAGE_CHANNEL ||
      msg.dir !== 'response' ||
      !msg.data
    )
      return;
    chrome.runtime.sendMessage({
      type: MSG.AGENT_RESPONSE_FROM_PAGE,
      data: msg.data,
    });
  });

  // page -> SW: persist DevUI preference changes emitted from the MAIN-world
  // overlay. The SW resolves the sender tab URL to the canonical eTLD+1 key.
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const message = prefsRuntimeMessageFromWindowMessage(event.data);
    if (!message) return;
    chrome.runtime.sendMessage(message);
  });
}

// --- Per-tab consent overlay (ISOLATED world, page-tamper-resistant) --------

function showConsentOverlay(decide: (allowed: boolean) => void): void {
  const root = document.documentElement;
  if (!root) {
    decide(false);
    return;
  }

  const host = document.createElement('div');
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  // Closed shadow: the page can't reach into it to auto-click or hide it.
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  // Unified dark frosted-glass styling (matches @iwer/devui). Rendered
  // in a closed shadow root, so these styles can't leak to or from the page.
  style.textContent = `
    .backdrop { position: fixed; inset: 0; background: rgba(8,8,10,.55);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card { background: rgba(34,34,40,.92); color: #ededed; width: min(480px, 92vw);
      border: 1px solid rgba(61,61,63,.7); border-radius: 14px; padding: 24px;
      backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      box-shadow: 0 24px 64px rgba(0,0,0,.55), 0 0 60px rgba(45,127,249,.16),
        inset 0 1px 0 rgba(255,255,255,.06);
      display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .chip { width: 44px; height: 44px; border-radius: 50%;
      background: rgba(45,127,249,.14); display: flex; align-items: center;
      justify-content: center; }
    .chip svg { width: 22px; height: 22px; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; text-align: center; }
    .expl { position: relative; width: 100%; box-sizing: border-box;
      background: #1b1b1d; border-radius: 10px; padding: 12px 12px 12px 15px;
      overflow: hidden; }
    .expl::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0;
      width: 3px; background: #2d7ff9; }
    .expl p { font-size: 13px; line-height: 1.5; color: #9c9c9c; margin: 0; }
    .row { display: flex; gap: 8px; justify-content: flex-end; width: 100%; }
    button { font: 600 13px system-ui, -apple-system, sans-serif; padding: 9px 16px;
      border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
    .deny { background: transparent; color: #f3978f; border-color: rgba(243,151,143,.35); }
    .deny:hover { background: rgba(243,151,143,.08); }
    .allow { background: #2d7ff9; color: #fff; box-shadow: 0 2px 12px rgba(45,127,249,.4); }
    .allow:hover { background: #1c6fe0; }
  `;

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const card = document.createElement('div');
  card.className = 'card';
  const chip = document.createElement('div');
  chip.className = 'chip';
  // Lucide "shield-check" — drawn in the shadow root, page-tamper-resistant.
  chip.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#2d7ff9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';
  const h1 = document.createElement('h1');
  h1.textContent = 'Allow agent control of this tab?';
  const expl = document.createElement('div');
  expl.className = 'expl';
  const p = document.createElement('p');
  p.textContent =
    'A local coding agent on your machine wants to drive this WebXR page through the Immersive Web Emulator — moving the headset, pressing controllers, and taking screenshots. Allow it for this tab until you close the browser?';
  expl.append(p);
  const row = document.createElement('div');
  row.className = 'row';
  const deny = document.createElement('button');
  deny.className = 'deny';
  deny.textContent = 'Deny';
  const allow = document.createElement('button');
  allow.className = 'allow';
  allow.textContent = 'Allow';
  row.append(deny, allow);
  card.append(chip, h1, expl, row);
  backdrop.append(card);
  shadow.append(style, backdrop);
  root.append(host);

  let settled = false;
  const finish = (allowed: boolean) => {
    if (settled) return;
    settled = true;
    try {
      host.remove();
    } catch {
      /* already gone */
    }
    decide(allowed);
  };
  allow.addEventListener('click', () => finish(true));
  deny.addEventListener('click', () => finish(false));
}

function installConsentOverlay(): void {
  if (window.top !== window) return; // only the top frame shows the dialog
  let open = false;
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === MSG.REQUEST_CONSENT && !open) {
      open = true;
      showConsentOverlay((allowed) => {
        open = false;
        chrome.runtime.sendMessage({ type: MSG.CONSENT_RESULT, allowed });
      });
    }
    return undefined;
  });
}

// Idempotency guard: the bridge is registered as a document_start content script
// for emulated domains; install its listeners + the consent overlay exactly once
// per frame (the ISOLATED world shares `window`).
const bridgeWindow = window as Window & { __IWE_CONTENT_BRIDGE__?: boolean };
if (!bridgeWindow.__IWE_CONTENT_BRIDGE__) {
  bridgeWindow.__IWE_CONTENT_BRIDGE__ = true;
  installContentBridge();
  installConsentOverlay();
}
