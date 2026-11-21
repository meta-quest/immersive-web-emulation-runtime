/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A static server for a Vite `dist/` that injects the compat tooling: HTML pages
 * get the tooling `<script>`s at the top of `<head>` (classic scripts run before
 * the app's module entry), worker scripts get the worker tracer prepended, and
 * workers POST their trace records back. Binds 127.0.0.1 only.
 */

import { promises as fsp } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export const TOOL_PREFIX = '/__iwn_compat/';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface CompatServerOptions {
  distDir: string;
  /** Tool files served under TOOL_PREFIX: name -> content. */
  toolFiles: Record<string, string>;
  /** Tool file names injected (in order) into every HTML page. */
  injectScripts: string[];
  /** Tool file name prepended to worker scripts. */
  workerTracer: string;
  onReport: (body: string) => void;
  /** The page's phase ('boot' | 'xr'), returned to workers with each report so their records carry it. */
  phase?: () => string;
  /** A WebSocket the tracer redirected to `${TOOL_PREFIX}ws-blocked?u=<url>` (refused with 403): the original URL. */
  onWebSocketBlocked?: (url: string) => void;
}

export interface CompatServer {
  origin: string;
  close(): Promise<void>;
  /** Requests for files that do not exist in dist/ (path -> count). */
  missing: Map<string, number>;
  /** Files in dist/ that could not be opened (path -> error). */
  unreadable: Map<string, string>;
}

/** Inject `<script src>` tags right after `<head>` (or at the top). */
export function injectHtml(html: string, srcs: string[]): string {
  const tags = srcs.map((s) => `<script src="${s}"></script>`).join('');
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tags + html.slice(m.index + m[0].length);
  return tags + html;
}

/**
 * True if a JS source looks like an ES module (a static import/export at statement start, or import.meta).
 * `importScripts(` and `import(` (dynamic import, valid in classic scripts) do not count.
 */
export function looksLikeModule(src: string): boolean {
  return /(^|[;\n}])\s*(import\s*[{*'"]|import\s+[\w$]+\s*(,|from\b)|export\s*[{*]|export\s+(default|const|let|var|function|class|async)\b)/.test(src) || /\bimport\.meta\b/.test(src);
}

/** Length of a classic script's leading directive prologue ("use strict"; and friends, with comments). */
export function directivePrologueLength(src: string): number {
  const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:(['"])(?:(?!\1)[^\\\n])*\1\s*(?:;|\n)(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*)+/.exec(src);
  return m ? m[0].length : 0;
}

/**
 * A worker-destination request that is not a registered worker entry, made from a script on our origin: a module
 * worker's static import (the referrer is the importing module). Every worker entry the tracer sees is registered
 * (synchronously) before it is fetched, nested workers included, and a page-created worker's referrer is the page.
 */
export function isModuleImport(referer: string, origin: string): boolean {
  if (!referer.startsWith(`${origin}/`)) return false;
  try {
    return /\.m?js$/i.test(new URL(referer).pathname);
  } catch {
    return false;
  }
}

/** Inside `root` (not a sibling that shares the prefix). */
export function isInside(root: string, file: string): boolean {
  const r = path.resolve(root);
  const f = path.resolve(file);
  return f === r || f.startsWith(r + path.sep);
}

export async function startCompatServer(
  opts: CompatServerOptions,
): Promise<CompatServer> {
  const root = path.resolve(opts.distDir);
  const workerTypes = new Map<string, string>();
  const missing = new Map<string, number>();
  const unreadable = new Map<string, string>();
  let origin = '';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = decodeURIComponent(url.pathname);
      if (p.startsWith(TOOL_PREFIX)) {
        const name = p.slice(TOOL_PREFIX.length);
        if (name === 'report' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          opts.onReport(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ phase: opts.phase?.() ?? 'boot' }));
          return;
        }
        if (name === 'worker-type') {
          const u = url.searchParams.get('url');
          if (u) workerTypes.set(u.split('#')[0]!, url.searchParams.get('type') ?? 'classic');
          res.writeHead(204).end();
          return;
        }
        const body = opts.toolFiles[name];
        if (body === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }
      let file = path.join(root, p);
      if (!isInside(root, file)) {
        res.writeHead(403).end();
        return;
      }
      let st = await fsp.stat(file).catch(() => null);
      if (st?.isDirectory()) {
        file = path.join(file, 'index.html');
        st = await fsp.stat(file).catch(() => null);
      }
      if (!st) {
        missing.set(p, (missing.get(p) ?? 0) + 1);
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const type = TYPES[ext] ?? 'application/octet-stream';
      const dest = String(req.headers['sec-fetch-dest'] ?? '');
      if (ext === '.html') {
        const html = await fsp.readFile(file, 'utf8');
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(injectHtml(html, opts.injectScripts.map((n) => TOOL_PREFIX + n)));
        return;
      }
      if ((dest === 'worker' || dest === 'sharedworker') && (ext === '.js' || ext === '.mjs')) {
        const src = await fsp.readFile(file, 'utf8');
        const full = `${origin}${url.pathname}${url.search}`;
        const registered = workerTypes.get(full);
        if (!registered && isModuleImport(String(req.headers.referer ?? ''), origin)) {
          // a static import of a module worker (HTML fetches those with the worker destination too): the worker's
          // entry already loaded the tracer, and importScripts would throw in a module worker
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
          res.end(src);
          return;
        }
        const kind = registered ?? (looksLikeModule(src) ? 'module' : 'classic');
        const tracer = JSON.stringify(TOOL_PREFIX + opts.workerTracer);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        if (kind === 'module') res.end(`import ${tracer};${src}`);
        else {
          // after the directive prologue, so a leading "use strict" still makes the worker strict
          const n = directivePrologueLength(src);
          res.end(`${src.slice(0, n)}importScripts(${tracer});\n${src.slice(n)}`);
        }
        return;
      }
      // open before answering: an unreadable file (EACCES, deleted after the stat) is a 500 for that request, not an
      // unhandled stream error that takes the whole process (and every concurrent trace) down
      let fh: fsp.FileHandle;
      try {
        fh = await fsp.open(file, 'r');
      } catch (error) {
        unreadable.set(p, String((error as Error).message ?? error));
        res.writeHead(500, { 'content-type': 'text/plain' }).end('unreadable');
        return;
      }
      res.writeHead(200, {
        'content-type': type,
        'content-length': st.size,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      const stream = fh.createReadStream();
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
      else res.destroy();
    }
  });
  // WebSocket upgrades: the tracer sends blocked ones here (refused, as NET-5 refuses them on the headset); the
  // page's own origin has no WebSocket endpoint, so any other upgrade is refused too
  server.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === `${TOOL_PREFIX}ws-blocked`) opts.onWebSocketBlocked?.(url.searchParams.get('u') ?? '');
    } catch {
      /* ignore */
    }
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    missing,
    unreadable,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
