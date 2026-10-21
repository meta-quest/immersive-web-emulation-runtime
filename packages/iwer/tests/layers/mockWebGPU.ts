/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Minimal WebGPU stand-ins for the layer tests. They record what IWER asks of
// the device, tagged with the label of the command encoder involved.

export const createMockTexture = (descriptor: any) => ({
  label: descriptor.label,
  width: descriptor.size[0],
  height: descriptor.size[1],
  depthOrArrayLayers: descriptor.size[2],
  format: descriptor.format,
  usage: descriptor.usage,
  mipLevelCount: descriptor.mipLevelCount ?? 1,
  descriptor,
  createView: jest.fn((viewDescriptor?: any) => ({ viewDescriptor })),
  destroy: jest.fn(),
});

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
    createSampler: jest.fn((descriptor: any) => ({ descriptor })),
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
    },
  };
  const passesLabelled = (label: string) =>
    renderPasses.filter((pass) => pass.label === label);
  return {
    device: device as any,
    renderPasses,
    copies,
    compositorPasses: () => passesLabelled('IWER layer compositor'),
    depthClears: () => passesLabelled('IWER layer depth clear'),
    // The uniforms of every draw the compositor issued in its last pass.
    draws: (): MockDraw[] => {
      const call = device.queue.writeBuffer.mock.calls
        .filter(
          ([buffer]: any[]) => buffer.label === 'IWER layer compositor draws',
        )
        .slice(-1)[0];
      if (!call) {
        return [];
      }
      const data: ArrayBuffer = call[2];
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
