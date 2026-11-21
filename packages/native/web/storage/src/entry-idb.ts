/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// dist/idb.min.js: opt-in prelude (after the glue and the net prelude): IndexedDB and the Cache API.
import { installIdbAndCaches } from './install-idb.ts';

installIdbAndCaches(globalThis);
