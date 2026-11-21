/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Imports math.js too: the diamond must evaluate math.js once (MOD-4).
import { add } from './math.js';
export const rootValue = add(1, 1) === 2 ? 'root' : 'bad';
