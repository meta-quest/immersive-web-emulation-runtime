/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds runtime/net's host targets (iwn_net_bridge for the Node tests) into web/net/.bridge-build.
// Incremental; ninja -j 8 at most (keeps the memory use of a shared build machine bounded).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..', 'runtime', 'net');
const out = join(here, '..', '.bridge-build');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`build-bridge: ${cmd} failed; bridge tests will be skipped`);
    process.exit(0);
  }
};
run('cmake', ['-S', src, '-B', out, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release']);
run('ninja', ['-C', out, '-j', '8', 'iwn_net_bridge']);
