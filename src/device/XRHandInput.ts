/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	PRIVATE as GAMEPAD_PRIVATE,
	Gamepad,
	GamepadConfig,
	GamepadMappingType,
} from '../gamepad/Gamepad.js';
import {
	GlobalSpace,
	PRIVATE as XRSPACE_PRIVATE,
	XRSpace,
} from '../spaces/XRSpace.js';
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
	PRIVATE as XRTRACKEDINPUT_PRIVATE,
	XRTrackedInput,
} from './XRTrackedInput.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { XRFrame } from '../frameloop/XRFrame.js';
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

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-hand-input');

export class XRHandInput extends XRTrackedInput {
	[PRIVATE]: {
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
		this[PRIVATE] = {
			poseId: 'default',
			poses: handInputConfig.poses,
		};

		this.updateHandPose();
	}

	get poseId() {
		return this[PRIVATE].poseId;
	}

	set poseId(poseId: string) {
		if (!this[PRIVATE].poses[poseId]) {
			console.warn(`Pose config ${poseId} not found`);
			return;
		}
		this[PRIVATE].poseId = poseId;
	}

	updateHandPose() {
		const targetPose = this[PRIVATE].poses[this[PRIVATE].poseId];
		const pinchPose = this[PRIVATE].poses.pinch;
		Object.values(XRHandJoint).forEach((jointName) => {
			const targetJointMatrix =
				targetPose.jointTransforms[jointName].offsetMatrix;
			const pinchJointMatrix =
				pinchPose.jointTransforms[jointName].offsetMatrix;
			const jointSpace = this.inputSource.hand!.get(jointName)!;
			interpolateMatrix(
				jointSpace[XRSPACE_PRIVATE].offsetMatrix,
				targetJointMatrix,
				pinchJointMatrix,
				this.pinchValue,
			);
			if (this.inputSource.handedness === XRHandedness.Right) {
				mirrorMatrixToRight(jointSpace[XRSPACE_PRIVATE].offsetMatrix);
			}
			jointSpace[XRJOINTSPACE_PRIVATE].radius =
				(1 - this.pinchValue) * targetPose.jointTransforms[jointName].radius +
				this.pinchValue * pinchPose.jointTransforms[jointName].radius;
		});
		if (targetPose.gripOffsetMatrix && pinchPose.gripOffsetMatrix) {
			interpolateMatrix(
				this.inputSource.gripSpace![XRSPACE_PRIVATE].offsetMatrix,
				targetPose.gripOffsetMatrix!,
				pinchPose.gripOffsetMatrix!,
				this.pinchValue,
			);
		}
	}

	get pinchValue() {
		return this[XRTRACKEDINPUT_PRIVATE].inputSource.gamepad![GAMEPAD_PRIVATE]
			.buttonsMap['pinch']!.value;
	}

	updatePinchValue(value: number) {
		if (value > 1 || value < 0) {
			console.warn(`Out-of-range value ${value} provided for pinch`);
			return;
		}
		const gamepadButton =
			this[XRTRACKEDINPUT_PRIVATE].inputSource.gamepad![GAMEPAD_PRIVATE]
				.buttonsMap['pinch']!;
		gamepadButton[GAMEPAD_PRIVATE].pendingValue = value;
	}

	onFrameStart(frame: XRFrame): void {
		super.onFrameStart(frame);
		this.updateHandPose();
	}
}
