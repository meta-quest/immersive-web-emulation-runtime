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
  // Native support of the AR features (XR-PERM-1: a session can be granted one only when its flag is true).
  planeDetection?: boolean;
  meshDetection?: boolean;
  hitTest?: boolean;
  anchors?: boolean;
  /** Anchors can be persisted and restored by UUID (XR_FB_spatial_entity_storage + _query). */
  persistentAnchors?: boolean;
  /** XR-DEPTH-2: environment depth (XR_META_environment_depth) for 'depth-sensing', and its hand removal. */
  depthSensing?: boolean;
  depthHandRemoval?: boolean;
  explicitGrant?: boolean;
  /** XR-LAYER-1: quad and cylinder layers (cylinder needs XR_KHR_composition_layer_cylinder). */
  compositionLayers?: {
    quad: boolean;
    cylinder: boolean;
    maxLayers: number;
    bufferVersion: number;
  };
  layoutVersion?: number;
  extensions?: string[];
}

/** A quad or cylinder layer's swapchain (beginLayerSwapchain). */
export interface NativeLayerSwapchain {
  id: number;
  width: number;
  height: number;
  arraySize: number;
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

/** One entity of the room (runtime/xr xr_scene.h SceneEntity); geometry in the entity's own space. */
export interface SceneEntityData {
  id: string;
  /** Its pose slot in scenePoses(). */
  slot: number;
  /** The runtime's labels, comma separated ("TABLE", "WALL_FACE", ...). */
  labels: string;
  /** 2D boundary: x y pairs in the entity's x-y plane. */
  polygon?: Float32Array;
  /** 3D bounding box: offset x y z (minimum corner), extent w h d. */
  box?: Float32Array;
  vertices?: Float32Array;
  indices?: Uint32Array;
}

export interface SceneData {
  version: number;
  entities: SceneEntityData[];
}

/** A finished anchor request (runtime/xr xr_anchors.h AnchorResult). */
export interface NativeAnchorResult {
  request: number;
  ok: boolean;
  /** create, restore: the anchor id */
  anchor?: number;
  /** persist: the UUID */
  uuid?: string;
  error?: string;
}

/** kind of a frame-handler call. */
export const FRAME_XR = 1;
export const FRAME_TICK = 2;
export const FRAME_EVENTS = 3;

export interface XrNatives {
  info(): XrInfo;
  record(): ArrayBuffer;
  readonly layoutVersion: number;
  setFrameHandler(
    handler: ((kind: number, events?: XrNativeEvent[]) => void) | null,
  ): void;
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
  haptic(
    hand: number,
    intensity: number,
    durationMs: number,
    frequencyHz: number,
  ): void;
  sessionStarted(
    immersiveAR: boolean,
    handTracking: boolean,
    planes: boolean,
    meshes: boolean,
  ): void;
  offered(): void;
  /** Every offerSession()/requestSession() still pending was rejected and no session exists (XR-LIFE-7). */
  offerRejected?(): void;
  entryEvaluated(): void;
  runWindowFrame(): void;
  endFrameGL(): void;
  /** Quad and cylinder layers (runtime/xr iwn/xr/layers.h): the buffer shared with the XR thread. */
  layers?(): ArrayBuffer;
  /**
   * kind 2 quad, 3 cylinder; width x height pixels of one image; `textureArray`: the page draws through
   * TEXTURE_2D_ARRAYs (also with arraySize 1). Null when the swapchain cannot be made.
   */
  beginLayerSwapchain?(
    kind: number,
    width: number,
    height: number,
    arraySize: number,
    format: number,
    isStatic: boolean,
    mipLevels: number,
    textureArray: boolean,
  ): NativeLayerSwapchain | null;
  destroyLayerSwapchain?(id: number): void;
  /** The GL name of the image layer swapchain `id` draws into now (acquired at once), 0 when there is none. */
  acquireLayerImage?(id: number): number;
  /**
   * XR-PERM-1: asks Android for runtime permissions (one system dialog for the ones not held, after any request in
   * flight; none for those already put to the user in this process or not in the manifest) and resolves each name to
   * whether it is held once the dialog is answered.
   */
  requestPermissions?(names: string[]): Promise<Record<string, boolean>>;
  /** checkSelfPermission for each name; no dialog. */
  checkPermissions?(names: string[]): Record<string, boolean>;
  /** The permissions the app's manifest declares; null when the runtime cannot read them. */
  declaredPermissions?(): string[] | null;
  /** The room's entities when their version differs from `knownVersion`, else null; the first call starts the query. */
  sceneData?(knownVersion: number): SceneData | null;
  /** The pose table (8 floats per slot), written before each frame. */
  scenePoses?(): ArrayBuffer;
  sceneStatus?(): Record<string, unknown>;
  // Spatial anchors (xr_anchors_binding.cc); a request number of 0 means refused at once.
  anchorPoses?(): ArrayBuffer;
  anchorCreate?(
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): number;
  anchorPersist?(anchor: number): number;
  anchorRestore?(uuid: string): number;
  anchorErase?(uuid: string): number;
  anchorDestroy?(anchor: number): void;
  anchorResults?(): NativeAnchorResult[] | undefined;
  anchorStats?(): Record<string, unknown>;
  /** XR-DEPTH-2: the session enabled 'depth-sensing'; environment depth runs until it ends. */
  startDepth?(handRemoval: boolean): void;
  /** The depth record (depth.ts), the same memory every frame. */
  depthRecord?(): ArrayBuffer;
  readonly depthRecordVersion?: number;
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
  retargetTexture(
    gl: GLContext,
    tex: object,
    name: number,
    framebuffers: Iterable<object>,
  ): void;
  invalidateDepthStencil(gl: GLContext, fb: object): void;
  /** XR-DEPTH-2: clear a framebuffer holding the session image at frame start (older preludes lack it). */
  clearSessionFramebuffer?(gl: GLContext, fb: object): void;
  frameBoundary(gl: GLContext | null): void;
  afterAnimationFrame(): void;
}
