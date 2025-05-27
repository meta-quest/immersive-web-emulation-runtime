/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRInputSourceEvent } from '../../src/events/XRInputSourceEvent.js';
import { XRInputSource } from '../../src/input/XRInputSource.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';

// Mock dependencies
jest.mock('../../src/input/XRInputSource.js');
jest.mock('../../src/frameloop/XRFrame.js');

describe('XRInputSourceEvent', () => {
	let mockInputSource: jest.Mocked<XRInputSource>;
	let mockFrame: jest.Mocked<XRFrame>;

	beforeEach(() => {
		mockInputSource = {} as any;
		mockFrame = {} as any;
	});

	describe('constructor', () => {
		it('should create event with type and event init', () => {
			const eventInit = {
				frame: mockFrame,
				inputSource: mockInputSource,
			};

			const event = new XRInputSourceEvent('select', eventInit);

			expect(event.type).toBe('select');
			expect(event.frame).toBe(mockFrame);
			expect(event.inputSource).toBe(mockInputSource);
		});

		it('should inherit from Event', () => {
			const eventInit = {
				frame: mockFrame,
				inputSource: mockInputSource,
			};

			const event = new XRInputSourceEvent('select', eventInit);

			expect(event).toBeInstanceOf(Event);
		});

		it('should handle event options', () => {
			const eventInit = {
				frame: mockFrame,
				inputSource: mockInputSource,
				bubbles: true,
				cancelable: true,
			};

			const event = new XRInputSourceEvent('select', eventInit);

			expect(event.bubbles).toBe(true);
			expect(event.cancelable).toBe(true);
		});

		it('should throw error when frame is missing', () => {
			const eventInit = {
				inputSource: mockInputSource,
			} as any;

			expect(() => {
				new XRInputSourceEvent('select', eventInit);
			}).toThrow('XRInputSourceEventInit.frame is required');
		});

		it('should throw error when inputSource is missing', () => {
			const eventInit = {
				frame: mockFrame,
			} as any;

			expect(() => {
				new XRInputSourceEvent('select', eventInit);
			}).toThrow('XRInputSourceEventInit.inputSource is required');
		});
	});
});
