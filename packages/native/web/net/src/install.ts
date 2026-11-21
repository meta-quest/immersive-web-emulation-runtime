/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Installs the network globals on a window or worker global: fetch, Headers, Request, Response,
// XMLHttpRequest(+Upload), the WHATWG Streams classes when missing, WebSocket + CloseEvent (only when
// the native WebSocket transport is opted in: experimental, outside the alpha surface), and
// navigator.onLine (NET-8, SHOULD: always true until a connectivity native exists).
// Publishes internals at globalThis[Symbol.for('iwn.net')] for other runtime JS (images, modules,
// Cache API, the headless runner).

import { makeEnv, type NetEnv } from './env.ts';
import { fetchWith, makeFetchContext, type FetchContext } from './fetch.ts';
import { wsNatives, type NetNatives } from './natives.ts';
import { Request, setRequestEnv, type RequestInitLike } from './request.ts';
import { InnerBody } from './body.ts';
import { Headers, headerList } from './headers.ts';
import { makeResponse, Response, type ResponseType } from './response.ts';
import { installStreams } from './streams.ts';
import { CloseEvent, setWebSocketContext, WebSocket } from './websocket.ts';
import { setXhrContext, XMLHttpRequest, XMLHttpRequestUpload } from './xhr.ts';

export const NET_REGISTRY_KEY: unique symbol = Symbol.for('iwn.net') as never;

export interface NetRegistry {
  env: NetEnv;
  context: FetchContext;
  fetch: (input: Request | string | URL, init?: RequestInitLike) => Promise<Response>;
  /** Origins blocked so far this session (debug endpoint `stats`, headless runner report). */
  blockedOrigins(): string[];
  installed: string[];
  /**
   * Builds a Response the way fetch does (any status incl. 0, type, url, redirected, immutable headers).
   * The Cache API uses it to restore stored responses exactly.
   */
  makeResponse(init: StoredResponseInit): Response;
}

export interface StoredResponseInit {
  type: ResponseType;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
  url: string;
  redirected: boolean;
}

export interface InstallNetOptions {
  natives?: NetNatives | null;
  warn?: (message: string) => void;
  /** 'missing' (default) keeps globals the engine already has; 'all' replaces them. */
  mode?: 'missing' | 'all';
}

function define(g: object, name: string, value: unknown, installed: string[], mode: 'missing' | 'all'): void {
  if (mode === 'missing' && (g as Record<string, unknown>)[name] !== undefined) return;
  Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
  installed.push(name);
}

export function installNet(g: typeof globalThis, options: InstallNetOptions = {}): NetRegistry {
  const natives =
    options.natives !== undefined ? options.natives : ((g as { __iwn?: { net?: NetNatives } }).__iwn?.net ?? null);
  const mode = options.mode ?? 'missing';
  const env = makeEnv(g, natives, options.warn);
  const context = makeFetchContext(env);
  setRequestEnv(env);
  setWebSocketContext(context);
  setXhrContext(context);
  const installed = installStreams(g);
  const fetch = function fetch(input: Request | string | URL, init?: RequestInitLike): Promise<Response> {
    return fetchWith(context, input, init);
  };
  define(g, 'fetch', fetch, installed, mode);
  define(g, 'Headers', Headers, installed, mode);
  define(g, 'Request', Request, installed, mode);
  define(g, 'Response', Response, installed, mode);
  // WebSocket is not part of the alpha surface: installed only over an opted-in native transport, so
  // pages can feature-detect it (`typeof WebSocket === 'undefined'`) instead of meeting a half-working one.
  if (wsNatives(natives)) {
    define(g, 'WebSocket', WebSocket, installed, mode);
    define(g, 'CloseEvent', CloseEvent, installed, 'missing');
  }
  define(g, 'XMLHttpRequest', XMLHttpRequest, installed, mode);
  define(g, 'XMLHttpRequestUpload', XMLHttpRequestUpload, installed, mode);
  const nav = (g as { navigator?: object }).navigator;
  if (nav && !('onLine' in nav)) {
    Object.defineProperty(nav, 'onLine', { get: () => true, configurable: true, enumerable: true });
  }
  const registry: NetRegistry = {
    env,
    context,
    fetch,
    blockedOrigins: () => context.blocked.blocked,
    installed,
    makeResponse(init) {
      const headers = new Headers();
      for (const [n, v] of init.headers) headerList(headers).push([n.toLowerCase(), v]);
      return makeResponse({
        type: init.type,
        status: init.status,
        statusText: init.statusText,
        headers,
        headersGuard: 'immutable',
        body: init.body ? InnerBody.fromBytes(init.body) : null,
        url: init.url,
        redirected: init.redirected,
        env,
      });
    },
  };
  Object.defineProperty(g, NET_REGISTRY_KEY, { value: registry, configurable: true });
  return registry;
}
