/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { XRFrame } from '../frameloop/XRFrame.js';
import type { XRTrackedInput } from './XRTrackedInput.js';

/*
 * The frame start of host-tracked input sources, in two phases: every source
 * writes its poses, buttons and axes, and only then do the button events
 * fire, in source order. A select or squeeze handler on one hand therefore
 * sees this frame's state of every source (the other hand included), and
 * once the events have fired nothing moves until the next frame, which the
 * pose cache in host/frame.ts relies on.
 *
 * Host sources call deferEdges from their edge step; outside
 * runHostInputFrame it returns false and they fire at once, as before.
 */

/** What deferEdges queues: a host source's edge step. */
interface EdgeSource {
  connected: boolean;
  applyEdges(frame: XRFrame): void;
}

let deferring = false;
// reused; emptied by popping so its storage stays (see utils/arrays.ts)
const queued: (EdgeSource | null)[] = [];

/**
 * Called by a host source about to fire its button events: queues it and
 * returns true while runHostInputFrame is writing sources, else false.
 */
export function deferEdges(source: object): boolean {
  if (!deferring) {
    return false;
  }
  queued.push(source as unknown as EdgeSource);
  return true;
}

/** The frame start of the listed host sources (see the header). */
export function runHostInputFrame(
  inputs: readonly XRTrackedInput[],
  frame: XRFrame,
): void {
  if (inputs.length === 0) {
    return;
  }
  deferring = true;
  try {
    for (let i = 0; i < inputs.length; i++) {
      inputs[i].onFrameStart(frame);
    }
    deferring = false;
    for (let i = 0; i < queued.length; i++) {
      const source = queued[i]!;
      queued[i] = null;
      // a handler may end the session, which disconnects every source
      if (source.connected) {
        source.applyEdges(frame);
      }
    }
  } finally {
    // also when something threw: nothing queued may leak into a later frame
    deferring = false;
    while (queued.length > 0) {
      queued.pop();
    }
  }
}
