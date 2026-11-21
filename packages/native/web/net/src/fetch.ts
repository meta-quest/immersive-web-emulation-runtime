/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// fetch() (Fetch §5.6) for the native runtime. Scheme routing:
//   app origin (https://app.local)  → the packaged dist (NET-1..4): readAsset, 404 for missing files
//   data:                           → Fetch "data: URL processor" (NET-12)
//   blob:                           → the glue's blob URL store (NET-14/15)
//   http(s): other origins          → native HTTP/1.1 client, only if allowlisted (NET-5..7)
// No CORS checks (the app is packaged and trusted, NET-7), no cookie jar (credentials: 'include' sends
// no cookies and Set-Cookie is dropped), no HTTP cache. See README.md.

import { checkOrigin, parseAllowlist, BlockedOriginLog, type AllowEntry } from './allowlist.ts';
import { type ByteSource, InnerBody } from './body.ts';
import { abortReason, domException, type NetEnv } from './env.ts';
import { Headers, headerList, headersFromPairs } from './headers.ts';
import { HTTP_DATA, HTTP_END, HTTP_ERROR, HTTP_HEAD } from './natives.ts';
import { Request, requestState, type RequestInitLike } from './request.ts';
import { makeResponse, type Response } from './response.ts';

export interface FetchContext {
  env: NetEnv;
  appOrigin: string;
  allow: AllowEntry[];
  blocked: BlockedOriginLog;
}

export function makeFetchContext(env: NetEnv): FetchContext {
  return {
    env,
    appOrigin: new URL(env.config.origin).origin,
    allow: parseAllowlist(env.config.allow),
    blocked: new BlockedOriginLog(env.warn),
  };
}

function networkError(message: string, cause?: unknown): TypeError {
  const e = new TypeError(message);
  if (cause !== undefined) (e as { cause?: unknown }).cause = cause;
  return e;
}

export function fetchWith(ctx: FetchContext, input: Request | string | URL, init?: RequestInitLike): Promise<Response> {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch (e) {
    return Promise.reject(e);
  }
  const s = requestState(request);
  if (s.signal.aborted) {
    if (s.body && !s.body.unusable()) s.body.stream().cancel(abortReason(s.signal)).catch(() => {});
    return Promise.reject(abortReason(s.signal));
  }
  const url = s.url;
  // blob: URLs report their creator's origin too, so check the scheme first.
  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === ctx.appOrigin) return assetFetch(ctx, request);
  switch (url.protocol) {
    case 'data:':
      return dataFetch(request);
    case 'blob:':
      return blobFetch(ctx, request);
    case 'http:':
    case 'https:':
      return httpFetch(ctx, request);
    case 'about:':
      return Promise.reject(networkError(`Failed to fetch ${url.href}: about: URLs are not fetchable`));
    default:
      return Promise.reject(networkError(`Failed to fetch ${url.href}: unsupported scheme ${url.protocol}`));
  }
}

// --- assets (NET-1..4) -----------------------------------------------------------------------------

function assetFetch(ctx: FetchContext, request: Request): Promise<Response> {
  const s = requestState(request);
  const natives = ctx.env.natives;
  if (!natives) return Promise.reject(networkError('Failed to fetch: no native asset reader'));
  if (s.method !== 'GET' && s.method !== 'HEAD') {
    // A static server answers other methods with 405.
    return Promise.resolve(
      makeResponse({
        type: 'basic',
        status: 405,
        statusText: 'Method Not Allowed',
        headers: new Headers({ allow: 'GET, HEAD' }),
        body: InnerBody.fromBytes(new Uint8Array(0)),
        url: s.url.href,
      }),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortReason(s.signal));
    };
    s.signal.addEventListener('abort', onAbort, { once: true });
    natives.readAsset(s.url.pathname, (status, buffer, mime) => {
      s.signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (status === 200 && buffer) {
        const bytes = new Uint8Array(buffer);
        const headers = new Headers();
        headerList(headers).push(['content-length', String(bytes.byteLength)], ['content-type', mime]);
        resolve(
          makeResponse({
            type: 'basic',
            status: 200,
            statusText: 'OK',
            headers,
            body: s.method === 'HEAD' ? null : InnerBody.fromBytes(bytes),
            url: s.url.href,
          }),
        );
        return;
      }
      if (status === 404) {
        resolve(
          makeResponse({
            type: 'basic',
            status: 404,
            statusText: 'Not Found',
            headers: new Headers({ 'content-type': 'text/plain;charset=UTF-8' }),
            body: InnerBody.fromBytes(new Uint8Array(0)),
            url: s.url.href,
          }),
        );
        return;
      }
      reject(networkError(`Failed to fetch ${s.url.href}: asset read error`));
    });
  });
}

// --- data: (NET-12) ---------------------------------------------------------------------------------

const ASCII_WS = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

function percentDecodeBytes(s: string): Uint8Array {
  const raw = new TextEncoder().encode(s);
  const out = new Uint8Array(raw.length);
  let o = 0;
  const hex = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === 0x25 && i + 2 < raw.length && hex(raw[i + 1]) >= 0 && hex(raw[i + 2]) >= 0) {
      out[o++] = hex(raw[i + 1]) * 16 + hex(raw[i + 2]);
      i += 2;
    } else {
      out[o++] = c;
    }
  }
  return out.subarray(0, o);
}

/** Infra "forgiving-base64 decode"; null on failure. */
export function forgivingBase64Decode(input: string): Uint8Array | null {
  let s = input.replace(/[\t\n\f\r ]/g, '');
  if (s.length % 4 === 0) s = s.replace(/==?$/, '');
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buf = 0,
    bits = 0,
    o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 71 : c >= 48 && c <= 57 ? c + 4 : c === 43 ? 62 : 63;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Fetch §4.2 data: URL processor. */
export function processDataURL(href: string): { mime: string; body: Uint8Array } | null {
  const input = href.slice(5); // after "data:"
  const hashless = input.split('#')[0];
  const comma = hashless.indexOf(',');
  if (comma < 0) return null;
  let mime = hashless.slice(0, comma).replace(ASCII_WS, '');
  let body = percentDecodeBytes(hashless.slice(comma + 1));
  const b64 = /;[\x20]*base64$/i.exec(mime);
  if (b64) {
    const decoded = forgivingBase64Decode(new TextDecoder('latin1').decode(body));
    if (!decoded) return null;
    body = decoded;
    mime = mime.slice(0, b64.index);
  }
  if (mime.startsWith(';')) mime = 'text/plain' + mime;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.test(mime)) mime = 'text/plain;charset=US-ASCII';
  return { mime: mime.toLowerCase().replace(/\s*;\s*/g, ';'), body };
}

function dataFetch(request: Request): Promise<Response> {
  const s = requestState(request);
  const parsed = processDataURL(s.url.href);
  if (!parsed) return Promise.reject(networkError(`Failed to fetch: malformed data: URL`));
  const headers = new Headers();
  headerList(headers).push(['content-type', parsed.mime]);
  return Promise.resolve(
    makeResponse({ type: 'basic', status: 200, statusText: 'OK', headers, body: InnerBody.fromBytes(parsed.body), url: s.url.href }),
  );
}

// --- blob: (NET-14/15) --------------------------------------------------------------------------------

function blobFetch(ctx: FetchContext, request: Request): Promise<Response> {
  const s = requestState(request);
  if (s.method !== 'GET') return Promise.reject(networkError(`Failed to fetch ${s.url.href}: blob: URLs support GET only`));
  const blob = ctx.env.glue?.blobUrls?.resolve(s.url.href.split('#')[0]) ?? null; // File API: fragment ignored
  if (!blob) return Promise.reject(networkError(`Failed to fetch ${s.url.href}: unknown or revoked blob URL`));
  const headers = new Headers();
  headerList(headers).push(['content-length', String(blob.size)], ['content-type', blob.type]);
  return Promise.resolve(
    makeResponse({
      type: 'basic',
      status: 200,
      statusText: 'OK',
      headers,
      body: new InnerBody({ kind: 'blob', blob }, blob.size),
      url: s.url.href,
    }),
  );
}

// --- network (NET-5..7) ---------------------------------------------------------------------------------

/**
 * Native body chunks for one response. The native callback holds the sink; readers hold a NetworkBody
 * handle that points at it, never the other way round, so a response body nobody can read any more
 * becomes garbage and its native request is released (see `unreadBodies`).
 */
class NetworkSink {
  #queue: Uint8Array[] = [];
  #waiters: Array<{ resolve: (c: Uint8Array | null) => void; reject: (e: unknown) => void }> = [];
  #ended = false;
  #error: unknown = undefined;
  #onAck: (bytes: number) => void;
  #onCancel: () => void;
  constructor(onAck: (bytes: number) => void, onCancel: () => void) {
    this.#onAck = onAck;
    this.#onCancel = onCancel;
  }
  get ended(): boolean {
    return this.#ended;
  }
  push(chunk: Uint8Array): void {
    const w = this.#waiters.shift();
    if (w) {
      this.#onAck(chunk.byteLength);
      w.resolve(chunk);
    } else {
      this.#queue.push(chunk);
    }
  }
  end(): void {
    this.#ended = true;
    for (const w of this.#waiters.splice(0)) w.resolve(null);
  }
  fail(e: unknown): void {
    if (this.#ended) return;
    this.#error = e;
    this.#ended = true;
    for (const w of this.#waiters.splice(0)) w.reject(e);
  }
  read(): Promise<Uint8Array | null> {
    const c = this.#queue.shift();
    if (c) {
      this.#onAck(c.byteLength);
      return Promise.resolve(c);
    }
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
  cancel(): void {
    this.#queue = [];
    if (!this.#ended) {
      this.#ended = true;
      this.#onCancel();
    }
  }
}

/**
 * Bodies that became unreachable before they were read to the end (an ignored response, an abandoned
 * download): the native request is aborted so its connection, thread and per-origin slot are freed, as
 * browsers do when they collect an unread response. A body that is being read (a pending read() or
 * arrayBuffer()) stays reachable through the pending promise and is never collected.
 */
const unreadBodies: FinalizationRegistry<NetworkSink> | null =
  typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<NetworkSink>((sink) => sink.cancel()) : null;

/** What readers of a network body hold (the ByteSource of its InnerBody). */
class NetworkBody implements ByteSource {
  #sink: NetworkSink;
  constructor(sink: NetworkSink) {
    this.#sink = sink;
    unreadBodies?.register(this, sink, this);
  }
  async read(): Promise<Uint8Array | null> {
    const chunk = await this.#sink.read();
    if (chunk === null) unreadBodies?.unregister(this);
    return chunk;
  }
  cancel(): void {
    unreadBodies?.unregister(this);
    this.#sink.cancel();
  }
}

async function httpFetch(ctx: FetchContext, request: Request): Promise<Response> {
  const s = requestState(request);
  const env = ctx.env;
  const verdict = checkOrigin(ctx.allow, s.url, env.config.debug);
  if (verdict !== 'allowed') {
    ctx.blocked.report(s.url, verdict);
    throw networkError(`Failed to fetch ${s.url.href}: origin not allowed (native.network.allow)`);
  }
  const natives = env.natives;
  if (!natives) throw networkError('Failed to fetch: no native network transport');
  let body: Uint8Array | null = null;
  if (s.body) body = await s.body.consume(env);
  if (s.signal.aborted) throw abortReason(s.signal);
  const headers: string[] = [];
  for (const [n, v] of headerList(s.headers)) headers.push(n, v);
  if (!s.headers.has('user-agent') && env.config.userAgent) headers.push('user-agent', env.config.userAgent);
  if (!s.headers.has('accept')) headers.push('accept', '*/*');
  const redirect = s.redirect === 'error' ? 1 : s.redirect === 'manual' ? 2 : 0;
  // Fetch keeps the fragment in request.url but never sends it.
  const wireUrl = s.url.href.split('#')[0];

  return new Promise<Response>((resolve, reject) => {
    // The native callback must not keep the Response alive (it would pin an unread body forever), so
    // nothing it captures may reach it: the settle functions are dropped once used (a settled promise
    // holds its value), and it holds the body's sink, not the body.
    let settle: { resolve: (r: Response) => void; reject: (e: unknown) => void } | null = { resolve, reject };
    const settleWith = (r: Response | null, e?: unknown) => {
      const p = settle;
      settle = null;
      if (!p) return;
      if (r) p.resolve(r);
      else p.reject(e);
    };
    let headSeen = false;
    let done = false;
    let sink: NetworkSink | null = null;
    const onAbort = () => {
      if (done) return;
      done = true;
      natives.httpAbort(id);
      const reason = abortReason(s.signal);
      if (!headSeen) settleWith(null, reason);
      else sink?.fail(reason);
    };
    const id = natives.httpStart(
      { url: wireUrl, method: s.method, headers, body: body && body.byteLength ? body : null, redirect, timeoutMs: env.config.timeoutMs },
      (type: number, ...args: unknown[]) => {
        if (done && type !== HTTP_DATA) return;
        switch (type) {
          case HTTP_HEAD: {
            headSeen = true;
            const [status, statusText, flat, finalUrl, flags] = args as [number, string, string[], string, number];
            if (flags & 2) {
              done = true;
              s.signal.removeEventListener('abort', onAbort);
              settleWith(
                makeResponse({ type: 'opaqueredirect', status: 0, statusText: '', body: null, url: s.url.href, headersGuard: 'immutable' }),
              );
              return;
            }
            const nullBody = s.method === 'HEAD' || [101, 103, 204, 205, 304].includes(status);
            sink = new NetworkSink(
              (bytes) => natives.httpAck(id, bytes),
              () => {
                done = true;
                s.signal.removeEventListener('abort', onAbort);
                natives.httpAbort(id);
              },
            );
            const respHeaders = headersFromPairs(flat, 'immutable');
            const len = Number(respHeaders.get('content-length'));
            settleWith(
              makeResponse({
                type: 'cors',
                status,
                statusText,
                headers: respHeaders,
                body: nullBody ? null : InnerBody.fromSource(new NetworkBody(sink), Number.isFinite(len) ? len : null),
                url: finalUrl,
                redirected: (flags & 1) !== 0,
                env,
              }),
            );
            return;
          }
          case HTTP_DATA:
            if (sink && !done) sink.push(new Uint8Array(args[0] as ArrayBuffer));
            return;
          case HTTP_END:
            done = true;
            s.signal.removeEventListener('abort', onAbort);
            sink?.end();
            return;
          case HTTP_ERROR: {
            done = true;
            s.signal.removeEventListener('abort', onAbort);
            const [kind, message] = args as [string, string];
            const err =
              kind === 'aborted' && s.signal.aborted
                ? abortReason(s.signal)
                : networkError(`Failed to fetch ${s.url.href}: ${message || kind}`, { kind, message });
            if (kind === 'blocked') ctx.blocked.report(s.url, 'not-listed');
            if (!headSeen) settleWith(null, err);
            else sink?.fail(err);
            return;
          }
        }
      },
    );
    s.signal.addEventListener('abort', onAbort, { once: true });
  });
}

export { domException };
