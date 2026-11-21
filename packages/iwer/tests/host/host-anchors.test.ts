/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host mode anchors: the WebXR Anchors module (createAnchor, anchorSpace,
// delete, trackedAnchors) and persistent anchors as Quest Browser offers them
// (requestPersistentHandle, persistentAnchors, restorePersistentAnchor,
// deletePersistentAnchor), kept by the host through the XRHostBackend anchor
// hooks (src/host/types.ts). The fixture values are arbitrary.

import { mat4 } from 'gl-matrix';

import { XRDevice, XRDeviceBase } from '../../src/device/XRDevice';
import { metaQuest3 } from '../../src/device/configs/headset/meta';
import type { XRAnchor } from '../../src/anchors/XRAnchor';
import type { XRFrame } from '../../src/frameloop/XRFrame';
import type {
  XRHostAnchor,
  XRHostBackend,
  XRHostFrame,
} from '../../src/host/types';
import { XRHostWebGLBinding } from '../../src/host/XRHostWebGLBinding';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';
import type { XRSession } from '../../src/session/XRSession';
import type { XRSpace } from '../../src/spaces/XRSpace';
import { P_DEVICE, P_SESSION } from '../../src/private';

const EYE_FOV = [-0.82, 0.76, 0.85, -0.93];

function makeFrame(time = 5000): XRHostFrame {
  const views = new Float32Array(22);
  views.set([-0.031, 1.7, 0, 0, 0, 0, 1, ...EYE_FOV], 0);
  views.set([0.031, 1.7, 0, 0, 0, 0, 1, ...EYE_FOV], 11);
  return {
    predictedDisplayTime: time,
    shouldRender: true,
    viewCount: 2,
    views,
    localPose: new Float32Array([0, 0, 0, 0, 0, 0, 1]),
    baseIsStage: true,
    colorTexture: 41,
    frameRate: 72,
  };
}

function makeGL() {
  return {
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER: 0x8ca9,
    TEXTURE_2D: 0x0de1,
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    getParameter: () => null,
    bindFramebuffer: () => {},
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    framebufferTexture2D: () => {},
    invalidateFramebuffer: () => {},
    getContextAttributes: () => ({ premultipliedAlpha: true }),
  } as unknown as WebGL2RenderingContext;
}

/** A host that keeps anchors in a table and settles requests when told. */
class FakeAnchorHost {
  readonly poses = new Map<XRHostAnchor, Float32Array | null>();
  readonly created: Float32Array[] = [];
  readonly deleted: XRHostAnchor[] = [];
  readonly persisted: XRHostAnchor[] = [];
  readonly restored: string[] = [];
  readonly erased: string[] = [];
  readonly stored = new Map<string, Float32Array>();
  /** settle functions of requests not settled yet */
  readonly pending: Array<() => void> = [];
  failCreate = false;
  next = 1;

  hooks(): Partial<XRHostBackend> {
    return {
      createAnchor: (transform) => {
        this.created.push(Float32Array.from(transform));
        return new Promise<XRHostAnchor>((resolve, reject) => {
          this.pending.push(() => {
            if (this.failCreate) {
              reject(new Error('xrCreateSpatialAnchorFB failed'));
              return;
            }
            const handle = { id: this.next++ };
            this.poses.set(handle, Float32Array.from(transform));
            resolve(handle);
          });
        });
      },
      getAnchorPose: (anchor, out) => {
        const pose = this.poses.get(anchor);
        if (!pose) {
          return false;
        }
        out.set(pose);
        return true;
      },
      deleteAnchor: (anchor) => {
        this.deleted.push(anchor);
        this.poses.delete(anchor);
      },
      persistAnchor: (anchor) => {
        this.persisted.push(anchor);
        return new Promise<string>((resolve) => {
          this.pending.push(() => {
            const uuid = `uuid-${(anchor as { id: number }).id}`;
            this.stored.set(uuid, this.poses.get(anchor)!);
            resolve(uuid);
          });
        });
      },
      restoreAnchor: (uuid) => {
        this.restored.push(uuid);
        return new Promise<XRHostAnchor>((resolve, reject) => {
          this.pending.push(() => {
            const pose = this.stored.get(uuid);
            if (!pose) {
              reject(
                new DOMException(`no anchor ${uuid}`, 'InvalidStateError'),
              );
              return;
            }
            const handle = { id: this.next++ };
            this.poses.set(handle, null); // not located yet
            resolve(handle);
          });
        });
      },
      erasePersistentAnchor: (uuid) => {
        this.erased.push(uuid);
        this.stored.delete(uuid);
        return Promise.resolve();
      },
      getPersistentAnchors: () => [...this.stored.keys()],
    };
  }

  /** Settles every request made so far, then lets their callbacks run. */
  async settle(): Promise<void> {
    const list = this.pending.splice(0);
    for (const f of list) f();
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function startSession(
  hooks: Partial<XRHostBackend>,
  features: string[] = ['local-floor', 'layers', 'anchors'],
) {
  const backend: XRHostBackend = {
    beginSwapchain: (o) => ({
      width: 1832,
      height: 1920,
      arraySize: o.arraySize,
      rates: [72],
      rate: 72,
      hasStage: true,
      stageWidth: 4,
      stageDepth: 3,
    }),
    endSession: () => {},
    getOpaqueColorTexture: () => ({}) as WebGLTexture,
    postTask: (task) => task(),
    ...hooks,
  };
  const device = new XRDevice(
    {
      ...metaQuest3,
      supportedFeatures: [...metaQuest3.supportedFeatures, 'layers'],
    },
    { host: backend },
  );
  device.installRuntime({ globalObject: {} });
  const session = (await navigator.xr!.requestSession('immersive-ar', {
    optionalFeatures: features,
  })) as unknown as XRSession;
  const layer = new XRHostWebGLBinding(session, makeGL()).createProjectionLayer(
    {} as never,
  );
  session.updateRenderState({ layers: [layer] } as never);
  const floor = (await session.requestReferenceSpace(
    'local-floor' as never,
  )) as unknown as XRSpace;
  return { device, session, floor };
}

let frameTime = 5000;

/** Runs one host frame with one XR callback and returns what it saw. */
function frameWith<T>(
  device: XRDeviceBase,
  session: XRSession,
  read: (frame: XRFrame) => T,
): T {
  let seen: T | undefined;
  session.requestAnimationFrame((_t, frame) => {
    seen = read(frame as unknown as XRFrame);
  });
  frameTime += 1000 / 72;
  device.runHostFrame(makeFrame(frameTime));
  return seen as T;
}

const position = (m: ArrayLike<number>) => [m[12], m[13], m[14]];

describe('host mode anchors', () => {
  afterEach(() => {
    const nav = navigator as { xr?: unknown };
    if (nav.xr) delete nav.xr;
  });

  test('XRAnchor and XRAnchorSet are globals in host mode', async () => {
    const { device } = await startSession({});
    const globalObject: Record<string, unknown> = {};
    device.installRuntime({ globalObject, forceInstall: true } as never);
    expect(typeof globalObject.XRAnchor).toBe('function');
    expect(typeof globalObject.XRAnchorSet).toBe('function');
  });

  test('without the anchors feature every anchor call rejects with NotSupportedError', async () => {
    const host = new FakeAnchorHost();
    const { device, session, floor } = await startSession(host.hooks(), [
      'local-floor',
      'layers',
    ]);
    const created = frameWith(device, session, (frame) =>
      frame.createAnchor(new XRRigidTransform(), floor),
    );
    await expect(created).rejects.toMatchObject({ name: 'NotSupportedError' });
    await expect(session.restorePersistentAnchor('x')).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
    await expect(session.deletePersistentAnchor('x')).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
    expect(host.created).toHaveLength(0);
  });

  test('createAnchor asks the host in the base space; the anchor arrives at the next frame and follows the host', async () => {
    const host = new FakeAnchorHost();
    const { device, session, floor } = await startSession(host.hooks());
    const globalSpace = session[P_SESSION].device[P_DEVICE].globalSpace;
    const offsetFloor = (
      floor as unknown as XRReferenceSpace
    ).getOffsetReferenceSpace(
      new XRRigidTransform({ x: 1, y: 0, z: 0 }) as never,
    ) as unknown as XRSpace;

    let anchor: XRAnchor | null = null;
    frameWith(device, session, (frame) => {
      frame
        .createAnchor(new XRRigidTransform({ x: 0, y: 1, z: -2 }), offsetFloor)
        .then((a) => {
          anchor = a as XRAnchor;
        });
    });
    expect(host.created).toHaveLength(1);
    // base space = global space: the floor's origin is the stage origin
    expect(position(host.created[0])).toEqual([1, 1, -2]);
    await host.settle();
    expect(anchor).toBeNull(); // settles in the next frame, not before

    // the page's promise settles in this frame, before its callbacks
    const tracked = frameWith(
      device,
      session,
      (frame) => frame.trackedAnchors.size,
    );
    await flush();
    expect(anchor).not.toBeNull();
    expect(tracked).toBe(1);
    const seen = frameWith(device, session, (frame) => ({
      listed: frame.trackedAnchors.has(anchor!),
      pose: position(
        frame.getPose(anchor!.anchorSpace, globalSpace)!.transform.matrix,
      ),
    }));
    expect(seen.listed).toBe(true);
    expect(seen.pose).toEqual([1, 1, -2]);

    // the host moves it (relocalisation), then loses it
    const handle = [...host.poses.keys()][0];
    host.poses.set(
      handle,
      mat4.fromTranslation(new Float32Array(16), [1.1, 1, -2]) as Float32Array,
    );
    const moved = frameWith(device, session, (frame) =>
      position(
        frame.getPose(anchor!.anchorSpace, globalSpace)!.transform.matrix,
      ),
    );
    expect(moved[0]).toBeCloseTo(1.1, 6);
    host.poses.set(handle, null);
    const lost = frameWith(device, session, (frame) => ({
      pose: frame.getPose(anchor!.anchorSpace, globalSpace),
      listed: frame.trackedAnchors.has(anchor!),
    }));
    expect(lost.pose).toBeNull();
    expect(lost.listed).toBe(true);

    // delete releases the host anchor once
    anchor!.delete();
    anchor!.delete();
    expect(host.deleted).toEqual([handle]);
    const after = frameWith(
      device,
      session,
      (frame) => frame.trackedAnchors.size,
    );
    expect(after).toBe(0);
  });

  test('an anchor the host cannot create rejects with OperationError', async () => {
    const host = new FakeAnchorHost();
    host.failCreate = true;
    const { device, session, floor } = await startSession(host.hooks());
    const created = frameWith(device, session, (frame) =>
      frame.createAnchor(new XRRigidTransform(), floor),
    );
    await host.settle();
    await expect(created).rejects.toMatchObject({ name: 'OperationError' });
  });

  test('requestPersistentHandle persists once; persistentAnchors lists the host UUIDs; restore and delete by UUID', async () => {
    const host = new FakeAnchorHost();
    const { device, session, floor } = await startSession(host.hooks());
    const globalSpace = session[P_SESSION].device[P_DEVICE].globalSpace;
    let anchor: XRAnchor | null = null;
    frameWith(device, session, (frame) => {
      frame
        .createAnchor(new XRRigidTransform({ x: 0.5, y: 0.8, z: -1 }), floor)
        .then((a) => {
          anchor = a as XRAnchor;
        });
    });
    await host.settle();
    frameWith(device, session, () => {});
    await flush();

    const first = anchor!.requestPersistentHandle();
    const second = anchor!.requestPersistentHandle();
    await host.settle();
    await expect(first).resolves.toBe('uuid-1');
    await expect(second).resolves.toBe('uuid-1');
    expect(host.persisted).toHaveLength(1);
    await expect(anchor!.requestPersistentHandle()).resolves.toBe('uuid-1');
    expect(host.persisted).toHaveLength(1);
    expect(session.persistentAnchors).toEqual(['uuid-1']);

    // a restore of an anchor that is live in this session gives it back
    await expect(session.restorePersistentAnchor('uuid-1')).resolves.toBe(
      anchor,
    );
    expect(host.restored).toHaveLength(0);

    // after delete, restore loads it from the host again
    anchor!.delete();
    let restored: XRAnchor | null = null;
    session.restorePersistentAnchor('uuid-1').then((a) => {
      restored = a as XRAnchor;
    });
    await expect(
      session.restorePersistentAnchor('uuid-1'),
    ).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(host.restored).toEqual(['uuid-1']);
    await host.settle();
    const seen = frameWith(device, session, (frame) =>
      restored ? frame.getPose(restored.anchorSpace, globalSpace) : 'pending',
    );
    await flush();
    expect(restored).not.toBeNull();
    expect(restored).not.toBe(anchor);
    expect(seen).toBe('pending');
    // no pose until the host has located it
    const handle = [...host.poses.keys()].pop()!;
    expect(
      frameWith(device, session, (frame) =>
        frame.getPose(restored!.anchorSpace, globalSpace),
      ),
    ).toBeNull();
    host.poses.set(handle, host.stored.get('uuid-1')!);
    const located = frameWith(device, session, (frame) =>
      position(
        frame.getPose(restored!.anchorSpace, globalSpace)!.transform.matrix,
      ),
    );
    expect(located[0]).toBeCloseTo(0.5, 6);
    expect(located[1]).toBeCloseTo(0.8, 6);
    expect(located[2]).toBeCloseTo(-1, 6);

    // an unknown UUID rejects with the host's error
    const unknown = session.restorePersistentAnchor('nope');
    await host.settle();
    await expect(unknown).rejects.toMatchObject({ name: 'InvalidStateError' });

    // deletePersistentAnchor erases it and deletes the live anchor
    await expect(session.deletePersistentAnchor('uuid-1')).resolves.toBe(
      undefined,
    );
    expect(host.erased).toEqual(['uuid-1']);
    expect(session.persistentAnchors).toEqual([]);
    expect(host.deleted).toContain(handle);
    expect(() => restored!.anchorSpace).toThrow();
  });

  test('after the session ended, requestPersistentHandle rejects instead of inventing a UUID', async () => {
    const host = new FakeAnchorHost();
    const { device, session, floor } = await startSession(host.hooks());
    let anchor: XRAnchor | null = null;
    frameWith(device, session, (frame) => {
      frame.createAnchor(new XRRigidTransform(), floor).then((a) => {
        anchor = a as XRAnchor;
      });
    });
    await host.settle();
    frameWith(device, session, () => {});
    await flush();
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    await session.end();
    await expect(anchor!.requestPersistentHandle()).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    expect(host.persisted).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled(); // not the emulator's store either
    setItem.mockRestore();
  });

  test('a persisted anchor is not deleted while it is restored; one deleted before its handover rejects its restore', async () => {
    const host = new FakeAnchorHost();
    host.stored.set('uuid-9', new Float32Array(16));
    const { device, session } = await startSession(host.hooks());
    let outcome = 'pending';
    session.restorePersistentAnchor('uuid-9').then(
      () => {
        outcome = 'resolved';
      },
      (e: DOMException) => {
        outcome = e.name;
      },
    );
    // as Quest Browser: refused while the restore is in flight
    await expect(
      session.deletePersistentAnchor('uuid-9'),
    ).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(host.erased).toEqual([]);
    // the restore is done but the anchor is not handed over yet (next frame): a delete now must not leave the
    // restore hanging
    await host.settle();
    await expect(session.deletePersistentAnchor('UUID-9')).resolves.toBe(
      undefined,
    );
    expect(host.erased).toEqual(['uuid-9']); // UUIDs compare in lower case
    for (let i = 0; i < 3; i++) frameWith(device, session, () => {});
    await flush();
    expect(outcome).toBe('InvalidStateError');
  });

  test('ending the session releases every host anchor; one created after the end is released and rejects', async () => {
    const host = new FakeAnchorHost();
    const { device, session, floor } = await startSession(host.hooks());
    let created: Promise<unknown> | null = null;
    frameWith(device, session, (frame) => {
      frame.createAnchor(new XRRigidTransform(), floor);
    });
    await host.settle();
    frameWith(device, session, (frame) => {
      created = frame.createAnchor(new XRRigidTransform(), floor);
    });
    expect(host.poses.size).toBe(1);
    await session.end();
    expect(host.deleted).toHaveLength(1);
    await host.settle();
    await expect(created).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(host.deleted).toHaveLength(2);
    expect(host.poses.size).toBe(0);
  });

  test('without the anchor hooks, a host session keeps IWER anchors fixed in the base space; they still arrive at the next frame', async () => {
    const { device, session, floor } = await startSession({});
    const globalSpace = session[P_SESSION].device[P_DEVICE].globalSpace;
    let anchor: XRAnchor | null = null;
    frameWith(device, session, (frame) => {
      frame
        .createAnchor(new XRRigidTransform({ x: 0, y: 1, z: -1 }), floor)
        .then((a) => {
          anchor = a as XRAnchor;
        });
    });
    await flush();
    expect(anchor).toBeNull();
    const pose = frameWith(
      device,
      session,
      (frame) => frame.trackedAnchors.size,
    );
    await flush();
    expect(pose).toBe(1);
    expect(
      frameWith(device, session, (frame) =>
        position(
          frame.getPose(anchor!.anchorSpace, globalSpace)!.transform.matrix,
        ),
      ),
    ).toEqual([0, 1, -1]);
  });
});

type XRReferenceSpace = { getOffsetReferenceSpace(t: unknown): unknown };
