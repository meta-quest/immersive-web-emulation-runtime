/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { NativeMesh, XRMesh } from '../meshes/XRMesh.js';
import { NativePlane, XRPlane, planeOrientation } from '../planes/XRPlane.js';
import {
  P_ANCHOR,
  P_COMPOSITION_LAYER,
  P_DEVICE,
  P_FRAME,
  P_GAMEPAD,
  P_HIT_TEST,
  P_MESH,
  P_PLANE,
  P_PROJECTION_LAYER,
  P_SESSION,
  P_SPACE,
  P_WEBGL_LAYER,
} from '../private.js';
import {
  XRCPUDepthInformation,
  XRDepthDataFormat,
  XRDepthStateInit,
  XRDepthUsage,
  findWebGPUDepthConfiguration,
  toMillimeterDepth,
} from '../depth/XRDepthInformation.js';
import { XRWebGLDepthInformation } from '../depth/XRWebGLBinding.js';
import type { WebXRFeature, XRDevice } from '../device/XRDevice.js';
import { XRAnchor, XRAnchorSet, XRAnchorUtils } from '../anchors/XRAnchor.js';
import {
  XRHitTestOptionsInit,
  XRHitTestResult,
  XRHitTestSource,
} from '../hittest/XRHitTest.js';
import { XRInputSource, XRInputSourceArray } from '../input/XRInputSource.js';
import {
  XRInputSourcesChangeEvent,
  XRInputSourcesChangeEventHandler,
} from '../events/XRInputSourcesChangeEvent.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { XRRenderState, XRRenderStateInit } from './XRRenderState.js';
import {
  XRSessionEvent,
  XRSessionEventHandler,
} from '../events/XRSessionEvent.js';
import { XRSpace, XRSpaceUtils } from '../spaces/XRSpace.js';
import { recordSpaceSession } from '../spaces/spaceSessions.js';

import { XREye } from '../views/XRView.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import {
  XRInputSourceEvent,
  XRInputSourceEventHandler,
} from '../events/XRInputSourceEvent.js';
import { edgeEventTypes, resetButton } from '../gamepad/button-edges.js';
import { GamepadButton } from '../gamepad/Gamepad.js';
import { GPULayerTextures } from '../layers/GPULayerTextures.js';
import { XRGPUPresenter } from '../layers/XRGPUPresenter.js';
import {
  XRCompositionLayer,
  XRProjectionLayer,
} from '../layers/XRProjectionLayer.js';
import { XRLayer, XRWebGLLayer } from '../layers/XRWebGLLayer.js';
import { mat4 } from 'gl-matrix';

export type XRVisibilityState = 'visible' | 'visible-blurred' | 'hidden';

export type XRSessionMode = 'inline' | 'immersive-vr' | 'immersive-ar';

export type XRSessionInit = {
  requiredFeatures?: WebXRFeature[];
  optionalFeatures?: WebXRFeature[];
  depthSensing?: XRDepthStateInit;
};

// The most layers a render state can hold (XRSession.maxRenderLayers).
const MAX_RENDER_LAYERS = 16;

// Maps clip-space z from WebGPU's [0, 1] depth range to WebGL's [-1, 1].
const WEBGPU_TO_WEBGL_DEPTH = mat4.create();
WEBGPU_TO_WEBGL_DEPTH[10] = 2;
WEBGPU_TO_WEBGL_DEPTH[14] = -1;

export enum XREnvironmentBlendMode {
  Opaque = 'opaque',
  AlphaBlend = 'alpha-blend',
  Additive = 'additive',
}

export enum XRInteractionMode {
  ScreenSpace = 'screen-space',
  WorldSpace = 'world-space',
}

type XRFrameRequestCallback = (
  time: DOMHighResTimeStamp,
  frame: XRFrame,
) => void;

type CallbackData = {
  handle: number;
  callback: XRFrameRequestCallback;
  cancelled: boolean;
};

export class XRSession extends EventTarget {
  [P_SESSION]: {
    device: XRDevice;
    enabledFeatures: Array<string>;
    // feature flags derived once from enabledFeatures for per-frame reuse
    hasAnchors: boolean;
    hasPlanes: boolean;
    hasMeshes: boolean;
    hasDepth: boolean;
    hasHitTest: boolean;
    hasGazeTracking: boolean;
    hasWebGPU: boolean;
    // cached immutable copy of device.supportedFrameRates
    supportedFrameRates: Float32Array;
    isSystemKeyboardSupported: boolean;
    mode: XRSessionMode;
    ended: boolean;
    referenceSpaceIsSupported: (
      referenceSpaceType: XRReferenceSpaceType,
    ) => boolean;
    // projection matrices
    projectionMatrices: { [key in XREye]: mat4 };
    getProjectionMatrix: (eye: XREye) => mat4;
    // XRFrames produced by this session
    frameHandle: number;
    frameCallbacks: CallbackData[];
    currentFrameCallbacks: CallbackData[] | null;
    // actual frameloop of the device this is running on
    onDeviceFrame: () => void;
    deviceFrameHandle?: number;
    // render state
    renderState: XRRenderState;
    pendingRenderState: XRRenderState | null;
    // WebGPU sessions render into a projection layer instead of a baseLayer
    // Every live layer an XRGPUBinding created for this session.
    gpuLayers: Set<XRCompositionLayer>;
    // Each view's requested and current viewport scale. The current scale
    // can change once per frame, when a subimage of the view is first asked for.
    viewportScales: Map<
      XREye,
      { requested: number; current: number; modifiable: boolean }
    >;
    gpuPresenter: XRGPUPresenter | null;
    releaseLayers: (frame: XRFrame) => void;
    // With space warp, a frame that submitted motion vectors; IWER
    // synthesizes the next device frame from it.
    spaceWarpFrame: XRFrame | null;
    synthesizeFrame: (frame: XRFrame) => void;
    updateProjectionMatrices: () => void;
    // framerate
    nominalFrameRate: number;
    // reference spaces
    referenceSpaces: XRReferenceSpace[];
    // tracked inputs
    inputSourceArray: XRInputSourceArray;
    activeInputSources: XRInputSource[];
    updateActiveInputSources: () => void;
    // tracked anchors
    trackedAnchors: XRAnchorSet;
    persistentAnchors: Map<string, XRAnchor>;
    newAnchors: Map<
      XRAnchor,
      {
        resolve: (value: XRAnchor | PromiseLike<XRAnchor>) => void;
        reject: (reason?: any) => void;
      }
    >;
    frameTrackedAnchors: XRAnchorSet; // https://immersive-web.github.io/anchors/#anchor-updates specifies same object
    updateTrackedAnchors: () => void;
    // tracked planes
    trackedPlanes: Map<NativePlane, XRPlane>;
    updateTrackedPlanes: (frame: XRFrame) => void;
    // tracked meshes
    trackedMeshes: Map<NativeMesh, XRMesh>;
    updateTrackedMeshes: (frame: XRFrame) => void;
    // hit-test
    hitTestSources: Set<XRHitTestSource>;
    computeHitTestResults: (frame: XRFrame) => void;
    // depth sensing
    depthSensingUsage: XRDepthUsage;
    depthSensingDataFormat: XRDepthDataFormat;
    depthTexture: WebGLTexture | null;
    depthTextureWidth: number;
    depthTextureHeight: number;
    // reusable scratch buffer for the GPU depth vertical-flip path,
    // reallocated only when width*height changes
    depthFlipScratch: Float32Array | null;
    depthFlipScratchSize: number;
    computeDepthSensing: (frame: XRFrame) => void;
    activeFrame: XRFrame | null;
    // event handlers
    onend: XRSessionEventHandler | null;
    oninputsourceschange: XRInputSourcesChangeEventHandler | null;
    onselect: XRInputSourceEventHandler | null;
    onselectstart: XRInputSourceEventHandler | null;
    onselectend: XRInputSourceEventHandler | null;
    onsqueeze: XRInputSourceEventHandler | null;
    onsqueezestart: XRInputSourceEventHandler | null;
    onsqueezeend: XRInputSourceEventHandler | null;
    onvisibilitychange: XRSessionEventHandler | null;
    onframeratechange: XRSessionEventHandler | null;
  };

  constructor(
    device: XRDevice,
    mode: XRSessionMode,
    enabledFeatures: string[],
    _depthSensing?: XRDepthStateInit,
  ) {
    super();
    // WebGPU sessions negotiate their depth configuration from the app's
    // preferences.
    const webgpuDepth = enabledFeatures.includes('webgpu')
      ? findWebGPUDepthConfiguration(_depthSensing)
      : null;
    this[P_SESSION] = {
      device,
      mode,
      renderState: new XRRenderState(
        enabledFeatures.includes('webgpu') ? { layers: [] } : {},
      ),
      pendingRenderState: null,
      gpuLayers: new Set(),
      viewportScales: new Map(
        [XREye.None, XREye.Left, XREye.Right].map((eye) => [
          eye,
          { requested: 1, current: 1, modifiable: true },
        ]),
      ),
      gpuPresenter: null,
      // "Release the WebGPU textures" of every layer drawn in this frame.
      releaseLayers: (frame: XRFrame) => {
        try {
          const encoders = new Map<GPUDevice, GPUCommandEncoder>();
          const released: [XRCompositionLayer, GPULayerTextures][] = [];
          for (const layer of this[P_SESSION].gpuLayers) {
            const { textures } = layer[P_COMPOSITION_LAYER];
            // Media layers have nothing for the app to draw.
            if (
              !(textures instanceof GPULayerTextures) ||
              textures.current?.frame !== frame
            ) {
              continue;
            }
            const device = textures.device as GPUDevice;
            let encoder = encoders.get(device);
            if (!encoder) {
              encoder = device.createCommandEncoder({
                label: 'IWER layer release',
              });
              encoders.set(device, encoder);
            }
            textures.release(frame, encoder);
            released.push([layer, textures]);
          }
          for (const [device, encoder] of encoders) {
            device.queue.submit([encoder.finish()]);
          }
          for (const [layer, textures] of released) {
            textures.expire();
            layer[P_COMPOSITION_LAYER].needsRedraw = false;
            if (layer instanceof XRProjectionLayer) {
              const projection = layer[P_PROJECTION_LAYER];
              projection.viewportScales = projection.frameViewportScales;
              projection.frameViewportScales = [1, 1];
            }
          }
        } catch (error) {
          console.error(error);
        }
      },
      spaceWarpFrame: null,
      synthesizeFrame: (frame: XRFrame) => {
        const now = performance.now();
        this[P_SESSION].updateProjectionMatrices();
        const device = this[P_SESSION].device[P_DEVICE];
        device.devui?.render(now);
        if (this[P_SESSION].mode === 'immersive-ar') {
          device.sem?.render(now);
        }
        device.onSynthesizedFrame();
        this[P_SESSION].gpuPresenter?.present(
          this,
          this[P_SESSION].renderState.layers ?? [],
          frame,
        );
      },
      updateProjectionMatrices: () => {
        const { depthNear, depthFar } = this[P_SESSION].renderState;
        const context = this[P_SESSION].renderState.baseLayer?.context;
        const { width, height } = context?.canvas ?? {
          width: window.innerWidth,
          height: window.innerHeight,
        };
        if (this[P_SESSION].mode !== 'inline') {
          const aspect =
            (width * (this[P_SESSION].device.stereoEnabled ? 0.5 : 1.0)) /
            height;
          // WebGPU clip space has a [0, 1] depth range
          const perspective = this[P_SESSION].hasWebGPU
            ? mat4.perspectiveZO
            : mat4.perspective;
          perspective(
            this[P_SESSION].projectionMatrices[XREye.Left],
            this[P_SESSION].device.fovy,
            aspect,
            depthNear,
            depthFar,
          );
          mat4.copy(
            this[P_SESSION].projectionMatrices[XREye.Right],
            this[P_SESSION].projectionMatrices[XREye.Left],
          );
        } else {
          const aspect = width / height;
          mat4.perspective(
            this[P_SESSION].projectionMatrices[XREye.None],
            this[P_SESSION].renderState.inlineVerticalFieldOfView!,
            aspect,
            depthNear,
            depthFar,
          );
        }
      },
      enabledFeatures: enabledFeatures,
      hasAnchors: enabledFeatures.includes('anchors'),
      hasPlanes: enabledFeatures.includes('plane-detection'),
      hasMeshes: enabledFeatures.includes('mesh-detection'),
      hasDepth: enabledFeatures.includes('depth-sensing'),
      hasHitTest: enabledFeatures.includes('hit-test'),
      hasGazeTracking:
        enabledFeatures.includes('gaze-tracking') ||
        enabledFeatures.includes('eye-tracking'),
      hasWebGPU: enabledFeatures.includes('webgpu'),
      supportedFrameRates: new Float32Array(device.supportedFrameRates),
      isSystemKeyboardSupported: false,
      ended: false,
      projectionMatrices: {
        [XREye.Left]: mat4.create(),
        [XREye.Right]: mat4.create(),
        [XREye.None]: mat4.create(),
      },
      getProjectionMatrix: (eye: XREye) => {
        return this[P_SESSION].projectionMatrices[eye];
      },
      referenceSpaceIsSupported: (referenceSpaceType: XRReferenceSpaceType) => {
        if (!this[P_SESSION].enabledFeatures.includes(referenceSpaceType)) {
          return false;
        }
        switch (referenceSpaceType) {
          case XRReferenceSpaceType.Viewer:
            return true;
          case XRReferenceSpaceType.Local:
          case XRReferenceSpaceType.LocalFloor:
          case XRReferenceSpaceType.BoundedFloor:
          case XRReferenceSpaceType.Unbounded:
            return this[P_SESSION].mode != 'inline';
        }
      },
      frameHandle: 0,
      frameCallbacks: [],
      currentFrameCallbacks: null,
      onDeviceFrame: () => {
        if (this[P_SESSION].ended) {
          return;
        }

        this[P_SESSION].deviceFrameHandle = globalThis.requestAnimationFrame(
          this[P_SESSION].onDeviceFrame,
        );

        // Space warp: the app skips this frame and IWER synthesizes it.
        const synthesizeFrom = this[P_SESSION].spaceWarpFrame;
        if (synthesizeFrom) {
          this[P_SESSION].spaceWarpFrame = null;
          this[P_SESSION].synthesizeFrame(synthesizeFrom);
          return;
        }

        if (this[P_SESSION].pendingRenderState != null) {
          this[P_SESSION].renderState = this[P_SESSION].pendingRenderState;
          this[P_SESSION].pendingRenderState = null;
          this[P_SESSION].device[P_DEVICE].onBaseLayerSet(
            this[P_SESSION].renderState.baseLayer,
          );
          if (this[P_SESSION].renderState.layers?.length) {
            this[P_SESSION].gpuPresenter ??= new XRGPUPresenter(
              this[P_SESSION].device,
            );
            this[P_SESSION].gpuPresenter.attach();
          }
        }

        const baseLayer = this[P_SESSION].renderState.baseLayer;
        // "Check the layers state": frames run while a layer can be shown.
        const layers = (this[P_SESSION].renderState.layers ?? []).filter(
          (layer) =>
            !(layer instanceof XRCompositionLayer) ||
            !layer[P_COMPOSITION_LAYER].destroyed,
        );
        this[P_SESSION].gpuPresenter?.setVisible(layers.length > 0);
        if (baseLayer === null && layers.length === 0) {
          return;
        }
        for (const viewportScale of this[P_SESSION].viewportScales.values()) {
          viewportScale.modifiable = true;
        }
        for (const layer of layers) {
          if (layer instanceof XRProjectionLayer) {
            const projection = layer[P_PROJECTION_LAYER];
            projection.frameFixedFoveation = projection.fixedFoveation;
          }
        }
        const context = baseLayer?.context;

        /**
         * This code snippet is designed to clear the buffers attached to an opaque framebuffer
         * at the beginning of each XR animation frame, but it only applies to immersive XR sessions.
         * The process is as follows:
         *
         * 1. Check if the session is immersive: It verifies if `session.immersive` is true.
         *    This ensures that the buffer clearing operations are only performed for immersive
         *    sessions, which have exclusive access to the XR device's display.
         *
         * 2. Save current clear values: The current clear values for the color, depth, and
         *    stencil buffers are stored. These values need to be restored after clearing the
         *    buffers to maintain the application's rendering state as expected.
         *
         * 3. Set clear values to defaults: The clear color is set to transparent black, the
         *    clear depth to the maximum depth value (1.0), and the clear stencil to 0. This
         *    ensures that the buffers are reset to a known state, free from any residual data.
         *
         * 4. Clear the buffers: The depth, color, and stencil buffers are cleared, removing
         *    any content from previous frames and preparing them for new rendering operations.
         *
         * 5. Restore previous clear values: The original clear values are reinstated to return
         *    the WebGL context to its state prior to this operation, allowing subsequent rendering
         *    to proceed without interference.
         *
         * This clearing process is crucial for some XR devices to function correctly and to
         * prevent rendering artifacts from past frames. It ensures that each new frame starts
         * with a clean slate.
         */
        if (context && this[P_SESSION].mode != 'inline') {
          const currentClearColor = context.getParameter(
            context.COLOR_CLEAR_VALUE,
          );
          const currentClearDepth = context.getParameter(
            context.DEPTH_CLEAR_VALUE,
          );
          const currentClearStencil = context.getParameter(
            context.STENCIL_CLEAR_VALUE,
          );
          context.clearColor(0.0, 0.0, 0.0, 0.0);
          context.clearDepth(1);
          context.clearStencil(0.0);
          context.clear(
            context.DEPTH_BUFFER_BIT |
              context.COLOR_BUFFER_BIT |
              context.STENCIL_BUFFER_BIT,
          );
          context.clearColor(
            currentClearColor[0],
            currentClearColor[1],
            currentClearColor[2],
            currentClearColor[3],
          );
          context.clearDepth(currentClearDepth);
          context.clearStencil(currentClearStencil);
        }

        // Calculate projection matrices
        this[P_SESSION].updateProjectionMatrices();

        const now = performance.now();
        const frame = new XRFrame(
          this,
          this[P_SESSION].frameHandle,
          true,
          true,
          now,
        );

        const devui = this[P_SESSION].device[P_DEVICE].devui;
        if (devui) {
          devui.render(now);
        }

        if (this[P_SESSION].mode === 'immersive-ar') {
          const sem = this[P_SESSION].device[P_DEVICE].sem;
          if (sem) {
            sem.render(now);
          }
        }

        if (this[P_SESSION].hasAnchors) {
          this[P_SESSION].updateTrackedAnchors();
        }
        if (this[P_SESSION].hasPlanes) {
          this[P_SESSION].updateTrackedPlanes(frame);
        }
        if (this[P_SESSION].hasMeshes) {
          this[P_SESSION].updateTrackedMeshes(frame);
        }
        if (this[P_SESSION].hasDepth) {
          this[P_SESSION].computeDepthSensing(frame);
        }
        if (this[P_SESSION].hasHitTest) {
          this[P_SESSION].computeHitTestResults(frame);
        }

        this[P_SESSION].activeFrame = frame;
        this[P_SESSION].device[P_DEVICE].onFrameStart(frame);
        this[P_SESSION].updateActiveInputSources();

        /*
         * For each entry in callbacks, in order:
         * - If the entry’s cancelled boolean is true, continue to the next entry.
         * - Invoke the Web IDL callback function, passing now and frame as the arguments.
         * - If an exception is thrown, report the exception.
         */
        // - Let callbacks be a list of the entries in session’s list of animation frame
        //   callback, in the order in which they were added to the list.
        const callbacks = (this[P_SESSION].currentFrameCallbacks =
          this[P_SESSION].frameCallbacks);
        // - Set session’s list of animation frame callbacks to the empty list.
        this[P_SESSION].frameCallbacks = [];
        for (let i = 0; i < callbacks.length; i++) {
          try {
            if (!callbacks[i].cancelled) {
              callbacks[i].callback(now, frame);
            }
          } catch (err) {
            console.error(err);
          }
        }
        this[P_SESSION].currentFrameCallbacks = null;

        // Hand the layers drawn in this frame to the compositor, then show
        // every layer in the render state.
        this[P_SESSION].releaseLayers(frame);
        if (!this[P_SESSION].ended) {
          this[P_SESSION].gpuPresenter?.present(this, layers);
          // After a frame where the app drew motion vectors and depth, IWER
          // synthesizes the next device frame from it. Other frames run as if
          // space warp was off, as the spec requires.
          const submitted = layers.some(
            (layer) =>
              layer instanceof XRProjectionLayer &&
              layer[P_COMPOSITION_LAYER].textures.releasedFrame === frame &&
              layer[P_COMPOSITION_LAYER].textures.releasedMotion,
          );
          this[P_SESSION].spaceWarpFrame = submitted ? frame : null;
        }

        // WebGPU depth textures are only valid during their frame.
        for (const texture of frame[P_FRAME].webgpuDepthTextures) {
          texture.destroy();
        }
        frame[P_FRAME].webgpuDepthTextures.length = 0;

        // - Set frame’s active boolean to false.
        frame[P_FRAME].active = false;
        this[P_SESSION].activeFrame = null;
      },
      nominalFrameRate: device.internalNominalFrameRate,
      referenceSpaces: [],
      inputSourceArray: [],
      activeInputSources: [],
      updateActiveInputSources: () => {
        const handTrackingOn =
          this[P_SESSION].enabledFeatures.includes('hand-tracking');
        const gazeTrackingOn = this[P_SESSION].hasGazeTracking;
        const prevInputs = this[P_SESSION].activeInputSources;
        const currInputs = this[P_SESSION].device.inputSources.filter(
          (inputSource) =>
            (!inputSource.hand || handTrackingOn) &&
            (inputSource.targetRayMode !== 'gaze' || gazeTrackingOn),
        );

        const added = currInputs.filter((item) => !prevInputs.includes(item));
        const removed = prevInputs.filter((item) => !currInputs.includes(item));

        this[P_SESSION].activeInputSources = currInputs;

        // A source that goes away mid-press ends its action without
        // completing it (`selectend`/`squeezeend` alone), on this frame and
        // before the source change is announced. Sources hidden by a
        // visibility change are cleared silently instead, as the native
        // override does, so becoming visible again can't produce a click.
        const visible =
          this[P_SESSION].device[P_DEVICE].visibilityState === 'visible';
        for (const inputSource of removed) {
          for (const button of inputSource.gamepad?.buttons ?? []) {
            if (!(button instanceof GamepadButton)) {
              continue;
            }
            const trigger = button[P_GAMEPAD].eventTrigger;
            const frame = this[P_SESSION].activeFrame;
            if (
              visible &&
              trigger &&
              frame &&
              button[P_GAMEPAD].lastFramePressed
            ) {
              for (const type of edgeEventTypes('cancel', trigger)) {
                this.dispatchEvent(
                  new XRInputSourceEvent(type, { frame, inputSource }),
                );
              }
            }
            resetButton(button);
          }
        }

        if (added.length > 0 || removed.length > 0) {
          this.dispatchEvent(
            new XRInputSourcesChangeEvent('inputsourceschange', {
              session: this,
              added,
              removed,
            }),
          );
        }
      },
      trackedAnchors: new XRAnchorSet(),
      persistentAnchors: new Map(),
      newAnchors: new Map(),
      frameTrackedAnchors: new XRAnchorSet(),
      updateTrackedAnchors: () => {
        if (this[P_SESSION].enabledFeatures.includes('anchors')) {
          this[P_SESSION].frameTrackedAnchors.clear();
          Array.from(this[P_SESSION].trackedAnchors).forEach((anchor) => {
            if (anchor[P_ANCHOR].deleted) {
              this[P_SESSION].trackedAnchors.delete(anchor);
              if (this[P_SESSION].newAnchors.has(anchor)) {
                const { reject } = this[P_SESSION].newAnchors.get(anchor)!;
                reject(
                  new DOMException(
                    'Anchor is no longer tracked',
                    'InvalidStateError',
                  ),
                );
              }
            } else {
              this[P_SESSION].frameTrackedAnchors.add(anchor);
              if (this[P_SESSION].newAnchors.has(anchor)) {
                const { resolve } = this[P_SESSION].newAnchors.get(anchor)!;
                resolve(anchor);
                this[P_SESSION].newAnchors.delete(anchor);
              }
            }
          });
        }
      },
      trackedPlanes: new Map(),
      updateTrackedPlanes: (frame: XRFrame) => {
        const sem = this[P_SESSION].device[P_DEVICE].sem;
        if (!sem) {
          return;
        }
        const trackedPlanes = Array.from(this[P_SESSION].trackedPlanes.keys());
        trackedPlanes.forEach((plane) => {
          if (!sem.trackedPlanes.has(plane)) {
            this[P_SESSION].trackedPlanes.delete(plane);
          }
        });
        sem.trackedPlanes.forEach((plane) => {
          let xrPlane = this[P_SESSION].trackedPlanes.get(plane);
          if (!xrPlane) {
            const planeSpace = new XRSpace(
              this[P_SESSION].device[P_DEVICE].globalSpace,
              plane.transform.matrix,
            );
            xrPlane = new XRPlane(
              plane,
              planeSpace,
              plane.polygon,
              plane.semanticLabel,
            );
            xrPlane[P_PLANE].lastChangedTime = frame.predictedDisplayTime;
            this[P_SESSION].trackedPlanes.set(plane, xrPlane);
          } else {
            // Pose is not a plane attribute, so moving planes update their
            // space without bumping lastChangedTime, unless they turn between
            // horizontal and vertical.
            XRSpaceUtils.updateOffsetMatrix(
              xrPlane.planeSpace,
              plane.transform.matrix,
            );
            const orientation = planeOrientation(plane, plane.semanticLabel);
            if (orientation !== xrPlane[P_PLANE].orientation) {
              xrPlane[P_PLANE].orientation = orientation;
              xrPlane[P_PLANE].lastChangedTime = frame.predictedDisplayTime;
            }
          }
          xrPlane[P_PLANE].frame = frame;
          frame[P_FRAME].detectedPlanes.add(xrPlane);
        });
      },
      trackedMeshes: new Map(),
      updateTrackedMeshes: (frame: XRFrame) => {
        const sem = this[P_SESSION].device[P_DEVICE].sem;
        if (!sem) {
          return;
        }
        const trackedMeshes = Array.from(this[P_SESSION].trackedMeshes.keys());
        trackedMeshes.forEach((mesh) => {
          if (!sem.trackedMeshes.has(mesh)) {
            this[P_SESSION].trackedMeshes.delete(mesh);
          }
        });
        sem.trackedMeshes.forEach((mesh) => {
          let xrMesh = this[P_SESSION].trackedMeshes.get(mesh);
          if (!xrMesh) {
            const meshSpace = new XRSpace(
              this[P_SESSION].device[P_DEVICE].globalSpace,
              mesh.transform.matrix,
            );
            xrMesh = new XRMesh(
              mesh,
              meshSpace,
              mesh.vertices,
              mesh.indices,
              mesh.semanticLabel,
            );
            xrMesh[P_MESH].lastChangedTime = frame.predictedDisplayTime;
            this[P_SESSION].trackedMeshes.set(mesh, xrMesh);
          } else {
            XRSpaceUtils.updateOffsetMatrix(
              xrMesh.meshSpace,
              mesh.transform.matrix,
            );
          }
          xrMesh[P_MESH].frame = frame;
          frame[P_FRAME].detectedMeshes.add(xrMesh);
        });
      },
      depthSensingUsage: (webgpuDepth?.usage ??
        _depthSensing?.usagePreference?.[0] ??
        'cpu-optimized') as XRDepthUsage,
      depthSensingDataFormat: webgpuDepth?.dataFormat ?? 'float32',
      depthTexture: null,
      depthTextureWidth: 0,
      depthTextureHeight: 0,
      depthFlipScratch: null,
      depthFlipScratchSize: 0,
      activeFrame: null,
      computeDepthSensing: (frame: XRFrame) => {
        const sem = this[P_SESSION].device[P_DEVICE].sem;
        if (!sem) return;

        const { depthNear, depthFar } = this[P_SESSION].renderState;
        const baseLayer = this[P_SESSION].renderState.baseLayer;
        // WebGPU sessions have no baseLayer; their views fill the window.
        const canvas = baseLayer?.context.canvas ?? {
          width: window.innerWidth,
          height: window.innerHeight,
        };
        const depthWidth = Math.max(1, Math.floor(canvas.width / 4));
        const depthHeight = Math.max(1, Math.floor(canvas.height / 4));

        const eyes =
          this[P_SESSION].mode === 'inline'
            ? [XREye.None]
            : [XREye.Left, XREye.Right];

        const isGpuOptimized =
          baseLayer !== null &&
          this[P_SESSION].depthSensingUsage === 'gpu-optimized';

        for (const eye of eyes) {
          let projectionMatrix = this[P_SESSION].getProjectionMatrix(eye);
          if (this[P_SESSION].hasWebGPU) {
            // SEM renders depth with WebGL, which uses a [-1, 1] depth range.
            projectionMatrix = mat4.multiply(
              mat4.create(),
              WEBGPU_TO_WEBGL_DEPTH,
              projectionMatrix,
            );
          }
          const viewSpace = this[P_SESSION].device.viewSpaces[eye];
          const viewGlobalMatrix =
            XRSpaceUtils.calculateGlobalOffsetMatrix(viewSpace);
          const viewMatrix = mat4.create();
          mat4.invert(viewMatrix, viewGlobalMatrix);

          const result = sem.computeDepthBuffer(
            viewMatrix,
            projectionMatrix,
            depthWidth,
            depthHeight,
            depthNear,
            depthFar,
          );
          if (result) {
            // SEM renders float32 meters; the 16-bit formats take millimeters.
            const depth =
              this[P_SESSION].depthSensingDataFormat === 'float32'
                ? result
                : toMillimeterDepth(result);
            if (
              this[P_SESSION].hasWebGPU &&
              this[P_SESSION].depthSensingUsage === 'gpu-optimized'
            ) {
              // XRGPUBinding uploads it on the app's device when asked.
              frame[P_FRAME].webgpuDepthDataMap.set(eye, depth);
            } else if (isGpuOptimized) {
              // Provide GPU depth data (inverse depth in texture)
              const gl = baseLayer.context as WebGL2RenderingContext;
              const { width: dw, height: dh } = result;
              const numLayers = 2;

              if (
                !this[P_SESSION].depthTexture ||
                this[P_SESSION].depthTextureWidth !== dw ||
                this[P_SESSION].depthTextureHeight !== dh
              ) {
                if (this[P_SESSION].depthTexture) {
                  gl.deleteTexture(this[P_SESSION].depthTexture);
                }
                this[P_SESSION].depthTexture = gl.createTexture();
                gl.bindTexture(
                  gl.TEXTURE_2D_ARRAY,
                  this[P_SESSION].depthTexture,
                );
                gl.texStorage3D(
                  gl.TEXTURE_2D_ARRAY,
                  1,
                  gl.R32F,
                  dw,
                  dh,
                  numLayers,
                );
                gl.texParameteri(
                  gl.TEXTURE_2D_ARRAY,
                  gl.TEXTURE_MIN_FILTER,
                  gl.NEAREST,
                );
                gl.texParameteri(
                  gl.TEXTURE_2D_ARRAY,
                  gl.TEXTURE_MAG_FILTER,
                  gl.NEAREST,
                );
                gl.texParameteri(
                  gl.TEXTURE_2D_ARRAY,
                  gl.TEXTURE_WRAP_S,
                  gl.CLAMP_TO_EDGE,
                );
                gl.texParameteri(
                  gl.TEXTURE_2D_ARRAY,
                  gl.TEXTURE_WRAP_T,
                  gl.CLAMP_TO_EDGE,
                );
                this[P_SESSION].depthTextureWidth = dw;
                this[P_SESSION].depthTextureHeight = dh;
              } else {
                gl.bindTexture(
                  gl.TEXTURE_2D_ARRAY,
                  this[P_SESSION].depthTexture,
                );
              }

              const srcData = new Float32Array(result.data);
              const flipSize = dw * dh;
              if (
                !this[P_SESSION].depthFlipScratch ||
                this[P_SESSION].depthFlipScratchSize !== flipSize
              ) {
                this[P_SESSION].depthFlipScratch = new Float32Array(flipSize);
                this[P_SESSION].depthFlipScratchSize = flipSize;
              }
              const flippedData = this[P_SESSION].depthFlipScratch;
              for (let row = 0; row < dh; row++) {
                const srcRow = dh - 1 - row;
                for (let col = 0; col < dw; col++) {
                  const depthM = srcData[srcRow * dw + col];
                  flippedData[row * dw + col] =
                    depthM > 0 ? 1 - depthNear / depthM : 0;
                }
              }

              const prevFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
              const prevPremultiply = gl.getParameter(
                gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
              );
              gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
              gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

              const layerIndex = eye === XREye.Right ? 1 : 0;
              gl.texSubImage3D(
                gl.TEXTURE_2D_ARRAY,
                0,
                0,
                0,
                layerIndex,
                dw,
                dh,
                1,
                gl.RED,
                gl.FLOAT,
                flippedData,
              );

              gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlipY);
              gl.pixelStorei(
                gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
                prevPremultiply,
              );

              const gpuDepthInfo = new XRWebGLDepthInformation(
                this[P_SESSION].depthTexture!,
                dw,
                dh,
                new XRRigidTransform(),
                result.rawValueToMeters,
                depthNear,
                depthFar,
                'texture-array',
                layerIndex,
              );
              frame[P_FRAME].gpuDepthDataMap.set(eye, gpuDepthInfo);
            } else {
              // Provide CPU depth data.
              const cpuDepthInfo = new XRCPUDepthInformation(
                depth.data,
                depth.width,
                depth.height,
                new XRRigidTransform(),
                depth.rawValueToMeters,
                this[P_SESSION].depthSensingDataFormat,
              );
              frame[P_FRAME].depthDataMap.set(eye, cpuDepthInfo);
            }
          }
        }
      },
      hitTestSources: new Set(),
      computeHitTestResults: (frame) => {
        const sem = this[P_SESSION].device[P_DEVICE].sem;
        if (!sem) return;
        const globalSpace = this[P_SESSION].device[P_DEVICE].globalSpace;
        this[P_SESSION].hitTestSources.forEach((hitTestSource) => {
          const sourceSpace = hitTestSource[P_HIT_TEST].space;
          const sourceGlobalOffset =
            XRSpaceUtils.calculateGlobalOffsetMatrix(sourceSpace);
          const rayLocalOffset = hitTestSource[P_HIT_TEST].offsetRay.matrix;
          const rayGlobalOffset = mat4.create();
          mat4.multiply(rayGlobalOffset, sourceGlobalOffset, rayLocalOffset);
          const hitTestResults: XRHitTestResult[] = [];
          sem.computeHitTestResults(rayGlobalOffset).forEach((matrix) => {
            const offsetSpace = new XRSpace(globalSpace, matrix);
            const hitTestResult = new XRHitTestResult(frame, offsetSpace);
            hitTestResults.push(hitTestResult);
          });
          frame[P_FRAME].hitTestResultsMap.set(hitTestSource, hitTestResults);
        });
      },
      onend: null,
      oninputsourceschange: null,
      onselect: null,
      onselectstart: null,
      onselectend: null,
      onsqueeze: null,
      onsqueezestart: null,
      onsqueezeend: null,
      onvisibilitychange: null,
      onframeratechange: null,
    };

    XRAnchorUtils.recoverPersistentAnchorsFromStorage(this);

    // start the frameloop
    this[P_SESSION].onDeviceFrame();
  }

  get visibilityState(): XRVisibilityState {
    return this[P_SESSION].device.visibilityState;
  }

  get frameRate(): number | undefined {
    return this[P_SESSION].nominalFrameRate;
  }

  get supportedFrameRates(): Float32Array | undefined {
    return this[P_SESSION].supportedFrameRates;
  }

  get renderState(): XRRenderState {
    return this[P_SESSION].renderState;
  }

  get inputSources(): XRInputSourceArray {
    // use the same array object
    this[P_SESSION].inputSourceArray.length = 0;
    if (!this[P_SESSION].ended && this[P_SESSION].mode !== 'inline') {
      this[P_SESSION].inputSourceArray.push(
        ...this[P_SESSION].activeInputSources,
      );
    }
    return this[P_SESSION].inputSourceArray;
  }

  get enabledFeatures(): Array<string> {
    return this[P_SESSION].enabledFeatures;
  }

  get isSystemKeyboardSupported(): boolean {
    return this[P_SESSION].isSystemKeyboardSupported;
  }

  get environmentBlendMode(): XREnvironmentBlendMode {
    return (
      this[P_SESSION].device[P_DEVICE].environmentBlendModes[
        this[P_SESSION].mode
      ] ?? XREnvironmentBlendMode.Opaque
    );
  }

  get interactionMode(): XRInteractionMode {
    return this[P_SESSION].device[P_DEVICE].interactionMode;
  }

  get maxRenderLayers(): number {
    return MAX_RENDER_LAYERS;
  }

  get depthUsage(): XRDepthUsage {
    return this[P_SESSION].depthSensingUsage;
  }

  get depthDataFormat(): XRDepthDataFormat {
    return this[P_SESSION].depthSensingDataFormat;
  }

  updateRenderState(state: XRRenderStateInit = {}): void {
    if (this[P_SESSION].ended) {
      throw new DOMException(
        'XRSession has already ended.',
        'InvalidStateError',
      );
    }

    if (this[P_SESSION].hasWebGPU && state.baseLayer) {
      throw state.layers
        ? new DOMException(
            'A render state cannot have both a baseLayer and layers',
            'NotSupportedError',
          )
        : new DOMException(
            'WebGPU sessions must use layers instead of a baseLayer',
            'InvalidStateError',
          );
    }

    if (state.baseLayer && state.baseLayer[P_WEBGL_LAYER].session !== this) {
      throw new DOMException(
        'Base layer was created by a different XRSession',
        'InvalidStateError',
      );
    }

    if (
      state.inlineVerticalFieldOfView != null &&
      this[P_SESSION].mode !== 'inline'
    ) {
      throw new DOMException(
        'InlineVerticalFieldOfView must not be set for an immersive session',
        'InvalidStateError',
      );
    }

    if (this[P_SESSION].hasWebGPU && state.layers) {
      // The WebXR Layers checks, in their order.
      const layers = [...state.layers];
      if (!layers.every((layer) => layer instanceof XRLayer)) {
        throw new TypeError('renderState layers must be XRLayer objects');
      }
      if (
        layers.some(
          (layer) =>
            layer instanceof XRCompositionLayer &&
            layer[P_COMPOSITION_LAYER].destroyed,
        )
      ) {
        throw new DOMException('Layer has been destroyed', 'InvalidStateError');
      }
      if (
        layers.length > 1 &&
        !this[P_SESSION].enabledFeatures.includes('layers')
      ) {
        throw new DOMException(
          "Multiple layers require the 'layers' feature",
          'NotSupportedError',
        );
      }
      if (layers.length > MAX_RENDER_LAYERS) {
        throw new DOMException(
          `At most ${MAX_RENDER_LAYERS} layers can be shown at once`,
          'NotSupportedError',
        );
      }
      if (new Set(layers).size !== layers.length) {
        throw new TypeError('renderState layers must not repeat a layer');
      }
      for (const layer of layers) {
        const session =
          layer instanceof XRCompositionLayer
            ? layer[P_COMPOSITION_LAYER].session
            : layer instanceof XRWebGLLayer
              ? layer[P_WEBGL_LAYER].session
              : this;
        if (session !== this) {
          throw new TypeError('Layer was created by a different XRSession');
        }
      }
    }

    const compoundStateInit: XRRenderStateInit = {
      // Use nullish coalescing so legitimate 0 values (e.g.
      // inlineVerticalFieldOfView=0) are preserved instead of being dropped.
      baseLayer:
        state.baseLayer ??
        this[P_SESSION].pendingRenderState?.baseLayer ??
        undefined,
      depthFar:
        state.depthFar ??
        this[P_SESSION].pendingRenderState?.depthFar ??
        undefined,
      depthNear:
        state.depthNear ??
        this[P_SESSION].pendingRenderState?.depthNear ??
        undefined,
      inlineVerticalFieldOfView:
        state.inlineVerticalFieldOfView ??
        this[P_SESSION].pendingRenderState?.inlineVerticalFieldOfView ??
        undefined,
      // Sessions without the 'webgpu' feature keep ignoring layers.
      layers: this[P_SESSION].hasWebGPU
        ? (state.layers ??
          this[P_SESSION].pendingRenderState?.layers ??
          undefined)
        : undefined,
    };

    this[P_SESSION].pendingRenderState = new XRRenderState(
      compoundStateInit,
      this[P_SESSION].renderState,
    );
  }

  // the nominal frame rate updates are emulated, no actual update to the
  // display frame rate of the device will be executed
  async updateTargetFrameRate(rate: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this[P_SESSION].ended) {
        reject(
          new DOMException('XRSession has already ended.', 'InvalidStateError'),
        );
      } else if (!this[P_SESSION].device.supportedFrameRates.includes(rate)) {
        reject(
          new DOMException(
            'Requested frame rate not supported.',
            'InvalidStateError',
          ),
        );
      } else {
        if (this[P_SESSION].nominalFrameRate === rate) {
          console.log(
            `Requested frame rate is the same as the current nominal frame rate, no update made`,
          );
        } else {
          this[P_SESSION].nominalFrameRate = rate;
          this.dispatchEvent(
            new XRSessionEvent('frameratechange', { session: this }),
          );
          console.log(`Nominal frame rate updated to ${rate}`);
        }
        resolve();
      }
    });
  }

  async requestReferenceSpace(
    type: XRReferenceSpaceType,
  ): Promise<XRReferenceSpace> {
    return new Promise<XRReferenceSpace>((resolve, reject) => {
      if (
        this[P_SESSION].ended ||
        !this[P_SESSION].referenceSpaceIsSupported(type)
      ) {
        reject(
          new DOMException(
            'The requested reference space type is not supported.',
            'NotSupportedError',
          ),
        );
        return;
      }
      let referenceSpace: XRReferenceSpace;
      switch (type) {
        case XRReferenceSpaceType.Viewer:
          referenceSpace = this[P_SESSION].device.viewerSpace;
          break;
        case XRReferenceSpaceType.Local:
          // creating an XRReferenceSpace with the current headset transform in global space
          referenceSpace = new XRReferenceSpace(
            type,
            this[P_SESSION].device[P_DEVICE].globalSpace,
            this[P_SESSION].device.viewerSpace[P_SPACE].offsetMatrix,
          );
          break;
        case XRReferenceSpaceType.LocalFloor:
        case XRReferenceSpaceType.BoundedFloor:
        case XRReferenceSpaceType.Unbounded:
          // TO-DO: add boundary geometry for bounded-floor
          referenceSpace = new XRReferenceSpace(
            type,
            this[P_SESSION].device[P_DEVICE].globalSpace,
          );
          break;
      }
      this[P_SESSION].referenceSpaces.push(referenceSpace);
      recordSpaceSession(referenceSpace, this);
      resolve(referenceSpace);
    });
  }

  requestAnimationFrame(callback: XRFrameRequestCallback): number {
    if (this[P_SESSION].ended) {
      return 0;
    }
    const frameHandle = ++this[P_SESSION].frameHandle;
    this[P_SESSION].frameCallbacks.push({
      handle: frameHandle,
      callback,
      cancelled: false,
    });
    return frameHandle;
  }

  cancelAnimationFrame(handle: number): void {
    // Remove the callback with that handle from the queue
    let callbacks: CallbackData[] | null = this[P_SESSION].frameCallbacks;
    let index = callbacks.findIndex((d) => d && d.handle === handle);
    if (index > -1) {
      callbacks[index].cancelled = true;
      callbacks.splice(index, 1);
    }
    // If cancelAnimationFrame is called from within a frame callback, also check
    // the remaining callbacks for the current frame:
    callbacks = this[P_SESSION].currentFrameCallbacks;
    if (callbacks) {
      index = callbacks.findIndex((d) => d && d.handle === handle);
      if (index > -1) {
        callbacks[index].cancelled = true;
        // Rely on cancelled flag only; don't mutate this array while it's being iterated
      }
    }
  }

  async end(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this[P_SESSION].ended) {
        reject(
          new DOMException('XRSession has already ended.', 'InvalidStateError'),
        );
      } else {
        // Mark the session as ended so the device frameloop early-returns and
        // requestAnimationFrame/updateRenderState behave per spec after end.
        this[P_SESSION].ended = true;
        globalThis.cancelAnimationFrame(this[P_SESSION].deviceFrameHandle!);
        this[P_SESSION].deviceFrameHandle = undefined;
        this[P_SESSION].device[P_DEVICE].onSessionEnd();

        // Tear down per-session state so it doesn't dangle after end.
        this[P_SESSION].frameCallbacks.length = 0;
        this[P_SESSION].currentFrameCallbacks = null;
        this[P_SESSION].referenceSpaces.length = 0;
        this[P_SESSION].hitTestSources.clear();
        this[P_SESSION].trackedPlanes.clear();
        this[P_SESSION].trackedMeshes.clear();
        // Per-session tracked anchors only; persistentAnchors survive by design.
        this[P_SESSION].trackedAnchors.clear();
        this[P_SESSION].frameTrackedAnchors.clear();
        // Reject any pending anchor-creation promises so they don't dangle.
        this[P_SESSION].newAnchors.forEach(({ reject: rejectAnchor }) => {
          rejectAnchor(
            new DOMException(
              'XRSession has ended before the anchor was resolved.',
              'InvalidStateError',
            ),
          );
        });
        this[P_SESSION].newAnchors.clear();
        // Release the depth texture via the base layer context, if any.
        if (this[P_SESSION].depthTexture) {
          const depthContext = this[P_SESSION].renderState.baseLayer?.context;
          depthContext?.deleteTexture(this[P_SESSION].depthTexture);
          this[P_SESSION].depthTexture = null;
        }
        // Stop presenting and free every WebGPU layer's textures.
        this[P_SESSION].gpuPresenter?.detach();
        this[P_SESSION].gpuPresenter = null;
        for (const layer of [...this[P_SESSION].gpuLayers]) {
          layer.destroy();
        }

        this.dispatchEvent(new XRSessionEvent('end', { session: this }));
        resolve();
      }
    });
  }

  // anchors
  get persistentAnchors(): Readonly<string[]> {
    return Array.from(this[P_SESSION].persistentAnchors.keys());
  }

  restorePersistentAnchor(uuid: string): Promise<XRAnchor> {
    return new Promise<XRAnchor>((resolve, reject) => {
      if (!this[P_SESSION].persistentAnchors.has(uuid)) {
        reject(
          new DOMException(
            `Persistent anchor with uuid ${uuid} not found.`,
            'InvalidStateError',
          ),
        );
      } else if (this[P_SESSION].ended) {
        reject(
          new DOMException('XRSession has already ended.', 'InvalidStateError'),
        );
      } else {
        const anchor = this[P_SESSION].persistentAnchors.get(uuid)!;
        if (this[P_SESSION].newAnchors.has(anchor)) {
          reject(
            new DOMException(
              `Multiple concurrent attempts detected to restore the anchor with UUID: ${uuid}.`,
              'InvalidStateError',
            ),
          );
        } else {
          this[P_SESSION].trackedAnchors.add(anchor);
          this[P_SESSION].newAnchors.set(anchor, { resolve, reject });
        }
      }
    });
  }

  deletePersistentAnchor(uuid: string): Promise<undefined> {
    return new Promise<undefined>((resolve, reject) => {
      if (!this[P_SESSION].persistentAnchors.has(uuid)) {
        reject(
          new DOMException(
            `Persistent anchor with uuid ${uuid} not found.`,
            'InvalidStateError',
          ),
        );
      } else {
        const anchor = this[P_SESSION].persistentAnchors.get(uuid)!;
        this[P_SESSION].persistentAnchors.delete(uuid);
        anchor.delete();
        resolve(undefined);
      }
    });
  }

  requestHitTestSource(options: XRHitTestOptionsInit) {
    return new Promise<XRHitTestSource>((resolve, reject) => {
      if (!this[P_SESSION].enabledFeatures.includes('hit-test')) {
        reject(
          new DOMException(
            `WebXR feature "hit-test" is not supported by current session`,
            'NotSupportedError',
          ),
        );
      } else if (this[P_SESSION].ended) {
        reject(
          new DOMException('XRSession has already ended.', 'InvalidStateError'),
        );
      } else if (!this[P_SESSION].device[P_DEVICE].sem) {
        reject(
          new DOMException(
            'Synthethic Environment Module required for emulating hit-test',
            'OperationError',
          ),
        );
      } else {
        const xrHitTestSource = new XRHitTestSource(this, options);
        this[P_SESSION].hitTestSources.add(xrHitTestSource);
        resolve(xrHitTestSource);
      }
    });
  }

  // events
  get onend() {
    return this[P_SESSION].onend!;
  }

  set onend(callback: XRSessionEventHandler) {
    if (this[P_SESSION].onend) {
      this.removeEventListener('end', this[P_SESSION].onend as EventListener);
    }
    this[P_SESSION].onend = callback;
    if (callback) {
      this.addEventListener('end', callback as EventListener);
    }
  }

  get oninputsourceschange() {
    return this[P_SESSION].oninputsourceschange!;
  }

  set oninputsourceschange(callback: XRInputSourcesChangeEventHandler) {
    if (this[P_SESSION].oninputsourceschange) {
      this.removeEventListener(
        'inputsourceschange',
        this[P_SESSION].oninputsourceschange as EventListener,
      );
    }
    this[P_SESSION].oninputsourceschange = callback;
    if (callback) {
      this.addEventListener('inputsourceschange', callback as EventListener);
    }
  }

  get onselect() {
    return this[P_SESSION].onselect!;
  }

  set onselect(callback: XRInputSourceEventHandler) {
    if (this[P_SESSION].onselect) {
      this.removeEventListener(
        'select',
        this[P_SESSION].onselect as EventListener,
      );
    }
    this[P_SESSION].onselect = callback;
    if (callback) {
      this.addEventListener('select', callback as EventListener);
    }
  }

  get onselectstart() {
    return this[P_SESSION].onselectstart!;
  }

  set onselectstart(callback: XRInputSourceEventHandler) {
    if (this[P_SESSION].onselectstart) {
      this.removeEventListener(
        'selectstart',
        this[P_SESSION].onselectstart as EventListener,
      );
    }
    this[P_SESSION].onselectstart = callback;
    if (callback) {
      this.addEventListener('selectstart', callback as EventListener);
    }
  }

  get onselectend() {
    return this[P_SESSION].onselectend!;
  }

  set onselectend(callback: XRInputSourceEventHandler) {
    if (this[P_SESSION].onselectend) {
      this.removeEventListener(
        'selectend',
        this[P_SESSION].onselectend as EventListener,
      );
    }
    this[P_SESSION].onselectend = callback;
    if (callback) {
      this.addEventListener('selectend', callback as EventListener);
    }
  }

  get onsqueeze() {
    return this[P_SESSION].onsqueeze!;
  }

  set onsqueeze(callback: XRInputSourceEventHandler) {
    if (this[P_SESSION].onsqueeze) {
      this.removeEventListener(
        'squeeze',
        this[P_SESSION].onsqueeze as EventListener,
      );
    }
    this[P_SESSION].onsqueeze = callback;
    if (callback) {
      this.addEventListener('squeeze', callback as EventListener);
    }
  }

  get onsqueezestart() {
    return this[P_SESSION].onsqueezestart!;
  }

  set onsqueezestart(callback: XRInputSourceEventHandler) {
    if (this[P_SESSION].onsqueezestart) {
      this.removeEventListener(
        'squeezestart',
        this[P_SESSION].onsqueezestart as EventListener,
      );
    }
    this[P_SESSION].onsqueezestart = callback;
    if (callback) {
      this.addEventListener('squeezestart', callback as EventListener);
    }
  }

  get onsqueezeend() {
    return this[P_SESSION].onsqueezeend!;
  }

  set onsqueezeend(callback: XRInputSourceEventHandler) {
    if (this[P_SESSION].onsqueezeend) {
      this.removeEventListener(
        'squeezeend',
        this[P_SESSION].onsqueezeend as EventListener,
      );
    }
    this[P_SESSION].onsqueezeend = callback;
    if (callback) {
      this.addEventListener('squeezeend', callback as EventListener);
    }
  }

  get onvisibilitychange() {
    return this[P_SESSION].onvisibilitychange!;
  }

  set onvisibilitychange(callback: XRSessionEventHandler) {
    if (this[P_SESSION].onvisibilitychange) {
      this.removeEventListener(
        'visibilitychange',
        this[P_SESSION].onvisibilitychange as EventListener,
      );
    }
    this[P_SESSION].onvisibilitychange = callback;
    if (callback) {
      this.addEventListener('visibilitychange', callback as EventListener);
    }
  }

  get onframeratechange() {
    return this[P_SESSION].onframeratechange!;
  }

  set onframeratechange(callback: XRSessionEventHandler) {
    if (this[P_SESSION].onframeratechange) {
      this.removeEventListener(
        'frameratechange',
        this[P_SESSION].onframeratechange as EventListener,
      );
    }
    this[P_SESSION].onframeratechange = callback;
    if (callback) {
      this.addEventListener('frameratechange', callback as EventListener);
    }
  }
}
