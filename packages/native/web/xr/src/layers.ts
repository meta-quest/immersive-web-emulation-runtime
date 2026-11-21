/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Quad and cylinder layers (docs/spec/08 XR-LAYER-1): the buffer this adapter shares with the XR thread for them
// (globalThis.__iwn.xr.layers()), laid out as runtime/xr/include/iwn/xr/layers.h says; the constants are mirrored
// here and the native side writes LAYER_BUFFER_VERSION into the buffer, which the adapter checks once (as XRF-4 does
// for the frame record). Per XR frame: the adapter sets the list to NO_LIST before IWER runs the frame, IWER's
// submitLayers writes the frame's list (write()), and the XR thread reads it once the frame is done. The XR thread
// writes, per layer swapchain, the GL name of the image the page draws into next (nameOf()).

import type { XRHostLayer } from 'iwer/host';

export const LAYER_BUFFER_VERSION = 1;
export const MAX_LAYER_SWAPCHAINS = 16;
export const MAX_LAYER_ENTRIES = 16;
export const LAYER_ENTRY_WORDS = 16;
export const NO_LIST = 0xffffffff;
export const VERSION_AT = 0;
export const COUNT_AT = 1;
export const NAMES_AT = 4;
export const ENTRIES_AT = NAMES_AT + MAX_LAYER_SWAPCHAINS;
export const LAYER_BUFFER_WORDS = ENTRIES_AT + MAX_LAYER_ENTRIES * LAYER_ENTRY_WORDS;

// entry words
export const E_KIND = 0;
export const E_ID = 1;
export const E_FLAGS = 2;
export const E_LAYOUT = 3;
export const E_POSE = 4; // 7 f32
export const E_A = 11;
export const E_B = 12;
export const E_C = 13;

export const KIND_PROJECTION = 1;
export const KIND_QUAD = 2;
export const KIND_CYLINDER = 3;

export const FLAG_LISTED = 1;
export const FLAG_REDRAWN = 2;
export const FLAG_BLEND_ALPHA = 4;
export const FLAG_VIEWER = 8;
export const FLAG_LOCATED = 16;

export const LAYOUT_MONO = 0;
export const LAYOUT_STEREO_LEFT_RIGHT = 1;
export const LAYOUT_STEREO_TOP_BOTTOM = 2;
export const LAYOUT_STEREO_ARRAY = 3;

function layoutCode(layout: XRHostLayer['layout']): number {
  switch (layout) {
    case 'stereo-left-right':
      return LAYOUT_STEREO_LEFT_RIGHT;
    case 'stereo-top-bottom':
      return LAYOUT_STEREO_TOP_BOTTOM;
    case 'stereo':
      return LAYOUT_STEREO_ARRAY;
    default:
      return LAYOUT_MONO;
  }
}

export class LayerBuffer {
  readonly u32: Uint32Array;
  readonly f32: Float32Array;
  /** Entries in the latest list written (diagnostics). */
  lastCount = 0;
  /** Lists longer than the buffer holds, so cut (diagnostics). */
  truncated = 0;

  constructor(buffer: ArrayBuffer) {
    this.u32 = new Uint32Array(buffer, 0, LAYER_BUFFER_WORDS);
    this.f32 = new Float32Array(buffer, 0, LAYER_BUFFER_WORDS);
  }

  /** The native side writes the layout it reads; a buffer of another layout is never written. */
  get valid(): boolean {
    return this.u32[VERSION_AT] === LAYER_BUFFER_VERSION;
  }

  /** Before IWER runs a frame: no list unless IWER submits one (an XRWebGLLayer session never does). */
  beginFrame(): void {
    this.u32[COUNT_AT] = NO_LIST;
  }

  /** The image layer swapchain `id` draws into next, 0 for none. */
  nameOf(id: number): number {
    return id >= 1 && id <= MAX_LAYER_SWAPCHAINS ? this.u32[NAMES_AT + id - 1] : 0;
  }

  /** IWER's submitLayers: the frame's list, in order (no allocation). */
  write(list: readonly XRHostLayer[]): void {
    const u32 = this.u32;
    const f32 = this.f32;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      if (count === MAX_LAYER_ENTRIES) {
        this.truncated++;
        break;
      }
      const l = list[i];
      const at = ENTRIES_AT + count * LAYER_ENTRY_WORDS;
      count++;
      u32[at + E_KIND] = l.kind === 'projection' ? KIND_PROJECTION : l.kind === 'quad' ? KIND_QUAD : KIND_CYLINDER;
      u32[at + E_ID] = l.id;
      u32[at + E_FLAGS] =
        (l.listed ? FLAG_LISTED : 0) |
        (l.redrawn ? FLAG_REDRAWN : 0) |
        (l.blendTextureSourceAlpha ? FLAG_BLEND_ALPHA : 0) |
        (l.viewerSpace ? FLAG_VIEWER : 0) |
        (l.located ? FLAG_LOCATED : 0);
      u32[at + E_LAYOUT] = layoutCode(l.layout);
      const pose = l.pose;
      for (let k = 0; k < 7; k++) f32[at + E_POSE + k] = pose[k];
      if (l.kind === 'cylinder') {
        f32[at + E_A] = l.radius;
        f32[at + E_B] = l.centralAngle;
        f32[at + E_C] = l.aspectRatio;
      } else {
        f32[at + E_A] = l.width;
        f32[at + E_B] = l.height;
        f32[at + E_C] = 0;
      }
    }
    u32[COUNT_AT] = count;
    this.lastCount = count;
  }
}
