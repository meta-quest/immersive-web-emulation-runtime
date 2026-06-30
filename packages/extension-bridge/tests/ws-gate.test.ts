/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebSocket } from 'ws';
import { BrowserHub } from '../src/hub.js';
import {
  createWsServer,
  hostAllowed,
  originAllowed,
  type WsServerHandle,
} from '../src/ws-server.js';
import { HELLO_TYPE } from '../src/constants.js';

describe('origin/host guards (pure)', () => {
  it('allows only extension or null origins', () => {
    expect(originAllowed('chrome-extension://abc')).toBe(true);
    expect(originAllowed('moz-extension://abc')).toBe(true);
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('null')).toBe(true);
    expect(originAllowed('https://evil.com')).toBe(false);
    expect(originAllowed('http://127.0.0.1:8723')).toBe(false);
  });

  it('allows only loopback hosts', () => {
    expect(hostAllowed('127.0.0.1:8723')).toBe(true);
    expect(hostAllowed('localhost:8723')).toBe(true);
    expect(hostAllowed('[::1]:8723')).toBe(true);
    expect(hostAllowed('evil.com:8723')).toBe(false);
    expect(hostAllowed('192.168.1.5:8723')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });
});

describe('WS server guards (live)', () => {
  let hub: BrowserHub;
  let handle: WsServerHandle;
  let url: string;

  beforeAll(async () => {
    hub = new BrowserHub();
    handle = await createWsServer({ host: '127.0.0.1', port: 0, hub });
    url = `ws://127.0.0.1:${handle.port}/__iwer_mcp`;
  });

  afterAll(async () => {
    hub.close();
    await handle.close();
  });

  function connect(headers: Record<string, string>): WebSocket {
    return new WebSocket(url, { headers });
  }

  it('accepts an extension-origin connection and acks the hello (no token)', async () => {
    const ws = connect({ Origin: 'chrome-extension://test' });
    const ack = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        ws.on('open', () =>
          ws.send(
            JSON.stringify({
              type: HELLO_TYPE,
              tabId: 't1',
              tabGeneration: 1,
            }),
          ),
        );
        ws.on('message', (d) => resolve(JSON.parse(d.toString())));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 4000);
      },
    );
    expect(ack.type).toBe('iwer_hello_ack');
    expect(hub.browserCount).toBe(1);
    ws.close();
    await new Promise((r) => ws.on('close', r));
  });

  it('rejects a non-extension Origin (close 1008)', async () => {
    const ws = connect({ Origin: 'https://evil.com' });
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => {});
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
    expect(code).toBe(1008);
  });
});
