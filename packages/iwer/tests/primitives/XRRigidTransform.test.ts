/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';

function getConstructorError(...args: unknown[]): unknown {
  try {
    Reflect.construct(XRRigidTransform, args);
  } catch (error) {
    return error;
  }
  throw new Error('Expected XRRigidTransform construction to throw');
}

describe('XRRigidTransform', () => {
  it('should create an identity transform with no arguments', () => {
    const transform = new XRRigidTransform();
    expect(transform.position.x).toBe(0);
    expect(transform.position.y).toBe(0);
    expect(transform.position.z).toBe(0);
    expect(transform.orientation.x).toBe(0);
    expect(transform.orientation.y).toBe(0);
    expect(transform.orientation.z).toBe(0);
    expect(transform.orientation.w).toBe(1);
    expect(transform.matrix).toEqual(expect.any(Float32Array));
    expect(transform.matrix.length).toBe(16);
  });

  it('should create a transform with given position and default orientation', () => {
    const position = { x: 1, y: 2, z: 3, w: 1 };
    const transform = new XRRigidTransform(position);
    expect(transform.position.x).toBe(1);
    expect(transform.position.y).toBe(2);
    expect(transform.position.z).toBe(3);
    expect(transform.orientation.x).toBe(0);
    expect(transform.orientation.y).toBe(0);
    expect(transform.orientation.z).toBe(0);
    expect(transform.orientation.w).toBe(1);
  });

  it('defaults a partial position and preserves the inverse and cached points', () => {
    const transform = new XRRigidTransform({ z: -2 });

    expect(transform.position).toMatchObject({ x: 0, y: 0, z: -2, w: 1 });
    expect(transform.orientation).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
    expect(transform.matrix.every(Number.isFinite)).toBe(true);
    expect(transform.matrix).toEqual(
      mat4.fromTranslation(mat4.create(), [0, 0, -2]),
    );
    expect(transform.inverse.position).toMatchObject({
      x: 0,
      y: 0,
      z: 2,
      w: 1,
    });
    expect(
      mat4.multiply(mat4.create(), transform.matrix, transform.inverse.matrix),
    ).toEqual(mat4.create());
    expect(transform.inverse.inverse).toBe(transform);
    expect(transform.inverse).toBe(transform.inverse);
    expect(transform.position).toBe(transform.position);
    expect(transform.orientation).toBe(transform.orientation);
  });

  it('defaults and normalizes a partial orientation', () => {
    const transform = new XRRigidTransform({ z: -2 }, { z: 1 });

    expect(transform.orientation.x).toBe(0);
    expect(transform.orientation.y).toBe(0);
    expect(transform.orientation.z).toBeCloseTo(Math.SQRT1_2);
    expect(transform.orientation.w).toBeCloseTo(Math.SQRT1_2);
    expect(transform.matrix.every(Number.isFinite)).toBe(true);
  });

  it.each([
    undefined,
    {},
    { x: undefined, y: undefined, z: undefined, w: undefined },
    null,
  ])('defaults empty or undefined dictionary members: %p', (point) => {
    const transform = Reflect.construct(XRRigidTransform, [point, point]);

    expect(transform.position).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
    expect(transform.orientation).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
    expect(transform.matrix).toEqual(mat4.create());
  });

  it('converts null members to zero instead of applying defaults', () => {
    const transform = Reflect.construct(XRRigidTransform, [
      { x: null, y: null, z: null, w: 1 },
      { x: null, y: null, z: 2, w: null },
    ]);

    expect(transform.position).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
    expect(transform.orientation).toMatchObject({ x: 0, y: 0, z: 1, w: 0 });
    expect(transform.matrix.every(Number.isFinite)).toBe(true);
  });

  it('converts numeric strings and booleans before normalization', () => {
    const transform = Reflect.construct(XRRigidTransform, [
      { x: '2', y: true, z: '-3', w: '1' },
      { x: false, y: '0', z: '2', w: '2' },
    ]);

    expect(transform.position).toMatchObject({ x: 2, y: 1, z: -3, w: 1 });
    expect(transform.orientation.x).toBe(0);
    expect(transform.orientation.y).toBe(0);
    expect(transform.orientation.z).toBeCloseTo(Math.SQRT1_2);
    expect(transform.orientation.w).toBeCloseTo(Math.SQRT1_2);
  });

  it.each([0, -0, -1, 2, null, false, '0'])(
    'rejects position.w that does not convert to one: %p',
    (w) => {
      expect(() => Reflect.construct(XRRigidTransform, [{ w }])).toThrow(
        TypeError,
      );
    },
  );

  it.each([true, '1'])('accepts position.w that converts to one: %p', (w) => {
    const transform = Reflect.construct(XRRigidTransform, [{ w }]);

    expect(transform.position.w).toBe(1);
    expect(transform.matrix).toEqual(mat4.create());
  });

  it.each([BigInt(1), Symbol('coordinate')])(
    'rejects members that cannot convert to an unrestricted double: %p',
    (value) => {
      for (const member of ['x', 'w']) {
        expect(() =>
          Reflect.construct(XRRigidTransform, [{ [member]: value }]),
        ).toThrow(TypeError);
        expect(() =>
          Reflect.construct(XRRigidTransform, [undefined, { [member]: value }]),
        ).toThrow(TypeError);
      }
    },
  );

  it('reads and converts inherited members once in WebIDL order', () => {
    const calls: string[] = [];
    const prototype = {};
    for (const member of ['w', 'x', 'y', 'z']) {
      Object.defineProperty(prototype, member, {
        get() {
          calls.push(member);
          return {
            valueOf() {
              calls.push(`convert ${member}`);
              return member === 'w' ? 1 : 0;
            },
          };
        },
      });
    }
    const point = Object.create(prototype);
    const transform = Reflect.construct(XRRigidTransform, [point, point]);
    const order = [
      'w',
      'convert w',
      'x',
      'convert x',
      'y',
      'convert y',
      'z',
      'convert z',
    ];

    expect(calls).toEqual([...order, ...order]);
    expect(transform.matrix).toEqual(mat4.create());
  });

  describe.each(['w', 'x', 'y', 'z'])('non-finite %s', (member) => {
    it.each([NaN, Infinity, -Infinity])(
      'rejects a non-finite position member: %p',
      (value) => {
        expect(() => new XRRigidTransform({ [member]: value })).toThrow(
          TypeError,
        );
      },
    );

    it.each([NaN, Infinity, -Infinity])(
      'rejects a non-finite orientation member: %p',
      (value) => {
        expect(
          () => new XRRigidTransform(undefined, { [member]: value }),
        ).toThrow(TypeError);
      },
    );
  });

  it.each([
    { x: 0, y: 0, z: 0, w: 0 },
    { x: -0, y: -0, z: -0, w: -0 },
    { x: -0, y: 0, z: -0, w: 0 },
  ])('rejects a zero quaternion with InvalidStateError: %p', (orientation) => {
    const error = getConstructorError(undefined, orientation);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: 'InvalidStateError' });
  });

  it.each([
    { x: 0, y: 0, z: 4, w: 0 },
    { x: 0, y: 0, z: 4, w: 4 },
    { x: 0, y: 0, z: 0, w: 4 },
  ])('normalizes a nonzero, non-unit quaternion: %p', (orientation) => {
    const transform = new XRRigidTransform(undefined, orientation);
    const length = Math.hypot(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    );

    for (const member of ['x', 'y', 'z', 'w'] as const) {
      expect(transform.orientation[member]).toBeCloseTo(
        orientation[member] / length,
      );
    }
    expect(transform.matrix.every(Number.isFinite)).toBe(true);
  });

  it.each(['w', 'x', 'y', 'z'])(
    'does not reject a finite nonzero %s that narrows to Float32 zero',
    (member) => {
      const transform = new XRRigidTransform(undefined, {
        x: 0,
        y: 0,
        z: 0,
        w: 0,
        [member]: Number.MIN_VALUE,
      });

      expect(transform.matrix.every(Number.isFinite)).toBe(true);
    },
  );

  describe.each(['position', 'orientation'])(
    '%s conversion exceptions',
    (throwingDictionary) => {
      it.each(['getter', 'valueOf'])(
        'propagates a %s exception before constructor validation',
        (phase) => {
          const calls: string[] = [];
          const sentinel = new Error('dictionary conversion sentinel');
          const points = ['position', 'orientation'].map((dictionary) => {
            const point = {};
            for (const member of ['w', 'x', 'y', 'z']) {
              const key = `${dictionary}.${member}`;
              const throws =
                dictionary === throwingDictionary && member === 'z';
              Object.defineProperty(point, member, {
                get() {
                  calls.push(key);
                  if (throws && phase === 'getter') {
                    throw sentinel;
                  }
                  return {
                    valueOf() {
                      calls.push(`convert ${key}`);
                      if (throws && phase === 'valueOf') {
                        throw sentinel;
                      }
                      return dictionary === 'position' && member === 'x'
                        ? NaN
                        : 0;
                    },
                  };
                },
              });
            }
            return point;
          });

          expect(getConstructorError(...points)).toBe(sentinel);
          const order = [
            'position.w',
            'convert position.w',
            'position.x',
            'convert position.x',
            'position.y',
            'convert position.y',
            'position.z',
            'convert position.z',
            'orientation.w',
            'convert orientation.w',
            'orientation.x',
            'convert orientation.x',
            'orientation.y',
            'convert orientation.y',
            'orientation.z',
            'convert orientation.z',
          ];
          const lastCall = `${phase === 'valueOf' ? 'convert ' : ''}${throwingDictionary}.z`;
          expect(calls).toEqual(order.slice(0, order.indexOf(lastCall) + 1));
        },
      );
    },
  );

  it('validates position.w before checking non-finite members', () => {
    const error = getConstructorError({ w: 0, x: NaN }, { y: Infinity, w: 0 });

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/position.*w/i),
    });
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects non-finite position before normalizing a zero quaternion: %p',
    (x) => {
      const error = getConstructorError({ x }, { x: 0, y: 0, z: 0, w: 0 });

      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        message: expect.stringMatching(/finite/i),
      });
    },
  );

  it('should create a transform with given position and orientation', () => {
    const position = { x: 1, y: 2, z: 3, w: 1 };
    const orientation = { x: 0, y: 0, z: 1, w: 0 };
    const transform = new XRRigidTransform(position, orientation);
    expect(transform.position.x).toBe(1);
    expect(transform.position.y).toBe(2);
    expect(transform.position.z).toBe(3);
    expect(transform.orientation.x).toBeCloseTo(0);
    expect(transform.orientation.y).toBeCloseTo(0);
    expect(transform.orientation.z).toBeCloseTo(1);
    expect(transform.orientation.w).toBeCloseTo(0);
  });

  it('should correctly calculate the inverse transform', () => {
    const position = { x: 1, y: 2, z: 3, w: 1 };
    const orientation = {
      x: 0.11109410971403122,
      y: 0.21208874881267548,
      z: 0.3130834102630615,
      w: 0.9190512895584106,
    }; // (normalized)
    const transform = new XRRigidTransform(position, orientation);
    const inverse = transform.inverse;

    // Test applying the transform and then the inverse transform to a point
    const point = vec3.fromValues(5, 5, 5); // Arbitrary point
    const transformedPoint = vec3.transformMat4(
      vec3.create(),
      point,
      transform.matrix,
    );
    const retransformedPoint = vec3.transformMat4(
      vec3.create(),
      transformedPoint,
      inverse.matrix,
    );

    // The retransformedPoint should be close to the original point
    expect(retransformedPoint[0]).toBeCloseTo(point[0]);
    expect(retransformedPoint[1]).toBeCloseTo(point[1]);
    expect(retransformedPoint[2]).toBeCloseTo(point[2]);

    const originalQuat = quat.fromValues(
      transform.orientation.x,
      transform.orientation.y,
      transform.orientation.z,
      transform.orientation.w,
    );

    const inverseQuat = quat.fromValues(
      inverse.orientation.x,
      inverse.orientation.y,
      inverse.orientation.z,
      inverse.orientation.w,
    );

    // Normalizing the quaternions (if not already normalized)
    quat.normalize(originalQuat, originalQuat);
    quat.normalize(inverseQuat, inverseQuat);

    // Combining the original and inverse quaternion
    const combinedQuat = quat.create();
    quat.multiply(combinedQuat, inverseQuat, originalQuat);

    // The combined quaternion should be close to a neutral quaternion (0, 0, 0, 1)
    expect(combinedQuat[0]).toBeCloseTo(0);
    expect(combinedQuat[1]).toBeCloseTo(0);
    expect(combinedQuat[2]).toBeCloseTo(0);
    expect(combinedQuat[3]).toBeCloseTo(1);
  });
});
