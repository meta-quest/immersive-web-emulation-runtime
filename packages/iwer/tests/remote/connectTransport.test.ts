/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Proves the contract the extension MCP bridge relies on: a plain
 * `{ postMessage, addEventListener('message') }` port handed to
 * `device.remote.connectTransport(port)` drives `device.remote.dispatch` and
 * returns `{ id, result }` / `{ id, error }` envelopes — no MessageChannel,
 * no DOM, no real WebSocket required. (Plan acceptance criterion C.)
 */

import { XRDevice } from '../../src/device/XRDevice.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';

console.log = () => {};

/** A minimal in-memory port pair matching the connectTransport interface. */
function makePortPair() {
  type Listener = (event: { data: unknown }) => void;
  const aListeners: Listener[] = [];
  const bListeners: Listener[] = [];
  const deliver = (listeners: Listener[], data: unknown) =>
    queueMicrotask(() => listeners.forEach((l) => l({ data })));
  const a = {
    postMessage: (data: unknown) => deliver(bListeners, data),
    addEventListener: (type: 'message', l: Listener) => {
      if (type === 'message') aListeners.push(l);
    },
  };
  const b = {
    postMessage: (data: unknown) => deliver(aListeners, data),
    addEventListener: (type: 'message', l: Listener) => {
      if (type === 'message') bListeners.push(l);
    },
  };
  return { a, b };
}

interface Envelope {
  id?: string;
  result?: unknown;
  error?: string;
}

describe('RemoteControlInterface.connectTransport', () => {
  function setup() {
    const device = new XRDevice(metaQuest3);
    const { a, b } = makePortPair();
    device.remote.connectTransport(a);
    let counter = 0;
    const bListeners: Array<(e: { data: unknown }) => void> = [];
    b.addEventListener('message', (e) => bListeners.forEach((l) => l(e)));

    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Envelope>((resolve) => {
        const id = `t${++counter}`;
        const onMsg = (e: { data: unknown }) => {
          const env = e.data as Envelope;
          if (env && env.id === id) {
            const idx = bListeners.indexOf(onMsg);
            if (idx !== -1) bListeners.splice(idx, 1);
            resolve(env);
          }
        };
        bListeners.push(onMsg);
        b.postMessage({ id, method, params });
      });

    return { device, call };
  }

  it('drives an immediate query and returns a result envelope', async () => {
    const { call } = setup();
    const env = await call('get_device_state');
    expect(env.error).toBeUndefined();
    const state = env.result as {
      headset: { position: { x: number; y: number; z: number } };
    };
    expect(state.headset).toBeDefined();
    expect(typeof state.headset.position.y).toBe('number');
  });

  it('reports session status without an active session', async () => {
    const { call } = setup();
    const env = await call('get_session_status');
    const status = env.result as { sessionActive: boolean; deviceName: string };
    expect(status.sessionActive).toBe(false);
    expect(typeof status.deviceName).toBe('string');
  });

  it('returns an error envelope for a session-required method with no session', async () => {
    const { call } = setup();
    const env = await call('set_transform', {
      device: 'headset',
      position: { x: 0, y: 1, z: 0 },
    });
    expect(env.result).toBeUndefined();
    expect(env.error).toMatch(/no active xr session/i);
  });

  it('resolves device-id aliases through the transport', async () => {
    const { call } = setup();
    const env = await call('get_select_value', { device: 'right' });
    // "right" → controller-right; value is a number in [0,1].
    const res = env.result as { device: string; value: number };
    expect(res.device).toBe('controller-right');
    expect(typeof res.value).toBe('number');
  });
});
