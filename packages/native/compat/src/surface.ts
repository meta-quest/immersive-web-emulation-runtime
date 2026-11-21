/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Load the measured surface the checker resolves against: live from this
 * package's built layers when they are present (a checkout), else from the
 * snapshot `surface-snapshot.json` written by `compat/scripts/snapshot.mjs`
 * (what an installed package has).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory } from './inventory.ts';
import {
  iwerHostSurface,
  measuredSurface,
  type MeasuredSurface,
} from './providers.ts';

export interface SurfaceSnapshot {
  generatedAt: string;
  source: string;
  v8Globals: string[];
  v8Members: string[];
  globals: Record<string, string>;
  members: Record<string, string>;
  tokens: Record<string, string>;
  extNames: Record<string, string>;
  iwer: string[];
  fields?: string[];
  stubs?: string[];
}

/** The @iwer/native package root (works from compat/src and from lib/compat/src). */
export function packageRoot(
  from = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  let d = from;
  for (let i = 0; i < 6; i++) {
    const pj = path.join(d, 'package.json');
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).name === '@iwer/native')
          return d;
      } catch {
        /* keep looking */
      }
    }
    d = path.dirname(d);
  }
  return null;
}

export function defaultIwerHostFile(root: string): string {
  return path.resolve(root, '../iwer/build/iwer-host.module.js');
}

export function snapshotFile(root: string): string {
  return path.join(root, 'compat', 'data', 'surface-snapshot.json');
}

export function toSnapshot(
  s: MeasuredSurface,
  source: string,
): SurfaceSnapshot {
  const tokens: Record<string, string> = {};
  // only identifier-like tokens that look like API names (keeps the snapshot small)
  for (const [k, v] of s.tokens)
    if (/^[A-Z][A-Za-z0-9]+$|^[a-z][A-Za-z0-9]{3,}$/.test(k)) tokens[k] = v;
  return {
    generatedAt: new Date().toISOString(),
    source,
    v8Globals: [...s.v8Globals].sort(),
    v8Members: [...s.v8Members].sort(),
    globals: Object.fromEntries([...s.globals].sort()),
    members: Object.fromEntries([...s.members].sort()),
    tokens,
    extNames: Object.fromEntries([...s.extNames].sort()),
    iwer: [...s.iwer].sort(),
    fields: [...s.fields].sort(),
    stubs: [...s.stubs].sort(),
  };
}

export function fromSnapshot(j: SurfaceSnapshot): MeasuredSurface {
  const byMember = new Map<string, Array<[string, string]>>();
  for (const [m, layer] of Object.entries(j.members)) {
    const name = m.slice(m.lastIndexOf('.') + 1);
    const l = byMember.get(name) ?? [];
    l.push([m, layer]);
    byMember.set(name, l);
  }
  return {
    v8Globals: new Set(j.v8Globals),
    v8Members: new Set(j.v8Members),
    globals: new Map(Object.entries(j.globals)),
    members: new Map(Object.entries(j.members)),
    byMember,
    tokens: new Map(Object.entries(j.tokens)),
    extNames: new Map(Object.entries(j.extNames ?? {})),
    iwer: new Set(j.iwer),
    fields: new Set(Array.isArray(j.fields) ? j.fields : []),
    stubs: new Set(j.stubs ?? []),
  };
}

export interface LoadedSurface {
  surface: MeasuredSurface;
  /** 'live' (measured now) or 'snapshot <date>'. */
  origin: string;
}

/** Live when the checkout has built layers; else the snapshot; else an empty surface (everything reads as a gap). */
export async function loadSurface(
  opts: {
    root?: string | null;
    iwerHostFile?: string;
    preferSnapshot?: boolean;
  } = {},
): Promise<LoadedSurface> {
  const root = opts.root === undefined ? packageRoot() : opts.root;
  if (
    root &&
    !opts.preferSnapshot &&
    existsSync(path.join(root, 'web', 'glue', 'dist'))
  ) {
    const iwerFile = opts.iwerHostFile ?? defaultIwerHostFile(root);
    const iwer = existsSync(iwerFile)
      ? await iwerHostSurface(iwerFile).catch(() => new Set<string>())
      : new Set<string>();
    if (iwer.size || !existsSync(snapshotFile(root)))
      return {
        surface: measuredSurface(buildInventory(root), iwer),
        origin: 'live',
      };
    // live layers but no IWER build: take IWER from the snapshot
    const snap = JSON.parse(
      readFileSync(snapshotFile(root), 'utf8'),
    ) as SurfaceSnapshot;
    return {
      surface: measuredSurface(buildInventory(root), snap.iwer),
      origin: 'live (IWER from snapshot)',
    };
  }
  if (root && existsSync(snapshotFile(root))) {
    const snap = JSON.parse(
      readFileSync(snapshotFile(root), 'utf8'),
    ) as SurfaceSnapshot;
    return {
      surface: fromSnapshot(snap),
      origin: `snapshot ${snap.generatedAt}`,
    };
  }
  return {
    surface: measuredSurface(
      { generatedAt: '', packageRoot: '', layers: [] },
      [],
    ),
    origin: 'empty (no built layers, no snapshot)',
  };
}

export async function writeSnapshot(
  root: string,
  iwerHostFile = defaultIwerHostFile(root),
): Promise<string> {
  const iwer = existsSync(iwerHostFile)
    ? await iwerHostSurface(iwerHostFile)
    : new Set<string>();
  const snap = toSnapshot(
    measuredSurface(buildInventory(root), iwer),
    `${path.basename(root)} + ${path.basename(iwerHostFile)}`,
  );
  const file = snapshotFile(root);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(snap)}\n`);
  return file;
}
