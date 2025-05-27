/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRInputSourcesChangeEvent } from '../../src/events/XRInputSourcesChangeEvent.js';
import { XRInputSource } from '../../src/input/XRInputSource.js';
import { XRSession } from '../../src/session/XRSession.js';

// Mock dependencies
jest.mock('../../src/input/XRInputSource.js');
jest.mock('../../src/session/XRSession.js');

describe('XRInputSourcesChangeEvent', () => {
	let mockInputSource1: jest.Mocked<XRInputSource>;
	let mockInputSource2: jest.Mocked<XRInputSource>;
	let mockSession: jest.Mocked<XRSession>;

	beforeEach(() => {
		mockInputSource1 = {} as any;
		mockInputSource2 = {} as any;
		mockSession = {} as any;
	});

	describe('constructor', () => {
		it('should create event with type and event init', () => {
			const eventInit = {
				session: mockSession,
				added: [mockInputSource1],
				removed: [mockInputSource2],
			};

			const event = new XRInputSourcesChangeEvent(
				'inputsourceschange',
				eventInit,
			);

			expect(event.type).toBe('inputsourceschange');
			expect(event.session).toBe(mockSession);
			expect(event.added).toEqual([mockInputSource1]);
			expect(event.removed).toEqual([mockInputSource2]);
		});

		it('should handle empty added and removed arrays', () => {
			const eventInit = {
				session: mockSession,
				added: [],
				removed: [],
			};

			const event = new XRInputSourcesChangeEvent(
				'inputsourceschange',
				eventInit,
			);

			expect(event.added).toEqual([]);
			expect(event.removed).toEqual([]);
		});

		it('should handle multiple input sources', () => {
			const mockInputSource3 = {} as any;
			const eventInit = {
				session: mockSession,
				added: [mockInputSource1, mockInputSource2],
				removed: [mockInputSource3],
			};

			const event = new XRInputSourcesChangeEvent(
				'inputsourceschange',
				eventInit,
			);

			expect(event.added).toHaveLength(2);
			expect(event.removed).toHaveLength(1);
			expect(event.added).toContain(mockInputSource1);
			expect(event.added).toContain(mockInputSource2);
		});

		it('should inherit from Event', () => {
			const eventInit = {
				session: mockSession,
				added: [],
				removed: [],
			};

			const event = new XRInputSourcesChangeEvent(
				'inputsourceschange',
				eventInit,
			);

			expect(event).toBeInstanceOf(Event);
		});

		it('should handle event options', () => {
			const eventInit = {
				session: mockSession,
				added: [],
				removed: [],
				bubbles: true,
				cancelable: true,
			};

			const event = new XRInputSourcesChangeEvent(
				'inputsourceschange',
				eventInit,
			);

			expect(event.bubbles).toBe(true);
			expect(event.cancelable).toBe(true);
		});

		it('should throw error when session is missing', () => {
			const eventInit = {
				added: [],
				removed: [],
			} as any;

			expect(() => {
				new XRInputSourcesChangeEvent('inputsourceschange', eventInit);
			}).toThrow('XRInputSourcesChangeEventInit.session is required');
		});

		it('should throw error when added is missing', () => {
			const eventInit = {
				session: mockSession,
				removed: [],
			} as any;

			expect(() => {
				new XRInputSourcesChangeEvent('inputsourceschange', eventInit);
			}).toThrow('XRInputSourcesChangeEventInit.added is required');
		});

		it('should throw error when removed is missing', () => {
			const eventInit = {
				session: mockSession,
				added: [],
			} as any;

			expect(() => {
				new XRInputSourcesChangeEvent('inputsourceschange', eventInit);
			}).toThrow('XRInputSourcesChangeEventInit.removed is required');
		});
	});
});
