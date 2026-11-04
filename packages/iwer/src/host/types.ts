/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { NativeMesh } from '../meshes/XRMesh.js';
import type { NativePlane } from '../planes/XRPlane.js';

/**
 * Host mode contract.
 *
 * A "host" is a program that embeds a JavaScript engine next to a native XR
 * runtime (for example an OpenXR app on Android) and uses IWER as the page's
 * WebXR implementation. The host decides when frames happen: for each
 * displayed frame it describes the tracking state in an {@link XRHostFrame}
 * and passes it to `XRDevice.runHostFrame`, which runs the page's XR
 * animation frame callbacks before returning. Rendering goes into images the
 * host owns, IWER creates no DOM, and no headset pose is emulated.
 *
 * Every pose in this contract is expressed in one host-chosen tracking space
 * (called the base space below). IWER treats that space as its global space;
 * `baseIsStage` tells IWER whether its origin sits on the floor.
 */

/**
 * The tracking state for one frame. The object belongs to the host, which may
 * reuse and overwrite it between frames; IWER only reads it while
 * `runHostFrame` is executing and does not hold on to it.
 */
export interface XRHostFrame {
  /** When the frame is expected to be displayed, on the page's `performance.now()` timeline. */
  predictedDisplayTime: number;
  /** When false, nothing from this frame will be displayed. */
  shouldRender: boolean;
  /** Number of views described in `views`: 1 for mono, 2 for stereo. */
  viewCount: number;
  /**
   * Packed view data, `HOST_VIEW_STRIDE` (11) numbers per view in this order:
   * position (x, y, z), orientation quaternion (x, y, z, w), and the four
   * field-of-view angles in radians as OpenXR's `XrFovf` defines them
   * (angleLeft, angleRight, angleUp, angleDown; angleLeft and angleDown are
   * normally negative). Must hold at least `viewCount * 11` numbers.
   */
  views: ArrayLike<number>;
  /** Pose of the OpenXR LOCAL space in the base space: x, y, z, then quaternion x, y, z, w. */
  localPose: ArrayLike<number>;
  /** Whether the base space's origin is on the floor (STAGE). False for a LOCAL base. */
  baseIsStage: boolean;
  /** GL texture name of the swapchain image the page renders into this frame, or 0. */
  colorTexture: number;
  /** Current display refresh rate in Hz, or 0 if the host does not know it. */
  frameRate: number;
}

/** Parameters IWER passes to `beginSwapchain` when a session creates its first layer. */
export interface XRHostSwapchainOptions {
  /** Images per swapchain entry: 2 for a 'texture-array' projection layer, 1 for one side-by-side image. */
  arraySize: number;
  /** Requested size relative to the runtime's recommended eye-buffer size. */
  scale: number;
  /** Sized GL internal format for the colour images (GL_RGBA8 when the page did not choose one). */
  format: number;
  /** Set for immersive-ar sessions: the real world should be visible behind the rendering. */
  passthrough?: boolean;
  /** Set for immersive-ar when the page's GL context does not premultiply alpha. */
  unpremultiplied?: boolean;
  /** Set when the session enabled plane-detection or mesh-detection. */
  scene?: boolean;
  /** Fixed foveation (0..1) implied by the session's requested features, if any. */
  foveation?: number;
}

/** What the host reports back from `beginSwapchain`. */
export interface XRHostSwapchain {
  /** Width of one image in pixels; with arraySize 1 it covers both eyes side by side. */
  width: number;
  /** Height of one image in pixels. */
  height: number;
  /** Image layers per swapchain entry, normally the requested arraySize. */
  arraySize: number;
  /** Display refresh rates the page may choose from. */
  rates?: ArrayLike<number>;
  /** Refresh rate in effect when the swapchain was created. */
  rate?: number;
  /** Whether a STAGE (bounded floor) space is available. */
  hasStage?: boolean;
  /** Stage extent along x, in metres. */
  stageWidth?: number;
  /** Stage extent along z, in metres. */
  stageDepth?: number;
  /** Fixed foveation actually applied, when it differs from the request. */
  foveation?: number;
}

/**
 * Where an exception that IWER caught during a host frame came from:
 * - `xr-frame-callback`: an `XRSession.requestAnimationFrame` callback;
 * - `window-frame`: `XRHostBackend.runWindowFrame`;
 * - `layer`: IWER's own per-frame work for an `XRWebGLLayer`;
 * - `host-hook`: a per-frame `XRHostBackend` hook (`getPlanes`, `getMeshes`,
 *   `setPassthroughVisible`) or the frame-start input update that reads the
 *   host's input state. The step that threw is skipped for that frame (no
 *   plane or mesh update, input left as far as it got); the frame goes on.
 */
export type XRHostErrorSource =
  | 'xr-frame-callback'
  | 'window-frame'
  | 'layer'
  | 'host-hook';

/**
 * The host side of host mode. IWER calls these members; only
 * `beginSwapchain` and `endSession` must be provided.
 */
export interface XRHostBackend {
  /**
   * Called once per session, by the first layer the page creates. Return
   * null if no swapchain could be made; the layer's constructor then throws
   * an `OperationError`.
   */
  beginSwapchain(options: XRHostSwapchainOptions): XRHostSwapchain | null;
  /**
   * The page called `XRSession.end()`. Release the swapchain and leave XR.
   * Not called when the host itself reported the end.
   */
  endSession(): void;
  /** Ask the display to switch refresh rate. Return false if the request is refused. */
  requestFrameRate?(rate: number): boolean;
  /** Apply a fixed foveation level between 0 (off) and 1 (strongest). */
  setFixedFoveation?(level: number): void;
  /** immersive-ar only: show (true) or hide (false) the passthrough background. */
  setPassthroughVisible?(visible: boolean): void;
  /**
   * The `colorTexture` that projection-layer sub-images report. Hosts return
   * a single `WebGLTexture` for the whole session and make that object refer
   * to whichever swapchain image is current, which is how a browser exposes
   * swapchain images too. Fetched once per session.
   */
  getOpaqueColorTexture?(): WebGLTexture | null;
  /** Wrap a GL texture name as a `WebGLTexture` (used by `XRWebGLLayer`). */
  wrapTexture?(name: number): WebGLTexture | null;
  /**
   * Run the page's `window.requestAnimationFrame` callbacks. IWER calls this
   * once per host frame, after the XR callbacks and before finishing the
   * `XRWebGLLayer` frame, including on frames where the XR callbacks were
   * skipped because the session is hidden.
   */
  runWindowFrame?(time: number): void;
  /**
   * Queue a task to run after the current host frame has returned. Used for
   * work that must not happen inside a frame (finishing an `end()` called
   * from an XR callback). IWER falls back to `setTimeout(callback, 0)`.
   */
  postTask?(callback: () => void): void;
  /** When true, `offerSession()` is granted immediately instead of waiting for `grantOfferedSession()`. */
  autoGrantOfferedSession?: boolean;
  /** `XRWebGLLayer`: discard its depth buffer once the frame is drawn. Defaults to true. */
  invalidateDepth?: boolean;
  /**
   * Planes the host currently tracks, read once per visible frame while the
   * session has plane-detection enabled. Each `NativePlane` keeps its
   * identity for as long as the host tracks it, and its transform is in the
   * base space. Assign a new `transform` or `polygon` to report a change.
   */
  getPlanes?(): ReadonlySet<NativePlane> | readonly NativePlane[] | null;
  /** Like `getPlanes`, for mesh-detection (assign new `vertices`/`indices` to report a change). */
  getMeshes?(): ReadonlySet<NativeMesh> | readonly NativeMesh[] | null;
  /**
   * Receives exceptions IWER catches while running a host frame (see
   * {@link XRHostErrorSource}). Without it they go to `console.error`. The
   * rest of the frame runs either way.
   */
  reportError?(error: unknown, source: XRHostErrorSource): void;
}

/** Runtime events a host passes to `XRDevice.dispatchHostEvent`. */
export type XRHostEvent =
  | { type: 'visibilitychange'; visible: boolean; focused: boolean }
  | { type: 'frameratechange'; rate: number }
  | { type: 'referencespacereset' }
  | { type: 'end' };
