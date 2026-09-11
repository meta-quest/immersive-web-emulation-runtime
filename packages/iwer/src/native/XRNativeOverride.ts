/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import type {
  ActionPlayer,
  ActionPlayerEventContext,
} from '../action/ActionPlayer.js';
import type { XRDevice, XRGlobalObject } from '../device/XRDevice.js';
import type { XRTrackedInput } from '../device/XRTrackedInput.js';
import { GamepadButton } from '../gamepad/Gamepad.js';
import { XRHandJoint as IwerHandJoint } from '../input/XRHand.js';
import type { XRInputSource as IwerInputSource } from '../input/XRInputSource.js';
import {
  P_ACTION_PLAYER,
  P_DEVICE,
  P_GAMEPAD,
  P_JOINT_SPACE,
  P_SPACE,
} from '../private.js';
import type { XRJointSpace as IwerJointSpace } from '../spaces/XRJointSpace.js';
import { XRSpaceUtils, type XRSpace as IwerSpace } from '../spaces/XRSpace.js';
import type { XRRuntimeAdapter } from '../types/runtime-session.js';
import { PatchRegistry } from '../utils/PatchRegistry.js';
import type {
  NativeOverrideCapabilities,
  NativeOverrideEnvironment,
  NativeOverrideHandle,
  NativeOverrideOptions,
  NativeOverrideSupport,
  NativeSessionInfo,
} from './types.js';

type NativeRequestSession = (
  this: XRSystem,
  mode: XRSessionMode,
  options?: XRSessionInit,
) => Promise<XRSession>;

type NativeGetPose = (
  this: XRFrame,
  space: XRSpace,
  baseSpace: XRSpace,
) => XRPose | null | undefined;

type NativeGetViewerPose = (
  this: XRFrame,
  referenceSpace: XRReferenceSpace,
) => XRViewerPose | null | undefined;

type NativeGetJointPose = (
  this: XRFrame,
  joint: XRJointSpace,
  baseSpace: XRSpace,
) => XRJointPose | null | undefined;

type NativeFillPoses = (
  this: XRFrame,
  spaces: Iterable<XRSpace>,
  baseSpace: XRSpace,
  transforms: Float32Array,
) => boolean;

type NativeFillJointRadii = (
  this: XRFrame,
  jointSpaces: Iterable<XRJointSpace>,
  radii: Float32Array,
) => boolean;

type NativeRequestHitTestSource = (
  this: XRSession,
  options: XRHitTestOptionsInit,
) => Promise<XRHitTestSource> | undefined;

type NativeGetHitTestResults = (
  this: XRFrame,
  hitTestSource: XRHitTestSource,
) => XRHitTestResult[];

type NativeCreateAnchor = (
  this: XRFrame,
  pose: XRRigidTransform,
  space: XRSpace,
) => Promise<XRAnchor>;

type NativeRigidTransformConstructor = new (
  position?: DOMPointInit,
  orientation?: DOMPointInit,
) => XRRigidTransform;

type InputEventName =
  | 'select'
  | 'selectstart'
  | 'selectend'
  | 'squeeze'
  | 'squeezestart'
  | 'squeezeend';

type InputBindingKind = 'controller' | 'hand' | 'playback';

/**
 * Result of attempting to wrap an optional native XRFrame method.
 * `unavailable` means the browser does not implement the method at all, which
 * is not a degradation; `failed` means it exists but could not be intercepted.
 */
type PatchOutcome = 'patched' | 'unavailable' | 'failed';

/** The primary/primary-squeeze action families WebXR dispatches events for. */
type InputActionTrigger = 'select' | 'squeeze';

/**
 * An input event that has been decided but not yet dispatched, because a
 * session may only stamp events with an XRFrame it currently owns. Queued
 * events are drained inside that session's own animation frame callback.
 */
interface QueuedInputEvent {
  type: InputEventName;
  inputSource: XRInputSource;
}

interface JointBinding {
  name: string;
  /** Stable XRJointSpace-shaped object handed to the application. */
  space: XRSpace;
  /** Live IWER joint space that carries the pose and radius. */
  source: IwerJointSpace;
}

interface ControlledSpace {
  adapter: NativeSessionAdapter;
  /**
   * Resolves the live IWER space whose global transform is this space's origin.
   * Omitted for the adapter anchor space itself, which is the origin. A
   * resolver returning null means the source is no longer available, which is
   * reported to the application as an unresolvable (null) pose.
   */
  origin?: () => IwerSpace | null;
  /** Transform from this space to its origin space. */
  localOffset: mat4;
  /** Present when this space is a hand joint. */
  joint?: JointBinding;
}

interface TransformOverride {
  epoch: number;
  transform: XRRigidTransform;
}

interface InputBinding {
  kind: InputBindingKind;
  /** Live IWER input source that carries pose, gamepad, and hand state. */
  iwerSource: IwerInputSource;
  /** Present for device-backed controllers and hands. */
  trackedInput?: XRTrackedInput;
  inputSource: XRInputSource;
  targetRaySpace: XRSpace;
  gripSpace?: XRSpace;
  joints: JointBinding[];
  eventButtons: GamepadButton[];
  previousButtonValues: Map<GamepadButton, number>;
  activeButtons: Set<GamepadButton>;
  /**
   * Actions the application has actually been told about: a start event was
   * delivered and its end event was not. Maintained at dispatch time, so an
   * event that is only queued never counts, and it is exactly the set that
   * needs terminating when the source disappears.
   */
  activeActions: Set<InputActionTrigger>;
  /**
   * Actions the recording has started, whether or not their start event has
   * been delivered yet. Used only to pair a recorded end with its start.
   */
  pendingActions: Set<InputActionTrigger>;
}

interface HitTestBinding {
  adapter: NativeSessionAdapter;
  facade: XRHitTestSource;
  /** The IWER-controlled space the application subscribed against. */
  space: XRSpace;
  /** Defensive copy of the caller's dictionary, reused for every resubscribe. */
  requestedOptions: XRHitTestOptionsInit;
  nativeMethod: NativeRequestHitTestSource;
  /**
   * Native subscription currently backing the facade. It keeps serving results
   * while a replacement is in flight, and survives a failed replacement.
   */
  current: XRHitTestSource | null;
  /** Anchor-relative pose the current subscription was created from. */
  currentMatrix: mat4 | null;
  /** Anchor-relative pose of the in-flight replacement, if any. */
  pendingMatrix: mat4 | null;
  pendingToken: number;
  /** Consecutive failed replacements, used only to size the retry backoff. */
  failures: number;
  /** Frames still to skip before the next replacement attempt. */
  backoffFrames: number;
  cancelled: boolean;
}

/**
 * The mutable mirror of the public capability type. Deriving it keeps the two
 * from drifting: a new public flag fails to compile until it is both cleared
 * in clearedCapabilities() and set somewhere in the implementation.
 */
type CapabilityState = Omit<
  {
    -readonly [K in keyof NativeOverrideCapabilities]: NativeOverrideCapabilities[K];
  },
  'notes'
> & { notes: string[] };

type ResettableCapabilities = Omit<
  CapabilityState,
  'phase' | 'supported' | 'notes'
>;

function clearedCapabilities(): ResettableCapabilities {
  return {
    requestSession: false,
    inputSources: false,
    inputEvents: false,
    brandedInputEvents: false,
    viewerSpaceTagging: false,
    poseOverride: false,
    batchPoses: false,
    viewerPose: false,
    viewTransforms: false,
    handInput: false,
    jointPoses: false,
    actionPlayback: false,
    anchors: false,
    hitTest: false,
  };
}

interface NativeSessionAdapter {
  session: XRSession;
  mode: 'immersive-vr' | 'immersive-ar';
  anchorSpace: XRReferenceSpace;
  handTracking: boolean;
  nativeRequestAnimationFrame: XRSession['requestAnimationFrame'];
  nativeRequestReferenceSpace: XRSession['requestReferenceSpace'];
  patches: PatchRegistry;
  instancePatches: PatchRegistry;
  cleanupListeners: Array<() => void>;
  sources: readonly XRInputSource[];
  deviceBindings: InputBinding[];
  playbackBindings: Map<IwerInputSource, InputBinding>;
  bindingByFacade: Map<XRInputSource, InputBinding>;
  spaceTokens: Set<XRSpace>;
  hitTests: Set<HitTestBinding>;
  baseSpaceCache: Map<XRSpace, mat4 | null>;
  lastFrameTime: number | undefined;
  /**
   * The XRFrame this session currently owns, or null. Non-null only for the
   * duration of an animation frame callback: WebXR forbids using an XRFrame
   * once its callback has returned, so anything that needs to hand a frame to
   * the application must either run inside this window or be queued for it.
   */
  activeFrame: XRFrame | null;
  /**
   * True once XRSession.requestAnimationFrame was successfully wrapped. Without
   * that wrapper the override never learns when a frame callback starts or
   * ends, so it cannot judge whether a frame is still active.
   */
  framesInstrumented: boolean;
  /** Input events waiting for an animation frame callback on this session. */
  pendingEvents: QueuedInputEvent[];
  /**
   * Facades that must stay in `sources` until their queued events drain, so a
   * recording's edges are never delivered for an unpublished input source.
   */
  retainedSources: Set<XRInputSource>;
  /** Whether the current frame supports controlled-space anchor translation. */
  createAnchorAvailable: boolean;
  /** Whether the current frame supports controlled-space hit-test facades. */
  hitTestResultsAvailable: boolean;
  ended: boolean;
}

const NATIVE_OVERRIDE_KEY = Symbol.for('@iwer/native-override');
const INPUT_EVENT_NAMES: readonly InputEventName[] = [
  'select',
  'selectstart',
  'selectend',
  'squeeze',
  'squeezestart',
  'squeezeend',
];
const HAND_TRACKING_FEATURE = 'hand-tracking';
/** Upper bound on the exponential backoff between failed subscription swaps. */
const MAX_HIT_TEST_BACKOFF_FRAMES = 32;
/**
 * Motion a hit test subscription tolerates before it is resubscribed. Real
 * tracking jitter is far above float epsilon, so an exact comparison would
 * resubscribe on every frame and never settle.
 */
const HIT_TEST_TRANSLATION_TOLERANCE_M = 0.005;
const HIT_TEST_ROTATION_TOLERANCE_RAD = Math.PI / 180;
/**
 * Soft bound for queued input events. Only complete queued action lifecycles
 * are discarded, so backpressure can never manufacture an orphaned start/end.
 */
const MAX_PENDING_EVENTS = 256;

const scratchViewerMatrix = mat4.create();
const scratchTargetMatrix = mat4.create();
const scratchAnchorToBase = mat4.create();
const scratchBaseToAnchor = mat4.create();
const scratchRelativeView = mat4.create();
const scratchResultMatrix = mat4.create();
const scratchControlledMatrix = mat4.create();
const scratchHitTestMatrix = mat4.create();
const scratchPosition = vec3.create();
const scratchOrientation = quat.create();
const scratchRadius = new Float32Array(1);

function findPropertyOwner(target: object, key: PropertyKey): object | null {
  let current: object | null = target;
  while (current) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      return current;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
}

function installedOverride(xr: XRSystem): NativeOverrideHandle | null {
  try {
    const direct = Reflect.get(xr as object, NATIVE_OVERRIDE_KEY);
    const requestSession = Reflect.get(xr as object, 'requestSession');
    const candidate =
      direct ??
      (typeof requestSession === 'function'
        ? Reflect.get(requestSession, NATIVE_OVERRIDE_KEY)
        : null);
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as NativeOverrideHandle).installed === 'boolean' &&
      typeof (candidate as NativeOverrideHandle).uninstall === 'function'
    ) {
      return candidate as NativeOverrideHandle;
    }
  } catch {
    // Ignore hostile or cross-realm host-object accessors.
  }
  return null;
}

function methodDescriptor(
  target: object,
  key: PropertyKey,
): { owner: object; descriptor: PropertyDescriptor } | null {
  const owner = findPropertyOwner(target, key);
  const descriptor = owner
    ? Object.getOwnPropertyDescriptor(owner, key)
    : undefined;
  return owner && descriptor ? { owner, descriptor } : null;
}

function matrixFromTransform(transform: XRRigidTransform): mat4 {
  const output = mat4.create();
  for (let index = 0; index < 16; index++) {
    output[index] = transform.matrix[index];
  }
  return output;
}

function copyMatrixToArray(
  matrix: mat4,
  output: Float32Array,
  offset: number,
): void {
  for (let index = 0; index < 16; index++) {
    output[offset + index] = matrix[index];
  }
}

const toleranceLeftPosition = vec3.create();
const toleranceRightPosition = vec3.create();
const toleranceLeftRotation = quat.create();
const toleranceRightRotation = quat.create();

/**
 * Reports whether two anchor-relative poses are close enough that resubscribing
 * a native hit test source would be wasted work.
 */
function poseWithinTolerance(left: mat4, right: mat4): boolean {
  mat4.getTranslation(toleranceLeftPosition, left);
  mat4.getTranslation(toleranceRightPosition, right);
  if (
    vec3.squaredDistance(toleranceLeftPosition, toleranceRightPosition) >
    HIT_TEST_TRANSLATION_TOLERANCE_M * HIT_TEST_TRANSLATION_TOLERANCE_M
  ) {
    return false;
  }
  mat4.getRotation(toleranceLeftRotation, left);
  mat4.getRotation(toleranceRightRotation, right);
  // |dot| maps to cos(theta/2); compare against the half-angle tolerance.
  const dot = Math.abs(quat.dot(toleranceLeftRotation, toleranceRightRotation));
  return Math.min(dot, 1) >= Math.cos(HIT_TEST_ROTATION_TOLERANCE_RAD / 2);
}

/**
 * WebXR Hand Input treats an absent or non-positive radius as "not tracked":
 * fillJointRadii reports NaN and getJointPose reports a null pose.
 */
function isTrackedRadius(radius: number): boolean {
  return Number.isFinite(radius) && radius > 0;
}

function invalidState(message: string): DOMException {
  return new DOMException(message, 'InvalidStateError');
}

function isImmersiveMode(
  mode: XRSessionMode,
): mode is 'immersive-vr' | 'immersive-ar' {
  return mode === 'immersive-vr' || mode === 'immersive-ar';
}

function propertyCanBePatched(target: object, key: PropertyKey): boolean {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  if (ownDescriptor) {
    return ownDescriptor.configurable || ownDescriptor.writable === true;
  }
  if (Object.isExtensible(target)) {
    return true;
  }
  const inherited = methodDescriptor(Object.getPrototypeOf(target), key);
  return Boolean(
    inherited &&
    (inherited.descriptor.configurable ||
      inherited.descriptor.writable === true),
  );
}

function globalRecord(globalObject: XRGlobalObject): Record<string, unknown> {
  return globalObject as unknown as Record<string, unknown>;
}

function eventConstructor(
  globalObject: XRGlobalObject,
): typeof Event | undefined {
  const candidate = globalRecord(globalObject).Event;
  return typeof candidate === 'function'
    ? (candidate as typeof Event)
    : undefined;
}

function resolveXRSystem(
  environment: NativeOverrideEnvironment,
): XRSystem | undefined {
  const globalObject = environment.globalObject ?? globalThis;
  return (
    environment.xrSystem ??
    ((globalRecord(globalObject).navigator as Navigator | undefined)?.xr as
      | XRSystem
      | undefined)
  );
}

/**
 * Reports whether the minimum native hooks required by XRNativeOverride appear
 * to be available. Host-object patching can still fail at runtime, so install()
 * records the authoritative result in its capabilities object.
 */
export function getNativeOverrideSupport(
  environment: NativeOverrideEnvironment = {},
): NativeOverrideSupport {
  const globalObject = environment.globalObject ?? globalThis;
  const xr = resolveXRSystem(environment);
  const notes: string[] = [];
  const requestSession = Boolean(
    xr &&
    typeof xr.requestSession === 'function' &&
    propertyCanBePatched(xr, 'requestSession'),
  );
  if (!xr) {
    notes.push('navigator.xr is unavailable.');
  } else if (!requestSession) {
    notes.push('The native XRSystem.requestSession method cannot be patched.');
  }
  if (typeof globalRecord(globalObject).XRRigidTransform !== 'function') {
    notes.push('The native XRRigidTransform constructor is unavailable.');
  }
  return {
    supported:
      requestSession &&
      typeof globalRecord(globalObject).XRRigidTransform === 'function',
    requestSession,
    notes,
  };
}

/**
 * Returns the installed override without relying on instanceof, so callers
 * can recover a handle installed by another IWER bundle or a prior HMR pass.
 */
export function getNativeOverride(
  environment: NativeOverrideEnvironment = {},
): NativeOverrideHandle | null {
  const xr = resolveXRSystem(environment);
  return xr ? installedOverride(xr) : null;
}

/**
 * Selectively overrides native WebXR tracking and input while preserving the
 * browser-owned XRSession, compositor, layers, frame cadence, and projections.
 *
 * Prefer installNativeOverride() for installation; direct construction is the
 * low-level path when installation must be deferred or retried.
 */
export class XRNativeOverride implements NativeOverrideHandle {
  readonly device: XRDevice;

  private readonly options: Required<
    Pick<NativeOverrideOptions, 'onUnsupported'>
  > &
    Omit<NativeOverrideOptions, 'onUnsupported'>;
  private xrSystem: XRSystem | undefined;
  private readonly globalObject: XRGlobalObject;
  private readonly patches = new PatchRegistry();
  private sessionsByObject = new WeakMap<XRSession, NativeSessionAdapter>();
  private readonly liveSessions = new Set<NativeSessionAdapter>();
  private frameSessions = new WeakMap<XRFrame, NativeSessionAdapter>();
  private spaces = new WeakMap<XRSpace, ControlledSpace>();
  private hitTestBindings = new WeakMap<XRHitTestSource, HitTestBinding>();
  private syntheticEvents = new WeakSet<Event>();
  private patchedFrameOwners = new WeakSet<object>();
  private patchedViewerFrameOwners = new WeakSet<object>();
  private patchedFillPosesOwners = new WeakSet<object>();
  private patchedJointPoseOwners = new WeakSet<object>();
  private patchedJointRadiiOwners = new WeakSet<object>();
  private patchedReferenceSpaceOwners = new WeakSet<object>();
  private patchedInputSourceOwners = new WeakSet<object>();
  private patchedRafOwners = new WeakSet<object>();
  private patchedRequestReferenceSpaceOwners = new WeakSet<object>();
  private patchedHitTestOwners = new WeakSet<object>();
  private patchedHitTestResultOwners = new WeakSet<object>();
  private patchedCreateAnchorOwners = new WeakSet<object>();
  private instancePatchedReferenceSpaces = new WeakSet<XRReferenceSpace>();
  private rawGetPoseByOwner = new WeakMap<object, NativeGetPose>();
  private rawGetPoseByFrame = new WeakMap<XRFrame, NativeGetPose>();
  private rawRafByOwner = new WeakMap<
    object,
    XRSession['requestAnimationFrame']
  >();
  private rawRequestReferenceSpaceByOwner = new WeakMap<
    object,
    XRSession['requestReferenceSpace']
  >();
  private rawTransformGetters = new WeakMap<
    object,
    (this: object) => XRRigidTransform
  >();
  private transformReaders = new WeakMap<object, () => XRRigidTransform>();
  private transformOverrides = new WeakMap<object, TransformOverride>();
  private patchedTransformOwners = new WeakSet<object>();
  private instancePatchedFrameEpochs = new WeakMap<XRFrame, number>();
  private instancePatchedTransformEpochs = new WeakMap<object, number>();
  private readonly warned = new Set<string>();
  private readonly capabilityState: CapabilityState;

  private installedState = false;
  private primarySession: NativeSessionAdapter | null = null;
  private previousRuntime: XRRuntimeAdapter | null = null;
  private epoch = 0;
  private lastEpochTime: number | undefined;
  /** Timestamp of the last frame that advanced shared device/playback state. */
  private lastPrimaryTime: number | undefined;
  private wiredPlayer: ActionPlayer | null = null;
  private previousPlayerContext: ActionPlayerEventContext | undefined;
  /**
   * Set while a native frame samples a recording. It keeps the final sampled
   * frame observable to the application even though ActionPlayer.playFrame()
   * clears `playing` as it clamps to the end of the recording.
   */
  private playbackFrame: ActionPlayer | null = null;
  /**
   * Handed to ActionPlayer when no session owns an active frame, so an
   * application-driven stepFrames()/playFrame() still runs the player's edge
   * detection. The override re-stamps every relayed event with a real frame
   * when it drains, so this token never reaches the application.
   */
  private readonly detachedPlaybackFrame = {} as XRFrame;
  constructor(device: XRDevice, options: NativeOverrideOptions = {}) {
    this.device = device;
    this.options = {
      ...options,
      onUnsupported: options.onUnsupported ?? 'warn',
    };
    this.globalObject = options.globalObject ?? globalThis;
    this.xrSystem = resolveXRSystem(options);
    const support = getNativeOverrideSupport({
      xrSystem: this.xrSystem,
      globalObject: this.globalObject,
    });
    this.capabilityState = {
      phase: 'uninstalled',
      supported: support.supported,
      ...clearedCapabilities(),
      notes: [...support.notes],
    };
  }

  get installed(): boolean {
    return this.installedState;
  }

  get capabilities(): NativeOverrideCapabilities {
    return {
      ...this.capabilityState,
      notes: [...this.capabilityState.notes],
    };
  }

  get sessions(): readonly NativeSessionInfo[] {
    return Array.from(this.liveSessions, (adapter) => ({
      session: adapter.session,
      mode: adapter.mode,
      primary: adapter === this.primarySession,
      anchorSpace: adapter.anchorSpace,
    }));
  }

  install(): void {
    if (this.installedState) {
      return;
    }
    const xr = resolveXRSystem(this.options);
    this.xrSystem = xr;
    const support = getNativeOverrideSupport({
      xrSystem: xr,
      globalObject: this.globalObject,
    });
    Object.assign(this.capabilityState, {
      phase: 'uninstalled' as const,
      supported: support.supported,
      ...clearedCapabilities(),
      notes: [] as string[],
    });
    this.warned.clear();
    if (!xr || !support.supported) {
      const notes =
        support.notes.length > 0
          ? support.notes
          : ['Native WebXR override prerequisites are unavailable.'];
      this.capabilityState.supported = false;
      for (const note of notes) {
        this.note(note);
      }
      if (this.options.onUnsupported === 'throw') {
        throw new Error(notes.join(' '));
      }
      return;
    }
    if (this.device[P_DEVICE].installedGlobalObject) {
      throw invalidState(
        'Cannot install a native override while the emulated IWER runtime is installed.',
      );
    }
    // Only a structurally valid IWER handle claims the shared marker; malformed
    // or colliding values are ignored rather than permanently wedging install.
    const existing = installedOverride(xr);
    if (existing && existing !== this) {
      throw invalidState(
        'A native IWER override is already installed on this XRSystem.',
      );
    }
    const override = this;
    const nativeRequestSession = xr.requestSession as NativeRequestSession;
    const wrappedRequestSession: NativeRequestSession = async function (
      this: XRSystem,
      mode,
      options,
    ) {
      const session = await nativeRequestSession.call(this, mode, options);
      if (this !== xr || !isImmersiveMode(mode)) {
        return session;
      }
      try {
        await override.attachSession(session, mode);
      } catch (error) {
        override.detachSession(session);
        if (override.options.onUnsupported === 'throw') {
          await session.end().catch(() => {});
          throw error;
        }
        override.note(
          `Native session override was skipped: ${override.errorText(error)}`,
          'session-attach-failed',
        );
      }
      return session;
    };
    // The registered symbol makes the guard visible across independently
    // bundled copies of IWER. Mark the wrapper as well as the host object so
    // the guard still works when an XRSystem refuses new own properties.
    Object.defineProperty(wrappedRequestSession, NATIVE_OVERRIDE_KEY, {
      value: this,
    });
    let patched = this.patches.define(xr as object, 'requestSession', {
      configurable: true,
      writable: true,
      value: wrappedRequestSession,
    });
    if (!patched) {
      const found = methodDescriptor(xr as object, 'requestSession');
      if (found && typeof found.descriptor.value === 'function') {
        const descriptor = found.descriptor;
        patched = this.patches.define(found.owner, 'requestSession', {
          ...descriptor,
          value: wrappedRequestSession,
        });
      }
    }
    if (!patched) {
      this.unsupported('Unable to patch native XRSystem.requestSession.');
      return;
    }

    this.patches.define(xr as object, NATIVE_OVERRIDE_KEY, {
      configurable: true,
      value: this,
    });

    this.previousRuntime = this.device[P_DEVICE].runtime;
    this.device[P_DEVICE].runtime = {
      kind: 'native',
      getSession: () => {
        const adapter = this.primarySession;
        if (!adapter || adapter.ended) {
          return null;
        }
        return {
          mode: adapter.mode,
          enabledFeatures: adapter.session.enabledFeatures ?? [],
          visibilityState: adapter.session.visibilityState,
          originOffsetMatrix: null,
          end: () => adapter.session.end(),
        };
      },
      onActionPlayerCreated: (player) => this.wirePlayer(player),
    };
    this.installedState = true;
    this.capabilityState.phase = 'installed';
    this.capabilityState.requestSession = true;
  }

  uninstall(): void {
    if (!this.installedState) {
      return;
    }
    this.installedState = false;
    for (const adapter of Array.from(this.liveSessions)) {
      this.detachAdapter(adapter, true);
    }
    this.unwirePlayer();
    this.patches.revert();
    if (this.previousRuntime) {
      this.device[P_DEVICE].runtime = this.previousRuntime;
      this.previousRuntime = null;
    }
    this.resetPatchTracking();
    this.lastEpochTime = undefined;
    this.playbackFrame = null;
    this.warned.clear();
    Object.assign(this.capabilityState, {
      phase: 'uninstalled' as const,
      ...clearedCapabilities(),
      notes: [] as string[],
    });
  }

  private async attachSession(
    session: XRSession,
    mode: 'immersive-vr' | 'immersive-ar',
  ): Promise<void> {
    if (!this.installedState || this.sessionsByObject.has(session)) {
      return;
    }
    const nativeRequestReferenceSpace =
      this.captureNativeRequestReferenceSpace(session);
    const nativeRequestAnimationFrame =
      this.captureNativeRequestAnimationFrame(session);
    let anchorSpace: XRReferenceSpace | undefined;
    let anchorType: XRReferenceSpaceType | undefined;
    for (const type of [
      'local-floor',
      'local',
      'unbounded',
    ] as XRReferenceSpaceType[]) {
      try {
        anchorSpace = await nativeRequestReferenceSpace.call(session, type);
        anchorType = type;
        break;
      } catch {
        // Try the next stable, world-locked reference-space type.
      }
    }
    if (!anchorSpace || !anchorType) {
      throw new Error(
        'No native local-floor, local, or unbounded reference space is available.',
      );
    }
    if (anchorType !== 'local-floor') {
      this.note(
        `Native local-floor is unavailable; poses are anchored to "${anchorType}" and are offset by the viewer's initial height.`,
      );
    }
    if (!this.installedState) {
      return;
    }

    const adapter: NativeSessionAdapter = {
      session,
      mode,
      anchorSpace,
      handTracking: this.sessionEnablesHandTracking(session),
      nativeRequestAnimationFrame,
      nativeRequestReferenceSpace,
      patches: new PatchRegistry(),
      instancePatches: new PatchRegistry(),
      cleanupListeners: [],
      sources: Object.freeze([]),
      deviceBindings: [],
      playbackBindings: new Map(),
      bindingByFacade: new Map(),
      spaceTokens: new Set([anchorSpace as XRSpace]),
      hitTests: new Set(),
      baseSpaceCache: new Map(),
      lastFrameTime: undefined,
      activeFrame: null,
      framesInstrumented: false,
      pendingEvents: [],
      retainedSources: new Set(),
      createAnchorAvailable: true,
      hitTestResultsAvailable: true,
      ended: false,
    };
    this.sessionsByObject.set(session, adapter);
    this.liveSessions.add(adapter);
    this.primarySession ??= adapter;
    this.spaces.set(anchorSpace, {
      adapter,
      localOffset: mat4.create(),
    });

    try {
      this.ensureReferenceSpacePatch(anchorSpace, adapter);
      this.createDeviceBindings(adapter);
      const inputSourcesPatched = this.patchInputSources(adapter);
      const rafPatched = this.patchRequestAnimationFrame(adapter);
      adapter.framesInstrumented = rafPatched;
      const referenceSpacesPatched = this.patchRequestReferenceSpace(adapter);
      this.patchRequestHitTestSource(adapter);
      this.installSessionListeners(adapter);

      this.capabilityState.inputSources ||= inputSourcesPatched;
      this.capabilityState.inputEvents ||= inputSourcesPatched && rafPatched;
      this.capabilityState.viewerSpaceTagging ||= referenceSpacesPatched;
      if (this.capabilityState.phase === 'installed') {
        this.capabilityState.phase = 'attached';
      }

      if (!inputSourcesPatched) {
        this.unsupportedForSession(
          adapter,
          'Unable to override XRSession.inputSources.',
        );
      }
      if (!rafPatched) {
        this.unsupportedForSession(
          adapter,
          'Unable to wrap XRSession.requestAnimationFrame.',
        );
      }
      if (!referenceSpacesPatched) {
        this.note(
          'XRReferenceSpace tagging is unavailable; viewer-relative offset spaces will use native behavior.',
        );
      }
    } catch (error) {
      this.detachAdapter(adapter);
      throw error;
    }
  }

  private sessionEnablesHandTracking(session: XRSession): boolean {
    const features = session.enabledFeatures as readonly string[] | undefined;
    if (features) {
      return Array.prototype.includes.call(features, HAND_TRACKING_FEATURE);
    }
    // Browsers without enabledFeatures cannot report the negotiated feature
    // set, so fall back to what the emulated device advertises.
    return this.device.supportedFeatures.includes(HAND_TRACKING_FEATURE);
  }

  // ===========================================================================
  // Input bindings
  // ===========================================================================

  private createDeviceBindings(adapter: NativeSessionAdapter): void {
    for (const controller of Object.values(this.device.controllers)) {
      adapter.deviceBindings.push(
        this.createInputBinding(adapter, 'controller', controller.inputSource, {
          trackedInput: controller,
          exposeHand: false,
        }),
      );
    }
    if (adapter.handTracking) {
      for (const hand of Object.values(this.device.hands)) {
        adapter.deviceBindings.push(
          this.createInputBinding(adapter, 'hand', hand.inputSource, {
            trackedInput: hand,
            exposeHand: true,
          }),
        );
      }
    }
  }

  /**
   * Returns the stable binding for a recorded playback source, creating it on
   * first use so the application always observes the same facade objects.
   */
  private playbackBinding(
    adapter: NativeSessionAdapter,
    source: IwerInputSource,
  ): InputBinding {
    const existing = adapter.playbackBindings.get(source);
    if (existing) {
      return existing;
    }
    const exposeHand = Boolean(source.hand) && adapter.handTracking;
    if (source.hand && !adapter.handTracking) {
      this.note(
        `Recorded hand joints are hidden because the native session does not enable the "${HAND_TRACKING_FEATURE}" feature.`,
      );
    }
    const binding = this.createInputBinding(adapter, 'playback', source, {
      exposeHand,
    });
    adapter.playbackBindings.set(source, binding);
    return binding;
  }

  private createInputBinding(
    adapter: NativeSessionAdapter,
    kind: InputBindingKind,
    iwerSource: IwerInputSource,
    options: { trackedInput?: XRTrackedInput; exposeHand: boolean },
  ): InputBinding {
    const targetRaySpace = this.createSpaceToken(adapter);
    this.spaces.set(targetRaySpace, {
      adapter,
      origin: () => iwerSource.targetRaySpace,
      localOffset: mat4.create(),
    });

    let gripSpace: XRSpace | undefined;
    if (iwerSource.gripSpace) {
      gripSpace = this.createSpaceToken(adapter);
      this.spaces.set(gripSpace, {
        adapter,
        origin: () => iwerSource.gripSpace ?? null,
        localOffset: mat4.create(),
      });
    }

    const joints: JointBinding[] = [];
    if (options.exposeHand && iwerSource.hand) {
      for (const name of Object.values(IwerHandJoint)) {
        const source = iwerSource.hand.get(name);
        if (!source) {
          continue;
        }
        const joint: JointBinding = {
          name,
          space: this.createJointSpaceFacade(name),
          source,
        };
        this.spaces.set(joint.space, {
          adapter,
          origin: () => joint.source,
          localOffset: mat4.create(),
          joint,
        });
        joints.push(joint);
      }
    }

    const binding: InputBinding = {
      kind,
      iwerSource,
      trackedInput: options.trackedInput,
      inputSource: undefined as unknown as XRInputSource,
      targetRaySpace,
      gripSpace,
      joints,
      eventButtons: this.eventButtons(iwerSource),
      previousButtonValues: new Map(),
      activeButtons: new Set(),
      activeActions: new Set(),
      pendingActions: new Set(),
    };
    binding.inputSource = this.createInputSourceFacade(binding, adapter);
    this.resetButtonBaseline(binding);
    adapter.bindingByFacade.set(binding.inputSource, binding);
    if (joints.length > 0) {
      this.capabilityState.handInput = true;
    }
    return binding;
  }

  /**
   * Allocates a distinct native reference space to use as a stable synthetic
   * space token. Browsers must return a fresh object for every call, otherwise
   * IWER cannot tell the target-ray and grip spaces apart.
   */
  private createSpaceToken(adapter: NativeSessionAdapter): XRSpace {
    const identity = new (this.getRigidTransformConstructor())();
    const token = adapter.anchorSpace.getOffsetReferenceSpace(
      identity,
    ) as XRSpace;
    if (adapter.spaceTokens.has(token)) {
      throw new Error(
        'Native getOffsetReferenceSpace(identity) reused a space object; stable synthetic input tokens require distinct objects.',
      );
    }
    adapter.spaceTokens.add(token);
    return token;
  }

  private createInputSourceFacade(
    binding: InputBinding,
    adapter: NativeSessionAdapter,
  ): XRInputSource {
    const inputPrototype = this.constructorPrototype('XRInputSource');
    const facade = Object.create(inputPrototype ?? Object.prototype) as object;
    const iwerSource = binding.iwerSource;
    // Hand input sources expose no gamepad per WebXR Hand Input. The IWER pinch
    // gamepad still drives select transitions through binding.eventButtons.
    const gamepad =
      binding.joints.length > 0 || !iwerSource.gamepad
        ? null
        : this.createGamepadFacade(binding, adapter);
    Object.defineProperties(facade, {
      handedness: {
        configurable: true,
        enumerable: true,
        value: iwerSource.handedness,
      },
      targetRayMode: {
        configurable: true,
        enumerable: true,
        value: iwerSource.targetRayMode,
      },
      profiles: {
        configurable: true,
        enumerable: true,
        value: Object.freeze([...iwerSource.profiles]),
      },
      targetRaySpace: {
        configurable: true,
        enumerable: true,
        value: binding.targetRaySpace,
      },
      gripSpace: {
        configurable: true,
        enumerable: true,
        value: binding.gripSpace ?? null,
      },
      gamepad: { configurable: true, enumerable: true, value: gamepad },
      hand: {
        configurable: true,
        enumerable: true,
        value:
          binding.joints.length > 0
            ? this.createHandFacade(binding.joints)
            : null,
      },
    });
    return facade as XRInputSource;
  }

  /**
   * Builds an XRHand-shaped maplike facade. The prototype is borrowed from the
   * browser so branded checks succeed, while every maplike method is an own
   * property because native XRHand methods reject foreign receivers.
   */
  private createHandFacade(joints: readonly JointBinding[]): XRHand {
    const prototype = this.constructorPrototype('XRHand');
    const facade = Object.create(prototype ?? Object.prototype) as object;
    const entries = new Map<string, XRSpace>(
      joints.map((joint) => [joint.name, joint.space]),
    );
    const define = (key: PropertyKey, value: unknown): void => {
      Object.defineProperty(facade, key, {
        configurable: true,
        writable: true,
        value,
      });
    };
    Object.defineProperty(facade, 'size', {
      configurable: true,
      enumerable: true,
      get: () => entries.size,
    });
    define('get', (joint: string) => entries.get(joint));
    define('has', (joint: string) => entries.has(joint));
    define('keys', () => entries.keys());
    define('values', () => entries.values());
    define('entries', () => entries.entries());
    define(
      'forEach',
      function (
        this: unknown,
        callback: (value: XRSpace, key: string, map: unknown) => void,
        thisArg?: unknown,
      ) {
        entries.forEach((value, key) => {
          callback.call(thisArg, value, key, facade);
        });
      },
    );
    define(Symbol.iterator, () => entries.entries());
    return facade as unknown as XRHand;
  }

  /** Builds a stable XRJointSpace-shaped object for one hand joint. */
  private createJointSpaceFacade(name: string): XRSpace {
    const prototype =
      this.constructorPrototype('XRJointSpace') ??
      this.constructorPrototype('XRSpace');
    const facade = Object.create(prototype ?? Object.prototype) as object;
    Object.defineProperty(facade, 'jointName', {
      configurable: true,
      enumerable: true,
      value: name,
    });
    return facade as XRSpace;
  }

  private createGamepadFacade(
    binding: InputBinding,
    adapter: NativeSessionAdapter,
  ): Gamepad {
    const prototype = this.constructorPrototype('Gamepad');
    const facade = Object.create(prototype ?? Object.prototype) as object;
    const gamepad = binding.iwerSource.gamepad!;
    let axes = Object.freeze(gamepad.axes.map((value) => value ?? 0));
    const buttons = Object.freeze(
      gamepad.buttons.map((button) =>
        Object.freeze({
          get pressed() {
            return button?.pressed ?? false;
          },
          get touched() {
            return button?.touched ?? false;
          },
          get value() {
            return button?.value ?? 0;
          },
        }),
      ),
    );
    const hapticActuators = Object.freeze([...gamepad.hapticActuators]);
    Object.defineProperties(facade, {
      id: {
        configurable: true,
        enumerable: true,
        value: '',
      },
      index: { configurable: true, enumerable: true, value: -1 },
      connected: {
        configurable: true,
        enumerable: true,
        get: () => (binding.trackedInput?.connected ?? true) && !adapter.ended,
      },
      timestamp: {
        configurable: true,
        enumerable: true,
        get: () => adapter.lastFrameTime ?? 0,
      },
      mapping: {
        configurable: true,
        enumerable: true,
        get: () => gamepad.mapping,
      },
      axes: {
        configurable: true,
        enumerable: true,
        get: () => {
          const current = gamepad.axes.map((value) => value ?? 0);
          if (
            current.length !== axes.length ||
            current.some((value, index) => value !== axes[index])
          ) {
            axes = Object.freeze(current);
          }
          return axes;
        },
      },
      buttons: {
        configurable: true,
        enumerable: true,
        get: () => buttons,
      },
      hapticActuators: {
        configurable: true,
        enumerable: true,
        get: () => hapticActuators,
      },
      vibrationActuator: {
        configurable: true,
        enumerable: true,
        get: () => gamepad.vibrationActuator,
      },
    });
    return facade as Gamepad;
  }

  private eventButtons(iwerSource: IwerInputSource): GamepadButton[] {
    const gamepad = iwerSource.gamepad;
    if (!gamepad) {
      return [];
    }
    return Object.values(gamepad[P_GAMEPAD].buttonsMap).filter(
      (button): button is GamepadButton => button !== null,
    );
  }

  private resetButtonBaseline(binding: InputBinding): void {
    for (const button of binding.eventButtons) {
      binding.previousButtonValues.set(button, button.value);
    }
  }

  /**
   * Forgets any in-progress action for a binding whose source just appeared or
   * disappeared, so a later removal cannot synthesize a duplicate end event.
   */
  private clearActionState(binding: InputBinding): void {
    binding.activeButtons.clear();
    binding.activeActions.clear();
    binding.pendingActions.clear();
  }

  // ===========================================================================
  // Session patches
  // ===========================================================================

  /**
   * Captures the browser method behind a prototype patch exactly once. A later
   * session otherwise sees IWER's wrapper as its "native" method and recurses.
   */
  private captureNativeRequestAnimationFrame(
    session: XRSession,
  ): XRSession['requestAnimationFrame'] {
    const found = methodDescriptor(session, 'requestAnimationFrame');
    if (!found || typeof found.descriptor.value !== 'function') {
      throw new Error('Native XRSession.requestAnimationFrame is unavailable.');
    }
    const cached = this.rawRafByOwner.get(found.owner);
    if (cached) {
      return cached;
    }
    const nativeMethod = found.descriptor
      .value as XRSession['requestAnimationFrame'];
    this.rawRafByOwner.set(found.owner, nativeMethod);
    return nativeMethod;
  }

  private captureNativeRequestReferenceSpace(
    session: XRSession,
  ): XRSession['requestReferenceSpace'] {
    const found = methodDescriptor(session, 'requestReferenceSpace');
    if (!found || typeof found.descriptor.value !== 'function') {
      throw new Error('Native XRSession.requestReferenceSpace is unavailable.');
    }
    const cached = this.rawRequestReferenceSpaceByOwner.get(found.owner);
    if (cached) {
      return cached;
    }
    const nativeMethod = found.descriptor
      .value as XRSession['requestReferenceSpace'];
    this.rawRequestReferenceSpaceByOwner.set(found.owner, nativeMethod);
    return nativeMethod;
  }

  private patchInputSources(adapter: NativeSessionAdapter): boolean {
    if (
      adapter.patches.define(adapter.session, 'inputSources', {
        configurable: true,
        enumerable: true,
        get: () => adapter.sources,
      })
    ) {
      return (adapter.session.inputSources as unknown) === adapter.sources;
    }
    const found = methodDescriptor(adapter.session, 'inputSources');
    const nativeGetter = found?.descriptor.get;
    if (!found || !nativeGetter) {
      return false;
    }
    if (!this.patchedInputSourceOwners.has(found.owner)) {
      const owner = this;
      const patched = this.patches.define(found.owner, 'inputSources', {
        ...found.descriptor,
        get(this: XRSession) {
          return (
            owner.sessionsByObject.get(this)?.sources ?? nativeGetter.call(this)
          );
        },
      });
      if (!patched) {
        return false;
      }
      this.patchedInputSourceOwners.add(found.owner);
    }
    return (adapter.session.inputSources as unknown) === adapter.sources;
  }

  private patchRequestAnimationFrame(adapter: NativeSessionAdapter): boolean {
    const owner = this;
    const wrapped: XRSession['requestAnimationFrame'] = function (
      this: XRSession,
      callback,
    ) {
      return adapter.nativeRequestAnimationFrame.call(this, (time, frame) => {
        owner.prepareFrameCallback(adapter, time, frame);
        try {
          callback(time, frame);
        } finally {
          owner.releaseFrameCallback(adapter, frame);
        }
      });
    };
    if (
      adapter.patches.define(adapter.session, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: wrapped,
      })
    ) {
      return true;
    }

    const found = methodDescriptor(adapter.session, 'requestAnimationFrame');
    const nativeMethod = found?.descriptor.value as
      | XRSession['requestAnimationFrame']
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return false;
    }
    if (!this.patchedRafOwners.has(found.owner)) {
      const patched = this.patches.define(
        found.owner,
        'requestAnimationFrame',
        {
          ...found.descriptor,
          value(this: XRSession, callback: XRFrameRequestCallback) {
            const current = owner.sessionsByObject.get(this);
            if (!current) {
              return nativeMethod.call(this, callback);
            }
            return current.nativeRequestAnimationFrame.call(
              this,
              (time, frame) => {
                owner.prepareFrameCallback(current, time, frame);
                try {
                  callback(time, frame);
                } finally {
                  owner.releaseFrameCallback(current, frame);
                }
              },
            );
          },
        },
      );
      if (!patched) {
        return false;
      }
      this.patchedRafOwners.add(found.owner);
    }
    return true;
  }

  private patchRequestReferenceSpace(adapter: NativeSessionAdapter): boolean {
    const owner = this;
    const wrapped: XRSession['requestReferenceSpace'] = function (
      this: XRSession,
      type,
    ) {
      return adapter.nativeRequestReferenceSpace
        .call(this, type)
        .then((space) => {
          owner.tagRequestedReferenceSpace(adapter, space, type);
          owner.ensureReferenceSpacePatch(space, adapter);
          return space;
        });
    };
    if (
      adapter.patches.define(adapter.session, 'requestReferenceSpace', {
        configurable: true,
        writable: true,
        value: wrapped,
      })
    ) {
      return true;
    }

    const found = methodDescriptor(adapter.session, 'requestReferenceSpace');
    const nativeMethod = found?.descriptor.value as
      | XRSession['requestReferenceSpace']
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return false;
    }
    if (!this.patchedRequestReferenceSpaceOwners.has(found.owner)) {
      const patched = this.patches.define(
        found.owner,
        'requestReferenceSpace',
        {
          ...found.descriptor,
          value(this: XRSession, type: XRReferenceSpaceType) {
            const current = owner.sessionsByObject.get(this);
            if (!current) {
              return nativeMethod.call(this, type);
            }
            return current.nativeRequestReferenceSpace
              .call(this, type)
              .then((space) => {
                owner.tagRequestedReferenceSpace(current, space, type);
                owner.ensureReferenceSpacePatch(space, current);
                return space;
              });
          },
        },
      );
      if (!patched) {
        return false;
      }
      this.patchedRequestReferenceSpaceOwners.add(found.owner);
    }
    return true;
  }

  private patchRequestHitTestSource(adapter: NativeSessionAdapter): void {
    const nativeMethod = adapter.session.requestHitTestSource as
      | NativeRequestHitTestSource
      | undefined;
    if (typeof nativeMethod !== 'function') {
      return;
    }
    const owner = this;
    const wrapped: NativeRequestHitTestSource = function (
      this: XRSession,
      options,
    ) {
      return owner.handleRequestHitTestSource(this, nativeMethod, options);
    };
    if (
      adapter.patches.define(adapter.session, 'requestHitTestSource', {
        configurable: true,
        writable: true,
        value: wrapped,
      })
    ) {
      return;
    }
    const found = methodDescriptor(adapter.session, 'requestHitTestSource');
    if (
      !found ||
      typeof found.descriptor.value !== 'function' ||
      this.patchedHitTestOwners.has(found.owner)
    ) {
      return;
    }
    const prototypeMethod = found.descriptor
      .value as NativeRequestHitTestSource;
    const patched = this.patches.define(found.owner, 'requestHitTestSource', {
      ...found.descriptor,
      value(this: XRSession, options: XRHitTestOptionsInit) {
        return owner.handleRequestHitTestSource(this, prototypeMethod, options);
      },
    });
    if (patched) {
      this.patchedHitTestOwners.add(found.owner);
    }
  }

  private tagRequestedReferenceSpace(
    adapter: NativeSessionAdapter,
    space: XRReferenceSpace,
    type: XRReferenceSpaceType,
  ): void {
    if (this.spaces.has(space)) {
      return;
    }
    if (type === 'viewer') {
      this.spaces.set(space, {
        adapter,
        origin: () => this.currentViewerSpace(),
        localOffset: mat4.create(),
      });
    }
  }

  private ensureReferenceSpacePatch(
    space: XRReferenceSpace,
    adapter: NativeSessionAdapter,
  ): void {
    if (this.instancePatchedReferenceSpaces.has(space)) {
      return;
    }
    const found = methodDescriptor(space, 'getOffsetReferenceSpace');
    const nativeMethod = found?.descriptor.value as
      | XRReferenceSpace['getOffsetReferenceSpace']
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return;
    }
    const owner = this;
    const wrapper = function (
      this: XRReferenceSpace,
      originOffset: XRRigidTransform,
    ): XRReferenceSpace {
      const info = owner.spaces.get(this);
      if (!info || info.adapter.ended) {
        return nativeMethod.call(this, originOffset);
      }
      const derived = nativeMethod.call(this, originOffset);
      owner.propagateSpaceMetadata(this, derived, originOffset);
      owner.ensureReferenceSpacePatch(derived, info.adapter);
      return derived;
    };
    if (
      found.owner !== space &&
      !this.patchedReferenceSpaceOwners.has(found.owner)
    ) {
      const patched = this.patches.define(
        found.owner,
        'getOffsetReferenceSpace',
        {
          ...found.descriptor,
          value: wrapper,
        },
      );
      if (patched) {
        this.patchedReferenceSpaceOwners.add(found.owner);
        return;
      }
    } else if (found.owner !== space) {
      return;
    }
    const patched = adapter.patches.define(space, 'getOffsetReferenceSpace', {
      configurable: true,
      writable: true,
      value: wrapper,
    });
    if (patched) {
      this.instancePatchedReferenceSpaces.add(space);
    }
  }

  private propagateSpaceMetadata(
    parent: XRReferenceSpace,
    derived: XRReferenceSpace,
    originOffset: XRRigidTransform,
  ): void {
    const info = this.spaces.get(parent);
    if (!info) {
      return;
    }
    const localOffset = mat4.create();
    mat4.multiply(
      localOffset,
      info.localOffset,
      matrixFromTransform(originOffset),
    );
    // An offset space derived from a joint is no longer a joint; only the
    // origin and the accumulated offset carry over.
    this.spaces.set(derived, {
      adapter: info.adapter,
      origin: info.origin,
      localOffset,
    });
  }

  private installSessionListeners(adapter: NativeSessionAdapter): void {
    const { session } = adapter;
    const suppressNativeInput = (event: Event): void => {
      if (!this.syntheticEvents.has(event)) {
        event.stopImmediatePropagation();
      }
    };
    for (const type of ['inputsourceschange', ...INPUT_EVENT_NAMES]) {
      session.addEventListener(type, suppressNativeInput, true);
      adapter.cleanupListeners.push(() =>
        session.removeEventListener(type, suppressNativeInput, true),
      );
    }
    const onVisibilityChange = (): void => {
      const driver = this.sharedStateDriver();
      this.device[P_DEVICE].visibilityState =
        driver?.session.visibilityState ?? session.visibilityState;
      this.device[P_DEVICE].pendingVisibilityState = null;
      // Native runtimes publish their initial input set from the frame loop.
      // Preserve that timing even if visibility changes before frame one.
      if (adapter.lastFrameTime !== undefined) {
        this.refreshInputSources(adapter, true);
      }
    };
    session.addEventListener('visibilitychange', onVisibilityChange);
    adapter.cleanupListeners.push(() =>
      session.removeEventListener('visibilitychange', onVisibilityChange),
    );
    const onEnd = (): void => this.detachAdapter(adapter);
    session.addEventListener('end', onEnd, { once: true });
    adapter.cleanupListeners.push(() =>
      session.removeEventListener('end', onEnd),
    );
  }

  // ===========================================================================
  // Frame loop
  // ===========================================================================

  private tick(
    adapter: NativeSessionAdapter,
    time: DOMHighResTimeStamp,
    frame: XRFrame,
  ): void {
    if (adapter.ended || adapter.lastFrameTime === time) {
      return;
    }
    adapter.lastFrameTime = time;
    adapter.baseSpaceCache.clear();

    if (adapter === this.sharedStateDriver()) {
      this.advanceSharedState(adapter, time);
    }

    // Publish first (so a recording's edges address a visible input source),
    // then drain, then publish again to release any source that was only kept
    // alive for the drain. Both passes are no-ops when nothing changed.
    this.refreshInputSources(adapter, true);
    this.drainPendingEvents(adapter, frame);
    this.refreshInputSources(adapter, true);
    this.dispatchButtonTransitions(adapter, frame);
    this.updateHitTestSources(adapter);
  }

  /**
   * Uses the primary session while it is visible, otherwise the first visible
   * session. Native runtimes normally expose one immersive session, but this
   * keeps shared device state live in runtimes that permit concurrent sessions.
   */
  private sharedStateDriver(): NativeSessionAdapter | null {
    if (this.primarySession?.session.visibilityState === 'visible') {
      return this.primarySession;
    }
    return (
      Array.from(this.liveSessions).find(
        (adapter) => adapter.session.visibilityState === 'visible',
      ) ?? this.primarySession
    );
  }

  private advanceSharedState(
    adapter: NativeSessionAdapter,
    time: DOMHighResTimeStamp,
  ): void {
    const previousTime = this.lastPrimaryTime;
    this.lastPrimaryTime = time;
    const delta =
      previousTime === undefined ? 16.67 : Math.max(0, time - previousTime);
    this.device[P_DEVICE].remote.update(delta);
    this.device[P_DEVICE].visibilityState = adapter.session.visibilityState;
    this.device[P_DEVICE].pendingVisibilityState = null;

    const player = this.device[P_DEVICE].actionPlayer;
    if (
      player &&
      (player.playing || player[P_ACTION_PLAYER].manualFrameActive)
    ) {
      this.wirePlayer(player);
      // Sample exactly once per primary native frame timestamp. playFrame()
      // clears `playing` on the final frame, so remember that this frame was
      // produced by the player and keep routing through it for its duration.
      this.playbackFrame = player;
      this.capabilityState.actionPlayback = true;
      if (player.playing && player[P_ACTION_PLAYER].autoAdvance) {
        player.playFrame();
      }
    } else {
      this.playbackFrame = null;
      if (this.wiredPlayer && this.wiredPlayer !== player) {
        this.unwirePlayer();
      }
      this.updateDeviceInputs();
    }
    this.device[P_DEVICE].updateViews();
  }

  /**
   * Mirrors XRTrackedInput.onFrameStart's state advance for the inputs the
   * device currently exposes: snapshot the target-ray pose, apply pending
   * gamepad values, and refresh interpolated hand joints.
   *
   * This reads the shared device rather than any one session's bindings, so a
   * session that cannot publish a given input kind (a session without
   * hand-tracking, say) never stalls that input for the other sessions.
   */
  private updateDeviceInputs(): void {
    // activeInputs already applies visibility, the primary input mode, and
    // per-input connectedness, exactly as the emulated frame loop does.
    for (const input of this.device.activeInputs) {
      mat4.fromRotationTranslation(
        input.inputSource.targetRaySpace[P_SPACE].offsetMatrix,
        input.quaternion.quat,
        input.position.vec3,
      );
      for (const button of input.inputSource.gamepad?.buttons ?? []) {
        if (button instanceof GamepadButton) {
          button[P_GAMEPAD].lastFrameValue = button[P_GAMEPAD].value;
          if (button[P_GAMEPAD].pendingValue != null) {
            button[P_GAMEPAD].value = button[P_GAMEPAD].pendingValue;
            button[P_GAMEPAD].pendingValue = null;
          }
        }
      }
      (input as { updateHandPose?: () => void }).updateHandPose?.();
    }
  }

  private prepareFrameCallback(
    adapter: NativeSessionAdapter,
    time: DOMHighResTimeStamp,
    frame: XRFrame,
  ): void {
    // A browser callback queued through the wrapper can outlive uninstall(),
    // or even fire after a later reinstall. It must still reach the application,
    // but the detached adapter must never re-patch host objects or mutate state.
    if (!this.installedState || adapter.ended) {
      return;
    }
    try {
      if (adapter.lastFrameTime !== time) {
        // Instance-tier fallbacks live for one native frame. Reverting them at
        // the next timestamp keeps exact uninstall semantics without retaining
        // every frame/pose object on browsers that allocate them per frame.
        adapter.instancePatches.revert();
        if (this.lastEpochTime !== time) {
          this.lastEpochTime = time;
          this.epoch += 1;
        }
      }
      this.frameSessions.set(frame, adapter);
      adapter.activeFrame = frame;
      this.ensureFramePatches(frame);
      this.tick(adapter, time, frame);
    } catch (error) {
      try {
        this.note(
          `Native frame preparation failed; the application frame was preserved: ${this.errorText(
            error,
          )}`,
          'frame-preparation-failed',
        );
      } catch {
        // Never let diagnostics prevent the browser-owned application callback.
      }
    }
  }

  /**
   * Ends this session's ownership of the frame. WebXR marks an XRFrame inactive
   * as soon as its callback returns, so nothing may hand it to the application
   * (or query it) afterwards.
   */
  private releaseFrameCallback(
    adapter: NativeSessionAdapter,
    frame: XRFrame,
  ): void {
    if (adapter.activeFrame === frame) {
      adapter.activeFrame = null;
    }
  }

  /**
   * The recording currently driving poses and inputs, or null when the device
   * state is authoritative. Stays non-null for the remainder of the native
   * frame in which the recording reached its final sample.
   */
  private activePlayer(): ActionPlayer | null {
    if (this.playbackFrame) {
      return this.playbackFrame;
    }
    const player = this.device[P_DEVICE].actionPlayer;
    return player &&
      (player.playing || player[P_ACTION_PLAYER].manualFrameActive)
      ? player
      : null;
  }

  private currentViewerSpace(): IwerSpace {
    const player = this.activePlayer();
    return player ? player.viewerSpace : this.device[P_DEVICE].viewerSpace;
  }

  private refreshInputSources(
    adapter: NativeSessionAdapter,
    dispatchChange: boolean,
  ): void {
    const visible = adapter.session.visibilityState === 'visible';
    const next = visible ? this.expectedSources(adapter) : [];
    if (visible) {
      // A facade with queued events stays published until those events drain,
      // so a recording's edge is never delivered for an unpublished source.
      for (const retained of adapter.retainedSources) {
        if (!next.includes(retained)) {
          next.push(retained);
        }
      }
    } else {
      // A session that is not visible receives no animation frame callbacks, so
      // the queue would never drain. Input is suspended anyway: drop it rather
      // than pin input sources the application must not observe.
      adapter.pendingEvents.length = 0;
      adapter.retainedSources.clear();
      for (const binding of adapter.bindingByFacade.values()) {
        binding.pendingActions.clear();
      }
    }
    const removed = adapter.sources.filter((source) => !next.includes(source));
    const added = next.filter((source) => !adapter.sources.includes(source));
    if (added.length === 0 && removed.length === 0) {
      return;
    }
    for (const source of removed) {
      const binding = adapter.bindingByFacade.get(source);
      if (!binding) {
        continue;
      }
      if (visible) {
        // A source that disappears while the session remains visible must
        // terminate its actions. A visibility loss instead clears them
        // silently: there is no active frame on which to deliver an end, and
        // delaying it until the source is re-added would create an orphan.
        for (const trigger of Array.from(binding.activeActions)) {
          this.emitInputEvent(
            adapter,
            `${trigger}end` as InputEventName,
            source,
            false,
          );
        }
      }
      this.clearActionState(binding);
      this.resetButtonBaseline(binding);
    }
    for (const source of added) {
      const binding = adapter.bindingByFacade.get(source);
      if (binding) {
        // Only the button-edge baseline is reset here. activeActions is left
        // alone: a recording can start an action in the same tick that first
        // publishes its source, and that action still has to be terminable.
        binding.activeButtons.clear();
        this.resetButtonBaseline(binding);
      }
    }
    adapter.sources = Object.freeze([...next]);
    if (dispatchChange) {
      this.dispatchInputSourcesChange(adapter, added, removed);
    }
  }

  private expectedSources(adapter: NativeSessionAdapter): XRInputSource[] {
    const player = this.activePlayer();
    if (player) {
      try {
        return player.inputSources.map(
          (source) => this.playbackBinding(adapter, source).inputSource,
        );
      } catch (error) {
        // refreshInputSources also runs outside the frame loop, so a failed
        // binding must degrade to "no sources" instead of escaping.
        this.note(
          `Recorded input sources could not be published: ${this.errorText(
            error,
          )}`,
          'recorded-input-publication-failed',
        );
        return [];
      }
    }
    const kind = this.device.primaryInputMode;
    if (kind === 'hand' && !adapter.handTracking) {
      this.note(
        `Native hand input requires the "${HAND_TRACKING_FEATURE}" feature on the browser session; inputSources remain empty while hand mode is selected.`,
      );
      return [];
    }
    return adapter.deviceBindings
      .filter(
        (binding) => binding.kind === kind && binding.trackedInput!.connected,
      )
      .map((binding) => binding.inputSource);
  }

  private dispatchButtonTransitions(
    adapter: NativeSessionAdapter,
    frame: XRFrame,
  ): void {
    const visibleSources = new Set(adapter.sources);
    for (const binding of adapter.deviceBindings) {
      if (!visibleSources.has(binding.inputSource)) {
        continue;
      }
      for (const button of binding.eventButtons) {
        const previous = binding.previousButtonValues.get(button) ?? 0;
        const current = button.value;
        binding.previousButtonValues.set(button, current);
        const trigger = button[P_GAMEPAD].eventTrigger;
        if (!trigger) {
          continue;
        }
        if (previous === 0 && current > 0) {
          binding.activeButtons.add(button);
          this.dispatchInputEvent(
            adapter,
            `${trigger}start` as InputEventName,
            frame,
            binding.inputSource,
          );
        } else if (previous > 0 && current === 0) {
          if (binding.activeButtons.delete(button)) {
            this.dispatchInputEvent(
              adapter,
              trigger,
              frame,
              binding.inputSource,
            );
            this.dispatchInputEvent(
              adapter,
              `${trigger}end` as InputEventName,
              frame,
              binding.inputSource,
            );
          }
        }
      }
    }
  }

  // ===========================================================================
  // Action playback routing
  // ===========================================================================

  /**
   * Attaches an event context so ActionPlayer's own select/squeeze edge
   * detection (including edges skipped across multi-frame advances) is routed
   * through the stable native facades instead of IWER's emulated session.
   */
  private wirePlayer(player: ActionPlayer): void {
    if (this.wiredPlayer === player) {
      return;
    }
    this.unwirePlayer();
    this.previousPlayerContext = player[P_ACTION_PLAYER].eventContext;
    const owner = this;
    // The player targets IWER's emulated session type; this relay accepts its
    // events and republishes them as native, facade-addressed events instead.
    const relay = {
      dispatchEvent(event: Event): boolean {
        owner.forwardPlaybackEvent(event);
        return true;
      },
    };
    player.setEventContext({
      session: relay,
      // ActionPlayer skips edge detection entirely when this yields nothing, so
      // never return null: an application-driven stepFrames() runs outside any
      // animation frame callback and its edges must still reach the queue.
      // The override re-stamps each event with a real frame as it drains.
      getFrame: () =>
        this.primarySession?.activeFrame ?? this.detachedPlaybackFrame,
      onDiscontinuity: () => {
        owner.terminatePlaybackActions();
      },
    } as unknown as ActionPlayerEventContext);
    this.wiredPlayer = player;
  }

  private unwirePlayer(): void {
    const player = this.wiredPlayer;
    if (!player) {
      return;
    }
    this.wiredPlayer = null;
    const previous = this.previousPlayerContext;
    this.previousPlayerContext = undefined;
    try {
      player.setEventContext(previous);
    } catch {
      // Restoring diagnostics must never break teardown.
    }
  }

  /**
   * Translates one ActionPlayer edge into WebXR's native event order and queues
   * it on every live session.
   *
   * ActionPlayer emits `<trigger>` + `<trigger>start` when a recorded button
   * goes down and `<trigger>end` when it comes back up. That order is IWER's
   * long-standing emulated behavior and is left untouched for the emulated
   * runtime, but WebXR specifies `<trigger>start` on press and `<trigger>` +
   * `<trigger>end` on release. On a browser-owned session the application is
   * entitled to the specified order, and to the same order the override
   * already produces for live device input, so the press-time completion event
   * is dropped and reissued on release.
   */
  private forwardPlaybackEvent(event: Event): void {
    const recorded = (event as { inputSource?: IwerInputSource }).inputSource;
    if (!recorded) {
      return;
    }
    const type = event.type as InputEventName;
    const trigger: InputActionTrigger | null = type.startsWith('select')
      ? 'select'
      : type.startsWith('squeeze')
        ? 'squeeze'
        : null;
    if (!trigger) {
      return;
    }
    const suffix = type.slice(trigger.length);
    if (suffix !== '' && suffix !== 'start' && suffix !== 'end') {
      return;
    }
    if (suffix === '') {
      // The player's press-time completion event; release reissues it in order.
      return;
    }
    for (const adapter of this.liveSessions) {
      let binding: InputBinding;
      try {
        binding = this.playbackBinding(adapter, recorded);
      } catch (error) {
        this.note(
          `A recorded input event could not be bound to a native input source: ${this.errorText(
            error,
          )}`,
          'recorded-input-binding-failed',
        );
        continue;
      }
      if (suffix === 'start') {
        // Defensively close a held action before accepting another start. The
        // player's discontinuity hook normally does this at loop/seek time.
        this.terminatePlaybackAction(adapter, binding, trigger);
        binding.pendingActions.add(trigger);
        this.emitInputEvent(
          adapter,
          `${trigger}start` as InputEventName,
          binding.inputSource,
          true,
        );
      } else {
        // Only terminate an action this session actually observed starting.
        if (!binding.pendingActions.delete(trigger)) {
          continue;
        }
        this.emitInputEvent(adapter, trigger, binding.inputSource, true);
        this.emitInputEvent(
          adapter,
          `${trigger}end` as InputEventName,
          binding.inputSource,
          true,
        );
      }
    }
  }

  private terminatePlaybackActions(): void {
    for (const adapter of this.liveSessions) {
      for (const binding of adapter.playbackBindings.values()) {
        for (const trigger of new Set([
          ...binding.pendingActions,
          ...binding.activeActions,
        ])) {
          this.terminatePlaybackAction(adapter, binding, trigger);
        }
      }
    }
  }

  private terminatePlaybackAction(
    adapter: NativeSessionAdapter,
    binding: InputBinding,
    trigger: InputActionTrigger,
  ): void {
    const wasPending = binding.pendingActions.delete(trigger);
    if (!wasPending && !binding.activeActions.has(trigger)) {
      return;
    }
    const endType = `${trigger}end` as InputEventName;
    const alreadyQueued = adapter.pendingEvents.some(
      (event) =>
        event.inputSource === binding.inputSource && event.type === endType,
    );
    if (!alreadyQueued) {
      // A discontinuity interrupts rather than completes the action, so it
      // produces only the terminal event.
      this.emitInputEvent(adapter, endType, binding.inputSource, true);
    }
  }

  /**
   * Dispatches an input event immediately when this session owns an active
   * frame, and otherwise queues it for the session's next animation frame
   * callback. `retain` keeps the source published until the queue drains.
   */
  private emitInputEvent(
    adapter: NativeSessionAdapter,
    type: InputEventName,
    inputSource: XRInputSource,
    retain: boolean,
  ): void {
    const frame = adapter.activeFrame;
    if (frame && adapter.sources.includes(inputSource)) {
      this.dispatchInputEvent(adapter, type, frame, inputSource);
      return;
    }
    if (adapter.pendingEvents.length >= MAX_PENDING_EVENTS) {
      this.compactPendingEvents(adapter);
    }
    adapter.pendingEvents.push({ type, inputSource });
    if (retain) {
      adapter.retainedSources.add(inputSource);
    }
  }

  /**
   * Drops the oldest complete queued action lifecycle under backpressure.
   * Incomplete lifecycles are retained even past the soft limit: preserving
   * WebXR's start/end invariant is more important than a strict queue bound.
   */
  private compactPendingEvents(adapter: NativeSessionAdapter): void {
    const starts = new Map<XRInputSource, Map<InputActionTrigger, number>>();
    let lifecycle:
      | {
          startIndex: number;
          endIndex: number;
          inputSource: XRInputSource;
          trigger: InputActionTrigger;
        }
      | undefined;
    for (let index = 0; index < adapter.pendingEvents.length; index++) {
      const event = adapter.pendingEvents[index];
      if (event.type.endsWith('start')) {
        const trigger = event.type.slice(
          0,
          -'start'.length,
        ) as InputActionTrigger;
        let byTrigger = starts.get(event.inputSource);
        if (!byTrigger) {
          byTrigger = new Map();
          starts.set(event.inputSource, byTrigger);
        }
        if (!byTrigger.has(trigger)) {
          byTrigger.set(trigger, index);
        }
        continue;
      }
      if (!event.type.endsWith('end')) {
        continue;
      }
      const trigger = event.type.slice(0, -'end'.length) as InputActionTrigger;
      const byTrigger = starts.get(event.inputSource);
      const startIndex = byTrigger?.get(trigger);
      if (startIndex === undefined) {
        continue;
      }
      byTrigger!.delete(trigger);
      if (!lifecycle || startIndex < lifecycle.startIndex) {
        lifecycle = {
          startIndex,
          endIndex: index,
          inputSource: event.inputSource,
          trigger,
        };
      }
    }
    if (!lifecycle) {
      return;
    }
    const { startIndex, endIndex, inputSource, trigger } = lifecycle;
    const startType = `${trigger}start` as InputEventName;
    const endType = `${trigger}end` as InputEventName;
    adapter.pendingEvents = adapter.pendingEvents.filter(
      (event, index) =>
        index < startIndex ||
        index > endIndex ||
        event.inputSource !== inputSource ||
        (event.type !== trigger &&
          event.type !== startType &&
          event.type !== endType),
    );
    this.note(
      'A native session fell too far behind; an oldest complete queued input action was discarded.',
    );
  }
  /** Flushes queued input events with a frame this session currently owns. */
  private drainPendingEvents(
    adapter: NativeSessionAdapter,
    frame: XRFrame,
  ): void {
    if (adapter.pendingEvents.length === 0) {
      adapter.retainedSources.clear();
      return;
    }
    const queued = adapter.pendingEvents.splice(0);
    adapter.retainedSources.clear();
    for (const entry of queued) {
      this.dispatchInputEvent(adapter, entry.type, frame, entry.inputSource);
    }
  }

  private dispatchInputEvent(
    adapter: NativeSessionAdapter,
    type: InputEventName,
    frame: XRFrame,
    inputSource: XRInputSource,
  ): void {
    // Record the transition before dispatching: a listener may synchronously
    // remove the source, and the terminating event must be based on what the
    // application has been told by then.
    this.recordDeliveredAction(adapter, type, inputSource);
    const event = this.createEvent(type, 'XRInputSourceEvent', {
      frame,
      inputSource,
    });
    this.syntheticEvents.add(event);
    adapter.session.dispatchEvent(event);
  }

  /**
   * Tracks which actions the application currently believes are in progress.
   * Only delivered events count, so an event dropped while a session was not
   * visible can never produce an unmatched terminating event later.
   */
  private recordDeliveredAction(
    adapter: NativeSessionAdapter,
    type: InputEventName,
    inputSource: XRInputSource,
  ): void {
    const binding = adapter.bindingByFacade.get(inputSource);
    if (!binding) {
      return;
    }
    if (type.endsWith('start')) {
      binding.activeActions.add(
        type.slice(0, -'start'.length) as InputActionTrigger,
      );
    } else if (type.endsWith('end')) {
      binding.activeActions.delete(
        type.slice(0, -'end'.length) as InputActionTrigger,
      );
    }
  }

  private dispatchInputSourcesChange(
    adapter: NativeSessionAdapter,
    added: XRInputSource[],
    removed: XRInputSource[],
  ): void {
    const event = this.createEvent(
      'inputsourceschange',
      'XRInputSourcesChangeEvent',
      {
        session: adapter.session,
        added: Object.freeze([...added]),
        removed: Object.freeze([...removed]),
      },
    );
    this.syntheticEvents.add(event);
    adapter.session.dispatchEvent(event);
  }

  private createEvent(
    type: string,
    prototypeName: string,
    properties: Record<string, unknown>,
  ): Event {
    const EventConstructor = eventConstructor(this.globalObject);
    if (!EventConstructor) {
      throw new Error('Event constructor is unavailable.');
    }
    const event = new EventConstructor(type);
    const prototype = this.constructorPrototype(prototypeName);
    if (prototype) {
      try {
        Object.setPrototypeOf(event, prototype);
        if (prototypeName === 'XRInputSourceEvent') {
          this.capabilityState.brandedInputEvents = true;
        }
      } catch {
        // A standards-shaped Event with own data properties remains usable.
      }
    }
    for (const [key, value] of Object.entries(properties)) {
      Object.defineProperty(event, key, {
        configurable: true,
        enumerable: true,
        value,
      });
    }
    return event;
  }

  // ===========================================================================
  // Frame patches
  // ===========================================================================

  private ensureFramePatches(frame: XRFrame): void {
    if (this.instancePatchedFrameEpochs.get(frame) === this.epoch) {
      return;
    }
    const adapter = this.adapterForFrame(frame);
    const posePatched = this.patchFrameGetPose(frame);
    const viewerPatched = this.patchFrameGetViewerPose(frame);
    const batchPatched = this.patchFrameFillPoses(frame);
    const jointPatched = this.patchFrameGetJointPose(frame);
    const radiiPatched = this.patchFrameFillJointRadii(frame);
    if (adapter) {
      this.recordAnchorAvailability(
        adapter,
        this.patchFrameCreateAnchor(frame),
      );
      this.recordHitTestAvailability(
        adapter,
        this.patchFrameGetHitTestResults(frame),
      );
    }
    this.capabilityState.poseOverride ||= posePatched;
    this.capabilityState.batchPoses ||= batchPatched;
    this.capabilityState.jointPoses ||= jointPatched && radiiPatched;
    if (!posePatched) {
      this.note('Unable to patch native XRFrame.getPose.');
    }
    if (!batchPatched) {
      this.note('Unable to patch native XRFrame.fillPoses.');
    }
    if (!viewerPatched) {
      this.note('Unable to patch native XRFrame.getViewerPose.');
    }
    this.instancePatchedFrameEpochs.set(frame, this.epoch);
  }

  private patchFrameGetPose(frame: XRFrame): boolean {
    const found = methodDescriptor(frame, 'getPose');
    if (
      found &&
      found.owner !== frame &&
      this.patchedFrameOwners.has(found.owner)
    ) {
      return true;
    }
    const nativeMethod = found?.descriptor.value as NativeGetPose | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return false;
    }
    const owner = this;
    if (found.owner !== frame) {
      this.rawGetPoseByOwner.set(found.owner, nativeMethod);
      const patched = this.patches.define(found.owner, 'getPose', {
        ...found.descriptor,
        value(this: XRFrame, space: XRSpace, baseSpace: XRSpace) {
          return owner.handleGetPose(this, nativeMethod, space, baseSpace);
        },
      });
      if (patched) {
        this.patchedFrameOwners.add(found.owner);
        return true;
      }
    }

    this.rawGetPoseByFrame.set(frame, nativeMethod);
    return this.defineFrameMethod(
      frame,
      'getPose',
      function (this: XRFrame, space: XRSpace, baseSpace: XRSpace) {
        return owner.handleGetPose(this, nativeMethod, space, baseSpace);
      },
    );
  }

  private patchFrameGetViewerPose(frame: XRFrame): boolean {
    const found = methodDescriptor(frame, 'getViewerPose');
    if (
      found &&
      found.owner !== frame &&
      this.patchedViewerFrameOwners.has(found.owner)
    ) {
      return true;
    }
    const nativeMethod = found?.descriptor.value as
      | NativeGetViewerPose
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return false;
    }
    const owner = this;
    if (found.owner !== frame) {
      const patched = this.patches.define(found.owner, 'getViewerPose', {
        ...found.descriptor,
        value(this: XRFrame, referenceSpace: XRReferenceSpace) {
          return owner.handleGetViewerPose(this, nativeMethod, referenceSpace);
        },
      });
      if (patched) {
        this.patchedViewerFrameOwners.add(found.owner);
        return true;
      }
    }

    return this.defineFrameMethod(
      frame,
      'getViewerPose',
      function (this: XRFrame, referenceSpace: XRReferenceSpace) {
        return owner.handleGetViewerPose(this, nativeMethod, referenceSpace);
      },
    );
  }

  private patchFrameFillPoses(frame: XRFrame): boolean {
    const found = methodDescriptor(frame, 'fillPoses');
    if (
      found &&
      found.owner !== frame &&
      this.patchedFillPosesOwners.has(found.owner)
    ) {
      return true;
    }
    const nativeMethod = found?.descriptor.value as NativeFillPoses | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return false;
    }
    const owner = this;
    if (found.owner !== frame) {
      const patched = this.patches.define(found.owner, 'fillPoses', {
        ...found.descriptor,
        value(
          this: XRFrame,
          spaces: Iterable<XRSpace>,
          baseSpace: XRSpace,
          transforms: Float32Array,
        ) {
          return owner.handleFillPoses(
            this,
            nativeMethod,
            spaces,
            baseSpace,
            transforms,
          );
        },
      });
      if (patched) {
        this.patchedFillPosesOwners.add(found.owner);
        return true;
      }
    }
    return this.defineFrameMethod(
      frame,
      'fillPoses',
      function (
        this: XRFrame,
        spaces: Iterable<XRSpace>,
        baseSpace: XRSpace,
        transforms: Float32Array,
      ) {
        return owner.handleFillPoses(
          this,
          nativeMethod,
          spaces,
          baseSpace,
          transforms,
        );
      },
    );
  }

  private patchFrameGetJointPose(frame: XRFrame): boolean {
    const found = methodDescriptor(frame, 'getJointPose');
    if (
      found &&
      found.owner !== frame &&
      this.patchedJointPoseOwners.has(found.owner)
    ) {
      return true;
    }
    const nativeMethod = found?.descriptor.value as
      | NativeGetJointPose
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return false;
    }
    const owner = this;
    if (found.owner !== frame) {
      const patched = this.patches.define(found.owner, 'getJointPose', {
        ...found.descriptor,
        value(this: XRFrame, joint: XRJointSpace, baseSpace: XRSpace) {
          return owner.handleGetJointPose(this, nativeMethod, joint, baseSpace);
        },
      });
      if (patched) {
        this.patchedJointPoseOwners.add(found.owner);
        return true;
      }
    }
    return this.defineFrameMethod(
      frame,
      'getJointPose',
      function (this: XRFrame, joint: XRJointSpace, baseSpace: XRSpace) {
        return owner.handleGetJointPose(this, nativeMethod, joint, baseSpace);
      },
    );
  }

  private patchFrameFillJointRadii(frame: XRFrame): boolean {
    const found = methodDescriptor(frame, 'fillJointRadii');
    if (
      found &&
      found.owner !== frame &&
      this.patchedJointRadiiOwners.has(found.owner)
    ) {
      return true;
    }
    const nativeMethod = found?.descriptor.value as
      | NativeFillJointRadii
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return false;
    }
    const owner = this;
    if (found.owner !== frame) {
      const patched = this.patches.define(found.owner, 'fillJointRadii', {
        ...found.descriptor,
        value(
          this: XRFrame,
          jointSpaces: Iterable<XRJointSpace>,
          radii: Float32Array,
        ) {
          return owner.handleFillJointRadii(
            this,
            nativeMethod,
            jointSpaces,
            radii,
          );
        },
      });
      if (patched) {
        this.patchedJointRadiiOwners.add(found.owner);
        return true;
      }
    }
    return this.defineFrameMethod(
      frame,
      'fillJointRadii',
      function (
        this: XRFrame,
        jointSpaces: Iterable<XRJointSpace>,
        radii: Float32Array,
      ) {
        return owner.handleFillJointRadii(
          this,
          nativeMethod,
          jointSpaces,
          radii,
        );
      },
    );
  }

  private patchFrameCreateAnchor(frame: XRFrame): PatchOutcome {
    const found = methodDescriptor(frame, 'createAnchor');
    if (
      found &&
      found.owner !== frame &&
      this.patchedCreateAnchorOwners.has(found.owner)
    ) {
      return 'patched';
    }
    const nativeMethod = found?.descriptor.value as
      | NativeCreateAnchor
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return 'unavailable';
    }
    const owner = this;
    const wrapped = function (
      this: XRFrame,
      pose: XRRigidTransform,
      space: XRSpace,
    ): Promise<XRAnchor> {
      return owner.handleCreateAnchor(this, nativeMethod, pose, space);
    };
    if (found.owner !== frame) {
      const patched = this.patches.define(found.owner, 'createAnchor', {
        ...found.descriptor,
        value: wrapped,
      });
      if (patched) {
        this.patchedCreateAnchorOwners.add(found.owner);
        return 'patched';
      }
    }
    return this.defineFrameMethod(frame, 'createAnchor', wrapped)
      ? 'patched'
      : 'failed';
  }

  private patchFrameGetHitTestResults(frame: XRFrame): PatchOutcome {
    const found = methodDescriptor(frame, 'getHitTestResults');
    if (
      found &&
      found.owner !== frame &&
      this.patchedHitTestResultOwners.has(found.owner)
    ) {
      return 'patched';
    }
    const nativeMethod = found?.descriptor.value as
      | NativeGetHitTestResults
      | undefined;
    if (!found || typeof nativeMethod !== 'function') {
      return 'unavailable';
    }
    const owner = this;
    const wrapped = function (
      this: XRFrame,
      hitTestSource: XRHitTestSource,
    ): XRHitTestResult[] {
      return owner.handleGetHitTestResults(this, nativeMethod, hitTestSource);
    };
    if (found.owner !== frame) {
      const patched = this.patches.define(found.owner, 'getHitTestResults', {
        ...found.descriptor,
        value: wrapped,
      });
      if (patched) {
        this.patchedHitTestResultOwners.add(found.owner);
        return 'patched';
      }
    }
    return this.defineFrameMethod(frame, 'getHitTestResults', wrapped)
      ? 'patched'
      : 'failed';
  }

  /**
   * Records whether XRFrame.createAnchor can be intercepted. Without the
   * interception an IWER-controlled space would reach the browser untranslated
   * and silently anchor at the wrong origin, so the capability is reported and
   * controlled spaces are refused instead.
   */
  private recordAnchorAvailability(
    adapter: NativeSessionAdapter,
    outcome: PatchOutcome,
  ): void {
    if (outcome === 'unavailable') {
      return;
    }
    adapter.createAnchorAvailable = outcome === 'patched';
    if (outcome === 'failed') {
      this.note(
        'Unable to override XRFrame.createAnchor on a native frame; anchors in IWER-controlled spaces are unavailable until a frame can be instrumented.',
      );
    }
  }

  /**
   * Records whether XRFrame.getHitTestResults can be intercepted. Without it
   * the hit test facade would reach the browser as a foreign object, so the
   * capability is reported and controlled spaces are refused for this session.
   */
  private recordHitTestAvailability(
    adapter: NativeSessionAdapter,
    outcome: PatchOutcome,
  ): void {
    if (outcome === 'unavailable') {
      return;
    }
    adapter.hitTestResultsAvailable = outcome === 'patched';
    if (outcome === 'failed') {
      this.note(
        'Unable to override XRFrame.getHitTestResults on a native frame; hit test sources in IWER-controlled spaces are unavailable until a frame can be instrumented.',
      );
    }
  }

  private defineFrameMethod(
    frame: XRFrame,
    key: PropertyKey,
    value: (...parameters: never[]) => unknown,
  ): boolean {
    const adapter = this.adapterForFrame(frame);
    if (!adapter) {
      return false;
    }
    return adapter.instancePatches.define(frame, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  // ===========================================================================
  // Pose resolution
  // ===========================================================================

  private handleGetPose(
    frame: XRFrame,
    nativeMethod: NativeGetPose,
    space: XRSpace,
    baseSpace: XRSpace,
  ): XRPose | null | undefined {
    if (!this.installedState) {
      return nativeMethod.call(frame, space, baseSpace);
    }
    const spaceInfo = this.spaces.get(space);
    const baseInfo = this.spaces.get(baseSpace);
    const involvesControlledSpace = Boolean(spaceInfo || baseInfo);
    if (!involvesControlledSpace) {
      return nativeMethod.call(frame, space, baseSpace);
    }
    const adapter = this.adapterForFrame(frame);
    if (!adapter) {
      throw invalidState(
        'The IWER-controlled space was queried from a frame owned by another native session.',
      );
    }
    this.assertFrameActive(adapter, frame, 'getPose');
    if (
      (spaceInfo && spaceInfo.adapter !== adapter) ||
      (baseInfo && baseInfo.adapter !== adapter)
    ) {
      throw invalidState(
        'The IWER-controlled space belongs to a different native session.',
      );
    }
    const matrix = this.effectivePoseMatrix(
      adapter,
      frame,
      nativeMethod,
      space,
      baseSpace,
    );
    if (!matrix) {
      this.note(
        'A synthetic pose could not be resolved in the requested base space.',
      );
      return null;
    }
    return this.createPoseFacade(matrix);
  }

  private handleGetJointPose(
    frame: XRFrame,
    nativeMethod: NativeGetJointPose,
    joint: XRJointSpace,
    baseSpace: XRSpace,
  ): XRJointPose | null | undefined {
    if (!this.installedState) {
      return nativeMethod.call(frame, joint, baseSpace);
    }
    const jointInfo = this.spaces.get(joint);
    const baseInfo = this.spaces.get(baseSpace);
    if (!jointInfo && !baseInfo) {
      return nativeMethod.call(frame, joint, baseSpace);
    }
    if (jointInfo && !jointInfo.joint) {
      // WebIDL rejects a non-XRJointSpace argument before the method runs.
      throw new TypeError(
        "Failed to execute 'getJointPose' on 'XRFrame': parameter 1 is not of type 'XRJointSpace'.",
      );
    }
    const adapter = this.adapterForFrame(frame);
    if (!adapter) {
      throw invalidState(
        'The IWER-controlled joint space was queried from a frame owned by another native session.',
      );
    }
    this.assertFrameActive(adapter, frame, 'getJointPose');
    if (
      (jointInfo && jointInfo.adapter !== adapter) ||
      (baseInfo && baseInfo.adapter !== adapter)
    ) {
      throw invalidState(
        'The IWER-controlled joint space belongs to a different native session.',
      );
    }
    const rawGetPose = this.nativeGetPose(frame);
    if (!rawGetPose) {
      this.note('The native XRFrame.getPose implementation is unavailable.');
      return null;
    }
    let radius: number;
    if (jointInfo?.joint) {
      radius = jointInfo.joint.source[P_JOINT_SPACE].radius;
      // An unknown radius means the joint is not tracked this frame, which
      // WebXR Hand Input reports as a null pose (and as NaN in fillJointRadii).
      if (!isTrackedRadius(radius)) {
        return null;
      }
    } else {
      // Mixed query: a browser-tracked joint resolved against a synthetic base
      // space still reports the browser's radius.
      const nativePose = nativeMethod.call(frame, joint, adapter.anchorSpace);
      if (!nativePose) {
        return nativePose;
      }
      radius = nativePose.radius as number;
    }
    const matrix = this.effectivePoseMatrix(
      adapter,
      frame,
      rawGetPose,
      joint,
      baseSpace,
      true,
    );
    if (!matrix) {
      this.note(
        'A synthetic joint pose could not be resolved in the requested base space.',
      );
      return null;
    }
    return this.createJointPoseFacade(matrix, radius);
  }

  private handleFillJointRadii(
    frame: XRFrame,
    nativeMethod: NativeFillJointRadii,
    jointSpaces: Iterable<XRJointSpace>,
    radii: Float32Array,
  ): boolean {
    const spaces = Array.from(jointSpaces);
    if (!this.installedState) {
      return nativeMethod.call(frame, spaces, radii);
    }
    if (!spaces.some((space) => this.spaces.has(space))) {
      return nativeMethod.call(frame, spaces, radii);
    }
    // WebIDL converts every sequence element before the frame algorithm runs.
    // Mirror that ordering for synthetic spaces, even on an inactive frame.
    for (const space of spaces) {
      const info = this.spaces.get(space);
      if (info && !info.joint) {
        throw new TypeError(
          "Failed to execute 'fillJointRadii' on 'XRFrame': an element of jointSpaces is not of type 'XRJointSpace'.",
        );
      }
    }
    const adapter = this.adapterForFrame(frame);
    if (!adapter) {
      throw invalidState(
        'IWER-controlled joint radii were queried from a frame owned by another native session.',
      );
    }
    this.assertFrameActive(adapter, frame, 'fillJointRadii');
    for (const space of spaces) {
      const info = this.spaces.get(space);
      if (info && info.adapter !== adapter) {
        throw invalidState(
          'An IWER-controlled joint space belongs to a different native session.',
        );
      }
    }
    if (spaces.length > radii.length) {
      throw new TypeError(
        'The length of jointSpaces is larger than the number of elements in radii.',
      );
    }
    let allValid = true;
    for (let index = 0; index < spaces.length; index++) {
      const info = this.spaces.get(spaces[index]);
      if (info?.joint && info.adapter === adapter) {
        const radius = info.joint.source[P_JOINT_SPACE].radius;
        if (isTrackedRadius(radius)) {
          radii[index] = radius;
        } else {
          radii[index] = NaN;
          allValid = false;
        }
      } else {
        // Browser-tracked joints keep native semantics, including any error the
        // native implementation raises for this frame.
        const valid = nativeMethod.call(frame, [spaces[index]], scratchRadius);
        radii[index] = valid ? scratchRadius[0] : NaN;
        allValid &&= valid;
      }
    }
    return allValid;
  }

  private handleFillPoses(
    frame: XRFrame,
    nativeMethod: NativeFillPoses,
    spaces: Iterable<XRSpace>,
    baseSpace: XRSpace,
    transforms: Float32Array,
  ): boolean {
    const spaceList = Array.from(spaces);
    if (!this.installedState) {
      return nativeMethod.call(frame, spaceList, baseSpace, transforms);
    }
    const baseInfo = this.spaces.get(baseSpace);
    const hasOverride =
      Boolean(baseInfo) || spaceList.some((space) => this.spaces.has(space));
    if (!hasOverride) {
      return nativeMethod.call(frame, spaceList, baseSpace, transforms);
    }
    const adapter = this.adapterForFrame(frame);
    if (!adapter) {
      throw invalidState(
        'IWER-controlled poses were queried from a frame owned by another native session.',
      );
    }
    this.assertFrameActive(adapter, frame, 'fillPoses');
    if (
      (baseInfo && baseInfo.adapter !== adapter) ||
      spaceList.some((space) => {
        const info = this.spaces.get(space);
        return info != null && info.adapter !== adapter;
      })
    ) {
      throw invalidState(
        'An IWER-controlled space belongs to a different native session.',
      );
    }
    if (transforms.length < spaceList.length * 16) {
      // WebXR specifies a TypeError for an output buffer that cannot hold one
      // 4x4 matrix per requested space.
      throw new TypeError(
        'The length of transforms is too small to hold a transform for every space.',
      );
    }
    const rawGetPose = this.nativeGetPose(frame);
    if (!rawGetPose) {
      return false;
    }
    let allValid = true;
    for (let index = 0; index < spaceList.length; index++) {
      const matrix = this.effectivePoseMatrix(
        adapter,
        frame,
        rawGetPose,
        spaceList[index],
        baseSpace,
        true,
      );
      if (!matrix) {
        allValid = false;
        continue;
      }
      copyMatrixToArray(matrix, transforms, index * 16);
    }
    return allValid;
  }

  private handleGetViewerPose(
    frame: XRFrame,
    nativeMethod: NativeGetViewerPose,
    referenceSpace: XRReferenceSpace,
  ): XRViewerPose | null | undefined {
    const nativePose = nativeMethod.call(frame, referenceSpace);
    const adapter = this.adapterForFrame(frame);
    if (!nativePose || !adapter || !this.installedState) {
      return nativePose;
    }
    const rawGetPose = this.nativeGetPose(frame);
    if (!rawGetPose) {
      return this.viewerOverrideFailure(
        'The native XRFrame.getPose implementation could not be recovered.',
      );
    }
    const overriddenViewer = this.viewerToBaseMatrix(
      adapter,
      frame,
      rawGetPose,
      referenceSpace,
    );
    if (!overriddenViewer) {
      return this.viewerOverrideFailure(
        'The overridden viewer pose could not be resolved in the requested reference space.',
      );
    }

    const rawViewerTransform = this.readNativeTransform(nativePose);
    if (!rawViewerTransform) {
      return this.viewerOverrideFailure(
        'The browser-owned XRViewerPose transform could not be read.',
      );
    }
    const rawViewer = matrixFromTransform(rawViewerTransform);
    const overriddenObjects: object[] = [];
    if (
      !this.overrideTransform(
        adapter,
        nativePose,
        this.rigidTransformFromMatrix(overriddenViewer),
      )
    ) {
      return this.viewerOverrideFailure(
        'The browser-owned XRViewerPose transform could not be overridden.',
      );
    }
    overriddenObjects.push(nativePose);

    const inverseRawViewer = mat4.invert(scratchRelativeView, rawViewer);
    if (!inverseRawViewer) {
      this.clearTransformOverrides(overriddenObjects);
      return this.viewerOverrideFailure(
        'The browser-owned XRViewerPose transform was not invertible.',
      );
    }
    for (const view of nativePose.views) {
      const rawViewTransform = this.readNativeTransform(view);
      if (!rawViewTransform) {
        this.clearTransformOverrides(overriddenObjects);
        return this.viewerOverrideFailure(
          'A browser-owned XRView transform could not be read.',
        );
      }
      const rawView = matrixFromTransform(rawViewTransform);
      const relative = mat4.create();
      mat4.multiply(relative, inverseRawViewer, rawView);
      const overriddenView = mat4.create();
      mat4.multiply(overriddenView, overriddenViewer, relative);
      if (
        !this.overrideTransform(
          adapter,
          view,
          this.rigidTransformFromMatrix(overriddenView),
        )
      ) {
        this.clearTransformOverrides(overriddenObjects);
        return this.viewerOverrideFailure(
          'A browser-owned XRView transform could not be overridden.',
        );
      }
      overriddenObjects.push(view);
    }
    this.capabilityState.viewerPose = true;
    this.capabilityState.viewTransforms = true;
    this.capabilityState.phase = 'active';
    return nativePose;
  }

  private viewerOverrideFailure(message: string): null {
    this.note(message);
    return null;
  }

  private effectivePoseMatrix(
    adapter: NativeSessionAdapter,
    frame: XRFrame,
    nativeGetPose: NativeGetPose,
    space: XRSpace,
    baseSpace: XRSpace,
    includeNative = false,
  ): mat4 | null {
    const targetInfo = this.spaces.get(space);
    const baseInfo = this.spaces.get(baseSpace);
    if (
      (targetInfo && targetInfo.adapter !== adapter) ||
      (baseInfo && baseInfo.adapter !== adapter)
    ) {
      return null;
    }
    if (!targetInfo && !baseInfo && !includeNative) {
      return null;
    }

    const targetToAnchor = targetInfo
      ? this.controlledSpaceToAnchor(targetInfo, scratchTargetMatrix)
      : this.nativePoseMatrix(
          nativeGetPose.call(frame, space, adapter.anchorSpace),
        );
    if (!targetToAnchor) {
      return null;
    }

    let anchorToBase: mat4 | null;
    if (baseInfo) {
      const baseToAnchor = this.controlledSpaceToAnchor(
        baseInfo,
        scratchBaseToAnchor,
      );
      anchorToBase = baseToAnchor
        ? mat4.invert(scratchAnchorToBase, baseToAnchor)
        : null;
    } else {
      anchorToBase = this.anchorToNativeBase(
        adapter,
        frame,
        nativeGetPose,
        baseSpace,
      );
    }
    if (!anchorToBase) {
      return null;
    }
    return mat4.clone(
      mat4.multiply(scratchResultMatrix, anchorToBase, targetToAnchor),
    );
  }

  private viewerToBaseMatrix(
    adapter: NativeSessionAdapter,
    frame: XRFrame,
    nativeGetPose: NativeGetPose,
    baseSpace: XRReferenceSpace,
  ): mat4 | null {
    const viewerToAnchor = this.viewerMatrix(scratchViewerMatrix);
    const baseInfo = this.spaces.get(baseSpace);
    let anchorToBase: mat4 | null;
    if (baseInfo) {
      if (baseInfo.adapter !== adapter) {
        return null;
      }
      const baseToAnchor = this.controlledSpaceToAnchor(
        baseInfo,
        scratchBaseToAnchor,
      );
      anchorToBase = baseToAnchor
        ? mat4.invert(scratchAnchorToBase, baseToAnchor)
        : null;
    } else {
      anchorToBase = this.anchorToNativeBase(
        adapter,
        frame,
        nativeGetPose,
        baseSpace,
      );
    }
    if (!anchorToBase) {
      return null;
    }
    return mat4.clone(
      mat4.multiply(scratchResultMatrix, anchorToBase, viewerToAnchor),
    );
  }

  private controlledSpaceToAnchor(
    info: ControlledSpace,
    output: mat4,
  ): mat4 | null {
    if (!info.origin) {
      mat4.identity(output);
    } else {
      const source = info.origin();
      if (!source) {
        return null;
      }
      XRSpaceUtils.calculateGlobalOffsetMatrix(source, output);
    }
    mat4.multiply(output, output, info.localOffset);
    return output;
  }

  private viewerMatrix(output: mat4): mat4 {
    return XRSpaceUtils.calculateGlobalOffsetMatrix(
      this.currentViewerSpace(),
      output,
    );
  }

  private anchorToNativeBase(
    adapter: NativeSessionAdapter,
    frame: XRFrame,
    nativeGetPose: NativeGetPose,
    baseSpace: XRSpace,
  ): mat4 | null {
    if (adapter.baseSpaceCache.has(baseSpace)) {
      const cached = adapter.baseSpaceCache.get(baseSpace);
      return cached ? mat4.clone(cached) : null;
    }
    const pose = nativeGetPose.call(frame, adapter.anchorSpace, baseSpace);
    const matrix = this.nativePoseMatrix(pose);
    adapter.baseSpaceCache.set(baseSpace, matrix ? mat4.clone(matrix) : null);
    return matrix;
  }

  private nativePoseMatrix(pose: XRPose | null | undefined): mat4 | null {
    if (!pose) {
      return null;
    }
    const transform = this.readNativeTransform(pose);
    return transform ? matrixFromTransform(transform) : null;
  }

  private createPoseFacade(matrix: mat4): XRPose {
    const prototype = this.constructorPrototype('XRPose');
    const pose = Object.create(prototype ?? Object.prototype) as object;
    Object.defineProperties(pose, this.poseProperties(matrix));
    return pose as XRPose;
  }

  private createJointPoseFacade(matrix: mat4, radius: number): XRJointPose {
    const prototype =
      this.constructorPrototype('XRJointPose') ??
      this.constructorPrototype('XRPose');
    const pose = Object.create(prototype ?? Object.prototype) as object;
    Object.defineProperties(pose, {
      ...this.poseProperties(matrix),
      radius: { configurable: true, enumerable: true, value: radius },
    });
    return pose as XRJointPose;
  }

  private poseProperties(matrix: mat4): PropertyDescriptorMap {
    return {
      transform: {
        configurable: true,
        enumerable: true,
        value: this.rigidTransformFromMatrix(matrix),
      },
      emulatedPosition: {
        configurable: true,
        enumerable: true,
        value: false,
      },
      linearVelocity: {
        configurable: true,
        enumerable: true,
        value: null,
      },
      angularVelocity: {
        configurable: true,
        enumerable: true,
        value: null,
      },
    };
  }

  private rigidTransformFromMatrix(matrix: mat4): XRRigidTransform {
    mat4.getTranslation(scratchPosition, matrix);
    mat4.getRotation(scratchOrientation, matrix);
    return new (this.getRigidTransformConstructor())(
      {
        x: scratchPosition[0],
        y: scratchPosition[1],
        z: scratchPosition[2],
        w: 1,
      },
      {
        x: scratchOrientation[0],
        y: scratchOrientation[1],
        z: scratchOrientation[2],
        w: scratchOrientation[3],
      },
    );
  }

  private getRigidTransformConstructor(): NativeRigidTransformConstructor {
    const constructor = globalRecord(this.globalObject).XRRigidTransform;
    if (typeof constructor !== 'function') {
      throw new Error('Native XRRigidTransform constructor is unavailable.');
    }
    return constructor as NativeRigidTransformConstructor;
  }

  private readNativeTransform(object: object): XRRigidTransform | null {
    let reader = this.transformReaders.get(object);
    if (!reader) {
      const found = methodDescriptor(object, 'transform');
      if (!found) {
        return null;
      }
      let nativeGetter = this.rawTransformGetters.get(found.owner);
      if (!nativeGetter && found.descriptor.get) {
        nativeGetter = found.descriptor.get as (
          this: object,
        ) => XRRigidTransform;
        this.rawTransformGetters.set(found.owner, nativeGetter);
      }
      if (nativeGetter) {
        reader = () => nativeGetter!.call(object);
      } else if ('value' in found.descriptor) {
        const value = found.descriptor.value as XRRigidTransform;
        reader = () => value;
      } else {
        return null;
      }
      this.transformReaders.set(object, reader);
    }
    try {
      return reader();
    } catch {
      return null;
    }
  }

  private overrideTransform(
    adapter: NativeSessionAdapter,
    object: object,
    transform: XRRigidTransform,
  ): boolean {
    const reader = this.readNativeTransform(object);
    if (!reader) {
      return false;
    }
    this.transformOverrides.set(object, { epoch: this.epoch, transform });
    const found = methodDescriptor(object, 'transform');
    if (!found) {
      return false;
    }
    if (
      found.owner !== object &&
      this.patchedTransformOwners.has(found.owner)
    ) {
      return true;
    }
    const nativeGetter = this.rawTransformGetters.get(found.owner);
    if (
      found.owner !== object &&
      nativeGetter &&
      found.descriptor.configurable !== false
    ) {
      const owner = this;
      const patched = this.patches.define(found.owner, 'transform', {
        ...found.descriptor,
        get(this: object) {
          const current = owner.transformOverrides.get(this);
          if (
            owner.installedState &&
            current &&
            current.epoch === owner.epoch
          ) {
            return current.transform;
          }
          return nativeGetter.call(this);
        },
      });
      if (patched) {
        this.patchedTransformOwners.add(found.owner);
        return true;
      }
    }

    if (this.instancePatchedTransformEpochs.get(object) === this.epoch) {
      return true;
    }
    const owner = this;
    const patched = adapter.instancePatches.define(object, 'transform', {
      configurable: true,
      get(this: object) {
        const current = owner.transformOverrides.get(this);
        if (owner.installedState && current && current.epoch === owner.epoch) {
          return current.transform;
        }
        return owner.transformReaders.get(this)?.();
      },
    });
    if (patched) {
      this.instancePatchedTransformEpochs.set(object, this.epoch);
      return true;
    }
    this.transformOverrides.delete(object);
    return false;
  }

  private clearTransformOverrides(objects: object[]): void {
    for (const object of objects) {
      this.transformOverrides.delete(object);
    }
  }

  private nativeGetPose(frame: XRFrame): NativeGetPose | null {
    const direct = this.rawGetPoseByFrame.get(frame);
    if (direct) {
      return direct;
    }
    const found = methodDescriptor(frame, 'getPose');
    return found ? (this.rawGetPoseByOwner.get(found.owner) ?? null) : null;
  }

  // ===========================================================================
  // Anchors
  // ===========================================================================

  private handleCreateAnchor(
    frame: XRFrame,
    nativeMethod: NativeCreateAnchor,
    pose: XRRigidTransform,
    space: XRSpace,
  ): Promise<XRAnchor> {
    if (!this.installedState) {
      return nativeMethod.call(frame, pose, space);
    }
    const info = this.spaces.get(space);
    if (!info) {
      return nativeMethod.call(frame, pose, space);
    }
    try {
      const adapter = this.adapterForFrame(frame);
      if (!adapter || adapter.ended) {
        throw invalidState(
          'The IWER-controlled anchor space belongs to a different native session.',
        );
      }
      this.assertFrameActive(adapter, frame, 'createAnchor');
      if (adapter !== info.adapter) {
        throw invalidState(
          'The IWER-controlled anchor space belongs to a different native session.',
        );
      }
      if (!adapter.createAnchorAvailable) {
        throw new DOMException(
          'Anchors in IWER-controlled spaces are unavailable because XRFrame.createAnchor could not be overridden.',
          'NotSupportedError',
        );
      }
      const controlledToAnchor = this.controlledSpaceToAnchor(
        info,
        scratchControlledMatrix,
      );
      if (!controlledToAnchor) {
        throw invalidState(
          'The IWER-controlled anchor space could not be resolved for this frame.',
        );
      }
      // anchorSpace_from_anchor = anchorSpace_from_controlled * controlled_from_anchor
      const composed = mat4.multiply(
        mat4.create(),
        controlledToAnchor,
        matrixFromTransform(pose),
      );
      const translated = this.rigidTransformFromMatrix(composed);
      this.capabilityState.anchors = true;
      // Native feature errors and inactive-frame errors stay authoritative.
      return nativeMethod.call(frame, translated, adapter.anchorSpace);
    } catch (error) {
      // Promise-returning WebIDL operations report validation failures through
      // rejection rather than throwing synchronously.
      return Promise.reject(error);
    }
  }

  // ===========================================================================
  // Hit testing
  // ===========================================================================

  private handleRequestHitTestSource(
    session: XRSession,
    nativeMethod: NativeRequestHitTestSource,
    options: XRHitTestOptionsInit,
  ): Promise<XRHitTestSource> | undefined {
    const info =
      this.installedState && options ? this.spaces.get(options.space) : null;
    if (!info) {
      return nativeMethod.call(session, options);
    }
    const adapter = this.sessionsByObject.get(session);
    if (!adapter || adapter !== info.adapter || adapter.ended) {
      return Promise.reject(
        invalidState(
          'The IWER-controlled hit test space belongs to a different native session.',
        ),
      );
    }
    if (!adapter.hitTestResultsAvailable) {
      return Promise.reject(
        new DOMException(
          'Hit test sources in IWER-controlled spaces are unavailable because XRFrame.getHitTestResults could not be overridden.',
          'NotSupportedError',
        ),
      );
    }
    const matrix = this.controlledSpaceToAnchor(info, scratchHitTestMatrix);
    if (!matrix) {
      return Promise.reject(
        invalidState(
          'The IWER-controlled hit test space could not be resolved.',
        ),
      );
    }
    const binding: HitTestBinding = {
      adapter,
      facade: undefined as unknown as XRHitTestSource,
      space: options.space,
      // Copy the caller's dictionary: WebXR treats it as by-value, and it is
      // replayed on every resubscribe long after the call returns.
      requestedOptions: {
        ...options,
        entityTypes: options.entityTypes
          ? Array.from(options.entityTypes)
          : undefined,
      },
      nativeMethod,
      current: null,
      currentMatrix: null,
      pendingMatrix: null,
      pendingToken: 0,
      failures: 0,
      backoffFrames: 0,
      cancelled: false,
    };
    binding.facade = this.createHitTestSourceFacade(binding);
    adapter.hitTests.add(binding);
    this.hitTestBindings.set(binding.facade, binding);
    this.capabilityState.hitTest = true;
    return this.requestBackingSource(binding, matrix).then(
      () => binding.facade,
      (error) => {
        this.disposeHitTestBinding(binding);
        throw error;
      },
    );
  }

  private createHitTestSourceFacade(binding: HitTestBinding): XRHitTestSource {
    const prototype = this.constructorPrototype('XRHitTestSource');
    const facade = Object.create(prototype ?? Object.prototype) as object;
    Object.defineProperty(facade, 'cancel', {
      configurable: true,
      writable: true,
      value: () => {
        if (binding.cancelled) {
          throw invalidState(
            'The IWER-controlled hit test source has already been cancelled.',
          );
        }
        this.disposeHitTestBinding(binding);
      },
    });
    return facade as XRHitTestSource;
  }

  /**
   * Subscribes a fresh native hit test source at the given anchor-relative
   * pose, swapping it in only once the browser resolves it. The previous
   * subscription keeps serving results throughout, and survives a failure, so
   * the facade never goes blank once it has resolved a subscription.
   */
  private requestBackingSource(
    binding: HitTestBinding,
    matrix: mat4,
  ): Promise<void> {
    const token = ++binding.pendingToken;
    binding.pendingMatrix = mat4.clone(matrix);
    const adapter = binding.adapter;
    let request: Promise<XRHitTestSource>;
    try {
      const space = this.createDetachedOffsetSpace(adapter, matrix);
      request = Promise.resolve(
        binding.nativeMethod.call(adapter.session, {
          ...binding.requestedOptions,
          space,
        }) as Promise<XRHitTestSource>,
      );
    } catch (error) {
      request = Promise.reject(error);
    }
    return request.then(
      (source) => {
        if (
          token !== binding.pendingToken ||
          binding.cancelled ||
          adapter.ended ||
          !this.installedState
        ) {
          this.cancelNativeHitTestSource(source);
          return;
        }
        const replaced = binding.current;
        binding.current = source;
        binding.currentMatrix = binding.pendingMatrix;
        binding.pendingMatrix = null;
        binding.failures = 0;
        binding.backoffFrames = 0;
        this.cancelNativeHitTestSource(replaced);
      },
      (error) => {
        if (token === binding.pendingToken && !binding.cancelled) {
          binding.pendingMatrix = null;
          binding.failures += 1;
          // Keep the last subscription that did work. A failed replacement is
          // usually transient (tracking loss, a frame without an AR plane), and
          // discarding a working subscription would turn it into data loss.
          binding.backoffFrames = Math.min(
            2 ** Math.min(binding.failures, 5),
            MAX_HIT_TEST_BACKOFF_FRAMES,
          );
        }
        throw error;
      },
    );
  }

  /**
   * Creates a world-locked native offset space at the given anchor-relative
   * pose. The space is deliberately untagged so native APIs treat it as an
   * ordinary browser space.
   */
  private createDetachedOffsetSpace(
    adapter: NativeSessionAdapter,
    matrix: mat4,
  ): XRSpace {
    const transform = this.rigidTransformFromMatrix(matrix);
    // Untag the anchor space for this one call so the derived space is a plain
    // browser space: it inherits no controlled metadata and needs no patching.
    const anchorInfo = this.spaces.get(adapter.anchorSpace);
    this.spaces.delete(adapter.anchorSpace);
    try {
      return adapter.anchorSpace.getOffsetReferenceSpace(transform) as XRSpace;
    } finally {
      if (anchorInfo) {
        this.spaces.set(adapter.anchorSpace, anchorInfo);
      }
    }
  }

  private updateHitTestSources(adapter: NativeSessionAdapter): void {
    if (adapter.hitTests.size === 0) {
      return;
    }
    for (const binding of Array.from(adapter.hitTests)) {
      if (binding.cancelled) {
        continue;
      }
      // Exactly one replacement is ever in flight, so a space that moves every
      // frame costs one subscription per round trip rather than one per frame.
      if (binding.pendingMatrix) {
        continue;
      }
      if (binding.backoffFrames > 0) {
        binding.backoffFrames -= 1;
        continue;
      }
      const info = this.spaces.get(binding.space);
      if (!info) {
        continue;
      }
      const matrix = this.controlledSpaceToAnchor(info, scratchHitTestMatrix);
      if (!matrix) {
        continue;
      }
      if (
        binding.currentMatrix &&
        poseWithinTolerance(binding.currentMatrix, matrix)
      ) {
        continue;
      }
      void this.requestBackingSource(binding, matrix).catch((error) => {
        this.note(
          `A native hit test subscription could not follow its IWER-controlled space: ${this.errorText(
            error,
          )}`,
          'hit-test-resubscribe-failed',
        );
      });
    }
  }

  private handleGetHitTestResults(
    frame: XRFrame,
    nativeMethod: NativeGetHitTestResults,
    hitTestSource: XRHitTestSource,
  ): XRHitTestResult[] {
    if (!this.installedState) {
      return nativeMethod.call(frame, hitTestSource);
    }
    const binding = this.hitTestBindings.get(hitTestSource);
    if (!binding) {
      return nativeMethod.call(frame, hitTestSource);
    }
    if (binding.cancelled) {
      throw invalidState(
        'The IWER-controlled hit test source has been cancelled.',
      );
    }
    const adapter = this.adapterForFrame(frame);
    if (!adapter || adapter !== binding.adapter) {
      throw invalidState(
        'The IWER-controlled hit test source belongs to a different native session.',
      );
    }
    if (adapter.framesInstrumented && adapter.activeFrame !== frame) {
      throw invalidState(
        "Failed to execute 'getHitTestResults' on 'XRFrame': the frame is not active.",
      );
    }
    if (!binding.current) {
      return [];
    }
    // Serve the last subscription the browser actually resolved, including
    // while a replacement is in flight. Its pose trails the controlled space by
    // at most the resubscribe tolerance plus one round trip, which is far more
    // useful than reporting nothing.
    return nativeMethod.call(frame, binding.current);
  }

  private cancelNativeHitTestSource(
    source: XRHitTestSource | null | undefined,
  ): void {
    if (!source) {
      return;
    }
    try {
      source.cancel();
    } catch {
      // A session that already ended cancels its own subscriptions.
    }
  }

  private disposeHitTestBinding(binding: HitTestBinding): void {
    binding.cancelled = true;
    binding.pendingToken += 1;
    binding.pendingMatrix = null;
    this.cancelNativeHitTestSource(binding.current);
    binding.current = null;
    binding.currentMatrix = null;
    binding.adapter.hitTests.delete(binding);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  private adapterForFrame(frame: XRFrame): NativeSessionAdapter | null {
    const tagged = this.frameSessions.get(frame);
    if (tagged && !tagged.ended) {
      return tagged;
    }
    try {
      return this.sessionsByObject.get(frame.session) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Throws if the frame is no longer the one its session owns. Browser spaces
   * already get this for free because the native call raises, but a query that
   * only touches IWER-controlled spaces never reaches the browser, and
   * answering it would let a stashed frame silently report live poses.
   */
  private assertFrameActive(
    adapter: NativeSessionAdapter,
    frame: XRFrame,
    method: string,
  ): void {
    if (!adapter.framesInstrumented) {
      return;
    }
    if (adapter.activeFrame !== frame) {
      throw invalidState(
        `Failed to execute '${method}' on 'XRFrame': the frame is not active.`,
      );
    }
  }

  private constructorPrototype(name: string): object | null {
    const constructor = globalRecord(this.globalObject)[name] as
      | { prototype?: object }
      | undefined;
    return constructor?.prototype ?? null;
  }

  private detachSession(session: XRSession): void {
    const adapter = this.sessionsByObject.get(session);
    if (adapter) {
      this.detachAdapter(adapter);
    }
  }

  private detachAdapter(
    adapter: NativeSessionAdapter,
    announceNativeInputTransition = false,
  ): void {
    if (adapter.ended) {
      return;
    }
    const removedSources = [...adapter.sources];
    adapter.ended = true;
    for (const cleanup of adapter.cleanupListeners.splice(0)) {
      try {
        cleanup();
      } catch {
        // A hostile EventTarget must not prevent the remaining patches and
        // runtime state from being restored.
      }
    }
    for (const binding of Array.from(adapter.hitTests)) {
      this.disposeHitTestBinding(binding);
    }
    adapter.instancePatches.revert();
    adapter.patches.revert();
    adapter.baseSpaceCache.clear();
    adapter.activeFrame = null;
    this.sessionsByObject.delete(adapter.session);

    if (announceNativeInputTransition) {
      // uninstall() keeps the browser session alive. Once its native getter has
      // been restored, announce both sides of the membership transition so
      // event-driven consumers release synthetic facades and discover the
      // browser's real input sources. Session-end cleanup intentionally skips
      // this event because the session itself is no longer usable.
      let addedSources: XRInputSource[] = [];
      try {
        addedSources = Array.from(adapter.session.inputSources);
      } catch {
        // A hostile native getter must not make teardown fail.
      }
      if (addedSources.length > 0 || removedSources.length > 0) {
        try {
          this.dispatchInputSourcesChange(
            adapter,
            addedSources,
            removedSources,
          );
        } catch {
          // Event construction or dispatch must not make teardown fail.
        }
      }
    }

    adapter.sources = Object.freeze([]);
    adapter.deviceBindings.splice(0);
    adapter.playbackBindings.clear();
    adapter.bindingByFacade.clear();
    adapter.spaceTokens.clear();
    adapter.pendingEvents.length = 0;
    adapter.retainedSources.clear();
    this.liveSessions.delete(adapter);
    if (this.primarySession === adapter) {
      this.primarySession = this.liveSessions.values().next().value ?? null;
      this.lastPrimaryTime = undefined;
    }
    if (this.liveSessions.size === 0) {
      this.unwirePlayer();
      this.playbackFrame = null;
      this.device.remote.forceRelease();
    }
  }

  private resetPatchTracking(): void {
    this.sessionsByObject = new WeakMap();
    this.frameSessions = new WeakMap();
    this.spaces = new WeakMap();
    this.hitTestBindings = new WeakMap();
    this.syntheticEvents = new WeakSet();
    this.patchedFrameOwners = new WeakSet();
    this.patchedViewerFrameOwners = new WeakSet();
    this.patchedFillPosesOwners = new WeakSet();
    this.patchedJointPoseOwners = new WeakSet();
    this.patchedJointRadiiOwners = new WeakSet();
    this.patchedReferenceSpaceOwners = new WeakSet();
    this.patchedInputSourceOwners = new WeakSet();
    this.patchedRafOwners = new WeakSet();
    this.patchedRequestReferenceSpaceOwners = new WeakSet();
    this.instancePatchedReferenceSpaces = new WeakSet();
    this.patchedHitTestOwners = new WeakSet();
    this.patchedHitTestResultOwners = new WeakSet();
    this.patchedCreateAnchorOwners = new WeakSet();
    this.rawGetPoseByOwner = new WeakMap();
    this.rawGetPoseByFrame = new WeakMap();
    this.rawRafByOwner = new WeakMap();
    this.rawRequestReferenceSpaceByOwner = new WeakMap();
    this.rawTransformGetters = new WeakMap();
    this.transformReaders = new WeakMap();
    this.transformOverrides = new WeakMap();
    this.patchedTransformOwners = new WeakSet();
    this.instancePatchedFrameEpochs = new WeakMap();
    this.instancePatchedTransformEpochs = new WeakMap();
    this.lastPrimaryTime = undefined;
  }

  private unsupportedForSession(
    adapter: NativeSessionAdapter,
    message: string,
  ): void {
    if (this.options.onUnsupported === 'throw') {
      this.detachAdapter(adapter);
      throw new Error(message);
    }
    this.note(message);
  }

  private unsupported(message: string): void {
    this.capabilityState.supported = false;
    this.note(message);
    if (this.options.onUnsupported === 'throw') {
      throw new Error(message);
    }
  }

  private note(message: string, key = message): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    this.capabilityState.notes.push(message);
    console.warn(`[IWER native override] ${message}`);
  }

  private errorText(error: unknown): string {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

/** Installs a native override and returns its lifecycle handle. */
export function installNativeOverride(
  device: XRDevice,
  options?: NativeOverrideOptions,
): XRNativeOverride {
  const override = new XRNativeOverride(device, options);
  override.install();
  return override;
}
