/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Service Workers §5 Cache / CacheStorage (`caches`) over this runtime's fetch and the native SQLite
// service: one database (<files>/iwn/cache/caches.sqlite), every mutation one atomic batch (the native
// side rolls the whole batch back if any statement fails). Matching follows "query cache"
// (ignoreSearch, ignoreMethod, ignoreVary, Vary headers) over the entries' metadata only; bodies are read
// for the entries a match returns, never for a put or a key listing. Opt-in like IndexedDB (spec
// NET-STORE-3).

import type { SqlResult, SqlValue, StorageNatives } from './natives.ts';

interface NetRegistryLike {
  makeResponse(init: {
    type: string;
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
    body: Uint8Array | null;
    url: string;
    redirected: boolean;
  }): Response;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CacheQueryOptions {
  ignoreSearch?: boolean;
  ignoreMethod?: boolean;
  ignoreVary?: boolean;
}

interface Row {
  id: number;
  url: string;
  method: string;
  req_headers: string;
  resp_type: string;
  resp_status: number;
  resp_status_text: string;
  resp_url: string;
  resp_redirected: number;
  resp_headers: string;
}

/** Every column but the body. */
const META = 'id, url, method, req_headers, resp_type, resp_status, resp_status_text, resp_url, resp_redirected, resp_headers';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS caches (name TEXT PRIMARY KEY, seq INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS entries (
     id INTEGER PRIMARY KEY AUTOINCREMENT, cache TEXT NOT NULL, url TEXT NOT NULL, url_nosearch TEXT NOT NULL,
     method TEXT NOT NULL, req_headers TEXT NOT NULL, resp_type TEXT NOT NULL, resp_status INTEGER NOT NULL,
     resp_status_text TEXT NOT NULL, resp_url TEXT NOT NULL, resp_redirected INTEGER NOT NULL,
     resp_headers TEXT NOT NULL, body BLOB)`,
  'CREATE INDEX IF NOT EXISTS entries_lookup ON entries (cache, url_nosearch)',
];

class Db {
  #natives: StorageNatives;
  #handle: Promise<number> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(natives: StorageNatives) {
    this.#natives = natives;
  }
  #open(): Promise<number> {
    this.#handle ??= (async () => {
      const h = this.#natives.sqlOpen('cache', 'caches.sqlite');
      const r = await this.#run(h, SCHEMA.map((sql) => [sql, []]), false);
      const err = r.find((x) => x.error);
      if (err) throw new Error(err.error);
      return h;
    })();
    return this.#handle;
  }
  #run(h: number, stmts: Array<[string, SqlValue[]]>, readOnly: boolean, atomic = false): Promise<SqlResult[]> {
    return new Promise((resolve) =>
      this.#natives.sqlExec(h, stmts.map((s) => s[0]), stmts.map((s) => s[1]), readOnly, resolve, atomic),
    );
  }
  /**
   * Runs statements in order (serialised with every other cache operation). `transaction`: all or
   * nothing (native atomic batch: a failing statement rolls back the ones before it).
   */
  exec(stmts: Array<[string, SqlValue[]]>, opts: { transaction?: boolean; readOnly?: boolean } = {}): Promise<SqlResult[]> {
    const job = this.#queue.then(async () => {
      const h = await this.#open();
      const results = await this.#run(h, stmts, !!opts.readOnly, !!opts.transaction);
      const failed = results.find((r) => r.error !== undefined);
      if (failed) throw domError(`Cache storage error: ${failed.error}`, 'UnknownError');
      return results;
    });
    this.#queue = job.catch(() => {});
    return job;
  }
}

function domError(message: string, name: string): Error {
  const D = (globalThis as { DOMException?: typeof DOMException }).DOMException;
  if (D) return new D(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

function getRequestCtor(): typeof Request {
  const R = (globalThis as { Request?: typeof Request }).Request;
  if (!R) throw new TypeError('Cache API needs Request (install the net prelude first)');
  return R;
}

function toRequest(input: RequestInfo | URL): Request {
  const R = getRequestCtor();
  return input instanceof R ? input : new R(input as string);
}

function stripHash(u: string): string {
  const x = new URL(u);
  x.hash = '';
  return x.href;
}
function stripSearch(u: string): string {
  const x = new URL(u);
  x.hash = '';
  x.search = '';
  return x.href;
}

function headerPairs(h: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  h.forEach((v, k) => out.push([k, v]));
  return out;
}

function varyNames(respHeaders: Array<[string, string]>): string[] {
  const vary = respHeaders.filter(([n]) => n === 'vary').map(([, v]) => v).join(',');
  return vary
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function headerValue(pairs: Array<[string, string]>, name: string): string | null {
  const vals = pairs.filter(([n]) => n === name).map(([, v]) => v);
  return vals.length ? vals.join(', ') : null;
}

/** "request matches cached item" (Service Workers §5.4.3 query cache). */
function matches(query: Request, row: Row, opts: CacheQueryOptions): boolean {
  const qUrl = opts.ignoreSearch ? stripSearch(query.url) : stripHash(query.url);
  const rUrl = opts.ignoreSearch ? stripSearch(row.url) : stripHash(row.url);
  if (qUrl !== rUrl) return false;
  if (opts.ignoreVary) return true;
  const respHeaders = JSON.parse(row.resp_headers) as Array<[string, string]>;
  const storedReq = JSON.parse(row.req_headers) as Array<[string, string]>;
  const qHeaders = headerPairs(query.headers);
  for (const name of varyNames(respHeaders)) {
    if (name === '*') return false;
    if (headerValue(storedReq, name) !== headerValue(qHeaders, name)) return false;
  }
  return true;
}

export class Cache {
  #name: string;
  #db: Db;
  #net: () => NetRegistryLike;
  constructor(token: symbol, name: string, db: Db, net: () => NetRegistryLike) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#name = name;
    this.#db = db;
    this.#net = net;
  }

  /** Matching entries' metadata (no bodies). */
  async #rows(query: Request | null, opts: CacheQueryOptions): Promise<Row[]> {
    const stmts: Array<[string, SqlValue[]]> = query
      ? [[`SELECT ${META} FROM entries WHERE cache = ? AND url_nosearch = ? ORDER BY id`, [this.#name, stripSearch(query.url)]]]
      : [[`SELECT ${META} FROM entries WHERE cache = ? ORDER BY id`, [this.#name]]];
    const [r] = await this.#db.exec(stmts, { readOnly: true });
    const rows = (r.rows ?? []) as unknown as Row[];
    if (!query) return rows;
    if (!opts.ignoreMethod && query.method !== 'GET') return [];
    return rows.filter((row) => matches(query, row, opts));
  }

  /** Responses for `rows`, reading only their bodies. */
  async #responses(rows: Row[]): Promise<Response[]> {
    if (!rows.length) return [];
    const results = await this.#db.exec(
      rows.map((r) => ['SELECT body FROM entries WHERE id = ?', [r.id]]),
      { readOnly: true },
    );
    return rows.map((row, i) => {
      const body = (results[i].rows?.[0]?.body ?? null) as ArrayBuffer | null;
      return this.#response(row, body);
    });
  }

  #response(row: Row, body: ArrayBuffer | null): Response {
    return this.#net().makeResponse({
      type: row.resp_type,
      status: row.resp_status,
      statusText: row.resp_status_text,
      headers: JSON.parse(row.resp_headers) as Array<[string, string]>,
      body: body ? new Uint8Array(body) : null,
      url: row.resp_url,
      redirected: row.resp_redirected === 1,
    });
  }

  async match(request: RequestInfo | URL, options: CacheQueryOptions = {}): Promise<Response | undefined> {
    const rows = await this.#rows(toRequest(request), options ?? {});
    return rows.length ? (await this.#responses([rows[0]]))[0] : undefined;
  }

  async matchAll(request?: RequestInfo | URL, options: CacheQueryOptions = {}): Promise<Response[]> {
    const rows = await this.#rows(request === undefined ? null : toRequest(request), options ?? {});
    return this.#responses(rows);
  }

  async add(request: RequestInfo | URL): Promise<void> {
    return this.addAll([request]);
  }

  async addAll(requests: Iterable<RequestInfo | URL>): Promise<void> {
    const reqs = [...requests].map(toRequest);
    for (const r of reqs) {
      if (!/^https?:$/.test(new URL(r.url).protocol)) throw new TypeError(`Cache.addAll: unsupported scheme in ${r.url}`);
      if (r.method !== 'GET') throw new TypeError('Cache.addAll: only GET requests can be cached');
    }
    const responses = await Promise.all(reqs.map((r) => this.#net().fetch(r)));
    for (const resp of responses) {
      if (!resp.ok) throw new TypeError(`Cache.addAll: request failed with status ${resp.status}`);
      if (varyNames(headerPairs(resp.headers)).includes('*')) throw new TypeError('Cache.addAll: Vary: * cannot be cached');
    }
    await this.#putAll(reqs.map((r, i) => [r, responses[i]]));
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const req = toRequest(request);
    const scheme = new URL(req.url).protocol;
    if (scheme !== 'http:' && scheme !== 'https:') throw new TypeError(`Cache.put: unsupported scheme ${scheme}`);
    if (req.method !== 'GET') throw new TypeError('Cache.put: only GET requests can be cached');
    if (response.status === 206) throw new TypeError('Cache.put: partial (206) responses cannot be cached');
    if (varyNames(headerPairs(response.headers)).includes('*')) throw new TypeError('Cache.put: Vary: * cannot be cached');
    if (response.bodyUsed) throw new TypeError('Cache.put: response body is already used');
    await this.#putAll([[req, response]]);
  }

  async #putAll(pairs: Array<[Request, Response]>): Promise<void> {
    const prepared = await Promise.all(
      pairs.map(async ([req, resp]) => ({
        req,
        resp,
        body: resp.body === null ? null : new Uint8Array(await resp.arrayBuffer()),
      })),
    );
    // Replace entries the new request matches (same URL, Vary-compatible), then insert. Only rows with
    // the same URL are looked at, and only their metadata.
    const stmts: Array<[string, SqlValue[]]> = [];
    for (const { req, resp, body } of prepared) {
      for (const row of await this.#rows(req, {})) stmts.push(['DELETE FROM entries WHERE id = ?', [row.id]]);
      stmts.push([
        `INSERT INTO entries (cache, url, url_nosearch, method, req_headers, resp_type, resp_status, resp_status_text,
           resp_url, resp_redirected, resp_headers, body) VALUES (?, ?, ?, 'GET', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.#name,
          stripHash(req.url),
          stripSearch(req.url),
          JSON.stringify(headerPairs(req.headers)),
          resp.type,
          resp.status,
          resp.statusText,
          resp.url,
          resp.redirected ? 1 : 0,
          JSON.stringify(headerPairs(resp.headers)),
          body,
        ],
      ]);
    }
    stmts.push(['INSERT OR IGNORE INTO caches (name, seq) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM caches))', [this.#name]]);
    await this.#db.exec(stmts, { transaction: true });
  }

  async delete(request: RequestInfo | URL, options: CacheQueryOptions = {}): Promise<boolean> {
    const rows = await this.#rows(toRequest(request), options ?? {});
    if (!rows.length) return false;
    await this.#db.exec(rows.map((r) => ['DELETE FROM entries WHERE id = ?', [r.id]]), { transaction: true });
    return true;
  }

  async keys(request?: RequestInfo | URL, options: CacheQueryOptions = {}): Promise<Request[]> {
    const rows = await this.#rows(request === undefined ? null : toRequest(request), options ?? {});
    const R = getRequestCtor();
    return rows.map((r) => new R(r.url, { headers: JSON.parse(r.req_headers) as Array<[string, string]> }));
  }

  get [Symbol.toStringTag](): string {
    return 'Cache';
  }
}

const INTERNAL = Symbol('cache-internal');

export class CacheStorage {
  #db: Db;
  #net: () => NetRegistryLike;
  constructor(token: symbol, natives: StorageNatives, net: () => NetRegistryLike) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#db = new Db(natives);
    this.#net = net;
  }

  async #names(): Promise<string[]> {
    const [r] = await this.#db.exec([['SELECT name FROM caches ORDER BY seq', []]], { readOnly: true });
    return (r.rows ?? []).map((row) => String(row.name));
  }

  async match(request: RequestInfo | URL, options: CacheQueryOptions & { cacheName?: string } = {}): Promise<Response | undefined> {
    const names = options?.cacheName !== undefined ? ((await this.has(options.cacheName)) ? [options.cacheName] : []) : await this.#names();
    for (const name of names) {
      const r = await (await this.open(name)).match(request, options);
      if (r) return r;
    }
    return undefined;
  }

  async has(name: string): Promise<boolean> {
    return (await this.#names()).includes(String(name));
  }

  async open(name: string): Promise<Cache> {
    name = String(name);
    await this.#db.exec([['INSERT OR IGNORE INTO caches (name, seq) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM caches))', [name]]], {
      transaction: true,
    });
    return new Cache(INTERNAL, name, this.#db, this.#net);
  }

  async delete(name: string): Promise<boolean> {
    name = String(name);
    if (!(await this.has(name))) return false;
    await this.#db.exec(
      [
        ['DELETE FROM entries WHERE cache = ?', [name]],
        ['DELETE FROM caches WHERE name = ?', [name]],
      ],
      { transaction: true },
    );
    return true;
  }

  keys(): Promise<string[]> {
    return this.#names();
  }

  get [Symbol.toStringTag](): string {
    return 'CacheStorage';
  }
}

export function createCacheStorage(natives: StorageNatives, net: () => NetRegistryLike): CacheStorage {
  return new CacheStorage(INTERNAL, natives, net);
}
