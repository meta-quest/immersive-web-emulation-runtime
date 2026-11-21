/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Loaded only by m1-check r5 (concurrent import() of one URL shares one off-thread read, PROC-2).
import { filler } from './shared-dep.js';
export const size = filler;
export const url = import.meta.url;
