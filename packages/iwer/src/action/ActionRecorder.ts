/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import { P_ACTION_RECORDER } from '../private.js';

export interface InputFrame {
  index: number;
  targetRayTransform: {
    position: vec3;
    quaternion: quat;
  };
  gripTransform?: {
    position: vec3;
    quaternion: quat;
  };
  hand?: {
    [joint in XRHandJoint]: {
      // Pre-compressed at record time using shared scratch buffers, so these
      // are plain number[] rather than vec3/quat.
      position: number[];
      quaternion: number[];
      radius: number;
    };
  };
  gamepad?: {
    buttons: (number[] | null)[];
    axes: (number | null)[];
  };
}

export interface InputSchema {
  handedness: XRHandedness;
  targetRayMode: XRTargetRayMode;
  profiles: string[];
  hasGrip: boolean;
  hasHand: boolean;
  jointSequence?: XRHandJoint[];
  hasGamepad: boolean;
  mapping?: GamepadMappingType;
  numButtons?: number;
  numAxes?: number;
}

export interface ActionFrame {
  timeStamp: DOMHighResTimeStamp;
  position: vec3;
  quaternion: quat;
  inputFrames: InputFrame[];
}

const compress = (arr: vec3 | quat) => {
  const out: number[] = [];
  Array.from(arr).forEach((num) => {
    out.push(Math.round(num * 1000) / 1000);
  });
  return out;
};

// Module-level scratch buffers reused for per-joint translation/rotation
// extraction. Their contents are compressed (copied out) immediately after
// each use, so they are never retained across joints or frames.
const _scratchJointVec3 = vec3.create();
const _scratchJointQuat = quat.create();

/**
 * Policy applied when a recording cap (maxFrames / maxDurationMs) is reached.
 * - 'stop' (default): stop recording new frames; already-recorded frames are
 *   kept intact.
 * - 'drop': drop the oldest recorded frame(s) to make room for new ones,
 *   keeping a sliding window of the most recent frames.
 */
export type RecordingCapPolicy = 'stop' | 'drop';

export interface ActionRecorderOptions {
  /**
   * Maximum number of frames to keep. Omit (or use a non-positive value) for
   * unlimited recording (default).
   */
  maxFrames?: number;
  /**
   * Maximum recording duration in milliseconds, measured from the first
   * recorded frame's timestamp. Omit (or use a non-positive value) for
   * unlimited recording (default).
   */
  maxDurationMs?: number;
  /**
   * Behavior when a cap is reached. Defaults to 'stop'.
   */
  capPolicy?: RecordingCapPolicy;
}

export class ActionRecorder {
  [P_ACTION_RECORDER]: {
    session: XRSession;
    refSpace: XRReferenceSpace;
    inputMap: Map<XRInputSource, number>;
    schemaMap: Map<number, InputSchema>;
    compressedFrames: any[];
    jointRadii: Float32Array;
    jointTransforms: Float32Array;
    maxFrames: number;
    maxDurationMs: number;
    capPolicy: RecordingCapPolicy;
    firstTimeStamp: number | null;
    lastTimeStamp: number | null;
  };

  constructor(
    session: XRSession,
    refSpace: XRReferenceSpace,
    options: ActionRecorderOptions = {},
  ) {
    this[P_ACTION_RECORDER] = {
      session,
      refSpace,
      inputMap: new Map(),
      schemaMap: new Map(),
      compressedFrames: [],
      jointRadii: new Float32Array(25),
      jointTransforms: new Float32Array(25 * 16),
      maxFrames:
        options.maxFrames != null && options.maxFrames > 0
          ? options.maxFrames
          : Infinity,
      maxDurationMs:
        options.maxDurationMs != null && options.maxDurationMs > 0
          ? options.maxDurationMs
          : Infinity,
      capPolicy: options.capPolicy ?? 'stop',
      firstTimeStamp: null,
      lastTimeStamp: null,
    };
  }

  /** Number of frames currently recorded. */
  get frameCount(): number {
    return this[P_ACTION_RECORDER].compressedFrames.length;
  }

  /**
   * Duration of the recording in milliseconds, measured from the first to the
   * most recently recorded frame. Returns 0 when fewer than two frames have
   * been recorded.
   */
  get durationMs(): number {
    const state = this[P_ACTION_RECORDER];
    if (state.firstTimeStamp == null || state.lastTimeStamp == null) {
      return 0;
    }
    return state.lastTimeStamp - state.firstTimeStamp;
  }

  recordFrame(frame: XRFrame) {
    const state = this[P_ACTION_RECORDER];
    const timeStamp = performance.now();
    // Enforce the duration cap up front: under the 'stop' policy, once the cap
    // is reached we keep what we have and skip recording new frames entirely.
    if (
      state.capPolicy === 'stop' &&
      state.firstTimeStamp != null &&
      timeStamp - state.firstTimeStamp >= state.maxDurationMs
    ) {
      return;
    }
    // Likewise, under 'stop' refuse new frames once the frame cap is hit.
    if (
      state.capPolicy === 'stop' &&
      state.compressedFrames.length >= state.maxFrames
    ) {
      return;
    }
    const viewerMatrix = frame.getViewerPose(this[P_ACTION_RECORDER].refSpace)
      ?.transform.matrix;
    if (!viewerMatrix) return;
    const position = mat4.getTranslation(vec3.create(), viewerMatrix);
    const quaternion = mat4.getRotation(quat.create(), viewerMatrix);
    const actionFrame: ActionFrame = {
      timeStamp,
      position,
      quaternion,
      inputFrames: [],
    };
    this[P_ACTION_RECORDER].session.inputSources.forEach((inputSource) => {
      if (!this[P_ACTION_RECORDER].inputMap.has(inputSource)) {
        const schema: InputSchema = {
          handedness: inputSource.handedness,
          targetRayMode: inputSource.targetRayMode,
          profiles: inputSource.profiles,
          hasGrip: inputSource.gripSpace != null,
          hasHand: inputSource.hand != null,
          hasGamepad: inputSource.gamepad != null,
        };
        if (schema.hasHand) {
          schema.jointSequence = Array.from(inputSource.hand!.values()).map(
            (jointSpace) => jointSpace.jointName,
          );
        }
        if (schema.hasGamepad) {
          schema.mapping = inputSource.gamepad!.mapping;
          schema.numButtons = inputSource.gamepad!.buttons.length;
          schema.numAxes = inputSource.gamepad!.axes.length;
        }
        const index = this[P_ACTION_RECORDER].inputMap.size;
        this[P_ACTION_RECORDER].inputMap.set(inputSource, index);
        this[P_ACTION_RECORDER].schemaMap.set(index, schema);
      }
      const index = this[P_ACTION_RECORDER].inputMap.get(inputSource)!;
      const schema = this[P_ACTION_RECORDER].schemaMap.get(index)!;
      const targetRayMatrix = frame.getPose(
        inputSource.targetRaySpace,
        this[P_ACTION_RECORDER].refSpace,
      )?.transform.matrix;
      if (targetRayMatrix) {
        const targetRayPosition = mat4.getTranslation(
          vec3.create(),
          targetRayMatrix,
        );
        const targetRayQuaternion = mat4.getRotation(
          quat.create(),
          targetRayMatrix,
        );

        const inputFrame: InputFrame = {
          index,
          targetRayTransform: {
            position: targetRayPosition,
            quaternion: targetRayQuaternion,
          },
        };

        if (schema.hasGrip) {
          const gripMatrix = frame.getPose(
            inputSource.gripSpace!,
            this[P_ACTION_RECORDER].refSpace,
          )?.transform.matrix;
          if (gripMatrix) {
            const position = mat4.getTranslation(vec3.create(), gripMatrix);
            const quaternion = mat4.getRotation(quat.create(), gripMatrix);
            inputFrame.gripTransform = {
              position,
              quaternion,
            };
          }
        }

        if (schema.hasHand) {
          const jointSpaces = Array.from(inputSource.hand!.values());
          let allValid = true;

          // @ts-ignore
          allValid &&= frame.fillPoses(
            jointSpaces,
            inputSource.targetRaySpace,
            this[P_ACTION_RECORDER].jointTransforms,
          );

          // @ts-ignore
          allValid &&= frame.fillJointRadii(
            jointSpaces,
            this[P_ACTION_RECORDER].jointRadii,
          );

          if (allValid) {
            const hand: {
              [joint in XRHandJoint]: {
                position: number[];
                quaternion: number[];
                radius: number;
              };
            } = {} as any;
            for (let offset = 0; offset < 25; offset++) {
              const jointMatrix = this[P_ACTION_RECORDER].jointTransforms.slice(
                offset * 16,
                (offset + 1) * 16,
              );
              const radius = this[P_ACTION_RECORDER].jointRadii[offset];
              // Reuse module-level scratch buffers, then compress (copy out)
              // immediately so the scratch contents are never retained.
              mat4.getTranslation(_scratchJointVec3, jointMatrix);
              mat4.getRotation(_scratchJointQuat, jointMatrix);
              const position = compress(_scratchJointVec3);
              const quaternion = compress(_scratchJointQuat);
              const jointName = jointSpaces[offset].jointName as XRHandJoint;
              hand[jointName] = { position, quaternion, radius };
            }
            inputFrame.hand = hand;
          }
        }

        if (schema.hasGamepad) {
          const gamepad = {
            buttons: inputSource.gamepad!.buttons.map((button) =>
              button
                ? [button.pressed ? 1 : 0, button.touched ? 1 : 0, button.value]
                : null,
            ),
            axes: Array.from(inputSource.gamepad!.axes),
          };
          inputFrame.gamepad = gamepad;
        }

        actionFrame.inputFrames.push(inputFrame);
      }
    });
    const frames = state.compressedFrames;
    frames.push(this.compressActionFrame(actionFrame));
    if (state.firstTimeStamp == null) {
      state.firstTimeStamp = timeStamp;
    }
    state.lastTimeStamp = timeStamp;
    // Under the 'drop' policy, maintain a sliding window by discarding the
    // oldest frames once a cap is exceeded.
    if (state.capPolicy === 'drop') {
      while (frames.length > state.maxFrames) {
        frames.shift();
      }
      while (
        frames.length > 1 &&
        timeStamp - state.firstTimeStamp! >= state.maxDurationMs
      ) {
        frames.shift();
        // firstTimeStamp tracks the oldest retained frame's timestamp; since
        // individual frame timestamps are compressed in storage, advance it by
        // re-reading the new head frame's timeStamp (stored at index 0).
        state.firstTimeStamp = frames[0][0];
      }
    }
  }

  compressActionFrame(af: ActionFrame): any[] {
    const out: any[] = [
      Math.round(af.timeStamp * 10) / 10,
      ...compress(af.position),
      ...compress(af.quaternion),
    ];
    af.inputFrames.forEach((inputFrame) => {
      const index = inputFrame.index;
      const schema = this[P_ACTION_RECORDER].schemaMap.get(index)!;
      const inputOut: any[] = [
        index,
        ...compress(inputFrame.targetRayTransform.position),
        ...compress(inputFrame.targetRayTransform.quaternion),
      ];
      if (schema.hasGrip) {
        inputOut.push([
          ...compress(inputFrame.gripTransform!.position),
          ...compress(inputFrame.gripTransform!.quaternion),
        ]);
      }
      if (schema.hasHand) {
        const handArr: number[] = [];
        Object.values(inputFrame.hand!).forEach(
          ({ position, quaternion, radius }) => {
            // position/quaternion were already compressed at record time.
            handArr.push(
              ...position,
              ...quaternion,
              Math.round(radius * 1000) / 1000,
            );
          },
        );
        inputOut.push(handArr);
      }
      if (schema.hasGamepad) {
        inputOut.push([
          ...inputFrame.gamepad!.buttons,
          ...inputFrame.gamepad!.axes,
        ]);
      }
      out.push(inputOut);
    });

    return out;
  }

  /**
   * Build the serialized recording object (the same shape ActionPlayer's
   * constructor consumes): the schema entries paired with the compressed frame
   * rows. Returned by reference, so callers that mutate it affect the recorder's
   * live buffers; clone if you need a detached snapshot.
   */
  getRecording(): {
    schema: [number, InputSchema][];
    frames: any[];
  } {
    return {
      schema: Array.from(this[P_ACTION_RECORDER].schemaMap.entries()),
      frames: this[P_ACTION_RECORDER].compressedFrames,
    };
  }

  /** Serialize the current recording to a JSON string. */
  toJSON(): string {
    return JSON.stringify(this.getRecording());
  }

  log() {
    console.log(this.toJSON());
  }
}
