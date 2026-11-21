/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Bundle entry (dist/canvas2d.js): installs Canvas 2D on the current global (window or worker), after the web glue
// and image bundles, with the natives at globalThis.__iwn.canvas2d.
import { installCanvas2D } from './src/install.ts';

installCanvas2D(globalThis);
