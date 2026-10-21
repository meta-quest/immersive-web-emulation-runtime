/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_SPACE } from '../private.js';
import type { XRSession } from '../session/XRSession.js';
import type { XRSpace } from './XRSpace.js';

// The session that created each reference space. Offset spaces resolve to the
// space they were derived from.
const referenceSpaceSessions = new WeakMap<XRSpace, XRSession>();

export const recordSpaceSession = (space: XRSpace, session: XRSession) => {
  referenceSpaceSessions.set(space, session);
};

/**
 * The session a space belongs to, or undefined when IWER can't tell, such as
 * for input sources' spaces, which are shared by all sessions.
 */
export const getSpaceSession = (space: XRSpace): XRSession | undefined => {
  for (
    let current: XRSpace | undefined = space;
    current;
    current = current[P_SPACE].parentSpace
  ) {
    const session = referenceSpaceSessions.get(current);
    if (session) {
      return session;
    }
  }
  return undefined;
};
