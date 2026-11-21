/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IWER host mode's XRHostBackend over the native XR module (docs/spec/09 XRF-B-1..4).

import type { XRHostBackend, XRHostErrorSource, XRHostSwapchain, XRHostSwapchainOptions } from 'iwer/host';

import type { GraphicsBridge } from './graphics.ts';
import type { WebGLHooks, XrNatives } from './natives.ts';

type ReportError = (error: unknown) => void;

export class NativeHostBackend implements XRHostBackend {
  /** XR-LIFE-2: granted at once unless the runtime runs in explicit-grant mode (set from the capabilities). */
  autoGrantOfferedSession = true;
  /** XRWebGLLayer: discard its depth after each frame (GL-PERF-5). */
  invalidateDepth = true;
  private readonly natives: XrNatives;
  private readonly gfx: GraphicsBridge;
  private readonly hooks: WebGLHooks | null;
  private readonly report: ReportError;
  private readonly schedule: (cb: () => void) => void;

  constructor(
    natives: XrNatives,
    gfx: GraphicsBridge,
    hooks: WebGLHooks | null,
    report: ReportError,
    schedule: (cb: () => void) => void,
  ) {
    this.natives = natives;
    this.gfx = gfx;
    this.hooks = hooks;
    this.report = report;
    this.schedule = schedule;
  }

  beginSwapchain(o: XRHostSwapchainOptions): XRHostSwapchain | null {
    const r = this.natives.beginSwapchain(
      o.arraySize,
      o.scale,
      o.format,
      typeof o.foveation === 'number' ? o.foveation : -1,
      o.passthrough === true,
      o.unpremultiplied === true,
    );
    if (!r) return null;  // IWER throws OperationError from the layer constructor
    this.gfx.onSwapchain(r.arraySize);
    const answer: XRHostSwapchain = {
      width: r.width,
      height: r.height,
      arraySize: r.arraySize,
      rates: r.rates,
      rate: r.rate,
      hasStage: r.hasStage,
      stageWidth: r.stageWidth,
      stageDepth: r.stageDepth,
    };
    if (typeof r.foveation === 'number') answer.foveation = r.foveation;
    return answer;
  }

  endSession(): void {
    this.gfx.onSessionEnd();
    this.natives.endSession();
  }

  requestFrameRate(rate: number): boolean {
    return this.natives.requestFrameRate(rate);
  }

  setFixedFoveation(level: number): void {
    this.natives.setFoveation(level);
  }

  setPassthroughVisible(visible: boolean): void {
    this.natives.setPassthroughVisible(visible);
  }

  getOpaqueColorTexture(): object | null {
    return this.gfx.opaqueTexture();
  }

  wrapTexture(name: number): object | null {
    return this.gfx.wrap(name);
  }

  /**
   * Window rAF callbacks for this frame. The `time` IWER passes (the predicted display time) is ignored: window
   * callbacks get the frame's start time, which the native side holds (XRF-B-2, TMR-5).
   */
  runWindowFrame(_time: number): void {
    this.natives.runWindowFrame();
    this.hooks?.afterAnimationFrame();
  }

  /** A task after the current frame (IWER finishes an end() called from an XR callback this way). */
  postTask(callback: () => void): void {
    this.schedule(callback);
  }

  /** XR-LOOP-3: exceptions from XR callbacks are reported like uncaught ones; the frame goes on. */
  reportError(error: unknown, _source: XRHostErrorSource): void {
    this.report(error);
  }
}
