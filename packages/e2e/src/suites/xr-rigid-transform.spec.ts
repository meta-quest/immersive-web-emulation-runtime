/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';

/**
 * §8 XRRigidTransform — constructor, position, orientation, matrix, inverse
 * 51 tests
 */
export function registerXRRigidTransformTests(harness: TestHarness): void {
  function assertTypeError(fn: () => void): void {
    let error: unknown;
    try {
      fn();
    } catch (caught: unknown) {
      error = caught;
    }
    harness.assertInstanceOf(error, TypeError);
  }

  harness.describe('§8 XRRigidTransform', () => {
    // 1. default constructor → identity position (0,0,0,1)
    harness.it('default constructor → identity position (0,0,0,1)', () => {
      const t = new XRRigidTransform();
      harness.assertApprox(t.position.x, 0, 0.0001);
      harness.assertApprox(t.position.y, 0, 0.0001);
      harness.assertApprox(t.position.z, 0, 0.0001);
      harness.assertApprox(t.position.w, 1, 0.0001);
    });

    // 2. default constructor → identity orientation (0,0,0,1)
    harness.it('default constructor → identity orientation (0,0,0,1)', () => {
      const t = new XRRigidTransform();
      harness.assertApprox(t.orientation.x, 0, 0.0001);
      harness.assertApprox(t.orientation.y, 0, 0.0001);
      harness.assertApprox(t.orientation.z, 0, 0.0001);
      harness.assertApprox(t.orientation.w, 1, 0.0001);
    });

    // 3. constructor with position sets x/y/z correctly
    harness.it('constructor with position sets x/y/z correctly', () => {
      const t = new XRRigidTransform({ x: 1, y: 2, z: 3, w: 1 });
      harness.assertApprox(t.position.x, 1, 0.0001);
      harness.assertApprox(t.position.y, 2, 0.0001);
      harness.assertApprox(t.position.z, 3, 0.0001);
      harness.assertApprox(t.position.w, 1, 0.0001);
    });

    // 4. constructor with position+orientation
    harness.it('constructor with position+orientation', () => {
      const pos = { x: 1, y: 2, z: 3, w: 1 };
      const ori = { x: 0, y: 0.7071068, z: 0, w: 0.7071068 };
      const t = new XRRigidTransform(pos, ori);

      harness.assertApprox(t.position.x, 1, 0.0001);
      harness.assertApprox(t.position.y, 2, 0.0001);
      harness.assertApprox(t.position.z, 3, 0.0001);
      harness.assertApprox(t.orientation.x, 0, 0.001);
      harness.assertApprox(t.orientation.y, 0.7071068, 0.001);
    });

    // 5. constructor normalizes non-unit quaternion
    harness.it('constructor normalizes non-unit quaternion', () => {
      const t = new XRRigidTransform(
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 0, z: 0, w: 2 },
      );
      // After normalization, should be (0,0,0,1)
      harness.assertApprox(t.orientation.w, 1, 0.001);
      harness.assertApprox(t.orientation.x, 0, 0.001);
      harness.assertApprox(t.orientation.y, 0, 0.001);
      harness.assertApprox(t.orientation.z, 0, 0.001);
    });

    // 6. position is DOMPointReadOnly
    harness.it('position is DOMPointReadOnly', () => {
      const t = new XRRigidTransform();
      harness.assertInstanceOf(t.position, DOMPointReadOnly);
    });

    // 7. position.w must be 1
    for (const w of [0, 99]) {
      harness.it(`position.w = ${w} throws JavaScript TypeError`, () => {
        assertTypeError(() => new XRRigidTransform({ x: 5, y: 6, z: 7, w }));
      });
    }

    for (const dictionary of ['position', 'orientation'] as const) {
      for (const member of ['x', 'y', 'z', 'w'] as const) {
        for (const value of [NaN, Infinity, -Infinity]) {
          harness.it(
            `${dictionary}.${member} = ${value} throws JavaScript TypeError`,
            () => {
              const point = { [member]: value };
              assertTypeError(() =>
                dictionary === 'position'
                  ? new XRRigidTransform(point)
                  : new XRRigidTransform({}, point),
              );
            },
          );
        }
      }
    }

    for (const { name, position, orientation, expectedX } of [
      {
        name: 'empty dictionaries',
        position: {},
        orientation: {},
        expectedX: 0,
      },
      {
        name: 'partial dictionaries',
        position: { x: 5 },
        orientation: { w: 2 },
        expectedX: 5,
      },
      {
        name: 'undefined members',
        position: { x: undefined, y: undefined, z: undefined, w: undefined },
        orientation: { x: undefined, y: undefined, z: undefined, w: undefined },
        expectedX: 0,
      },
      {
        name: 'undefined arguments',
        position: undefined,
        orientation: undefined,
        expectedX: 0,
      },
    ]) {
      harness.it(`${name} retain transform defaults`, () => {
        const t = new XRRigidTransform(position, orientation);
        harness.assertEqual(t.position.x, expectedX);
        harness.assertEqual(t.position.y, 0);
        harness.assertEqual(t.position.z, 0);
        harness.assertEqual(t.position.w, 1);
        harness.assertEqual(t.orientation.x, 0);
        harness.assertEqual(t.orientation.y, 0);
        harness.assertEqual(t.orientation.z, 0);
        harness.assertEqual(t.orientation.w, 1);
      });
    }

    for (const { name, position, orientation } of [
      { name: 'invalid position.w', position: { w: 99 }, orientation: {} },
      { name: 'non-finite position.x', position: { x: NaN }, orientation: {} },
      {
        name: 'non-finite orientation.w',
        position: {},
        orientation: { w: Infinity },
      },
    ]) {
      harness.it(`${name} is checked after both dictionaries convert`, () => {
        const reads: string[] = [];
        const trackReads = (
          name: string,
          point: DOMPointInit,
        ): DOMPointInit => {
          const tracked: DOMPointInit = {};
          for (const member of ['w', 'x', 'y', 'z'] as const) {
            Object.defineProperty(tracked, member, {
              get() {
                reads.push(`${name}.${member}`);
                return point[member];
              },
            });
          }
          return tracked;
        };
        assertTypeError(
          () =>
            new XRRigidTransform(
              trackReads('position', position),
              trackReads('orientation', orientation),
            ),
        );
        harness.assertEqual(
          reads.join(','),
          'position.w,position.x,position.y,position.z,orientation.w,orientation.x,orientation.y,orientation.z',
        );
      });
    }

    // 8. orientation is DOMPointReadOnly
    harness.it('orientation is DOMPointReadOnly', () => {
      const t = new XRRigidTransform();
      harness.assertInstanceOf(t.orientation, DOMPointReadOnly);
    });

    // 9. matrix is Float32Array of length 16
    harness.it('matrix is Float32Array of length 16', () => {
      const t = new XRRigidTransform();
      harness.assertInstanceOf(t.matrix, Float32Array);
      harness.assertEqual(t.matrix.length, 16);
    });

    // 10. matrix is identity for default transform
    harness.it('matrix is identity for default transform', () => {
      const t = new XRRigidTransform();
      const m = t.matrix;
      // Diagonal = 1
      harness.assertApprox(m[0], 1, 0.0001);
      harness.assertApprox(m[5], 1, 0.0001);
      harness.assertApprox(m[10], 1, 0.0001);
      harness.assertApprox(m[15], 1, 0.0001);
      // Off-diagonal = 0
      harness.assertApprox(m[1], 0, 0.0001);
      harness.assertApprox(m[2], 0, 0.0001);
      harness.assertApprox(m[3], 0, 0.0001);
      harness.assertApprox(m[4], 0, 0.0001);
    });

    // 11. matrix encodes translation (m[12],m[13],m[14])
    harness.it('matrix encodes translation (m[12],m[13],m[14])', () => {
      const t = new XRRigidTransform(
        { x: 10, y: 20, z: 30, w: 1 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
      const m = t.matrix;
      harness.assertApprox(m[12], 10, 0.001);
      harness.assertApprox(m[13], 20, 0.001);
      harness.assertApprox(m[14], 30, 0.001);
    });

    // 12. inverse returns XRRigidTransform
    harness.it('inverse returns XRRigidTransform', () => {
      const t = new XRRigidTransform(
        { x: 1, y: 2, z: 3, w: 1 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
      harness.assertInstanceOf(t.inverse, XRRigidTransform);
    });

    // 13. inverse.inverse returns original position values
    harness.it('inverse.inverse returns original position values', () => {
      const t = new XRRigidTransform(
        { x: 1, y: 2, z: 3, w: 1 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
      const roundTrip = t.inverse.inverse;
      harness.assertApprox(roundTrip.position.x, t.position.x, 0.001);
      harness.assertApprox(roundTrip.position.y, t.position.y, 0.001);
      harness.assertApprox(roundTrip.position.z, t.position.z, 0.001);
    });

    // 14. inverse is cached (same object reference)
    harness.it('inverse is cached (same object reference)', () => {
      const t = new XRRigidTransform(
        { x: 1, y: 2, z: 3, w: 1 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
      const inv1 = t.inverse;
      const inv2 = t.inverse;
      harness.assertEqual(inv1, inv2, 'inverse should return same object');
    });

    // 15. inverse.inverse === original (circular ref)
    harness.it('inverse.inverse === original (circular ref)', () => {
      const t = new XRRigidTransform(
        { x: 1, y: 2, z: 3, w: 1 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
      harness.assertEqual(
        t.inverse.inverse,
        t,
        'inverse.inverse should be the original transform',
      );
    });

    // 16. zero quaternion throws InvalidStateError during normalization
    harness.it('zero quaternion throws DOMException(InvalidStateError)', () => {
      let error: unknown;
      try {
        new XRRigidTransform(
          { x: 0, y: 0, z: 0, w: 1 },
          { x: 0, y: 0, z: 0, w: 0 },
        );
      } catch (caught: unknown) {
        error = caught;
      }
      harness.assertInstanceOf(error, DOMException);
      harness.assertEqual((error as DOMException).name, 'InvalidStateError');
    });

    // 17. position is readonly
    harness.it('position is readonly', () => {
      const t = new XRRigidTransform();
      harness.assertReadonly(t, 'position');
    });

    // 18. orientation is readonly
    harness.it('orientation is readonly', () => {
      const t = new XRRigidTransform();
      harness.assertReadonly(t, 'orientation');
    });

    // 19. matrix is readonly
    harness.it('matrix is readonly', () => {
      const t = new XRRigidTransform();
      harness.assertReadonly(t, 'matrix');
    });
  });
}
