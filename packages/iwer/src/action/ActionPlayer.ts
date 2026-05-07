/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Axis,
  Button,
  Gamepad,
  GamepadButton,
  GamepadMappingType,
} from '../gamepad/Gamepad.js';
import {
  P_ACTION_PLAYER,
  P_GAMEPAD,
  P_JOINT_SPACE,
  P_SPACE,
} from '../private.js';
import { XRHand, XRHandJoint } from '../input/XRHand.js';
import {
  XRHandedness,
  XRInputSource,
  XRTargetRayMode,
} from '../input/XRInputSource.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { InputSchema } from './ActionRecorder.js';
import { XREye } from '../views/XRView.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRSpace } from '../spaces/XRSpace.js';

export interface CompressedRecording {
  schema: {
    0: number;
    1: InputSchema;
  }[];
  frames: any[];
}

type ProcessedInputData = {
  targetRayTransform: number[];
  gripTransform?: number[];
  handTransforms?: any[];
  buttons?: { 0: 0 | 1; 1: 0 | 1; 2: number }[];
  axes?: number[];
};

export class ActionPlayer {
  [P_ACTION_PLAYER]: {
    refSpace: XRReferenceSpace;
    inputSources: Map<number, { active: boolean; source: XRInputSource }>;
    inputSchemas: Map<number, InputSchema>;
    frames: any[];
    recordedFramePointer: number;
    startingTimeStamp: DOMHighResTimeStamp;
    endingTimeStamp: DOMHighResTimeStamp;
    playbackTime: DOMHighResTimeStamp;
    actualTimeStamp?: DOMHighResTimeStamp;
    playing: boolean;
    viewerSpace: XRReferenceSpace;
    viewSpaces: { [key in XREye]: XRSpace };
    vec3: vec3;
    quat: quat;
  };

  constructor(
    refSpace: XRReferenceSpace,
    recording: {
      schema: {
        0: number;
        1: InputSchema;
      }[];
      frames: any[];
    },
    ipd: number,
  ) {
    const { schema, frames } = recording;
    if (!frames || !schema || frames.length === 0) {
      throw new DOMException('wrong recording format', 'NotSupportedError');
    }
    const viewerSpace = new XRReferenceSpace(
      XRReferenceSpaceType.Viewer,
      refSpace,
    );
    const viewSpaces: { [key in XREye]: XRSpace } = {
      [XREye.Left]: new XRSpace(viewerSpace),
      [XREye.Right]: new XRSpace(viewerSpace),
      [XREye.None]: new XRSpace(viewerSpace),
    };
    this[P_ACTION_PLAYER] = {
      refSpace,
      inputSources: new Map(),
      inputSchemas: new Map(),
      frames,
      recordedFramePointer: 0,
      startingTimeStamp: frames[0][0] as number,
      endingTimeStamp: frames[frames.length - 1][0] as number,
      playbackTime: frames[0][0] as number,
      playing: false,
      viewerSpace,
      viewSpaces,
      vec3: vec3.create(),
      quat: quat.create(),
    };

    mat4.fromTranslation(
      this[P_ACTION_PLAYER].viewSpaces[XREye.Left][P_SPACE].offsetMatrix,
      vec3.fromValues(-ipd / 2, 0, 0),
    );
    mat4.fromTranslation(
      this[P_ACTION_PLAYER].viewSpaces[XREye.Right][P_SPACE].offsetMatrix,
      vec3.fromValues(ipd / 2, 0, 0),
    );

    schema.forEach((schemaEntry) => {
      const index = schemaEntry[0];
      const schema = schemaEntry[1];
      let gamepad;
      if (schema.hasGamepad) {
        const buttons: Button[] = [];
        for (let i = 0; i < schema.numButtons!; i++) {
          buttons.push({ id: i.toString(), type: 'manual' });
        }
        const axes: Axis[] = [];
        for (let i = 0; i < schema.numAxes!; i++) {
          axes.push({ id: i.toString(), type: 'manual' });
        }
        gamepad = new Gamepad({
          mapping: schema.mapping as GamepadMappingType,
          buttons,
          axes,
        });
      }

      const targetRaySpace = new XRSpace(refSpace);

      let hand: XRHand | undefined = undefined;
      if (schema.hasHand) {
        hand = new XRHand();
        Object.values(XRHandJoint).forEach((jointName) => {
          hand!.set(jointName, new XRJointSpace(jointName, targetRaySpace));
        });
      }

      const inputSource = new XRInputSource(
        schema.handedness as XRHandedness,
        schema.targetRayMode as XRTargetRayMode,
        schema.profiles,
        targetRaySpace,
        gamepad,
        schema.hasGrip ? new XRSpace(refSpace) : undefined,
        schema.hasHand ? hand : undefined,
      );

      this[P_ACTION_PLAYER].inputSources.set(index, {
        active: false,
        source: inputSource,
      });
      this[P_ACTION_PLAYER].inputSchemas.set(index, schema);
    });
  }

  play() {
    this[P_ACTION_PLAYER].recordedFramePointer = 0;
    this[P_ACTION_PLAYER].playbackTime =
      this[P_ACTION_PLAYER].startingTimeStamp;
    this[P_ACTION_PLAYER].playing = true;
    this[P_ACTION_PLAYER].actualTimeStamp = performance.now();
  }

  stop() {
    this[P_ACTION_PLAYER].playing = false;
  }

  get playing() {
    return this[P_ACTION_PLAYER].playing;
  }

  get viewerSpace() {
    return this[P_ACTION_PLAYER].viewerSpace;
  }

  get viewSpaces() {
    return this[P_ACTION_PLAYER].viewSpaces;
  }

  get inputSources() {
    return Array.from(this[P_ACTION_PLAYER].inputSources.values())
      .filter((wrapper) => wrapper.active)
      .map((wrapper) => wrapper.source);
  }

  playFrame() {
    const now = performance.now();
    const delta = now - this[P_ACTION_PLAYER].actualTimeStamp!;
    this[P_ACTION_PLAYER].actualTimeStamp = now;
    this[P_ACTION_PLAYER].playbackTime! += delta;
    if (
      this[P_ACTION_PLAYER].playbackTime! >
      this[P_ACTION_PLAYER].endingTimeStamp
    ) {
      this.stop();
      return;
    }
    while (
      (this[P_ACTION_PLAYER].frames[
        this[P_ACTION_PLAYER].recordedFramePointer + 1
      ][0] as number) < this[P_ACTION_PLAYER].playbackTime
    ) {
      this[P_ACTION_PLAYER].recordedFramePointer++;
    }
    const lastFrameData =
      this[P_ACTION_PLAYER].frames[this[P_ACTION_PLAYER].recordedFramePointer];
    const nextFrameData =
      this[P_ACTION_PLAYER].frames[
        this[P_ACTION_PLAYER].recordedFramePointer + 1
      ];
    const alpha =
      ((this[P_ACTION_PLAYER].playbackTime - lastFrameData[0]) as number) /
      (((nextFrameData[0] as number) - lastFrameData[0]) as number);

    this.updateXRSpaceFromMergedFrames(
      this[P_ACTION_PLAYER].viewerSpace,
      lastFrameData.slice(1, 8),
      nextFrameData.slice(1, 8),
      alpha,
    );

    const lastFrameInputs: Map<number, ProcessedInputData> = new Map();
    for (let i = 8; i < lastFrameData.length; i++) {
      const { index, inputData } = this.processRawInputData(
        lastFrameData[i] as any[],
      );
      lastFrameInputs.set(index, inputData);
    }

    const nextFrameInputs: Map<number, ProcessedInputData> = new Map();
    for (let i = 8; i < nextFrameData.length; i++) {
      const { index, inputData } = this.processRawInputData(
        nextFrameData[i] as any[],
      );
      nextFrameInputs.set(index, inputData);
    }

    this[P_ACTION_PLAYER].inputSources.forEach((sourceWrapper) => {
      sourceWrapper.active = false;
    });

    nextFrameInputs.forEach((inputData, index) => {
      this[P_ACTION_PLAYER].inputSources.get(index)!.active = true;
      const inputSource = this[P_ACTION_PLAYER].inputSources.get(index)!.source;
      const schema = this[P_ACTION_PLAYER].inputSchemas.get(index)!;
      this.updateInputSource(
        inputSource,
        schema,
        lastFrameInputs.has(index) ? lastFrameInputs.get(index)! : inputData,
        inputData,
        alpha,
      );
    });
  }

  updateInputSource(
    inputSource: XRInputSource,
    schema: InputSchema,
    lastInputData: ProcessedInputData,
    nextInputData: ProcessedInputData,
    alpha: number,
  ) {
    this.updateXRSpaceFromMergedFrames(
      inputSource.targetRaySpace,
      lastInputData.targetRayTransform,
      nextInputData.targetRayTransform,
      alpha,
    );

    if (schema.hasGrip) {
      this.updateXRSpaceFromMergedFrames(
        inputSource.gripSpace!,
        lastInputData.gripTransform!,
        nextInputData.gripTransform!,
        alpha,
      );
    }

    if (schema.hasHand) {
      for (let i = 0; i < 25; i++) {
        const lastTransformArray = lastInputData.handTransforms!.slice(
          i * 8,
          i * 8 + 7,
        );
        const nextTransformArray = nextInputData.handTransforms!.slice(
          i * 8,
          i * 8 + 7,
        );
        const lastRadius = lastInputData.handTransforms![i * 8 + 7];
        const nextRadius = nextInputData.handTransforms![i * 8 + 7];
        const jointSpace = inputSource.hand!.get(
          schema.jointSequence![i] as XRHandJoint,
        )!;
        this.updateXRSpaceFromMergedFrames(
          jointSpace,
          lastTransformArray,
          nextTransformArray,
          alpha,
        );
        jointSpace[P_JOINT_SPACE].radius =
          (nextRadius - lastRadius) * alpha + lastRadius;
      }
    }

    if (schema.hasGamepad) {
      const gamepad = inputSource.gamepad!;
      nextInputData.buttons!.forEach((states, index) => {
        const gamepadButton = gamepad.buttons[index]! as GamepadButton;
        gamepadButton[P_GAMEPAD].pressed = states[0] === 1 ? true : false;
        gamepadButton[P_GAMEPAD].touched = states[1] === 1 ? true : false;
        const lastValue = lastInputData.buttons![index][2];
        const nextValue = states[2];
        gamepadButton[P_GAMEPAD].value =
          (nextValue - lastValue) * alpha + lastValue;
      });
      nextInputData.axes!.forEach((nextValue, index) => {
        const lastValue = lastInputData.axes![index];
        gamepad[P_GAMEPAD].axesMap[index.toString()].x =
          (nextValue - lastValue) * alpha + lastValue;
      });
    }
  }

  updateXRSpaceFromMergedFrames(
    space: XRSpace,
    lastTransform: number[],
    nextTransform: number[],
    alpha: number,
  ) {
    const f1p = vec3.fromValues(
      lastTransform[0],
      lastTransform[1],
      lastTransform[2],
    );
    const f1q = quat.fromValues(
      lastTransform[3],
      lastTransform[4],
      lastTransform[5],
      lastTransform[6],
    );
    const f2p = vec3.fromValues(
      nextTransform[0],
      nextTransform[1],
      nextTransform[2],
    );
    const f2q = quat.fromValues(
      nextTransform[3],
      nextTransform[4],
      nextTransform[5],
      nextTransform[6],
    );
    vec3.lerp(this[P_ACTION_PLAYER].vec3, f1p, f2p, alpha);
    quat.slerp(this[P_ACTION_PLAYER].quat, f1q, f2q, alpha);
    mat4.fromRotationTranslation(
      space[P_SPACE].offsetMatrix,
      this[P_ACTION_PLAYER].quat,
      this[P_ACTION_PLAYER].vec3,
    );
  }

  processRawInputData(inputDataRaw: any[]) {
    const index = inputDataRaw[0];
    const schema = this[P_ACTION_PLAYER].inputSchemas.get(index)!;
    const targetRayTransform: number[] = inputDataRaw.slice(1, 8);
    const inputData: ProcessedInputData = { targetRayTransform };
    let dataCounter = 8;
    if (schema.hasGrip) {
      inputData.gripTransform = inputDataRaw[dataCounter++];
    }
    if (schema.hasHand) {
      inputData.handTransforms = inputDataRaw[dataCounter++];
    }
    if (schema.hasGamepad) {
      const gamepadData = inputDataRaw[dataCounter] as any[];
      inputData.buttons = gamepadData.slice(0, schema.numButtons!);
      inputData.axes = gamepadData.slice(schema.numButtons!);
    }
    return { index, inputData };
  }
}

export const mergeTransform = (
  f1: number[],
  f2: number[],
  alpha: number,
  position: vec3,
  quaternion: quat,
) => {
  const f1p = vec3.fromValues(f1[0], f1[1], f1[2]);
  const f1q = quat.fromValues(f1[3], f1[4], f1[5], f1[6]);
  const f2p = vec3.fromValues(f2[0], f2[1], f2[2]);
  const f2q = quat.fromValues(f2[3], f2[4], f2[5], f2[6]);
  vec3.lerp(position, f1p, f2p, alpha);
  quat.slerp(quaternion, f1q, f2q, alpha);
};
