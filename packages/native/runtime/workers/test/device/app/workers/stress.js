/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Bounces 64 KB buffers back (transfer both ways) until terminated (WRK-8 stress).
onmessage = (e) => {
  const buf = e.data;
  if (buf instanceof ArrayBuffer) {
    new Uint8Array(buf)[0]++;
    postMessage(buf, [buf]);
  }
};
