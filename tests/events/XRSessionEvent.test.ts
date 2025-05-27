/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRSessionEvent } from '../../src/events/XRSessionEvent.js';
import { XRSession } from '../../src/session/XRSession.js';

// Mock dependencies
jest.mock('../../src/session/XRSession.js');

describe('XRSessionEvent', () => {
	let mockSession: jest.Mocked<XRSession>;

	beforeEach(() => {
		mockSession = {} as any;
	});

	describe('constructor', () => {
		it('should create event with type and event init', () => {
			const eventInit = {
				session: mockSession,
			};

			const event = new XRSessionEvent('end', eventInit);

			expect(event.type).toBe('end');
			expect(event.session).toBe(mockSession);
		});

		it('should inherit from Event', () => {
			const eventInit = {
				session: mockSession,
			};

			const event = new XRSessionEvent('end', eventInit);

			expect(event).toBeInstanceOf(Event);
		});

		it('should handle event options', () => {
			const eventInit = {
				session: mockSession,
				bubbles: true,
				cancelable: true,
			};

			const event = new XRSessionEvent('end', eventInit);

			expect(event.bubbles).toBe(true);
			expect(event.cancelable).toBe(true);
		});

		it('should throw error when session is missing', () => {
			const eventInit = {} as any;

			expect(() => {
				new XRSessionEvent('end', eventInit);
			}).toThrow('XRSessionEventInit.session is required');
		});
	});
});
