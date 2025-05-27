/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRHitTestSource, XRHitTestResult } from '../../src/hittest/XRHitTest.js';
import { XRRay } from '../../src/hittest/XRRay.js';
import { XRSession } from '../../src/session/XRSession.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRSpace } from '../../src/spaces/XRSpace.js';
import { P_SESSION } from '../../src/private.js';

// Mock dependencies
jest.mock('../../src/session/XRSession.js');
jest.mock('../../src/frameloop/XRFrame.js');
jest.mock('../../src/spaces/XRSpace.js');

describe('XRHitTestSource', () => {
	let mockSession: jest.Mocked<XRSession>;
	let mockSpace: jest.Mocked<XRSpace>;

	beforeEach(() => {
		// Create a proper session mock with the private symbol
		mockSession = {
			[P_SESSION]: {
				hitTestSources: new Set()
			}
		} as any;
		mockSpace = {} as any;
	});

	describe('constructor', () => {
		it('should create a hit test source with required options', () => {
			const options = {
				space: mockSpace,
				offsetRay: new XRRay()
			};
			
			const hitTestSource = new XRHitTestSource(mockSession, options);
			
			expect(hitTestSource).toBeDefined();
		});

		it('should use default ray when offsetRay not provided', () => {
			const options = {
				space: mockSpace,
				offsetRay: undefined as any
			};
			
			const hitTestSource = new XRHitTestSource(mockSession, options);
			
			expect(hitTestSource).toBeDefined();
		});
	});

	describe('cancel method', () => {
		it('should remove itself from session hit test sources', () => {
			const options = {
				space: mockSpace,
				offsetRay: new XRRay()
			};
			const hitTestSource = new XRHitTestSource(mockSession, options);
			
			// Add to session first
			(mockSession as any)[P_SESSION].hitTestSources.add(hitTestSource);
			expect((mockSession as any)[P_SESSION].hitTestSources.has(hitTestSource)).toBe(true);
			
			hitTestSource.cancel();
			
			expect((mockSession as any)[P_SESSION].hitTestSources.has(hitTestSource)).toBe(false);
		});
	});
});

describe('XRHitTestResult', () => {
	let mockFrame: jest.Mocked<XRFrame>;
	let mockOffsetSpace: jest.Mocked<XRSpace>;
	let mockBaseSpace: jest.Mocked<XRSpace>;

	beforeEach(() => {
		mockFrame = {
			getPose: jest.fn(),
			createAnchor: jest.fn()
		} as any;
		mockOffsetSpace = {} as any;
		mockBaseSpace = {} as any;
	});

	describe('constructor', () => {
		it('should create a hit test result', () => {
			const result = new XRHitTestResult(mockFrame, mockOffsetSpace);
			
			expect(result).toBeDefined();
		});
	});

	describe('getPose method', () => {
		it('should call frame.getPose with correct spaces', () => {
			const result = new XRHitTestResult(mockFrame, mockOffsetSpace);
			const mockPose = {} as any;
			mockFrame.getPose.mockReturnValue(mockPose);
			
			const pose = result.getPose(mockBaseSpace);
			
			expect(mockFrame.getPose).toHaveBeenCalledWith(mockOffsetSpace, mockBaseSpace);
			expect(pose).toBe(mockPose);
		});

		it('should return undefined when frame.getPose returns undefined', () => {
			const result = new XRHitTestResult(mockFrame, mockOffsetSpace);
			mockFrame.getPose.mockReturnValue(undefined as any);
			
			const pose = result.getPose(mockBaseSpace);
			
			expect(pose).toBeUndefined();
		});
	});

	describe('createAnchor method', () => {
		it('should call frame.createAnchor with rigid transform and offset space', () => {
			const result = new XRHitTestResult(mockFrame, mockOffsetSpace);
			const mockAnchor = {} as any;
			mockFrame.createAnchor.mockReturnValue(mockAnchor);
			
			const anchor = result.createAnchor();
			
			expect(mockFrame.createAnchor).toHaveBeenCalledWith(
				expect.any(Object), // XRRigidTransform
				mockOffsetSpace
			);
			expect(anchor).toBe(mockAnchor);
		});
	});
});