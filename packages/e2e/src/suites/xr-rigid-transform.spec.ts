/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';

/**
 * §8 XRRigidTransform — constructor, position, orientation, matrix, inverse
 * 19 tests
 */
export function registerXRRigidTransformTests(harness: TestHarness): void {
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

    // 7. position.w is always 1
    harness.it('position.w is always 1', () => {
      const t = new XRRigidTransform({ x: 5, y: 6, z: 7, w: 99 });
      harness.assertApprox(t.position.w, 1, 0.0001);
    });

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

    // 16. zero quaternion → NaN matrix [DEVIATION: spec says TypeError]
    harness.it(
      'zero quaternion → NaN matrix [DEVIATION: spec says TypeError]',
      () => {
        // iwer normalizes the zero quaternion (producing NaN), rather than throwing TypeError
        try {
          const t = new XRRigidTransform(
            { x: 0, y: 0, z: 0, w: 1 },
            { x: 0, y: 0, z: 0, w: 0 },
          );
          const hasNaN = Array.from(t.matrix).some(isNaN);
          harness.assert(
            hasNaN,
            'Zero quaternion should produce NaN matrix values',
          );
        } catch (_e: any) {
          // Throwing is also valid per spec
          harness.assert(true, 'Zero quaternion threw');
        }
      },
    );

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
