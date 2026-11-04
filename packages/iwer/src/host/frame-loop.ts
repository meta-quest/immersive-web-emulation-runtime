/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_FRAME, P_SESSION } from '../private.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import type { XRSession } from '../session/XRSession.js';

/** An `XRSession.requestAnimationFrame` registration. */
export type XRHostFrameRequest = {
  handle: number;
  callback: (time: number, frame: XRFrame) => void;
  cancelled: boolean;
};

const idle = () => {};

/**
 * The garbage-free parts of a host session's "run animation frames" step
 * (WebXR Device API): recycled `XRFrame` objects and recycled callback
 * registrations.
 */
export class XRHostFrameLoop {
  private readonly session: XRSession;
  // XRFrame objects with the frame id each was last handed out for
  private readonly frames: XRFrame[] = [];
  // registrations whose callbacks have run, ready for requestAnimationFrame
  private readonly freeRequests: XRHostFrameRequest[] = [];
  // the registrations taken for the frame being run
  private readonly running: XRHostFrameRequest[] = [];

  constructor(session: XRSession) {
    this.session = session;
  }

  /** A registration for requestAnimationFrame, recycled when possible. */
  request(
    handle: number,
    callback: (time: number, frame: XRFrame) => void,
  ): XRHostFrameRequest {
    const recycled = this.freeRequests.pop();
    if (!recycled) {
      return { handle, callback, cancelled: false };
    }
    recycled.handle = handle;
    recycled.callback = callback;
    recycled.cancelled = false;
    return recycled;
  }

  /**
   * An inactive XRFrame for frame `frameId`. A page may keep the XRFrame of
   * one frame and compare it with the next one, so the object used for the
   * previous frame is never handed out again right away.
   */
  frameFor(frameId: number, time: number): XRFrame {
    let frame: XRFrame | undefined;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i][P_FRAME].id < frameId - 1) {
        frame = this.frames[i];
        break;
      }
    }
    if (!frame) {
      frame = new XRFrame(this.session, frameId, false, true, time);
      this.frames.push(frame);
    }
    const state = frame[P_FRAME];
    state.id = frameId;
    state.predictedDisplayTime = time;
    // guarded: V8's Set.prototype.clear allocates a new table even when the
    // set is already empty, and these stay empty without plane/mesh detection
    if (state.detectedPlanes.size > 0) {
      state.detectedPlanes.clear();
    }
    if (state.detectedMeshes.size > 0) {
      state.detectedMeshes.clear();
    }
    return frame;
  }

  /**
   * Makes `frame` the session's active frame. It stays active until
   * `runCallbacks` returns (WebXR: an XRFrame is only usable while the
   * callbacks it was made for run). Input sources are updated in between.
   */
  activate(frame: XRFrame): void {
    frame[P_FRAME].active = true;
    this.session[P_SESSION].activeFrame = frame;
  }

  /**
   * Runs the callbacks registered before this point, in registration order,
   * passing each the (already activated) `frame`, then deactivates it.
   * Callbacks registered while they run wait for the next frame; cancelled
   * ones are skipped; an exception from one goes to `report` and the others
   * still run.
   */
  runCallbacks(
    frame: XRFrame,
    time: number,
    report: (error: unknown) => void,
  ): void {
    const s = this.session[P_SESSION];
    const pending = s.frameCallbacks;
    const running = this.running;
    for (let i = 0; i < pending.length; i++) {
      running.push(pending[i]);
    }
    pending.length = 0;
    // cancelAnimationFrame looks here for callbacks of the frame being run
    s.currentFrameCallbacks = running;
    try {
      for (let i = 0; i < running.length; i++) {
        const request = running[i];
        if (request.cancelled) {
          continue;
        }
        try {
          request.callback(time, frame);
        } catch (error) {
          report(error);
        }
      }
    } finally {
      frame[P_FRAME].active = false;
      s.activeFrame = null;
      s.currentFrameCallbacks = null;
      for (let i = 0; i < running.length; i++) {
        running[i].callback = idle;
        this.freeRequests.push(running[i]);
      }
      running.length = 0;
    }
  }
}
