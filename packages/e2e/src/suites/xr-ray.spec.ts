/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { XRRay } from 'iwer';

/**
 * XRRay — constructor overloads, direction normalization, validation, matrix, readonly
 * 15 tests
 */
export function registerXRRayTests(harness: TestHarness): void {
  harness.describe('XRRay', () => {
    // 1. default constructor creates ray with origin (0,0,0,1)
    harness.it('default constructor creates ray with origin (0,0,0,1)', () => {
      const ray = new XRRay();
      harness.assertApprox(ray.origin.x, 0, 1e-6);
      harness.assertApprox(ray.origin.y, 0, 1e-6);
      harness.assertApprox(ray.origin.z, 0, 1e-6);
      harness.assertApprox(ray.origin.w, 1, 1e-6);
    });

    // 2. default constructor direction is (0,0,-1,0)
    harness.it('default constructor direction is (0,0,-1,0)', () => {
      const ray = new XRRay();
      harness.assertApprox(ray.direction.x, 0, 1e-6);
      harness.assertApprox(ray.direction.y, 0, 1e-6);
      harness.assertApprox(ray.direction.z, -1, 1e-6);
      harness.assertApprox(ray.direction.w, 0, 1e-6);
    });

    // 3. constructor with DOMPointInit origin
    harness.it('constructor with DOMPointInit origin', () => {
      const ray = new XRRay({ x: 1, y: 2, z: 3, w: 1 });
      harness.assertApprox(ray.origin.x, 1, 1e-6);
      harness.assertApprox(ray.origin.y, 2, 1e-6);
      harness.assertApprox(ray.origin.z, 3, 1e-6);
    });

    // 4. constructor with DOMPointInit direction
    harness.it('constructor with DOMPointInit direction', () => {
      const ray = new XRRay(
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 1, z: 0, w: 0 },
      );
      harness.assertApprox(ray.direction.x, 0, 1e-6);
      harness.assertApprox(ray.direction.y, 1, 1e-6);
      harness.assertApprox(ray.direction.z, 0, 1e-6);
      harness.assertApprox(ray.direction.w, 0, 1e-6);
    });

    // 5. constructor with XRRigidTransform
    harness.it('constructor with XRRigidTransform', () => {
      const transform = new XRRigidTransform({ x: 5, y: 6, z: 7, w: 1 });
      const ray = new XRRay(transform as any);
      harness.assert(ray.origin != null, 'origin should exist');
      harness.assert(ray.direction != null, 'direction should exist');
      harness.assertApprox(ray.origin.w, 1, 1e-6);
      harness.assertApprox(ray.direction.w, 0, 1e-6);
    });

    // 6. direction is normalized
    harness.it('direction is normalized', () => {
      const ray = new XRRay(
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 3, y: 4, z: 0, w: 0 },
      );
      const len = Math.sqrt(
        ray.direction.x ** 2 + ray.direction.y ** 2 + ray.direction.z ** 2,
      );
      harness.assertApprox(len, 1.0, 1e-6, 'direction should be unit length');
    });

    // 7. zero direction throws DOMException('TypeError')
    harness.it('zero direction throws DOMException(TypeError)', () => {
      harness.assertDOMException(
        () => new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: 0 }),
        'TypeError',
        'Zero direction should throw TypeError DOMException',
      );
    });

    // 8. direction.w !== 0 throws DOMException('TypeError')
    harness.it('direction.w !== 0 throws DOMException(TypeError)', () => {
      harness.assertDOMException(
        () =>
          new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: -1, w: 1 }),
        'TypeError',
        'Non-zero direction.w should throw TypeError DOMException',
      );
    });

    // 9. matrix is Float32Array(16)
    harness.it('matrix is Float32Array(16)', () => {
      const ray = new XRRay();
      harness.assertInstanceOf(ray.matrix, Float32Array);
      harness.assertEqual(ray.matrix.length, 16);
    });

    // 10. matrix is lazily computed (cached)
    harness.it('matrix is lazily computed (cached)', () => {
      const ray = new XRRay();
      const m1 = ray.matrix;
      const m2 = ray.matrix;
      harness.assert(
        m1 === m2,
        'matrix should return the same instance on repeated access',
      );
    });

    // 11. origin is readonly
    harness.it('origin is readonly', () => {
      const ray = new XRRay();
      harness.assertReadonly(ray, 'origin');
    });

    // 12. direction is readonly
    harness.it('direction is readonly', () => {
      const ray = new XRRay();
      harness.assertReadonly(ray, 'direction');
    });

    // 13. matrix is readonly (no setter)
    harness.it('matrix is readonly (no setter)', () => {
      const ray = new XRRay();
      harness.assertReadonly(ray, 'matrix');
    });

    // 14. XRRigidTransform with position transforms origin
    harness.it('XRRigidTransform with position transforms origin', () => {
      const transform = new XRRigidTransform({ x: 5, y: 0, z: 0, w: 1 });
      const ray = new XRRay(transform as any);
      harness.assertApprox(ray.origin.x, 5, 1e-6, 'origin.x should be 5');
      harness.assertApprox(ray.origin.y, 0, 1e-6, 'origin.y should be 0');
      harness.assertApprox(ray.origin.z, 0, 1e-6, 'origin.z should be 0');
    });

    // 15. direction normalization precision (3,4,0 → 0.6,0.8,0)
    harness.it('direction normalization precision (3,4,0 → 0.6,0.8,0)', () => {
      const ray = new XRRay(
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 3, y: 4, z: 0, w: 0 },
      );
      harness.assertApprox(
        ray.direction.x,
        0.6,
        1e-6,
        'direction.x should be 0.6',
      );
      harness.assertApprox(
        ray.direction.y,
        0.8,
        1e-6,
        'direction.y should be 0.8',
      );
      harness.assertApprox(ray.direction.z, 0, 1e-6, 'direction.z should be 0');
    });
  });
}
