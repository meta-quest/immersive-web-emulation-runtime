/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createRelayHandler,
  WS_OPEN,
  type RelayWebSocket,
} from '../src/relay.js';

function mockSocket(): RelayWebSocket & { sent: string[] } {
  const sent: string[] = [];
  return { readyState: WS_OPEN, send: (d: string) => sent.push(d), sent };
}

describe('createRelayHandler (first-response-wins)', () => {
  it('broadcasts a request to all other clients, not the sender', () => {
    const relay = createRelayHandler();
    const mcp = mockSocket();
    const tabA = mockSocket();
    const tabB = mockSocket();
    const clients = new Set<RelayWebSocket>([mcp, tabA, tabB]);

    relay.onMessage(
      mcp,
      JSON.stringify({ id: '1', method: 'get_device_state', params: {} }),
      clients,
    );

    expect(mcp.sent).toHaveLength(0);
    expect(tabA.sent).toHaveLength(1);
    expect(tabB.sent).toHaveLength(1);
    expect(relay.pendingCount()).toBe(1);
  });

  it('forwards the first response to the original requester and drops duplicates', () => {
    const relay = createRelayHandler();
    const mcp = mockSocket();
    const tabA = mockSocket();
    const tabB = mockSocket();
    const clients = new Set<RelayWebSocket>([mcp, tabA, tabB]);

    relay.onMessage(
      mcp,
      JSON.stringify({ id: '7', method: 'get_transform', params: {} }),
      clients,
    );
    relay.onMessage(
      tabA,
      JSON.stringify({ id: '7', result: { device: 'headset' } }),
      clients,
    );
    relay.onMessage(
      tabB,
      JSON.stringify({ id: '7', result: { device: 'headset', dup: true } }),
      clients,
    );

    expect(mcp.sent).toHaveLength(1);
    expect(JSON.parse(mcp.sent[0])).toMatchObject({
      id: '7',
      result: { device: 'headset' },
    });
    expect(relay.pendingCount()).toBe(0);
  });

  it('does not forward to a closed requester', () => {
    const relay = createRelayHandler();
    const mcp = mockSocket();
    const tab = mockSocket();
    const clients = new Set<RelayWebSocket>([mcp, tab]);

    relay.onMessage(
      mcp,
      JSON.stringify({ id: '9', method: 'x', params: {} }),
      clients,
    );
    mcp.readyState = 3; // CLOSED
    relay.onMessage(tab, JSON.stringify({ id: '9', result: 1 }), clients);
    expect(mcp.sent).toHaveLength(0);
  });

  it('cleanStale sweeps old pending requests', () => {
    const relay = createRelayHandler();
    const mcp = mockSocket();
    const tab = mockSocket();
    const clients = new Set<RelayWebSocket>([mcp, tab]);
    relay.onMessage(
      mcp,
      JSON.stringify({ id: 'old', method: 'x', params: {} }),
      clients,
    );
    expect(relay.pendingCount()).toBe(1);
    relay.cleanStale(-1); // everything is "older than -1ms"
    expect(relay.pendingCount()).toBe(0);
  });
});
