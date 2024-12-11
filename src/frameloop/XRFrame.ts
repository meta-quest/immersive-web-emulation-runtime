/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRAnchor, XRAnchorSet } from '../anchors/XRAnchor.js';
import { XREye, XRView } from '../views/XRView.js';
import {
	PRIVATE as XRJOINTSPACE_PRIVATE,
	XRJointSpace,
} from '../spaces/XRJointSpace.js';
import {
	PRIVATE as XRSESSION_PRIVATE,
	XRSession,
	XRSessionMode,
} from '../session/XRSession.js';
import {
	PRIVATE as XRSPACE_PRIVATE,
	XRSpace,
	XRSpaceUtils,
} from '../spaces/XRSpace.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { PRIVATE as XRDEVICE_PRIVATE } from '../device/XRDevice.js';
import { XRJointPose } from '../pose/XRJointPose.js';
import { XRMeshSet } from '../meshes/XRMesh.js';
import { XRPlaneSet } from '../planes/XRPlane.js';
import { XRPose } from '../pose/XRPose.js';
import { XRReferenceSpace } from '../spaces/XRReferenceSpace.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRViewerPose } from '../pose/XRViewerPose.js';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-frame');

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
	[PRIVATE]: {
		session: XRSession;
		id: number;
		active: boolean;
		animationFrame: boolean;
		predictedDisplayTime: number;
		tempMat4: mat4;
		detectedPlanes: XRPlaneSet;
		detectedMeshes: XRMeshSet;
		trackedAnchors: XRAnchorSet;
	};

	constructor(
		session: XRSession,
		id: number,
		active: boolean,
		animationFrame: boolean,
		predictedDisplayTime: number,
	) {
		this[PRIVATE] = {
			session,
			id,
			active,
			animationFrame,
			predictedDisplayTime,
			tempMat4: mat4.create(),
			detectedPlanes: new XRPlaneSet(),
			detectedMeshes: new XRMeshSet(),
			trackedAnchors: session[XRSESSION_PRIVATE].frameTrackedAnchors,
		};
	}

	get session() {
		return this[PRIVATE].session;
	}

	get predictedDisplayTime() {
		return this[PRIVATE].predictedDisplayTime;
	}

	getPose(space: XRSpace, baseSpace: XRSpace) {
		if (!this[PRIVATE].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		getOffsetMatrix(this[PRIVATE].tempMat4, space, baseSpace);
		const position = vec3.create();
		mat4.getTranslation(position, this[PRIVATE].tempMat4);
		const orientation = quat.create();
		mat4.getRotation(orientation, this[PRIVATE].tempMat4);
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
			space[XRSPACE_PRIVATE].emulated,
		);
	}

	getViewerPose(referenceSpace: XRReferenceSpace) {
		if (!this[PRIVATE].animationFrame) {
			throw new DOMException(
				'getViewerPose can only be called on XRFrame objects passed to XRSession.requestAnimationFrame callbacks.',
				'InvalidStateError',
			);
		}
		const session = this[PRIVATE].session;
		const device = session[XRSESSION_PRIVATE].device;
		const pose = this.getPose(device.viewerSpace, referenceSpace);
		const eyes =
			session[XRSESSION_PRIVATE].mode === XRSessionMode.Inline
				? [XREye.None]
				: [XREye.Left, XREye.Right];

		const views: XRView[] = [];
		eyes.forEach((eye) => {
			const viewSpace = device.viewSpaces[eye];
			const viewPose = this.getPose(viewSpace, referenceSpace);
			const projectionMatrix =
				session[XRSESSION_PRIVATE].getProjectionMatrix(eye);
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
		const radius = joint[XRJOINTSPACE_PRIVATE].radius;
		return new XRJointPose(xrPose.transform, radius, false);
	}

	fillJointRadii(jointSpaces: XRJointSpace[], radii: Float32Array) {
		// converting from sequence type to array
		jointSpaces = Array.from(jointSpaces);
		if (!this[PRIVATE].active) {
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
			if (!jointSpaces[offset][XRJOINTSPACE_PRIVATE].radius) {
				radii[offset] = NaN;
				allValid = false;
			} else {
				radii[offset] = jointSpaces[offset][XRJOINTSPACE_PRIVATE].radius;
			}
		}
		return allValid;
	}

	fillPoses(spaces: XRSpace[], baseSpace: XRSpace, transforms: Float32Array) {
		// converting from sequence type to array
		spaces = Array.from(spaces);
		if (!this[PRIVATE].active) {
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
			getOffsetMatrix(this[PRIVATE].tempMat4, space, baseSpace);
			for (let j = 0; j < 16; j++) {
				transforms[i * 16 + j] = this[PRIVATE].tempMat4[j];
			}
		});
		return true;
	}

	get detectedPlanes() {
		if (!this[PRIVATE].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		return this[PRIVATE].detectedPlanes;
	}

	get detectedMeshes() {
		if (!this[PRIVATE].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		return this[PRIVATE].detectedMeshes;
	}

	get trackedAnchors() {
		if (!this[PRIVATE].active) {
			throw new DOMException(
				'XRFrame access outside the callback that produced it is invalid.',
				'InvalidStateError',
			);
		}
		return this[PRIVATE].trackedAnchors;
	}

	createAnchor(pose: XRRigidTransform, space: XRSpace) {
		return new Promise<XRAnchor>((resolve, reject) => {
			if (!this[PRIVATE].active) {
				reject(
					new DOMException(
						'XRFrame access outside the callback that produced it is invalid.',
						'InvalidStateError',
					),
				);
			} else {
				const globalSpace =
					this[PRIVATE].session[XRSESSION_PRIVATE].device[XRDEVICE_PRIVATE]
						.globalSpace;
				const tempSpace = new XRSpace(space, pose.matrix);
				const globalOffsetMatrix =
					XRSpaceUtils.calculateGlobalOffsetMatrix(tempSpace);
				const anchorSpace = new XRSpace(globalSpace, globalOffsetMatrix);
				const anchor = new XRAnchor(anchorSpace, this[PRIVATE].session);
				this[PRIVATE].session[XRSESSION_PRIVATE].trackedAnchors.add(anchor);
				this[PRIVATE].session[XRSESSION_PRIVATE].newAnchors.set(anchor, {
					resolve,
					reject,
				});
			}
		});
	}
}
