/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Depth sensing (docs/spec/08 XR-DEPTH-2): the native depth record (runtime/xr include/iwn/xr/depth_record.h, written
// by the XR thread with each frame) read in place as IWER host mode's XRHostDepth. One object, rewritten each frame;
// its `views` is a view of the record itself, so a frame reads nothing it does not use and allocates nothing.

import type { XRHostDepth, XRHostDepthSupport } from 'iwer/host';

/** depth_layout::kDepthVersion; a record with another version is not read (depth-sensing is then not offered). */
export const DEPTH_VERSION = 1;

// depth_layout offsets (doubles)
const VERSION = 0;
const VALID = 1;
const TEXTURE = 2;
const WIDTH = 3;
const HEIGHT = 4;
const NEAR = 5;
const FAR = 6;
const VIEWS = 7;
const VIEW_STRIDE = 11;
const ACQUIRE_MS = VIEWS + 2 * VIEW_STRIDE;
const SERIAL = ACQUIRE_MS + 1;
export const DEPTH_RECORD_COUNT = SERIAL + 1;

const NO_TEXTURE = {};

/**
 * What the runtime offers: Quest Browser's depth sensing, GPU depth only (the environment depth texture, a
 * DEPTH_COMPONENT16 array), as 'unsigned-short' (what Quest Browser 156 reports for it) or 'float32' (IWSDK asks for
 * gpu-optimized + float32, and samples the same texture either way). Not 'luminance-alpha': that names a packed
 * two-byte encoding this texture does not have.
 */
export const DEPTH_SUPPORT: XRHostDepthSupport = {
  usages: ['gpu-optimized'],
  dataFormats: ['unsigned-short', 'float32'],
};

/** A snapshot of the record for tools (`__iwnXR.depth()`). */
export interface DepthState {
  valid: boolean;
  texture: number;
  width: number;
  height: number;
  near: number;
  far: number;
  acquireMs: number;
  images: number;
}

export class DepthRecordView {
  readonly data: Float64Array;
  private readonly depth: XRHostDepth;

  constructor(buffer: ArrayBuffer) {
    this.data = new Float64Array(buffer, 0, DEPTH_RECORD_COUNT);
    this.depth = {
      texture: NO_TEXTURE,
      width: 0,
      height: 0,
      depthNear: 0,
      depthFar: 0,
      rawValueToMeters: 1,  // a depth texture: metres = depthNear / (1 - d)
      viewCount: 2,
      views: this.data.subarray(VIEWS, VIEWS + 2 * VIEW_STRIDE),
    };
  }

  /**
   * This frame's depth, or null when it has none; `texture` turns the image's GL name into the session's depth
   * texture (null: no WebGL context yet, and then no depth either).
   */
  read(texture: (name: number) => object | null): XRHostDepth | null {
    const d = this.data;
    if (d[VERSION] !== DEPTH_VERSION || d[VALID] !== 1) return null;
    const tex = texture(d[TEXTURE]);
    if (tex === null) return null;
    const out = this.depth;
    out.texture = tex;
    out.width = d[WIDTH];
    out.height = d[HEIGHT];
    out.depthNear = d[NEAR];
    out.depthFar = d[FAR];
    return out;
  }

  state(): DepthState {
    const d = this.data;
    return {
      valid: d[VERSION] === DEPTH_VERSION && d[VALID] === 1,
      texture: d[TEXTURE],
      width: d[WIDTH],
      height: d[HEIGHT],
      near: d[NEAR],
      far: d[FAR],
      acquireMs: d[ACQUIRE_MS],
      images: d[SERIAL],
    };
  }
}
