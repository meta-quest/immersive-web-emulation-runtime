/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host-mode benchmark scenarios. Each one sets up a session the way a page
// on the native Quest host would (three.js + IWSDK: local-floor, a
// projection layer, host input) and returns `step()`, which plays the host
// for one display frame: it writes the frame record and the input state in
// place, as native code would, and calls `device.runHostFrame`. The page's
// XR callback reads what three.js's WebXRManager / WebXRController and
// IWSDK's xr-input read every frame (see `consumer` below).

import { installGlobals, makeBackend, makeGL } from './env.mjs';

const HOST_VIEW_STRIDE = 11;
const JOINTS = 25;
const JOINT_STRIDE = 8;
const FRAME_MS = 1000 / 72;

/** Quest-3-like asymmetric FOV, radians: left, right, up, down. */
const FOV_L = [-0.942, 0.698, 0.768, -0.873];
const FOV_R = [-0.698, 0.942, 0.768, -0.873];

/** Every scenario the runner knows, with what it covers. */
export const SCENARIOS = {
  core: 'viewer pose + 2 projection views, no input sources',
  controllers:
    'core + 2 controllers (target ray, grip, 8-button gamepad, axes)',
  hands:
    'core + 2 hands (25 joints each: getJointPose x25, fillPoses, pinch pose)',
  mixed: 'core + left controller + right hand',
  edges:
    'controllers with a trigger press/release every 30 frames (select events)',
  scene:
    'controllers + plane-detection (12 planes) + mesh-detection (4 meshes), IWSDK scene-understanding reads',
};

/** Writes a yaw-only pose (position + quaternion) at `at`. */
function writePose(out, at, x, y, z, yaw) {
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = 0;
  out[at + 4] = Math.sin(yaw / 2);
  out[at + 5] = 0;
  out[at + 6] = Math.cos(yaw / 2);
}

/**
 * The page's per-frame reads, written to allocate nothing on its own side
 * (destination arrays are made once), so whatever a frame allocates is
 * IWER's. Modelled on three.js r18x WebXRManager.onAnimationFrame +
 * WebXRController.update and IWSDK xr-input (XROrigin.updateHead,
 * updatePose, the hand visual's fillPoses + pinch distance, StatefulGamepad).
 */
function makeConsumer(env) {
  const { session, binding, layer } = env;
  const camMatrix = new Float32Array(16);
  const camProjection = new Float32Array(16);
  const headMatrix = new Float32Array(16);
  const poseMatrix = new Float32Array(16);
  const jointBuffer = new Float32Array(16 * JOINTS);
  const fillBuffer = new Float32Array(16 * JOINTS);
  const viewport = [0, 0, 0, 0];
  const gamepadState = new Float32Array(32);
  // per-source caches a page builds when a source connects
  const jointLists = new Map();
  // Results are summed into a Float64Array: a double kept in a captured
  // variable would box a heap number on every write and bill IWER for it.
  const acc = new Float64Array(1);

  // scene reads go through callbacks made once (a closure per frame would
  // be the page's allocation, not IWER's)
  const scene = {
    frame: null,
    planes: null,
    visitPlane: (plane) => {
      if (!scene.planes.has(plane)) return;
      const pose = scene.frame.getPose(plane.planeSpace, env.refSpace);
      if (pose !== null) copy16(poseMatrix, pose.transform.matrix);
      acc[0] += plane.lastChangedTime > 0 ? 1 : 0;
      acc[0] += plane.polygon.length;
    },
    visitMesh: (mesh) => {
      const pose = scene.frame.getPose(mesh.meshSpace, env.refSpace);
      if (pose !== null) copy16(poseMatrix, pose.transform.matrix);
      acc[0] += mesh.vertices.length;
    },
  };
  const copy16 = (dst, src) => {
    for (let i = 0; i < 16; i++) dst[i] = src[i];
  };

  const jointsOf = (source) => {
    let list = jointLists.get(source);
    if (!list) {
      list = Array.from(source.hand.values());
      jointLists.set(source, list);
    }
    return list;
  };

  return function onXRFrame(_time, frame) {
    session.requestAnimationFrame(onXRFrame);
    const refSpace = env.refSpace;
    const pose = frame.getViewerPose(refSpace);
    if (pose !== null) {
      copy16(headMatrix, pose.transform.matrix);
      const views = pose.views;
      for (let i = 0; i < views.length; i++) {
        const view = views[i];
        const sub = binding.getViewSubImage(layer, view);
        const vp = sub.viewport;
        viewport[0] = vp.x;
        viewport[1] = vp.y;
        viewport[2] = vp.width;
        viewport[3] = vp.height;
        if (i === 0) {
          acc[0] += sub.colorTexture === null ? 1 : 0;
          acc[0] += sub.depthStencilTexture === null ? 2 : 0;
        }
        copy16(camMatrix, view.transform.matrix);
        copy16(camProjection, view.projectionMatrix);
      }
    }

    const sources = session.inputSources;
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      const hand = source.hand;
      if (hand) {
        // three.js: one getJointPose per joint, matrix + radius
        const joints = jointsOf(source);
        for (let j = 0; j < joints.length; j++) {
          const jointPose = frame.getJointPose(joints[j], refSpace);
          if (jointPose !== null) {
            copy16(poseMatrix, jointPose.transform.matrix);
            acc[0] += jointPose.radius;
          }
        }
        // IWSDK hand visual: all joints relative to the grip in one call,
        // then the pinch distance from the index tip to the thumb tip
        if (frame.fillPoses(joints, source.gripSpace, fillBuffer)) {
          const pinch = frame.getPose(joints[9], joints[4]);
          if (pinch !== null) {
            const p = pinch.transform.position;
            // IWSDK: vec3.copy(position).length()
            acc[0] += Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
          }
        }
        frame.fillJointRadii(joints, jointBuffer);
      }
      const grip = source.gripSpace;
      if (grip) {
        const gripPose = frame.getPose(grip, refSpace);
        if (gripPose !== null) {
          copy16(poseMatrix, gripPose.transform.matrix);
          if (gripPose.linearVelocity) acc[0]++;
        }
      }
      const rayPose = frame.getPose(source.targetRaySpace, refSpace);
      if (rayPose !== null) {
        copy16(poseMatrix, rayPose.transform.matrix);
        if (rayPose.linearVelocity) acc[0]++;
        if (rayPose.angularVelocity) acc[0]++;
        acc[0] += rayPose.emulatedPosition ? 1 : 0;
      }
      const gamepad = source.gamepad;
      if (gamepad) {
        const buttons = gamepad.buttons;
        for (let b = 0; b < buttons.length; b++) {
          const button = buttons[b];
          gamepadState[b] = button.value;
          gamepadState[b + 12] = button.pressed ? 1 : button.touched ? 0.5 : 0;
        }
        const axes = gamepad.axes;
        for (let a = 0; a < axes.length; a++) {
          gamepadState[24 + a] = axes[a] ?? 0;
        }
      }
    }
    // IWSDK scene understanding: membership, then each plane / mesh pose
    if (env.scene) {
      const planes = frame.detectedPlanes;
      scene.frame = frame;
      scene.planes = planes;
      planes.forEach(scene.visitPlane);
      frame.detectedMeshes.forEach(scene.visitMesh);
      scene.frame = null;
    }
    // IWSDK walks the tracked sources too
    const tracked = session.trackedSources;
    if (tracked) {
      for (let s = 0; s < tracked.length; s++) {
        acc[0] += tracked[s].handedness === 'left' ? 1 : 2;
      }
    }
    env.sink = acc;
  };
}

/**
 * Builds a scenario on an IWER module (the `iwer/host` or `iwer` bundle).
 * Resolves to `{ step, writeFrame, env }`.
 */
export async function createScenario(iwer, name) {
  if (!(name in SCENARIOS)) {
    throw new Error(`unknown scenario ${name}`);
  }
  installGlobals();
  const errors = [];
  const backend = makeBackend(errors);
  if (name === 'scene') {
    // a room as a host's scene tracking reports it: stable objects
    const planes = [];
    for (let i = 0; i < 12; i++) {
      planes.push(
        new iwer.NativePlane(
          new iwer.XRRigidTransform({ x: i * 0.5, y: 0, z: -1 }),
          [
            new DOMPointReadOnly(-0.5, 0, -0.5),
            new DOMPointReadOnly(0.5, 0, -0.5),
            new DOMPointReadOnly(0.5, 0, 0.5),
            new DOMPointReadOnly(-0.5, 0, 0.5),
          ],
          i === 0 ? 'floor' : 'wall',
        ),
      );
    }
    const meshes = [];
    for (let i = 0; i < 4; i++) {
      meshes.push(
        new iwer.NativeMesh(
          new iwer.XRRigidTransform({ x: 0, y: 0.4, z: -i }),
          new Float32Array(3 * 24),
          new Uint32Array(36),
          'table',
        ),
      );
    }
    backend.getPlanes = () => planes;
    backend.getMeshes = () => meshes;
  }
  const config = {
    ...iwer.metaQuest3,
    supportedFeatures: [...iwer.metaQuest3.supportedFeatures, 'layers'],
  };
  const device = new iwer.XRDevice(config, { host: backend });
  const globalObject = {};
  device.installRuntime({ globalObject });
  const input = device.enableHostInput({ onHaptic: () => {} });

  // installRuntime puts the XRSystem on globalThis.navigator.xr
  const sceneFeatures =
    name === 'scene' ? ['plane-detection', 'mesh-detection'] : [];
  const live = await navigator.xr.requestSession('immersive-vr', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'layers', ...sceneFeatures],
  });
  const gl = makeGL();
  const binding = new iwer.XRHostWebGLBinding(live, gl);
  const layer = binding.createProjectionLayer({
    textureType: 'texture-array',
    colorFormat: 0x8058,
    depthFormat: 0x88f0,
    scaleFactor: 1,
  });
  live.updateRenderState({ layers: [layer], depthNear: 0.1, depthFar: 1000 });
  const refSpace = await live.requestReferenceSpace('local-floor');

  const env = {
    device,
    session: live,
    binding,
    layer,
    refSpace,
    input,
    errors,
    sink: 0,
    events: 0,
  };

  const Mode = iwer.XRHostInputMode;
  const left = input.left;
  const right = input.right;
  const sideMode = {
    core: [Mode.None, Mode.None],
    controllers: [Mode.Controller, Mode.Controller],
    hands: [Mode.Hand, Mode.Hand],
    mixed: [Mode.Controller, Mode.Hand],
    edges: [Mode.Controller, Mode.Controller],
    scene: [Mode.Controller, Mode.Controller],
  }[name];
  env.scene = name === 'scene';
  left.mode = sideMode[0];
  right.mode = sideMode[1];
  if (name === 'edges') {
    const count = () => {
      env.events++;
    };
    for (const type of ['select', 'selectstart', 'selectend']) {
      live.addEventListener(type, count);
    }
  }

  live.requestAnimationFrame(makeConsumer(env));

  // the host's frame record, rewritten in place every frame
  const frame = {
    predictedDisplayTime: 1000,
    shouldRender: true,
    viewCount: 2,
    views: new Float32Array(2 * HOST_VIEW_STRIDE),
    localPose: new Float32Array([0, 1.6, 0, 0, 0, 0, 1]),
    baseIsStage: true,
    colorTexture: 7,
    frameRate: 72,
  };
  frame.views.set(FOV_L, 7);
  frame.views.set(FOV_R, HOST_VIEW_STRIDE + 7);

  const writeSide = (state, sign, t, n) => {
    const yaw = 0.2 * Math.sin(t + sign);
    writePose(state.targetRay, 0, 0.2 * sign, 1.2, -0.3, yaw);
    writePose(state.grip, 0, 0.2 * sign, 1.18, -0.28, yaw);
    writePose(state.palm, 0, 0.2 * sign, 1.17, -0.27, yaw);
    state.targetRayValid = true;
    state.gripValid = state.mode === Mode.Controller;
    state.palmValid = true;
    if (state.mode === Mode.Controller) {
      // analog drift without crossing the host's press decision
      state.buttonValues[0] = 0.2 + 0.1 * Math.sin(t);
      state.buttonValues[1] = 0.1;
      state.buttonTouched[0] = 1;
      state.axes[2] = 0.3 * Math.sin(t);
      state.axes[3] = 0.3 * Math.cos(t);
      if (name === 'edges') {
        const pressed = n % 60 < 30;
        state.buttonPressed[0] = pressed ? 1 : 0;
        state.buttonValues[0] = pressed ? 1 : 0;
      }
    } else if (state.mode === Mode.Hand) {
      const joints = state.joints;
      for (let j = 0; j < JOINTS; j++) {
        const at = j * JOINT_STRIDE;
        writePose(
          joints,
          at,
          0.2 * sign + 0.01 * j,
          1.15 + 0.004 * j,
          -0.3 - 0.003 * j,
          yaw + 0.01 * j,
        );
        joints[at + 7] = 0.008;
        state.jointValid[j] = 1;
      }
      state.buttonValues[0] = 0;
    }
  };

  let n = 0;
  // the host's side of a frame: what native code writes in place
  const writeFrame = () => {
    n++;
    const t = n * 0.01;
    frame.predictedDisplayTime += FRAME_MS;
    const yaw = 0.3 * Math.sin(t);
    const views = frame.views;
    writePose(views, 0, -0.032, 1.62, 0.01 * Math.sin(t), yaw);
    writePose(views, HOST_VIEW_STRIDE, 0.032, 1.62, 0.01 * Math.sin(t), yaw);
    frame.colorTexture = 7 + (n % 3);
    if (left.mode !== Mode.None) writeSide(left, -1, t, n);
    if (right.mode !== Mode.None) writeSide(right, 1, t, n);
  };
  const step = () => {
    writeFrame();
    device.runHostFrame(frame);
  };

  // writeFrame alone is the benchmark's own cost (native code writes these
  // values without touching the JS heap); the runner subtracts it
  return { step, writeFrame, env };
}

/**
 * One full session lifecycle as a page and host go through it: request,
 * binding + projection layer, reference space, one frame, end. Resolves
 * when the session has ended.
 */
export async function sessionCycle(iwer, shared) {
  installGlobals();
  if (!shared.device) {
    const backend = makeBackend(shared.errors);
    const config = {
      ...iwer.metaQuest3,
      supportedFeatures: [...iwer.metaQuest3.supportedFeatures, 'layers'],
    };
    shared.device = new iwer.XRDevice(config, { host: backend });
    shared.device.installRuntime({ globalObject: {} });
    shared.device.enableHostInput();
    shared.gl = makeGL();
    shared.frame = {
      predictedDisplayTime: 1000,
      shouldRender: true,
      viewCount: 2,
      views: new Float32Array(2 * HOST_VIEW_STRIDE),
      localPose: new Float32Array([0, 1.6, 0, 0, 0, 0, 1]),
      baseIsStage: true,
      colorTexture: 7,
      frameRate: 72,
    };
    shared.frame.views.set(FOV_L, 7);
    shared.frame.views.set(FOV_R, HOST_VIEW_STRIDE + 7);
    writePose(shared.frame.views, 0, -0.032, 1.6, 0, 0);
    writePose(shared.frame.views, HOST_VIEW_STRIDE, 0.032, 1.6, 0, 0);
  }
  const session = await navigator.xr.requestSession('immersive-vr', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'layers'],
  });
  const binding = new iwer.XRHostWebGLBinding(session, shared.gl);
  const layer = binding.createProjectionLayer({ textureType: 'texture-array' });
  session.updateRenderState({ layers: [layer] });
  const refSpace = await session.requestReferenceSpace('local-floor');
  session.requestAnimationFrame((_t, frame) => {
    shared.sink += frame.getViewerPose(refSpace) ? 1 : 0;
  });
  shared.frame.predictedDisplayTime += FRAME_MS;
  shared.device.runHostFrame(shared.frame);
  await session.end();
}
