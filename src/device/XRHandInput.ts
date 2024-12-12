/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	Gamepad,
	GamepadConfig,
	GamepadMappingType,
} from '../gamepad/Gamepad.js';
import { GlobalSpace, XRSpace } from '../spaces/XRSpace.js';
import {
	P_GAMEPAD,
	P_HAND_INPUT,
	P_JOINT_SPACE,
	P_SPACE,
	P_TRACKED_INPUT,
} from '../private.js';
import { XRHand, XRHandJoint } from '../input/XRHand.js';
import {
	XRHandedness,
	XRInputSource,
	XRTargetRayMode,
} from '../input/XRInputSource.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { XRFrame } from '../frameloop/XRFrame.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRTrackedInput } from './XRTrackedInput.js';
import { pinchHandPose } from './configs/hand/pinch.js';
import { pointHandPose } from './configs/hand/point.js';
import { relaxedHandPose } from './configs/hand/relaxed.js';

export interface HandPose {
	jointTransforms: {
		[joint in XRHandJoint]: {
			offsetMatrix: mat4;
			radius: number;
		};
	};
	gripOffsetMatrix?: mat4;
}

export interface XRHandInputConfig {
	profileId: string;
	fallbackProfileIds: string[];
	// use left hand pose data and mirror for right hand
	poses: {
		default: HandPose;
		pinch: HandPose;
		// Additional poses can be specified freely with string keys.
		[poseId: string]: HandPose;
	};
}

export const oculusHandConfig: XRHandInputConfig = {
	profileId: 'oculus-hand',
	fallbackProfileIds: [
		'generic-hand',
		'generic-hand-select',
		'generic-trigger',
	],
	poses: {
		default: relaxedHandPose,
		pinch: pinchHandPose,
		point: pointHandPose,
	},
};

const XRHandGamepadConfig: GamepadConfig = {
	mapping: GamepadMappingType.None,
	buttons: [{ id: 'pinch', type: 'analog', eventTrigger: 'select' }],
	axes: [],
};

const fromPosition = vec3.create();
const fromQuaternion = quat.create();
const fromScale = vec3.create();
const toPosition = vec3.create();
const toQuaternion = quat.create();
const toScale = vec3.create();
const interpolatedPosition = vec3.create();
const interpolatedQuaternion = quat.create();
const interpolatedScale = vec3.create();
const interpolateMatrix = (
	out: mat4,
	fromMatrix: mat4,
	toMatrix: mat4,
	alpha: number,
) => {
	mat4.getTranslation(fromPosition, fromMatrix);
	mat4.getRotation(fromQuaternion, fromMatrix);
	mat4.getScaling(fromScale, fromMatrix);
	mat4.getTranslation(toPosition, toMatrix);
	mat4.getRotation(toQuaternion, toMatrix);
	mat4.getScaling(toScale, toMatrix);
	vec3.lerp(interpolatedPosition, fromPosition, toPosition, alpha);
	quat.slerp(interpolatedQuaternion, fromQuaternion, toQuaternion, alpha);
	vec3.lerp(interpolatedScale, fromScale, toScale, alpha);
	mat4.fromRotationTranslationScale(
		out,
		interpolatedQuaternion,
		interpolatedPosition,
		interpolatedScale,
	);
	return out;
};

const mirrorMultiplierMatrix = [
	1, -1, -1, 0, -1, 1, 1, 0, -1, 1, 1, 0, -1, 1, 1, 1,
];
const mirrorMatrixToRight = (matrixLeft: mat4) => {
	for (let i = 0; i < 16; i++) {
		matrixLeft[i] *= mirrorMultiplierMatrix[i];
	}
};

export class XRHandInput extends XRTrackedInput {
	[P_HAND_INPUT]: {
		poseId: string;
		poses: {
			default: HandPose;
			pinch: HandPose;
			// Additional poses can be specified freely with string keys.
			[poseId: string]: HandPose;
		};
	};

	constructor(
		handInputConfig: XRHandInputConfig,
		handedness: XRHandedness,
		globalSpace: GlobalSpace,
	) {
		if (handedness !== XRHandedness.Left && handedness !== XRHandedness.Right) {
			throw new DOMException(
				'handedness for XRHandInput must be either "left" or "right"',
				'InvalidStateError',
			);
		}
		if (!handInputConfig.poses.default || !handInputConfig.poses.pinch) {
			throw new DOMException(
				'"default" and "pinch" hand pose configs are required',
				'InvalidStateError',
			);
		}

		const targetRaySpace = new XRSpace(globalSpace);
		const gripSpace = new XRSpace(targetRaySpace);
		const profiles = [
			handInputConfig.profileId,
			...handInputConfig.fallbackProfileIds,
		];
		const hand = new XRHand();
		Object.values(XRHandJoint).forEach((jointName) => {
			hand.set(jointName, new XRJointSpace(jointName, targetRaySpace));
		});
		const inputSource = new XRInputSource(
			handedness,
			XRTargetRayMode.TrackedPointer,
			profiles,
			targetRaySpace,
			new Gamepad(XRHandGamepadConfig),
			gripSpace,
			hand,
		);

		super(inputSource);
		this[P_HAND_INPUT] = {
			poseId: 'default',
			poses: handInputConfig.poses,
		};

		this.updateHandPose();
	}

	get poseId() {
		return this[P_HAND_INPUT].poseId;
	}

	set poseId(poseId: string) {
		if (!this[P_HAND_INPUT].poses[poseId]) {
			console.warn(`Pose config ${poseId} not found`);
			return;
		}
		this[P_HAND_INPUT].poseId = poseId;
	}

	updateHandPose() {
		const targetPose = this[P_HAND_INPUT].poses[this[P_HAND_INPUT].poseId];
		const pinchPose = this[P_HAND_INPUT].poses.pinch;
		Object.values(XRHandJoint).forEach((jointName) => {
			const targetJointMatrix =
				targetPose.jointTransforms[jointName].offsetMatrix;
			const pinchJointMatrix =
				pinchPose.jointTransforms[jointName].offsetMatrix;
			const jointSpace = this.inputSource.hand!.get(jointName)!;
			interpolateMatrix(
				jointSpace[P_SPACE].offsetMatrix,
				targetJointMatrix,
				pinchJointMatrix,
				this.pinchValue,
			);
			if (this.inputSource.handedness === XRHandedness.Right) {
				mirrorMatrixToRight(jointSpace[P_SPACE].offsetMatrix);
			}
			jointSpace[P_JOINT_SPACE].radius =
				(1 - this.pinchValue) * targetPose.jointTransforms[jointName].radius +
				this.pinchValue * pinchPose.jointTransforms[jointName].radius;
		});
		if (targetPose.gripOffsetMatrix && pinchPose.gripOffsetMatrix) {
			interpolateMatrix(
				this.inputSource.gripSpace![P_SPACE].offsetMatrix,
				targetPose.gripOffsetMatrix!,
				pinchPose.gripOffsetMatrix!,
				this.pinchValue,
			);
		}
	}

	get pinchValue() {
		return this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap[
			'pinch'
		]!.value;
	}

	updatePinchValue(value: number) {
		if (value > 1 || value < 0) {
			console.warn(`Out-of-range value ${value} provided for pinch`);
			return;
		}
		const gamepadButton =
			this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap[
				'pinch'
			]!;
		gamepadButton[P_GAMEPAD].pendingValue = value;
	}

	onFrameStart(frame: XRFrame): void {
		super.onFrameStart(frame);
		this.updateHandPose();
	}
}
