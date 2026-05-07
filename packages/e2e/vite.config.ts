/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/pages'),
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  resolve: {
    alias: {
      '@harness': path.resolve(__dirname, 'src/harness'),
      '@suites': path.resolve(__dirname, 'src/suites'),
      '@setup': path.resolve(__dirname, 'src/setup'),
    },
  },
});
