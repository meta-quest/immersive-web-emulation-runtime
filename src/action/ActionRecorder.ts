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
			position: vec3;
			quaternion: quat;
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
	arr.forEach((num) => {
		out.push(parseFloat(num.toFixed(3)));
	});
	return out;
};

export class ActionRecorder {
	[P_ACTION_RECORDER]: {
		session: XRSession;
		refSpace: XRReferenceSpace;
		inputMap: Map<XRInputSource, number>;
		schemaMap: Map<number, InputSchema>;
		compressedFrames: any[];
		jointRadii: Float32Array;
		jointTransforms: Float32Array;
	};

	constructor(session: XRSession, refSpace: XRReferenceSpace) {
		this[P_ACTION_RECORDER] = {
			session,
			refSpace,
			inputMap: new Map(),
			schemaMap: new Map(),
			compressedFrames: [],
			jointRadii: new Float32Array(25),
			jointTransforms: new Float32Array(25 * 16),
		};
	}

	recordFrame(frame: XRFrame) {
		const timeStamp = performance.now();
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
								position: vec3;
								quaternion: quat;
								radius: number;
							};
						} = {} as any;
						for (let offset = 0; offset < 25; offset++) {
							const jointMatrix = this[P_ACTION_RECORDER].jointTransforms.slice(
								offset * 16,
								(offset + 1) * 16,
							);
							const radius = this[P_ACTION_RECORDER].jointRadii[offset];
							const position = mat4.getTranslation(vec3.create(), jointMatrix);
							const quaternion = mat4.getRotation(quat.create(), jointMatrix);
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
		this[P_ACTION_RECORDER].compressedFrames.push(
			this.compressActionFrame(actionFrame),
		);
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
						handArr.push(
							...compress(position),
							...compress(quaternion),
							parseFloat(radius.toFixed(3)),
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

	log() {
		const out = {
			schema: Array.from(this[P_ACTION_RECORDER].schemaMap.entries()),
			frames: this[P_ACTION_RECORDER].compressedFrames,
		};
		console.log(JSON.stringify(out));
	}
}
