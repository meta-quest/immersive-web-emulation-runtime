/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Full-chain integration (plan acceptance criterion D):
 *   MCP client  ──stdio──►  @iwer/extension-bridge daemon  ──ws──►  browser stand-in  ──►  mock device.remote
 *
 * Runs the MVP exit sequence (accept_session → look_at → select → screenshot)
 * through the REAL daemon process (real stdio MCP server, real WS relay,
 * loopback Origin/Host gate). The browser side is a stand-in wired to a mock
 * device so
 * the test runs in Node; the REAL XRDevice.remote wiring through a postMessage
 * port is covered separately by the iwer connectTransport test.
 *
 * Requires `pnpm build` first (it spawns lib/cli.js).
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HELLO_TYPE } from '../src/constants.js';

const CLI_PATH = fileURLToPath(new URL('../lib/cli.js', import.meta.url));
const PORT = 8799;
interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

/** A browser stand-in: dials the daemon (loopback + extension Origin), then
 * answers via a mock device. There is no token — control is gated browser-side. */
function startBrowserStandIn(port: number) {
  const calls: RecordedCall[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/__iwer_mcp`, {
    headers: { Origin: 'chrome-extension://integration-test' },
  });

  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: HELLO_TYPE,
          tabId: 'tab-1',
          tabGeneration: 1,
        }),
      ),
    );
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'iwer_hello_ack') {
        resolve();
        return;
      }
      if (typeof msg.method !== 'string') return;
      calls.push({ method: msg.method, params: msg.params ?? {} });
      const result = mockDevice(msg.method, msg.params ?? {});
      ws.send(
        JSON.stringify({
          id: msg.id,
          result,
          _tabId: 'tab-1',
          _tabGeneration: 1,
        }),
      );
    });
    ws.on('error', reject);
    setTimeout(
      () => reject(new Error('browser stand-in connect timeout')),
      5000,
    );
  });

  return { ws, ready, calls };
}

function mockDevice(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'get_session_status':
      return {
        deviceName: 'Meta Quest 3',
        sessionActive: false,
        sessionOffered: true,
      };
    case 'accept_session':
      return { success: true };
    case 'look_at':
      return {
        device: params.device,
        position: { x: 0, y: 1.6, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      };
    case 'select':
      return { device: params.device, duration: params.duration ?? 0.15 };
    case 'screenshot':
      // In production this is serviced by the extension's service worker
      // (captureVisibleTab); the stand-in returns the same envelope shape.
      return {
        imageData: 'AAAA'.repeat(8),
        width: (params.maxWidth as number) ?? 768,
        height: 100,
        format: (params.format as string) ?? 'jpeg',
        timestamp: 1,
      };
    default:
      return { ok: true, method, params };
  }
}

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('full chain integration', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let browser: ReturnType<typeof startBrowserStandIn>;

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `Build first: ${CLI_PATH} is missing (run \`pnpm --filter @iwer/extension-bridge build\`).`,
      );
    }
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, 'serve'],
      env: {
        ...(process.env as Record<string, string>),
        IWER_MCP_PORT: String(PORT),
      },
      stderr: 'ignore',
    });
    client = new Client(
      { name: 'integration-test', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    browser = startBrowserStandIn(PORT);
    await browser.ready;
  }, 20000);

  afterAll(async () => {
    try {
      browser?.ws.close();
    } catch {
      /* ignore */
    }
    await client?.close();
  });

  it('lists the full tool catalog', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(20);
    const names = tools.map((t) => t.name);
    expect(names).toContain('xr_accept_session');
    expect(names).toContain('xr_look_at');
    expect(names).toContain('xr_select');
    expect(names).toContain('browser_screenshot');
  });

  it('runs the MVP exit sequence end to end', async () => {
    const status = await client.callTool({
      name: 'xr_get_session_status',
      arguments: {},
    });
    expect(textOf(status as never)).toContain('Meta Quest 3');

    const accept = await client.callTool({
      name: 'xr_accept_session',
      arguments: {},
    });
    expect(textOf(accept as never)).toContain('success');

    const look = await client.callTool({
      name: 'xr_look_at',
      arguments: { device: 'headset', target: { x: 1, y: 1, z: 1 } },
    });
    expect(textOf(look as never)).toContain('headset');

    const select = await client.callTool({
      name: 'xr_select',
      arguments: { device: 'controller-right' },
    });
    expect(textOf(select as never)).toContain('controller-right');

    // The browser stand-in actually received each method with its params.
    const methods = browser.calls.map((c) => c.method);
    expect(methods).toEqual(
      expect.arrayContaining([
        'get_session_status',
        'accept_session',
        'look_at',
        'select',
      ]),
    );
    const lookCall = browser.calls.find((c) => c.method === 'look_at');
    expect(lookCall?.params).toMatchObject({
      device: 'headset',
      target: { x: 1, y: 1, z: 1 },
    });
  });

  it('returns screenshot as MCP image content', async () => {
    const shot = await client.callTool({
      name: 'browser_screenshot',
      arguments: {},
    });
    const content = (
      shot as {
        content: Array<{ type: string; mimeType?: string; data?: string }>;
      }
    ).content;
    const image = content.find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe('image/jpeg');
    expect(typeof image?.data).toBe('string');
  });

  it('errors cleanly when no browser is connected', async () => {
    // Disconnect the browser, then a call should surface the NoBrowser error.
    browser.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const res = (await client.callTool({
      name: 'xr_get_device_state',
      arguments: {},
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(res.isError).toBe(true);
    expect(textOf(res as never).toLowerCase()).toContain(
      'no immersive web emulator is connected',
    );
  });
});
