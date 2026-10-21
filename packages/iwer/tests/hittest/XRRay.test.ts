/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRRay } from '../../src/hittest/XRRay.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';

function getConstructorError(...args: unknown[]): unknown {
  try {
    Reflect.construct(XRRay, args);
  } catch (error) {
    return error;
  }
  throw new Error('Expected XRRay construction to throw');
}

describe('XRRay', () => {
  describe('constructor', () => {
    it('should create a ray with default origin and direction', () => {
      const ray = new XRRay();

      expect(ray.origin.x).toBe(0);
      expect(ray.origin.y).toBe(0);
      expect(ray.origin.z).toBe(0);
      expect(ray.origin.w).toBe(1);

      expect(ray.direction.x).toBe(0);
      expect(ray.direction.y).toBe(0);
      expect(ray.direction.z).toBe(-1);
      expect(ray.direction.w).toBe(0);
    });

    it('should create a ray with custom origin', () => {
      const origin = { x: 1, y: 2, z: 3, w: 1 };
      const ray = new XRRay(origin);

      expect(ray.origin.x).toBe(1);
      expect(ray.origin.y).toBe(2);
      expect(ray.origin.z).toBe(3);
      expect(ray.origin.w).toBe(1);
    });

    it.each([
      undefined,
      {},
      { x: undefined, y: undefined, z: undefined, w: undefined },
      null,
    ])('defaults empty or undefined dictionary members: %p', (point) => {
      const ray = Reflect.construct(XRRay, [point, point]);

      expect(ray.origin).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
      expect(ray.direction).toMatchObject({ x: 0, y: 0, z: -1, w: 0 });
      expect(ray.matrix.every(Number.isFinite)).toBe(true);
    });

    it('defaults partial origin and direction and preserves cached points', () => {
      const ray = new XRRay({ z: -2 }, { z: -2 });

      expect(ray.origin).toMatchObject({ x: 0, y: 0, z: -2, w: 1 });
      expect(ray.direction).toMatchObject({ x: 0, y: 0, z: -1, w: 0 });
      expect(ray.matrix.every(Number.isFinite)).toBe(true);
      expect(Array.from(ray.matrix.slice(12))).toEqual([0, 0, -2, 1]);
      expect(ray.origin).toBe(ray.origin);
      expect(ray.direction).toBe(ray.direction);
    });

    it('uses the direction-specific z and w defaults before normalization', () => {
      const ray = new XRRay(undefined, { x: 1 });

      expect(ray.direction).toEqual({
        x: 1 / Math.sqrt(2),
        y: 0,
        z: -1 / Math.sqrt(2),
        w: 0,
      });
      expect(ray.matrix.every(Number.isFinite)).toBe(true);
    });

    it('converts null members to zero instead of applying defaults', () => {
      const ray = Reflect.construct(XRRay, [
        { x: null, y: null, z: null, w: 1 },
        { x: null, y: 2, z: null, w: null },
      ]);

      expect(ray.origin).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
      expect(ray.direction).toMatchObject({ x: 0, y: 1, z: 0, w: 0 });
      expect(ray.matrix.every(Number.isFinite)).toBe(true);
    });

    it('converts numeric strings and booleans before validating direction', () => {
      const ray = Reflect.construct(XRRay, [
        { x: '2', y: true, z: '-3', w: '1' },
        { x: false, y: '2', z: false, w: '0' },
      ]);

      expect(ray.origin).toMatchObject({ x: 2, y: 1, z: -3, w: 1 });
      expect(ray.direction).toMatchObject({ x: 0, y: 1, z: 0, w: 0 });
    });

    it.each([
      0,
      -0,
      -1,
      2,
      null,
      false,
      '0',
      NaN,
      Infinity,
      -Infinity,
      'NaN',
      'Infinity',
      '-Infinity',
    ])('rejects origin.w that does not convert to one: %p', (w) => {
      expect(() => Reflect.construct(XRRay, [{ w }])).toThrow(TypeError);
    });

    it.each([true, '1'])('accepts origin.w that converts to one: %p', (w) => {
      const ray = Reflect.construct(XRRay, [{ w }]);

      expect(ray.origin).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
      expect(ray.direction).toMatchObject({ x: 0, y: 0, z: -1, w: 0 });
    });

    it.each([BigInt(1), Symbol('coordinate')])(
      'rejects members that cannot convert to a double: %p',
      (value) => {
        for (const member of ['x', 'w']) {
          expect(() => Reflect.construct(XRRay, [{ [member]: value }])).toThrow(
            TypeError,
          );
          expect(() =>
            Reflect.construct(XRRay, [undefined, { [member]: value }]),
          ).toThrow(TypeError);
        }
      },
    );

    it.each([
      { z: 0 },
      { x: -0, y: 0, z: -0, w: -0 },
      { x: '0', y: false, z: null, w: '0' },
      { w: 1 },
      { w: '1' },
      { w: NaN },
    ])(
      'throws TypeError for invalid direction after conversion: %p',
      (direction) => {
        expect(() => Reflect.construct(XRRay, [undefined, direction])).toThrow(
          TypeError,
        );
      },
    );

    describe.each(['x', 'y', 'z'] as const)(
      'unrestricted origin.%s',
      (member) => {
        it.each([NaN, Infinity, -Infinity])(
          'allows a non-finite coordinate: %p',
          (value) => {
            const ray = new XRRay({ [member]: value });

            expect(ray.origin[member]).toBe(value);
            expect(ray.origin.w).toBe(1);
            expect(ray.direction).toMatchObject({ x: 0, y: 0, z: -1, w: 0 });
          },
        );
      },
    );

    describe.each(['w', 'x', 'y', 'z'])('restricted direction.%s', (member) => {
      it.each(
        [NaN, Infinity, -Infinity].flatMap((value) => [
          { kind: 'number', value, input: value },
          { kind: 'string', value, input: String(value) },
          { kind: 'valueOf', value, input: { valueOf: () => value } },
        ]),
      )('rejects $kind coercion to $value', ({ input }) => {
        expect(() =>
          Reflect.construct(XRRay, [undefined, { [member]: input }]),
        ).toThrow(TypeError);
      });
    });

    it.each(['w', 'x', 'y', 'z'])(
      'rejects non-finite direction.%s before reading later members or validating inputs',
      (invalidMember) => {
        const calls: string[] = [];
        const members = ['w', 'x', 'y', 'z'];
        const direction = {};
        const sentinel = new Error('later direction getter must not run');
        for (const [index, member] of members.entries()) {
          Object.defineProperty(direction, member, {
            get() {
              calls.push(member);
              if (index > members.indexOf(invalidMember)) {
                throw sentinel;
              }
              return {
                valueOf() {
                  calls.push(`convert ${member}`);
                  return member === invalidMember
                    ? Infinity
                    : member === 'w'
                      ? 1
                      : 0;
                },
              };
            },
          });
        }

        const error = getConstructorError({ w: 0 }, direction);

        expect(error).toBeInstanceOf(TypeError);
        expect(error).toMatchObject({
          message: expect.stringMatching(/finite/i),
        });
        expect(calls).toEqual(
          [
            'w',
            'convert w',
            'x',
            'convert x',
            'y',
            'convert y',
            'z',
            'convert z',
          ].slice(0, (members.indexOf(invalidMember) + 1) * 2),
        );
      },
    );

    it('reads and converts inherited origin members before direction members, once in WebIDL order', () => {
      const calls: string[] = [];
      const points = [
        ['origin', { w: 1, x: 2, y: 3, z: 4 }],
        ['direction', { w: 0, x: 0, y: 2, z: 0 }],
      ] as const;
      const args = points.map(([dictionary, values]) => {
        const prototype = {};
        for (const member of ['w', 'x', 'y', 'z'] as const) {
          Object.defineProperty(prototype, member, {
            get() {
              calls.push(`${dictionary}.${member}`);
              return {
                valueOf() {
                  calls.push(`convert ${dictionary}.${member}`);
                  return values[member];
                },
              };
            },
          });
        }
        return Object.create(prototype);
      });
      const ray = Reflect.construct(XRRay, args);

      expect(calls).toEqual([
        'origin.w',
        'convert origin.w',
        'origin.x',
        'convert origin.x',
        'origin.y',
        'convert origin.y',
        'origin.z',
        'convert origin.z',
        'direction.w',
        'convert direction.w',
        'direction.x',
        'convert direction.x',
        'direction.y',
        'convert direction.y',
        'direction.z',
        'convert direction.z',
      ]);
      expect(ray.origin).toMatchObject({ x: 2, y: 3, z: 4, w: 1 });
      expect(ray.direction).toMatchObject({ x: 0, y: 1, z: 0, w: 0 });
    });

    describe.each(['origin', 'direction'])(
      '%s conversion exceptions',
      (throwingDictionary) => {
        it.each(['getter', 'valueOf'])(
          'propagates a %s exception before constructor validation',
          (phase) => {
            const calls: string[] = [];
            const sentinel = new Error('dictionary conversion sentinel');
            const points = ['origin', 'direction'].map((dictionary) => {
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
                        return dictionary === 'direction' && member === 'w'
                          ? 1
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
              'origin.w',
              'convert origin.w',
              'origin.x',
              'convert origin.x',
              'origin.y',
              'convert origin.y',
              'origin.z',
              'convert origin.z',
              'direction.w',
              'convert direction.w',
              'direction.x',
              'convert direction.x',
              'direction.y',
              'convert direction.y',
              'direction.z',
              'convert direction.z',
            ];
            const lastCall = `${phase === 'valueOf' ? 'convert ' : ''}${throwingDictionary}.z`;
            expect(calls).toEqual(order.slice(0, order.indexOf(lastCall) + 1));
          },
        );
      },
    );

    it.each([
      {
        check: 'zero direction before direction.w and origin.w',
        direction: { x: 0, y: 0, z: 0, w: 1 },
        message: /zero|length/i,
      },
      {
        check: 'direction.w before origin.w',
        direction: { w: 1 },
        message: /direction.*w/i,
      },
      {
        check: 'origin.w after a valid direction',
        direction: {},
        message: /origin.*w/i,
      },
    ])('validates $check', ({ direction, message }) => {
      const error = getConstructorError({ w: 0 }, direction);

      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        message: expect.stringMatching(message),
      });
    });

    it('should create a ray with custom origin and direction', () => {
      const origin = { x: 1, y: 2, z: 3, w: 1 };
      const direction = { x: 0, y: 1, z: 0, w: 0 };
      const ray = new XRRay(origin, direction);

      expect(ray.origin.x).toBe(1);
      expect(ray.origin.y).toBe(2);
      expect(ray.origin.z).toBe(3);
      expect(ray.origin.w).toBe(1);

      expect(ray.direction.x).toBe(0);
      expect(ray.direction.y).toBe(1);
      expect(ray.direction.z).toBe(0);
      expect(ray.direction.w).toBe(0);
    });

    it('should normalize direction vector', () => {
      const direction = { x: 2, y: 0, z: 0, w: 0 };
      const ray = new XRRay(undefined, direction);

      // Should be normalized to unit vector
      expect(ray.direction.x).toBe(1);
      expect(ray.direction.y).toBe(0);
      expect(ray.direction.z).toBe(0);
      expect(ray.direction.w).toBe(0);
    });

    it('should throw error for zero-length direction vector', () => {
      const direction = { x: 0, y: 0, z: 0, w: 0 };

      expect(() => new XRRay(undefined, direction)).toThrow(TypeError);
    });

    it('should throw error for direction with w !== 0', () => {
      const direction = { x: 1, y: 0, z: 0, w: 1 };

      expect(() => new XRRay(undefined, direction)).toThrow(TypeError);
    });

    it('should create ray from XRRigidTransform', () => {
      const transform = new XRRigidTransform(
        { x: 1, y: 2, z: 3, w: 1 },
        { x: 0, y: 0, z: 0, w: 1 }, // Identity quaternion
      );
      const ray = new XRRay(transform);

      // Origin should be transformed
      expect(ray.origin.x).toBe(1);
      expect(ray.origin.y).toBe(2);
      expect(ray.origin.z).toBe(3);
      expect(ray.origin.w).toBe(1);

      // Direction should be transformed from default (0, 0, -1)
      expect(ray.direction.z).toBe(-1);
    });
  });

  describe('matrix getter', () => {
    it('should return a matrix for default ray', () => {
      const ray = new XRRay();
      const matrix = ray.matrix;

      expect(matrix).toBeInstanceOf(Float32Array);
      expect(matrix.length).toBe(16);
    });

    it('should return the same matrix on subsequent calls', () => {
      const ray = new XRRay();
      const matrix1 = ray.matrix;
      const matrix2 = ray.matrix;

      expect(matrix1).toBe(matrix2);
    });

    it('should handle edge case where direction is opposite to -z', () => {
      const direction = { x: 0, y: 0, z: 1, w: 0 }; // Opposite to default -z
      const ray = new XRRay(undefined, direction);
      const matrix = ray.matrix;

      expect(matrix).toBeInstanceOf(Float32Array);
      expect(matrix.length).toBe(16);
    });

    it('should handle edge case where direction is same as -z', () => {
      const direction = { x: 0, y: 0, z: -1, w: 0 }; // Same as default -z
      const ray = new XRRay(undefined, direction);
      const matrix = ray.matrix;

      expect(matrix).toBeInstanceOf(Float32Array);
      expect(matrix.length).toBe(16);
    });

    it('should handle arbitrary direction vectors', () => {
      const direction = { x: 1, y: 1, z: 1, w: 0 };
      const ray = new XRRay(undefined, direction);
      const matrix = ray.matrix;

      expect(matrix).toBeInstanceOf(Float32Array);
      expect(matrix.length).toBe(16);
    });
  });

  describe('origin getter', () => {
    it('should return immutable origin', () => {
      const ray = new XRRay();
      const origin = ray.origin;

      expect(origin.x).toBe(0);
      expect(origin.y).toBe(0);
      expect(origin.z).toBe(0);
      expect(origin.w).toBe(1);
    });
  });

  describe('direction getter', () => {
    it('should return immutable direction', () => {
      const ray = new XRRay();
      const direction = ray.direction;

      expect(direction.x).toBe(0);
      expect(direction.y).toBe(0);
      expect(direction.z).toBe(-1);
      expect(direction.w).toBe(0);
    });
  });
});
