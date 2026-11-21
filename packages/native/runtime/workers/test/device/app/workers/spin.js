/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A worker stuck in a JS loop, or in a wasm loop (WRK-8): terminate() must still stop it.
onmessage = async (e) => {
  if (e.data === 'js') {
    postMessage('spinning');
    for (;;) {}
  } else if (e.data === 'wasm') {
    // (module (func (export "spin") (loop (br 0))))
    const bytes = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4,
      115, 112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11,
    ]);
    const { instance } = await WebAssembly.instantiate(bytes);
    postMessage('spinning');
    instance.exports.spin();
  }
};
