/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// comlink expose() over a transferred MessagePort, as IWSDK's MSDF text worker is driven (WRK-6).
import * as Comlink from '../vendor/comlink.mjs';
const api = {
  counter: 0,
  inc(n = 1) {
    this.counter += n;
    return this.counter;
  },
  async atlas(size) {
    const buf = new Uint8Array(size).fill(7);
    return Comlink.transfer(buf, [buf.buffer]);
  },
  callback(fn) {
    return fn(21);
  },
};
onmessage = (e) => Comlink.expose(api, e.ports[0]);
