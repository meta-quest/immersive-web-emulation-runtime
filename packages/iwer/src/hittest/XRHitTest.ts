/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_HIT_TEST, P_SESSION } from '../private.js';

import { XRFrame } from '../frameloop/XRFrame.js';
import type { XRInputSource } from '../input/XRInputSource.js';
import { XRPose } from '../pose/XRPose.js';
import { XRRay } from './XRRay.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSession } from '../session/XRSession.js';
import { XRSpace } from '../spaces/XRSpace.js';

export type XRHitTestTrackableType = 'point' | 'plane' | 'mesh';

export interface XRHitTestOptionsInit {
  space: XRSpace;
  offsetRay?: XRRay;
  entityTypes?: XRHitTestTrackableType[];
}

export class XRHitTestSource {
  [P_HIT_TEST]: {
    session: XRSession;
    space: XRSpace;
    offsetRay: XRRay;
    entityTypes?: XRHitTestTrackableType[];
  };

  constructor(session: XRSession, options: XRHitTestOptionsInit) {
    this[P_HIT_TEST] = {
      session,
      space: options.space,
      offsetRay: options.offsetRay ?? new XRRay(),
      entityTypes: options.entityTypes,
    };
  }

  cancel() {
    this[P_HIT_TEST].session[P_SESSION].hitTestSources.delete(this);
  }
}

export interface XRTransientInputHitTestOptionsInit {
  profile: string;
  offsetRay?: XRRay;
  entityTypes?: XRHitTestTrackableType[];
}

/** WebXR Hit Test: a source for transient input (screen taps, transient pointers) with a given profile. */
export class XRTransientInputHitTestSource {
  [P_HIT_TEST]: {
    session: XRSession;
    profile: string;
    offsetRay: XRRay;
    entityTypes?: XRHitTestTrackableType[];
  };

  constructor(session: XRSession, options: XRTransientInputHitTestOptionsInit) {
    this[P_HIT_TEST] = {
      session,
      profile: String(options.profile ?? ''),
      offsetRay: options.offsetRay ?? new XRRay(),
      entityTypes: options.entityTypes,
    };
  }

  cancel() {
    this[P_HIT_TEST].session[P_SESSION].transientHitTestSources.delete(this);
  }
}

/** The hits of one transient input source this frame. */
export class XRTransientInputHitTestResult {
  [P_HIT_TEST]: {
    inputSource: XRInputSource;
    results: XRHitTestResult[];
  };

  constructor(inputSource: XRInputSource, results: XRHitTestResult[]) {
    this[P_HIT_TEST] = {
      inputSource,
      results: Object.freeze(results) as XRHitTestResult[],
    };
  }

  get inputSource(): XRInputSource {
    return this[P_HIT_TEST].inputSource;
  }

  get results(): readonly XRHitTestResult[] {
    return this[P_HIT_TEST].results;
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
    return (
      this[P_HIT_TEST].frame.getPose(this[P_HIT_TEST].offsetSpace, baseSpace) ??
      undefined
    );
  }

  createAnchor() {
    return this[P_HIT_TEST].frame.createAnchor(
      new XRRigidTransform(),
      this[P_HIT_TEST].offsetSpace,
    );
  }
}
