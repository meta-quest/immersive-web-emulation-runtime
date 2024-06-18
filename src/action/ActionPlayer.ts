/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	Axis,
	Button,
	PRIVATE as GAMEPAD_PRIVATE,
	Gamepad,
	GamepadButton,
	GamepadMappingType,
} from '../gamepad/Gamepad.js';
import { XRHand, XRHandJoint } from '../input/XRHand.js';
import {
	XRHandedness,
	XRInputSource,
	XRTargetRayMode,
} from '../input/XRInputSource.js';
import {
	PRIVATE as XRJOINTSPACE_PRIVATE,
	XRJointSpace,
} from '../spaces/XRJointSpace.js';
import {
	XRReferenceSpace,
	XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { PRIVATE as XRSPACE_PRIVATE, XRSpace } from '../spaces/XRSpace.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { InputSchema } from './ActionRecorder.js';
import { XREye } from '../views/XRView.js';

export interface CompressedRecording {
	schema: {
		0: number;
		1: InputSchema;
	}[];
	frames: any[];
}

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/action-player');

type ProcessedInputData = {
	targetRayTransform: number[];
	gripTransform?: number[];
	handTransforms?: any[];
	buttons?: { 0: 0 | 1; 1: 0 | 1; 2: number }[];
	axes?: number[];
};

export class ActionPlayer {
	[PRIVATE]: {
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
		this[PRIVATE] = {
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
			this[PRIVATE].viewSpaces[XREye.Left][XRSPACE_PRIVATE].offsetMatrix,
			vec3.fromValues(-ipd / 2, 0, 0),
		);
		mat4.fromTranslation(
			this[PRIVATE].viewSpaces[XREye.Right][XRSPACE_PRIVATE].offsetMatrix,
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

			this[PRIVATE].inputSources.set(index, {
				active: false,
				source: inputSource,
			});
			this[PRIVATE].inputSchemas.set(index, schema);
		});
	}

	play() {
		this[PRIVATE].recordedFramePointer = 0;
		this[PRIVATE].playbackTime = this[PRIVATE].startingTimeStamp;
		this[PRIVATE].playing = true;
		this[PRIVATE].actualTimeStamp = performance.now();
	}

	stop() {
		this[PRIVATE].playing = false;
	}

	get playing() {
		return this[PRIVATE].playing;
	}

	get viewerSpace() {
		return this[PRIVATE].viewerSpace;
	}

	get viewSpaces() {
		return this[PRIVATE].viewSpaces;
	}

	get inputSources() {
		return Array.from(this[PRIVATE].inputSources.values())
			.filter((wrapper) => wrapper.active)
			.map((wrapper) => wrapper.source);
	}

	playFrame() {
		const now = performance.now();
		const delta = now - this[PRIVATE].actualTimeStamp!;
		this[PRIVATE].actualTimeStamp = now;
		this[PRIVATE].playbackTime! += delta;
		if (this[PRIVATE].playbackTime! > this[PRIVATE].endingTimeStamp) {
			this.stop();
			return;
		}
		while (
			(this[PRIVATE].frames[
				this[PRIVATE].recordedFramePointer + 1
			][0] as number) < this[PRIVATE].playbackTime
		) {
			this[PRIVATE].recordedFramePointer++;
		}
		const lastFrameData =
			this[PRIVATE].frames[this[PRIVATE].recordedFramePointer];
		const nextFrameData =
			this[PRIVATE].frames[this[PRIVATE].recordedFramePointer + 1];
		const alpha =
			((this[PRIVATE].playbackTime - lastFrameData[0]) as number) /
			(((nextFrameData[0] as number) - lastFrameData[0]) as number);

		this.updateXRSpaceFromMergedFrames(
			this[PRIVATE].viewerSpace,
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

		this[PRIVATE].inputSources.forEach((sourceWrapper) => {
			sourceWrapper.active = false;
		});

		nextFrameInputs.forEach((inputData, index) => {
			this[PRIVATE].inputSources.get(index)!.active = true;
			const inputSource = this[PRIVATE].inputSources.get(index)!.source;
			const schema = this[PRIVATE].inputSchemas.get(index)!;
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
				jointSpace[XRJOINTSPACE_PRIVATE].radius =
					(nextRadius - lastRadius) * alpha + lastRadius;
			}
		}

		if (schema.hasGamepad) {
			const gamepad = inputSource.gamepad!;
			nextInputData.buttons!.forEach((states, index) => {
				const gamepadButton = gamepad.buttons[index]! as GamepadButton;
				gamepadButton[GAMEPAD_PRIVATE].pressed = states[0] === 1 ? true : false;
				gamepadButton[GAMEPAD_PRIVATE].touched = states[1] === 1 ? true : false;
				const lastValue = lastInputData.buttons![index][2];
				const nextValue = states[2];
				gamepadButton[GAMEPAD_PRIVATE].value =
					(nextValue - lastValue) * alpha + lastValue;
			});
			nextInputData.axes!.forEach((nextValue, index) => {
				const lastValue = lastInputData.axes![index];
				gamepad[GAMEPAD_PRIVATE].axesMap[index.toString()].x =
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
		vec3.lerp(this[PRIVATE].vec3, f1p, f2p, alpha);
		quat.slerp(this[PRIVATE].quat, f1q, f2q, alpha);
		mat4.fromRotationTranslation(
			space[XRSPACE_PRIVATE].offsetMatrix,
			this[PRIVATE].quat,
			this[PRIVATE].vec3,
		);
	}

	processRawInputData(inputDataRaw: any[]) {
		const index = inputDataRaw[0];
		const schema = this[PRIVATE].inputSchemas.get(index)!;
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
