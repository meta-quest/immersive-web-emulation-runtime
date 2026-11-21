/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Fetch §5.5 Response class (NET-9): constructor checks, static error()/redirect()/json(), type, url,
// redirected, ok, clone(), and the Body mixin.

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
import { type NetEnv, utf8Encode } from './env.ts';
import {
  cloneHeaders,
  fillHeaders,
  Headers,
  setGuard,
  type HeadersInitLike,
} from './headers.ts';
import { getRequestEnv } from './request.ts';

export type ResponseType =
  | 'basic'
  | 'cors'
  | 'default'
  | 'error'
  | 'opaque'
  | 'opaqueredirect';

export interface ResponseInitLike {
  status?: number;
  statusText?: string;
  headers?: HeadersInitLike;
}

interface ResponseState {
  type: ResponseType;
  status: number;
  statusText: string;
  headers: Headers;
  body: InnerBody | null;
  urlList: string[];
  redirected: boolean;
  env: NetEnv | null;
}

const STATE = new WeakMap<object, ResponseState>();
const NULL_BODY_STATUS = [101, 103, 204, 205, 304];
const REDIRECT_STATUS = [301, 302, 303, 307, 308];
const REASON = /^[\t !-~\x80-\xff]*$/;

function stateOf(r: Response): ResponseState {
  const s = STATE.get(r);
  if (!s) throw new TypeError('Illegal invocation');
  return s;
}

function initialize(
  state: ResponseState,
  init: ResponseInitLike,
  body: { body: InnerBody; type: string | null } | null,
): void {
  const status = init.status === undefined ? 200 : Number(init.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(
      `Failed to construct 'Response': The status provided (${init.status}) is outside the range [200, 599].`,
    );
  }
  const statusText =
    init.statusText === undefined ? '' : String(init.statusText);
  if (!REASON.test(statusText))
    throw new TypeError("Failed to construct 'Response': Invalid statusText");
  state.status = status;
  state.statusText = statusText;
  if (init.headers !== undefined) fillHeaders(state.headers, init.headers);
  if (body) {
    if (NULL_BODY_STATUS.includes(status)) {
      throw new TypeError(
        "Failed to construct 'Response': Response with null body status cannot have body",
      );
    }
    state.body = body.body;
    if (body.type !== null && !state.headers.has('content-type'))
      state.headers.append('content-type', body.type);
  }
}

export class Response implements BodyOwner {
  constructor(body: unknown = null, init: ResponseInitLike = {}) {
    if (init === null || init === undefined) init = {};
    const env = getRequestEnv();
    const headers = new Headers();
    setGuard(headers, 'response');
    const state: ResponseState = {
      type: 'default',
      status: 200,
      statusText: '',
      headers,
      body: null,
      urlList: [],
      redirected: false,
      env,
    };
    STATE.set(this, state);
    initialize(
      state,
      init,
      body === null || body === undefined ? null : extractBody(body, env),
    );
  }

  static error(): Response {
    const r = makeResponse({
      type: 'error',
      status: 0,
      statusText: '',
      body: null,
      headersGuard: 'immutable',
    });
    return r;
  }

  static redirect(url: string | URL, status = 302): Response {
    const env = getRequestEnv();
    let parsed: URL;
    try {
      parsed = env ? new URL(String(url), env.baseURL()) : new URL(String(url));
    } catch {
      throw new TypeError(
        `Failed to execute 'redirect' on 'Response': Invalid URL "${String(url)}"`,
      );
    }
    if (!REDIRECT_STATUS.includes(status))
      throw new RangeError(
        `Failed to execute 'redirect' on 'Response': Invalid status code ${status}`,
      );
    const r = makeResponse({
      type: 'default',
      status,
      statusText: '',
      body: null,
      headersGuard: 'immutable',
    });
    stateOf(r).headers = (() => {
      const h = new Headers({ location: parsed.href });
      setGuard(h, 'immutable');
      return h;
    })();
    return r;
  }

  static json(data: unknown, init: ResponseInitLike = {}): Response {
    const text = JSON.stringify(data);
    if (text === undefined)
      throw new TypeError(
        "Failed to execute 'json' on 'Response': The data is not JSON serializable",
      );
    const r = Object.create(Response.prototype) as Response;
    const headers = new Headers();
    setGuard(headers, 'response');
    const state: ResponseState = {
      type: 'default',
      status: 200,
      statusText: '',
      headers,
      body: null,
      urlList: [],
      redirected: false,
      env: getRequestEnv(),
    };
    STATE.set(r, state);
    initialize(state, init ?? {}, {
      body: InnerBody.fromBytes(utf8Encode(text)),
      type: 'application/json',
    });
    return r;
  }

  get type(): ResponseType {
    return stateOf(this).type;
  }
  get url(): string {
    const list = stateOf(this).urlList;
    return list.length ? list[list.length - 1] : '';
  }
  get redirected(): boolean {
    return stateOf(this).redirected;
  }
  get status(): number {
    return stateOf(this).status;
  }
  get ok(): boolean {
    const s = stateOf(this).status;
    return s >= 200 && s <= 299;
  }
  get statusText(): string {
    return stateOf(this).statusText;
  }
  get headers(): Headers {
    return stateOf(this).headers;
  }
  get body(): ReadableStream<Uint8Array> | null {
    const b = stateOf(this).body;
    return b ? b.stream() : null;
  }
  get bodyUsed(): boolean {
    const b = stateOf(this).body;
    return !!b && b.disturbed;
  }

  clone(): Response {
    const s = stateOf(this);
    if (s.body?.unusable())
      throw new TypeError(
        "Failed to execute 'clone' on 'Response': Response body is already used",
      );
    const r = Object.create(Response.prototype) as Response;
    STATE.set(r, {
      ...s,
      headers: cloneHeaders(s.headers),
      body: s.body ? s.body.tee() : null,
      urlList: [...s.urlList],
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
    return 'Response';
  }
}

for (const k of ['innerBody', 'contentType', 'env'] as const) {
  Object.defineProperty(Response.prototype, k, { enumerable: false });
}

export interface MakeResponseInit {
  type: ResponseType;
  status: number;
  statusText: string;
  headers?: Headers;
  headersGuard?: 'immutable' | 'response';
  body: InnerBody | null;
  url?: string;
  redirected?: boolean;
  env?: NetEnv | null;
}

/** Builds a Response the way fetch does (no constructor checks; status 0 allowed for error/opaque). */
export function makeResponse(init: MakeResponseInit): Response {
  const r = Object.create(Response.prototype) as Response;
  const headers = init.headers ?? new Headers();
  setGuard(headers, init.headersGuard ?? 'immutable');
  STATE.set(r, {
    type: init.type,
    status: init.status,
    statusText: init.statusText,
    headers,
    body: init.body,
    urlList: init.url ? [init.url] : [],
    redirected: init.redirected ?? false,
    env: init.env ?? getRequestEnv(),
  });
  return r;
}

export function responseState(r: Response): ResponseState {
  return stateOf(r);
}
