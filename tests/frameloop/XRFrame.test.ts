/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRSession } from '../../src/session/XRSession.js';
import { XRReferenceSpace } from '../../src/spaces/XRReferenceSpace.js';
import { XRSpace } from '../../src/spaces/XRSpace.js';
import { XRJointSpace } from '../../src/spaces/XRJointSpace.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';
import { XRHitTestSource } from '../../src/hittest/XRHitTest.js';
import { XREye } from '../../src/views/XRView.js';
import {
	P_FRAME,
	P_SESSION,
	P_JOINT_SPACE,
	P_DEVICE,
	P_SPACE,
} from '../../src/private.js';

// Mock dependencies
jest.mock('../../src/session/XRSession.js');
jest.mock('../../src/spaces/XRReferenceSpace.js');
jest.mock('../../src/spaces/XRSpace.js');
jest.mock('../../src/spaces/XRJointSpace.js');
jest.mock('../../src/primitives/XRRigidTransform.js');
jest.mock('../../src/hittest/XRHitTest.js');

describe('XRFrame', () => {
	let mockSession: jest.Mocked<XRSession>;
	let mockReferenceSpace: jest.Mocked<XRReferenceSpace>;
	let mockSpace: jest.Mocked<XRSpace>;
	let mockJointSpace: jest.Mocked<XRJointSpace>;
	let mockHitTestSource: jest.Mocked<XRHitTestSource>;

	beforeEach(() => {
		// Create mock session
		mockSession = {
			[P_SESSION]: {
				frameTrackedAnchors: new Set(),
				mode: 'immersive-vr',
				device: {
					viewerSpace: {
						[P_SPACE]: {
							emulated: false,
						},
					} as any,
					viewSpaces: {
						[XREye.Left]: {
							[P_SPACE]: {
								emulated: false,
							},
						} as any,
						[XREye.Right]: {
							[P_SPACE]: {
								emulated: false,
							},
						} as any,
						[XREye.None]: {
							[P_SPACE]: {
								emulated: false,
							},
						} as any,
					},
					[P_DEVICE]: {
						globalSpace: {
							[P_SPACE]: {
								emulated: false,
							},
						} as any,
					},
				},
				getProjectionMatrix: jest
					.fn()
					.mockReturnValue([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
				trackedAnchors: {
					add: jest.fn(),
				} as any,
				newAnchors: {
					set: jest.fn(),
				} as any,
			},
		} as any;

		// Create mock reference space
		mockReferenceSpace = {} as any;

		// Create mock space
		mockSpace = {
			[P_SPACE]: {
				emulated: false,
			},
		} as any;

		// Create mock joint space
		mockJointSpace = {
			[P_JOINT_SPACE]: {
				radius: 0.01,
			},
			[P_SPACE]: {
				emulated: false,
			},
		} as any;

		// Create mock hit test source
		mockHitTestSource = {} as any;
	});

	describe('constructor', () => {
		it('should create XRFrame with required properties', () => {
			const frame = new XRFrame(mockSession, 1, true, true, 1000.5);

			expect(frame.session).toBe(mockSession);
			expect(frame.predictedDisplayTime).toBe(1000.5);
			expect(frame[P_FRAME].id).toBe(1);
			expect(frame[P_FRAME].active).toBe(true);
			expect(frame[P_FRAME].animationFrame).toBe(true);
		});

		it('should initialize with correct internal state', () => {
			const frame = new XRFrame(mockSession, 42, false, false, 2000.25);

			expect(frame[P_FRAME].session).toBe(mockSession);
			expect(frame[P_FRAME].id).toBe(42);
			expect(frame[P_FRAME].active).toBe(false);
			expect(frame[P_FRAME].animationFrame).toBe(false);
			expect(frame[P_FRAME].predictedDisplayTime).toBe(2000.25);
			expect(frame[P_FRAME].detectedPlanes).toBeDefined();
			expect(frame[P_FRAME].detectedMeshes).toBeDefined();
			expect(frame[P_FRAME].trackedAnchors).toBe(
				mockSession[P_SESSION].frameTrackedAnchors,
			);
			expect(frame[P_FRAME].hitTestResultsMap).toBeDefined();
		});
	});

	describe('property getters', () => {
		let activeFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
		});

		it('should return session', () => {
			expect(activeFrame.session).toBe(mockSession);
		});

		it('should return predictedDisplayTime', () => {
			expect(activeFrame.predictedDisplayTime).toBe(1000.5);
		});
	});

	describe('getPose method', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
		});

		it('should return pose when frame is active', () => {
			const pose = activeFrame.getPose(mockSpace, mockReferenceSpace);

			expect(pose).toBeDefined();
			expect(pose.transform).toBeDefined();
			// emulated property is internal
		});

		it('should throw InvalidStateError when frame is inactive', () => {
			expect(() => {
				inactiveFrame.getPose(mockSpace, mockReferenceSpace);
			}).toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});
	});

	describe('getViewerPose method', () => {
		let activeAnimationFrame: XRFrame;
		let activeNonAnimationFrame: XRFrame;

		beforeEach(() => {
			activeAnimationFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			activeNonAnimationFrame = new XRFrame(
				mockSession,
				2,
				true,
				false,
				2000.5,
			);
		});

		it('should return viewer pose for active animation frame', () => {
			const viewerPose = activeAnimationFrame.getViewerPose(mockReferenceSpace);

			expect(viewerPose).toBeDefined();
			expect(viewerPose.transform).toBeDefined();
			expect(viewerPose.views).toBeDefined();
			expect(Array.isArray(viewerPose.views)).toBe(true);
		});

		it('should handle inline session mode', () => {
			mockSession[P_SESSION].mode = 'inline';
			const viewerPose = activeAnimationFrame.getViewerPose(mockReferenceSpace);

			expect(viewerPose).toBeDefined();
			expect(viewerPose.views.length).toBe(1);
		});

		it('should handle immersive session mode', () => {
			mockSession[P_SESSION].mode = 'immersive-vr';
			const viewerPose = activeAnimationFrame.getViewerPose(mockReferenceSpace);

			expect(viewerPose).toBeDefined();
			expect(viewerPose.views.length).toBe(2);
		});

		it('should throw InvalidStateError when not animation frame', () => {
			expect(() => {
				activeNonAnimationFrame.getViewerPose(mockReferenceSpace);
			}).toThrow(
				new DOMException(
					'getViewerPose can only be called on XRFrame objects passed to XRSession.requestAnimationFrame callbacks.',
					'InvalidStateError',
				),
			);
		});
	});

	describe('getJointPose method', () => {
		let activeFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
		});

		it('should return joint pose with radius', () => {
			const jointPose = activeFrame.getJointPose(
				mockJointSpace,
				mockReferenceSpace,
			);

			expect(jointPose).toBeDefined();
			expect(jointPose.transform).toBeDefined();
			expect(jointPose.radius).toBeCloseTo(0.01);
			// emulated property is internal
		});

		it('should handle joint pose with different radius values', () => {
			const largeJointSpace = {
				[P_JOINT_SPACE]: {
					radius: 0.05,
				},
				[P_SPACE]: {
					emulated: false,
				},
			} as any;

			const jointPose = activeFrame.getJointPose(
				largeJointSpace,
				mockReferenceSpace,
			);

			expect(jointPose).toBeDefined();
			expect(jointPose.radius).toBeCloseTo(0.05);
		});
	});

	describe('fillJointRadii method', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
		});

		it('should fill radii array when frame is active', () => {
			const jointSpaces = [mockJointSpace];
			const radii = new Float32Array(1);

			const result = activeFrame.fillJointRadii(jointSpaces, radii);

			expect(result).toBe(true);
			expect(radii[0]).toBeCloseTo(0.01);
		});

		it('should handle invalid joint radius', () => {
			const invalidJointSpace = {
				[P_JOINT_SPACE]: {
					radius: null,
				},
			} as any;
			const jointSpaces = [invalidJointSpace];
			const radii = new Float32Array(1);

			const result = activeFrame.fillJointRadii(jointSpaces, radii);

			expect(result).toBe(false);
			expect(radii[0]).toBeNaN();
		});

		it('should handle multiple joint spaces', () => {
			const validJointSpace = {
				[P_JOINT_SPACE]: {
					radius: 0.02,
				},
			} as any;
			const invalidJointSpace = {
				[P_JOINT_SPACE]: {
					radius: null,
				},
			} as any;
			const jointSpaces = [validJointSpace, invalidJointSpace];
			const radii = new Float32Array(2);

			const result = activeFrame.fillJointRadii(jointSpaces, radii);

			expect(result).toBe(false);
			expect(radii[0]).toBeCloseTo(0.02);
			expect(radii[1]).toBeNaN();
		});

		it('should throw InvalidStateError when frame is inactive', () => {
			const jointSpaces = [mockJointSpace];
			const radii = new Float32Array(1);

			expect(() => {
				inactiveFrame.fillJointRadii(jointSpaces, radii);
			}).toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});

		it('should throw TypeError when jointSpaces length exceeds radii length', () => {
			const jointSpaces = [mockJointSpace, mockJointSpace];
			const radii = new Float32Array(1);

			expect(() => {
				activeFrame.fillJointRadii(jointSpaces, radii);
			}).toThrow(
				new DOMException(
					'The length of jointSpaces is larger than the number of elements in radii',
					'TypeError',
				),
			);
		});

		it('should convert sequence to array', () => {
			// Test that the method handles sequence-like objects
			const jointSpaceSequence = {
				0: mockJointSpace,
				length: 1,
				[Symbol.iterator]: function* () {
					yield this[0];
				},
			} as any;
			const radii = new Float32Array(1);

			const result = activeFrame.fillJointRadii(jointSpaceSequence, radii);

			expect(result).toBe(true);
			expect(radii[0]).toBeCloseTo(0.01);
		});
	});

	describe('fillPoses method', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
		});

		it('should fill transforms array when frame is active', () => {
			const spaces = [mockSpace];
			const transforms = new Float32Array(16);

			const result = activeFrame.fillPoses(
				spaces,
				mockReferenceSpace,
				transforms,
			);

			expect(result).toBe(true);
			expect(transforms.length).toBe(16);
		});

		it('should handle multiple spaces', () => {
			const spaces = [mockSpace, mockSpace];
			const transforms = new Float32Array(32);

			const result = activeFrame.fillPoses(
				spaces,
				mockReferenceSpace,
				transforms,
			);

			expect(result).toBe(true);
			expect(transforms.length).toBe(32);
		});

		it('should throw InvalidStateError when frame is inactive', () => {
			const spaces = [mockSpace];
			const transforms = new Float32Array(16);

			expect(() => {
				inactiveFrame.fillPoses(spaces, mockReferenceSpace, transforms);
			}).toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});

		it('should throw TypeError when spaces length * 16 exceeds transforms length', () => {
			const spaces = [mockSpace, mockSpace];
			const transforms = new Float32Array(16); // Only space for 1 space, not 2

			expect(() => {
				activeFrame.fillPoses(spaces, mockReferenceSpace, transforms);
			}).toThrow(
				new DOMException(
					'The length of spaces multiplied by 16 is larger than the number of elements in transforms',
					'TypeError',
				),
			);
		});

		it('should convert sequence to array', () => {
			// Test that the method handles sequence-like objects
			const spaceSequence = {
				0: mockSpace,
				length: 1,
				[Symbol.iterator]: function* () {
					yield this[0];
				},
			} as any;
			const transforms = new Float32Array(16);

			const result = activeFrame.fillPoses(
				spaceSequence,
				mockReferenceSpace,
				transforms,
			);

			expect(result).toBe(true);
		});
	});

	describe('detectedPlanes getter', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
		});

		it('should return detected planes when frame is active', () => {
			const planes = activeFrame.detectedPlanes;

			expect(planes).toBeDefined();
		});

		it('should throw InvalidStateError when frame is inactive', () => {
			expect(() => {
				inactiveFrame.detectedPlanes;
			}).toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});
	});

	describe('detectedMeshes getter', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
		});

		it('should return detected meshes when frame is active', () => {
			const meshes = activeFrame.detectedMeshes;

			expect(meshes).toBeDefined();
		});

		it('should throw InvalidStateError when frame is inactive', () => {
			expect(() => {
				inactiveFrame.detectedMeshes;
			}).toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});
	});

	describe('trackedAnchors getter', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
		});

		it('should return tracked anchors when frame is active', () => {
			const anchors = activeFrame.trackedAnchors;

			expect(anchors).toBe(mockSession[P_SESSION].frameTrackedAnchors);
		});

		it('should throw InvalidStateError when frame is inactive', () => {
			expect(() => {
				inactiveFrame.trackedAnchors;
			}).toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});
	});

	describe('createAnchor method', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;
		let mockPose: jest.Mocked<XRRigidTransform>;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
			mockPose = {
				matrix: new Float32Array([
					1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
				]),
			} as any;
		});

		it('should create anchor promise when frame is active', async () => {
			const anchorPromise = activeFrame.createAnchor(mockPose, mockSpace);

			expect(anchorPromise).toBeInstanceOf(Promise);

			expect(mockSession[P_SESSION].trackedAnchors.add).toHaveBeenCalled();
			expect(mockSession[P_SESSION].newAnchors.set).toHaveBeenCalled();
		});

		it('should reject promise when frame is inactive', async () => {
			const anchorPromise = inactiveFrame.createAnchor(mockPose, mockSpace);

			await expect(anchorPromise).rejects.toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});
	});

	describe('getHitTestResults method', () => {
		let activeFrame: XRFrame;
		let inactiveFrame: XRFrame;

		beforeEach(() => {
			activeFrame = new XRFrame(mockSession, 1, true, true, 1000.5);
			inactiveFrame = new XRFrame(mockSession, 2, false, false, 2000.5);
		});

		it('should return hit test results when available', () => {
			const mockResults = [{ transform: {} } as any];
			activeFrame[P_FRAME].hitTestResultsMap.set(
				mockHitTestSource,
				mockResults,
			);

			const results = activeFrame.getHitTestResults(mockHitTestSource);

			expect(results).toEqual(mockResults);
			expect(results).not.toBe(mockResults); // Should be a copy
		});

		it('should throw InvalidStateError when frame is inactive', () => {
			expect(() => {
				inactiveFrame.getHitTestResults(mockHitTestSource);
			}).toThrow(
				new DOMException(
					'XRFrame access outside the callback that produced it is invalid.',
					'InvalidStateError',
				),
			);
		});

		it('should throw InvalidStateError when hit test source not available', () => {
			expect(() => {
				activeFrame.getHitTestResults(mockHitTestSource);
			}).toThrow(
				new DOMException(
					'Requested hit test results are not available for current frame.',
					'InvalidStateError',
				),
			);
		});
	});

	describe('edge cases and integration', () => {
		it('should handle frame with zero predicted display time', () => {
			const frame = new XRFrame(mockSession, 0, true, true, 0);

			expect(frame.predictedDisplayTime).toBe(0);
		});

		it('should handle negative frame id', () => {
			const frame = new XRFrame(mockSession, -1, true, true, 1000);

			expect(frame[P_FRAME].id).toBe(-1);
		});

		it('should handle very large predicted display time', () => {
			const largeTime = Number.MAX_SAFE_INTEGER;
			const frame = new XRFrame(mockSession, 1, true, true, largeTime);

			expect(frame.predictedDisplayTime).toBe(largeTime);
		});
	});
});
