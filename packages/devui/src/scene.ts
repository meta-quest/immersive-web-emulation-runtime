/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Euler,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { TransformHandles, TransformHandlesMode } from '@pmndrs/handle';

import { XRDevice } from 'iwer';
import { forwardHtmlEvents } from '@pmndrs/pointer-events';
import {
  cursorToViewerDirection,
  type GazeCommitHand,
  type GazeMode,
} from './gaze.js';

export const PRIVATE = Symbol('@@iwer/devui/input-scene');
const FREE_MOVEMENT_SPEED = 2;

type Handedness = 'left' | 'right';
type GazeCommitSource = {
  mode: 'controller' | 'hand';
  handedness: Handedness;
};
type PendingGazeCommitRelease = {
  source: GazeCommitSource;
  queuedForFrame: boolean;
};

export interface PoseTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface DefaultPose {
  headset: PoseTransform;
  controllers?: Partial<Record<Handedness, PoseTransform>>;
  hands?: Partial<Record<Handedness, PoseTransform>>;
}

export class InputLayer {
  public transformHandles: Map<Handedness, TransformHandles>;
  public combinedCameraPosition: Vector3 = new Vector3();

  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private playerRig: Group;
  private cameraRig: Group;
  private isPointerLocked: boolean = false;
  private vec3: Vector3 = new Vector3();
  private quat: Quaternion = new Quaternion();
  private quatB: Quaternion = new Quaternion();
  private quatInv: Quaternion = new Quaternion();
  private quatMouse: Quaternion = new Quaternion();
  private euler: Euler = new Euler();
  private mouseMoveHandler: (event: MouseEvent) => void;
  private gazePointerDownHandlerBound: (event: PointerEvent) => void;
  private gazePointerMoveHandlerBound: (event: PointerEvent) => void;
  private gazePointerUpHandlerBound: (event: PointerEvent) => void;
  private gazeWheelHandlerBound: (event: WheelEvent) => void;
  private gazeContextMenuHandlerBound: (event: MouseEvent) => void;
  private windowBlurHandlerBound: () => void;
  private documentVisibilityHandlerBound: () => void;
  private pointerLockChangeHandlerBound: () => void;
  private keyDownHandlerBound: (event: KeyboardEvent) => void;
  private keyUpHandlerBound: (event: KeyboardEvent) => void;
  private headsetDefaultPosition: Vector3;
  private headsetDefaultQuaternion: Quaternion;
  private keyState: { [key: string]: boolean } = {
    ShiftLeft: false,
    KeyW: false,
    KeyA: false,
    KeyS: false,
    KeyD: false,
    ArrowUp: false,
    ArrowDown: false,
  };
  private forwardHtmlEvents: () => void;
  private lastTime: number = 0;
  private gazeMode: GazeMode;
  private preferredConnectedGazeMode: Exclude<GazeMode, 'off'> = 'head-locked';
  private gazeCommitHand: GazeCommitHand = 'right';
  private gazePointerId: number | null = null;
  private gazeCommitActive: GazeCommitSource | undefined;
  private gazeCommitPendingRelease: PendingGazeCommitRelease | undefined;
  private gazeHeadsetDragActive = false;
  private gazeLastPointer = { x: 0, y: 0 };
  private readonly gazeForward = new Vector3(0, 0, -1);
  private readonly gazeDirection = new Vector3();
  private readonly gazeQuaternion = new Quaternion();

  /**
   * Whether the device is in programmatic control mode.
   * When true, this layer won't sync TO the device (device controls us instead).
   */
  public isInProgrammaticMode: boolean = false;

  /**
   * Whether user interactions (pointer lock, mouse movement) are enabled.
   */
  private interactionsEnabled: boolean = true;

  constructor(private xrDevice: XRDevice) {
    this.scene = new Scene();
    this.gazeMode = xrDevice.gaze?.connected ? 'head-locked' : 'off';
    this.camera = new PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      40,
    );

    this.playerRig = new Group();
    this.cameraRig = new Group();
    this.scene.add(this.playerRig);
    this.playerRig.add(this.cameraRig);
    this.cameraRig.position.fromArray(xrDevice.position.vec3);
    this.cameraRig.quaternion.fromArray(xrDevice.quaternion.quat);
    this.cameraRig.add(this.camera);
    this.camera.position.x -= xrDevice.ipd / 2;

    const spaceOriginIndicator = new Mesh(
      new RingGeometry(0.25, 0.27, 32),
      new MeshBasicMaterial({
        color: 0xffffff,
        side: FrontSide,
      }),
    );
    spaceOriginIndicator.rotateX(-Math.PI / 2);
    this.scene.add(spaceOriginIndicator);

    // Create a renderer
    this.renderer = new WebGLRenderer({ alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 0);

    this.renderer.domElement.style.position = 'fixed';
    this.renderer.domElement.style.top = '50vh';
    this.renderer.domElement.style.left = '50vw';
    this.renderer.domElement.style.transform = 'translate(-50%, -50%)';

    this.transformHandles = new Map<Handedness, TransformHandles>();
    (['left', 'right'] as Handedness[]).forEach((handedness) => {
      const transformHandle = new TransformHandles();
      transformHandle.scale.setScalar(0.1);
      transformHandle.position.fromArray(
        xrDevice.controllers[handedness]!.position.vec3,
      );
      transformHandle.quaternion.fromArray(
        xrDevice.controllers[handedness]!.quaternion.quat,
      );
      this.cameraRig.attach(transformHandle);
      transformHandle.userData = {
        defaultPosition: transformHandle.position.toArray(),
        defaultQuaternion: transformHandle.quaternion.toArray(),
      };
      transformHandle.userData.setMode = (mode: TransformHandlesMode) => {
        transformHandle.userData.modeCleanup?.();
        transformHandle.userData.modeCleanup = transformHandle.bind(mode);
        transformHandle.userData.mode = mode;
      };
      transformHandle.userData.setMode('translate');
      transformHandle.space = 'local';
      this.transformHandles.set(handedness, transformHandle);
      transformHandle.addEventListener('click' as any, () => {
        if (transformHandle.userData.mode === 'translate') {
          transformHandle.userData.setMode('rotate');
        } else {
          transformHandle.userData.setMode('translate');
        }
      });
    });

    // @ts-ignore
    window.transformHandles = this.transformHandles;

    this.mouseMoveHandler = (event: MouseEvent) => {
      if (!this.isPointerLocked || this.isInProgrammaticMode) return;
      const movementX =
        // @ts-ignore
        event.movementX || event.mozMovementX || event.webkitMovementX || 0;
      const movementY =
        // @ts-ignore
        event.movementY || event.mozMovementY || event.webkitMovementY || 0;
      this.playerRig.rotation.y -= movementX * 0.002;
      this.cameraRig.rotation.x -= movementY * 0.002;

      xrDevice.quaternion.copy(
        this.cameraRig.getWorldQuaternion(this.quatMouse) as any,
      );
    };

    this.cameraRig.getWorldPosition(this.combinedCameraPosition);
    this.headsetDefaultPosition = this.cameraRig.position.clone();
    this.headsetDefaultQuaternion = this.cameraRig.quaternion.clone();
    this.forwardHtmlEvents = forwardHtmlEvents(
      this.renderer.domElement,
      () => this.camera,
      this.scene,
    ).update;

    this.pointerLockChangeHandlerBound =
      this.pointerLockChangeHandler.bind(this);
    this.gazePointerDownHandlerBound = this.gazePointerDownHandler.bind(this);
    this.gazePointerMoveHandlerBound = this.gazePointerMoveHandler.bind(this);
    this.gazePointerUpHandlerBound = this.gazePointerUpHandler.bind(this);
    this.gazeWheelHandlerBound = this.gazeWheelHandler.bind(this);
    this.gazeContextMenuHandlerBound = this.gazeContextMenuHandler.bind(this);
    this.windowBlurHandlerBound = () => {
      this.releaseGazeCommit(true);
      this.gazeHeadsetDragActive = false;
    };
    this.documentVisibilityHandlerBound = () => {
      if (document.visibilityState !== 'visible') {
        this.releaseGazeCommit(true);
        this.gazeHeadsetDragActive = false;
      }
    };
    this.keyDownHandlerBound = this.keyDownHandler.bind(this);
    this.keyUpHandlerBound = this.keyUpHandler.bind(this);

    document.addEventListener(
      'pointerlockchange',
      this.pointerLockChangeHandlerBound,
      false,
    );
    document.addEventListener(
      'mozpointerlockchange',
      this.pointerLockChangeHandlerBound,
      false,
    );
    document.addEventListener(
      'webkitpointerlockchange',
      this.pointerLockChangeHandlerBound,
      false,
    );

    document.addEventListener('keydown', this.keyDownHandlerBound, false);
    document.addEventListener('keyup', this.keyUpHandlerBound, false);
    this.renderer.domElement.addEventListener(
      'pointerdown',
      this.gazePointerDownHandlerBound,
    );
    this.renderer.domElement.addEventListener(
      'pointermove',
      this.gazePointerMoveHandlerBound,
    );
    this.renderer.domElement.addEventListener(
      'pointerup',
      this.gazePointerUpHandlerBound,
    );
    this.renderer.domElement.addEventListener(
      'pointercancel',
      this.gazePointerUpHandlerBound,
    );
    this.renderer.domElement.addEventListener(
      'wheel',
      this.gazeWheelHandlerBound,
      { passive: false },
    );
    this.renderer.domElement.addEventListener(
      'contextmenu',
      this.gazeContextMenuHandlerBound,
    );
    window.addEventListener('blur', this.windowBlurHandlerBound);
    document.addEventListener(
      'visibilitychange',
      this.documentVisibilityHandlerBound,
    );
  }

  lockPointer() {
    // Don't allow pointer lock in programmatic mode or when interactions disabled
    if (
      this.isInProgrammaticMode ||
      !this.interactionsEnabled ||
      this.gazeMode === 'cursor'
    ) {
      return;
    }
    this.renderer.domElement.requestPointerLock =
      this.renderer.domElement.requestPointerLock ||
      // @ts-ignore
      this.renderer.domElement.mozRequestPointerLock ||
      // @ts-ignore
      this.renderer.domElement.webkitRequestPointerLock;
    this.renderer.domElement.requestPointerLock();
  }

  pointerLockChangeHandler() {
    this.isPointerLocked =
      document.pointerLockElement === this.renderer.domElement ||
      // @ts-ignore
      document.mozPointerLockElement === this.renderer.domElement ||
      // @ts-ignore
      document.webkitPointerLockElement === this.renderer.domElement;

    if (this.isPointerLocked) {
      document.addEventListener('mousemove', this.mouseMoveHandler, false);
    } else {
      document.removeEventListener('mousemove', this.mouseMoveHandler, false);
    }
  }

  get currentGazeMode(): GazeMode {
    return this.gazeMode;
  }

  get currentGazeCommitHand(): GazeCommitHand {
    return this.gazeCommitHand;
  }

  private applyGazeModePresentation(mode: GazeMode): void {
    this.gazeMode = mode;
    if (mode === 'cursor' && this.isPointerLocked) {
      document.exitPointerLock?.();
    }

    const ownsCanvas = mode === 'cursor';
    this.renderer.domElement.style.cursor = ownsCanvas ? 'crosshair' : '';
    this.renderer.domElement.style.touchAction = ownsCanvas ? 'none' : '';
    this.setTransformHandleRoutingSuppressed(ownsCanvas);
  }

  setGazeMode(mode: GazeMode): void {
    this.releaseGazeCommit(true);
    this.gazeHeadsetDragActive = false;

    const gaze = this.xrDevice.gaze;
    if (!gaze) {
      this.applyGazeModePresentation('off');
      return;
    }

    if (mode !== 'off') {
      this.preferredConnectedGazeMode = mode;
    }
    gaze.connected = mode !== 'off';
    if (mode === 'head-locked') {
      gaze.quaternion.set(0, 0, 0, 1);
    }
    this.applyGazeModePresentation(mode);
  }

  setProgrammaticMode(enabled: boolean): void {
    const wasProgrammatic = this.isInProgrammaticMode;
    this.isInProgrammaticMode = enabled;
    if (!wasProgrammatic || enabled) return;

    // Take over from where remote control left the device: a hand it holds
    // by an anchor settles after the last state change the handles followed.
    this.syncFromDevice();

    const gaze = this.xrDevice.gaze;
    const nextGazeMode: GazeMode = gaze?.connected
      ? this.preferredConnectedGazeMode
      : 'off';
    if (nextGazeMode === this.gazeMode) return;

    this.releaseGazeCommit(true);
    this.gazeHeadsetDragActive = false;
    // Programmatic control has ended. Restore the operator's last connected
    // gaze mode without reconnecting gaze if the remote client disabled it.
    this.applyGazeModePresentation(nextGazeMode);
  }

  setGazeCommitHand(handedness: GazeCommitHand): void {
    if (handedness === this.gazeCommitHand) return;
    this.releaseGazeCommit(true);
    this.gazeHeadsetDragActive = false;
    this.gazeCommitHand = handedness;
  }

  onSessionEnd(): void {
    this.releaseGazeCommit(true);
    this.gazeHeadsetDragActive = false;
  }

  private setTransformHandleRoutingSuppressed(suppressed: boolean): void {
    this.transformHandles.forEach((transformHandle) => {
      if (suppressed && !transformHandle.userData.gazeSuppressed) {
        transformHandle.userData.modeCleanup?.();
        transformHandle.userData.modeCleanup = undefined;
        transformHandle.userData.gazeSuppressed = true;
      } else if (!suppressed && transformHandle.userData.gazeSuppressed) {
        transformHandle.userData.gazeSuppressed = false;
        transformHandle.userData.setMode(transformHandle.userData.mode);
      }
    });
  }

  private gazeInteractionEnabled(): boolean {
    return (
      this.gazeMode === 'cursor' &&
      Boolean(this.xrDevice.gaze?.connected) &&
      this.xrDevice.visibilityState === 'visible' &&
      this.interactionsEnabled &&
      !this.isInProgrammaticMode &&
      Boolean(this.xrDevice.activeSession)
    );
  }

  private updateGazeFromPointer(clientX: number, clientY: number): void {
    if (!this.gazeInteractionEnabled() || this.gazeCommitActive) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const direction = cursorToViewerDirection(
      clientX,
      clientY,
      rect,
      this.xrDevice.stereoEnabled,
      this.xrDevice.fovy,
    );
    this.gazeDirection.fromArray(direction);
    this.gazeQuaternion.setFromUnitVectors(
      this.gazeForward,
      this.gazeDirection,
    );
    this.xrDevice.gaze!.quaternion.copy(this.gazeQuaternion as any);
  }

  private beginGazeCommit(): void {
    if (this.gazeCommitActive || this.gazeCommitPendingRelease) return;

    const mode = this.xrDevice.primaryInputMode;
    const handedness = this.gazeCommitHand;
    const input =
      mode === 'hand'
        ? this.xrDevice.hands[handedness]
        : this.xrDevice.controllers[handedness];
    if (!input?.connected) return;

    this.writeGazeCommitValue({ mode, handedness }, 1, false);
    this.gazeCommitActive = { mode, handedness };
  }

  private writeGazeCommitValue(
    source: GazeCommitSource,
    value: number,
    immediate: boolean,
  ): void {
    if (source.mode === 'hand') {
      const hand = this.xrDevice.hands[source.handedness];
      immediate
        ? hand?.setPinchValueImmediate(value)
        : hand?.updatePinchValue(value);
    } else {
      const controller = this.xrDevice.controllers[source.handedness];
      immediate
        ? controller?.setButtonValueImmediate('trigger', value)
        : controller?.updateButtonValue('trigger', value);
    }
  }

  private releaseGazeCommit(forceImmediate: boolean): void {
    const active = this.gazeCommitActive;
    const pendingRelease = this.gazeCommitPendingRelease?.source;
    const pointerId = this.gazePointerId;
    this.gazePointerId = null;
    if (
      pointerId !== null &&
      this.renderer.domElement.hasPointerCapture?.(pointerId)
    ) {
      this.renderer.domElement.releasePointerCapture?.(pointerId);
    }

    if (forceImmediate) {
      const queued = this.gazeCommitPendingRelease?.queuedForFrame;
      this.gazeCommitPendingRelease = undefined;
      // The user already let go: that release completes the click, so it
      // stays a release (queued for the next frame) rather than a cancel.
      if (pendingRelease && !queued) {
        this.writeGazeCommitValue(pendingRelease, 0, false);
      }
      if (active && active !== pendingRelease) {
        this.writeGazeCommitValue(active, 0, true);
      }
      this.gazeCommitActive = undefined;
      return;
    }
    if (!active) return;

    // DevUI renders immediately before XRTrackedInput.onFrameStart. Queue the
    // release from renderScene so a press and release received between frames
    // are observed as two edges instead of one pending value overwriting the
    // other.
    this.gazeCommitPendingRelease = {
      source: active,
      queuedForFrame: false,
    };
    this.gazeCommitActive = undefined;
  }

  private schedulePendingGazeRelease(): void {
    const pendingRelease = this.gazeCommitPendingRelease;
    if (!pendingRelease) return;
    queueMicrotask(() => {
      if (this.gazeCommitPendingRelease !== pendingRelease) return;
      if (!pendingRelease.queuedForFrame) {
        this.writeGazeCommitValue(pendingRelease.source, 0, false);
        pendingRelease.queuedForFrame = true;
      } else {
        // This microtask runs after XRTrackedInput.onFrameStart has consumed
        // the queued release, so another click can now begin safely.
        this.gazeCommitPendingRelease = undefined;
      }
    });
  }

  private gazeCommitSourceIsActive(): boolean {
    const active = this.gazeCommitActive;
    if (!active || this.xrDevice.primaryInputMode !== active.mode) {
      return false;
    }
    const input =
      active.mode === 'hand'
        ? this.xrDevice.hands[active.handedness]
        : this.xrDevice.controllers[active.handedness];
    return Boolean(input?.connected);
  }

  private moveCommitInput(deltaX: number, deltaY: number): void {
    const active = this.gazeCommitActive;
    if (!active) return;
    const handle = this.transformHandles.get(active.handedness);
    if (!handle) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const depth = Math.max(0.25, Math.abs(handle.position.z));
    const worldUnitsPerPixel =
      (2 * Math.tan(this.xrDevice.fovy / 2) * depth) / Math.max(rect.height, 1);
    handle.position.x += deltaX * worldUnitsPerPixel;
    handle.position.y -= deltaY * worldUnitsPerPixel;
    this.syncDeviceTransforms();
  }

  private moveCommitInputDepth(deltaY: number): void {
    const active = this.gazeCommitActive;
    if (!active) return;
    const handle = this.transformHandles.get(active.handedness);
    if (!handle) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const depth = Math.max(0.25, Math.abs(handle.position.z));
    const worldUnitsPerPixel =
      (2 * Math.tan(this.xrDevice.fovy / 2) * depth) / Math.max(rect.height, 1);
    handle.position.z -= deltaY * worldUnitsPerPixel * 0.5;
    this.syncDeviceTransforms();
  }

  private gazePointerDownHandler(event: PointerEvent): void {
    if (this.gazePointerId !== null) return;
    if (!this.gazeInteractionEnabled()) return;
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    this.gazePointerId = event.pointerId;
    this.gazeLastPointer = { x: event.clientX, y: event.clientY };
    this.renderer.domElement.setPointerCapture?.(event.pointerId);

    if (event.button === 0) {
      this.updateGazeFromPointer(event.clientX, event.clientY);
      this.beginGazeCommit();
    } else {
      this.gazeHeadsetDragActive = true;
    }
  }

  private gazePointerMoveHandler(event: PointerEvent): void {
    if (this.gazePointerId !== null && this.gazePointerId !== event.pointerId)
      return;
    const deltaX = event.clientX - this.gazeLastPointer.x;
    const deltaY = event.clientY - this.gazeLastPointer.y;
    this.gazeLastPointer = { x: event.clientX, y: event.clientY };
    if (!this.gazeInteractionEnabled()) return;

    if (this.gazeCommitActive) {
      event.preventDefault();
      this.moveCommitInput(deltaX, deltaY);
      return;
    }
    if (this.gazeHeadsetDragActive) {
      event.preventDefault();
      this.playerRig.rotation.y -= deltaX * 0.002;
      this.cameraRig.rotation.x -= deltaY * 0.002;
      this.xrDevice.quaternion.copy(
        this.cameraRig.getWorldQuaternion(this.quatMouse) as any,
      );
      return;
    }
    this.updateGazeFromPointer(event.clientX, event.clientY);
  }

  private gazePointerUpHandler(event: PointerEvent): void {
    if (this.gazePointerId !== event.pointerId) return;
    if (this.gazeCommitActive) {
      this.releaseGazeCommit(false);
    }
    this.gazeHeadsetDragActive = false;
    this.gazePointerId = null;
    if (this.renderer.domElement.hasPointerCapture?.(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture?.(event.pointerId);
    }
  }

  private gazeWheelHandler(event: WheelEvent): void {
    if (!this.gazeInteractionEnabled() || !this.gazeCommitActive) return;
    event.preventDefault();
    event.stopPropagation();
    this.moveCommitInputDepth(event.deltaY);
  }

  private gazeContextMenuHandler(event: MouseEvent): void {
    if (this.gazeMode === 'cursor') {
      event.preventDefault();
    }
  }

  private resetInputTransform(handedness: Handedness): void {
    const transformHandle = this.transformHandles.get(handedness);
    if (!transformHandle) return;
    transformHandle.position.fromArray(
      transformHandle.userData.defaultPosition,
    );
    transformHandle.quaternion.fromArray(
      transformHandle.userData.defaultQuaternion,
    );
    this.syncDeviceTransforms();
  }

  keyDownHandler(event: KeyboardEvent) {
    const { keyState } = this;

    if (event.code in keyState) {
      keyState[event.code] = true;
    }

    if (this.isInProgrammaticMode) return;

    if (this.gazeMode === 'cursor' && event.code === 'Space') {
      const eventTargetsControl = event.composedPath().some((target) => {
        if (typeof target !== 'object' || target === null) return false;
        const element = target as {
          isContentEditable?: boolean;
          tagName?: unknown;
        };
        return (
          element.isContentEditable === true ||
          (typeof element.tagName === 'string' &&
            ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(
              element.tagName,
            ))
        );
      });
      if (eventTargetsControl) return;
      event.preventDefault();
      this.resetInputTransform(this.gazeCommitHand);
      return;
    }

    if (keyState.ShiftLeft && keyState.ArrowUp) {
      this.cameraRig.position.y += 0.05;
    }

    if (keyState.ShiftLeft && keyState.ArrowDown) {
      this.cameraRig.position.y -= 0.05;
    }
  }

  keyUpHandler(event: KeyboardEvent) {
    const { keyState } = this;

    if (event.code in keyState) {
      keyState[event.code] = false;
    }
  }

  movePlayerRig(delta: number) {
    const { playerRig, keyState, vec3 } = this;
    vec3.set(
      (keyState.KeyD ? 1 : 0) - (keyState.KeyA ? 1 : 0),
      0,
      (keyState.KeyS ? 1 : 0) - (keyState.KeyW ? 1 : 0),
    );
    if (vec3.lengthSq() > 0 && keyState.ShiftLeft) {
      vec3
        .normalize()
        .multiplyScalar(FREE_MOVEMENT_SPEED * delta)
        .applyQuaternion(playerRig.quaternion);
      playerRig.position.add(vec3);
    }
  }

  resetDeviceTransforms() {
    const { playerRig, cameraRig, transformHandles } = this;
    cameraRig.position.copy(this.headsetDefaultPosition);
    cameraRig.quaternion.copy(this.headsetDefaultQuaternion);
    playerRig.position.set(0, 0, 0);
    playerRig.quaternion.set(0, 0, 0, 1);
    transformHandles.forEach((transformHandle) => {
      transformHandle.position.fromArray(
        transformHandle.userData.defaultPosition,
      );
      transformHandle.quaternion.fromArray(
        transformHandle.userData.defaultQuaternion,
      );
    });
  }

  captureDefaultPose(): DefaultPose {
    const headsetPosition = this.cameraRig
      .getWorldPosition(this.vec3)
      .toArray();
    const headsetQuaternion = this.cameraRig
      .getWorldQuaternion(this.quat)
      .toArray();
    const controllers: Partial<Record<Handedness, PoseTransform>> = {};
    const hands: Partial<Record<Handedness, PoseTransform>> = {};
    this.transformHandles.forEach((transformHandle, handedness) => {
      const position = transformHandle
        .getWorldPosition(this.vec3)
        .toArray() as [number, number, number];
      const quaternion = transformHandle
        .getWorldQuaternion(this.quat)
        .toArray() as [number, number, number, number];
      const pose = {
        position,
        quaternion,
      };
      controllers[handedness] = pose;
      hands[handedness] = {
        position: [...position],
        quaternion: [...quaternion],
      };
    });
    return {
      headset: {
        position: headsetPosition,
        quaternion: headsetQuaternion,
      },
      controllers,
      hands,
    };
  }

  applyDefaultPose(defaultPose: DefaultPose) {
    const { headset, controllers, hands } = defaultPose;
    this.headsetDefaultPosition.fromArray(headset.position);
    this.headsetDefaultQuaternion.fromArray(headset.quaternion);
    this.quatInv.copy(this.headsetDefaultQuaternion).invert();
    this.transformHandles.forEach((transformHandle, handedness) => {
      const inputPose = controllers?.[handedness] ?? hands?.[handedness];
      if (!inputPose) return;
      this.vec3
        .fromArray(inputPose.position)
        .sub(this.headsetDefaultPosition)
        .applyQuaternion(this.quatInv);
      this.quat.fromArray(inputPose.quaternion).premultiply(this.quatInv);
      transformHandle.userData.defaultPosition = this.vec3.toArray();
      transformHandle.userData.defaultQuaternion = this.quat.toArray();
    });
    this.resetDeviceTransforms();
    // Keep the combined camera position in sync with the restored headset pose,
    // otherwise the next non-pointer-locked render frame overwrites cameraRig.y
    // (and playerRig x/z) with the stale construction-time camera position,
    // reverting the saved headset height.
    this.combinedCameraPosition.copy(this.headsetDefaultPosition);
  }

  syncDeviceTransforms() {
    const { xrDevice, cameraRig, transformHandles } = this;
    xrDevice.position.copy(cameraRig.getWorldPosition(this.vec3) as any);
    xrDevice.quaternion.copy(cameraRig.getWorldQuaternion(this.quat) as any);
    transformHandles.forEach((transformHandle, handedness) => {
      const emulatedInput =
        xrDevice.primaryInputMode === 'controller'
          ? xrDevice.controllers[handedness]!
          : xrDevice.hands[handedness]!;
      emulatedInput.position.copy(
        transformHandle.getWorldPosition(this.vec3) as any,
      );
      emulatedInput.quaternion.copy(
        transformHandle.getWorldQuaternion(this.quat) as any,
      );
    });
  }

  /**
   * Sync DevUI's local transforms FROM the device's global transforms.
   * This is the reverse of syncDeviceTransforms() - used when device
   * is controlled programmatically and we need to follow its state.
   */
  syncFromDevice() {
    const { xrDevice, playerRig, cameraRig, transformHandles } = this;
    this.syncGazeModeFromDevice();

    // Get headset world position and rotation from device
    const headsetPos = xrDevice.position;
    const headsetQuat = xrDevice.quaternion;

    // Update combined camera position
    this.combinedCameraPosition.set(headsetPos.x, headsetPos.y, headsetPos.z);

    // Decompose quaternion into Euler angles (YXZ order for gimbal)
    // Y = yaw (playerRig), pitch+roll preserved on cameraRig
    this.quatB.set(headsetQuat.x, headsetQuat.y, headsetQuat.z, headsetQuat.w);
    this.euler.setFromQuaternion(this.quatB, 'YXZ');

    // Set playerRig position (x/z) and yaw
    playerRig.position.set(headsetPos.x, 0, headsetPos.z);
    playerRig.rotation.set(0, this.euler.y, 0);

    // Set cameraRig position (y) and full local rotation (preserving roll)
    // cameraRig local quat = inv(playerRig yaw quat) * headset world quat
    cameraRig.position.set(0, headsetPos.y, 0);
    this.quat.setFromEuler(this.euler.set(0, this.euler.y, 0, 'YXZ'));
    cameraRig.quaternion.multiplyQuaternions(this.quat.invert(), this.quatB);

    // Force Three.js to update world matrices
    playerRig.updateMatrixWorld(true);

    // cameraRig world quaternion inverse is constant across the loop, so
    // compute it once into a distinct scratch (quatInv) to avoid recomputing
    // and to avoid clobbering this.quat used above.
    cameraRig.getWorldQuaternion(this.quatInv).invert();

    // Sync controller/hand transforms
    transformHandles.forEach((transformHandle, handedness) => {
      const emulatedInput =
        xrDevice.primaryInputMode === 'controller'
          ? xrDevice.controllers[handedness]!
          : xrDevice.hands[handedness]!;

      // Convert world position to cameraRig local position
      const worldPos = this.vec3.set(
        emulatedInput.position.x,
        emulatedInput.position.y,
        emulatedInput.position.z,
      );
      cameraRig.worldToLocal(worldPos);
      transformHandle.position.copy(worldPos);

      // Convert world quaternion to cameraRig local quaternion
      this.quatB.set(
        emulatedInput.quaternion.x,
        emulatedInput.quaternion.y,
        emulatedInput.quaternion.z,
        emulatedInput.quaternion.w,
      );
      this.quatB.premultiply(this.quatInv);
      transformHandle.quaternion.copy(this.quatB);
    });
  }

  private syncGazeModeFromDevice(): void {
    const nextGazeMode: GazeMode = this.xrDevice.gaze?.connected
      ? 'head-locked'
      : 'off';
    if (nextGazeMode === this.gazeMode) return;

    this.releaseGazeCommit(true);
    this.gazeHeadsetDragActive = false;
    // Preserve the quaternion supplied by remote control. This path updates
    // only DevUI state and presentation, never device gaze state.
    this.applyGazeModePresentation(nextGazeMode);
  }

  /**
   * Enable or disable user interactions (pointer lock, keyboard controls).
   * When disabled, the DevUI still renders but doesn't respond to user input.
   */
  setInteractionsEnabled(enabled: boolean) {
    this.interactionsEnabled = enabled;
    if (!enabled) {
      this.releaseGazeCommit(true);
      this.gazeHeadsetDragActive = false;
    }
    if (!enabled && this.isPointerLocked) {
      document.exitPointerLock();
    }
  }

  renderScene(time: number) {
    if (
      this.gazeCommitActive &&
      (!this.gazeInteractionEnabled() || !this.gazeCommitSourceIsActive())
    ) {
      this.releaseGazeCommit(true);
      this.gazeHeadsetDragActive = false;
    }
    this.schedulePendingGazeRelease();
    const xrDeviceFOV = (this.xrDevice.fovy / Math.PI) * 180;
    let cameraMatrixNeedsUpdate = false;
    if (this.camera.fov !== xrDeviceFOV) {
      this.camera.fov = xrDeviceFOV;
      cameraMatrixNeedsUpdate = true;
    }
    const iwerCanvasDimension = this.xrDevice.canvasDimensions;
    if (iwerCanvasDimension) {
      const canvas = this.renderer.domElement;
      const resizeNeeded =
        canvas.width !== iwerCanvasDimension.width ||
        canvas.height !== iwerCanvasDimension.height;
      if (resizeNeeded) {
        this.camera.aspect =
          iwerCanvasDimension.width / iwerCanvasDimension.height;
        this.renderer.setSize(
          iwerCanvasDimension.width,
          iwerCanvasDimension.height,
        );
        cameraMatrixNeedsUpdate = true;
      }
    }
    if (cameraMatrixNeedsUpdate) {
      this.camera.updateProjectionMatrix();
    }
    if (!this.isInProgrammaticMode) {
      if (!this.isPointerLocked) {
        this.cameraRig.position.y = this.combinedCameraPosition.y;
        this.playerRig.position.x = this.combinedCameraPosition.x;
        this.playerRig.position.z = this.combinedCameraPosition.z;
      } else {
        this.cameraRig.getWorldPosition(this.combinedCameraPosition);
      }
    }
    if (this.gazeMode !== 'cursor') {
      this.forwardHtmlEvents();
    }
    this.transformHandles.forEach((transformHandle, handedness) => {
      const emulatedInput =
        this.xrDevice.primaryInputMode === 'controller'
          ? this.xrDevice.controllers[handedness]
          : this.xrDevice.hands[handedness];
      const connected = Boolean(emulatedInput?.connected);
      transformHandle.visible =
        connected &&
        !this.isPointerLocked &&
        !this.isInProgrammaticMode &&
        this.gazeMode !== 'cursor';
      if (connected) {
        transformHandle.update(time, this.camera);
      }
    });
    const delta = Math.min((time - this.lastTime) / 1000, 0.1);

    // Only process user input and sync TO device in manual mode
    // In programmatic mode, the device controls us (via syncFromDevice)
    if (!this.isInProgrammaticMode) {
      this.movePlayerRig(delta);
      this.syncDeviceTransforms();
    }

    this.renderer.render(this.scene, this.camera);
    this.lastTime = time;
  }

  get domElement() {
    return this.renderer.domElement;
  }

  dispose() {
    this.releaseGazeCommit(true);
    this.setTransformHandleRoutingSuppressed(false);
    this.renderer.dispose();
    document.removeEventListener(
      'pointerlockchange',
      this.pointerLockChangeHandlerBound,
      false,
    );
    document.removeEventListener(
      'mozpointerlockchange',
      this.pointerLockChangeHandlerBound,
      false,
    );
    document.removeEventListener(
      'webkitpointerlockchange',
      this.pointerLockChangeHandlerBound,
      false,
    );
    document.removeEventListener('mousemove', this.mouseMoveHandler, false);
    document.removeEventListener('keydown', this.keyDownHandlerBound, false);
    document.removeEventListener('keyup', this.keyUpHandlerBound, false);
    this.renderer.domElement.removeEventListener(
      'pointerdown',
      this.gazePointerDownHandlerBound,
    );
    this.renderer.domElement.removeEventListener(
      'pointermove',
      this.gazePointerMoveHandlerBound,
    );
    this.renderer.domElement.removeEventListener(
      'pointerup',
      this.gazePointerUpHandlerBound,
    );
    this.renderer.domElement.removeEventListener(
      'pointercancel',
      this.gazePointerUpHandlerBound,
    );
    this.renderer.domElement.removeEventListener(
      'wheel',
      this.gazeWheelHandlerBound,
    );
    this.renderer.domElement.removeEventListener(
      'contextmenu',
      this.gazeContextMenuHandlerBound,
    );
    window.removeEventListener('blur', this.windowBlurHandlerBound);
    document.removeEventListener(
      'visibilitychange',
      this.documentVisibilityHandlerBound,
    );
  }
}
