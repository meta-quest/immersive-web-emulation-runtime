/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * BrowserHub correlates an in-process MCP tool call to a response from one (or
 * more) connected browser sockets, using the ported first-response-wins relay.
 *
 * The MCP server is NOT a WebSocket client — it runs in-process — so we model
 * it as a "virtual" relay client (`mcpVirtual`). A `dispatch()` feeds a request
 * frame into the relay (which broadcasts to all browser sockets); the first
 * matching response the relay forwards back to `mcpVirtual` resolves the
 * awaiting promise. This reuses the proven multi-tab dedup logic verbatim.
 */

import { REQUEST_TIMEOUT_MS, STALE_REQUEST_MS } from './constants.js';
import {
  createRelayHandler,
  WS_OPEN,
  type RelayHandler,
  type RelayWebSocket,
} from './relay.js';

export interface DispatchResponse {
  id?: string;
  result?: unknown;
  error?: { message?: string; cause?: string } | string;
  _tabId?: string;
  _tabGeneration?: number;
}

/** Thrown when no consented browser tab is connected. */
export class NoBrowserError extends Error {
  readonly code = 'no_browser';
  constructor() {
    // The bridge can't tell "extension not installed" from "installed but not
    // consenting" — it only sees that no browser has dialed in / consented. So
    // enumerate the fix, ordered for the extension->agent journey.
    super(
      'No Immersive Web Emulator is connected to this bridge yet. ' +
        'If the extension is installed: open your WebXR page, enable IWE on it ' +
        'with the toolbar icon, make it the active tab, then retry — the first ' +
        'time the agent acts, an "Allow" prompt appears on the page; approve it. ' +
        'No extension yet? Install the Immersive Web Emulator from the Chrome ' +
        'Web Store, then retry.',
    );
    this.name = 'NoBrowserError';
  }
}

/** Thrown when the browser does not answer in time. */
export class BrowserTimeoutError extends Error {
  readonly code = 'timeout';
  constructor(method: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for the Immersive Web Emulator ` +
        `to handle '${method}'. Is the paired tab still open, on the emulated ` +
        `page, and the active tab in its window? Re-pair from the IWE popup if ` +
        `you navigated away. (Run \`iwer-bridge status\` to check.)`,
    );
    this.name = 'BrowserTimeoutError';
  }
}

interface PendingEntry {
  resolve: (value: DispatchResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrowserHubOptions {
  verbose?: boolean;
  onLog?: (message: string) => void;
  requestTimeoutMs?: number;
}

export class BrowserHub {
  private readonly clients = new Set<RelayWebSocket>();
  private readonly relay: RelayHandler;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly mcpVirtual: RelayWebSocket;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly requestTimeoutMs: number;
  private idCounter = 0;

  constructor(opts: BrowserHubOptions = {}) {
    this.relay = createRelayHandler({
      verbose: opts.verbose,
      onLog: opts.onLog,
    });
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.mcpVirtual = {
      readyState: WS_OPEN,
      send: (data: string) => this.onVirtualReceive(data),
    };
    this.sweepTimer = setInterval(
      () => this.relay.cleanStale(STALE_REQUEST_MS),
      STALE_REQUEST_MS,
    );
    this.sweepTimer.unref?.();
  }

  /** Number of authenticated browser sockets currently connected. */
  get browserCount(): number {
    return this.clients.size;
  }

  addBrowser(ws: RelayWebSocket): void {
    this.clients.add(ws);
  }

  removeBrowser(ws: RelayWebSocket): void {
    this.clients.delete(ws);
  }

  /** Feed a message received from a browser socket into the relay. */
  onBrowserMessage(ws: RelayWebSocket, data: string): void {
    this.relay.onMessage(ws, data, this.relayClients());
  }

  /** Dispatch a method to the browser and await the first response. */
  dispatch(
    method: string,
    params: unknown = {},
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<DispatchResponse> {
    if (this.clients.size === 0) {
      return Promise.reject(new NoBrowserError());
    }
    const id = `mcp-${++this.idCounter}`;
    return new Promise<DispatchResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.relay.onMessage(
        this.mcpVirtual,
        JSON.stringify({ id, method, params: params ?? {} }),
        this.relayClients(),
      );
    });
  }

  close(): void {
    clearInterval(this.sweepTimer);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Daemon shutting down'));
    }
    this.pending.clear();
    this.clients.clear();
  }

  private relayClients(): Set<RelayWebSocket> {
    const set = new Set<RelayWebSocket>(this.clients);
    set.add(this.mcpVirtual);
    return set;
  }

  private onVirtualReceive(data: string): void {
    let parsed: DispatchResponse | null = null;
    try {
      parsed = JSON.parse(data) as DispatchResponse;
    } catch {
      return;
    }
    const id = parsed?.id;
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(parsed);
  }
}
