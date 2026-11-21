/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The app side of packing: walk the Vite `dist/` (PKG-4), read its
 * `index.html` (PKG-5) and refuse dists with an injected WebXR emulator
 * (PKG-6, GAP-7).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export class DistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistError';
  }
}

export interface DistFile {
  /** POSIX path relative to dist/ ("assets/index-abc.js"). */
  rel: string;
  abs: string;
  size: number;
}

/**
 * Extensions stored uncompressed so the runtime can map them (NET-3) and
 * because compressing them gains little (PKG-4).
 */
export const STORE_UNCOMPRESSED = new Set([
  '.glb',
  '.bin',
  '.ktx2',
  '.basis',
  '.wasm',
  '.mp3',
  '.ogg',
  '.wav',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.hdr',
  '.exr',
  '.mp4',
  '.webm',
  '.m4a',
  '.aac',
  '.opus',
  '.avif',
  '.gz',
  '.br',
  '.zip',
  '.drc',
  '.ktx',
]);

export function storeUncompressed(rel: string): boolean {
  return STORE_UNCOMPRESSED.has(path.posix.extname(rel).toLowerCase());
}

/** Minimal glob: `*` within a segment, `**` across segments, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern without a slash matches the basename anywhere (like .gitignore).
  return glob.includes('/')
    ? new RegExp(`^${re}$`)
    : new RegExp(`(?:^|/)${re}$`);
}

/** Every file under dist/, sorted by path (byte order), with excludes applied. */
export function listDist(
  distDir: string,
  exclude: readonly string[] = [],
): { files: DistFile[]; excluded: string[] } {
  let st;
  try {
    st = statSync(distDir);
  } catch {
    throw new DistError(
      `no dist directory at ${distDir}; build the app first (vite build)`,
    );
  }
  if (!st.isDirectory()) throw new DistError(`${distDir} is not a directory`);
  const patterns = exclude.map(globToRegExp);
  const files: DistFile[] = [];
  const excluded: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const s = statSync(abs); // follows symlinks
      if (s.isDirectory()) walk(abs, rel);
      else if (s.isFile()) {
        if (patterns.some((p) => p.test(rel))) excluded.push(rel);
        else files.push({ rel, abs, size: s.size });
      }
    }
  };
  walk(distDir, '');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)));
  return { files, excluded };
}

export interface IndexInfo {
  title: string | null;
  /** `<script type="module" src>` values, in document order. */
  moduleScripts: string[];
  /** Inline `<script type="module">` count. */
  inlineModules: number;
  modulePreloads: string[];
  classicScripts: string[];
}

const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<\w+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(attrRe))
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/** Scan index.html for what the runtime boots (PKG-5). Comments are ignored. */
export function scanIndexHtml(html: string): IndexInfo {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const info: IndexInfo = {
    title: null,
    moduleScripts: [],
    inlineModules: 0,
    modulePreloads: [],
    classicScripts: [],
  };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (title) info.title = title[1].trim().replace(/\s+/g, ' ');
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const open = /^<script\b[^>]*>/i.exec(m[0])![0];
    const a = parseAttrs(open);
    const type = (a.type ?? '').trim().toLowerCase();
    if (type === 'module') {
      if (a.src) info.moduleScripts.push(a.src);
      else if (m[1].trim()) info.inlineModules++;
    } else if (
      type === '' ||
      type === 'text/javascript' ||
      type === 'application/javascript'
    ) {
      if (a.src) info.classicScripts.push(a.src);
    }
  }
  for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (
      (a.rel ?? '').toLowerCase().split(/\s+/).includes('modulepreload') &&
      a.href
    )
      info.modulePreloads.push(a.href);
  }
  return info;
}

export interface InjectionFinding {
  file: string;
  what: string;
}

/**
 * Markers of IWSDK's build-time IWER injection (`dev.emulator.injectOnBuild`):
 * the injected entry is the virtual module `/@iwer-injection-runtime`, and its
 * configuration object carries keys only that runtime uses. Minifiers keep
 * object keys, so the keys survive a production build.
 *
 * Only keys present in every IWSDK release are required: `userAgentException`
 * and `activation` exist since 0.x (published 0.5.3), whereas later keys such
 * as `nativeXRControl` (added before 1.0.0) are missing from 0.x builds and
 * must not be required, or an old injected build passes (GAP-7). Clean builds
 * mention these names only as strings (config validators), never as keys.
 */
const INJECTION_KEY_SETS: { keys: RegExp[]; what: string }[] = [
  {
    what: 'IWSDK IWER emulator injection',
    keys: [/\buserAgentException\s*["']?\s*:/, /\bactivation\s*["']?\s*:/],
  },
];

export function detectInjection(
  distDir: string,
  files: readonly DistFile[],
  index: string,
): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  if (/iwer-injection/i.test(index))
    findings.push({
      file: 'index.html',
      what: 'IWSDK IWER emulator injection (script tag)',
    });
  for (const f of files) {
    if (!/\.(m?js)$/i.test(f.rel)) continue;
    if (/iwer-injection/i.test(f.rel)) {
      findings.push({
        file: f.rel,
        what: 'IWSDK IWER emulator injection (chunk name)',
      });
      continue;
    }
    if (f.size > 32 * 1024 * 1024) continue;
    const text = readFileSync(path.join(distDir, f.rel), 'latin1');
    if (text.includes('__IWSDK_DEV_CONFIG__')) {
      findings.push({
        file: f.rel,
        what: 'IWSDK IWER emulator injection (config placeholder)',
      });
      continue;
    }
    for (const set of INJECTION_KEY_SETS) {
      if (set.keys.every((k) => k.test(text))) {
        findings.push({ file: f.rel, what: set.what });
        break;
      }
    }
  }
  return findings;
}
