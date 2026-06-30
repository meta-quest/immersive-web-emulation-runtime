#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Thin launcher so the published bin carries a shebang without relying on
 * tsc to preserve one. All real logic lives in lib/cli.js.
 */
import('../lib/cli.js').catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
