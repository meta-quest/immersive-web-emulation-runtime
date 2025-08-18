/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRFrame } from '../frameloop/XRFrame.js';
import { XRInputSource } from '../input/XRInputSource.js';

interface XRInputSourceEventInit extends EventInit {
  frame: XRFrame;
  inputSource: XRInputSource;
}

export class XRInputSourceEvent extends Event {
  public readonly frame: XRFrame;
  public readonly inputSource: XRInputSource;

  constructor(type: string, eventInitDict: XRInputSourceEventInit) {
    super(type, eventInitDict);
    if (!eventInitDict.frame) {
      throw new Error('XRInputSourceEventInit.frame is required');
    }
    if (!eventInitDict.inputSource) {
      throw new Error('XRInputSourceEventInit.inputSource is required');
    }
    this.frame = eventInitDict.frame;
    this.inputSource = eventInitDict.inputSource;
  }
}

export interface XRInputSourceEventHandler {
  (evt: XRInputSourceEvent): any;
}
