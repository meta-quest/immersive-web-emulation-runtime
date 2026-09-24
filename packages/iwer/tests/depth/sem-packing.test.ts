/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { DoubleSide, RGBADepthPacking } from 'three';
import {
  createEnvironmentDepthMaterial,
  perspectiveDepthToMeters,
  unpackRGBADepthBytes,
} from '../../../sem/src/depth-packing.js';

const packDepthToBytes = (depth: number): [number, number, number, number] => {
  if (depth <= 0) return [0, 0, 0, 0];
  if (depth >= 1) return [255, 255, 255, 255];

  // CPU mirror of Three.js's packDepthToRGBA shader, including RGBA8
  // quantization after PackUpscale is applied to the G/B channels.
  let whole = Math.floor(depth * 256 ** 3);
  const alpha = depth * 256 ** 3 - whole;
  const blueValue = whole / 256;
  whole = Math.floor(blueValue);
  const blue = blueValue - whole;
  const greenValue = whole / 256;
  whole = Math.floor(greenValue);
  const green = greenValue - whole;
  return [
    whole,
    Math.round(green * 256),
    Math.round(blue * 256),
    Math.round(alpha * 255),
  ];
};

const projectMetersToDepth = (
  meters: number,
  depthNear: number,
  depthFar: number,
): number =>
  (depthFar - (depthNear * depthFar) / meters) / (depthFar - depthNear);

describe('SEM RGBA depth packing', () => {
  it.each([0, 0.125, 0.5, 0.9972272083582641, 1])(
    'round-trips normalized depth %s',
    (depth) => {
      expect(unpackRGBADepthBytes(...packDepthToBytes(depth))).toBeCloseTo(
        depth,
        7,
      );
    },
  );

  it('preserves sub-meter geometry with a 1 mm near plane', () => {
    const depthNear = 0.001;
    const depthFar = 200;
    const expectedMeters = 0.36;
    const packed = packDepthToBytes(
      projectMetersToDepth(expectedMeters, depthNear, depthFar),
    );
    const normalizedDepth = unpackRGBADepthBytes(...packed);

    expect(
      perspectiveDepthToMeters(normalizedDepth, depthNear, depthFar),
    ).toBeCloseTo(expectedMeters, 6);

    // The former base-255 decode inflated depth by 256/255. At this near
    // plane that pushes the same table surface beyond 1 and maps it to far.
    const [r, g, b, a] = packed.map((value) => value / 255);
    const oldDepth = r + g / 256 + b / 65536 + a / 16777216;
    expect(oldDepth).toBeGreaterThanOrEqual(1);
    expect(perspectiveDepthToMeters(oldDepth, depthNear, depthFar)).toBe(
      depthFar,
    );
  });

  it('maps clear pixels to the far plane', () => {
    expect(perspectiveDepthToMeters(0, 0.001, 200)).toBe(200);
    expect(
      perspectiveDepthToMeters(
        unpackRGBADepthBytes(255, 255, 255, 255),
        0.001,
        200,
      ),
    ).toBe(200);
  });

  it('renders synthetic room surfaces from both sides', () => {
    const material = createEnvironmentDepthMaterial();
    expect(material.depthPacking).toBe(RGBADepthPacking);
    expect(material.side).toBe(DoubleSide);
    material.dispose();
  });
});
