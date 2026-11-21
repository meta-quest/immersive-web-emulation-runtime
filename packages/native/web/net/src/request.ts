/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Fetch §5.4 Request class (NET-9). Modes, credentials and cache are stored and reported; the runtime
// has no cookie jar and no HTTP cache (documented in web/net/README.md), so `credentials` and `cache`
// do not change what goes on the wire.

import {
  consumeArrayBuffer,
  consumeBlob,
  consumeBytes,
  consumeFormData,
  consumeJson,
  consumeText,
  extractBody,
  type BodyOwner,
  InnerBody,
} from './body.ts';
import { abortReason, type NetEnv } from './env.ts';
import {
  cloneHeaders,
  fillHeaders,
  getGuard,
  Headers,
  setGuard,
  type HeadersInitLike,
} from './headers.ts';

export interface RequestInitLike {
  method?: string;
  headers?: HeadersInitLike;
  body?: unknown;
  referrer?: string;
  referrerPolicy?: string;
  mode?: string;
  credentials?: string;
  cache?: string;
  redirect?: string;
  integrity?: string;
  keepalive?: boolean;
  signal?: AbortSignal | null;
  duplex?: string;
  priority?: string;
  window?: unknown;
}

const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const NORMALIZED = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH'];
const MODES = ['navigate', 'same-origin', 'no-cors', 'cors'];
const CREDENTIALS = ['omit', 'same-origin', 'include'];
const CACHES = [
  'default',
  'no-store',
  'reload',
  'no-cache',
  'force-cache',
  'only-if-cached',
];
const REDIRECTS = ['follow', 'error', 'manual'];

let currentEnv: NetEnv | null = null;
/** Set by installNet: the environment Requests built by page code resolve against. */
export function setRequestEnv(env: NetEnv | null): void {
  currentEnv = env;
}
export function getRequestEnv(): NetEnv | null {
  return currentEnv;
}

function enumValue(v: unknown, allowed: string[], what: string): string {
  const s = String(v);
  if (!allowed.includes(s))
    throw new TypeError(
      `Failed to construct 'Request': The provided value '${s}' is not a valid enum value of type ${what}.`,
    );
  return s;
}

interface RequestState {
  url: URL;
  method: string;
  headers: Headers;
  body: InnerBody | null;
  mode: string;
  credentials: string;
  cache: string;
  redirect: string;
  referrer: string;
  referrerPolicy: string;
  integrity: string;
  keepalive: boolean;
  signal: AbortSignal;
  duplex: string;
  env: NetEnv | null;
}

const STATE = new WeakMap<object, RequestState>();

function stateOf(r: Request): RequestState {
  const s = STATE.get(r);
  if (!s) throw new TypeError('Illegal invocation');
  return s;
}

/**
 * Fetch "create a dependent abort signal": AbortSignal.any([parent]) when the platform has it (the
 * glue's holds dependents weakly, so a long-lived parent signal does not accumulate one listener per
 * Request). Fallback: a listener that holds the dependent controller through a WeakRef.
 */
const DEPENDENT_CONTROLLERS = new WeakMap<AbortSignal, AbortController>();
function followSignal(parent: AbortSignal | null | undefined): AbortSignal {
  const AS = (
    globalThis as {
      AbortSignal?: typeof AbortSignal & {
        any?: (s: AbortSignal[]) => AbortSignal;
      };
    }
  ).AbortSignal;
  if (parent && AS && typeof AS.any === 'function' && parent instanceof AS)
    return AS.any([parent]);
  const AC = (globalThis as { AbortController?: typeof AbortController })
    .AbortController;
  if (!AC)
    return (
      parent ??
      ({
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as AbortSignal)
    );
  const ac = new AC();
  if (parent) {
    if (parent.aborted) {
      ac.abort(abortReason(parent));
    } else if (typeof WeakRef === 'function') {
      // The dependent signal keeps its controller alive (a signal does not reference its controller).
      DEPENDENT_CONTROLLERS.set(ac.signal, ac);
      const weak = new WeakRef(ac);
      parent.addEventListener(
        'abort',
        () => weak.deref()?.abort(abortReason(parent)),
        { once: true },
      );
    } else {
      parent.addEventListener('abort', () => ac.abort(abortReason(parent)), {
        once: true,
      });
    }
  }
  return ac.signal;
}

export class Request implements BodyOwner {
  constructor(input: Request | string | URL, init: RequestInitLike = {}) {
    const env = currentEnv;
    if (init === null || init === undefined) init = {};
    let base: RequestState | null = null;
    let url: URL;
    if (input instanceof Request) {
      base = stateOf(input);
      url = new URL(base.url.href);
    } else {
      const baseURL = env ? env.baseURL() : undefined;
      try {
        url = baseURL
          ? new URL(String(input), baseURL)
          : new URL(String(input));
      } catch {
        throw new TypeError(
          `Failed to construct 'Request': Invalid URL "${String(input)}"`,
        );
      }
      if (url.username || url.password) {
        throw new TypeError(
          `Failed to construct 'Request': Request cannot be constructed from a URL that includes credentials: ${String(input)}`,
        );
      }
    }
    let method = base ? base.method : 'GET';
    if (init.method !== undefined) {
      const m = String(init.method);
      if (!METHOD_TOKEN.test(m))
        throw new TypeError(
          `Failed to construct 'Request': '${m}' is not a valid HTTP method.`,
        );
      const upper = m.toUpperCase();
      if (upper === 'CONNECT' || upper === 'TRACE' || upper === 'TRACK') {
        throw new TypeError(
          `Failed to construct 'Request': '${m}' HTTP method is unsupported.`,
        );
      }
      method = NORMALIZED.includes(upper) && upper !== 'PATCH' ? upper : m;
    }
    const mode =
      init.mode !== undefined
        ? enumValue(init.mode, MODES, 'RequestMode')
        : base
          ? base.mode
          : 'cors';
    if (mode === 'navigate')
      throw new TypeError(
        "Failed to construct 'Request': Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.",
      );
    const credentials =
      init.credentials !== undefined
        ? enumValue(init.credentials, CREDENTIALS, 'RequestCredentials')
        : base
          ? base.credentials
          : 'same-origin';
    const cache =
      init.cache !== undefined
        ? enumValue(init.cache, CACHES, 'RequestCache')
        : base
          ? base.cache
          : 'default';
    if (cache === 'only-if-cached' && mode !== 'same-origin') {
      throw new TypeError(
        "Failed to construct 'Request': 'only-if-cached' can be set only with 'same-origin' mode",
      );
    }
    const redirect =
      init.redirect !== undefined
        ? enumValue(init.redirect, REDIRECTS, 'RequestRedirect')
        : base
          ? base.redirect
          : 'follow';
    const signal = followSignal(
      init.signal !== undefined ? init.signal : base ? base.signal : null,
    );

    const headers = new Headers();
    setGuard(headers, mode === 'no-cors' ? 'request-no-cors' : 'request');
    const headerInit =
      init.headers !== undefined
        ? init.headers
        : base
          ? base.headers
          : undefined;
    if (headerInit !== undefined)
      fillHeaders(
        headers,
        headerInit instanceof Headers
          ? cloneHeaders(headerInit, 'none')
          : headerInit,
      );

    let body: InnerBody | null = null;
    const inputBody = base ? base.body : null;
    if (
      ((init.body !== undefined && init.body !== null) || inputBody) &&
      (method === 'GET' || method === 'HEAD')
    ) {
      throw new TypeError(
        "Failed to construct 'Request': Request with GET/HEAD method cannot have body.",
      );
    }
    if (init.body !== undefined && init.body !== null) {
      const ex = extractBody(init.body, env);
      if (ex.body.content.kind === 'stream' && init.duplex !== 'half') {
        throw new TypeError(
          "Failed to construct 'Request': The `duplex` member must be specified for a request with a streaming body",
        );
      }
      body = ex.body;
      if (ex.type !== null && !headers.has('content-type'))
        headers.append('content-type', ex.type);
    } else if (inputBody) {
      if (inputBody.unusable())
        throw new TypeError(
          "Failed to construct 'Request': Cannot construct a Request with a Request object that has already been used.",
        );
      // Fetch: the new request takes over the input's body (the input becomes disturbed).
      body = inputBody;
      base!.body = new InnerBody(
        { kind: 'bytes', bytes: new Uint8Array(0), shared: false },
        0,
      );
      base!.body.disturbed = true;
    }

    STATE.set(this, {
      url,
      method,
      headers,
      body,
      mode,
      credentials,
      cache,
      redirect,
      referrer:
        init.referrer !== undefined
          ? String(init.referrer) || ''
          : base
            ? base.referrer
            : 'about:client',
      referrerPolicy:
        init.referrerPolicy !== undefined
          ? String(init.referrerPolicy)
          : base
            ? base.referrerPolicy
            : '',
      integrity:
        init.integrity !== undefined
          ? String(init.integrity)
          : base
            ? base.integrity
            : '',
      keepalive:
        init.keepalive !== undefined
          ? Boolean(init.keepalive)
          : base
            ? base.keepalive
            : false,
      signal,
      duplex: 'half',
      env,
    });
  }

  get method(): string {
    return stateOf(this).method;
  }
  get url(): string {
    return stateOf(this).url.href;
  }
  get headers(): Headers {
    return stateOf(this).headers;
  }
  get destination(): string {
    return '';
  }
  get referrer(): string {
    const r = stateOf(this).referrer;
    return r === 'about:client' ? 'about:client' : r;
  }
  get referrerPolicy(): string {
    return stateOf(this).referrerPolicy;
  }
  get mode(): string {
    return stateOf(this).mode;
  }
  get credentials(): string {
    return stateOf(this).credentials;
  }
  get cache(): string {
    return stateOf(this).cache;
  }
  get redirect(): string {
    return stateOf(this).redirect;
  }
  get integrity(): string {
    return stateOf(this).integrity;
  }
  get keepalive(): boolean {
    return stateOf(this).keepalive;
  }
  get isReloadNavigation(): boolean {
    return false;
  }
  get isHistoryNavigation(): boolean {
    return false;
  }
  get signal(): AbortSignal {
    return stateOf(this).signal;
  }
  get duplex(): string {
    return stateOf(this).duplex;
  }
  get body(): ReadableStream<Uint8Array> | null {
    const b = stateOf(this).body;
    return b ? b.stream() : null;
  }
  get bodyUsed(): boolean {
    const b = stateOf(this).body;
    return !!b && b.disturbed;
  }

  clone(): Request {
    const s = stateOf(this);
    if (s.body?.unusable())
      throw new TypeError(
        "Failed to execute 'clone' on 'Request': Request body is already used",
      );
    const r = Object.create(Request.prototype) as Request;
    STATE.set(r, {
      ...s,
      headers: cloneHeaders(s.headers),
      body: s.body ? s.body.tee() : null,
      signal: followSignal(s.signal),
    });
    return r;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return consumeArrayBuffer(this);
  }
  bytes(): Promise<Uint8Array> {
    return consumeBytes(this);
  }
  text(): Promise<string> {
    return consumeText(this);
  }
  json(): Promise<unknown> {
    return consumeJson(this);
  }
  blob(): Promise<Blob> {
    return consumeBlob(this);
  }
  formData(): Promise<FormData> {
    return consumeFormData(this);
  }

  innerBody(): InnerBody | null {
    return stateOf(this).body;
  }
  contentType(): string | null {
    return stateOf(this).headers.get('content-type');
  }
  env(): NetEnv | null {
    return stateOf(this).env;
  }

  get [Symbol.toStringTag](): string {
    return 'Request';
  }
}

// Hide the BodyOwner plumbing from enumeration and page code that inspects prototypes.
for (const k of ['innerBody', 'contentType', 'env'] as const) {
  Object.defineProperty(Request.prototype, k, { enumerable: false });
}

/** Internal view for fetch(). */
export function requestState(r: Request): RequestState {
  return stateOf(r);
}

export function requestHeadersGuard(r: Request): string {
  return getGuard(stateOf(r).headers);
}
