/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_DEVICE, P_REF_SPACE, P_SESSION } from '../private.js';
import type {
  XRHostBackend,
  XRHostErrorSource,
  XRHostEvent,
  XRHostFrame,
  XRHostSwapchain,
} from './types.js';
import { XRHostFrameLoop, XRHostFrameRequest } from './frame-loop.js';
import { XRHostFrameRate } from './frame-rate.js';
import { XRHostLayerRequest, XRHostOutput } from './output.js';
import { XRHostReferenceSpaces } from './reference-spaces.js';
import { XRHostScene } from './scene.js';
import { XRHostViews } from './views.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { XRReferenceSpaceEvent } from '../events/XRReferenceSpaceEvent.js';
import { XRSessionEvent } from '../events/XRSessionEvent.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import type { XRSession, XRVisibilityState } from '../session/XRSession.js';
import type { XRWebGLLayer } from '../layers/XRWebGLLayer.js';

/**
 * Host frame ids are counted across sessions, never restarting: pose caches
 * filed under spaces that outlive a session (the viewer space, host input
 * spaces) then cannot mistake a frame of a new session for the frame they
 * answered in the previous one.
 */
let hostFrameSerial = 0;

/** Maps the host's view of the session (OpenXR states) to WebXR visibility. */
function visibilityOf(visible: boolean, focused: boolean): XRVisibilityState {
  if (!visible) {
    return 'hidden';
  }
  return focused ? 'visible' : 'visible-blurred';
}

/**
 * The host-mode side of an `XRSession` (`session[P_SESSION].host`). It turns
 * host frames and host events into WebXR behaviour and delegates the details
 * to small parts: views, output (swapchain, foveation, passthrough), frame
 * rate, reference spaces, scene, and the frame loop.
 */
export class XRHostSession {
  readonly session: XRSession;
  readonly backend: XRHostBackend;
  readonly views = new XRHostViews();
  readonly output: XRHostOutput;
  readonly rate: XRHostFrameRate;
  readonly spaces: XRHostReferenceSpaces;
  readonly scene: XRHostScene;
  private readonly loop: XRHostFrameLoop;

  /** The host frame being run; null outside `runFrame`. */
  private current: XRHostFrame | null = null;
  /** `end()` was called during a frame; it completes once the frame returns. */
  private endAfterFrame = false;
  /** The end has been carried out (teardown done, `end` dispatched). */
  private closed = false;
  private endWaiters: Array<() => void> = [];

  private readonly reportCallbackError = (error: unknown) =>
    this.report(error, 'xr-frame-callback');

  constructor(session: XRSession, backend: XRHostBackend) {
    this.session = session;
    this.backend = backend;
    const s = session[P_SESSION];
    this.output = new XRHostOutput(backend, {
      immersiveAR: s.mode === 'immersive-ar',
      wantsScene: s.hasPlanes || s.hasMeshes,
      enabledFeatures: s.enabledFeatures,
    });
    this.rate = new XRHostFrameRate(backend);
    const globalSpace = s.device[P_DEVICE].globalSpace;
    this.spaces = new XRHostReferenceSpaces(globalSpace, this.output);
    this.scene = new XRHostScene(globalSpace, s.trackedPlanes, s.trackedMeshes);
    this.loop = new XRHostFrameLoop(session);
  }

  // -- used by XRSession, XRFrame and the layer classes ------------------------

  get frameRate(): number {
    return this.rate.current;
  }

  get supportedFrameRates(): Float32Array {
    return this.rate.supported;
  }

  get foveation(): number {
    return this.output.foveation;
  }

  setFoveation(level: number): void {
    this.output.setFoveation(level);
  }

  getOpaqueColorTexture(): WebGLTexture | null {
    return this.output.opaqueColorTexture();
  }

  /**
   * Called by a layer constructor: the session's swapchain, created by the
   * first layer. Throws InvalidStateError once the session has ended.
   */
  acquireSwapchain(request: XRHostLayerRequest): XRHostSwapchain {
    if (this.session[P_SESSION].ended) {
      throw new DOMException(
        'Cannot create a layer for an XRSession that has ended.',
        'InvalidStateError',
      );
    }
    const hadSwapchain = this.output.swapchain !== null;
    const swapchain = this.output.acquire(request);
    if (!hadSwapchain) {
      this.rate.adopt(this.output.offeredRates, this.output.initialRate);
    }
    return swapchain;
  }

  /** A pooled registration for `XRSession.requestAnimationFrame`. */
  frameRequest(
    handle: number,
    callback: (time: number, frame: XRFrame) => void,
  ): XRHostFrameRequest {
    return this.loop.request(handle, callback);
  }

  updateTargetFrameRate(rate: number): Promise<void> {
    return this.rate.request(rate, this.session[P_SESSION].ended);
  }

  /** `requestReferenceSpace` in host mode; null for unsupported types. */
  createReferenceSpace(type: XRReferenceSpaceType): XRReferenceSpace | null {
    if (type === XRReferenceSpaceType.Viewer) {
      return this.session[P_SESSION].device.viewerSpace;
    }
    return this.spaces.create(type, this.current);
  }

  // -- the frame -----------------------------------------------------------------

  /**
   * Runs one host frame (`XRDevice.runHostFrame`). Returns after the page's
   * XR callbacks, the window frame and the layer's end-of-frame work.
   */
  runFrame(frame: XRHostFrame): void {
    const session = this.session;
    const s = session[P_SESSION];
    if (s.ended) {
      return;
    }
    const device = s.device[P_DEVICE];
    const frameId = ++hostFrameSerial;
    const time = frame.predictedDisplayTime;
    this.current = frame;
    try {
      // WebXR: the pending render state becomes the active one as the frame
      // starts
      if (s.pendingRenderState !== null) {
        s.renderState = s.pendingRenderState;
        s.pendingRenderState = null;
      }
      const renderState = s.renderState;

      // tracking first, so everything below sees this frame's poses
      this.views.readPoses(frame, s.device);
      this.spaces.update(frame);

      try {
        this.output.syncPassthrough(renderState.passthroughFullyObscured);
      } catch (error) {
        this.report(error, 'host-hook');
      }
      if (this.rate.observe(frame.frameRate)) {
        this.announceRate();
      } else {
        this.rate.countFrame();
      }

      const visible = device.visibilityState !== 'hidden';
      const baseLayer = renderState.baseLayer as XRWebGLLayer | null;
      if (visible) {
        this.views.writeProjections(
          frame,
          renderState.depthNear,
          renderState.depthFar,
        );
        if (baseLayer) {
          this.guard(() => baseLayer.hostBindFrame(frame.colorTexture));
        }
        const xrFrame = this.loop.frameFor(frameId, time);
        // a host list that cannot be read leaves the scene as it was
        if (s.hasPlanes) {
          try {
            this.scene.syncPlanes(xrFrame, this.backend.getPlanes?.());
          } catch (error) {
            this.report(error, 'host-hook');
            this.scene.keepPlanes(xrFrame);
          }
        }
        if (s.hasMeshes) {
          try {
            this.scene.syncMeshes(xrFrame, this.backend.getMeshes?.());
          } catch (error) {
            this.report(error, 'host-hook');
            this.scene.keepMeshes(xrFrame);
          }
        }
        // input sources must reflect this frame before any callback runs
        this.loop.activate(xrFrame);
        try {
          device.onHostFrameStart(xrFrame);
        } catch (error) {
          this.report(error, 'host-hook');
        }
        s.updateActiveInputSources();
        this.loop.runCallbacks(xrFrame, time, this.reportCallbackError);
      }

      // the host has no browser to run window.requestAnimationFrame, so it
      // does that here, also while hidden
      if (this.backend.runWindowFrame) {
        try {
          this.backend.runWindowFrame(time);
        } catch (error) {
          this.report(error, 'window-frame');
        }
      }

      if (visible && baseLayer && !s.ended) {
        this.guard(() => baseLayer.hostEndFrame());
      }
    } finally {
      this.current = null;
    }

    if (this.endAfterFrame) {
      this.endAfterFrame = false;
      this.afterFrame(() => this.close(false));
    }
  }

  private guard(step: () => void): void {
    try {
      step();
    } catch (error) {
      this.report(error, 'layer');
    }
  }

  /** Routes an exception caught during a frame (WebXR: "report the exception"). */
  private report(error: unknown, source: XRHostErrorSource): void {
    const reporter = this.backend.reportError;
    if (reporter) {
      try {
        reporter.call(this.backend, error, source);
        return;
      } catch (reporterError) {
        console.error(reporterError);
      }
    }
    console.error(error);
  }

  private afterFrame(task: () => void): void {
    if (this.backend.postTask) {
      this.backend.postTask(task);
    } else {
      setTimeout(task, 0);
    }
  }

  /** Dispatches `frameratechange` for a new rate, then settles waiting requests. */
  private announceRate(): void {
    const session = this.session;
    session.dispatchEvent(new XRSessionEvent('frameratechange', { session }));
    this.rate.settle();
  }

  // -- host events and the end of the session ---------------------------------

  /** `XRDevice.dispatchHostEvent`. */
  onEvent(event: XRHostEvent): void {
    if (this.closed) {
      return;
    }
    const session = this.session;
    const s = session[P_SESSION];
    if (event.type === 'visibilitychange') {
      const device = s.device[P_DEVICE];
      const next = visibilityOf(event.visible, event.focused);
      if (next !== device.visibilityState) {
        device.visibilityState = next;
        device.pendingVisibilityState = null;
        session.dispatchEvent(
          new XRSessionEvent('visibilitychange', { session }),
        );
      }
    } else if (event.type === 'frameratechange') {
      if (this.rate.observe(event.rate)) {
        this.announceRate();
      }
    } else if (event.type === 'referencespacereset') {
      // every space the page asked for, except viewer spaces (the viewer
      // has no origin to reset), then the offset spaces derived from them.
      // Only spaces that exist now get a reset: both lists are measured
      // before the first handler runs, since handlers may add to them.
      const requested = s.referenceSpaces.slice();
      const offsetCount = this.spaces.offsetCount;
      for (let i = 0; i < requested.length; i++) {
        const space = requested[i];
        if (space[P_REF_SPACE].type !== XRReferenceSpaceType.Viewer) {
          space.dispatchEvent(
            new XRReferenceSpaceEvent('reset', { referenceSpace: space }),
          );
        }
      }
      this.spaces.resetOffsets(offsetCount);
    } else if (event.type === 'end') {
      s.ended = true;
      this.close(true);
    }
  }

  /** `XRSession.end()` in host mode. */
  end(): Promise<void> {
    const s = this.session[P_SESSION];
    if (s.ended) {
      return Promise.reject(
        new DOMException('XRSession has already ended.', 'InvalidStateError'),
      );
    }
    s.ended = true;
    const done = new Promise<void>((resolve) => this.endWaiters.push(resolve));
    if (this.current) {
      // inside a frame: finish after it returns
      this.endAfterFrame = true;
    } else {
      this.close(false);
    }
    return done;
  }

  /**
   * Shuts the session down once. `byHost`: the host ended it, so it is not
   * asked to end it again.
   */
  private close(byHost: boolean): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const session = this.session;
    session[P_SESSION].ended = true;
    session[P_SESSION].teardown();
    this.rate.abandon();
    this.spaces.clear();
    if (!byHost) {
      try {
        this.backend.endSession();
      } catch (error) {
        console.error(
          'XRSession.end(): XRHostBackend.endSession() threw',
          error,
        );
      }
    }
    this.output.release();
    // WebXR "shut down the session": the end event comes before the
    // promises returned by end() resolve
    session.dispatchEvent(new XRSessionEvent('end', { session }));
    const waiters = this.endWaiters;
    this.endWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
