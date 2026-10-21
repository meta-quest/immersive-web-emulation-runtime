/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { GlobalSpace, XRSpaceUtils } from '../../src/spaces/XRSpace';
import { P_REF_SPACE, P_SPACE } from '../../src/private';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace';
import { mat4, vec3 } from 'gl-matrix';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';

describe('XRReferenceSpace', () => {
  let globalSpace: GlobalSpace;
  let xrReferenceSpace: XRReferenceSpace;

  beforeEach(() => {
    globalSpace = new GlobalSpace();
    xrReferenceSpace = new XRReferenceSpace(
      XRReferenceSpaceType.Local,
      globalSpace,
    );
  });

  test('XRReferenceSpace should initialize correctly', () => {
    expect(xrReferenceSpace).toBeDefined();
    expect(xrReferenceSpace[P_REF_SPACE].type).toBe(XRReferenceSpaceType.Local);
    expect(xrReferenceSpace[P_SPACE].parentSpace).toBe(globalSpace);
  });

  test('getOffsetReferenceSpace should create a new XRReferenceSpace with correct offset', () => {
    const offsetMatrix = mat4.create();
    mat4.translate(offsetMatrix, offsetMatrix, vec3.fromValues(1, 2, 3)); // Some arbitrary offset

    const offsetSpace = xrReferenceSpace.getOffsetReferenceSpace(offsetMatrix);

    expect(offsetSpace).toBeInstanceOf(XRReferenceSpace);
    expect(offsetSpace[P_SPACE].parentSpace).toBe(xrReferenceSpace);
    expect(
      mat4.equals(offsetSpace[P_SPACE].offsetMatrix, offsetMatrix),
    ).toBeTruthy();
  });

  test('calculateGlobalOffsetMatrix should return correct global offset for nested XRReferenceSpaces created with getOffsetReferenceSpace', () => {
    // Create a parent XRReferenceSpace
    const parentSpace = new XRReferenceSpace(
      XRReferenceSpaceType.Local,
      globalSpace,
    );
    XRSpaceUtils.updateOffsetPosition(parentSpace, vec3.fromValues(0, 1, 0)); // 1 unit up

    // Create an offset XRReferenceSpace from parentSpace
    const offsetMatrix = mat4.create();
    mat4.fromTranslation(offsetMatrix, vec3.fromValues(1, 0, 0)); // 1 unit right
    const offsetSpace = parentSpace.getOffsetReferenceSpace(offsetMatrix);

    // Calculate the global offset matrix for offsetSpace
    const globalMatrix = XRSpaceUtils.calculateGlobalOffsetMatrix(offsetSpace);

    // Expected global matrix combines parent's and offsetSpace's transformations
    const expectedMatrix = mat4.create();
    mat4.translate(expectedMatrix, expectedMatrix, vec3.fromValues(1, 1, 0)); // Combined translation

    expect(mat4.equals(globalMatrix, expectedMatrix)).toBeTruthy();
  });

  test('getOffsetReferenceSpace accepts a transform with a finite offset and preserves parent and type', () => {
    const transform = new XRRigidTransform({ x: 1, y: 2, z: 3, w: 1 });
    const offsetSpace = xrReferenceSpace.getOffsetReferenceSpace(transform);
    const matrix = offsetSpace[P_SPACE].offsetMatrix;

    expect(Array.from(matrix).every(Number.isFinite)).toBe(true);
    expect(mat4.equals(matrix, transform.matrix)).toBe(true);
    expect(Array.from(mat4.getTranslation(vec3.create(), matrix))).toEqual([
      1, 2, 3,
    ]);
    expect(offsetSpace[P_SPACE].parentSpace).toBe(xrReferenceSpace);
    expect(offsetSpace[P_REF_SPACE].type).toBe(XRReferenceSpaceType.Local);
  });

  test('nested transform offsets compose translation and rotation', () => {
    const parentOffset = new XRRigidTransform(
      { x: 1, y: 2, z: 3, w: 1 },
      { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
    );
    const parentSpace = xrReferenceSpace.getOffsetReferenceSpace(parentOffset);
    const childOffset = new XRRigidTransform({ x: 2, y: 0, z: 0, w: 1 });
    const childSpace = parentSpace.getOffsetReferenceSpace(childOffset);
    const matrix = XRSpaceUtils.calculateGlobalOffsetMatrix(childSpace);
    const expected = mat4.multiply(
      mat4.create(),
      parentOffset.matrix,
      childOffset.matrix,
    );

    expect(Array.from(matrix).every(Number.isFinite)).toBe(true);
    expect(mat4.equals(matrix, expected)).toBe(true);
    const position = mat4.getTranslation(vec3.create(), matrix);
    expect(position[0]).toBeCloseTo(1);
    expect(position[1]).toBeCloseTo(4);
    expect(position[2]).toBeCloseTo(3);
    expect(childSpace[P_SPACE].parentSpace).toBe(parentSpace);
    expect(childSpace[P_REF_SPACE].type).toBe(XRReferenceSpaceType.Local);
  });

  test('transform offsets copy the matrix independently of the input and siblings', () => {
    const transform = new XRRigidTransform({ x: 1, y: 2, z: 3, w: 1 });
    const first = xrReferenceSpace.getOffsetReferenceSpace(transform);
    const second = xrReferenceSpace.getOffsetReferenceSpace(transform);

    expect(first[P_SPACE].offsetMatrix).not.toBe(transform.matrix);
    expect(first[P_SPACE].offsetMatrix).not.toBe(second[P_SPACE].offsetMatrix);
    transform.matrix[12] = 99;
    first[P_SPACE].offsetMatrix[13] = 88;

    expect(
      Array.from(second[P_SPACE].offsetMatrix).every(Number.isFinite),
    ).toBe(true);
    expect(first[P_SPACE].offsetMatrix[12]).toBe(1);
    expect(second[P_SPACE].offsetMatrix[12]).toBe(1);
    expect(second[P_SPACE].offsetMatrix[13]).toBe(2);
    expect(transform.matrix[13]).toBe(2);
  });

  test('getOffsetReferenceSpace still accepts ordinary matrix arrays', () => {
    const matrix = Array.from(
      mat4.fromTranslation(mat4.create(), [1, 2, 3]),
    ) as mat4;
    const offsetSpace = xrReferenceSpace.getOffsetReferenceSpace(matrix);

    expect(Array.from(offsetSpace[P_SPACE].offsetMatrix)).toEqual(matrix);
    expect(offsetSpace[P_SPACE].offsetMatrix).not.toBe(matrix);
  });
});
