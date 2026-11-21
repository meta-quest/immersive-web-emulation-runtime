/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Bundle entry (dist/glue.js): installs the glue on the current global from `globalThis.__iwn`
// (natives + config) before the app's entry module is evaluated.
import { installGlue } from './index.ts';

installGlue(globalThis);
