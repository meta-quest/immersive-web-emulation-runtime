/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import {
  ActionPlayer,
  type CompressedRecording,
} from '../../src/action/ActionPlayer.js';
import type { InputSchema } from '../../src/action/ActionRecorder.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import { GamepadMappingType } from '../../src/gamepad/Gamepad.js';
import { XRHandJoint as IwerHandJoint } from '../../src/input/XRHand.js';
import { P_JOINT_SPACE, P_SPACE } from '../../src/private.js';
import {
  XRReferenceSpace as IwerReferenceSpace,
  XRReferenceSpaceType as IwerReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { GlobalSpace, XRSpaceUtils } from '../../src/spaces/XRSpace.js';
import {
  getNativeOverride,
  getNativeOverrideSupport,
  installNativeOverride,
  XRNativeOverride,
} from '../../src/native/XRNativeOverride.js';

type FrameCallback = (time: DOMHighResTimeStamp, frame: MockFrame) => void;

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function point(x = 0, y = 0, z = 0, w = 1): DOMPointReadOnly {
  return { x, y, z, w } as DOMPointReadOnly;
}

class MockRigidTransform {
  readonly position: DOMPointReadOnly;
  readonly orientation: DOMPointReadOnly;
  readonly matrix: Float32Array;

  constructor(position: DOMPointInit = {}, orientation: DOMPointInit = {}) {
    this.position = point(position.x, position.y, position.z, position.w);
    this.orientation = point(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w ?? 1,
    );
    this.matrix = new Float32Array(16);
    mat4.fromRotationTranslation(
      this.matrix,
      quat.fromValues(
        this.orientation.x,
        this.orientation.y,
        this.orientation.z,
        this.orientation.w,
      ),
      vec3.fromValues(this.position.x, this.position.y, this.position.z),
    );
  }

  static fromMatrix(matrix: mat4): MockRigidTransform {
    const position = vec3.create();
    const orientation = quat.create();
    mat4.getTranslation(position, matrix);
    mat4.getRotation(orientation, matrix);
    return new MockRigidTransform(
      { x: position[0], y: position[1], z: position[2], w: 1 },
      {
        x: orientation[0],
        y: orientation[1],
        z: orientation[2],
        w: orientation[3],
      },
    );
  }
}

class MockSpace {
  constructor(readonly toAnchor: mat4 = mat4.create()) {}

  getOffsetReferenceSpace(originOffset: MockRigidTransform): MockSpace {
    const matrix = mat4.create();
    mat4.multiply(matrix, this.toAnchor, originOffset.matrix);
    return new MockSpace(matrix);
  }
}

/** Browser-tracked joint space, used to exercise mixed joint queries. */
class MockNativeJointSpace extends MockSpace {
  constructor(
    readonly jointName: string,
    readonly radius: number,
    toAnchor: mat4 = mat4.create(),
  ) {
    super(toAnchor);
  }
}

class MockHitTestSource {
  cancelled = false;

  constructor(readonly space: MockSpace) {}

  cancel(): void {
    this.cancelled = true;
  }
}

class MockPose {
  emulatedPosition = false;

  constructor(private nativeTransform: MockRigidTransform) {}

  get transform(): MockRigidTransform {
    return this.nativeTransform;
  }

  setNativeTransform(transform: MockRigidTransform): void {
    this.nativeTransform = transform;
  }
}

class MockView {
  readonly projectionMatrix = new Float32Array([1, 0, 0, 0, 0, 1]);

  constructor(
    readonly eye: 'left' | 'right',
    private nativeTransform: MockRigidTransform,
  ) {}

  get transform(): MockRigidTransform {
    return this.nativeTransform;
  }

  setNativeTransform(transform: MockRigidTransform): void {
    this.nativeTransform = transform;
  }
}

class MockViewerPose extends MockPose {
  readonly views: readonly MockView[];

  constructor(transform: MockRigidTransform, views: readonly MockView[]) {
    super(transform);
    this.views = views;
  }
}

class MockFrame {
  trackingAvailable = true;
  readonly untrackedSpaces = new Set<MockSpace>();
  anchorFailure: Error | null = null;
  /**
   * WebXR marks an XRFrame inactive as soon as its animation frame callback
   * returns, and every accessor throws InvalidStateError afterwards. Modelling
   * that is what makes stale-frame regressions observable in these tests.
   */
  active = false;
  readonly anchorRequests: Array<{
    pose: MockRigidTransform;
    space: MockSpace;
  }> = [];
  private readonly leftView = new MockView(
    'left',
    new MockRigidTransform({ x: 9.97, y: 2, z: 3 }),
  );
  private readonly rightView = new MockView(
    'right',
    new MockRigidTransform({ x: 10.03, y: 2, z: 3 }),
  );
  readonly viewerPose = new MockViewerPose(
    new MockRigidTransform({ x: 10, y: 2, z: 3 }),
    [this.leftView, this.rightView],
  );

  constructor(readonly session: MockSession) {}

  private assertActive(method: string): void {
    if (!this.active) {
      throw new DOMException(
        `Failed to execute '${method}' on 'XRFrame': the frame is not active.`,
        'InvalidStateError',
      );
    }
  }

  getPose(space: MockSpace, baseSpace: MockSpace): MockPose | null | undefined {
    this.assertActive('getPose');
    if (!this.trackingAvailable || this.untrackedSpaces.has(space)) {
      return null;
    }
    const inverseBase = mat4.invert(mat4.create(), baseSpace.toAnchor);
    if (!inverseBase) {
      return undefined;
    }
    const result = mat4.multiply(mat4.create(), inverseBase, space.toAnchor);
    return new MockPose(MockRigidTransform.fromMatrix(result));
  }

  getViewerPose(baseSpace: MockSpace): MockViewerPose | undefined {
    this.assertActive('getViewerPose');
    const inverseBase = mat4.invert(mat4.create(), baseSpace.toAnchor);
    if (!inverseBase) {
      return undefined;
    }
    const nativeViewer = mat4.fromTranslation(
      mat4.create(),
      vec3.fromValues(10, 2, 3),
    );
    const viewerInBase = mat4.multiply(
      mat4.create(),
      inverseBase,
      nativeViewer,
    );
    this.viewerPose.setNativeTransform(
      MockRigidTransform.fromMatrix(viewerInBase),
    );
    for (const [view, x] of [
      [this.leftView, -0.03],
      [this.rightView, 0.03],
    ] as const) {
      const eyeOffset = mat4.fromTranslation(
        mat4.create(),
        vec3.fromValues(x, 0, 0),
      );
      const eyeInBase = mat4.multiply(mat4.create(), viewerInBase, eyeOffset);
      view.setNativeTransform(MockRigidTransform.fromMatrix(eyeInBase));
    }
    return this.viewerPose;
  }

  fillPoses(
    spaces: readonly MockSpace[],
    baseSpace: MockSpace,
    transforms: Float32Array,
  ): boolean {
    this.assertActive('fillPoses');
    for (let index = 0; index < spaces.length; index++) {
      const pose = this.getPose(spaces[index], baseSpace);
      if (!pose) {
        return false;
      }
      transforms.set(pose.transform.matrix, index * 16);
    }
    return true;
  }

  getJointPose(
    joint: MockNativeJointSpace,
    baseSpace: MockSpace,
  ): (MockPose & { radius: number }) | null {
    this.assertActive('getJointPose');
    const pose = this.getPose(joint, baseSpace);
    if (!pose) {
      return null;
    }
    return Object.assign(pose, { radius: joint.radius });
  }

  fillJointRadii(
    jointSpaces: readonly MockNativeJointSpace[],
    radii: Float32Array,
  ): boolean {
    this.assertActive('fillJointRadii');
    let allValid = true;
    jointSpaces.forEach((joint, index) => {
      radii[index] = joint.radius || NaN;
      allValid &&= Boolean(joint.radius);
    });
    return allValid;
  }

  createAnchor(
    pose: MockRigidTransform,
    space: MockSpace,
  ): Promise<{ delete(): void }> {
    this.assertActive('createAnchor');
    if (this.anchorFailure) {
      return Promise.reject(this.anchorFailure);
    }
    this.anchorRequests.push({ pose, space });
    return Promise.resolve({ delete: () => {} });
  }

  getHitTestResults(source: MockHitTestSource): object[] {
    this.assertActive('getHitTestResults');
    if (source.cancelled) {
      throw new DOMException(
        'The hit test source has been cancelled.',
        'InvalidStateError',
      );
    }
    return [{ source, space: source.space }];
  }
}

class MockSession extends EventTarget {
  visibilityState: XRVisibilityState = 'visible';
  readonly nativeInputSources = [{ handedness: 'right', native: true }];
  frame = new MockFrame(this);
  freshFrames = false;
  ownFrameMethods = false;
  readonly hitTestRequests: MockHitTestSource[] = [];
  readonly hitTestOptions: Array<{ entityTypes?: string[] }> = [];
  hitTestAttempts = 0;
  hitTestFailure: Error | null = null;
  endCalls = 0;
  private callbacks = new Map<number, FrameCallback>();
  private nextCallbackId = 1;

  constructor(
    readonly mode: XRSessionMode,
    readonly enabledFeatures: string[] = ['local-floor'],
  ) {
    super();
  }

  get inputSources(): readonly object[] {
    return this.nativeInputSources;
  }

  requestAnimationFrame(callback: FrameCallback): number {
    const id = this.nextCallbackId++;
    this.callbacks.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.callbacks.delete(id);
  }

  requestReferenceSpace(_type: XRReferenceSpaceType): Promise<MockSpace> {
    return Promise.resolve(new MockSpace());
  }

  requestHitTestSource(options: {
    space: MockSpace;
    entityTypes?: string[];
  }): Promise<MockHitTestSource> {
    this.hitTestAttempts += 1;
    this.hitTestOptions.push({ entityTypes: options.entityTypes });
    if (this.hitTestFailure) {
      return Promise.reject(this.hitTestFailure);
    }
    const source = new MockHitTestSource(options.space);
    this.hitTestRequests.push(source);
    return Promise.resolve(source);
  }

  fireFrame(time: number): void {
    const callbacks = Array.from(this.callbacks.values());
    this.callbacks.clear();
    if (this.freshFrames) {
      this.frame = new MockFrame(this);
      if (this.ownFrameMethods) {
        exposeFrameMethodsAsOwnProperties(this.frame);
      }
    }
    this.frame.active = true;
    try {
      for (const callback of callbacks) {
        callback(time, this.frame);
      }
    } finally {
      this.frame.active = false;
    }
  }

  setVisibility(state: XRVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }

  async end(): Promise<void> {
    this.endCalls += 1;
    this.dispatchEvent(new Event('end'));
  }
}

class LocalFallbackSession extends MockSession {
  readonly requestedReferenceSpaces: XRReferenceSpaceType[] = [];

  override requestReferenceSpace(
    type: XRReferenceSpaceType,
  ): Promise<MockSpace> {
    this.requestedReferenceSpaces.push(type);
    return type === 'local-floor'
      ? Promise.reject(new Error('local-floor unavailable'))
      : Promise.resolve(new MockSpace());
  }
}

class MockXRSystem {
  readonly requestedModes: XRSessionMode[] = [];
  lastSession: MockSession | null = null;

  constructor(readonly features: string[] = ['local-floor']) {}

  async requestSession(mode: XRSessionMode): Promise<MockSession> {
    this.requestedModes.push(mode);
    const session = new MockSession(mode, this.features);
    this.lastSession = session;
    return session;
  }
}

class LocalFallbackXRSystem extends MockXRSystem {
  override async requestSession(mode: XRSessionMode): Promise<MockSession> {
    this.requestedModes.push(mode);
    const session = new LocalFallbackSession(mode, this.features);
    this.lastSession = session;
    return session;
  }
}

class MockXRInputSource {}
class MockGamepad {}
class MockXRInputSourceEvent extends Event {}
class PrototypeFallbackXRSystem extends MockXRSystem {
  readonly sessions: MockSession[] = [];

  override async requestSession(mode: XRSessionMode): Promise<MockSession> {
    this.requestedModes.push(mode);
    const session = new MockSession(mode, this.features);
    Object.preventExtensions(session);
    this.sessions.push(session);
    this.lastSession = session;
    return session;
  }
}

class NoReferenceSpaceSession extends MockSession {
  override requestReferenceSpace(): Promise<MockSpace> {
    return Promise.reject(new Error('no reference spaces'));
  }
}

class NoReferenceSpaceXRSystem extends MockXRSystem {
  override async requestSession(mode: XRSessionMode): Promise<MockSession> {
    this.requestedModes.push(mode);
    const session = new NoReferenceSpaceSession(mode, this.features);
    this.lastSession = session;
    return session;
  }
}

class MockXRInputSourcesChangeEvent extends Event {}
class MockXRHand extends Map<string, unknown> {}
class MockXRJointSpace {}
class MockXRJointPose extends MockPose {}
class MockXRHitTestSource {}

function makeNativeGlobal(): typeof globalThis {
  const nativeGlobal = Object.create(globalThis) as Record<string, unknown>;
  Object.assign(nativeGlobal, {
    Event,
    Gamepad: MockGamepad,
    XRHand: MockXRHand,
    XRHitTestSource: MockXRHitTestSource,
    XRInputSource: MockXRInputSource,
    XRInputSourceEvent: MockXRInputSourceEvent,
    XRInputSourcesChangeEvent: MockXRInputSourcesChangeEvent,
    XRJointPose: MockXRJointPose,
    XRJointSpace: MockXRJointSpace,
    XRPose: MockPose,
    XRRigidTransform: MockRigidTransform,
  });
  return nativeGlobal as unknown as typeof globalThis;
}

const HAND_FEATURES = ['local-floor', 'hand-tracking'];
/** Mirrors MAX_HIT_TEST_BACKOFF_FRAMES in the implementation. */
const MAX_BACKOFF_FRAMES = 32;

function position(transform: {
  position: Pick<DOMPointReadOnly, 'x' | 'y' | 'z'>;
}): [number, number, number] {
  return [transform.position.x, transform.position.y, transform.position.z];
}

function publishInitialInputSources(session: MockSession, time = 0): void {
  session.requestAnimationFrame(() => {});
  session.fireFrame(time);
}

function exposeFrameMethodsAsOwnProperties(frame: MockFrame): void {
  for (const name of ['getPose', 'getViewerPose', 'fillPoses'] as const) {
    Object.defineProperty(frame, name, {
      configurable: true,
      writable: true,
      value: frame[name],
    });
  }
}

function exposeTransformAsOwnProperty(object: MockPose | MockView): void {
  let owner = Object.getPrototypeOf(object) as object | null;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'transform')) {
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  const descriptor = owner
    ? Object.getOwnPropertyDescriptor(owner, 'transform')
    : undefined;
  const getter = descriptor?.get;
  if (!getter) {
    throw new Error('Mock transform getter is unavailable');
  }
  Object.defineProperty(object, 'transform', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => getter.call(object),
  });
}

describe('XRNativeOverride', () => {
  let override: XRNativeOverride | undefined;

  afterEach(() => {
    override?.uninstall();
    override = undefined;
  });

  test('passes inline sessions through and attaches immersive sessions', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    const nativeGlobal = makeNativeGlobal();
    const environment = {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: nativeGlobal,
    };
    const support = getNativeOverrideSupport(environment);
    expect(support).toMatchObject({ supported: true, requestSession: true });
    expect(getNativeOverride(environment)).toBeNull();
    const originalRequestSession = nativeXR.requestSession;
    override = installNativeOverride(device, {
      ...environment,
      onUnsupported: 'throw',
    });
    expect(override.installed).toBe(true);
    expect(getNativeOverride(environment)).toBe(override);

    const inline = await nativeXR.requestSession('inline');
    expect(override.sessions).toHaveLength(0);
    expect(inline.inputSources).toBe(inline.nativeInputSources);

    const session = await nativeXR.requestSession('immersive-vr');
    expect(override.sessions).toHaveLength(1);
    expect(override.sessions[0]).toMatchObject({
      session,
      mode: 'immersive-vr',
      primary: true,
    });
    const initialSourceChanges: XRInputSourcesChangeEvent[] = [];
    session.addEventListener('inputsourceschange', (event) => {
      initialSourceChanges.push(event as XRInputSourcesChangeEvent);
    });
    expect(session.inputSources).toHaveLength(0);
    session.setVisibility('hidden');
    session.setVisibility('visible');
    expect(session.inputSources).toHaveLength(0);
    expect(initialSourceChanges).toHaveLength(0);
    publishInitialInputSources(session);
    expect(session.inputSources).toHaveLength(2);
    expect(session.inputSources).not.toContain(session.nativeInputSources[0]);
    expect(initialSourceChanges).toHaveLength(1);
    expect(Array.from(initialSourceChanges[0].added)).toEqual(
      Array.from(session.inputSources),
    );
    expect(Array.from(initialSourceChanges[0].removed)).toEqual([]);
    expect(override.capabilities.brandedInputEvents).toBe(false);
    const rightSource = session.inputSources.find(
      (source) => (source as XRInputSource).handedness === 'right',
    ) as XRInputSource;
    const axes = rightSource.gamepad!.axes;
    const buttons = rightSource.gamepad!.buttons;
    expect(rightSource.gamepad!.id).toBe('');
    expect(rightSource.gamepad!.index).toBe(-1);
    expect(axes).toEqual([0, 0, 0, 0]);
    expect(rightSource.gamepad!.axes).toBe(axes);
    expect(Object.isFrozen(axes)).toBe(true);
    expect(Object.isFrozen(buttons)).toBe(true);
    expect(Object.isFrozen(buttons[0])).toBe(true);
    expect(Reflect.set(axes, '0', 1)).toBe(false);
    expect(Reflect.set(buttons[0], 'value', 1)).toBe(false);

    device.controllers.right!.updateAxes('thumbstick', 0.5, -0.25);
    session.requestAnimationFrame(() => {});
    session.fireFrame(1);
    const updatedAxes = rightSource.gamepad!.axes;
    expect(updatedAxes).not.toBe(axes);
    expect(axes).toEqual([0, 0, 0, 0]);
    expect(updatedAxes).toContain(0.5);
    const spaces = session.inputSources.flatMap((source) => [
      (source as XRInputSource).targetRaySpace,
      (source as XRInputSource).gripSpace,
    ]);
    expect(new Set(spaces).size).toBe(4);

    // Constructing only an XRInputSourcesChangeEvent must not claim that
    // XRInputSourceEvent branding has succeeded.
    device.controllers.right!.connected = false;
    session.requestAnimationFrame(() => {});
    session.fireFrame(2);
    expect(override.capabilities.brandedInputEvents).toBe(false);

    await expect(device.remote.dispatch('accept_session')).rejects.toThrow(
      'app-driven',
    );
    await expect(
      device.remote.dispatch('get_session_status'),
    ).resolves.toMatchObject({
      sessionActive: true,
      sessionMode: 'immersive-vr',
    });

    override.uninstall();
    expect(nativeXR.requestSession).toBe(originalRequestSession);
    expect(session.inputSources).toBe(session.nativeInputSources);
    expect(getNativeOverride(environment)).toBeNull();
    await expect(
      device.remote.dispatch('get_session_status'),
    ).resolves.toMatchObject({ sessionActive: false });
  });

  test('recovers a lost handle and permits reinstallation', () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    const options = {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw' as const,
    };
    override = installNativeOverride(device, options);
    const recovered = getNativeOverride(options);
    expect(recovered?.installed).toBe(true);
    override = undefined;
    recovered?.uninstall();
    expect(getNativeOverride(options)).toBeNull();
    override = installNativeOverride(device, options);
    expect(override.installed).toBe(true);
  });

  test('recovers a foreign handle through the default native XR lookup', () => {
    const nativeXR = new MockXRSystem();
    const crossBundleKey = Symbol.for('@iwer/native-override');
    const uninstall = jest.fn();
    const foreignHandle = {
      installed: true,
      uninstall,
    };
    Object.defineProperty(nativeXR, crossBundleKey, {
      configurable: true,
      value: foreignHandle,
    });
    const previousXR = Object.getOwnPropertyDescriptor(navigator, 'xr');
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: nativeXR,
    });
    try {
      const recovered = getNativeOverride();
      expect(recovered).toBe(foreignHandle);
      recovered?.uninstall();
      expect(uninstall).toHaveBeenCalledTimes(1);
    } finally {
      if (previousXR) {
        Object.defineProperty(navigator, 'xr', previousXR);
      } else {
        Reflect.deleteProperty(navigator, 'xr');
      }
    }
  });

  test('ignores a malformed global marker during installation', () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    const options = {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw' as const,
    };
    Object.defineProperty(nativeXR, Symbol.for('@iwer/native-override'), {
      configurable: true,
      value: { notAHandle: true },
    });

    expect(getNativeOverride(options)).toBeNull();
    override = installNativeOverride(device, options);
    expect(override.installed).toBe(true);
    expect(getNativeOverride(options)).toBe(override);
  });

  test('rechecks support when a previously unsupported environment becomes patchable', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    const nativeGlobal = makeNativeGlobal();
    const globals = nativeGlobal as unknown as Record<string, unknown>;
    delete globals.XRRigidTransform;
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: nativeGlobal,
    });
    expect(override.installed).toBe(false);
    expect(override.capabilities.supported).toBe(false);

    globals.XRRigidTransform = MockRigidTransform;
    override.install();
    expect(override.installed).toBe(true);
    expect(override.capabilities.supported).toBe(true);
    expect(override.capabilities.notes).toEqual([]);
    await expect(
      nativeXR.requestSession('immersive-vr'),
    ).resolves.toBeInstanceOf(MockSession);
    warning.mockRestore();
  });

  test('prototype fallbacks preserve raw methods across successive sessions', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new PrototypeFallbackXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });

    const first = await nativeXR.requestSession('immersive-vr');
    await expect(
      first.requestReferenceSpace('local-floor'),
    ).resolves.toBeInstanceOf(MockSpace);
    let callbacks = 0;
    first.requestAnimationFrame(() => callbacks++);
    first.fireFrame(1);
    await first.end();

    const second = await nativeXR.requestSession('immersive-vr');
    await expect(
      second.requestReferenceSpace('local-floor'),
    ).resolves.toBeInstanceOf(MockSpace);
    second.requestAnimationFrame(() => callbacks++);
    second.fireFrame(2);

    expect(callbacks).toBe(2);
    expect(nativeXR.sessions).toHaveLength(2);
  });

  test('ends a native session before propagating an attach failure', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new NoReferenceSpaceXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });

    await expect(nativeXR.requestSession('immersive-vr')).rejects.toThrow(
      'No native local-floor, local, or unbounded reference space is available.',
    );
    expect(nativeXR.lastSession?.endCalls).toBe(1);
    expect(override.sessions).toHaveLength(0);
  });

  test('reports when native pose anchoring falls back from local-floor', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new LocalFallbackXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });

    const session = (await nativeXR.requestSession(
      'immersive-vr',
    )) as LocalFallbackSession;

    expect(session.requestedReferenceSpaces).toEqual(['local-floor', 'local']);
    expect(override.capabilities.notes).toContain(
      'Native local-floor is unavailable; poses are anchored to "local" and are offset by the viewer\'s initial height.',
    );
  });

  test('overrides controller and viewer poses while preserving native view objects', async () => {
    const device = new XRDevice(metaQuest3);
    device.position.set(0.2, 1.7, -0.5);
    const right = device.controllers.right!;
    right.position.set(0.4, 1.1, -0.8);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    const referenceSpace = await session.requestReferenceSpace('local-floor');
    publishInitialInputSources(session);
    const rightSource = session.inputSources.find(
      (source) => (source as XRInputSource).handedness === 'right',
    ) as XRInputSource;
    const nativeViewerPose = session.frame.viewerPose;
    const nativeViews = nativeViewerPose.views;
    const leftProjection = nativeViews[0].projectionMatrix;

    let firstPose: MockViewerPose | undefined;
    session.requestAnimationFrame((_time, frame) => {
      const controllerPose = frame.getPose(
        rightSource.targetRaySpace as unknown as MockSpace,
        referenceSpace,
      );
      expect(position(controllerPose!.transform as XRRigidTransform)).toEqual([
        0.4000000059604645, 1.100000023841858, -0.800000011920929,
      ]);
      expect(controllerPose!.emulatedPosition).toBe(false);

      const gripPose = frame.getPose(
        rightSource.gripSpace as unknown as MockSpace,
        referenceSpace,
      );
      expect(gripPose).not.toBeNull();
      const expectedGripMatrix = mat4.multiply(
        mat4.create(),
        controllerPose!.transform.matrix,
        right.inputSource.gripSpace![P_SPACE].offsetMatrix,
      );
      for (
        let matrixIndex = 0;
        matrixIndex < expectedGripMatrix.length;
        matrixIndex++
      ) {
        expect(gripPose!.transform.matrix[matrixIndex]).toBeCloseTo(
          expectedGripMatrix[matrixIndex],
        );
      }

      firstPose = frame.getViewerPose(referenceSpace);
      expect(firstPose).toBe(nativeViewerPose);
      expect(firstPose!.views).toBe(nativeViews);
      expect(firstPose!.views[0].projectionMatrix).toBe(leftProjection);
      expect(position(firstPose!.transform)).toEqual([
        0.20000000298023224, 1.7000000476837158, -0.5,
      ]);
      expect(firstPose!.views[0].transform.position.x).toBeCloseTo(0.17);
      expect(firstPose!.views[0].transform.position.y).toBeCloseTo(1.7);
      expect(firstPose!.views[0].transform.position.z).toBeCloseTo(-0.5);

      const transforms = new Float32Array(16);
      expect(
        frame.fillPoses(
          [rightSource.targetRaySpace as unknown as MockSpace],
          referenceSpace,
          transforms,
        ),
      ).toBe(true);
      expect(Array.from(transforms.slice(12, 15))).toEqual([
        0.4000000059604645, 1.100000023841858, -0.800000011920929,
      ]);
    });
    session.fireFrame(100);

    device.position.set(0.5, 1.8, -0.25);
    session.requestAnimationFrame((_time, frame) => {
      // The same native pose object is reused. Before it is queried in this
      // epoch, its accessor falls back to the browser-owned transform.
      expect(position(firstPose!.transform)).toEqual([10, 2, 3]);
      const secondPose = frame.getViewerPose(referenceSpace);
      expect(secondPose).toBe(firstPose);
      expect(secondPose!.transform.position.x).toBeCloseTo(0.5);
      expect(secondPose!.transform.position.y).toBeCloseTo(1.8);
      expect(secondPose!.transform.position.z).toBeCloseTo(-0.25);
    });
    session.fireFrame(200);

    expect(override.capabilities).toMatchObject({
      phase: 'active',
      poseOverride: true,
      batchPoses: true,
      viewerPose: true,
      viewTransforms: true,
    });
  });

  test('composes controlled-space anchors into the native anchor space', async () => {
    const device = new XRDevice(metaQuest3);
    const right = device.controllers.right!;
    right.position.set(0.4, 1.1, -0.8);
    right.quaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-ar');
    const nativeSpace = await session.requestReferenceSpace('local-floor');
    publishInitialInputSources(session);
    const source = session.inputSources.find(
      (candidate) => (candidate as XRInputSource).handedness === 'right',
    ) as XRInputSource;
    const anchorPose = new MockRigidTransform({ x: 0, y: 0, z: -1 });

    let controlled: Promise<{ delete(): void }> | undefined;
    let native: Promise<{ delete(): void }> | undefined;
    session.requestAnimationFrame((_time, frame) => {
      controlled = frame.createAnchor(
        anchorPose,
        source.targetRaySpace as unknown as MockSpace,
      );
      native = frame.createAnchor(anchorPose, nativeSpace);
    });
    session.fireFrame(95);

    await expect(controlled).resolves.toBeDefined();
    await expect(native).resolves.toBeDefined();
    expect(session.frame.anchorRequests).toHaveLength(2);

    // base_from_controlled * controlled_from_anchor, expressed in anchorSpace.
    const controllerMatrix = mat4.fromRotationTranslation(
      mat4.create(),
      right.quaternion.quat,
      right.position.vec3,
    );
    const expected = mat4.multiply(
      mat4.create(),
      controllerMatrix,
      anchorPose.matrix,
    );
    const request = session.frame.anchorRequests[0];
    expect(request.space).toBe(override.sessions[0].anchorSpace);
    for (let index = 0; index < 16; index++) {
      expect(request.pose.matrix[index]).toBeCloseTo(expected[index]);
    }
    // Native spaces are forwarded untouched.
    expect(session.frame.anchorRequests[1]).toEqual({
      pose: anchorPose,
      space: nativeSpace,
    });
    expect(override.capabilities.anchors).toBe(true);
  });

  test('preserves anchor errors for foreign frames and native failures', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const primary = await nativeXR.requestSession('immersive-ar');
    const secondary = await nativeXR.requestSession('immersive-ar');
    publishInitialInputSources(primary);
    const source = primary.inputSources[0] as XRInputSource;
    const controlledSpace = source.targetRaySpace as unknown as MockSpace;

    let foreignFrameRequest: Promise<{ delete(): void }> | undefined;
    secondary.requestAnimationFrame((_time, frame) => {
      foreignFrameRequest = frame.createAnchor(
        new MockRigidTransform(),
        controlledSpace,
      );
    });
    secondary.fireFrame(10);
    await expect(foreignFrameRequest).rejects.toMatchObject({
      name: 'InvalidStateError',
    });

    primary.frame.anchorFailure = new DOMException(
      'anchors are not supported',
      'NotSupportedError',
    );
    let failing: Promise<{ delete(): void }> | undefined;
    primary.requestAnimationFrame((_time, frame) => {
      failing = frame.createAnchor(new MockRigidTransform(), controlledSpace);
    });
    primary.fireFrame(20);
    await expect(failing).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  test('backs controlled hit test sources with swappable native subscriptions', async () => {
    const device = new XRDevice(metaQuest3);
    const right = device.controllers.right!;
    right.position.set(0.4, 1.1, -0.8);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-ar');
    const nativeSpace = await session.requestReferenceSpace('local-floor');

    // Poses are sampled per frame, so subscribe after the controller settles.
    session.requestAnimationFrame(() => {});
    session.fireFrame(10);
    const source = session.inputSources.find(
      (candidate) => (candidate as XRInputSource).handedness === 'right',
    ) as XRInputSource;

    const nativeHitTest = await session.requestHitTestSource({
      space: nativeSpace,
    });
    expect(nativeHitTest).toBe(session.hitTestRequests[0]);

    const facade = (await session.requestHitTestSource({
      space: source.targetRaySpace as unknown as MockSpace,
    })) as unknown as MockHitTestSource;
    expect(session.hitTestRequests).toHaveLength(2);
    const firstBacking = session.hitTestRequests[1];
    expect(facade).not.toBe(firstBacking);
    expect(
      Array.from((firstBacking.space.toAnchor as Float32Array).slice(12, 15)),
    ).toEqual([0.4000000059604645, 1.100000023841858, -0.800000011920929]);

    session.requestAnimationFrame((_time, frame) => {
      const results = frame.getHitTestResults(facade) as Array<{
        source: MockHitTestSource;
      }>;
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe(firstBacking);
      // Native sources keep going straight to the browser.
      expect(
        (
          frame.getHitTestResults(nativeHitTest) as Array<{
            source: MockHitTestSource;
          }>
        )[0].source,
      ).toBe(nativeHitTest);
    });
    session.fireFrame(20);

    // Moving the controlled space starts an asynchronous replacement. The
    // subscription that already resolved keeps serving results meanwhile, so
    // the facade never goes blank.
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    right.position.set(1, 1, -1);
    session.requestAnimationFrame((_time, frame) => {
      const results = frame.getHitTestResults(facade) as Array<{
        source: MockHitTestSource;
      }>;
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe(firstBacking);
      expect(firstBacking.cancelled).toBe(false);
    });
    session.fireFrame(30);
    expect(session.hitTestRequests).toHaveLength(3);
    await flushMicrotasks();
    const secondBacking = session.hitTestRequests[2];
    // The old subscription is cancelled only once its replacement resolves.
    expect(firstBacking.cancelled).toBe(true);
    expect(
      Array.from((secondBacking.space.toAnchor as Float32Array).slice(12, 15)),
    ).toEqual([1, 1, -1]);

    session.requestAnimationFrame((_time, frame) => {
      const results = frame.getHitTestResults(facade) as Array<{
        source: MockHitTestSource;
      }>;
      expect(results[0].source).toBe(secondBacking);
    });
    session.fireFrame(40);
    // A static pose does not resubscribe.
    session.requestAnimationFrame(() => {});
    session.fireFrame(50);
    expect(session.hitTestRequests).toHaveLength(3);

    // Neither does tracking jitter below the resubscribe tolerance.
    for (let step = 0; step < 20; step++) {
      right.position.set(1 + step * 0.0001, 1, -1);
      session.requestAnimationFrame(() => {});
      session.fireFrame(51 + step);
      await flushMicrotasks();
    }
    expect(session.hitTestRequests).toHaveLength(3);

    facade.cancel();
    expect(secondBacking.cancelled).toBe(true);
    expect(() => facade.cancel()).toThrow(
      expect.objectContaining({ name: 'InvalidStateError' }),
    );
    session.requestAnimationFrame((_time, frame) => {
      expect(() => frame.getHitTestResults(facade)).toThrow(/cancelled/i);
    });
    session.fireFrame(60);
    expect(override.capabilities.hitTest).toBe(true);
    warning.mockRestore();
  });

  test('cleans up native hit test subscriptions on session end and uninstall', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const ended = await nativeXR.requestSession('immersive-ar');
    publishInitialInputSources(ended);
    await ended.requestHitTestSource({
      space: (ended.inputSources[0] as XRInputSource)
        .targetRaySpace as unknown as MockSpace,
    });
    expect(ended.hitTestRequests[0].cancelled).toBe(false);
    await ended.end();
    expect(ended.hitTestRequests[0].cancelled).toBe(true);

    const kept = await nativeXR.requestSession('immersive-ar');
    publishInitialInputSources(kept);
    await kept.requestHitTestSource({
      space: (kept.inputSources[0] as XRInputSource)
        .targetRaySpace as unknown as MockSpace,
    });
    override.uninstall();
    expect(kept.hitTestRequests[0].cancelled).toBe(true);
  });

  test('backs off failed hit test replacements without losing the working subscription', async () => {
    const device = new XRDevice(metaQuest3);
    const right = device.controllers.right!;
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-ar');
    publishInitialInputSources(session);
    const source = session.inputSources.find(
      (candidate) => (candidate as XRInputSource).handedness === 'right',
    ) as XRInputSource;
    const controlledSpace = source.targetRaySpace as unknown as MockSpace;

    session.hitTestFailure = new DOMException(
      'hit-test is not enabled',
      'NotSupportedError',
    );
    await expect(
      session.requestHitTestSource({ space: controlledSpace }),
    ).rejects.toMatchObject({ name: 'NotSupportedError' });

    session.hitTestFailure = null;
    const facade = (await session.requestHitTestSource({
      space: controlledSpace,
    })) as unknown as MockHitTestSource;
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    session.hitTestFailure = new DOMException(
      'device lost',
      'InvalidStateError',
    );
    const working = session.hitTestRequests[0];
    for (let step = 0; step < 40; step++) {
      right.position.set(step + 1, 0, 0);
      session.requestAnimationFrame(() => {});
      session.fireFrame(100 + step * 10);
      await flushMicrotasks();
    }
    // Exponential backoff keeps a persistently failing source from issuing one
    // native request per frame; 40 frames cost far fewer than 40 attempts.
    const attemptsWhileFailing = session.hitTestAttempts - 2;
    expect(attemptsWhileFailing).toBeGreaterThan(0);
    expect(attemptsWhileFailing).toBeLessThan(12);
    expect(session.hitTestRequests).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('could not follow its IWER-controlled space'),
    );

    // A failed replacement never discards the subscription that already works.
    expect(working.cancelled).toBe(false);
    session.requestAnimationFrame((_time, frame) => {
      const results = frame.getHitTestResults(facade) as Array<{
        source: MockHitTestSource;
      }>;
      expect(results[0].source).toBe(working);
    });
    session.fireFrame(600);
    await flushMicrotasks();

    // Failures are transient, not terminal: the source recovers on its own.
    session.hitTestFailure = null;
    for (let step = 0; step < MAX_BACKOFF_FRAMES + 2; step++) {
      right.position.set(100 + step, 0, 0);
      session.requestAnimationFrame(() => {});
      session.fireFrame(700 + step * 10);
      await flushMicrotasks();
    }
    expect(session.hitTestRequests.length).toBeGreaterThan(1);
    const recovered =
      session.hitTestRequests[session.hitTestRequests.length - 1];
    expect(working.cancelled).toBe(true);
    session.requestAnimationFrame((_time, frame) => {
      const results = frame.getHitTestResults(facade) as Array<{
        source: MockHitTestSource;
      }>;
      expect(results[0].source).toBe(recovered);
    });
    session.fireFrame(900);
    await flushMicrotasks();
    warning.mockRestore();
  });

  test('uses native null semantics when controlled poses cannot be resolved', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    const referenceSpace = await session.requestReferenceSpace('local-floor');
    publishInitialInputSources(session);
    const source = session.inputSources[0] as XRInputSource;
    session.frame.trackingAvailable = false;
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

    session.requestAnimationFrame((_time, frame) => {
      const controllerPose = frame.getPose(
        source.targetRaySpace as unknown as MockSpace,
        referenceSpace,
      );
      const viewerPose = frame.getViewerPose(referenceSpace);
      expect(controllerPose).toBeNull();
      expect(viewerPose).toBeNull();

      // Mirrors the strict null check used by three.js WebXRManager.
      let accessedViews = false;
      if (viewerPose !== null) {
        accessedViews = true;
        void viewerPose!.views;
      }
      expect(accessedViews).toBe(false);

      const transforms = new Float32Array(16);
      expect(
        frame.fillPoses(
          [source.targetRaySpace as unknown as MockSpace],
          referenceSpace,
          transforms,
        ),
      ).toBe(false);
    });
    session.fireFrame(97);
    // Assert on the notes rather than a call count: unrelated asynchronous
    // notes from other sessions must not make this test flaky.
    const messages = warning.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain(
      '[IWER native override] A synthetic pose could not be resolved in the requested base space.',
    );
    expect(messages).toContain(
      '[IWER native override] The overridden viewer pose could not be resolved in the requested reference space.',
    );
    warning.mockRestore();
  });

  test('continues fillPoses after an unresolvable entry', async () => {
    const device = new XRDevice(metaQuest3);
    device.controllers.right!.position.set(4, 5, 6);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    const referenceSpace = await session.requestReferenceSpace('local-floor');
    publishInitialInputSources(session);
    const unavailable = new MockSpace();
    const tracked = (
      session.inputSources.find(
        (source) => (source as XRInputSource).handedness === 'right',
      ) as XRInputSource
    ).targetRaySpace as unknown as MockSpace;
    session.frame.untrackedSpaces.add(unavailable);

    session.requestAnimationFrame((_time, frame) => {
      const transforms = new Float32Array(32);
      transforms.fill(-1);
      expect(
        frame.fillPoses([unavailable, tracked], referenceSpace, transforms),
      ).toBe(false);
      expect(Array.from(transforms.slice(0, 16))).toEqual(
        new Array(16).fill(-1),
      );
      expect(Array.from(transforms.slice(16, 32))).not.toEqual(
        new Array(16).fill(-1),
      );
      expect(transforms[28]).toBeCloseTo(4);
      expect(transforms[29]).toBeCloseTo(5);
      expect(transforms[30]).toBeCloseTo(6);
    });
    session.fireFrame(98);
  });

  test('publishes stable synthetic inputs and native-order select events once per timestamp', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    publishInitialInputSources(session);
    const stableSources = session.inputSources;
    expect(Object.isFrozen(stableSources)).toBe(true);
    const rightSource = stableSources.find(
      (source) => (source as XRInputSource).handedness === 'right',
    ) as XRInputSource;
    const events: string[] = [];
    for (const type of ['selectstart', 'select', 'selectend']) {
      session.addEventListener(type, (event) => {
        const inputEvent = event as XRInputSourceEvent;
        events.push(type);
        expect(inputEvent.inputSource).toBe(rightSource);
        expect(inputEvent.frame).toBe(session.frame);
      });
    }

    // A foreign native event is captured and suppressed before app listeners.
    session.dispatchEvent(new Event('selectstart'));
    expect(events).toEqual([]);

    device.controllers.right!.updateButtonValue('trigger', 1);
    session.requestAnimationFrame(() => {});
    session.requestAnimationFrame(() => {});
    session.fireFrame(10);
    expect(events).toEqual(['selectstart']);
    expect(rightSource.gamepad!.buttons[0].pressed).toBe(true);

    device.controllers.right!.updateButtonValue('trigger', 0);
    session.requestAnimationFrame(() => {});
    session.fireFrame(20);
    expect(events).toEqual(['selectstart', 'select', 'selectend']);

    const sourceChanges: XRInputSourcesChangeEvent[] = [];
    session.addEventListener('inputsourceschange', (event) => {
      sourceChanges.push(event as XRInputSourcesChangeEvent);
    });
    device.controllers.right!.connected = false;
    session.requestAnimationFrame(() => {});
    session.fireFrame(30);
    expect(session.inputSources).not.toBe(stableSources);
    expect(stableSources).toHaveLength(2);
    expect(session.inputSources).toHaveLength(1);
    expect(sourceChanges).toHaveLength(1);
    expect(Array.from(sourceChanges[0].removed)).toEqual([rightSource]);

    device.primaryInputMode = 'hand';
    session.requestAnimationFrame(() => {});
    session.fireFrame(40);
    expect(session.inputSources).toHaveLength(0);
    expect(override.capabilities.brandedInputEvents).toBe(true);
  });

  test('mirrors native visibility and never emits a release without a visible start', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    publishInitialInputSources(session);
    const stableSources = session.inputSources;
    const events: string[] = [];
    for (const type of ['selectstart', 'select', 'selectend']) {
      session.addEventListener(type, () => events.push(type));
    }

    session.setVisibility('hidden');
    expect(device.visibilityState).toBe('hidden');
    expect(session.inputSources).not.toBe(stableSources);
    expect(stableSources).toHaveLength(2);
    expect(session.inputSources).toHaveLength(0);

    device.controllers.right!.updateButtonValue('trigger', 1);
    session.requestAnimationFrame(() => {});
    session.fireFrame(50);
    session.setVisibility('visible');
    expect(device.visibilityState).toBe('visible');
    expect(session.inputSources).toHaveLength(2);

    device.controllers.right!.updateButtonValue('trigger', 0);
    session.requestAnimationFrame(() => {});
    session.fireFrame(60);
    expect(events).toEqual([]);
  });

  test('ends an active select before removing its input source', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    publishInitialInputSources(session);
    const events: string[] = [];
    for (const type of ['selectstart', 'select', 'selectend']) {
      session.addEventListener(type, () => events.push(type));
    }

    device.controllers.right!.updateButtonValue('trigger', 1);
    session.requestAnimationFrame(() => {});
    session.fireFrame(65);
    device.controllers.right!.connected = false;
    session.requestAnimationFrame(() => {});
    session.fireFrame(66);

    expect(events).toEqual(['selectstart', 'selectend']);
  });

  test('always invokes the application callback when frame preparation throws', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const update = jest
      .spyOn(device.remote, 'update')
      .mockImplementationOnce(() => {
        throw new Error('listener failure');
      });
    let callbackCount = 0;

    session.requestAnimationFrame(() => {
      callbackCount += 1;
    });
    session.fireFrame(70);
    session.requestAnimationFrame(() => {
      callbackCount += 1;
    });
    session.fireFrame(80);

    expect(callbackCount).toBe(2);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('application frame was preserved'),
    );
    update.mockRestore();
    warning.mockRestore();
  });

  test('restores instance-tier frame and transform descriptors exactly', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    exposeFrameMethodsAsOwnProperties(session.frame);
    exposeTransformAsOwnProperty(session.frame.viewerPose);
    for (const view of session.frame.viewerPose.views) {
      exposeTransformAsOwnProperty(view);
    }
    const frameDescriptors = Object.getOwnPropertyDescriptors(session.frame);
    const poseDescriptor = Object.getOwnPropertyDescriptor(
      session.frame.viewerPose,
      'transform',
    );
    const viewDescriptors = session.frame.viewerPose.views.map((view) =>
      Object.getOwnPropertyDescriptor(view, 'transform'),
    );
    const referenceSpace = await session.requestReferenceSpace('local-floor');

    session.requestAnimationFrame((_time, frame) => {
      expect(frame.getViewerPose(referenceSpace)).toBe(
        session.frame.viewerPose,
      );
      expect(Object.getOwnPropertyDescriptor(frame, 'getPose')?.value).not.toBe(
        frameDescriptors.getPose.value,
      );
      expect(
        Object.getOwnPropertyDescriptor(session.frame.viewerPose, 'transform')
          ?.get,
      ).not.toBe(poseDescriptor?.get);
    });
    session.fireFrame(90);
    override.uninstall();

    for (const name of ['getPose', 'getViewerPose', 'fillPoses'] as const) {
      expect(Object.getOwnPropertyDescriptor(session.frame, name)).toEqual(
        frameDescriptors[name],
      );
    }
    expect(
      Object.getOwnPropertyDescriptor(session.frame.viewerPose, 'transform'),
    ).toEqual(poseDescriptor);
    session.frame.viewerPose.views.forEach((view, index) => {
      expect(Object.getOwnPropertyDescriptor(view, 'transform')).toEqual(
        viewDescriptors[index],
      );
    });
  });

  test('announces the transition back to native inputs on live-session uninstall', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    const changes: XRInputSourcesChangeEvent[] = [];
    const consumerSources = new Set<XRInputSource>();
    session.addEventListener('inputsourceschange', (event) => {
      const change = event as XRInputSourcesChangeEvent;
      changes.push(change);
      for (const source of change.removed) {
        consumerSources.delete(source);
      }
      for (const source of change.added) {
        consumerSources.add(source);
      }
    });

    publishInitialInputSources(session);
    const syntheticSources = Array.from(session.inputSources);
    expect(Array.from(consumerSources)).toEqual(syntheticSources);
    changes.length = 0;

    override.uninstall();

    expect(session.inputSources).toBe(session.nativeInputSources);
    expect(changes).toHaveLength(1);
    expect(Array.from(changes[0].removed)).toEqual(syntheticSources);
    expect(Array.from(changes[0].added)).toEqual(session.nativeInputSources);
    expect(Array.from(consumerSources)).toEqual(session.nativeInputSources);
  });

  test('completes teardown when native listener cleanup throws', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const session = await nativeXR.requestSession('immersive-vr');
    publishInitialInputSources(session);
    const removeEventListener = jest
      .spyOn(session, 'removeEventListener')
      .mockImplementation(() => {
        throw new Error('hostile removeEventListener');
      });

    expect(() => override!.uninstall()).not.toThrow();
    expect(override.capabilities.phase).toBe('uninstalled');
    expect(session.inputSources).toBe(session.nativeInputSources);
    expect(
      Reflect.get(nativeXR, Symbol.for('@iwer/native-override')),
    ).toBeUndefined();

    removeEventListener.mockRestore();
  });

  test('can reinstall the same override and restores shared prototypes', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    const originalFrameDescriptors = Object.fromEntries(
      [
        'getPose',
        'getViewerPose',
        'fillPoses',
        'getJointPose',
        'fillJointRadii',
        'createAnchor',
        'getHitTestResults',
      ].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(MockFrame.prototype, name),
      ]),
    );
    const originalPoseTransform = Object.getOwnPropertyDescriptor(
      MockPose.prototype,
      'transform',
    );
    const originalViewTransform = Object.getOwnPropertyDescriptor(
      MockView.prototype,
      'transform',
    );
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });

    const exercise = async (time: number): Promise<void> => {
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      session.requestAnimationFrame((_frameTime, frame) => {
        expect(frame.getViewerPose(referenceSpace)!.transform.position.x).toBe(
          device.position.x,
        );
      });
      session.fireFrame(time);
    };

    await exercise(100);
    const pendingSession = nativeXR.lastSession!;
    let lateCallbackCount = 0;
    pendingSession.requestAnimationFrame(() => {
      lateCallbackCount += 1;
    });
    override.uninstall();
    expect(override.capabilities).toMatchObject({
      phase: 'uninstalled',
      requestSession: false,
      poseOverride: false,
      viewerPose: false,
    });
    // Browser-owned callbacks cannot be cancelled wholesale. A callback queued
    // before teardown still runs, but must not re-install prototype patches.
    pendingSession.fireFrame(150);
    expect(lateCallbackCount).toBe(1);
    expect(
      Reflect.get(nativeXR, Symbol.for('@iwer/native-override')),
    ).toBeUndefined();
    for (const [name, descriptor] of Object.entries(originalFrameDescriptors)) {
      expect(
        Object.getOwnPropertyDescriptor(MockFrame.prototype, name),
      ).toEqual(descriptor);
    }
    expect(
      Object.getOwnPropertyDescriptor(MockPose.prototype, 'transform'),
    ).toEqual(originalPoseTransform);
    expect(
      Object.getOwnPropertyDescriptor(MockView.prototype, 'transform'),
    ).toEqual(originalViewTransform);

    override.install();
    await exercise(200);
    expect(override.capabilities).toMatchObject({
      phase: 'active',
      viewerPose: true,
    });
  });

  test('keeps per-session input edges independent and promotes the next primary session', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    override = installNativeOverride(device, {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw',
    });
    const primary = await nativeXR.requestSession('immersive-vr');
    const secondary = await nativeXR.requestSession('immersive-ar');
    publishInitialInputSources(primary, 100);
    publishInitialInputSources(secondary, 101);
    const primaryEvents: string[] = [];
    const secondaryEvents: string[] = [];
    primary.addEventListener('selectstart', () =>
      primaryEvents.push('selectstart'),
    );
    secondary.addEventListener('selectstart', () =>
      secondaryEvents.push('selectstart'),
    );

    device.controllers.right!.updateButtonValue('trigger', 1);
    secondary.requestAnimationFrame(() => {});
    secondary.fireFrame(110);
    expect(secondaryEvents).toEqual([]);
    primary.requestAnimationFrame(() => {});
    primary.fireFrame(120);
    secondary.requestAnimationFrame(() => {});
    secondary.fireFrame(130);
    expect(primaryEvents).toEqual(['selectstart']);
    expect(secondaryEvents).toEqual(['selectstart']);
    expect(override.sessions.map((session) => session.primary)).toEqual([
      true,
      false,
    ]);

    await primary.end();
    expect(override.sessions).toHaveLength(1);
    expect(override.sessions[0].session).toBe(secondary);
    expect(override.sessions[0].primary).toBe(true);

    const pendingAction = device.remote.dispatch('set_transform', {
      device: 'headset',
      position: { x: 1, y: 2, z: 3 },
    });
    const rejectedAction =
      expect(pendingAction).rejects.toThrow('Capture released');
    await secondary.end();
    await rejectedAction;
    expect(device.controlMode).toBe('manual');
  });

  test('rejects a second installer and detaches when the native session ends', async () => {
    const device = new XRDevice(metaQuest3);
    const nativeXR = new MockXRSystem();
    const options = {
      xrSystem: nativeXR as unknown as XRSystem,
      globalObject: makeNativeGlobal(),
      onUnsupported: 'throw' as const,
    };
    override = installNativeOverride(device, options);
    const crossBundleKey = Symbol.for('@iwer/native-override');
    expect(Reflect.get(nativeXR, crossBundleKey)).toBe(override);
    // The requestSession wrapper carries the same marker as a host fallback.
    Reflect.deleteProperty(nativeXR, crossBundleKey);
    const second = new XRNativeOverride(new XRDevice(metaQuest3), options);
    expect(() => second.install()).toThrow('already installed');

    const session = await nativeXR.requestSession('immersive-vr');
    const changes: XRInputSourcesChangeEvent[] = [];
    session.addEventListener('inputsourceschange', (event) => {
      changes.push(event as XRInputSourcesChangeEvent);
    });
    publishInitialInputSources(session);
    expect(changes).toHaveLength(1);
    changes.length = 0;

    expect(override.sessions).toHaveLength(1);
    await session.end();
    expect(override.sessions).toHaveLength(0);
    expect(session.inputSources).toBe(session.nativeInputSources);
    expect(changes).toHaveLength(0);
  });

  describe('synthetic hands', () => {
    test('exposes hands only with hand tracking and hand mode selected', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const session = await nativeXR.requestSession('immersive-vr');
      publishInitialInputSources(session);

      // Controller sources report a null hand rather than undefined.
      expect((session.inputSources[0] as XRInputSource).hand).toBeNull();

      device.primaryInputMode = 'hand';
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      expect(session.inputSources).toHaveLength(0);
      expect(override!.capabilities.handInput).toBe(false);
      expect(override!.capabilities.notes).toContain(
        'Native hand input requires the "hand-tracking" feature on the browser session; inputSources remain empty while hand mode is selected.',
      );
      warning.mockRestore();
    });

    test('publishes stable XRHand-shaped facades over every joint', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      device.primaryInputMode = 'hand';
      const sourceChanges: XRInputSourcesChangeEvent[] = [];
      session.addEventListener('inputsourceschange', (event) => {
        sourceChanges.push(event as XRInputSourcesChangeEvent);
      });
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);

      expect(session.inputSources).toHaveLength(2);
      expect(sourceChanges).toHaveLength(1);
      expect(Array.from(sourceChanges[0].added)).toEqual(
        Array.from(session.inputSources),
      );
      const stable = session.inputSources;
      const rightHand = session.inputSources.find(
        (source) => (source as XRInputSource).handedness === 'right',
      ) as XRInputSource;
      expect(rightHand.targetRayMode).toBe('tracked-pointer');
      expect(rightHand.profiles[0]).toBe('oculus-hand');
      // Hand input sources expose no public gamepad.
      expect(rightHand.gamepad).toBeNull();

      const hand = rightHand.hand!;
      expect(hand).toBeInstanceOf(MockXRHand);
      expect(hand.size).toBe(25);
      expect(Array.from(hand.keys())).toEqual(Object.values(IwerHandJoint));
      const wrist = hand.get(IwerHandJoint.Wrist as XRHandJoint);
      expect(wrist).toBeInstanceOf(MockXRJointSpace);
      expect(wrist!.jointName).toBe('wrist');
      expect(Array.from(hand.values())).toHaveLength(25);
      const forEachKeys: string[] = [];
      hand.forEach((_space, key) => forEachKeys.push(key));
      expect(forEachKeys).toHaveLength(25);
      expect(Array.from(hand)).toHaveLength(25);

      // Facades stay stable across frames and mode round-trips.
      session.requestAnimationFrame(() => {});
      session.fireFrame(20);
      expect(session.inputSources).toBe(stable);
      expect(rightHand.hand).toBe(hand);
      expect(hand.get(IwerHandJoint.Wrist as XRHandJoint)).toBe(wrist);
      expect(override!.capabilities.handInput).toBe(true);

      device.primaryInputMode = 'controller';
      session.requestAnimationFrame(() => {});
      session.fireFrame(30);
      expect(session.inputSources).not.toContain(rightHand);
      device.primaryInputMode = 'hand';
      session.requestAnimationFrame(() => {});
      session.fireFrame(40);
      expect(session.inputSources).toContain(rightHand);
    });

    test('resolves joint poses, radii, and mixed native queries', async () => {
      const device = new XRDevice(metaQuest3);
      const rightHandInput = device.hands.right!;
      rightHandInput.position.set(0.3, 1.2, -0.6);
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      device.primaryInputMode = 'hand';
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);

      const rightHand = session.inputSources.find(
        (source) => (source as XRInputSource).handedness === 'right',
      ) as XRInputSource;
      const hand = rightHand.hand!;
      const tip = hand.get(IwerHandJoint.IndexFingerTip as XRHandJoint);
      const iwerTip = rightHandInput.inputSource.hand!.get(
        IwerHandJoint.IndexFingerTip,
      )!;
      const nativeJoint = new MockNativeJointSpace(
        'wrist',
        0.02,
        mat4.fromTranslation(mat4.create(), vec3.fromValues(5, 0, 0)),
      );

      session.requestAnimationFrame((_time, frame) => {
        const expected = XRSpaceUtils.calculateGlobalOffsetMatrix(iwerTip);
        const jointPose = frame.getJointPose(
          tip as unknown as MockNativeJointSpace,
          referenceSpace,
        )!;
        expect(jointPose).not.toBeNull();
        expect(jointPose.radius).toBeCloseTo(iwerTip[P_JOINT_SPACE].radius);
        for (let index = 0; index < 16; index++) {
          expect(jointPose.transform.matrix[index]).toBeCloseTo(
            expected[index],
          );
        }

        // getPose and fillPoses agree with getJointPose for joint spaces.
        const pose = frame.getPose(
          tip as unknown as MockSpace,
          referenceSpace,
        )!;
        expect(Array.from(pose.transform.matrix.slice(12, 15))).toEqual(
          Array.from(jointPose.transform.matrix.slice(12, 15)),
        );
        const transforms = new Float32Array(25 * 16);
        expect(
          frame.fillPoses(
            Array.from(hand.values()) as unknown as MockSpace[],
            referenceSpace,
            transforms,
          ),
        ).toBe(true);

        const radii = new Float32Array(25);
        expect(
          frame.fillJointRadii(
            Array.from(hand.values()) as unknown as MockNativeJointSpace[],
            radii,
          ),
        ).toBe(true);
        expect(radii[4]).toBeCloseTo(iwerTip[P_JOINT_SPACE].radius);

        // Mixed arrays keep native semantics for browser-tracked joints.
        const mixed = new Float32Array(2);
        expect(
          frame.fillJointRadii(
            [tip as unknown as MockNativeJointSpace, nativeJoint],
            mixed,
          ),
        ).toBe(true);
        expect(mixed[1]).toBeCloseTo(0.02);
        const nativeJointPose = frame.getJointPose(nativeJoint, referenceSpace);
        expect(nativeJointPose!.radius).toBeCloseTo(0.02);

        expect(() =>
          frame.fillJointRadii(
            Array.from(hand.values()) as unknown as MockNativeJointSpace[],
            new Float32Array(3),
          ),
        ).toThrow(TypeError);
      });
      session.fireFrame(20);
      expect(override!.capabilities.jointPoses).toBe(true);
    });

    test('accepts one-shot iterables in bulk pose APIs', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      device.primaryInputMode = 'hand';
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      const hand = (
        session.inputSources.find(
          (source) => (source as XRInputSource).handedness === 'right',
        ) as XRInputSource
      ).hand!;
      const nativeJoints = [
        new MockNativeJointSpace('wrist', 0.02),
        new MockNativeJointSpace('thumb-tip', 0.01),
      ];

      session.requestAnimationFrame((_time, frame) => {
        const transforms = new Float32Array(hand.size * 16);
        expect(
          frame.fillPoses(
            hand.values() as unknown as readonly MockSpace[],
            referenceSpace,
            transforms,
          ),
        ).toBe(true);
        expect(
          Array.from(transforms).some((component) => component !== 0),
        ).toBe(true);

        function* joints(): Generator<MockNativeJointSpace> {
          yield* nativeJoints;
        }
        const radii = new Float32Array(nativeJoints.length);
        expect(
          frame.fillJointRadii(
            joints() as unknown as readonly MockNativeJointSpace[],
            radii,
          ),
        ).toBe(true);
        expect(radii[0]).toBeCloseTo(0.02);
        expect(radii[1]).toBeCloseTo(0.01);
      });
      session.fireFrame(20);
    });

    test('drives select transitions from the internal pinch gamepad', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      device.primaryInputMode = 'hand';
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      const rightHand = session.inputSources.find(
        (source) => (source as XRInputSource).handedness === 'right',
      ) as XRInputSource;
      const events: string[] = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, (event) => {
          events.push(type);
          expect((event as XRInputSourceEvent).inputSource).toBe(rightHand);
        });
      }

      device.hands.right!.updatePinchValue(1);
      session.requestAnimationFrame(() => {});
      session.fireFrame(20);
      expect(events).toEqual(['selectstart']);
      expect(device.hands.right!.pinchValue).toBe(1);

      device.hands.right!.updatePinchValue(0);
      session.requestAnimationFrame(() => {});
      session.fireFrame(30);
      expect(events).toEqual(['selectstart', 'select', 'selectend']);
    });
  });

  describe('action playback', () => {
    const recordingSchema: InputSchema = {
      handedness: 'right',
      targetRayMode: 'tracked-pointer',
      profiles: ['recorded-controller'],
      hasGrip: true,
      hasHand: false,
      hasGamepad: true,
      mapping: GamepadMappingType.XRStandard,
      numButtons: 2,
      numAxes: 2,
    };

    const recordedFrame = (index: number, trigger: 0 | 1): unknown[] => [
      index * 100,
      index,
      0,
      0,
      0,
      0,
      0,
      1,
      [
        0,
        index + 10,
        0,
        0,
        0,
        0,
        0,
        1,
        [index + 20, 0, 0, 0, 0, 0, 1],
        [[trigger, trigger, trigger], [0, 0, 0], 0.5, 0],
      ],
    ];

    /** A recorded frame in which no input source is present at all. */
    const emptyFrame = (index: number): unknown[] => [
      index * 100,
      index,
      0,
      0,
      0,
      0,
      0,
      1,
    ];

    const recording = (): CompressedRecording => ({
      schema: [{ 0: 0, 1: recordingSchema }],
      frames: [
        recordedFrame(0, 0),
        recordedFrame(1, 1),
        recordedFrame(2, 0),
        recordedFrame(3, 0),
      ],
    });

    const recordingOf = (frames: unknown[][]): CompressedRecording => ({
      schema: [{ 0: 0, 1: recordingSchema }],
      frames,
    });

    test('routes recorded state and events through stable native facades', async () => {
      const device = new XRDevice(metaQuest3);
      device.position.set(9, 9, 9);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      const events: string[] = [];
      const sourceChanges: XRInputSourcesChangeEvent[] = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, (event) => {
          events.push(type);
          expect((event as XRInputSourceEvent).frame).toBe(session.frame);
        });
      }
      session.addEventListener('inputsourceschange', (event) => {
        sourceChanges.push(event as XRInputSourcesChangeEvent);
      });

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recording(),
      );
      const playFrame = jest.spyOn(player, 'playFrame');
      player.play();

      const advance = (time: number): void => {
        clock += 100;
        session.requestAnimationFrame(() => {});
        session.fireFrame(time);
      };

      // Two callbacks in one native frame must sample the recording once.
      clock += 100;
      session.requestAnimationFrame(() => {});
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      expect(playFrame).toHaveBeenCalledTimes(1);

      const sources = session.inputSources;
      expect(sources).toHaveLength(1);
      expect(sourceChanges).toHaveLength(1);
      const recorded = sources[0] as XRInputSource;
      expect(recorded.profiles).toEqual(['recorded-controller']);
      expect(recorded.hand).toBeNull();
      expect(recorded.gamepad!.buttons[0].value).toBeCloseTo(1);
      expect(recorded.gamepad!.axes[0]).toBeCloseTo(0.5);

      let observedViewer = 0;
      session.requestAnimationFrame((_time, frame) => {
        observedViewer =
          frame.getViewerPose(referenceSpace)!.transform.position.x;
        expect(
          frame.getPose(
            recorded.targetRaySpace as unknown as MockSpace,
            referenceSpace,
          )!.transform.position.x,
        ).toBeCloseTo(11);
        expect(
          frame.getPose(
            recorded.gripSpace as unknown as MockSpace,
            referenceSpace,
          )!.transform.position.x,
        ).toBeCloseTo(21);
      });
      clock += 0;
      session.fireFrame(10);
      expect(observedViewer).toBeCloseTo(1);
      // Stable facades: the same objects are reused every frame.
      advance(20);
      expect(session.inputSources).toBe(sources);
      expect(session.inputSources[0]).toBe(recorded);
      // WebXR order: only selectstart fires on press. The recording's
      // press-time completion event is withheld until release.
      expect(events).toEqual(['selectstart']);

      advance(30);
      expect(events).toEqual(['selectstart', 'select', 'selectend']);

      // The final sampled frame stays observable even though playback stopped.
      let finalViewer = 0;
      clock += 100;
      session.requestAnimationFrame((_time, frame) => {
        finalViewer = frame.getViewerPose(referenceSpace)!.transform.position.x;
      });
      session.fireFrame(40);
      expect(player.playing).toBe(false);
      expect(finalViewer).toBeCloseTo(3);
      expect(session.inputSources[0]).toBe(recorded);
      expect(override!.capabilities.actionPlayback).toBe(true);

      // The following frame hands control back to live device state.
      let deviceViewer = 0;
      session.requestAnimationFrame((_time, frame) => {
        deviceViewer =
          frame.getViewerPose(referenceSpace)!.transform.position.x;
      });
      session.fireFrame(50);
      expect(deviceViewer).toBeCloseTo(9);
      expect(session.inputSources).toHaveLength(2);
      expect(
        Array.from(sourceChanges[sourceChanges.length - 1].removed),
      ).toEqual([recorded]);

      playFrame.mockRestore();
      now.mockRestore();
    });

    test('preserves edges skipped across a multi-frame advance', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const events: string[] = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, () => events.push(type));
      }

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recording(),
      );
      player.play();

      // Establish the edge baseline on the first sampled frame.
      clock += 50;
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      expect(events).toEqual([]);

      // One native frame advances the recording past two frame boundaries; the
      // rising and falling edges in between must both be reported.
      clock += 250;
      session.requestAnimationFrame(() => {});
      session.fireFrame(20);
      expect(events).toEqual(['selectstart', 'select', 'selectend']);
      now.mockRestore();
    });

    test('restores the recording event context when the override detaches', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const setEventContext = jest.spyOn(
        ActionPlayer.prototype,
        'setEventContext',
      );
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recording(),
      );
      player.play();
      clock += 100;
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      expect(setEventContext).toHaveBeenCalledTimes(1);
      expect(setEventContext.mock.calls[0][0]).toBeDefined();

      override.uninstall();
      expect(setEventContext).toHaveBeenLastCalledWith(undefined);
      now.mockRestore();
      setEventContext.mockRestore();
    });

    test('delivers an edge whose source is first published by the same frame', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const events: Array<{ type: string; published: boolean }> = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, (event) => {
          const inputEvent = event as XRInputSourceEvent;
          events.push({
            type,
            // The source an event addresses has to be observable when it lands.
            published: Array.from(session.inputSources).includes(
              inputEvent.inputSource,
            ),
          });
          expect(inputEvent.frame).toBe(session.frame);
          expect((inputEvent.frame as unknown as MockFrame).active).toBe(true);
        });
      }

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      // The recorded source only appears at frame 2 and presses at frame 3, so
      // a large advance publishes it and crosses its rising edge at once.
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recordingOf([
          emptyFrame(0),
          emptyFrame(1),
          recordedFrame(2, 0),
          recordedFrame(3, 1),
          recordedFrame(4, 1),
        ]),
      );
      player.play();

      clock += 50;
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      expect(session.inputSources).toHaveLength(0);
      expect(events).toEqual([]);

      clock += 350;
      session.requestAnimationFrame(() => {});
      session.fireFrame(20);
      expect(session.inputSources).toHaveLength(1);
      expect(events).toEqual([{ type: 'selectstart', published: true }]);
      now.mockRestore();
    });

    test('synthesizes selectend when a held recorded source disappears', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const events: string[] = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, (event) => {
          events.push(type);
          expect(
            ((event as XRInputSourceEvent).frame as unknown as MockFrame)
              .active,
          ).toBe(true);
        });
      }

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      // The trigger goes down at frame 1 and is still down on the final frame.
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recordingOf([
          recordedFrame(0, 0),
          recordedFrame(1, 1),
          recordedFrame(2, 1),
          recordedFrame(3, 1),
        ]),
      );
      player.play();

      for (let step = 0; step < 8; step++) {
        clock += 100;
        session.requestAnimationFrame(() => {});
        session.fireFrame(10 + step * 10);
      }

      expect(player.playing).toBe(false);
      // An interrupted action terminates with selectend alone: it was never
      // completed, so no select is synthesized.
      expect(events).toEqual(['selectstart', 'selectend']);
      expect(session.inputSources).toHaveLength(2);
      now.mockRestore();
    });

    test('synthesizes selectend when playback is stopped mid-press', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const events: string[] = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, () => events.push(type));
      }

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recordingOf([
          recordedFrame(0, 0),
          recordedFrame(1, 1),
          recordedFrame(2, 1),
          recordedFrame(3, 1),
          recordedFrame(4, 1),
        ]),
      );
      player.play();
      clock += 100;
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      clock += 100;
      session.requestAnimationFrame(() => {});
      session.fireFrame(20);
      expect(events).toEqual(['selectstart']);

      player.stop();
      clock += 100;
      session.requestAnimationFrame(() => {});
      session.fireFrame(30);
      expect(events).toEqual(['selectstart', 'selectend']);
      now.mockRestore();
    });

    test('pairs actions across loop and seek discontinuities', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      const events: string[] = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, () => events.push(type));
      }
      let observedViewer = -1;

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recordingOf([
          recordedFrame(0, 0),
          recordedFrame(1, 1),
          recordedFrame(2, 1),
        ]),
        { loop: true },
      );
      player.play();

      // Wire the player and establish frame 0 as the event baseline.
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      player.stepFrames(1);
      session.requestAnimationFrame((_time, frame) => {
        observedViewer =
          frame.getViewerPose(referenceSpace)!.transform.position.x;
      });
      clock += 1000;
      session.fireFrame(20);
      expect(events).toEqual(['selectstart']);
      // A manual step remains on its exact frame even as wall time advances.
      expect(observedViewer).toBeCloseTo(1);

      // Wrapping while held interrupts the old action before another loop can
      // start it, so starts and ends always remain paired.
      player.stepFrames(2);
      session.requestAnimationFrame(() => {});
      session.fireFrame(30);
      expect(events).toEqual(['selectstart', 'selectend']);
      player.stepFrames(1);
      session.requestAnimationFrame(() => {});
      session.fireFrame(40);
      expect(events).toEqual(['selectstart', 'selectend', 'selectstart']);

      // Seeking is also a discontinuity and terminates the held action.
      player.seek(0);
      session.requestAnimationFrame(() => {});
      session.fireFrame(50);
      expect(events).toEqual([
        'selectstart',
        'selectend',
        'selectstart',
        'selectend',
      ]);
      player.stop();
      now.mockRestore();
    });

    test('stamps secondary-session playback events with that session own active frame', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const primary = await nativeXR.requestSession('immersive-vr');
      const secondary = await nativeXR.requestSession('immersive-ar');
      const observed: Array<{
        type: string;
        ownFrame: boolean;
        active: boolean;
        poseResolved: boolean;
      }> = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        secondary.addEventListener(type, (event) => {
          const inputEvent = event as XRInputSourceEvent;
          const frame = inputEvent.frame as unknown as MockFrame;
          let poseResolved = false;
          try {
            // The canonical thing an application does in a select handler.
            poseResolved = Boolean(
              frame.getPose(
                inputEvent.inputSource.targetRaySpace as unknown as MockSpace,
                override!.sessions.find(
                  (entry) =>
                    (entry.session as unknown as MockSession) === secondary,
                )!.anchorSpace as unknown as MockSpace,
              ),
            );
          } catch {
            poseResolved = false;
          }
          observed.push({
            type,
            ownFrame: frame === secondary.frame,
            active: frame.active,
            poseResolved,
          });
        });
      }

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recording(),
      );
      player.play();

      // The primary drives the recording and crosses the rising edge; the
      // secondary is not inside an animation frame callback at that moment.
      clock += 100;
      primary.requestAnimationFrame(() => {});
      primary.fireFrame(10);
      clock += 100;
      primary.requestAnimationFrame(() => {});
      primary.fireFrame(20);
      expect(observed).toEqual([]);

      // The event is delivered on the secondary's own next frame, and is
      // usable: the frame it carries is active and resolves poses.
      secondary.requestAnimationFrame(() => {});
      secondary.fireFrame(25);
      expect(observed).toEqual([
        {
          type: 'selectstart',
          ownFrame: true,
          active: true,
          poseResolved: true,
        },
      ]);
      now.mockRestore();
    });

    test('queues edges from an application-driven stepFrames for the next frame', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const observed: Array<{ type: string; active: boolean }> = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, (event) => {
          const frame = (event as XRInputSourceEvent)
            .frame as unknown as MockFrame;
          observed.push({ type, active: frame.active });
        });
      }

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recordingOf([
          recordedFrame(0, 0),
          recordedFrame(1, 0),
          recordedFrame(2, 1),
          recordedFrame(3, 0),
        ]),
      );
      expect(observed).toEqual([]);

      // Immediate stepping is wired when the player is created. The edge must
      // wait for a real native frame rather than being dropped or stamped with
      // an unusable placeholder frame.
      player.stepFrames(2);
      expect(observed).toEqual([]);
      player.stop();

      session.requestAnimationFrame(() => {});
      session.fireFrame(20);
      // The stepped edge is delivered on the next frame with a usable frame,
      // and stopping mid-press then terminates the action it started.
      expect(observed).toEqual([
        { type: 'selectstart', active: true },
        { type: 'selectend', active: true },
      ]);
      now.mockRestore();
    });

    test('drops queued playback events when a session stops being visible', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const primary = await nativeXR.requestSession('immersive-vr');
      const secondary = await nativeXR.requestSession('immersive-ar');
      const secondaryEvents: string[] = [];
      for (const type of ['selectstart', 'select', 'selectend']) {
        secondary.addEventListener(type, () => secondaryEvents.push(type));
      }

      let clock = 1000;
      const now = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock);
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recording(),
      );
      player.play();
      clock += 100;
      primary.requestAnimationFrame(() => {});
      primary.fireFrame(10);
      secondary.requestAnimationFrame(() => {});
      secondary.fireFrame(11);
      clock += 100;
      primary.requestAnimationFrame(() => {});
      primary.fireFrame(20);
      expect(secondaryEvents).toEqual([]);

      // A hidden session receives no animation frame callbacks, so a queued
      // event must not pin its input source indefinitely.
      secondary.setVisibility('hidden');
      expect(secondary.inputSources).toHaveLength(0);
      secondary.setVisibility('visible');
      secondary.requestAnimationFrame(() => {});
      secondary.fireFrame(30);
      expect(secondaryEvents).toEqual([]);
      now.mockRestore();
    });

    test('keeps the terminal manually stepped frame active until explicit stop', async () => {
      const device = new XRDevice(metaQuest3);
      device.position.set(9, 0, 0);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      const player = device.createActionPlayer(
        new IwerReferenceSpace(IwerReferenceSpaceType.Local, new GlobalSpace()),
        recordingOf([
          recordedFrame(0, 0),
          recordedFrame(1, 0),
          recordedFrame(2, 0),
        ]),
      );

      player.stepFrames(10);
      expect(player.playing).toBe(false);

      const observed: number[] = [];
      const sample = (): void => {
        session.requestAnimationFrame((_time, frame) => {
          observed.push(
            frame.getViewerPose(referenceSpace)!.transform.position.x,
          );
        });
      };
      sample();
      session.fireFrame(10);
      sample();
      session.fireFrame(20);
      expect(observed).toEqual([2, 2]);

      player.stop();
      sample();
      session.fireFrame(30);
      expect(observed).toEqual([2, 2, 9]);
    });

    test('compacts the oldest complete queued lifecycle in one pass', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const [first, second] = session.inputSources as XRInputSource[];
      type PendingAdapter = {
        pendingEvents: Array<{
          type:
            | 'select'
            | 'selectstart'
            | 'selectend'
            | 'squeeze'
            | 'squeezestart'
            | 'squeezeend';
          inputSource: XRInputSource;
        }>;
      };
      const internals = override as unknown as {
        sessionsByObject: WeakMap<XRSession, PendingAdapter>;
        compactPendingEvents(adapter: PendingAdapter): void;
      };
      const adapter = internals.sessionsByObject.get(
        session as unknown as XRSession,
      )!;
      adapter.pendingEvents = [
        { type: 'selectstart', inputSource: first },
        { type: 'squeezestart', inputSource: second },
        { type: 'squeeze', inputSource: second },
        { type: 'squeezeend', inputSource: second },
        { type: 'select', inputSource: first },
        { type: 'selectend', inputSource: first },
      ];

      internals.compactPendingEvents(adapter);
      expect(adapter.pendingEvents).toEqual([
        { type: 'squeezestart', inputSource: second },
        { type: 'squeeze', inputSource: second },
        { type: 'squeezeend', inputSource: second },
      ]);
      warning.mockRestore();
    });
  });

  describe('frame ownership', () => {
    test('rejects controlled-space queries made after the frame callback returns', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-ar');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      device.primaryInputMode = 'hand';
      let stashed: MockFrame | undefined;
      session.requestAnimationFrame((_time, frame) => {
        stashed = frame;
      });
      session.fireFrame(10);

      const hand = session.inputSources.find(
        (source) => (source as XRInputSource).handedness === 'right',
      ) as XRInputSource;
      const joint = hand.hand!.get(IwerHandJoint.Wrist as XRHandJoint)!;
      const frame = stashed!;
      const anchorSpace = override.sessions[0]
        .anchorSpace as unknown as MockSpace;

      // Every one of these silently answered from live device state before.
      // Short buffers still report inactive-frame InvalidStateError first.
      expect(() =>
        frame.getPose(hand.targetRaySpace as unknown as MockSpace, anchorSpace),
      ).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      expect(() =>
        frame.getJointPose(
          joint as unknown as MockNativeJointSpace,
          anchorSpace,
        ),
      ).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      expect(() =>
        frame.getJointPose(
          hand.targetRaySpace as unknown as MockNativeJointSpace,
          anchorSpace,
        ),
      ).toThrow(TypeError);
      expect(() =>
        frame.fillJointRadii(
          [joint as unknown as MockNativeJointSpace],
          new Float32Array(0),
        ),
      ).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      expect(() =>
        frame.fillJointRadii(
          [hand.targetRaySpace as unknown as MockNativeJointSpace],
          new Float32Array(1),
        ),
      ).toThrow(TypeError);
      expect(() =>
        frame.fillPoses(
          [hand.targetRaySpace as unknown as MockSpace],
          anchorSpace,
          new Float32Array(0),
        ),
      ).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      // Frame inactivity takes precedence even if anchor interception is
      // unavailable for this adapter.
      const adapter = (
        override as unknown as {
          sessionsByObject: WeakMap<
            XRSession,
            { createAnchorAvailable: boolean }
          >;
        }
      ).sessionsByObject.get(session as unknown as XRSession)!;
      adapter.createAnchorAvailable = false;
      await expect(
        frame.createAnchor(
          new MockRigidTransform(),
          hand.targetRaySpace as unknown as MockSpace,
        ),
      ).rejects.toMatchObject({ name: 'InvalidStateError' });

      // Purely native queries keep whatever the browser itself decides.
      expect(() => frame.getPose(referenceSpace, anchorSpace)).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
    });

    test('instruments a fresh browser XRFrame on every callback', async () => {
      const device = new XRDevice(metaQuest3);
      device.controllers.right!.position.set(1, 0, 0);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      session.freshFrames = true;
      session.ownFrameMethods = true;
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      publishInitialInputSources(session);
      const source = session.inputSources.find(
        (candidate) => (candidate as XRInputSource).handedness === 'right',
      ) as XRInputSource;
      const frames: MockFrame[] = [];
      const positions: number[] = [];

      const sample = (): void => {
        session.requestAnimationFrame((_time, frame) => {
          frames.push(frame);
          positions.push(
            frame.getPose(
              source.targetRaySpace as unknown as MockSpace,
              referenceSpace,
            )!.transform.position.x,
          );
        });
      };
      sample();
      session.fireFrame(10);
      device.controllers.right!.position.set(2, 0, 0);
      sample();
      session.fireFrame(20);

      expect(frames[0]).not.toBe(frames[1]);
      expect(positions).toEqual([1, 2]);
    });
  });

  describe('spec-compatible errors', () => {
    test('throws InvalidStateError for controlled spaces from another session', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const first = await nativeXR.requestSession('immersive-vr');
      const second = await nativeXR.requestSession('immersive-ar');
      const secondReferenceSpace =
        await second.requestReferenceSpace('local-floor');
      publishInitialInputSources(first);
      const foreignSpace = (first.inputSources[0] as XRInputSource)
        .targetRaySpace as unknown as MockSpace;

      second.requestAnimationFrame((_time, frame) => {
        expect(() => frame.getPose(foreignSpace, secondReferenceSpace)).toThrow(
          expect.objectContaining({ name: 'InvalidStateError' }),
        );
        expect(() =>
          frame.getJointPose(
            foreignSpace as unknown as MockNativeJointSpace,
            secondReferenceSpace,
          ),
        ).toThrow(TypeError);
        expect(() =>
          frame.fillPoses(
            [foreignSpace],
            secondReferenceSpace,
            new Float32Array(16),
          ),
        ).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      });
      second.fireFrame(10);

      // Once the callback ends, frame inactivity takes precedence over the
      // synthetic space's cross-session ownership mismatch. Promise-returning
      // WebIDL methods surface the validation failure as a rejection.
      await expect(
        second.frame.createAnchor(new MockRigidTransform(), foreignSpace),
      ).rejects.toThrow(/frame is not active/);
    });

    test('prioritizes cross-session joint errors over short buffers', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const first = await nativeXR.requestSession('immersive-vr');
      const second = await nativeXR.requestSession('immersive-ar');
      device.primaryInputMode = 'hand';
      first.requestAnimationFrame(() => {});
      first.fireFrame(10);
      second.requestAnimationFrame(() => {});
      second.fireFrame(11);

      const firstHand = first.inputSources.find(
        (source) => (source as XRInputSource).handedness === 'right',
      ) as XRInputSource;
      const foreignJoint = firstHand.hand!.get(
        IwerHandJoint.Wrist as XRHandJoint,
      )!;

      second.requestAnimationFrame((_time, frame) => {
        expect(() =>
          frame.fillJointRadii(
            [foreignJoint as unknown as MockNativeJointSpace],
            new Float32Array(0),
          ),
        ).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      });
      second.fireFrame(20);
    });

    test('reports untracked synthetic joints consistently across both APIs', async () => {
      const device = new XRDevice(metaQuest3);
      const rightHandInput = device.hands.right!;
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      device.primaryInputMode = 'hand';
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);

      const hand = (
        session.inputSources.find(
          (source) => (source as XRInputSource).handedness === 'right',
        ) as XRInputSource
      ).hand!;
      const wrist = hand.get(IwerHandJoint.Wrist as XRHandJoint)!;
      const iwerWrist = rightHandInput.inputSource.hand!.get(
        IwerHandJoint.Wrist,
      )!;
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

      session.requestAnimationFrame((_time, frame) => {
        // A radius of zero means the joint is not tracked this frame.
        iwerWrist[P_JOINT_SPACE].radius = 0;
        const radii = new Float32Array(1);
        expect(
          frame.fillJointRadii(
            [wrist as unknown as MockNativeJointSpace],
            radii,
          ),
        ).toBe(false);
        expect(Number.isNaN(radii[0])).toBe(true);
        // getJointPose has to agree rather than report a zero-radius pose.
        expect(
          frame.getJointPose(
            wrist as unknown as MockNativeJointSpace,
            referenceSpace,
          ),
        ).toBeNull();

        iwerWrist[P_JOINT_SPACE].radius = 0.02;
        expect(
          frame.fillJointRadii(
            [wrist as unknown as MockNativeJointSpace],
            radii,
          ),
        ).toBe(true);
        expect(radii[0]).toBeCloseTo(0.02);
        expect(
          frame.getJointPose(
            wrist as unknown as MockNativeJointSpace,
            referenceSpace,
          ),
        ).not.toBeNull();
      });
      session.fireFrame(20);
      warning.mockRestore();
    });

    test('throws TypeError for a non-joint space and for a short fillPoses buffer', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem(HAND_FEATURES);
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-vr');
      const referenceSpace = await session.requestReferenceSpace('local-floor');
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      const controller = session.inputSources[0] as XRInputSource;

      session.requestAnimationFrame((_time, frame) => {
        // A target-ray space is IWER-controlled but is not an XRJointSpace.
        expect(() =>
          frame.getJointPose(
            controller.targetRaySpace as unknown as MockNativeJointSpace,
            referenceSpace,
          ),
        ).toThrow(TypeError);
        expect(() =>
          frame.fillJointRadii(
            [controller.targetRaySpace as unknown as MockNativeJointSpace],
            new Float32Array(1),
          ),
        ).toThrow(TypeError);
        // fillPoses matches fillJointRadii: a short output buffer is a
        // TypeError, not a false return.
        expect(() =>
          frame.fillPoses(
            [
              controller.targetRaySpace as unknown as MockSpace,
              controller.gripSpace as unknown as MockSpace,
            ],
            referenceSpace,
            new Float32Array(16),
          ),
        ).toThrow(TypeError);
      });
      session.fireFrame(20);
    });

    test('refuses controlled spaces and notes when frame hooks cannot be installed', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-ar');
      let controlled!: MockSpace;
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // A frame whose own hooks are sealed cannot be wrapped at either tier.
      // Only this instance is sealed, so the shared prototype stays reusable.
      for (const name of ['createAnchor', 'getHitTestResults'] as const) {
        Object.defineProperty(session.frame, name, {
          configurable: false,
          writable: false,
          enumerable: false,
          value: MockFrame.prototype[name],
        });
      }

      session.requestAnimationFrame(() => {
        controlled = (session.inputSources[0] as XRInputSource)
          .targetRaySpace as unknown as MockSpace;
      });
      session.fireFrame(10);

      // Both degradations are reported rather than failing silently.
      const notes = override.capabilities.notes;
      expect(notes).toContain(
        'Unable to override XRFrame.createAnchor on a native frame; anchors in IWER-controlled spaces are unavailable until a frame can be instrumented.',
      );
      expect(notes).toContain(
        'Unable to override XRFrame.getHitTestResults on a native frame; hit test sources in IWER-controlled spaces are unavailable until a frame can be instrumented.',
      );
      expect(override.capabilities.anchors).toBe(false);
      expect(override.capabilities.hitTest).toBe(false);

      // requestHitTestSource is a session method, so the override can still
      // refuse a controlled space outright instead of handing back a facade
      // the browser would later reject as a foreign object.
      await expect(
        session.requestHitTestSource({ space: controlled }),
      ).rejects.toMatchObject({ name: 'NotSupportedError' });

      // One hostile frame does not poison other sessions. A later frame whose
      // prototype is patchable can use controlled-space hit testing normally.
      const recovered = await nativeXR.requestSession('immersive-ar');
      recovered.requestAnimationFrame(() => {});
      recovered.fireFrame(20);
      const recoveredSpace = (recovered.inputSources[0] as XRInputSource)
        .targetRaySpace as unknown as MockSpace;
      await expect(
        recovered.requestHitTestSource({ space: recoveredSpace }),
      ).resolves.toBeDefined();
      warning.mockRestore();
    });

    test('copies hit test options so later caller mutation cannot leak in', async () => {
      const device = new XRDevice(metaQuest3);
      const right = device.controllers.right!;
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const session = await nativeXR.requestSession('immersive-ar');
      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      const source = session.inputSources.find(
        (candidate) => (candidate as XRInputSource).handedness === 'right',
      ) as XRInputSource;

      const options = {
        space: source.targetRaySpace as unknown as MockSpace,
        entityTypes: ['plane'],
      };
      await session.requestHitTestSource(options);
      options.entityTypes.push('point');

      right.position.set(2, 2, -2);
      session.requestAnimationFrame(() => {});
      session.fireFrame(20);
      await flushMicrotasks();
      expect(session.hitTestOptions).toHaveLength(2);
      expect(session.hitTestOptions[1].entityTypes).toEqual(['plane']);
    });
  });

  describe('shared device state', () => {
    test('advances hands for a session that cannot publish them itself', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
      // This session never negotiated hand-tracking, so its adapter holds no
      // hand bindings at all and cannot publish hand input sources.
      const session = await nativeXR.requestSession('immersive-vr');
      device.primaryInputMode = 'hand';

      const rightHand = device.hands.right!;
      const wrist = rightHand.inputSource.hand!.get(IwerHandJoint.Wrist)!;
      const before = mat4.clone(wrist[P_SPACE].offsetMatrix);
      rightHand.updatePinchValue(1);

      session.requestAnimationFrame(() => {});
      session.fireFrame(10);
      expect(session.inputSources).toHaveLength(0);

      // Device state is advanced from the shared device rather than from this
      // session's bindings, so the pinch still applies and the joints move.
      expect(rightHand.pinchValue).toBe(1);
      expect(Array.from(wrist[P_SPACE].offsetMatrix)).not.toEqual(
        Array.from(before),
      );
      warning.mockRestore();
    });

    test('keeps a visible secondary session live while the primary is hidden', async () => {
      const device = new XRDevice(metaQuest3);
      const nativeXR = new MockXRSystem();
      override = installNativeOverride(device, {
        xrSystem: nativeXR as unknown as XRSystem,
        globalObject: makeNativeGlobal(),
        onUnsupported: 'throw',
      });
      const primary = await nativeXR.requestSession('immersive-vr');
      const secondary = await nativeXR.requestSession('immersive-ar');
      const referenceSpace =
        await secondary.requestReferenceSpace('local-floor');
      publishInitialInputSources(secondary);
      const source = secondary.inputSources.find(
        (candidate) => (candidate as XRInputSource).handedness === 'right',
      ) as XRInputSource;

      primary.setVisibility('hidden');
      expect(primary.inputSources).toHaveLength(0);
      expect(secondary.inputSources).toHaveLength(2);
      expect(device.visibilityState).toBe('visible');

      device.controllers.right!.position.set(4, 1, -1);
      let x = 0;
      secondary.requestAnimationFrame((_time, frame) => {
        x = frame.getPose(
          source.targetRaySpace as unknown as MockSpace,
          referenceSpace,
        )!.transform.position.x;
      });
      secondary.fireFrame(10);
      expect(x).toBeCloseTo(4);
    });
  });
});
