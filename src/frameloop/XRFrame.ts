/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	P_DEVICE,
	P_FRAME,
	P_JOINT_SPACE,
	P_SESSION,
	P_SPACE,
} from '../private.js';
import { XRAnchor, XRAnchorSet } from '../anchors/XRAnchor.js';
import { XREye, XRView } from '../views/XRView.js';
import { XRHitTestResult, XRHitTestSource } from '../hittest/XRHitTest.js';
import { XRSpace, XRSpaceUtils } from '../spaces/XRSpace.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { XRJointPose } from '../pose/XRJointPose.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRMeshSet } from '../meshes/XRMesh.js';
import { XRPlaneSet } from '../planes/XRPlane.js';
import { XRPose } from '../pose/XRPose.js';
import { XRReferenceSpace } from '../spaces/XRReferenceSpace.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSession } from '../session/XRSession.js';
import { XRViewerPose } from '../pose/XRViewerPose.js';

const spaceGlobalMatrix = mat4.create();
const baseSpaceGlobalMatrix = mat4.create();
const baseSpaceGlobalMatrixInverse = mat4.create();

const getOffsetMatrix = (
	offsetMatrix: mat4,
	space: XRSpace,
	baseSpace: XRSpace,
) => {
	XRSpaceUtils.calculateGlobalOffsetMatrix(space, spaceGlobalMatrix);
	XRSpaceUtils.calculateGlobalOffsetMatrix(baseSpace, baseSpaceGlobalMatrix);
	mat4.invert(baseSpaceGlobalMatrixInverse, baseSpaceGlobalMatrix);
	mat4.multiply(offsetMatrix, baseSpaceGlobalMatrixInverse, spaceGlobalMatrix);
};

export class XRFrame {
	[P_FRAME]: {
		session: XRSession;
		id: number;
		active: boolean;
		animationFrame: boolean;
		predictedDisplayTime: number;
		tempMat4: mat4;
		detectedPlanes: XRPlaneSet;
		detectedMeshes: XRMeshSet;
		trackedAnchors: XRAnchorSet;
		hitTestResultsMap: Map<XRHitTestSource, XRHitTestResult[]>;
	};

	constructor(
		session: XRSession,
		id: number,
		active: boolean,
		animationFrame: boolean,
		predictedDisplayTime: number,
	) {
		this[P_FRAME] = {
			session,
			id,
			active,
			animationFrame,
			predictedDisplayTime,
			tempMat4: mat4.create(),
			detectedPlanes: new XRPlaneSet(),
			detectedMeshes: new XRMeshSet(),
			trackedAnchors: session[P_SESSION].frameTrackedAnchors,
			hitTestResultsMap: new Map(),
		};
	}

	get session() {
		return this[P_FRAME].session;
	}

	get predictedDisplayTime() {
		return this[P_FRAME].predictedDisplayTime;
	}

	getPose(space: XRSpace, baseSpace: XRSpace) {
		if (!this[P_FRAME].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		getOffsetMatrix(this[P_FRAME].tempMat4, space, baseSpace);
		const position = vec3.create();
		mat4.getTranslation(position, this[P_FRAME].tempMat4);
		const orientation = quat.create();
		mat4.getRotation(orientation, this[P_FRAME].tempMat4);
		return new XRPose(
			new XRRigidTransform(
				{ x: position[0], y: position[1], z: position[2], w: 1.0 },
				{
					x: orientation[0],
					y: orientation[1],
					z: orientation[2],
					w: orientation[3],
				},
			),
			space[P_SPACE].emulated,
		);
	}

	getViewerPose(referenceSpace: XRReferenceSpace) {
		if (!this[P_FRAME].animationFrame) {
			throw new DOMException(
				'getViewerPose can only be called on XRFrame objects passed to XRSession.requestAnimationFrame callbacks.',
				'InvalidStateError',
			);
		}
		const session = this[P_FRAME].session;
		const device = session[P_SESSION].device;
		const pose = this.getPose(device.viewerSpace, referenceSpace);
		const eyes =
			session[P_SESSION].mode === 'inline'
				? [XREye.None]
				: [XREye.Left, XREye.Right];

		const views: XRView[] = [];
		eyes.forEach((eye) => {
			const viewSpace = device.viewSpaces[eye];
			const viewPose = this.getPose(viewSpace, referenceSpace);
			const projectionMatrix = session[P_SESSION].getProjectionMatrix(eye);
			const view = new XRView(
				eye,
				new Float32Array(projectionMatrix),
				viewPose.transform,
				session,
			);
			views.push(view);
		});

		return new XRViewerPose(pose.transform, views, false);
	}

	getJointPose(joint: XRJointSpace, baseSpace: XRSpace) {
		const xrPose = this.getPose(joint, baseSpace);
		const radius = joint[P_JOINT_SPACE].radius;
		return new XRJointPose(xrPose.transform, radius, false);
	}

	fillJointRadii(jointSpaces: XRJointSpace[], radii: Float32Array) {
		// converting from sequence type to array
		jointSpaces = Array.from(jointSpaces);
		if (!this[P_FRAME].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		if (jointSpaces.length > radii.length) {
			throw new DOMException(
				'The length of jointSpaces is larger than the number of elements in radii',
				'TypeError',
			);
		}
		let allValid = true;
		for (let offset = 0; offset < jointSpaces.length; offset++) {
			if (!jointSpaces[offset][P_JOINT_SPACE].radius) {
				radii[offset] = NaN;
				allValid = false;
			} else {
				radii[offset] = jointSpaces[offset][P_JOINT_SPACE].radius;
			}
		}
		return allValid;
	}

	fillPoses(spaces: XRSpace[], baseSpace: XRSpace, transforms: Float32Array) {
		// converting from sequence type to array
		spaces = Array.from(spaces);
		if (!this[P_FRAME].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		if (spaces.length * 16 > transforms.length) {
			throw new DOMException(
				'The length of spaces multiplied by 16 is larger than the number of elements in transforms',
				'TypeError',
			);
		}
		spaces.forEach((space, i) => {
			getOffsetMatrix(this[P_FRAME].tempMat4, space, baseSpace);
			for (let j = 0; j < 16; j++) {
				transforms[i * 16 + j] = this[P_FRAME].tempMat4[j];
			}
		});
		return true;
	}

	get detectedPlanes() {
		if (!this[P_FRAME].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		return this[P_FRAME].detectedPlanes;
	}

	get detectedMeshes() {
		if (!this[P_FRAME].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		return this[P_FRAME].detectedMeshes;
	}

	get trackedAnchors() {
		if (!this[P_FRAME].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		return this[P_FRAME].trackedAnchors;
	}

	createAnchor(pose: XRRigidTransform, space: XRSpace) {
		return new Promise<XRAnchor>((resolve, reject) => {
			if (!this[P_FRAME].active) {
				reject(
					new DOMException(
						'XRFrame access outside the callback that produced it is invalid.',
						'InvalidStateError',
					),
				);
			} else {
				const globalSpace =
					this[P_FRAME].session[P_SESSION].device[P_DEVICE].globalSpace;
				const tempSpace = new XRSpace(space, pose.matrix);
				const globalOffsetMatrix =
					XRSpaceUtils.calculateGlobalOffsetMatrix(tempSpace);
				const anchorSpace = new XRSpace(globalSpace, globalOffsetMatrix);
				const anchor = new XRAnchor(anchorSpace, this[P_FRAME].session);
				this[P_FRAME].session[P_SESSION].trackedAnchors.add(anchor);
				this[P_FRAME].session[P_SESSION].newAnchors.set(anchor, {
					resolve,
					reject,
				});
			}
		});
	}

	getHitTestResults(hitTestSource: XRHitTestSource) {
		if (!this[P_FRAME].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		} else if (!this[P_FRAME].hitTestResultsMap.has(hitTestSource)) {
			throw new DOMException(
				'Requested hit test results are not available for current frame.',
				'InvalidStateError',
			);
		} else {
			return [...this[P_FRAME].hitTestResultsMap.get(hitTestSource)!];
		}
	}
}
