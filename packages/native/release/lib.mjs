/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared helpers for the release scripts. Plain Node, no dependencies.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Whether the module at `metaUrl` is the script node was started with. Compares real paths: `import.meta.url` is
 * the resolved, URL-escaped path, while process.argv[1] keeps symlinks and spaces as typed, so a plain string
 * comparison is false in a symlinked checkout and the script would silently do nothing.
 */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return metaUrl === pathToFileURL(process.argv[1]).href;
  }
}

export function loadComponents(root = PKG) {
  return JSON.parse(readFileSync(path.join(root, 'release', 'components.json'), 'utf8'));
}

export function placeholders(env = process.env, root = PKG) {
  return {
    PKG: root,
    THIRD_PARTY: env.IWN_THIRD_PARTY_DIR || '',
    V8_SRC: env.IWN_V8_SRC || '',
  };
}

export function expand(p, vars) {
  return p.replace(/\$\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`unknown placeholder \${${k}} in ${p}`);
    return vars[k];
  });
}

/** First cells of every Markdown table row in THIRD_PARTY.md (component names), lower-cased. */
export function thirdPartyNames(root = PKG) {
  const md = readFileSync(path.join(root, 'THIRD_PARTY.md'), 'utf8');
  const names = [];
  for (const line of md.split('\n')) {
    const m = /^\|([^|]+)\|/.exec(line);
    if (!m) continue;
    const cell = m[1].trim();
    if (!cell || /^-+$/.test(cell) || /^(component|dependency of whatwg-url)$/i.test(cell)) continue;
    names.push(cell.toLowerCase());
  }
  return names;
}

export function hasThirdPartyEntry(component, names) {
  const want = (component.thirdPartyName ?? component.name).toLowerCase();
  return names.some((n) => n.includes(want));
}

/** Recursively list files under dir (relative paths), skipping node_modules and build dirs. */
export function walk(dir, filter = () => true, rel = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, filter, r));
    else if (filter(r)) out.push(r);
  }
  return out;
}
