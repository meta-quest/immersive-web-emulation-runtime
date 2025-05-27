/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRReferenceSpaceEvent } from '../../src/events/XRReferenceSpaceEvent.js';
import { XRReferenceSpace } from '../../src/spaces/XRReferenceSpace.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';

// Mock dependencies
jest.mock('../../src/spaces/XRReferenceSpace.js');
jest.mock('../../src/primitives/XRRigidTransform.js');

describe('XRReferenceSpaceEvent', () => {
	let mockReferenceSpace: jest.Mocked<XRReferenceSpace>;
	let mockTransform: jest.Mocked<XRRigidTransform>;

	beforeEach(() => {
		mockReferenceSpace = {} as any;
		mockTransform = {} as any;
	});

	describe('constructor', () => {
		it('should create event with type and event init', () => {
			const eventInit = {
				referenceSpace: mockReferenceSpace,
				transform: mockTransform,
			};

			const event = new XRReferenceSpaceEvent('reset', eventInit);

			expect(event.type).toBe('reset');
			expect(event.referenceSpace).toBe(mockReferenceSpace);
			expect(event.transform).toBe(mockTransform);
		});

		it('should inherit from Event', () => {
			const eventInit = {
				referenceSpace: mockReferenceSpace,
				transform: mockTransform,
			};

			const event = new XRReferenceSpaceEvent('reset', eventInit);

			expect(event).toBeInstanceOf(Event);
		});

		it('should handle event options', () => {
			const eventInit = {
				referenceSpace: mockReferenceSpace,
				transform: mockTransform,
				bubbles: true,
				cancelable: true,
			};

			const event = new XRReferenceSpaceEvent('reset', eventInit);

			expect(event.bubbles).toBe(true);
			expect(event.cancelable).toBe(true);
		});

		it('should throw error when referenceSpace is missing', () => {
			const eventInit = {
				transform: mockTransform,
			} as any;

			expect(() => {
				new XRReferenceSpaceEvent('reset', eventInit);
			}).toThrow('XRReferenceSpaceEventInit.referenceSpace is required');
		});
	});
});
