/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_VIEWPORT } from '../private.js';

export class XRViewport {
  [P_VIEWPORT]: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  constructor(x: number, y: number, width: number, height: number) {
    this[P_VIEWPORT] = { x, y, width, height };
  }

  get x(): number {
    return this[P_VIEWPORT].x;
  }

  get y(): number {
    return this[P_VIEWPORT].y;
  }

  get width(): number {
    return this[P_VIEWPORT].width;
  }

  get height(): number {
    return this[P_VIEWPORT].height;
  }
}
