/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_HIT_TEST, P_SESSION } from '../private.js';

import { XRFrame } from '../frameloop/XRFrame.js';
import { XRPose } from '../pose/XRPose.js';
import { XRRay } from './XRRay.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSession } from '../session/XRSession.js';
import { XRSpace } from '../spaces/XRSpace.js';

export interface XRHitTestOptionsInit {
  space: XRSpace;
  offsetRay: XRRay;
}

export class XRHitTestSource {
  [P_HIT_TEST]: {
    session: XRSession;
    space: XRSpace;
    offsetRay: XRRay;
  };

  constructor(session: XRSession, options: XRHitTestOptionsInit) {
    this[P_HIT_TEST] = {
      session,
      space: options.space,
      offsetRay: options.offsetRay ?? new XRRay(),
    };
  }

  cancel() {
    this[P_HIT_TEST].session[P_SESSION].hitTestSources.delete(this);
  }
}

export class XRHitTestResult {
  [P_HIT_TEST]: {
    frame: XRFrame;
    offsetSpace: XRSpace;
  };

  constructor(frame: XRFrame, offsetSpace: XRSpace) {
    this[P_HIT_TEST] = { frame, offsetSpace };
  }

  getPose(baseSpace: XRSpace): XRPose | undefined {
    return this[P_HIT_TEST].frame.getPose(
      this[P_HIT_TEST].offsetSpace,
      baseSpace,
    );
  }

  createAnchor() {
    return this[P_HIT_TEST].frame.createAnchor(
      new XRRigidTransform(),
      this[P_HIT_TEST].offsetSpace,
    );
  }
}
