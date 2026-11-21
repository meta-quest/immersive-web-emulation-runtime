/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Long-lived: posts a tick every 100 ms (pause/resume check).
let n = 0;
setInterval(() => postMessage(++n), 100);
