#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Write compat/data/surface-snapshot.json: the measured runtime surface (built
 * layers + IWER host mode) that an installed `iwer-native compat` resolves
 * against when the package has no built layers next to it.
 *
 *   node compat/scripts/snapshot.mjs [--iwer-host <iwer-host.module.js>]
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const { writeSnapshot, defaultIwerHostFile } = await import(
  path.join(here, '..', 'src', 'surface.ts')
);
const { values } = parseArgs({ options: { 'iwer-host': { type: 'string' } } });
const file = await writeSnapshot(
  root,
  values['iwer-host'] ?? defaultIwerHostFile(root),
);
console.error(`wrote ${path.relative(process.cwd(), file)}`);
