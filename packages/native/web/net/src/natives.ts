/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The native net module as JS sees it: `globalThis.__iwn.net`, installed by
 * `iwn_register_net` (runtime/net/binding/net_binding.cc). Every callback runs
 * as a task on the isolate's JS thread. Tests provide fakes with the same
 * shape (test/bridge-natives.ts drives the real C++ core over stdio).
 */
export interface NetNatives {
  config(): NetConfig;
  /**
   * Reads one file of the app's dist by URL path ("/assets/a.js", percent-encoded).
   * status 200 (buffer = the bytes, possibly a private file mapping), 404 (missing
   * or outside the dist) or 500 (I/O error).
   */
  readAsset(
    urlPath: string,
    cb: (
      status: number,
      buffer: ArrayBuffer | null,
      mime: string,
      mapped: boolean,
    ) => void,
  ): void;
  httpStart(
    request: NativeHttpRequest,
    onEvent: (type: number, ...args: unknown[]) => void,
  ): number;
  /** The consumer took `bytes` of delivered body; lets the native reader continue. */
  httpAck(id: number, bytes: number): void;
  httpAbort(id: number): void;
  /**
   * WebSocket transport. Outside the alpha's supported surface: present only when the app opts in
   * ("network": {"experimentalWebSocket": true}); without it the WebSocket global is not installed.
   */
  wsConnect?(
    url: string,
    protocols: string[],
    onEvent: (type: number, ...args: unknown[]) => void,
  ): number;
  wsSend?(id: number, data: string | ArrayBuffer | ArrayBufferView): void;
  /** code 0 = no status code. */
  wsClose?(id: number, code: number, reason: string): void;
  /**
   * Blocking request (synchronous XHR, NET-11). Present only where blocking is allowed: worker
   * isolates. The page isolate has no httpSync, which is how the JS layer knows to refuse synchronous
   * requests there. `totalTimeoutMs` (0 = none) bounds the whole request (XHR `timeout`).
   */
  httpSync?(
    request: NativeHttpRequest & { totalTimeoutMs?: number },
  ): NativeSyncResponse;
  /** Blocking asset read (worker isolates only), same results as readAsset. */
  readAssetSync?(urlPath: string): {
    status: number;
    buffer: ArrayBuffer | null;
    mime: string;
  };
}

export type WsNatives = Required<
  Pick<NetNatives, 'wsConnect' | 'wsSend' | 'wsClose'>
>;

/** The WebSocket transport when the native module has it (experimental opt-in), else null. */
export function wsNatives(n: NetNatives | null | undefined): WsNatives | null {
  return n &&
    typeof n.wsConnect === 'function' &&
    typeof n.wsSend === 'function' &&
    typeof n.wsClose === 'function'
    ? (n as WsNatives)
    : null;
}

export type NativeSyncResponse =
  | {
      status: number;
      statusText: string;
      headers: string[];
      url: string;
      flags: number;
      body: ArrayBuffer;
      errorKind?: undefined;
    }
  | { errorKind: string; errorMessage: string };

export interface NetConfig {
  /** native.network.allow (NET-5). */
  allow: string[];
  /** Debug build: cleartext to loopback may be allowlisted. */
  debug: boolean;
  /** The app's origin, e.g. "https://app.local". */
  origin: string;
  userAgent: string;
  timeoutMs: number;
}

export interface NativeHttpRequest {
  url: string;
  method: string;
  /** name, value, name, value, ... */
  headers: string[];
  body?: ArrayBuffer | ArrayBufferView | null;
  /** 0 follow, 1 error, 2 manual */
  redirect: number;
  timeoutMs?: number;
}

/** httpStart events. */
export const HTTP_HEAD = 1; // (status, statusText, headers[], url, flags: 1 redirected | 2 opaque-redirect)
export const HTTP_DATA = 2; // (ArrayBuffer)
export const HTTP_END = 3; // ()
export const HTTP_ERROR = 4; // (kind, message)

/** wsConnect events. */
export const WS_OPEN = 1; // (protocol, extensions)
export const WS_MESSAGE = 2; // (isText, string | ArrayBuffer)
export const WS_SENT = 3; // (bytes)
export const WS_ERROR = 4; // (kind, message)
export const WS_CLOSE = 5; // (code, reason, wasClean)
