/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { installNet, type NetRegistry } from '../src/install.ts';
import type { NetNatives } from '../src/natives.ts';
import { BridgeNatives, type BridgeOptions } from './bridge-natives.ts';

export interface Setup {
  registry: NetRegistry;
  fetch: NetRegistry['fetch'];
  natives: NetNatives;
  warnings: string[];
  global: Record<string | symbol, unknown>;
}

/** Installs the net layer on a scratch global with the given natives. */
export function setup(natives: NetNatives | null, glue?: unknown): Setup {
  const warnings: string[] = [];
  const g: Record<string | symbol, unknown> = { navigator: {} };
  if (glue) g[Symbol.for('iwn.glue')] = glue;
  const registry = installNet(g as unknown as typeof globalThis, {
    natives,
    warn: (m) => warnings.push(m),
    mode: 'all',
  });
  return {
    registry,
    fetch: registry.fetch,
    natives: natives as NetNatives,
    warnings,
    global: g,
  };
}

export async function setupBridge(
  opts: BridgeOptions,
  glue?: unknown,
): Promise<Setup & { bridge: BridgeNatives }> {
  const bridge = new BridgeNatives(opts);
  await bridge.ready;
  return { ...setup(bridge, glue), bridge };
}

/** A fixture dist: _app/x.js, .well-known/y.json, ü.txt, a big binary, index.html. */
export function makeDist(bigBytes = 5 * 1024 * 1024 + 3): {
  dir: string;
  big: Buffer;
  sha: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'iwn-dist-'));
  mkdirSync(join(dir, '_app'));
  mkdirSync(join(dir, '.well-known'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, '_app', 'x.js'), 'export const x = 1;\n');
  writeFileSync(join(dir, '.well-known', 'y.json'), '{"y":2}');
  writeFileSync(join(dir, 'ü.txt'), 'umlaut');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  const big = Buffer.alloc(bigBytes);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  writeFileSync(join(dir, 'assets', 'model.glb'), big);
  return { dir, big, sha: createHash('sha256').update(big).digest('hex') };
}

export function sha256(bytes: ArrayBuffer | Uint8Array): string {
  return createHash('sha256')
    .update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .digest('hex');
}

export interface TestHttpServer {
  server: Server;
  port: number;
  origin: string;
  requests: Array<{
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: Buffer;
  }>;
  close(): Promise<void>;
}

export async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<TestHttpServer> {
  const requests: TestHttpServer['requests'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A full garbage collection on demand (works without node --expose-gc). */
export function exposeGc(): () => void {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing) return existing;
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}
