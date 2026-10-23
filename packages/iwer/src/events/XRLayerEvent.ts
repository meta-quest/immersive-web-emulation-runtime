/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { XRLayer } from '../layers/XRWebGLLayer.js';

interface XRLayerEventInit extends EventInit {
  layer: XRLayer;
}

export class XRLayerEvent extends Event {
  public readonly layer: XRLayer;

  constructor(type: string, eventInitDict: XRLayerEventInit) {
    super(type, eventInitDict);
    if (!eventInitDict?.layer) {
      throw new TypeError('XRLayerEventInit.layer is required');
    }
    this.layer = eventInitDict.layer;
  }
}

export interface XRLayerEventHandler {
  (evt: XRLayerEvent): any;
}
