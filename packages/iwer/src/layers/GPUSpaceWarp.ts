/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { mat4 } from 'gl-matrix';
import type { GPULayerTextures } from './GPULayerTextures.js';

// Every view reads one slice of a shared uniform buffer.
const WARP_STRIDE = 256;
const WARP_SIZE = 96;

const SPACE_WARP_SHADER = /* wgsl */ `
struct Warp {
  // The current view's clip space from the drawn frame's NDC.
  clipFromSource: mat4x4f,
  // The size of the motion vector and depth textures.
  grid: vec2u,
  arrayLayer: u32,
  // How far each texel moves along its motion vector.
  extrapolation: f32,
  // The part of the color texture the frame used: its viewport scale.
  colorScale: f32,
};

@group(0) @binding(0) var<uniform> warp: Warp;
@group(1) @binding(0) var colorSampler: sampler;
@group(1) @binding(1) var colorTexture: texture_2d_array<f32>;
// Depth is read as a float texture, which compatibility mode allows.
@group(1) @binding(2) var depthTexture: texture_2d_array<f32>;
@group(1) @binding(3) var motionTexture: texture_2d_array<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// A grid with a cell per motion vector texel. Each corner moves along its
// motion vector, then depth reprojects it into the current view.
@vertex
fn warpVertex(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(0u, 1u), vec2u(1u, 0u),
    vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 1u),
  );
  let cell = vertexIndex / 6u;
  let corner = vec2u(cell % warp.grid.x, cell / warp.grid.x) + corners[vertexIndex % 6u];
  // A corner takes the nearest of its four texels, so foreground edges hold.
  var depth = 2.0;
  var motion = vec3f(0.0);
  for (var i = 0u; i < 4u; i++) {
    let texel = clamp(
      vec2i(corner) - vec2i(vec2u(i & 1u, i >> 1u)),
      vec2i(0),
      vec2i(warp.grid) - vec2i(1),
    );
    let texelDepth = textureLoad(depthTexture, texel, warp.arrayLayer, 0).r;
    if (texelDepth < depth) {
      depth = texelDepth;
      motion = textureLoad(motionTexture, texel, warp.arrayLayer, 0).xyz;
    }
  }
  let uv = vec2f(corner) / vec2f(warp.grid);
  let ndc = vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth) + motion * warp.extrapolation;
  var output: VertexOutput;
  output.position = warp.clipFromSource * vec4f(ndc.xy, clamp(ndc.z, 0.0, 1.0), 1.0);
  // Keep what was at the far plane in view.
  output.position.z = min(output.position.z, output.position.w * 0.99999);
  output.uv = uv * warp.colorScale;
  return output;
}

@fragment
fn warpFragment(input: VertexOutput) -> @location(0) vec4f {
  return textureSampleLevel(colorTexture, colorSampler, input.uv, warp.arrayLayer, 0.0);
}
`;

// GPUShaderStage and GPUBufferUsage flags, inlined so this module loads
// without WebGPU globals.
const SHADER_STAGE_VERTEX = 0x1;
const SHADER_STAGE_FRAGMENT = 0x2;
const UNIFORM_BUFFER_USAGE = 0x48;

type DeviceResources = {
  module: GPUShaderModule;
  uniformLayout: GPUBindGroupLayout;
  textureLayout: GPUBindGroupLayout;
  pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
  sampler: GPUSampler;
  uniforms: GPUBuffer | null;
  uniformGroup: GPUBindGroup | null;
  textureGroups: WeakMap<GPUTexture, GPUBindGroup>;
};

const resources = new WeakMap<GPUDevice, DeviceResources>();

const getResources = (device: GPUDevice): DeviceResources => {
  let entry = resources.get(device);
  if (!entry) {
    const texture = (
      binding: number,
      sampleType: GPUTextureSampleType,
      visibility: number,
    ) => ({
      binding,
      visibility,
      texture: { sampleType, viewDimension: '2d-array' as const },
    });
    entry = {
      module: device.createShaderModule({
        label: 'IWER space warp',
        code: SPACE_WARP_SHADER,
      }),
      uniformLayout: device.createBindGroupLayout({
        label: 'IWER space warp view',
        entries: [
          {
            binding: 0,
            visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT,
            buffer: {
              type: 'uniform',
              hasDynamicOffset: true,
              minBindingSize: WARP_SIZE,
            },
          },
        ],
      }),
      textureLayout: device.createBindGroupLayout({
        label: 'IWER space warp textures',
        entries: [
          {
            binding: 0,
            visibility: SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' },
          },
          texture(1, 'float', SHADER_STAGE_FRAGMENT),
          texture(2, 'unfilterable-float', SHADER_STAGE_VERTEX),
          texture(3, 'unfilterable-float', SHADER_STAGE_VERTEX),
        ],
      }),
      pipelines: new Map(),
      sampler: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      uniforms: null,
      uniformGroup: null,
      textureGroups: new WeakMap(),
    };
    resources.set(device, entry);
  }
  return entry;
};

const getPipeline = (device: GPUDevice, format: GPUTextureFormat) => {
  const entry = getResources(device);
  let pipeline = entry.pipelines.get(format);
  if (!pipeline) {
    pipeline = device.createRenderPipeline({
      label: 'IWER space warp',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [entry.uniformLayout, entry.textureLayout],
      }),
      vertex: { module: entry.module, entryPoint: 'warpVertex' },
      fragment: {
        module: entry.module,
        entryPoint: 'warpFragment',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });
    entry.pipelines.set(format, pipeline);
  }
  return pipeline;
};

export type SpaceWarpView = {
  arrayLayer: number;
  clipFromSource: mat4;
  colorScale: number;
};

/**
 * Synthesizes a frame from a projection layer's last released textures, as
 * space warp does: every motion vector texel moves `extrapolation` times its
 * motion vector, and depth reprojects it into each view's current pose. The
 * frame is drawn into the layer's synthesis targets, laid out like its color
 * texture.
 */
export const synthesizeFrame = (
  textures: GPULayerTextures,
  views: SpaceWarpView[],
  extrapolation: number,
): void => {
  const device = textures.device as GPUDevice;
  const released = textures.released!;
  const target = textures.synthesisTargets();
  const { color, motionVector } = textures.descriptors;
  const [width, height] = color.size as number[];
  const [gridWidth, gridHeight] = motionVector!.size as number[];
  const entry = getResources(device);

  const data = new ArrayBuffer(views.length * WARP_STRIDE);
  views.forEach((view, index) => {
    const floats = new Float32Array(data, index * WARP_STRIDE, WARP_SIZE / 4);
    const uints = new Uint32Array(data, index * WARP_STRIDE, WARP_SIZE / 4);
    floats.set(view.clipFromSource);
    uints[16] = gridWidth;
    uints[17] = gridHeight;
    uints[18] = view.arrayLayer;
    floats[19] = extrapolation;
    floats[20] = view.colorScale;
  });
  if (!entry.uniforms || entry.uniforms.size < data.byteLength) {
    entry.uniforms?.destroy();
    entry.uniforms = device.createBuffer({
      label: 'IWER space warp views',
      size: data.byteLength,
      usage: UNIFORM_BUFFER_USAGE,
    });
    entry.uniformGroup = device.createBindGroup({
      layout: entry.uniformLayout,
      entries: [
        { binding: 0, resource: { buffer: entry.uniforms, size: WARP_SIZE } },
      ],
    });
  }
  device.queue.writeBuffer(entry.uniforms, 0, data);

  const sourceColor = released.color as GPUTexture;
  let textureGroup = entry.textureGroups.get(sourceColor);
  if (!textureGroup) {
    textureGroup = device.createBindGroup({
      layout: entry.textureLayout,
      entries: [
        { binding: 0, resource: entry.sampler },
        {
          binding: 1,
          resource: sourceColor.createView({ dimension: '2d-array' }),
        },
        {
          binding: 2,
          resource: (released.depthStencil as GPUTexture).createView({
            dimension: '2d-array',
            aspect: 'depth-only',
          }),
        },
        {
          binding: 3,
          resource: (released.motionVector as GPUTexture).createView({
            dimension: '2d-array',
          }),
        },
      ],
    });
    entry.textureGroups.set(sourceColor, textureGroup);
  }

  const pipeline = getPipeline(device, color.format);
  const encoder = device.createCommandEncoder({ label: 'IWER space warp' });
  views.forEach((view, index) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: (target.color as GPUTexture).createView({
            dimension: '2d',
            baseArrayLayer: view.arrayLayer,
            arrayLayerCount: 1,
          }),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: (target.depth as GPUTexture).createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setViewport(
      0,
      0,
      width * view.colorScale,
      height * view.colorScale,
      0,
      1,
    );
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, entry.uniformGroup!, [index * WARP_STRIDE]);
    pass.setBindGroup(1, textureGroup);
    pass.draw(gridWidth * gridHeight * 6);
    pass.end();
  });
  device.queue.submit([encoder.finish()]);
};
