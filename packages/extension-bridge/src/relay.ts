/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * First-response-wins relay. Ported from IWSDK's
 * `vite-plugin-dev/src/mcp-relay.ts` (`createRelayHandler`), kept faithful so
 * the proven multi-tab dedup logic stays shared in spirit (plan §7 reuse map).
 *
 * A request (a frame with a `method`) from one client is broadcast to all
 * OTHER connected clients. The FIRST response for a given request id is
 * forwarded back to the original requester; duplicate responses are dropped.
 */

/**
 * Minimal WebSocket interface used by the relay. Compatible with both the `ws`
 * library and an in-process virtual socket.
 */
export interface RelayWebSocket {
  readyState: number;
  send(data: string): void;
}

/** WebSocket OPEN readyState constant. */
export const WS_OPEN = 1;

export interface RelayOptions {
  verbose?: boolean;
  onLog?: (message: string) => void;
}

export interface RelayHandler {
  /** Handle an incoming message from a connected client. */
  onMessage(
    senderWs: RelayWebSocket,
    data: string,
    clients: Set<RelayWebSocket>,
  ): void;
  /** Number of pending (unresolved) relay requests. */
  pendingCount(): number;
  /** Clean up stale pending entries older than `maxAgeMs`. */
  cleanStale(maxAgeMs: number): void;
}

export function createRelayHandler(options?: RelayOptions): RelayHandler {
  const verbose = options?.verbose ?? false;
  const log = options?.onLog ?? (() => {});

  const pendingRelayRequests = new Map<
    string,
    { timestamp: number; sourceWs: RelayWebSocket }
  >();

  function onMessage(
    senderWs: RelayWebSocket,
    data: string,
    clients: Set<RelayWebSocket>,
  ): void {
    let parsed: {
      id?: string;
      method?: string;
      result?: unknown;
      error?: unknown;
    } | null = null;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Not JSON — broadcast as-is for backward compatibility.
    }

    if (parsed && typeof parsed.id === 'string') {
      if (typeof parsed.method === 'string') {
        // Request: track for dedup + broadcast to all OTHER clients.
        pendingRelayRequests.set(parsed.id, {
          timestamp: Date.now(),
          sourceWs: senderWs,
        });
        clients.forEach((client) => {
          if (client !== senderWs && client.readyState === WS_OPEN) {
            client.send(data);
          }
        });
        return;
      }

      // Response: a frame with an `id` and no `method` is a response — even if
      // `result` is undefined (JSON.stringify drops an undefined result), which
      // is why we key off "id present, no method" rather than "result present".
      // First response wins; duplicates/unknown ids are dropped.
      const pending = pendingRelayRequests.get(parsed.id);
      if (pending) {
        pendingRelayRequests.delete(parsed.id);
        if (pending.sourceWs.readyState === WS_OPEN) {
          pending.sourceWs.send(data);
        }
        if (verbose)
          log(`[relay] response for ${parsed.id} forwarded (first-wins)`);
      } else if (verbose) {
        log(`[relay] duplicate/unknown response for ${parsed.id} dropped`);
      }
      return;
    }

    // Unknown shape — broadcast for backward compatibility.
    clients.forEach((client) => {
      if (client !== senderWs && client.readyState === WS_OPEN) {
        client.send(data);
      }
    });
  }

  function pendingCount(): number {
    return pendingRelayRequests.size;
  }

  function cleanStale(maxAgeMs: number): void {
    const now = Date.now();
    for (const [id, entry] of pendingRelayRequests) {
      if (now - entry.timestamp > maxAgeMs) {
        pendingRelayRequests.delete(id);
      }
    }
  }

  return { onMessage, pendingCount, cleanStale };
}
