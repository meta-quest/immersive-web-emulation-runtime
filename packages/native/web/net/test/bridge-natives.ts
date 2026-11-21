/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// NetNatives backed by the real C++ net core (runtime/net, iwn_net_bridge over stdio). The bridge is
// built by scripts/build-bridge.mjs (npm pretest) into .bridge-build/.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { NativeHttpRequest, NativeSyncResponse, NetConfig, NetNatives } from '../src/natives.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const BRIDGE = process.env.IWN_NET_BRIDGE ?? join(here, '..', '.bridge-build', 'iwn_net_bridge');
export const bridgeAvailable = existsSync(BRIDGE);

const b64 = (s: string | Uint8Array): string => {
  const buf = typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s.buffer, s.byteOffset, s.byteLength);
  return buf.length ? buf.toString('base64') : '-';
};
const unb64 = (s: string): Buffer => (s === '-' ? Buffer.alloc(0) : Buffer.from(s, 'base64'));
const toArrayBuffer = (b: Buffer): ArrayBuffer => {
  const ab = new ArrayBuffer(b.length);
  new Uint8Array(ab).set(b);
  return ab;
};

export interface BridgeOptions {
  assets: string;
  allow?: string[];
  debug?: boolean;
  origin?: string;
  timeoutMs?: number;
  /**
   * Behave like a worker isolate's natives: httpSync/readAssetSync exist and block (each runs the
   * bridge once in --once mode through spawnSync, so the C++ FetchBlocking path is what answers).
   */
  worker?: boolean;
}

export class BridgeNatives implements NetNatives {
  #proc: ChildProcessWithoutNullStreams;
  #next = 1;
  #handlers = new Map<number, (fields: string[]) => void>();
  #config: NetConfig;
  ready: Promise<void>;
  /** Every command line sent (assertions on what JS asked for). */
  sent: string[] = [];
  httpSync?: NetNatives['httpSync'];
  readAssetSync?: NetNatives['readAssetSync'];

  constructor(opts: BridgeOptions) {
    const args = ['--assets', opts.assets];
    if (opts.allow?.length) args.push('--allow', opts.allow.join(','));
    if (opts.debug) args.push('--debug');
    this.#config = {
      allow: opts.allow ?? [],
      debug: !!opts.debug,
      origin: opts.origin ?? 'https://app.local',
      userAgent: 'iwer-native-test',
      timeoutMs: opts.timeoutMs ?? 60000,
    };
    this.#proc = spawn(BRIDGE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    if (opts.worker) {
      const once = (line: string): string[] => {
        const r = spawnSync(BRIDGE, [...args, '--once'], { input: line + '\n', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        return r.stdout.split('\n').filter(Boolean);
      };
      this.httpSync = (req): NativeSyncResponse => {
        let body = '-';
        if (req.body) {
          const v = ArrayBuffer.isView(req.body) ? new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength) : new Uint8Array(req.body);
          body = b64(v);
        }
        const lines = once(
          `H 1 ${b64(req.url)} ${b64(req.method)} ${req.redirect} ${req.timeoutMs ?? 0} ${b64(req.headers.join('\0'))} ${body} ${req.totalTimeoutMs ?? 0}`,
        );
        const out = { status: 0, statusText: '', headers: [] as string[], url: '', flags: 0, body: new ArrayBuffer(0) };
        for (const l of lines) {
          const f = l.split(' ');
          if (f[0] === 'x') return { errorKind: f[2], errorMessage: unb64(f[3]).toString('utf8') };
          if (f[0] === 'h') {
            const flat = unb64(f[4]).toString('utf8');
            Object.assign(out, { status: Number(f[2]), statusText: unb64(f[3]).toString('utf8'), headers: flat ? flat.split('\0') : [], url: unb64(f[5]).toString('utf8'), flags: Number(f[6]) });
          }
          if (f[0] === 'd') out.body = toArrayBuffer(unb64(f[2]));
        }
        return out;
      };
      this.readAssetSync = (urlPath) => {
        const [l] = once(`A 1 ${b64(urlPath)}`);
        const f = l.split(' ');
        const status = Number(f[2]);
        return { status, buffer: status === 200 ? toArrayBuffer(unb64(f[4])) : null, mime: unb64(f[3]).toString('utf8') };
      };
    }
    const rl = createInterface({ input: this.#proc.stdout });
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    rl.on('line', (line) => {
      if (line === 'ready') return resolveReady();
      const fields = line.split(' ');
      const id = Number(fields[1]);
      this.#handlers.get(id)?.(fields);
    });
  }

  #send(line: string): void {
    this.sent.push(line);
    this.#proc.stdin.write(line + '\n');
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#proc.once('exit', () => resolve());
      this.#proc.stdin.write('Q 0\n');
      this.#proc.stdin.end();
    });
  }

  config(): NetConfig {
    return this.#config;
  }

  readAsset(urlPath: string, cb: (status: number, buffer: ArrayBuffer | null, mime: string, mapped: boolean) => void): void {
    const id = this.#next++;
    this.#handlers.set(id, (f) => {
      this.#handlers.delete(id);
      const status = Number(f[2]);
      cb(status, status === 200 ? toArrayBuffer(unb64(f[4])) : null, unb64(f[3]).toString('utf8'), f[5] === '1');
    });
    this.#send(`A ${id} ${b64(urlPath)}`);
  }

  httpStart(req: NativeHttpRequest, onEvent: (type: number, ...args: unknown[]) => void): number {
    const id = this.#next++;
    this.#handlers.set(id, (f) => {
      switch (f[0]) {
        case 'h': {
          const flat = unb64(f[4]).toString('utf8');
          const headers = flat.length ? flat.split('\0') : [];
          onEvent(1, Number(f[2]), unb64(f[3]).toString('utf8'), headers, unb64(f[5]).toString('utf8'), Number(f[6]));
          break;
        }
        case 'd':
          onEvent(2, toArrayBuffer(unb64(f[2])));
          break;
        case 'e':
          this.#handlers.delete(id);
          onEvent(3);
          break;
        case 'x':
          this.#handlers.delete(id);
          onEvent(4, f[2], unb64(f[3]).toString('utf8'));
          break;
      }
    });
    let body = '-';
    if (req.body) {
      const v = ArrayBuffer.isView(req.body) ? new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength) : new Uint8Array(req.body);
      body = b64(v);
    }
    this.#send(`H ${id} ${b64(req.url)} ${b64(req.method)} ${req.redirect} ${req.timeoutMs ?? 0} ${b64(req.headers.join('\0'))} ${body}`);
    return id;
  }

  httpAck(id: number, bytes: number): void {
    this.#send(`K ${id} ${bytes}`);
  }

  httpAbort(id: number): void {
    this.#send(`X ${id}`);
  }

  wsConnect(url: string, protocols: string[], onEvent: (type: number, ...args: unknown[]) => void): number {
    const id = this.#next++;
    this.#handlers.set(id, (f) => {
      switch (f[0]) {
        case 'o':
          onEvent(1, unb64(f[2]).toString('utf8'), unb64(f[3]).toString('utf8'));
          break;
        case 'm':
          onEvent(2, f[2] === 't', f[2] === 't' ? unb64(f[3]).toString('utf8') : toArrayBuffer(unb64(f[3])));
          break;
        case 's':
          onEvent(3, Number(f[2]));
          break;
        case 'w':
          onEvent(4, f[2], unb64(f[3]).toString('utf8'));
          break;
        case 'c':
          this.#handlers.delete(id);
          onEvent(5, Number(f[2]), unb64(f[3]).toString('utf8'), f[4] === '1');
          break;
      }
    });
    this.#send(`W ${id} ${b64(url)} ${b64(protocols.join('\0'))}`);
    return id;
  }

  wsSend(id: number, data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.#send(`S ${id} t ${b64(data)}`);
    } else {
      const v = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      this.#send(`S ${id} b ${b64(v)}`);
    }
  }

  wsClose(id: number, code: number, reason: string): void {
    this.#send(`C ${id} ${code} ${b64(reason)}`);
  }
}
