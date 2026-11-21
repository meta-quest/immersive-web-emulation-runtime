/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XMLHttpRequest Living Standard over this runtime's fetch (NET-11): asynchronous requests with the
// standard readyState/progress/load/error/abort/timeout event sequence, responseType '', 'text',
// 'arraybuffer', 'blob', 'json'. Synchronous requests (`open(..., false)`) work in workers, over the
// natives' blocking httpSync/readAssetSync (which exist only in worker isolates). Deliberate deviation
// on the main thread (documented on the developer page): every synchronous open throws
// InvalidAccessError, because a blocking request would stall the XR frame loop; the standard throws
// only when timeout/responseType are set.

import { checkOrigin } from './allowlist.ts';
import { domException, type NetEnv, utf8Decode } from './env.ts';
import { fetchWith, processDataURL, type FetchContext } from './fetch.ts';
import {
  Headers,
  headerList,
  headersFromPairs,
  isForbiddenRequestHeader,
} from './headers.ts';
import { InnerBody, mimeEssence } from './body.ts';
import { Request, requestState } from './request.ts';
import { makeResponse, type Response } from './response.ts';

let xhrContext: FetchContext | null = null;
export function setXhrContext(ctx: FetchContext | null): void {
  xhrContext = ctx;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const EVENTS = [
  'loadstart',
  'progress',
  'abort',
  'error',
  'load',
  'timeout',
  'loadend',
] as const;

type Handler = ((this: unknown, ev: Event) => unknown) | null;

function progressEvent(
  type: string,
  loaded: number,
  total: number,
  computable: boolean,
): Event {
  const PE = (globalThis as { ProgressEvent?: typeof ProgressEvent })
    .ProgressEvent;
  if (PE) return new PE(type, { lengthComputable: computable, loaded, total });
  const e = new Event(type) as Event & {
    loaded: number;
    total: number;
    lengthComputable: boolean;
  };
  Object.defineProperties(e, {
    loaded: { value: loaded },
    total: { value: total },
    lengthComputable: { value: computable },
  });
  return e;
}

class XHREventTarget extends EventTarget {
  // Defined on the prototype below.
  declare onloadstart: Handler;
  declare onprogress: Handler;
  declare onabort: Handler;
  declare onerror: Handler;
  declare onload: Handler;
  declare ontimeout: Handler;
  declare onloadend: Handler;
  #handlers = new Map<string, Handler>();
  protected handler(type: string): Handler {
    return this.#handlers.get(type) ?? null;
  }
  protected setHandler(type: string, h: Handler): void {
    const old = this.#handlers.get(type);
    if (old) this.removeEventListener(type, old as EventListener);
    if (typeof h === 'function') {
      this.#handlers.set(type, h);
      this.addEventListener(type, h as EventListener);
    } else {
      this.#handlers.delete(type);
    }
  }
}
for (const t of EVENTS) {
  Object.defineProperty(XHREventTarget.prototype, 'on' + t, {
    get(this: XHREventTarget) {
      return this.handler(t);
    },
    set(this: XHREventTarget, h: Handler) {
      this.setHandler(t, h);
    },
    configurable: true,
    enumerable: true,
  });
}

export class XMLHttpRequestUpload extends XHREventTarget {
  get [Symbol.toStringTag](): string {
    return 'XMLHttpRequestUpload';
  }
}

export class XMLHttpRequest extends XHREventTarget {
  static readonly UNSENT = 0;
  static readonly OPENED = 1;
  static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3;
  static readonly DONE = 4;
  readonly UNSENT = 0;
  readonly OPENED = 1;
  readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3;
  readonly DONE = 4;

  #ctx: FetchContext | null = xhrContext;
  #state = 0;
  #send = false;
  #method = 'GET';
  #url: URL | null = null;
  #headers: Array<[string, string]> = [];
  #timeout = 0;
  #withCredentials = false;
  #responseType: XMLHttpRequestResponseType = '';
  #overrideMime: string | null = null;
  #upload = new XMLHttpRequestUpload();
  #response: Response | null = null;
  #status = 0;
  #statusText = '';
  #responseURL = '';
  #chunks: Uint8Array[] = [];
  #received = 0;
  #bytes: Uint8Array | null = null;
  #responseObject: unknown = undefined;
  #error = false;
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;
  #sync = false;

  get onreadystatechange(): Handler {
    return this.handler('readystatechange');
  }
  set onreadystatechange(h: Handler) {
    this.setHandler('readystatechange', h);
  }

  get readyState(): number {
    return this.#state;
  }
  get upload(): XMLHttpRequestUpload {
    return this.#upload;
  }
  get timeout(): number {
    return this.#timeout;
  }
  set timeout(v: number) {
    this.#timeout = Math.max(0, Number(v) >>> 0);
  }
  get withCredentials(): boolean {
    return this.#withCredentials;
  }
  set withCredentials(v: boolean) {
    if (this.#state !== 0 && this.#state !== 1)
      throw domException(
        'withCredentials can only be set before send()',
        'InvalidStateError',
      );
    if (this.#send)
      throw domException(
        'withCredentials can only be set before send()',
        'InvalidStateError',
      );
    this.#withCredentials = !!v;
  }
  get responseType(): XMLHttpRequestResponseType {
    return this.#responseType;
  }
  set responseType(v: XMLHttpRequestResponseType) {
    if (this.#state === 3 || this.#state === 4)
      throw domException(
        'responseType cannot be set after loading started',
        'InvalidStateError',
      );
    if (['', 'arraybuffer', 'blob', 'document', 'json', 'text'].includes(v))
      this.#responseType = v;
  }
  get status(): number {
    return this.#status;
  }
  get statusText(): string {
    return this.#statusText;
  }
  get responseURL(): string {
    return this.#responseURL;
  }

  open(
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    method = String(method);
    if (!TOKEN.test(method))
      throw domException(
        `'${method}' is not a valid HTTP method.`,
        'SyntaxError',
      );
    const upper = method.toUpperCase();
    if (upper === 'CONNECT' || upper === 'TRACE' || upper === 'TRACK')
      throw domException(
        `'${method}' HTTP method is unsupported.`,
        'SecurityError',
      );
    if (['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'].includes(upper))
      method = upper;
    let parsed: URL;
    try {
      const base = this.#ctx?.env.baseURL();
      parsed = base ? new URL(String(url), base) : new URL(String(url));
    } catch {
      throw domException(`Invalid URL '${String(url)}'`, 'SyntaxError');
    }
    if (username !== undefined && username !== null)
      parsed.username = String(username);
    if (password !== undefined && password !== null)
      parsed.password = String(password);
    const sync = arguments.length >= 3 && !async;
    if (sync && typeof this.#ctx?.env.natives?.httpSync !== 'function') {
      throw domException(
        'Synchronous XMLHttpRequest is not supported on the main thread of the native runtime (it would block the XR frame loop); use async requests, fetch(), or a worker.',
        'InvalidAccessError',
      );
    }
    this.#terminate();
    this.#sync = sync;
    this.#method = method;
    this.#url = parsed;
    this.#headers = [];
    this.#send = false;
    this.#resetResponse();
    if (this.#state !== 1) {
      this.#state = 1;
      this.dispatchEvent(new Event('readystatechange'));
    }
  }

  setRequestHeader(name: string, value: string): void {
    if (this.#state !== 1 || this.#send)
      throw domException(
        "Failed to execute 'setRequestHeader': The object's state must be OPENED.",
        'InvalidStateError',
      );
    name = String(name);
    value = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (!TOKEN.test(name))
      throw domException(
        `'${name}' is not a valid HTTP header field name.`,
        'SyntaxError',
      );
    if (/[\0\r\n]/.test(value))
      throw domException(
        `'${value}' is not a valid HTTP header field value.`,
        'SyntaxError',
      );
    const lower = name.toLowerCase();
    if (isForbiddenRequestHeader(lower, value)) return;
    const existing = this.#headers.find(([n]) => n === lower);
    if (existing) existing[1] = existing[1] + ', ' + value;
    else this.#headers.push([lower, value]);
  }

  overrideMimeType(mime: string): void {
    if (this.#state === 3 || this.#state === 4)
      throw domException(
        'overrideMimeType() cannot be called after loading started',
        'InvalidStateError',
      );
    this.#overrideMime =
      mimeEssence(String(mime)) || 'application/octet-stream';
  }

  send(body: unknown = null): void {
    if (this.#state !== 1 || this.#send)
      throw domException(
        "Failed to execute 'send': The object's state must be OPENED.",
        'InvalidStateError',
      );
    const ctx = this.#ctx;
    const url = this.#url!;
    if (this.#method === 'GET' || this.#method === 'HEAD') body = null;
    if (this.#sync) return this.#sendSync(body);
    this.#send = true;
    this.#error = false;
    const gen = ++this.#generation;
    const ac = new AbortController();
    this.#abort = ac;
    const hasUploadBody = body !== null && body !== undefined;
    this.dispatchEvent(progressEvent('loadstart', 0, 0, false));
    if (hasUploadBody)
      this.#upload.dispatchEvent(progressEvent('loadstart', 0, 0, false));
    if (!ctx) {
      queueMicrotask(() => this.#requestError(gen, 'error'));
      return;
    }
    if (this.#timeout > 0) {
      this.#timer = setTimeout(() => {
        if (gen !== this.#generation || !this.#send) return;
        ac.abort();
        this.#requestError(gen, 'timeout');
      }, this.#timeout);
    }
    const doc =
      typeof body === 'object' &&
      body !== null &&
      (body as { nodeType?: number }).nodeType === 9;
    const init = {
      method: this.#method,
      headers: this.#headers,
      body: doc ? String(body) : (body as BodyInit | null),
      signal: ac.signal,
      credentials: this.#withCredentials ? 'include' : 'same-origin',
      duplex: 'half',
    };
    fetchWith(ctx, url.href, init).then(
      (resp) => this.#onResponse(gen, resp, hasUploadBody),
      () => {
        if (gen === this.#generation && this.#send)
          this.#requestError(gen, 'error');
      },
    );
  }

  abort(): void {
    const gen = this.#generation;
    this.#terminate();
    if (
      (this.#state === 1 && this.#send) ||
      this.#state === 2 ||
      this.#state === 3
    ) {
      this.#requestError(gen, 'abort');
    }
    if (this.#state === 4) {
      this.#state = 0;
      this.#resetResponse();
    }
  }

  getResponseHeader(name: string): string | null {
    if (!this.#response || this.#error) return null;
    return this.#response.headers.get(String(name));
  }

  getAllResponseHeaders(): string {
    if (!this.#response || this.#error) return '';
    let out = '';
    for (const [n, v] of this.#response.headers) out += `${n}: ${v}\r\n`;
    return out;
  }

  get responseText(): string {
    if (this.#responseType !== '' && this.#responseType !== 'text') {
      throw domException(
        "The value is only accessible if the object's 'responseType' is '' or 'text'.",
        'InvalidStateError',
      );
    }
    if (this.#state !== 3 && this.#state !== 4) return '';
    return this.#text();
  }

  get response(): unknown {
    if (this.#responseType === '' || this.#responseType === 'text')
      return this.responseText;
    if (this.#state !== 4 || this.#error) return null;
    if (this.#responseObject !== undefined) return this.#responseObject;
    const bytes = this.#allBytes();
    switch (this.#responseType) {
      case 'arraybuffer':
        this.#responseObject =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
        break;
      case 'blob':
        this.#responseObject = new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: this.#finalMime(),
        });
        break;
      case 'json':
        try {
          this.#responseObject = JSON.parse(utf8Decode(bytes));
        } catch {
          this.#responseObject = null;
        }
        break;
      default:
        this.#responseObject = null;
    }
    return this.#responseObject;
  }

  get responseXML(): null {
    return null;
  }

  // --- internals ---

  #finalMime(): string {
    return (
      this.#overrideMime ??
      mimeEssence(this.#response?.headers.get('content-type') ?? null)
    );
  }

  #allBytes(): Uint8Array {
    if (!this.#bytes) {
      const out = new Uint8Array(this.#received);
      let o = 0;
      for (const c of this.#chunks) {
        out.set(c, o);
        o += c.byteLength;
      }
      this.#bytes = this.#chunks.length === 1 ? this.#chunks[0] : out;
    }
    return this.#bytes;
  }

  #text(): string {
    return utf8Decode(this.#allBytes());
  }

  #resetResponse(): void {
    this.#response = null;
    this.#status = 0;
    this.#statusText = '';
    this.#responseURL = '';
    this.#chunks = [];
    this.#received = 0;
    this.#bytes = null;
    this.#responseObject = undefined;
  }

  #terminate(): void {
    this.#generation++;
    if (this.#abort) this.#abort.abort();
    this.#abort = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #onResponse(
    gen: number,
    resp: Response,
    hadUpload: boolean,
  ): Promise<void> {
    if (gen !== this.#generation) return;
    if (hadUpload) {
      this.#upload.dispatchEvent(progressEvent('progress', 0, 0, false));
      this.#upload.dispatchEvent(progressEvent('load', 0, 0, false));
      this.#upload.dispatchEvent(progressEvent('loadend', 0, 0, false));
    }
    this.#response = resp;
    this.#status = resp.status;
    this.#statusText = resp.statusText;
    this.#responseURL = resp.url;
    this.#state = 2;
    this.dispatchEvent(new Event('readystatechange'));
    if (gen !== this.#generation) return;
    const total = Number(resp.headers.get('content-length')) || 0;
    const body = resp.body;
    if (body) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (gen !== this.#generation) {
            reader.cancel().catch(() => {});
            return;
          }
          if (done) break;
          this.#chunks.push(value);
          this.#received += value.byteLength;
          this.#bytes = null;
          if (this.#state === 2) this.#state = 3;
          this.dispatchEvent(new Event('readystatechange'));
          this.dispatchEvent(
            progressEvent('progress', this.#received, total, total > 0),
          );
        }
      } catch {
        if (gen === this.#generation) this.#requestError(gen, 'error');
        return;
      }
    }
    if (gen !== this.#generation) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#state = 4;
    this.#send = false;
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(progressEvent('load', this.#received, total, total > 0));
    this.dispatchEvent(
      progressEvent('loadend', this.#received, total, total > 0),
    );
  }

  /** XHR send() with the synchronous flag (workers): blocks until the response is complete. */
  #sendSync(body: unknown): void {
    const ctx = this.#ctx!;
    const url = this.#url!;
    this.#send = true;
    this.#error = false;
    const gen = ++this.#generation;
    let request: Request;
    try {
      const doc =
        typeof body === 'object' &&
        body !== null &&
        (body as { nodeType?: number }).nodeType === 9;
      request = new Request(url.href, {
        method: this.#method,
        headers: this.#headers,
        body: doc ? String(body) : (body as BodyInit | null),
        credentials: this.#withCredentials ? 'include' : 'same-origin',
      });
    } catch (e) {
      return this.#syncError(
        gen,
        'NetworkError',
        `XMLHttpRequest: ${(e as Error).message}`,
      );
    }
    const s = requestState(request);
    let bytes: Uint8Array | null = null;
    if (s.body) {
      const c = s.body.content;
      if (c.kind === 'bytes') bytes = c.bytes;
      else if (c.kind === 'blob' && ctx.env.glue?.blobBytes)
        bytes = ctx.env.glue.blobBytes(c.blob);
      else
        return this.#syncError(
          gen,
          'NotSupportedError',
          'XMLHttpRequest: this body type cannot be sent synchronously',
        );
    }
    const natives = ctx.env.natives!;
    const href = s.url.href;
    let status = 0;
    let statusText = '';
    let headers: Headers;
    let responseURL = href;
    let data: Uint8Array;
    let type: 'basic' | 'cors' = 'basic';
    if (
      (s.url.protocol === 'https:' || s.url.protocol === 'http:') &&
      s.url.origin === ctx.appOrigin
    ) {
      if (s.method !== 'GET' && s.method !== 'HEAD') {
        status = 405;
        statusText = 'Method Not Allowed';
        headers = new Headers({ allow: 'GET, HEAD' });
        data = new Uint8Array(0);
      } else {
        const r = natives.readAssetSync?.(s.url.pathname);
        if (!r || (r.status !== 200 && r.status !== 404))
          return this.#syncError(
            gen,
            'NetworkError',
            `XMLHttpRequest: cannot read ${href}`,
          );
        status = r.status;
        statusText = r.status === 200 ? 'OK' : 'Not Found';
        headers = new Headers();
        data =
          r.status === 200 && r.buffer
            ? new Uint8Array(r.buffer)
            : new Uint8Array(0);
        if (r.status === 200)
          headerList(headers).push(
            ['content-length', String(data.byteLength)],
            ['content-type', r.mime],
          );
        else
          headerList(headers).push([
            'content-type',
            'text/plain;charset=UTF-8',
          ]);
        if (s.method === 'HEAD') data = new Uint8Array(0);
      }
    } else if (s.url.protocol === 'data:') {
      const parsed = processDataURL(href);
      if (!parsed)
        return this.#syncError(
          gen,
          'NetworkError',
          'XMLHttpRequest: malformed data: URL',
        );
      status = 200;
      statusText = 'OK';
      headers = new Headers();
      headerList(headers).push(['content-type', parsed.mime]);
      data = parsed.body;
    } else if (s.url.protocol === 'blob:') {
      const blob =
        s.method === 'GET'
          ? (ctx.env.glue?.blobUrls?.resolve(href.split('#')[0]) ?? null)
          : null;
      if (!blob || !ctx.env.glue?.blobBytes)
        return this.#syncError(
          gen,
          'NetworkError',
          `XMLHttpRequest: cannot load ${href}`,
        );
      data = ctx.env.glue.blobBytes(blob);
      status = 200;
      statusText = 'OK';
      headers = new Headers();
      headerList(headers).push(
        ['content-length', String(data.byteLength)],
        ['content-type', blob.type],
      );
    } else if (s.url.protocol === 'http:' || s.url.protocol === 'https:') {
      const verdict = checkOrigin(ctx.allow, s.url, ctx.env.config.debug);
      if (verdict !== 'allowed') {
        ctx.blocked.report(s.url, verdict);
        return this.#syncError(
          gen,
          'NetworkError',
          `XMLHttpRequest: origin not allowed (native.network.allow): ${href}`,
        );
      }
      const flat: string[] = [];
      for (const [n, v] of headerList(s.headers)) flat.push(n, v);
      if (!s.headers.has('user-agent') && ctx.env.config.userAgent)
        flat.push('user-agent', ctx.env.config.userAgent);
      if (!s.headers.has('accept')) flat.push('accept', '*/*');
      const r = natives.httpSync!({
        url: href.split('#')[0],
        method: s.method,
        headers: flat,
        body: bytes && bytes.byteLength ? bytes : null,
        redirect: 0,
        timeoutMs: ctx.env.config.timeoutMs,
        totalTimeoutMs: this.#timeout,
      });
      if (r.errorKind !== undefined) {
        if (r.errorKind === 'blocked') ctx.blocked.report(s.url, 'not-listed');
        if (r.errorKind === 'timeout' && this.#timeout > 0)
          return this.#syncError(
            gen,
            'TimeoutError',
            `XMLHttpRequest: timed out after ${this.#timeout} ms`,
          );
        return this.#syncError(
          gen,
          'NetworkError',
          `XMLHttpRequest: ${r.errorMessage || r.errorKind} (${href})`,
        );
      }
      status = r.status;
      statusText = r.statusText;
      headers = headersFromPairs(r.headers, 'immutable');
      responseURL = r.url;
      data = new Uint8Array(r.body);
      type = 'cors';
    } else {
      return this.#syncError(
        gen,
        'NetworkError',
        `XMLHttpRequest: unsupported scheme ${s.url.protocol}`,
      );
    }
    if (gen !== this.#generation) return; // re-opened from a handler
    this.#response = makeResponse({
      type,
      status,
      statusText,
      headers,
      body: InnerBody.fromBytes(new Uint8Array(0)),
      url: responseURL,
    });
    this.#status = status;
    this.#statusText = statusText;
    this.#responseURL = responseURL;
    this.#chunks = data.byteLength ? [data] : [];
    this.#received = data.byteLength;
    this.#bytes = null;
    // "handle response end-of-body" with the synchronous flag: no progress events.
    this.#state = 4;
    this.#send = false;
    const total = this.#received;
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(progressEvent('load', total, total, true));
    this.dispatchEvent(progressEvent('loadend', total, total, true));
  }

  /** "request error steps" with the synchronous flag: readystatechange, then throw (no events). */
  #syncError(gen: number, name: string, message: string): never {
    if (gen === this.#generation) {
      this.#state = 4;
      this.#send = false;
      this.#error = true;
      this.#resetResponse();
      this.dispatchEvent(new Event('readystatechange'));
    }
    throw domException(message, name);
  }

  #requestError(gen: number, type: 'error' | 'abort' | 'timeout'): void {
    if (gen !== this.#generation && type !== 'abort') return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const hadSend = this.#send;
    this.#state = 4;
    this.#send = false;
    this.#error = true;
    this.#resetResponse();
    this.dispatchEvent(new Event('readystatechange'));
    if (hadSend) {
      this.#upload.dispatchEvent(progressEvent(type, 0, 0, false));
      this.#upload.dispatchEvent(progressEvent('loadend', 0, 0, false));
    }
    this.dispatchEvent(progressEvent(type, 0, 0, false));
    this.dispatchEvent(progressEvent('loadend', 0, 0, false));
  }

  get [Symbol.toStringTag](): string {
    return 'XMLHttpRequest';
  }
}

export type { NetEnv };
