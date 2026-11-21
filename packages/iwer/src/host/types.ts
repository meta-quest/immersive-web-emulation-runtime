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

/**
 * Parameters IWER passes to `beginSwapchain` when a session creates its
 * first projection layer, and once for every quad or cylinder layer (then
 * `layer` is set).
 */
export interface XRHostSwapchainOptions {
  /**
   * Images per swapchain entry: 2 for a 'texture-array' projection layer, 1
   * for one side-by-side image. For a quad or cylinder layer: 2 for a
   * 'texture-array' stereo layer, 1 otherwise.
   */
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
  /**
   * Set for a WebXR Layers quad or cylinder layer: the swapchain is that
   * layer's own (one per layer, next to the session's projection
   * swapchain). Absent for the projection swapchain.
   */
  layer?: XRHostContentLayerKind;
  /**
   * Quad and cylinder layers: the size of one image in pixels, exactly
   * (`scale` is 1 and not applied). It covers both views of a
   * 'stereo-left-right' (twice the view width) or 'stereo-top-bottom'
   * (twice the view height) layer.
   */
  width?: number;
  height?: number;
  /** Quad and cylinder layers: the page draws the layer once (`isStatic`). */
  isStatic?: boolean;
  /** Quad and cylinder layers: mip levels the page asked for (1 or more). */
  mipLevels?: number;
  /**
   * Quad and cylinder layers: 'texture-array' when the page draws the
   * layer through a TEXTURE_2D_ARRAY (`subImage.imageIndex` picks the
   * layer), also for a mono layer, whose array then has one layer
   * (`arraySize` 1).
   */
  textureType?: 'texture' | 'texture-array';
}

/** WebXR Layers layer types a host can present besides the projection layer. */
export type XRHostContentLayerKind = 'quad' | 'cylinder';

/**
 * How a layer's views share its images:
 * - `mono`: one view, the whole image, shown to both eyes;
 * - `stereo-left-right`: left eye in the left half, right eye in the right
 *   half of one image;
 * - `stereo-top-bottom`: left eye in the top half, right eye in the bottom
 *   half (GL's bottom-left origin: the left eye's rows are the upper ones);
 * - `stereo`: a 2-layer texture array, left eye in layer 0.
 */
export type XRHostLayerLayout =
  | 'mono'
  | 'stereo-left-right'
  | 'stereo-top-bottom'
  | 'stereo';

/**
 * One entry of the layer list IWER hands to `submitLayers` for a frame.
 * IWER owns these objects and rewrites them every frame; the host reads
 * them during the call only.
 */
export interface XRHostLayer {
  /** 'projection' is the session's projection layer (the frame's image). */
  kind: 'projection' | XRHostContentLayerKind;
  /** The `id` the host gave the layer's swapchain; 0 for the projection layer. */
  id: number;
  /**
   * In `renderState.layers`, so shown, in list order. False for a layer the
   * page drew this frame that is not in the list (its new content must
   * still become the layer's current image).
   */
  listed: boolean;
  /**
   * The page called `getSubImage` for the layer in this frame: the image it
   * received holds new content and should replace the layer's current one.
   * A layer the page did not draw keeps showing its last content.
   */
  redrawn: boolean;
  layout: XRHostLayerLayout;
  /** `blendTextureSourceAlpha`: blend by the texture's (premultiplied) alpha. */
  blendTextureSourceAlpha: boolean;
  /** False when the layer's space could not be located this frame (leave it out). */
  located: boolean;
  /**
   * Whether `pose` is relative to the viewer (a head-locked layer, whose
   * space is the viewer reference space) instead of the base space.
   */
  viewerSpace: boolean;
  /** The layer's centre: x, y, z, then quaternion x, y, z, w. */
  pose: Float32Array;
  /**
   * Quad: full width and height in metres. WebXR's `width` and `height`
   * are half-extents, as Quest Browser and the WebXR Layers polyfill draw
   * them, so these are twice the page's values.
   */
  width: number;
  height: number;
  /** Cylinder: radius (m), central angle (rad) and width / height. */
  radius: number;
  centralAngle: number;
  aspectRatio: number;
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
  /**
   * Quad and cylinder layers: the host's handle for the layer's swapchain,
   * which IWER passes back to `getLayerColorTexture`, `releaseSwapchain`
   * and in the layer list. Any number but 0.
   */
  id?: number;
}

/**
 * Where an exception that IWER caught during a host frame came from:
 * - `xr-frame-callback`: an `XRSession.requestAnimationFrame` callback;
 * - `window-frame`: `XRHostBackend.runWindowFrame`;
 * - `layer`: IWER's own per-frame work for an `XRWebGLLayer`, or the
 *   frame's layer list for `submitLayers`;
 * - `host-hook`: a per-frame `XRHostBackend` hook (`getPlanes`, `getMeshes`,
 *   `setPassthroughVisible`), the frame-start input update that reads the
 *   host's input state, or the hit test over the host's scene. The step that
 *   threw is skipped for that frame (no plane or mesh update, input left as
 *   far as it got); the frame goes on.
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
   * Called once per session, by the first projection layer (or
   * `XRWebGLLayer`) the page creates, and once by every quad or cylinder
   * layer (`options.layer` set; the answer must carry an `id`). Return null
   * if no swapchain could be made; the layer's constructor then throws an
   * `OperationError`.
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
   * Quad and cylinder layers: the `colorTexture` their sub-images report, one
   * `WebGLTexture` per layer swapchain (`id`) that refers to the image the
   * page draws into this frame, as `getOpaqueColorTexture` does for the
   * projection layer. Asked each time the page calls `getSubImage`. A host
   * without it cannot offer these layers: `createQuadLayer` and
   * `createCylinderLayer` throw NotSupportedError.
   */
  getLayerColorTexture?(id: number): WebGLTexture | null;
  /**
   * A quad or cylinder layer was destroyed (`layer.destroy()`): release its
   * swapchain. Not called when the session ends; the host releases every
   * layer swapchain of the session then.
   */
  releaseSwapchain?(id: number): void;
  /**
   * The frame's layers, called once per visible frame after the window
   * frame while the session presents through `renderState.layers` (not for
   * an `XRWebGLLayer`): the listed entries in `renderState.layers` order,
   * then layers drawn but not listed. Quad and cylinder entries refer to
   * live layers only (destroyed ones are left out).
   */
  submitLayers?(layers: readonly XRHostLayer[]): void;
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
   * session has plane-detection enabled, or has hit-test enabled and at least
   * one hit-test source (host mode hit-tests these planes and meshes). Each
   * `NativePlane` keeps its identity for as long as the host tracks it, and its
   * transform is in the base space. Assign a new `transform` or `polygon` to
   * report a change.
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
