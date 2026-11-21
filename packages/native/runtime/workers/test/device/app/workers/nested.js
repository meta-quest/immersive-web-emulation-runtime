/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A worker that starts its own worker (nested workers).
const inner = new Worker('./echo.js', { name: 'inner' });
inner.onmessage = (e) => postMessage('inner echoed ' + e.data);
onmessage = (e) => inner.postMessage(e.data);
