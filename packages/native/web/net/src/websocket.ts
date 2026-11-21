/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// WHATWG WebSockets Standard `WebSocket` over the native RFC 6455 client (runtime/net/src/websocket.cc,
// TLS through the platform). Cross-origin sockets follow the same allowlist as fetch (NET-5): a blocked
// origin fails the connection (error + close 1006), it does not throw.

import { checkOrigin, type AllowEntry, type BlockedOriginLog } from './allowlist.ts';
import { domException, isBufferSource, makeBlob, type NetEnv, utf8Encode, blobToBytes } from './env.ts';
import { WS_CLOSE, WS_ERROR, WS_MESSAGE, WS_OPEN, WS_SENT, wsNatives } from './natives.ts';

export interface WebSocketContext {
  env: NetEnv;
  allow: AllowEntry[];
  blocked: BlockedOriginLog;
}

let wsContext: WebSocketContext | null = null;
export function setWebSocketContext(ctx: WebSocketContext | null): void {
  wsContext = ctx;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type Handler = ((this: WebSocket, ev: Event) => unknown) | null;

function getMessageEvent(): typeof MessageEvent {
  const g = globalThis as { MessageEvent?: typeof MessageEvent };
  if (g.MessageEvent) return g.MessageEvent;
  return class MessageEventShim extends Event {
    readonly data: unknown;
    readonly origin: string;
    readonly lastEventId = '';
    readonly source = null;
    readonly ports: readonly unknown[] = [];
    constructor(type: string, init: { data?: unknown; origin?: string } = {}) {
      super(type);
      this.data = init.data ?? null;
      this.origin = init.origin ?? '';
    }
  } as unknown as typeof MessageEvent;
}

/** WHATWG CloseEvent (installed when the glue does not provide one). */
export class CloseEvent extends Event {
  #wasClean: boolean;
  #code: number;
  #reason: string;
  constructor(type: string, init: { wasClean?: boolean; code?: number; reason?: string } & EventInit = {}) {
    super(type, init);
    this.#wasClean = !!init.wasClean;
    this.#code = (init.code ?? 0) & 0xffff;
    this.#reason = init.reason === undefined ? '' : String(init.reason);
  }
  get wasClean(): boolean {
    return this.#wasClean;
  }
  get code(): number {
    return this.#code;
  }
  get reason(): string {
    return this.#reason;
  }
}

function getCloseEvent(): typeof CloseEvent {
  return ((globalThis as unknown as { CloseEvent?: typeof CloseEvent }).CloseEvent ?? CloseEvent);
}

export class WebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  #url: string;
  #readyState = 0;
  #bufferedAmount = 0;
  #protocol = '';
  #extensions = '';
  #binaryType: 'blob' | 'arraybuffer' = 'blob';
  #id = 0;
  #ctx: WebSocketContext | null;
  #handlers: Record<string, Handler> = { open: null, message: null, error: null, close: null };
  #closeFired = false;
  // Blob payloads are read asynchronously; later sends (and close) queue behind them to keep order.
  #sendChain: Promise<void> = Promise.resolve();
  #pendingBlobs = 0;

  constructor(url: string | URL, protocols: string | string[] = []) {
    super();
    const ctx = wsContext;
    this.#ctx = ctx;
    const base = ctx ? ctx.env.baseURL() : undefined;
    let parsed: URL;
    try {
      parsed = base ? new URL(String(url), base) : new URL(String(url));
    } catch {
      throw domException(`Failed to construct 'WebSocket': The URL '${String(url)}' is invalid.`, 'SyntaxError');
    }
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw domException(`Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${parsed.protocol}' is not allowed.`, 'SyntaxError');
    }
    if (parsed.hash || String(url).includes('#')) {
      throw domException(`Failed to construct 'WebSocket': The URL contains a fragment identifier ('${parsed.hash}'). Fragment identifiers are not allowed in WebSocket URLs.`, 'SyntaxError');
    }
    const list = typeof protocols === 'string' ? [protocols] : [...protocols].map(String);
    const seen = new Set<string>();
    for (const p of list) {
      if (!TOKEN.test(p)) throw domException(`Failed to construct 'WebSocket': The subprotocol '${p}' is invalid.`, 'SyntaxError');
      if (seen.has(p.toLowerCase())) throw domException(`Failed to construct 'WebSocket': The subprotocol '${p}' is duplicated.`, 'SyntaxError');
      seen.add(p.toLowerCase());
    }
    this.#url = parsed.href;
    const natives = wsNatives(ctx?.env.natives);
    const verdict = ctx ? checkOrigin(ctx.allow, parsed, ctx.env.config.debug) : 'not-listed';
    if (!natives || verdict !== 'allowed') {
      if (ctx && verdict !== 'allowed') ctx.blocked.report(parsed, verdict);
      // Fail the connection asynchronously, as a network failure would.
      setTimeout(() => this.#fail(), 0);
      return;
    }
    this.#id = natives.wsConnect(this.#url, list, (type: number, ...args: unknown[]) => this.#onNative(type, args));
  }

  get url(): string {
    return this.#url;
  }
  get readyState(): number {
    return this.#readyState;
  }
  get bufferedAmount(): number {
    return this.#bufferedAmount;
  }
  get extensions(): string {
    return this.#extensions;
  }
  get protocol(): string {
    return this.#protocol;
  }
  get binaryType(): 'blob' | 'arraybuffer' {
    return this.#binaryType;
  }
  set binaryType(v: 'blob' | 'arraybuffer') {
    if (v === 'blob' || v === 'arraybuffer') this.#binaryType = v;
  }

  get onopen(): Handler {
    return this.#handlers.open;
  }
  set onopen(h: Handler) {
    this.#setHandler('open', h);
  }
  get onmessage(): Handler {
    return this.#handlers.message;
  }
  set onmessage(h: Handler) {
    this.#setHandler('message', h);
  }
  get onerror(): Handler {
    return this.#handlers.error;
  }
  set onerror(h: Handler) {
    this.#setHandler('error', h);
  }
  get onclose(): Handler {
    return this.#handlers.close;
  }
  set onclose(h: Handler) {
    this.#setHandler('close', h);
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.#readyState === WebSocket.CONNECTING) {
      throw domException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    }
    const natives = wsNatives(this.#ctx?.env.natives);
    let size: number;
    let payload: string | Uint8Array | Promise<Uint8Array>;
    if (typeof data === 'string') {
      const bytes = utf8Encode(data);
      size = bytes.byteLength;
      payload = data;
    } else if (isBufferSource(data)) {
      const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      size = view.byteLength;
      payload = view.slice();
    } else if (typeof Blob === 'function' && data instanceof Blob) {
      size = data.size;
      payload = this.#ctx ? blobToBytes(this.#ctx.env, data) : data.arrayBuffer().then((b) => new Uint8Array(b));
    } else {
      const s = String(data);
      size = utf8Encode(s).byteLength;
      payload = s;
    }
    // CLOSING/CLOSED: bufferedAmount grows, nothing is sent (WHATWG).
    this.#bufferedAmount += size;
    if (this.#readyState !== WebSocket.OPEN || !natives) return;
    const id = this.#id;
    if (payload instanceof Promise) {
      const p = payload;
      this.#pendingBlobs++;
      this.#sendChain = this.#sendChain.then(async () => {
        try {
          natives.wsSend(id, await p);
        } finally {
          this.#pendingBlobs--;
        }
      });
    } else if (this.#pendingBlobs > 0) {
      const send = payload;
      this.#sendChain = this.#sendChain.then(() => natives.wsSend(id, send));
    } else {
      natives.wsSend(id, payload);
    }
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined) {
      code = Number(code) & 0xffff;
      if (code !== 1000 && (code < 3000 || code > 4999)) {
        throw domException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, 'InvalidAccessError');
      }
    }
    let reasonText = '';
    if (reason !== undefined) {
      reasonText = String(reason);
      if (utf8Encode(reasonText).byteLength > 123) {
        throw domException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", 'SyntaxError');
      }
    }
    if (this.#readyState === WebSocket.CLOSING || this.#readyState === WebSocket.CLOSED) return;
    const natives = wsNatives(this.#ctx?.env.natives);
    if (this.#readyState === WebSocket.CONNECTING) {
      // "Fail the WebSocket connection": error + close(1006).
      this.#readyState = WebSocket.CLOSING;
      if (natives && this.#id) natives.wsClose(this.#id, 0, '');
      else setTimeout(() => this.#fail(), 0);
      return;
    }
    this.#readyState = WebSocket.CLOSING;
    const id = this.#id;
    const c = code ?? (reason !== undefined ? 1000 : 0);
    if (this.#pendingBlobs > 0) this.#sendChain = this.#sendChain.then(() => natives?.wsClose(id, c, reasonText));
    else natives?.wsClose(id, c, reasonText);
  }

  #setHandler(type: string, h: Handler): void {
    const old = this.#handlers[type];
    if (old) this.removeEventListener(type, old as EventListener);
    this.#handlers[type] = typeof h === 'function' ? h : null;
    if (typeof h === 'function') this.addEventListener(type, h as EventListener);
  }

  #onNative(type: number, args: unknown[]): void {
    switch (type) {
      case WS_OPEN: {
        if (this.#readyState !== WebSocket.CONNECTING) {
          // close() while connecting won the race; the native close follows.
          return;
        }
        this.#readyState = WebSocket.OPEN;
        this.#protocol = String(args[0] ?? '');
        this.#extensions = String(args[1] ?? '');
        this.dispatchEvent(new Event('open'));
        return;
      }
      case WS_MESSAGE: {
        if (this.#readyState !== WebSocket.OPEN) return;
        const [isText, payload] = args as [boolean, string | ArrayBuffer];
        let data: unknown = payload;
        if (!isText) {
          data =
            this.#binaryType === 'arraybuffer'
              ? payload
              : this.#ctx
                ? makeBlob(this.#ctx.env, new Uint8Array(payload as ArrayBuffer), '')
                : new Blob([payload as ArrayBuffer]);
        }
        const ME = getMessageEvent();
        this.dispatchEvent(new ME('message', { data, origin: new URL(this.#url).origin }));
        return;
      }
      case WS_SENT:
        this.#bufferedAmount = Math.max(0, this.#bufferedAmount - Number(args[0]));
        return;
      case WS_ERROR:
        if (this.#readyState !== WebSocket.CLOSED) this.dispatchEvent(new Event('error'));
        return;
      case WS_CLOSE: {
        const [code, reason, wasClean] = args as [number, string, boolean];
        this.#finish(code, reason, wasClean);
        return;
      }
    }
  }

  #fail(): void {
    if (this.#closeFired) return;
    this.dispatchEvent(new Event('error'));
    this.#finish(1006, '', false);
  }

  #finish(code: number, reason: string, wasClean: boolean): void {
    if (this.#closeFired) return;
    this.#closeFired = true;
    this.#readyState = WebSocket.CLOSED;
    const CE = getCloseEvent();
    this.dispatchEvent(new CE('close', { wasClean, code, reason }));
  }

  get [Symbol.toStringTag](): string {
    return 'WebSocket';
  }
}
