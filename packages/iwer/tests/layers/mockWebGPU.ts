/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Minimal WebGPU stand-ins for the layer tests. They record what IWER asks of
// the device, tagged with the label of the command encoder involved.

export const createMockTexture = (descriptor: any) => {
  // IWER wraps destroy() on layer textures, so tests check this one.
  const destroyMock = jest.fn();
  return {
    label: descriptor.label,
    width: descriptor.size[0],
    height: descriptor.size[1],
    depthOrArrayLayers: descriptor.size[2],
    format: descriptor.format,
    usage: descriptor.usage,
    mipLevelCount: descriptor.mipLevelCount ?? 1,
    descriptor,
    createView: jest.fn((viewDescriptor?: any) => ({ viewDescriptor })),
    destroy: destroyMock,
    destroyMock,
  };
};

// The uniforms of one compositor draw (see XRGPUPresenter's Draw struct).
export type MockDraw = {
  matrix: number[];
  dims: number[];
  uvRect: number[];
  grid: number[];
  kind: number;
  arrayLayer: number;
  opacity: number;
  blendSourceAlpha: number;
  fixedFoveation: number;
  infinite: number;
};

// The uniforms of one space warp view (see GPUSpaceWarp's Warp struct).
export type MockWarp = {
  matrix: number[];
  grid: number[];
  arrayLayer: number;
  extrapolation: number;
  colorScale: number;
};

const DRAW_STRIDE = 256;

export const createMockGPUDevice = () => {
  const renderPasses: any[] = [];
  const copies: any[] = [];
  let resolveLost: (info: unknown) => void = () => {};
  const device = {
    features: new Set<string>(),
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
    lost: new Promise((resolve) => {
      resolveLost = resolve;
    }),
    createTexture: jest.fn(createMockTexture),
    createShaderModule: jest.fn(() => ({})),
    createBindGroupLayout: jest.fn((descriptor: any) => ({ descriptor })),
    createPipelineLayout: jest.fn((descriptor: any) => ({ descriptor })),
    createRenderPipeline: jest.fn((descriptor: any) => ({ descriptor })),
    createSampler: jest.fn((descriptor: any) => {
      // WebGPU rejects anisotropic samplers unless every filter is linear.
      const linear = ['magFilter', 'minFilter', 'mipmapFilter'].every(
        (filter) => descriptor[filter] === 'linear',
      );
      if ((descriptor.maxAnisotropy ?? 1) > 1 && !linear) {
        throw new Error('maxAnisotropy > 1 needs linear filters');
      }
      return { descriptor };
    }),
    createBuffer: jest.fn((descriptor: any) => ({
      ...descriptor,
      destroy: jest.fn(),
    })),
    createBindGroup: jest.fn((descriptor: any) => ({ descriptor })),
    createCommandEncoder: jest.fn((encoderDescriptor?: any) => ({
      beginRenderPass: jest.fn((descriptor: any) => {
        const pass = {
          label: encoderDescriptor?.label,
          descriptor,
          setPipeline: jest.fn(),
          setBindGroup: jest.fn(),
          setViewport: jest.fn(),
          draw: jest.fn(),
          end: jest.fn(),
        };
        renderPasses.push(pass);
        return pass;
      }),
      copyTextureToTexture: jest.fn(
        (source: any, destination: any, size: any) => {
          copies.push({
            label: encoderDescriptor?.label,
            source,
            destination,
            size,
          });
        },
      ),
      finish: jest.fn(() => ({})),
    })),
    queue: {
      submit: jest.fn(),
      writeBuffer: jest.fn(),
      writeTexture: jest.fn(),
      copyExternalImageToTexture: jest.fn(),
    },
  };
  const passesLabelled = (label: string) =>
    renderPasses.filter((pass) => pass.label === label);
  const lastWrite = (label: string): ArrayBuffer | null => {
    const call = device.queue.writeBuffer.mock.calls
      .filter(([buffer]: any[]) => buffer.label === label)
      .slice(-1)[0];
    return call ? call[2] : null;
  };
  return {
    device: device as any,
    renderPasses,
    copies,
    compositorPasses: () => passesLabelled('IWER layer compositor'),
    depthClears: () => passesLabelled('IWER layer depth clear'),
    warpPasses: () => passesLabelled('IWER space warp'),
    // The uniforms of every view in the last space warp.
    warps: (): MockWarp[] => {
      const data = lastWrite('IWER space warp views');
      const warps: MockWarp[] = [];
      for (
        let offset = 0;
        data && offset < data.byteLength;
        offset += DRAW_STRIDE
      ) {
        const floats = new Float32Array(data, offset, 24);
        const uints = new Uint32Array(data, offset, 24);
        warps.push({
          matrix: [...floats.slice(0, 16)],
          grid: [uints[16], uints[17]],
          arrayLayer: uints[18],
          extrapolation: floats[19],
          colorScale: floats[20],
        });
      }
      return warps;
    },
    // The uniforms of every draw the compositor issued in its last pass.
    draws: (): MockDraw[] => {
      const data = lastWrite('IWER layer compositor draws');
      if (!data) {
        return [];
      }
      const draws: MockDraw[] = [];
      for (let offset = 0; offset < data.byteLength; offset += DRAW_STRIDE) {
        const floats = new Float32Array(data, offset, 32);
        const uints = new Uint32Array(data, offset, 32);
        draws.push({
          matrix: [...floats.slice(0, 16)],
          dims: [...floats.slice(16, 20)],
          uvRect: [...floats.slice(20, 24)],
          grid: [uints[24], uints[25]],
          kind: uints[26],
          arrayLayer: uints[27],
          opacity: floats[28],
          blendSourceAlpha: floats[29],
          fixedFoveation: floats[30],
          infinite: floats[31],
        });
      }
      return draws;
    },
    lose: () => resolveLost({ reason: 'destroyed', message: '' }),
  };
};

export const createMockCanvasContext = () => ({
  configure: jest.fn(),
  unconfigure: jest.fn(),
  getCurrentTexture: jest.fn(() => ({ createView: jest.fn(() => ({})) })),
});
