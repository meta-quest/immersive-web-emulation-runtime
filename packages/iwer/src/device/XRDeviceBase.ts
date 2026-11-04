/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { GlobalSpace, XRSpace } from '../spaces/XRSpace.js';
import { GamepadButton } from '../gamepad/Gamepad.js';
import { resetButton } from '../gamepad/button-edges.js';
import {
  P_DEVICE,
  P_HOST_INPUT,
  P_REF_SPACE,
  P_SESSION,
  P_SPACE,
  P_SYSTEM,
} from '../private.js';
import { Quaternion, Vector3 } from '../utils/Math.js';
import type { ControlMode } from '../types/state.js';
import type { RemoteControlInterface } from '../remote/RemoteControlInterface.js';
import { XRController, XRControllerConfig } from './XRController.js';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
  XRSession,
  XRSessionMode,
  XRVisibilityState,
} from '../session/XRSession.js';
import { XREye, XRView } from '../views/XRView.js';
import { XRHandInput, oculusHandConfig } from './XRHandInput.js';
import {
  XRHandedness,
  XRInputSource,
  XRInputSourceArray,
} from '../input/XRInputSource.js';
import { XRLayer, XRWebGLLayer } from '../layers/XRWebGLLayer.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { mat4, vec3 } from 'gl-matrix';

import type {
  ActionPlayer,
  ActionPlayerOptions,
  CompressedRecording,
} from '../action/ActionPlayer.js';
import { VERSION } from '../version.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import { XRHand } from '../input/XRHand.js';
import { XRInputSourceEvent } from '../events/XRInputSourceEvent.js';
import { XRInputSourcesChangeEvent } from '../events/XRInputSourcesChangeEvent.js';
import { XRJointPose } from '../pose/XRJointPose.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRPose } from '../pose/XRPose.js';
import { XRReferenceSpaceEvent } from '../events/XRReferenceSpaceEvent.js';
import { XRRenderState } from '../session/XRRenderState.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSessionEvent } from '../events/XRSessionEvent.js';
import { XRSystem } from '../initialization/XRSystem.js';
import { XRTrackedInput } from './XRTrackedInput.js';
import { XRHostInput, XRHostInputOptions } from './XRHostInput.js';
import { runHostInputFrame } from './host-input-frame.js';
import { XRGazeInput, supportsGazeTracking } from './XRGazeInput.js';
import { XRViewerPose } from '../pose/XRViewerPose.js';
import { XRViewport } from '../views/XRViewport.js';
import { NativePlane } from '../planes/XRPlane.js';
import { NativeMesh } from '../meshes/XRMesh.js';
import type { DepthSensingData } from '../depth/XRDepthInformation.js';
import { XRWebGLBinding } from '../depth/XRWebGLBinding.js';
import type { XRRuntimeAdapter } from '../types/runtime-session.js';
import type { XRDevice } from './XRDevice.js';
import type { XRHostBackend, XRHostEvent, XRHostFrame } from '../host/types.js';
import { XRHostWebGLBinding } from '../host/XRHostWebGLBinding.js';
import { XRBoundedReferenceSpace } from '../spaces/XRBoundedReferenceSpace.js';
import {
  XRCompositionLayer,
  XRProjectionLayer,
  XRWebGLSubImage,
} from '../layers/XRProjectionLayer.js';
import {
  calculateVisibilityMaskBounds,
  type XRVisibilityMask,
} from './XRVisibilityMask.js';

export type WebXRFeature =
  | 'viewer'
  | 'local'
  | 'local-floor'
  | 'bounded-floor'
  | 'unbounded'
  | 'dom-overlay'
  | 'anchors'
  | 'plane-detection'
  | 'mesh-detection'
  | 'hit-test'
  | 'hand-tracking'
  | 'gaze-tracking'
  | 'eye-tracking'
  | 'depth-sensing'
  // WebXR Layers and Quest Browser's startup foveation levels (host mode)
  | 'layers'
  | 'high-fixed-foveation-level'
  | 'medium-fixed-foveation-level'
  | 'low-fixed-foveation-level';

export interface XRDeviceConfig {
  name: string;
  controllerConfig: XRControllerConfig | undefined;
  supportedSessionModes: XRSessionMode[];
  supportedFeatures: WebXRFeature[];
  supportedFrameRates: number[];
  isSystemKeyboardSupported: boolean;
  internalNominalFrameRate: number;
  environmentBlendModes: Partial<{
    [sessionMode in XRSessionMode]: XREnvironmentBlendMode;
  }>;
  interactionMode: XRInteractionMode;
  userAgent: string;
  /** Optional per-eye angular mask used to preview a narrower headset FOV. */
  visibilityMask?: XRVisibilityMask;
}

export interface XRDeviceOptions {
  ipd: number;
  fovy: number;
  stereoEnabled: boolean;
  headsetPosition: Vector3;
  headsetQuaternion: Quaternion;
  canvasContainer: HTMLDivElement;
  /** Override or disable the device config's visibility mask. */
  visibilityMask: XRVisibilityMask | null;
  /** Whether a configured visibility mask starts enabled. */
  visibilityMaskEnabled: boolean;
  /**
   * Whether immersive sessions clear the base layer at the start of every
   * frame. Defaults to `true`. See {@link XRDeviceBase.frameClearEnabled}.
   */
  frameClearEnabled: boolean;
  /**
   * Decides, once per immersive-ar frame, whether the synthetic environment is
   * drawn. Defaults to `null` (always drawn). See
   * {@link XRDeviceBase.shouldDrawEnvironment}.
   */
  shouldDrawEnvironment: (() => boolean) | null;
  /**
   * Host mode (see host/types.ts): a native host drives frames through
   * runHostFrame and backs layers with its swapchain. IWER then touches no
   * DOM and emulates no headset pose.
   */
  host: XRHostBackend;
}

const DEFAULTS = {
  ipd: 0.063,
  fovy: Math.PI / 2,
  headsetPosition: new Vector3(0, 1.6, 0),
  headsetQuaternion: new Quaternion(),
  stereoEnabled: false,
  frameClearEnabled: true,
  shouldDrawEnvironment: null,
};

// DevUI and SEM are written against the full entry's XRDevice, the only
// device that installs them.
export interface DevUIConstructor {
  new (xrDevice: XRDevice): DevUI;
}
export interface DevUI {
  version: string;
  render(time: number): void;
  applyDefaultPose?(defaultPose: unknown): void;
  setGazeMode?(mode: 'off' | 'cursor' | 'head-locked'): void;
  setGazeCommitHand?(handedness: 'left' | 'right'): void;
  onSessionEnd?(): void;
  get devUICanvas(): HTMLCanvasElement;
  get devUIContainer(): HTMLDivElement;
}

export interface SEMConstructor {
  new (xrDevice: XRDevice): SyntheticEnvironmentModule;
}
export interface SyntheticEnvironmentModule {
  version: string;
  /** Update the environment for a frame, then draw it. */
  render(time: number): void;
  // Optional, so older or custom modules that only render() still fit.
  /**
   * Update the environment for a frame without drawing: scene logic, world
   * matrices (read by hit tests) and the camera. Modules with both `update`
   * and `draw` are drawn separately, after the app's frame callbacks, so a
   * host can skip draws with {@link XRDeviceBase.shouldDrawEnvironment}.
   */
  update?(time: number): void;
  /** Draw the environment as of the last {@link update}. */
  draw?(): void;
  // The concrete environment schema (`SceneFile`) is defined in the `sem`
  // package, which depends on `iwer`; importing it here would create a
  // circular dependency. The SEM implementation casts this to its schema.
  loadEnvironment(json: unknown): void;
  loadDefaultEnvironment(envId: string): Promise<void>;
  // Optional, so older or custom modules without GLTS support still fit.
  /** Adds a `.glts` environment that loadDefaultEnvironment(id) can load. */
  addEnvironment?(id: string, url: string | URL): void;
  /** Ids of the built-in and added environments. */
  readonly environments?: string[];
  /** Whether an environment is a built-in room, added, or a legacy scan. */
  environmentInfo?(
    id: string,
  ): { kind: 'room' | 'added' | 'legacy-scan' } | undefined;
  planesVisible: boolean;
  boundingBoxesVisible: boolean;
  meshesVisible: boolean;
  get environmentCanvas(): HTMLCanvasElement;
  get trackedPlanes(): Set<NativePlane>;
  get trackedMeshes(): Set<NativeMesh>;
  deleteAll(): void;
  computeHitTestResults(rayMatrix: mat4): mat4[];
  computeDepthBuffer(
    viewMatrix: mat4,
    projectionMatrix: mat4,
    width: number,
    height: number,
    depthNear: number,
    depthFar: number,
  ): DepthSensingData | null;
}

/**
 * Host object that receives or supplies WebXR constructor globals. Both arms
 * are load-bearing: the record arm accepts partial test doubles, and the
 * `typeof globalThis` arm keeps `window` (typed `Window & typeof globalThis`)
 * assignable without a cast. Do not collapse to one.
 */
export type XRGlobalObject = typeof globalThis | Record<string, unknown>;

type GlobalObjectRecord = Record<string, unknown>;

export interface RuntimeOptions {
  globalObject?: XRGlobalObject;
  polyfillLayers?: boolean;
  /**
   * When a native `navigator.xr` is already present, installRuntime skips
   * clobbering the existing runtime and warns instead. Set this to `true` to
   * force the emulated runtime to be installed over the native one. Required for
   * browser-extension use, where the whole point is to override native WebXR.
   */
  forceInstall?: boolean;
}

/** Longest frame delta remote control advances by in one frame. */
export const MAX_REMOTE_FRAME_MS = 100;

const Z_INDEX_SEM_CANVAS = 1;
const Z_INDEX_APP_CANVAS = 2;
const Z_INDEX_DEVUI_CANVAS = 3;
const Z_INDEX_VISIBILITY_MASK = 4;
const Z_INDEX_DEVUI_CONTAINER = 5;

// scratch buffers for per-frame view offset updates (consumed synchronously
// within updateViews via mat4.fromTranslation, never returned to callers)
const leftViewOffsetScratch = vec3.create();
const rightViewOffsetScratch = vec3.create();

/**
 * Optional parts of a device that pull in a lot of code. `XRDevice` (the
 * main `iwer` entry) supplies all of them; the `iwer/host` entry builds
 * devices without them, so a native host does not ship code it never runs.
 */
export interface XRDeviceExtensions {
  /** Creates `device.remote`. Without it `device.remote` is null. */
  createRemoteControl?(device: XRDeviceBase): RemoteControlInterface;
  /** Backs `device.createActionPlayer`. Without it that method throws. */
  createActionPlayer?(
    refSpace: XRReferenceSpace,
    recording: CompressedRecording,
    ipd: number,
    options: ActionPlayerOptions,
  ): ActionPlayer;
  /** Installs the WebXR Layers polyfill (`installRuntime({ polyfillLayers })`). */
  installLayersPolyfill?(): void;
}

/**
 * The device model shared by every IWER entry point. XRDevice is not a
 * standard API class outlined in the WebXR Device API Specifications.
 * Instead, it serves as an user-facing interface to control the emulated XR
 * Device (or, in host mode, the device a native host drives).
 */
export class XRDeviceBase {
  public readonly version = VERSION;

  [P_DEVICE]: {
    // device config
    name: string;
    supportedSessionModes: string[];
    supportedFeatures: WebXRFeature[];
    supportedFrameRates: number[];
    isSystemKeyboardSupported: boolean;
    internalNominalFrameRate: number;
    environmentBlendModes: Partial<{
      [sessionMode in XRSessionMode]: XREnvironmentBlendMode;
    }>;
    interactionMode: XRInteractionMode;
    userAgent: string;

    // device state
    position: Vector3;
    quaternion: Quaternion;
    stereoEnabled: boolean;
    ipd: number;
    fovy: number;
    frameClearEnabled: boolean;
    shouldDrawEnvironment: (() => boolean) | null;
    visibilityMask?: XRVisibilityMask;
    visibilityMaskEnabled: boolean;
    visibilityMaskCanvas?: HTMLCanvasElement;
    controllers: { [key in XRHandedness]?: XRController };
    hands: { [key in XRHandedness]?: XRHandInput };
    gaze?: XRGazeInput;
    primaryInputMode: 'controller' | 'hand';
    // Real tracking driving the input sources instead of the emulated ones.
    hostInput: XRHostInput | null;
    pendingReferenceSpaceReset: boolean;
    visibilityState: XRVisibilityState;
    pendingVisibilityState: XRVisibilityState | null;
    xrSystem: XRSystem | null;

    // runtime install/uninstall bookkeeping: descriptors captured at install
    // time so uninstallRuntime can best-effort restore the previous globals.
    installedGlobalObject: GlobalObjectRecord | null;
    previousNavigatorXRDescriptor: PropertyDescriptor | null;
    previousUserAgentDescriptor: PropertyDescriptor | null;
    previousGlobals: Map<string, { existed: boolean; value: unknown }> | null;
    previousMakeXRCompatible: Map<
      object,
      { existed: boolean; descriptor: PropertyDescriptor | undefined }
    > | null;

    matrix: mat4;
    globalSpace: GlobalSpace;
    viewerSpace: XRReferenceSpace;
    viewSpaces: { [key in XREye]: XRSpace };

    canvasData?: {
      canvas: HTMLCanvasElement;
      parent: HTMLElement | null;
      width: number;
      height: number;
      zIndex: string;
    };
    canvasContainer: HTMLDivElement;

    getViewport: (layer: XRWebGLLayer, view: XRView) => XRViewport;
    viewportCache: { [key in XREye]?: XRViewport };
    updateViews: () => void;
    onBaseLayerSet: (baseLayer: XRWebGLLayer | null) => void;
    onSessionEnd: () => void;
    onFrameStart: (frame: XRFrame) => void;

    // action playback
    actionPlayer?: ActionPlayer;

    // add-on modules:
    devui?: DevUI;
    sem?: SyntheticEnvironmentModule;

    // control mode for programmatic access
    controlMode: ControlMode;
    controlModeListeners: Set<(mode: ControlMode) => void>;
    stateChangeListeners: Set<() => void>;

    // remote control interface (null when built without it, see XRDeviceExtensions)
    remote: RemoteControlInterface | null;
    extensions: XRDeviceExtensions;
    // runtime-neutral session bridge used by RemoteControlInterface
    runtime: XRRuntimeAdapter;

    // frame timing for remote update
    lastFrameTime: number;

    // host mode backend, null when emulating
    host: XRHostBackend | null;
    // host mode's onFrameStart: inputs only, poses come from the host
    onHostFrameStart: (frame: XRFrame) => void;
  };

  constructor(
    deviceConfig: XRDeviceConfig,
    deviceOptions: Partial<XRDeviceOptions> = {},
    extensions: XRDeviceExtensions = {},
  ) {
    const globalSpace = new GlobalSpace();
    const viewerSpace = new XRReferenceSpace(
      XRReferenceSpaceType.Viewer,
      globalSpace,
    );
    const viewSpaces: { [key in XREye]: XRSpace } = {
      [XREye.Left]: new XRSpace(viewerSpace),
      [XREye.Right]: new XRSpace(viewerSpace),
      [XREye.None]: new XRSpace(viewerSpace),
    };
    const controllerConfig = deviceConfig.controllerConfig;
    const controllers: { [key in XRHandedness]?: XRController } = {};
    if (controllerConfig) {
      Object.values(XRHandedness).forEach((handedness) => {
        if (controllerConfig.layout[handedness]) {
          controllers[handedness] = new XRController(
            controllerConfig,
            handedness,
            globalSpace,
          );
        }
      });
    }
    const hands = {
      [XRHandedness.Left]: new XRHandInput(
        oculusHandConfig,
        XRHandedness.Left,
        globalSpace,
      ),
      [XRHandedness.Right]: new XRHandInput(
        oculusHandConfig,
        XRHandedness.Right,
        globalSpace,
      ),
    };
    const gaze = supportsGazeTracking(deviceConfig.supportedFeatures)
      ? new XRGazeInput(viewerSpace)
      : undefined;
    const host = deviceOptions.host ?? null;
    // Host mode renders nothing itself, so it creates no DOM: the container
    // is never read there (onBaseLayerSet/onSessionEnd skip it).
    const canvasContainer = host
      ? (undefined as unknown as HTMLDivElement)
      : (deviceOptions.canvasContainer ?? document.createElement('div'));
    if (!host) {
      canvasContainer.dataset.webxr_runtime = `Immersive Web Emulation Runtime v${VERSION}`;
      canvasContainer.style.position = 'fixed';
      canvasContainer.style.width = '100%';
      canvasContainer.style.height = '100%';
      canvasContainer.style.top = '0';
      canvasContainer.style.left = '0';
      canvasContainer.style.display = 'flex';
      canvasContainer.style.justifyContent = 'center';
      canvasContainer.style.alignItems = 'center';
      canvasContainer.style.overflow = 'hidden';
      canvasContainer.style.zIndex = '999';
    }
    const visibilityMask =
      deviceOptions.visibilityMask === null || host
        ? undefined
        : (deviceOptions.visibilityMask ?? deviceConfig.visibilityMask);
    const visibilityMaskCanvas = visibilityMask
      ? document.createElement('canvas')
      : undefined;
    if (visibilityMaskCanvas) {
      visibilityMaskCanvas.dataset.webxrVisibilityMask = deviceConfig.name;
      visibilityMaskCanvas.style.position = 'absolute';
      visibilityMaskCanvas.style.inset = '0';
      visibilityMaskCanvas.style.width = '100%';
      visibilityMaskCanvas.style.height = '100%';
      visibilityMaskCanvas.style.pointerEvents = 'none';
      visibilityMaskCanvas.style.zIndex = Z_INDEX_VISIBILITY_MASK.toString();
    }

    this[P_DEVICE] = {
      name: deviceConfig.name,
      supportedSessionModes: deviceConfig.supportedSessionModes,
      supportedFeatures: deviceConfig.supportedFeatures,
      supportedFrameRates: deviceConfig.supportedFrameRates,
      isSystemKeyboardSupported: deviceConfig.isSystemKeyboardSupported,
      internalNominalFrameRate: deviceConfig.internalNominalFrameRate,
      environmentBlendModes: deviceConfig.environmentBlendModes,
      interactionMode: deviceConfig.interactionMode,
      userAgent: deviceConfig.userAgent,

      position:
        deviceOptions.headsetPosition ?? DEFAULTS.headsetPosition.clone(),
      quaternion:
        deviceOptions.headsetQuaternion ?? DEFAULTS.headsetQuaternion.clone(),
      stereoEnabled: deviceOptions.stereoEnabled ?? DEFAULTS.stereoEnabled,
      frameClearEnabled:
        deviceOptions.frameClearEnabled ?? DEFAULTS.frameClearEnabled,
      shouldDrawEnvironment:
        deviceOptions.shouldDrawEnvironment ?? DEFAULTS.shouldDrawEnvironment,
      ipd: deviceOptions.ipd ?? DEFAULTS.ipd,
      fovy: deviceOptions.fovy ?? DEFAULTS.fovy,
      visibilityMask,
      visibilityMaskEnabled:
        Boolean(visibilityMask) &&
        (deviceOptions.visibilityMaskEnabled ?? true),
      visibilityMaskCanvas,
      controllers,
      hands,
      gaze,
      primaryInputMode: 'controller',
      hostInput: null,
      pendingReferenceSpaceReset: false,
      visibilityState: 'visible',
      pendingVisibilityState: null,
      xrSystem: null,

      installedGlobalObject: null,
      previousNavigatorXRDescriptor: null,
      previousUserAgentDescriptor: null,
      previousGlobals: null,
      previousMakeXRCompatible: null,

      matrix: mat4.create(),
      globalSpace,
      viewerSpace,
      viewSpaces,
      canvasContainer,

      getViewport: (layer: XRWebGLLayer, view: XRView) => {
        const canvas = layer.context.canvas;
        const { width, height } = canvas;
        const stereoEnabled = this[P_DEVICE].stereoEnabled;
        const eye = view.eye;
        let x: number;
        let y: number;
        let vpWidth: number;
        let vpHeight: number;
        switch (eye) {
          case XREye.None:
            x = 0;
            y = 0;
            vpWidth = width;
            vpHeight = height;
            break;
          case XREye.Left:
            x = 0;
            y = 0;
            vpWidth = stereoEnabled ? width / 2 : width;
            vpHeight = height;
            break;
          case XREye.Right:
            x = width / 2;
            y = 0;
            // zero-width right viewport in mono is deliberate
            vpWidth = stereoEnabled ? width / 2 : 0;
            vpHeight = height;
            break;
        }
        // cache per (eye, width, height, stereoEnabled): return the cached
        // instance unless one of those changed
        const cached = this[P_DEVICE].viewportCache[eye];
        if (
          cached &&
          cached.x === x &&
          cached.y === y &&
          cached.width === vpWidth &&
          cached.height === vpHeight
        ) {
          return cached;
        }
        const viewport = new XRViewport(x, y, vpWidth, vpHeight);
        this[P_DEVICE].viewportCache[eye] = viewport;
        return viewport;
      },
      viewportCache: {},
      updateViews: () => {
        // update viewerSpace
        const viewerSpace = this[P_DEVICE].viewerSpace;
        mat4.fromRotationTranslation(
          viewerSpace[P_SPACE].offsetMatrix,
          this[P_DEVICE].quaternion.quat,
          this[P_DEVICE].position.vec3,
        );

        // update viewSpaces
        vec3.set(leftViewOffsetScratch, -this[P_DEVICE].ipd / 2, 0, 0);
        mat4.fromTranslation(
          this[P_DEVICE].viewSpaces[XREye.Left][P_SPACE].offsetMatrix,
          leftViewOffsetScratch,
        );
        vec3.set(rightViewOffsetScratch, this[P_DEVICE].ipd / 2, 0, 0);
        mat4.fromTranslation(
          this[P_DEVICE].viewSpaces[XREye.Right][P_SPACE].offsetMatrix,
          rightViewOffsetScratch,
        );
      },
      onBaseLayerSet: (baseLayer: XRWebGLLayer | null) => {
        if (!baseLayer || this[P_DEVICE].host) return;

        // backup canvas data
        const canvas = baseLayer.context.canvas as HTMLCanvasElement;
        if (canvas.parentElement !== this[P_DEVICE].canvasContainer) {
          const devui = this[P_DEVICE].devui;
          if (devui) {
            const { devUICanvas, devUIContainer } = devui;
            devUICanvas.style.zIndex = Z_INDEX_DEVUI_CANVAS.toString();
            devUIContainer.style.zIndex = Z_INDEX_DEVUI_CONTAINER.toString();
            this[P_DEVICE].canvasContainer.appendChild(devui.devUICanvas);
            this[P_DEVICE].canvasContainer.appendChild(devui.devUIContainer);
          }
          const sem = this[P_DEVICE].sem;
          if (sem) {
            sem.environmentCanvas.style.zIndex = Z_INDEX_SEM_CANVAS.toString();
            this[P_DEVICE].canvasContainer.appendChild(sem.environmentCanvas);
          }
          this[P_DEVICE].canvasData = {
            canvas,
            parent: canvas.parentElement,
            width: canvas.width,
            height: canvas.height,
            zIndex: canvas.style.zIndex,
          };
          canvas.style.zIndex = Z_INDEX_APP_CANVAS.toString();
          this[P_DEVICE].canvasContainer.appendChild(canvas);
          if (this[P_DEVICE].visibilityMaskCanvas) {
            this[P_DEVICE].canvasContainer.appendChild(
              this[P_DEVICE].visibilityMaskCanvas,
            );
          }
          document.body.appendChild(this[P_DEVICE].canvasContainer);
        }

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
      },
      onSessionEnd: () => {
        this[P_DEVICE].remote?.onSessionEnd();
        this[P_DEVICE].hostInput?.[P_HOST_INPUT].endSession();
        this[P_DEVICE].devui?.onSessionEnd?.();
        // Nothing carries into the next session: buttons held now (or with a
        // cancel still to report) start the next session released.
        for (const input of [
          ...Object.values(this[P_DEVICE].controllers),
          ...Object.values(this[P_DEVICE].hands),
        ]) {
          for (const button of input.inputSource.gamepad?.buttons ?? []) {
            if (button instanceof GamepadButton) {
              resetButton(button);
            }
          }
        }
        if (this[P_DEVICE].canvasData) {
          const { canvas, parent, width, height, zIndex } =
            this[P_DEVICE].canvasData;
          canvas.width = width;
          canvas.height = height;
          canvas.style.zIndex = zIndex;
          if (parent) {
            parent.appendChild(canvas);
          } else {
            this[P_DEVICE].canvasContainer.removeChild(canvas);
          }
          const devui = this[P_DEVICE].devui;
          if (devui) {
            this[P_DEVICE].canvasContainer.removeChild(devui.devUICanvas);
            this[P_DEVICE].canvasContainer.removeChild(devui.devUIContainer);
          }
          const sem = this[P_DEVICE].sem;
          if (sem) {
            this[P_DEVICE].canvasContainer.removeChild(sem.environmentCanvas);
          }
          const visibilityMaskCanvas = this[P_DEVICE].visibilityMaskCanvas;
          if (
            visibilityMaskCanvas?.parentElement ===
            this[P_DEVICE].canvasContainer
          ) {
            this[P_DEVICE].canvasContainer.removeChild(visibilityMaskCanvas);
          }
          document.body.removeChild(this[P_DEVICE].canvasContainer);
          this[P_DEVICE].canvasData = undefined;
          window.dispatchEvent(new Event('resize'));
        }
      },
      onFrameStart: (frame: XRFrame) => {
        // Calculate delta time for remote control, capped so one stalled
        // frame (a background tab, a debugger pause) can't run several timed
        // actions at once.
        const now = performance.now();
        const deltaTimeMs =
          this[P_DEVICE].lastFrameTime > 0
            ? Math.min(now - this[P_DEVICE].lastFrameTime, MAX_REMOTE_FRAME_MS)
            : 16.67; // Default to ~60fps
        this[P_DEVICE].lastFrameTime = now;

        // Update remote control interface
        if (this[P_DEVICE].remote) {
          this[P_DEVICE].remote.update(deltaTimeMs);
        }

        if (this[P_DEVICE].actionPlayer?.playing) {
          this[P_DEVICE].actionPlayer.playFrame();
        } else {
          const session = frame.session;

          if (this[P_DEVICE].pendingVisibilityState) {
            this[P_DEVICE].visibilityState =
              this[P_DEVICE].pendingVisibilityState;
            this[P_DEVICE].pendingVisibilityState = null;
            session.dispatchEvent(
              new XRSessionEvent('visibilitychange', { session }),
            );
          }
          const hostInput = this[P_DEVICE].hostInput;
          hostInput?.[P_HOST_INPUT].sync(frame);
          if (this[P_DEVICE].visibilityState === 'visible') {
            if (hostInput) {
              runHostInputFrame(this.activeInputs, frame);
            } else {
              const activeInputs = this.activeInputs;
              for (let i = 0; i < activeInputs.length; i++) {
                activeInputs[i].onFrameStart(frame);
              }
            }
          }

          if (this[P_DEVICE].pendingReferenceSpaceReset) {
            session[P_SESSION].referenceSpaces.forEach((referenceSpace) => {
              switch (referenceSpace[P_REF_SPACE].type) {
                case XRReferenceSpaceType.Local:
                case XRReferenceSpaceType.LocalFloor:
                case XRReferenceSpaceType.BoundedFloor:
                case XRReferenceSpaceType.Unbounded:
                  referenceSpace.dispatchEvent(
                    new XRReferenceSpaceEvent('reset', { referenceSpace }),
                  );
                  break;
              }
            });
            this[P_DEVICE].pendingReferenceSpaceReset = false;
          }
        }

        this[P_DEVICE].updateViews();
        this.drawVisibilityMask();
      },

      // control mode for programmatic access
      controlMode: 'manual',
      controlModeListeners: new Set(),
      stateChangeListeners: new Set(),

      // remote control interface - initialized after this object
      remote: null,
      extensions,
      runtime: null as any,

      // frame timing for remote update
      lastFrameTime: 0,

      host,
      onHostFrameStart: (frame: XRFrame) => {
        const state = this[P_DEVICE];
        // the clock is only read for remote control (absent from iwer/host)
        const remote = state.remote;
        if (remote) {
          const now = performance.now();
          const deltaTimeMs =
            state.lastFrameTime > 0
              ? Math.min(now - state.lastFrameTime, MAX_REMOTE_FRAME_MS)
              : 16.67;
          state.lastFrameTime = now;
          remote.update(deltaTimeMs);
        }
        // real tracking (HOST-INPUT.md) replaces the emulated inputs
        const hostInput = state.hostInput;
        if (hostInput) {
          hostInput[P_HOST_INPUT].sync(frame);
        }
        if (state.visibilityState === 'visible') {
          if (hostInput) {
            runHostInputFrame(this.activeInputs, frame);
          } else {
            const inputs = this.activeInputs;
            for (let i = 0; i < inputs.length; i++) {
              inputs[i].onFrameStart(frame);
            }
          }
        }
      },
    };

    // Initialize remote control interface
    this[P_DEVICE].runtime = {
      kind: 'emulated',
      getSession: () => {
        const session = this.activeSession;
        if (!session) {
          return null;
        }
        // Keep the adapter structural so lightweight XRDevice test doubles and
        // integrations that replace activeSession continue to work.
        const sessionState = session[P_SESSION];
        const structuralSession = session as unknown as {
          mode?: XRSessionMode;
          enabledFeatures?: readonly string[];
          visibilityState?: XRVisibilityState;
          end?: () => void | Promise<void>;
        };
        // The XR origin is the app's first reference space that isn't the
        // (moving) viewer space.
        const primaryReferenceSpace = sessionState?.referenceSpaces?.find(
          (space) => space[P_REF_SPACE]?.type !== XRReferenceSpaceType.Viewer,
        );
        return {
          mode: sessionState?.mode ?? structuralSession.mode ?? 'immersive-vr',
          enabledFeatures: structuralSession.enabledFeatures ?? [],
          visibilityState:
            structuralSession.visibilityState ?? this.visibilityState,
          originOffsetMatrix:
            primaryReferenceSpace?.[P_SPACE].offsetMatrix ?? null,
          end: () => structuralSession.end?.(),
        };
      },
    };
    this[P_DEVICE].remote = extensions.createRemoteControl?.(this) ?? null;

    this[P_DEVICE].updateViews();
    globalThis;
  }

  private drawVisibilityMask(): void {
    const mask = this[P_DEVICE].visibilityMask;
    const maskCanvas = this[P_DEVICE].visibilityMaskCanvas;
    const appCanvas = this[P_DEVICE].canvasData?.canvas;
    if (
      !this[P_DEVICE].visibilityMaskEnabled ||
      !mask ||
      !maskCanvas ||
      !appCanvas
    ) {
      return;
    }

    const width = appCanvas.width;
    const height = appCanvas.height;
    if (width <= 0 || height <= 0) return;
    if (maskCanvas.width !== width || maskCanvas.height !== height) {
      maskCanvas.width = width;
      maskCanvas.height = height;
    }

    const context = maskCanvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#000';

    const eyes = this[P_DEVICE].stereoEnabled
      ? (['left', 'right'] as const)
      : (['left'] as const);
    const eyeWidth = width / eyes.length;
    eyes.forEach((eye, index) => {
      const eyeX = index * eyeWidth;
      const bounds = calculateVisibilityMaskBounds(
        mask[eye],
        this[P_DEVICE].fovy,
        eyeWidth,
        height,
      );
      context.fillRect(eyeX, 0, eyeWidth, height);
      context.clearRect(eyeX + bounds.x, bounds.y, bounds.width, bounds.height);
    });
  }

  /**
   * Whether a native (non-emulated) WebXR runtime is already present on
   * `navigator.xr`. installRuntime uses this to avoid clobbering a real
   * runtime unless `forceInstall` is set.
   */
  isNativeXRAvailable(): boolean {
    const nativeXR = (globalThis.navigator as Navigator | undefined)?.xr;
    // An emulated runtime installed by IWER is an XRSystem instance; anything
    // else present is treated as a native runtime.
    return Boolean(nativeXR) && !(nativeXR instanceof XRSystem);
  }

  installRuntime(options?: RuntimeOptions) {
    if (this[P_DEVICE].runtime.kind === 'native') {
      throw new DOMException(
        'Cannot install the emulated runtime while a native override is installed.',
        'InvalidStateError',
      );
    }
    const globalObject = (options?.globalObject ??
      globalThis) as GlobalObjectRecord;
    const polyfillLayers = options?.polyfillLayers;

    // Skip clobbering a real WebXR runtime unless the caller forces it.
    if (this.isNativeXRAvailable() && !options?.forceInstall) {
      console.warn(
        'IWER: a native WebXR runtime is already available on navigator.xr; ' +
          'skipping installRuntime. Pass { forceInstall: true } to override.',
      );
      return;
    }

    // Track which globals/descriptors we overwrite so uninstallRuntime can
    // best-effort restore them later.
    const previousGlobals = new Map<
      string,
      { existed: boolean; value: unknown }
    >();
    const previousMakeXRCompatible = new Map<
      object,
      { existed: boolean; descriptor: PropertyDescriptor | undefined }
    >();
    this[P_DEVICE].installedGlobalObject = globalObject;
    this[P_DEVICE].previousGlobals = previousGlobals;
    this[P_DEVICE].previousMakeXRCompatible = previousMakeXRCompatible;

    const defineMakeXRCompatible = (proto: object | undefined) => {
      if (!proto) return;
      previousMakeXRCompatible.set(proto, {
        existed: 'makeXRCompatible' in (proto as Record<string, unknown>),
        descriptor: Object.getOwnPropertyDescriptor(proto, 'makeXRCompatible'),
      });
      Object.defineProperty(proto, 'makeXRCompatible', {
        value: function () {
          return new Promise((resolve, _reject) => {
            resolve(true);
          });
        },
        configurable: true,
      });
    };
    defineMakeXRCompatible(
      (globalThis as { WebGL2RenderingContext?: { prototype: object } })
        .WebGL2RenderingContext?.prototype,
    );
    // Also patch WebGL1 contexts, which can request XR compatibility too.
    defineMakeXRCompatible(
      (globalThis as { WebGLRenderingContext?: { prototype: object } })
        .WebGLRenderingContext?.prototype,
    );

    this[P_DEVICE].xrSystem = new XRSystem(this);

    // Capture the previous navigator.xr / userAgent descriptors before
    // overwriting so uninstallRuntime can restore them.
    this[P_DEVICE].previousNavigatorXRDescriptor =
      Object.getOwnPropertyDescriptor(globalThis.navigator, 'xr') ?? null;
    this[P_DEVICE].previousUserAgentDescriptor =
      Object.getOwnPropertyDescriptor(navigator, 'userAgent') ?? null;

    Object.defineProperty(globalThis.navigator, 'xr', {
      value: this[P_DEVICE].xrSystem,
      configurable: true,
    });
    // userAgent is configurable so uninstallRuntime can restore the original.
    // A host keeps its own user agent: it is the real device.
    if (!this[P_DEVICE].host) {
      Object.defineProperty(navigator, 'userAgent', {
        value: this[P_DEVICE].userAgent,
        writable: false,
        configurable: true,
        enumerable: true,
      });
    }

    const setGlobal = (name: string, value: unknown) => {
      previousGlobals.set(name, {
        existed: name in globalObject,
        value: globalObject[name],
      });
      globalObject[name] = value;
    };

    setGlobal('XRSystem', XRSystem);
    setGlobal('XRSession', XRSession);
    setGlobal('XRRenderState', XRRenderState);
    setGlobal('XRFrame', XRFrame);
    setGlobal('XRSpace', XRSpace);
    setGlobal('XRReferenceSpace', XRReferenceSpace);
    setGlobal('XRJointSpace', XRJointSpace);
    setGlobal('XRView', XRView);
    setGlobal('XRViewport', XRViewport);
    setGlobal('XRRigidTransform', XRRigidTransform);
    setGlobal('XRPose', XRPose);
    setGlobal('XRViewerPose', XRViewerPose);
    setGlobal('XRJointPose', XRJointPose);
    setGlobal('XRInputSource', XRInputSource);
    setGlobal('XRInputSourceArray', XRInputSourceArray);
    setGlobal('XRHand', XRHand);
    setGlobal('XRLayer', XRLayer);
    setGlobal('XRWebGLLayer', XRWebGLLayer);
    setGlobal('XRSessionEvent', XRSessionEvent);
    setGlobal('XRInputSourceEvent', XRInputSourceEvent);
    setGlobal('XRInputSourcesChangeEvent', XRInputSourcesChangeEvent);
    setGlobal('XRReferenceSpaceEvent', XRReferenceSpaceEvent);

    if (this[P_DEVICE].host) {
      // host mode has real projection layers; three.js looks for
      // createProjectionLayer on XRWebGLBinding.prototype to use them
      setGlobal('XRWebGLBinding', XRHostWebGLBinding);
      setGlobal('XRCompositionLayer', XRCompositionLayer);
      setGlobal('XRProjectionLayer', XRProjectionLayer);
      setGlobal('XRBoundedReferenceSpace', XRBoundedReferenceSpace);
      setGlobal('XRWebGLSubImage', XRWebGLSubImage);
      return;
    }
    if (polyfillLayers) {
      const installPolyfill = this[P_DEVICE].extensions.installLayersPolyfill;
      if (installPolyfill) {
        installPolyfill();
      } else {
        console.warn(
          'IWER: polyfillLayers needs the full iwer entry; this build does not include the layers polyfill.',
        );
      }
    } else {
      setGlobal('XRMediaBinding', undefined);
    }
    setGlobal('XRWebGLBinding', XRWebGLBinding);
  }

  /** The host backend in host mode, undefined when emulating. */
  get hostBackend(): XRHostBackend | undefined {
    return this[P_DEVICE].host ?? undefined;
  }

  /**
   * Host mode: runs one XR frame of the active session (see host/types.ts).
   * Call it between xrBeginFrame and xrEndFrame; it returns once the page's
   * animation frame callbacks (and the window's) have run.
   */
  runHostFrame(frame: XRHostFrame): void {
    this.activeSession?.[P_SESSION].host?.runFrame(frame);
  }

  /** Host mode: forwards a runtime event to the active session. */
  dispatchHostEvent(event: XRHostEvent): void {
    this.activeSession?.[P_SESSION].host?.onEvent(event);
  }

  /**
   * Best-effort reversal of installRuntime: restores the previous
   * navigator.xr / navigator.userAgent descriptors, the WebGL makeXRCompatible
   * methods, and the overwritten global constructors. Safe to call even if
   * installRuntime was never invoked (no-op in that case).
   */
  uninstallRuntime() {
    const previousGlobals = this[P_DEVICE].previousGlobals;
    const globalObject = this[P_DEVICE].installedGlobalObject;

    // Restore overwritten global constructors.
    if (previousGlobals && globalObject) {
      previousGlobals.forEach(({ existed, value }, name) => {
        if (existed) {
          globalObject[name] = value;
        } else {
          delete globalObject[name];
        }
      });
    }

    // Restore navigator.xr.
    const navXrDescriptor = this[P_DEVICE].previousNavigatorXRDescriptor;
    if (navXrDescriptor) {
      Object.defineProperty(globalThis.navigator, 'xr', navXrDescriptor);
    } else if (
      Object.getOwnPropertyDescriptor(globalThis.navigator, 'xr')?.configurable
    ) {
      delete (globalThis.navigator as { xr?: unknown }).xr;
    }

    // Restore navigator.userAgent (now configurable, so this can succeed).
    const userAgentDescriptor = this[P_DEVICE].previousUserAgentDescriptor;
    if (
      userAgentDescriptor &&
      Object.getOwnPropertyDescriptor(navigator, 'userAgent')?.configurable
    ) {
      Object.defineProperty(navigator, 'userAgent', userAgentDescriptor);
    }

    // Restore makeXRCompatible on the WebGL prototypes.
    this[P_DEVICE].previousMakeXRCompatible?.forEach(
      ({ existed, descriptor }, proto) => {
        if (existed && descriptor) {
          Object.defineProperty(proto, 'makeXRCompatible', descriptor);
        } else {
          delete (proto as Record<string, unknown>).makeXRCompatible;
        }
      },
    );

    this[P_DEVICE].xrSystem = null;
    this[P_DEVICE].installedGlobalObject = null;
    this[P_DEVICE].previousGlobals = null;
    this[P_DEVICE].previousMakeXRCompatible = null;
    this[P_DEVICE].previousNavigatorXRDescriptor = null;
    this[P_DEVICE].previousUserAgentDescriptor = null;
  }

  installDevUI(devUIConstructor: DevUIConstructor) {
    this[P_DEVICE].devui = new devUIConstructor(this as unknown as XRDevice);
  }

  installSEM(semConstructor: SEMConstructor) {
    this[P_DEVICE].sem = new semConstructor(this as unknown as XRDevice);
  }

  get supportedSessionModes() {
    return this[P_DEVICE].supportedSessionModes;
  }

  get supportedFeatures() {
    return this[P_DEVICE].supportedFeatures;
  }

  get supportedFrameRates() {
    return this[P_DEVICE].supportedFrameRates;
  }

  get isSystemKeyboardSupported() {
    return this[P_DEVICE].isSystemKeyboardSupported;
  }

  get internalNominalFrameRate() {
    return this[P_DEVICE].internalNominalFrameRate;
  }

  get stereoEnabled() {
    return this[P_DEVICE].stereoEnabled;
  }

  set stereoEnabled(value: boolean) {
    this[P_DEVICE].stereoEnabled = value;
  }

  /**
   * Whether immersive sessions clear the base layer's color, depth and stencil
   * buffers at the start of every frame, as the WebXR opaque framebuffer
   * requires. Defaults to `true`; changes apply from the next frame.
   *
   * Turning it off is for automation hosts that skip drawing on purpose (for
   * example a headless browser that renders on demand under software GL),
   * where clearing a canvas nobody draws to is the dominant per-frame cost.
   * It is safe for apps that clear before they draw, such as three.js with
   * `renderer.autoClear` (the default): every drawn frame starts clean anyway.
   * When a frame is not drawn, the page keeps showing the last drawn image;
   * the drawing buffer itself is not readable later unless the context uses
   * `preserveDrawingBuffer`, so capture at page level or in the same task as
   * the draw. Inline sessions never clear, whatever this is set to. The
   * setting is owned by the host page and is not part of remote-control
   * device state.
   */
  get frameClearEnabled() {
    return this[P_DEVICE].frameClearEnabled;
  }

  set frameClearEnabled(value: boolean) {
    this[P_DEVICE].frameClearEnabled = value;
  }

  /**
   * Decides whether the synthetic environment (SEM) is drawn in an
   * immersive-ar frame. Called once per frame, after the app's frame
   * callbacks; returning `false` skips that frame's environment draw. The
   * environment still updates every frame, so scene logic, tracked planes and
   * meshes, hit tests and depth sensing are unaffected. Defaults to `null`,
   * which draws every frame. If the function throws, the environment is drawn.
   *
   * This is the environment's counterpart to {@link frameClearEnabled}, for
   * hosts that render on demand: answer whether the app drew this frame, and
   * the room behind the app's canvas is drawn exactly when the app is, from
   * the same pose. A skipped frame leaves the last drawn room on the page. It
   * only applies to modules that implement `update` and `draw` (`@iwer/sem`
   * does); others render every frame. Like {@link frameClearEnabled}, it is
   * owned by the host page and is not part of remote-control device state.
   */
  get shouldDrawEnvironment(): (() => boolean) | null {
    return this[P_DEVICE].shouldDrawEnvironment;
  }

  set shouldDrawEnvironment(value: (() => boolean) | null) {
    this[P_DEVICE].shouldDrawEnvironment = value;
  }

  get ipd() {
    return this[P_DEVICE].ipd;
  }

  set ipd(value: number) {
    this[P_DEVICE].ipd = value;
  }

  get fovy() {
    return this[P_DEVICE].fovy;
  }

  set fovy(value: number) {
    this[P_DEVICE].fovy = value;
  }

  get visibilityMask(): XRVisibilityMask | undefined {
    return this[P_DEVICE].visibilityMask;
  }

  /**
   * Whether this device's configured visibility mask is currently displayed.
   * Profiles without a visibility mask always remain disabled.
   */
  get visibilityMaskEnabled(): boolean {
    return this[P_DEVICE].visibilityMaskEnabled;
  }

  set visibilityMaskEnabled(value: boolean) {
    const enabled = Boolean(this[P_DEVICE].visibilityMask) && value;
    this[P_DEVICE].visibilityMaskEnabled = enabled;
    if (this[P_DEVICE].visibilityMaskCanvas) {
      this[P_DEVICE].visibilityMaskCanvas.style.display = enabled ? '' : 'none';
    }
  }

  get position(): Vector3 {
    return this[P_DEVICE].position;
  }

  get quaternion(): Quaternion {
    return this[P_DEVICE].quaternion;
  }

  get viewerSpace() {
    if (this[P_DEVICE].actionPlayer?.playing) {
      return this[P_DEVICE].actionPlayer.viewerSpace;
    } else {
      return this[P_DEVICE].viewerSpace;
    }
  }

  get viewSpaces() {
    if (this[P_DEVICE].actionPlayer?.playing) {
      return this[P_DEVICE].actionPlayer.viewSpaces;
    } else {
      return this[P_DEVICE].viewSpaces;
    }
  }

  get controllers() {
    return this[P_DEVICE].controllers;
  }

  get hands() {
    return this[P_DEVICE].hands;
  }

  get gaze() {
    return this[P_DEVICE].gaze;
  }

  get primaryInputMode() {
    return this[P_DEVICE].primaryInputMode;
  }

  set primaryInputMode(mode: 'controller' | 'hand') {
    if (mode !== 'controller' && mode !== 'hand') {
      console.warn('primary input mode can only be "controller" or "hand"');
      return;
    }
    this[P_DEVICE].primaryInputMode = mode;
  }

  /**
   * Drives the input sources from real tracking (see HOST-INPUT.md): the
   * returned object holds one state per hand that the host rewrites every
   * frame. Calling it again returns the same object (a new `onHaptic`
   * replaces the old one).
   */
  enableHostInput(options: XRHostInputOptions = {}): XRHostInput {
    let hostInput = this[P_DEVICE].hostInput;
    if (!hostInput) {
      hostInput = new XRHostInput(this, options);
      this[P_DEVICE].hostInput = hostInput;
    } else if (options.onHaptic !== undefined) {
      hostInput.onHaptic = options.onHaptic;
    }
    return hostInput;
  }

  /** Returns the device to its emulated controllers and hands. */
  disableHostInput() {
    const hostInput = this[P_DEVICE].hostInput;
    if (!hostInput) {
      return;
    }
    for (const input of hostInput[P_HOST_INPUT].activeInputs) {
      input.connected = false;
    }
    this[P_DEVICE].hostInput = null;
  }

  get hostInput(): XRHostInput | null {
    return this[P_DEVICE].hostInput;
  }

  get activeInputs(): XRTrackedInput[] {
    const hostInput = this[P_DEVICE].hostInput;
    if (hostInput) {
      return hostInput[P_HOST_INPUT].activeInputs;
    }
    if (this[P_DEVICE].visibilityState !== 'visible') {
      return [];
    }
    const primaryInputs: XRTrackedInput[] =
      this[P_DEVICE].primaryInputMode === 'controller'
        ? Object.values(this[P_DEVICE].controllers)
        : Object.values(this[P_DEVICE].hands);
    const activeInputs = this[P_DEVICE].gaze
      ? [...primaryInputs, this[P_DEVICE].gaze]
      : primaryInputs;
    return activeInputs.filter((input) => input.connected);
  }

  get inputSources(): XRInputSource[] {
    const hostInput = this[P_DEVICE].hostInput;
    if (hostInput) {
      return hostInput[P_HOST_INPUT].inputSources;
    }
    if (this[P_DEVICE].actionPlayer?.playing) {
      return this[P_DEVICE].actionPlayer.inputSources;
    } else {
      return this.activeInputs.map((input) => input.inputSource);
    }
  }

  get canvasContainer(): HTMLDivElement {
    return this[P_DEVICE].canvasContainer;
  }

  get canvasDimensions(): { width: number; height: number } | undefined {
    if (this[P_DEVICE].canvasData) {
      const { width, height } = this[P_DEVICE].canvasData.canvas;
      return { width, height };
    }
    return;
  }

  /**
   * Get the app canvas when an XR session is active.
   * Returns undefined if no session is active or no canvas is available.
   */
  get appCanvas(): HTMLCanvasElement | undefined {
    return this[P_DEVICE].canvasData?.canvas;
  }

  get activeSession(): XRSession | undefined {
    return this[P_DEVICE].xrSystem?.[P_SYSTEM].activeSession;
  }

  get sessionOffered(): boolean {
    return Boolean(this[P_DEVICE].xrSystem?.[P_SYSTEM].offeredSessionConfig);
  }

  get name() {
    return this[P_DEVICE].name;
  }

  grantOfferedSession(): void {
    const xrSystem = this[P_DEVICE].xrSystem;
    const pSystem = xrSystem?.[P_SYSTEM];
    if (pSystem && pSystem.offeredSessionConfig) {
      const { resolve, reject, mode, options } = pSystem.offeredSessionConfig;

      // Clear the offered session config first
      pSystem.offeredSessionConfig = undefined;

      // Use the same requestSession flow to ensure identical behavior
      xrSystem.requestSession(mode, options).then(resolve).catch(reject);
    }
  }

  recenter() {
    const deltaVec = new Vector3(-this.position.x, 0, -this.position.z);
    const forward = new Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    forward.y = 0;
    forward.normalize();
    const angle = Math.atan2(forward.x, -forward.z);
    const deltaQuat = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      angle,
    );
    this.position.add(deltaVec);
    this.quaternion.multiply(deltaQuat);

    [
      ...Object.values(this[P_DEVICE].controllers),
      ...Object.values(this[P_DEVICE].hands),
    ].forEach((activeInput) => {
      activeInput.position.add(deltaVec);
      activeInput.quaternion.multiply(deltaQuat);
      activeInput.position.applyQuaternion(deltaQuat);
    });

    this[P_DEVICE].pendingReferenceSpaceReset = true;
  }

  get visibilityState() {
    return this[P_DEVICE].visibilityState;
  }

  // visibility state updates are queued until the XRSession produces frames
  updateVisibilityState(state: XRVisibilityState) {
    if (
      !Object.values(['visible', 'visible-blurred', 'hidden']).includes(state)
    ) {
      throw new DOMException(
        'Invalid XRVisibilityState value',
        'NotSupportedError',
      );
    }
    if (state !== this[P_DEVICE].visibilityState) {
      this[P_DEVICE].pendingVisibilityState = state;
    }
  }

  createActionPlayer(
    refSpace: XRReferenceSpace,
    recording: CompressedRecording,
    options: ActionPlayerOptions = {},
  ) {
    const create = this[P_DEVICE].extensions.createActionPlayer;
    if (!create) {
      throw new DOMException(
        'ActionPlayer is not part of this IWER build; use the full iwer entry.',
        'NotSupportedError',
      );
    }
    const player = create(refSpace, recording, this[P_DEVICE].ipd, options);
    this[P_DEVICE].actionPlayer = player;
    this[P_DEVICE].runtime.onActionPlayerCreated?.(player);
    return player;
  }

  get devui() {
    return this[P_DEVICE].devui;
  }

  get sem() {
    return this[P_DEVICE].sem;
  }

  /** Remote control; null for devices built without it (the `iwer/host` entry). */
  get remote(): RemoteControlInterface | null {
    return this[P_DEVICE].remote ?? null;
  }

  // =============================================================================
  // Control Mode API
  // =============================================================================

  /**
   * Get the current control mode
   * - 'manual': User controls device via DevUI (default)
   * - 'programmatic': External API controls device
   */
  get controlMode(): ControlMode {
    return this[P_DEVICE].controlMode;
  }

  /**
   * Set the control mode
   * Notifies all registered listeners of the change
   */
  set controlMode(mode: ControlMode) {
    if (mode !== 'manual' && mode !== 'programmatic') {
      console.warn('control mode can only be "manual" or "programmatic"');
      return;
    }
    const prevMode = this[P_DEVICE].controlMode;
    if (prevMode !== mode) {
      this[P_DEVICE].controlMode = mode;
      this[P_DEVICE].controlModeListeners.forEach((listener) => listener(mode));
    }
  }

  /**
   * Register a listener to be notified when control mode changes
   * @param listener - Callback function that receives the new mode
   * @returns Unsubscribe function to remove the listener
   */
  onControlModeChange(listener: (mode: ControlMode) => void): () => void {
    this[P_DEVICE].controlModeListeners.add(listener);
    return () => {
      this[P_DEVICE].controlModeListeners.delete(listener);
    };
  }

  /**
   * Register a listener to be notified when device state changes
   * Called after programmatic state modifications
   * @param listener - Callback function
   * @returns Unsubscribe function to remove the listener
   */
  onStateChange(listener: () => void): () => void {
    this[P_DEVICE].stateChangeListeners.add(listener);
    return () => {
      this[P_DEVICE].stateChangeListeners.delete(listener);
    };
  }

  /**
   * Notify all state change listeners that device state has been modified
   * Should be called after programmatic state modifications
   */
  notifyStateChange(): void {
    this[P_DEVICE].stateChangeListeners.forEach((listener) => listener());
  }
}
