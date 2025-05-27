/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	XRAnchor,
	XRAnchorSet,
	XRAnchorUtils,
} from '../../src/anchors/XRAnchor.js';
import { XRSession } from '../../src/session/XRSession.js';
import { XRSpace } from '../../src/spaces/XRSpace.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import { P_SESSION, P_DEVICE, P_SPACE, P_ANCHOR } from '../../src/private.js';
import { mat4 } from 'gl-matrix';

// Mock dependencies
jest.mock('../../src/session/XRSession.js');
jest.mock('../../src/spaces/XRSpace.js');
jest.mock('../../src/device/XRDevice.js');

// Mock crypto.randomUUID
const mockRandomUUID = jest.fn();
Object.defineProperty(global, 'crypto', {
	value: {
		randomUUID: mockRandomUUID,
	},
});

// Mock localStorage
const localStorageMock = {
	getItem: jest.fn(),
	setItem: jest.fn(),
	removeItem: jest.fn(),
	clear: jest.fn(),
};
Object.defineProperty(global, 'localStorage', {
	value: localStorageMock,
});

describe('XRAnchor', () => {
	let mockSession: jest.Mocked<XRSession>;
	let mockAnchorSpace: jest.Mocked<XRSpace>;
	let mockDevice: jest.Mocked<XRDevice>;
	let mockGlobalSpace: jest.Mocked<XRSpace>;

	beforeEach(() => {
		// Reset mocks
		jest.clearAllMocks();
		mockRandomUUID.mockReturnValue('test-uuid-123');
		localStorageMock.getItem.mockReturnValue('{}');

		// Create mock spaces
		mockGlobalSpace = {
			[P_SPACE]: {
				offsetMatrix: mat4.create(),
			},
		} as any;

		mockAnchorSpace = {
			[P_SPACE]: {
				offsetMatrix: mat4.create(),
			},
		} as any;

		// Create mock device
		mockDevice = {
			[P_DEVICE]: {
				globalSpace: mockGlobalSpace,
			},
		} as any;

		// Create mock session
		mockSession = {
			[P_SESSION]: {
				trackedAnchors: new Set(),
				persistentAnchors: new Map(),
				device: mockDevice,
			},
		} as any;
	});

	describe('constructor', () => {
		it('should create an anchor with space and session', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			expect(anchor).toBeDefined();
			expect(anchor.anchorSpace).toBe(mockAnchorSpace);
		});

		it('should add anchor to session tracked anchors', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			expect(mockSession[P_SESSION].trackedAnchors.has(anchor)).toBe(true);
			expect(mockSession[P_SESSION].trackedAnchors.size).toBe(1);
		});

		it('should initialize with deleted=false', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			// Anchor should be accessible (not deleted)
			expect(() => anchor.anchorSpace).not.toThrow();
		});

		it('should handle multiple anchors in same session', () => {
			const space1 = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;
			const space2 = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;

			const anchor1 = new XRAnchor(space1, mockSession);
			const anchor2 = new XRAnchor(space2, mockSession);

			expect(mockSession[P_SESSION].trackedAnchors.size).toBe(2);
			expect(mockSession[P_SESSION].trackedAnchors.has(anchor1)).toBe(true);
			expect(mockSession[P_SESSION].trackedAnchors.has(anchor2)).toBe(true);
		});
	});

	describe('anchorSpace getter', () => {
		it('should return the anchor space when not deleted', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			expect(anchor.anchorSpace).toBe(mockAnchorSpace);
		});

		it('should return consistent space on multiple calls', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			const space1 = anchor.anchorSpace;
			const space2 = anchor.anchorSpace;

			expect(space1).toBe(space2);
			expect(space1).toBe(mockAnchorSpace);
		});

		it('should throw InvalidStateError when anchor is deleted', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);
			anchor.delete();

			expect(() => anchor.anchorSpace).toThrow(DOMException);
			expect(() => anchor.anchorSpace).toThrow(
				'XRAnchor has already been deleted.',
			);
		});

		it('should throw InvalidStateError with correct error name when deleted', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);
			anchor.delete();

			try {
				anchor.anchorSpace;
				fail('Expected DOMException to be thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(DOMException);
				expect((error as DOMException).name).toBe('InvalidStateError');
			}
		});
	});

	describe('requestPersistentHandle method', () => {
		it('should resolve with UUID when anchor is not deleted', async () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			const handle = await anchor.requestPersistentHandle();

			expect(handle).toBe('test-uuid-123');
			expect(mockRandomUUID).toHaveBeenCalled();
		});

		it('should reject with InvalidStateError when anchor is deleted', async () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);
			anchor.delete();

			await expect(anchor.requestPersistentHandle()).rejects.toThrow(
				DOMException,
			);
			await expect(anchor.requestPersistentHandle()).rejects.toThrow(
				'XRAnchor has already been deleted.',
			);
		});

		it('should reject with correct error name when deleted', async () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);
			anchor.delete();

			try {
				await anchor.requestPersistentHandle();
				fail('Expected promise to reject');
			} catch (error) {
				expect(error).toBeInstanceOf(DOMException);
				expect((error as DOMException).name).toBe('InvalidStateError');
			}
		});

		it('should return existing UUID if anchor is already persistent', async () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);
			const existingUuid = 'existing-uuid-456';

			// Add anchor to persistent anchors with existing UUID
			mockSession[P_SESSION].persistentAnchors.set(existingUuid, anchor);

			const handle = await anchor.requestPersistentHandle();

			expect(handle).toBe(existingUuid);
			// Should not generate new UUID
			expect(mockRandomUUID).not.toHaveBeenCalled();
		});

		it('should create new persistent anchor when not already persistent', async () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			// Spy on XRAnchorUtils.createPersistentAnchor
			const createPersistentSpy = jest
				.spyOn(XRAnchorUtils, 'createPersistentAnchor')
				.mockImplementation();

			const handle = await anchor.requestPersistentHandle();

			expect(handle).toBe('test-uuid-123');
			expect(createPersistentSpy).toHaveBeenCalledWith(
				mockSession,
				anchor,
				'test-uuid-123',
			);
			expect(mockRandomUUID).toHaveBeenCalled();

			createPersistentSpy.mockRestore();
		});

		it('should handle multiple calls correctly', async () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			const handle1 = await anchor.requestPersistentHandle();
			const handle2 = await anchor.requestPersistentHandle();

			// Second call should return existing UUID, not create new one
			expect(handle1).toBe('test-uuid-123');
			expect(handle2).toBe('test-uuid-123');
		});
	});

	describe('delete method', () => {
		it('should mark anchor as deleted', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			anchor.delete();

			expect(() => anchor.anchorSpace).toThrow(DOMException);
		});

		it('should set anchorSpace to null when deleted', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			anchor.delete();

			// Access private property to verify it's set to null
			expect((anchor as any)[P_ANCHOR].anchorSpace).toBeNull();
		});

		it('should remove anchor from session tracked anchors', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);
			expect(mockSession[P_SESSION].trackedAnchors.has(anchor)).toBe(true);

			anchor.delete();

			expect(mockSession[P_SESSION].trackedAnchors.has(anchor)).toBe(false);
			expect(mockSession[P_SESSION].trackedAnchors.size).toBe(0);
		});

		it('should be safe to call delete multiple times', () => {
			const anchor = new XRAnchor(mockAnchorSpace, mockSession);

			anchor.delete();
			anchor.delete(); // Should not throw or cause issues

			expect(() => anchor.anchorSpace).toThrow(DOMException);
			expect(mockSession[P_SESSION].trackedAnchors.has(anchor)).toBe(false);
		});

		it('should not affect other anchors when one is deleted', () => {
			const space1 = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;
			const space2 = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;

			const anchor1 = new XRAnchor(space1, mockSession);
			const anchor2 = new XRAnchor(space2, mockSession);

			anchor1.delete();

			expect(() => anchor1.anchorSpace).toThrow();
			expect(anchor2.anchorSpace).toBe(space2);
			expect(mockSession[P_SESSION].trackedAnchors.has(anchor1)).toBe(false);
			expect(mockSession[P_SESSION].trackedAnchors.has(anchor2)).toBe(true);
		});
	});
});

describe('XRAnchorSet', () => {
	it('should extend Set', () => {
		const anchorSet = new XRAnchorSet();

		expect(anchorSet).toBeInstanceOf(Set);
		expect(anchorSet.size).toBe(0);
	});

	it('should work with XRAnchor instances', () => {
		const mockSession = {
			[P_SESSION]: {
				trackedAnchors: new Set(),
				persistentAnchors: new Map(),
			},
		} as any;
		const mockSpace = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;

		const anchorSet = new XRAnchorSet();
		const anchor = new XRAnchor(mockSpace, mockSession);

		anchorSet.add(anchor);

		expect(anchorSet.has(anchor)).toBe(true);
		expect(anchorSet.size).toBe(1);
	});
});

describe('XRAnchorUtils', () => {
	let mockSession: jest.Mocked<XRSession>;
	let mockDevice: jest.Mocked<XRDevice>;
	let mockGlobalSpace: jest.Mocked<XRSpace>;

	beforeEach(() => {
		jest.clearAllMocks();
		localStorageMock.getItem.mockReturnValue('{}');

		mockGlobalSpace = {
			[P_SPACE]: {
				offsetMatrix: mat4.create(),
			},
		} as any;

		mockDevice = {
			[P_DEVICE]: {
				globalSpace: mockGlobalSpace,
			},
		} as any;

		mockSession = {
			[P_SESSION]: {
				trackedAnchors: new Set(),
				persistentAnchors: new Map(),
				device: mockDevice,
			},
		} as any;
	});

	describe('recoverPersistentAnchorsFromStorage', () => {
		it('should handle empty localStorage', () => {
			localStorageMock.getItem.mockReturnValue(null);

			XRAnchorUtils.recoverPersistentAnchorsFromStorage(mockSession);

			expect(mockSession[P_SESSION].persistentAnchors.size).toBe(0);
		});

		it('should handle empty persistent anchors object', () => {
			localStorageMock.getItem.mockReturnValue('{}');

			XRAnchorUtils.recoverPersistentAnchorsFromStorage(mockSession);

			expect(mockSession[P_SESSION].persistentAnchors.size).toBe(0);
		});

		it('should recover anchors from localStorage', () => {
			const testMatrix = mat4.create();
			mat4.translate(testMatrix, testMatrix, [1, 2, 3]);

			const storedAnchors = {
				'uuid-1': Array.from(testMatrix),
				'uuid-2': Array.from(mat4.create()),
			};
			localStorageMock.getItem.mockReturnValue(JSON.stringify(storedAnchors));

			XRAnchorUtils.recoverPersistentAnchorsFromStorage(mockSession);

			expect(mockSession[P_SESSION].persistentAnchors.size).toBe(2);
			expect(mockSession[P_SESSION].persistentAnchors.has('uuid-1')).toBe(true);
			expect(mockSession[P_SESSION].persistentAnchors.has('uuid-2')).toBe(true);
		});

		it('should create XRSpace and XRAnchor for each stored anchor', () => {
			const testMatrix = mat4.create();
			const storedAnchors = {
				'test-uuid': Array.from(testMatrix),
			};
			localStorageMock.getItem.mockReturnValue(JSON.stringify(storedAnchors));

			XRAnchorUtils.recoverPersistentAnchorsFromStorage(mockSession);

			const anchor = mockSession[P_SESSION].persistentAnchors.get('test-uuid');
			expect(anchor).toBeInstanceOf(XRAnchor);
		});

		it('should handle malformed JSON gracefully', () => {
			localStorageMock.getItem.mockReturnValue('invalid-json');

			expect(() => {
				XRAnchorUtils.recoverPersistentAnchorsFromStorage(mockSession);
			}).toThrow();
		});
	});

	describe('createPersistentAnchor', () => {
		it('should add anchor to tracked anchors', () => {
			const mockSpace = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;
			const anchor = new XRAnchor(mockSpace, mockSession);
			const uuid = 'test-uuid';

			// Clear tracked anchors to test the method
			mockSession[P_SESSION].trackedAnchors.clear();

			XRAnchorUtils.createPersistentAnchor(mockSession, anchor, uuid);

			expect(mockSession[P_SESSION].trackedAnchors.has(anchor)).toBe(true);
		});

		it('should add anchor to persistent anchors map', () => {
			const mockSpace = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;
			const anchor = new XRAnchor(mockSpace, mockSession);
			const uuid = 'test-uuid';

			XRAnchorUtils.createPersistentAnchor(mockSession, anchor, uuid);

			expect(mockSession[P_SESSION].persistentAnchors.get(uuid)).toBe(anchor);
		});

		it('should store anchor in localStorage', () => {
			const mockSpace = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;
			const anchor = new XRAnchor(mockSpace, mockSession);
			const uuid = 'test-uuid';

			XRAnchorUtils.createPersistentAnchor(mockSession, anchor, uuid);

			expect(localStorageMock.setItem).toHaveBeenCalledWith(
				'@immersive-web-emulation-runtime/persistent-anchors',
				expect.stringContaining(uuid),
			);
		});

		it('should merge with existing localStorage data', () => {
			const existingData = { 'existing-uuid': Array.from(mat4.create()) };
			localStorageMock.getItem.mockReturnValue(JSON.stringify(existingData));

			const mockSpace = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;
			const anchor = new XRAnchor(mockSpace, mockSession);
			const uuid = 'new-uuid';

			XRAnchorUtils.createPersistentAnchor(mockSession, anchor, uuid);

			const setItemCall = localStorageMock.setItem.mock.calls[0];
			const storedData = JSON.parse(setItemCall[1]);

			expect(storedData).toHaveProperty('existing-uuid');
			expect(storedData).toHaveProperty('new-uuid');
		});

		it('should store the anchor offset matrix', () => {
			const testMatrix = mat4.create();
			mat4.translate(testMatrix, testMatrix, [1, 2, 3]);

			const mockSpace = { [P_SPACE]: { offsetMatrix: testMatrix } } as any;
			const anchor = new XRAnchor(mockSpace, mockSession);
			const uuid = 'test-uuid';

			XRAnchorUtils.createPersistentAnchor(mockSession, anchor, uuid);

			const setItemCall = localStorageMock.setItem.mock.calls[0];
			const storedData = JSON.parse(setItemCall[1]);

			expect(storedData[uuid]).toEqual(Array.from(testMatrix));
		});

		it('should handle empty localStorage when creating persistent anchor', () => {
			localStorageMock.getItem.mockReturnValue(null);

			const mockSpace = { [P_SPACE]: { offsetMatrix: mat4.create() } } as any;
			const anchor = new XRAnchor(mockSpace, mockSession);
			const uuid = 'test-uuid';

			XRAnchorUtils.createPersistentAnchor(mockSession, anchor, uuid);

			expect(localStorageMock.setItem).toHaveBeenCalledWith(
				'@immersive-web-emulation-runtime/persistent-anchors',
				expect.stringContaining(uuid),
			);

			const setItemCall = localStorageMock.setItem.mock.calls[0];
			const storedData = JSON.parse(setItemCall[1]);
			expect(storedData).toHaveProperty(uuid);
		});
	});
});
