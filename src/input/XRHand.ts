/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRJointSpace } from '../spaces/XRJointSpace.js';

export enum XRHandJoint {
  Wrist = 'wrist',

  ThumbMetacarpal = 'thumb-metacarpal',
  ThumbPhalanxProximal = 'thumb-phalanx-proximal',
  ThumbPhalanxDistal = 'thumb-phalanx-distal',
  ThumbTip = 'thumb-tip',

  IndexFingerMetacarpal = 'index-finger-metacarpal',
  IndexFingerPhalanxProximal = 'index-finger-phalanx-proximal',
  IndexFingerPhalanxIntermediate = 'index-finger-phalanx-intermediate',
  IndexFingerPhalanxDistal = 'index-finger-phalanx-distal',
  IndexFingerTip = 'index-finger-tip',

  MiddleFingerMetacarpal = 'middle-finger-metacarpal',
  MiddleFingerPhalanxProximal = 'middle-finger-phalanx-proximal',
  MiddleFingerPhalanxIntermediate = 'middle-finger-phalanx-intermediate',
  MiddleFingerPhalanxDistal = 'middle-finger-phalanx-distal',
  MiddleFingerTip = 'middle-finger-tip',

  RingFingerMetacarpal = 'ring-finger-metacarpal',
  RingFingerPhalanxProximal = 'ring-finger-phalanx-proximal',
  RingFingerPhalanxIntermediate = 'ring-finger-phalanx-intermediate',
  RingFingerPhalanxDistal = 'ring-finger-phalanx-distal',
  RingFingerTip = 'ring-finger-tip',

  PinkyFingerMetacarpal = 'pinky-finger-metacarpal',
  PinkyFingerPhalanxProximal = 'pinky-finger-phalanx-proximal',
  PinkyFingerPhalanxIntermediate = 'pinky-finger-phalanx-intermediate',
  PinkyFingerPhalanxDistal = 'pinky-finger-phalanx-distal',
  PinkyFingerTip = 'pinky-finger-tip',
}

export class XRHand extends Map<XRHandJoint, XRJointSpace> {}
