/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Prelude entry (dist/glue-subtle.min.js), evaluated after dist/glue.min.js. Installs the digest-only
// `crypto.subtle` and the `SubtleCrypto` interface object when the app config enables it
// (`subtle: 'digest'`, NET-STORE-4); otherwise it does nothing.
import { createSubtle, SubtleCrypto } from './subtle.ts';

const registry = (
  globalThis as unknown as Record<
    symbol,
    { installSubtle?(ctor: Function, instance: object): boolean } | undefined
  >
)[Symbol.for('iwn.glue')];
if (registry?.installSubtle)
  registry.installSubtle(SubtleCrypto, createSubtle());
