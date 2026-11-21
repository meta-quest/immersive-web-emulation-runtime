/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The part of IWER's host entry point (`iwer/host`, packages/iwer/src/host.ts) this adapter uses, written from
// IWER's contract files (src/host/types.ts, HOST-INPUT.md). build.mjs bundles the real module; declaring the
// subset here keeps the adapter's type check independent of IWER's build output.
declare module 'iwer/host' {
  export interface XRHostFrame {
    predictedDisplayTime: number;
    shouldRender: boolean;
    viewCount: number;
    views: ArrayLike<number>;
    localPose: ArrayLike<number>;
    baseIsStage: boolean;
    colorTexture: number;
    frameRate: number;
  }

  export interface XRHostSwapchainOptions {
    arraySize: number;
    scale: number;
    format: number;
    passthrough?: boolean;
    unpremultiplied?: boolean;
    scene?: boolean;
    foveation?: number;
    layer?: XRHostContentLayerKind;
    width?: number;
    height?: number;
    isStatic?: boolean;
    mipLevels?: number;
    textureType?: 'texture' | 'texture-array';
  }

  export type XRHostContentLayerKind = 'quad' | 'cylinder';
  export type XRHostLayerLayout = 'mono' | 'stereo-left-right' | 'stereo-top-bottom' | 'stereo';

  export interface XRHostLayer {
    kind: 'projection' | XRHostContentLayerKind;
    id: number;
    listed: boolean;
    redrawn: boolean;
    layout: XRHostLayerLayout;
    blendTextureSourceAlpha: boolean;
    located: boolean;
    viewerSpace: boolean;
    pose: Float32Array;
    width: number;
    height: number;
    radius: number;
    centralAngle: number;
    aspectRatio: number;
  }

  export interface XRHostSwapchain {
    width: number;
    height: number;
    arraySize: number;
    rates?: ArrayLike<number>;
    rate?: number;
    hasStage?: boolean;
    stageWidth?: number;
    stageDepth?: number;
    foveation?: number;
    id?: number;
  }

  export type XRHostErrorSource = 'xr-frame-callback' | 'window-frame' | 'layer' | 'host-hook';

  /** A DOMPointReadOnly (the runtime's, web/xr geometry.ts); the adapter's type check has no DOM library. */
  export interface HostPoint {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  }

  export class XRRigidTransform {
    constructor(position?: Partial<HostPoint>, orientation?: Partial<HostPoint>);
    readonly matrix: Float32Array;
    readonly position: HostPoint;
    readonly orientation: HostPoint;
  }

  export function overwriteTransformMatrix(transform: XRRigidTransform, source: ArrayLike<number>): void;

  export class NativePlane {
    constructor(transform: XRRigidTransform, polygon: HostPoint[], semanticLabel: string);
    transform: XRRigidTransform;
    polygon: HostPoint[];
    semanticLabel: string;
  }

  export class NativeMesh {
    constructor(transform: XRRigidTransform, vertices: Float32Array, indices: Uint32Array, semanticLabel: string);
    transform: XRRigidTransform;
    vertices: Float32Array;
    indices: Uint32Array;
    semanticLabel: string;
  }
  export type XRHostAnchor = object;

  export interface XRHostBackend {
    beginSwapchain(options: XRHostSwapchainOptions): XRHostSwapchain | null;
    endSession(): void;
    requestFrameRate?(rate: number): boolean;
    setFixedFoveation?(level: number): void;
    setPassthroughVisible?(visible: boolean): void;
    getOpaqueColorTexture?(): unknown;
    wrapTexture?(name: number): unknown;
    getLayerColorTexture?(id: number): unknown;
    releaseSwapchain?(id: number): void;
    submitLayers?(layers: readonly XRHostLayer[]): void;
    runWindowFrame?(time: number): void;
    postTask?(callback: () => void): void;
    autoGrantOfferedSession?: boolean;
    invalidateDepth?: boolean;
    reportError?(error: unknown, source: XRHostErrorSource): void;
    getPlanes?(): ReadonlySet<NativePlane> | readonly NativePlane[] | null;
    getMeshes?(): ReadonlySet<NativeMesh> | readonly NativeMesh[] | null;
    createAnchor?(transform: Float32Array): Promise<XRHostAnchor>;
    getAnchorPose?(anchor: XRHostAnchor, out: Float32Array): boolean;
    deleteAnchor?(anchor: XRHostAnchor): void;
    persistAnchor?(anchor: XRHostAnchor): Promise<string>;
    restoreAnchor?(uuid: string): Promise<XRHostAnchor>;
    erasePersistentAnchor?(uuid: string): Promise<void>;
    getPersistentAnchors?(): readonly string[];
  }

  export type XRHostEvent =
    | { type: 'visibilitychange'; visible: boolean; focused: boolean }
    | { type: 'frameratechange'; rate: number }
    | { type: 'referencespacereset' }
    | { type: 'end' };

  export class XRHostInputState {
    readonly handedness: 'left' | 'right';
    mode: number;
    readonly targetRay: Float32Array;
    targetRayValid: boolean;
    readonly grip: Float32Array;
    gripValid: boolean;
    readonly palm: Float32Array;
    palmValid: boolean;
    readonly buttonValues: Float32Array;
    readonly buttonPressed: Uint8Array;
    readonly buttonTouched: Uint8Array;
    readonly axes: Float32Array;
    readonly joints: Float32Array;
    readonly jointValid: Uint8Array;
  }

  export type XRHostHapticCallback = (
    handedness: 'left' | 'right',
    intensity: number,
    durationMs: number,
    frequencyHz: number,
  ) => void | Promise<boolean>;

  export class XRHostInput {
    readonly left: XRHostInputState;
    readonly right: XRHostInputState;
    onHaptic: XRHostHapticCallback | null;
  }

  export interface XRControllerConfig {
    profileId: string;
    fallbackProfileIds: string[];
    layout: unknown;
  }

  export interface XRDeviceConfig {
    name: string;
    controllerConfig: XRControllerConfig | undefined;
    supportedSessionModes: string[];
    supportedFeatures: string[];
    supportedFrameRates: number[];
    isSystemKeyboardSupported: boolean;
    internalNominalFrameRate: number;
    environmentBlendModes: Record<string, string>;
    interactionMode: string;
    userAgent: string;
  }

  export class XRDevice {
    constructor(config: XRDeviceConfig, options?: { host?: XRHostBackend });
    installRuntime(options?: { globalObject?: object }): void;
    enableHostInput(options?: {
      leftMenuButton?: boolean;
      onHaptic?: XRHostHapticCallback | null;
      controllerConfig?: XRControllerConfig;
    }): XRHostInput;
    disableHostInput(): void;
    readonly hostInput: XRHostInput | null;
    runHostFrame(frame: XRHostFrame): void;
    dispatchHostEvent(event: XRHostEvent): void;
    grantOfferedSession(): void;
    readonly activeSession: object | undefined;
    readonly sessionOffered: boolean;
  }

  export class XRSystem {
    isSessionSupported(mode: string): Promise<boolean>;
    requestSession(mode: string, init?: object): Promise<object>;
    offerSession(mode: string, init?: object): Promise<object>;
  }

  export const metaQuestTouchPlus: XRControllerConfig;
  export const metaQuestTouchPro: XRControllerConfig;
  export const oculusTouchV3: XRControllerConfig;
  export const oculusTouchV2: XRControllerConfig;
}
