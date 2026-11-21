/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The contracts this adapter consumes: globalThis.__iwn.xr (runtime/xr/src/v8/xr_binding.cc) and the WebGL
// prelude's host hooks (globalThis.__iwnWebGL, web/webgl/host.ts).

/** Capabilities of the OpenXR system (runtime/xr XrSystem::info). */
export interface XrInfo {
  available: boolean;
  error?: string;
  runtimeName?: string;
  runtimeVersion?: string;
  systemName?: string;
  /** ro.product.model, e.g. "Quest 3S". */
  model?: string;
  recommendedWidth?: number;
  recommendedHeight?: number;
  refreshRates?: number[];
  refreshRate?: number;
  hasStage?: boolean;
  stageWidth?: number;
  stageDepth?: number;
  baseIsStage?: boolean;
  handTracking?: boolean;
  passthrough?: boolean;
  /** immersive-ar is offered: passthrough is available and the config opted in (xr.immersiveAr, XR-AR-1). */
  immersiveAr?: boolean;
  foveation?: boolean;
  explicitGrant?: boolean;
  layoutVersion?: number;
  extensions?: string[];
}

export interface NativeSwapchain {
  width: number;
  height: number;
  arraySize: number;
  rates: number[];
  rate: number;
  hasStage: boolean;
  stageWidth: number;
  stageDepth: number;
  foveation?: number;
}

export type XrNativeEvent =
  | { type: 'visibilitychange'; visible: boolean; focused: boolean }
  | { type: 'frameratechange'; rate: number }
  | { type: 'referencespacereset' }
  | { type: 'end' }
  | { type: 'running'; running: boolean };

/** kind of a frame-handler call. */
export const FRAME_XR = 1;
export const FRAME_TICK = 2;
export const FRAME_EVENTS = 3;

export interface XrNatives {
  info(): XrInfo;
  record(): ArrayBuffer;
  readonly layoutVersion: number;
  setFrameHandler(handler: ((kind: number, events?: XrNativeEvent[]) => void) | null): void;
  beginSwapchain(
    arraySize: number,
    scale: number,
    format: number,
    foveation: number,
    passthrough: boolean,
    unpremultiplied: boolean,
  ): NativeSwapchain | null;
  endSession(): void;
  requestFrameRate(hz: number): boolean;
  setFoveation(level: number): void;
  setPassthroughVisible(visible: boolean): void;
  haptic(hand: number, intensity: number, durationMs: number, frequencyHz: number): void;
  sessionStarted(immersiveAR: boolean, handTracking: boolean, planes: boolean, meshes: boolean): void;
  offered(): void;
  /** Every offerSession()/requestSession() still pending was rejected and no session exists (XR-LIFE-7). */
  offerRejected?(): void;
  entryEvaluated(): void;
  runWindowFrame(): void;
  endFrameGL(): void;
}

/** The internal surface of a WebGL context the hooks below take (web/webgl Ctx). */
export interface GLContext {
  _makeCurrent(): void;
  bindFramebuffer(target: number, framebuffer: object | null): void;
  isFramebuffer(framebuffer: object | null): boolean;
  getParameter?(pname: number): unknown;
}

/** The WebGL prelude's host hooks (web/webgl/host.ts) this adapter uses. */
export interface WebGLHooks {
  wrapTexture(gl: GLContext, name: number, target?: number): object;
  retargetTexture(gl: GLContext, tex: object, name: number, framebuffers: Iterable<object>): void;
  invalidateDepthStencil(gl: GLContext, fb: object): void;
  frameBoundary(gl: GLContext | null): void;
  afterAnimationFrame(): void;
}
