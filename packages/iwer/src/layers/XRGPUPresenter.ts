/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';
import {
  P_COMPOSITION_LAYER,
  P_DEVICE,
  P_PROJECTION_LAYER,
  P_SESSION,
  P_SPACE_LAYER,
} from '../private.js';
import {
  XRProjectionLayer,
  type XRCompositionLayer,
} from './XRProjectionLayer.js';
import {
  XRCubeLayer,
  XRCylinderLayer,
  XREquirectLayer,
  XRQuadLayer,
} from './XRSpaceLayers.js';
import { GPUMediaTextures } from './GPUMediaTextures.js';
import { synthesizeFrame } from './GPUSpaceWarp.js';
import { XRSpaceUtils } from '../spaces/XRSpace.js';
import { XREye } from '../views/XRView.js';
import type { XRDevice } from '../device/XRDevice.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import type { XRLayer } from './XRWebGLLayer.js';
import type { XRSession } from '../session/XRSession.js';

// Every draw reads one slice of a shared uniform buffer.
const DRAW_STRIDE = 256;
const DRAW_SIZE = 128;

// Surface kinds, matching the shader's switch.
const QUAD = 0;
const CYLINDER = 1;
const EQUIRECT = 2;

const COMPOSITOR_SHADER = /* wgsl */ `
struct Draw {
  // Surfaces: clip from layer space. Cube: layer direction from clip.
  matrix: mat4x4f,
  dims: vec4f,
  // The region of the texture to show: offset, then scale.
  uvRect: vec4f,
  grid: vec2u,
  kind: u32,
  arrayLayer: u32,
  opacity: f32,
  blendSourceAlpha: f32,
  fixedFoveation: f32,
  infinite: f32,
};

@group(0) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(0) var layerSampler: sampler;
@group(1) @binding(1) var layerTexture: texture_2d_array<f32>;
@group(1) @binding(1) var cubeTexture: texture_cube<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) clip: vec2f,
};

// Opacity applies to premultiplied color. Without source alpha the layer is
// opaque.
fn shade(color: vec4f) -> vec4f {
  var shaded = color;
  if (draw.blendSourceAlpha == 0.0) {
    shaded.a = 1.0;
  }
  return shaded * draw.opacity;
}

fn fullscreen(vertexIndex: u32) -> VertexOutput {
  let uv = vec2f(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var output: VertexOutput;
  output.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  output.uv = uv;
  output.clip = output.position.xy;
  return output;
}

// Like fixed foveated rendering, resolution drops to 1/2 and then 1/4 in
// rings away from the centre of the view; higher levels start them closer.
fn foveate(uv: vec2f) -> vec2f {
  if (draw.fixedFoveation <= 0.0) {
    return uv;
  }
  let inner = mix(1.0, 0.5, draw.fixedFoveation);
  let ring = clamp(floor((length(uv * 2.0 - 1.0) - inner) / 0.35) + 1.0, 0.0, 2.0);
  if (ring == 0.0) {
    return uv;
  }
  let size = vec2f(textureDimensions(layerTexture)) * draw.uvRect.zw;
  let blocks = size / exp2(ring);
  return (floor(uv * blocks) + 0.5) / blocks;
}

// Projection layers: one view of the layer over the whole viewport.
@vertex
fn projectionVertex(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  return fullscreen(vertexIndex);
}

@fragment
fn projectionFragment(input: VertexOutput) -> @location(0) vec4f {
  let uv = draw.uvRect.xy + foveate(input.uv) * draw.uvRect.zw;
  return shade(textureSampleLevel(layerTexture, layerSampler, uv, draw.arrayLayer, 0.0));
}

// Quad, cylinder and equirect layers: a grid of two triangles per cell, wound
// counter-clockwise as seen from the side that shows.
@vertex
fn surfaceVertex(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(0u, 1u), vec2u(1u, 0u),
    vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 1u),
  );
  let cell = vertexIndex / 6u;
  let corner = corners[vertexIndex % 6u];
  let uv = vec2f(
    f32(cell % draw.grid.x + corner.x) / f32(draw.grid.x),
    f32(cell / draw.grid.x + corner.y) / f32(draw.grid.y),
  );
  var local: vec3f;
  switch draw.kind {
    case 0u: {
      // Quad: dims = (width, height), centered in the XY plane, facing +Z.
      local = vec3f((uv.x - 0.5) * draw.dims.x, (0.5 - uv.y) * draw.dims.y, 0.0);
    }
    case 1u: {
      // Cylinder: dims = (radius, central angle, height), seen from inside.
      let angle = (uv.x - 0.5) * draw.dims.y;
      local = vec3f(
        draw.dims.x * sin(angle),
        (0.5 - uv.y) * draw.dims.z,
        -draw.dims.x * cos(angle),
      );
    }
    default: {
      // Equirect: dims = (radius, horizontal angle, upper, lower angles).
      let azimuth = (uv.x - 0.5) * draw.dims.y;
      let elevation = draw.dims.z - uv.y * (draw.dims.z - draw.dims.w);
      local = draw.dims.x * vec3f(
        cos(elevation) * sin(azimuth),
        sin(elevation),
        -cos(elevation) * cos(azimuth),
      );
    }
  }
  var output: VertexOutput;
  output.position = draw.matrix * vec4f(local, 1.0);
  if (draw.infinite != 0.0) {
    // Infinitely far: as deep as the view allows.
    output.position.z = output.position.w * 0.99999;
  }
  output.uv = draw.uvRect.xy + uv * draw.uvRect.zw;
  output.clip = output.position.xy;
  return output;
}

@fragment
fn surfaceFragment(input: VertexOutput) -> @location(0) vec4f {
  return shade(textureSample(layerTexture, layerSampler, input.uv, draw.arrayLayer));
}

// Cube layers: the cube map seen from the centre of the view.
@vertex
fn cubeVertex(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  return fullscreen(vertexIndex);
}

@fragment
fn cubeFragment(input: VertexOutput) -> @location(0) vec4f {
  let point = draw.matrix * vec4f(input.clip, 1.0, 1.0);
  return shade(textureSample(cubeTexture, layerSampler, point.xyz / point.w));
}
`;

type PipelineKind = 'projection' | 'surface' | 'cube';

type DeviceResources = {
  module: GPUShaderModule;
  drawLayout: GPUBindGroupLayout;
  arrayLayout: GPUBindGroupLayout;
  cubeLayout: GPUBindGroupLayout;
  pipelines: Map<string, GPURenderPipeline>;
  samplers: Map<string, GPUSampler>;
  uniforms: GPUBuffer | null;
  drawBindGroup: GPUBindGroup | null;
  textureBindGroups: WeakMap<
    GPUTexture,
    Map<GPUSampler, Map<string, GPUBindGroup>>
  >;
};

const resources = new WeakMap<GPUDevice, DeviceResources>();

const getResources = (device: GPUDevice): DeviceResources => {
  let entry = resources.get(device);
  if (!entry) {
    const textureLayout = (viewDimension: GPUTextureViewDimension) =>
      device.createBindGroupLayout({
        label: `IWER layer compositor ${viewDimension} texture`,
        entries: [
          {
            binding: 0,
            visibility: SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' },
          },
          {
            binding: 1,
            visibility: SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'float', viewDimension },
          },
        ],
      });
    entry = {
      module: device.createShaderModule({
        label: 'IWER layer compositor',
        code: COMPOSITOR_SHADER,
      }),
      drawLayout: device.createBindGroupLayout({
        label: 'IWER layer compositor draw',
        entries: [
          {
            binding: 0,
            visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT,
            buffer: {
              type: 'uniform',
              hasDynamicOffset: true,
              minBindingSize: DRAW_SIZE,
            },
          },
        ],
      }),
      arrayLayout: textureLayout('2d-array'),
      cubeLayout: textureLayout('cube'),
      pipelines: new Map(),
      samplers: new Map(),
      uniforms: null,
      drawBindGroup: null,
      textureBindGroups: new WeakMap(),
    };
    resources.set(device, entry);
  }
  return entry;
};

// GPUShaderStage flags, inlined so this module loads without WebGPU globals.
const SHADER_STAGE_VERTEX = 0x1;
const SHADER_STAGE_FRAGMENT = 0x2;
// GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
const UNIFORM_BUFFER_USAGE = 0x48;

const getPipeline = (
  device: GPUDevice,
  format: GPUTextureFormat,
  kind: PipelineKind,
): GPURenderPipeline => {
  const entry = getResources(device);
  const key = `${kind} ${format}`;
  let pipeline = entry.pipelines.get(key);
  if (!pipeline) {
    const blend: GPUBlendComponent = {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    };
    pipeline = device.createRenderPipeline({
      label: `IWER layer compositor ${kind}`,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          entry.drawLayout,
          kind === 'cube' ? entry.cubeLayout : entry.arrayLayout,
        ],
      }),
      vertex: { module: entry.module, entryPoint: `${kind}Vertex` },
      fragment: {
        module: entry.module,
        entryPoint: `${kind}Fragment`,
        targets: [{ format, blend: { color: blend, alpha: blend } }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: kind === 'surface' ? 'back' : 'none',
        frontFace: 'ccw',
      },
    });
    entry.pipelines.set(key, pipeline);
  }
  return pipeline;
};

const getSampler = (device: GPUDevice, layer: XRCompositionLayer) => {
  const { mipLevels, quality } = layer[P_COMPOSITION_LAYER];
  // Text- and graphics-optimized layers get anisotropic filtering, which
  // WebGPU only allows with linear filters, the mip filter included.
  const maxAnisotropy = quality === 'default' ? 1 : 16;
  const mipmapFilter: GPUMipmapFilterMode =
    mipLevels > 1 || maxAnisotropy > 1 ? 'linear' : 'nearest';
  const key = `${mipmapFilter} ${maxAnisotropy}`;
  const entry = getResources(device);
  let sampler = entry.samplers.get(key);
  if (!sampler) {
    sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter,
      maxAnisotropy,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    entry.samplers.set(key, sampler);
  }
  return sampler;
};

const getTextureBindGroup = (
  device: GPUDevice,
  texture: GPUTexture,
  sampler: GPUSampler,
  view: GPUTextureViewDescriptor,
  layout: GPUBindGroupLayout,
) => {
  const entry = getResources(device);
  let samplers = entry.textureBindGroups.get(texture);
  if (!samplers) {
    samplers = new Map();
    entry.textureBindGroups.set(texture, samplers);
  }
  let groups = samplers.get(sampler);
  if (!groups) {
    groups = new Map();
    samplers.set(sampler, groups);
  }
  const key = JSON.stringify(view);
  let group = groups.get(key);
  if (!group) {
    group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView(view) },
      ],
    });
    groups.set(key, group);
  }
  return group;
};

type ViewRegion = {
  eye: XREye;
  eyeIndex: number;
  // The view's viewport on the canvas: x, width.
  x: number;
  width: number;
  projection: mat4;
  // The view from the global space, with and without translation.
  view: mat4;
  rotation: mat4;
};

type Draw = {
  pipeline: GPURenderPipeline;
  textureGroup: GPUBindGroup;
  vertexCount: number;
  region: ViewRegion;
};

type Surface = {
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext | null;
  device: GPUDevice | null;
};

// The views a frame the app drew was shown with.
type FramePoses = {
  time: number;
  views: Map<XREye, { view: mat4; projection: mat4 }>;
};

const scratchModel = mat4.create();
const scratchRotation = quat.create();

const rotationOnly = (out: mat4, matrix: mat4) => {
  mat4.copy(out, matrix);
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  return out;
};

/**
 * Maps the NDC of a view of the last drawn frame to clip space of the view's
 * current pose, for space warp. Motion vectors include camera motion, so a
 * frame extrapolated along them is seen from the camera pose extrapolated the
 * same way; depth then reprojects it to where the head is now.
 */
const warpMatrix = (
  region: ViewRegion,
  last: FramePoses,
  previous: FramePoses | undefined,
  extrapolation: number,
): mat4 => {
  const drawn = last.views.get(region.eye) ?? region;
  const previousView = previous?.views.get(region.eye)?.view ?? drawn.view;
  const camera = mat4.invert(mat4.create(), drawn.view) ?? mat4.create();
  // The camera's motion over the last frame, in its own space, scaled.
  const motion = mat4.multiply(mat4.create(), previousView, camera);
  const rotation = quat.slerp(
    quat.create(),
    quat.create(),
    mat4.getRotation(quat.create(), motion),
    extrapolation,
  );
  const translation = vec3.scale(
    vec3.create(),
    mat4.getTranslation(vec3.create(), motion),
    extrapolation,
  );
  mat4.multiply(
    camera,
    camera,
    mat4.fromRotationTranslation(mat4.create(), rotation, translation),
  );
  const matrix = mat4.invert(mat4.create(), drawn.projection) ?? mat4.create();
  mat4.multiply(matrix, camera, matrix);
  mat4.multiply(matrix, region.view, matrix);
  return mat4.multiply(matrix, region.projection, matrix);
};

/**
 * Draws the layers of a WebGPU session onto IWER-owned canvases, mounted where
 * a WebGL session's canvas would be. Layers are composited in render state
 * order with source-over blending; consecutive layers on the same GPUDevice
 * share a canvas, and the canvases stack in order.
 */
export class XRGPUPresenter {
  private xrDevice: XRDevice;
  private format: GPUTextureFormat;
  private surfaces: Surface[] = [];
  // The last two frames the app drew, newest first, for space warp.
  private poses: FramePoses[] = [];

  constructor(xrDevice: XRDevice) {
    this.xrDevice = xrDevice;
    this.format = navigator.gpu.getPreferredCanvasFormat();
  }

  attach(): void {
    this.xrDevice[P_DEVICE].mountCanvas(this.surface(0).canvas);
  }

  // Hides the last presented image while no usable layer is set.
  setVisible(visible: boolean): void {
    for (const { canvas } of this.surfaces) {
      canvas.style.visibility = visible ? '' : 'hidden';
    }
  }

  /**
   * Shows the layers. With `synthesizeFrom`, this is a frame IWER synthesizes
   * with space warp: projection layers that submitted motion vectors in that
   * frame are extrapolated from it, and other layers show their last frame.
   */
  present(
    session: XRSession,
    layers: readonly XRLayer[],
    synthesizeFrom: XRFrame | null = null,
  ): void {
    try {
      // Media layers show their video's current frame.
      for (const layer of layers) {
        const textures =
          P_COMPOSITION_LAYER in layer
            ? (layer as XRCompositionLayer)[P_COMPOSITION_LAYER].textures
            : null;
        if (textures instanceof GPUMediaTextures) {
          textures.update();
        }
      }
      const drawable = layers.filter(
        (layer): layer is XRCompositionLayer =>
          P_COMPOSITION_LAYER in layer &&
          (layer as XRCompositionLayer)[P_COMPOSITION_LAYER].textures
            .released !== null,
      );
      // Consecutive layers on the same device share a canvas.
      const runs: XRCompositionLayer[][] = [];
      for (const layer of drawable) {
        const run = runs[runs.length - 1];
        if (
          run &&
          run[0][P_COMPOSITION_LAYER].textures.device ===
            layer[P_COMPOSITION_LAYER].textures.device
        ) {
          run.push(layer);
        } else {
          runs.push([layer]);
        }
      }
      const regions = this.viewRegions(session);
      let synthesized = new Set<XRCompositionLayer>();
      if (synthesizeFrom) {
        synthesized = this.synthesize(drawable, regions, synthesizeFrom);
      } else {
        this.poses = [
          {
            time: performance.now(),
            views: new Map(
              regions.map(({ eye, view, projection }) => [
                eye,
                { view: mat4.clone(view), projection: mat4.clone(projection) },
              ]),
            ),
          },
          ...this.poses.slice(0, 1),
        ];
      }
      this.surfaces.forEach(({ canvas }, index) => {
        canvas.style.visibility = index < runs.length ? '' : 'hidden';
      });
      runs.forEach((run, index) =>
        this.drawRun(this.surface(index), run, regions, synthesized),
      );
    } catch (error) {
      console.error(error);
    }
  }

  // Draws a synthesized frame for each projection layer with motion vectors
  // from `frame`, and returns those layers.
  private synthesize(
    layers: XRCompositionLayer[],
    regions: ViewRegion[],
    frame: XRFrame,
  ): Set<XRCompositionLayer> {
    const synthesized = new Set<XRCompositionLayer>();
    const [last, previous] = this.poses;
    if (!last) {
      return synthesized;
    }
    // Motion vectors span the time since the previous frame; extrapolate by
    // the share of that which has passed since the last one.
    const interval = previous ? last.time - previous.time : 0;
    const extrapolation =
      interval > 0
        ? Math.min(1, Math.max(0, (performance.now() - last.time) / interval))
        : 0.5;
    for (const layer of layers) {
      const { textures, forceMonoPresentation } = layer[P_COMPOSITION_LAYER];
      if (
        !(layer instanceof XRProjectionLayer) ||
        textures.releasedFrame !== frame ||
        !textures.released?.motionVector
      ) {
        continue;
      }
      const scales = layer[P_PROJECTION_LAYER].viewportScales;
      // forceMonoPresentation shows the left view to both eyes.
      const views = regions
        .filter((region) => !forceMonoPresentation || region.eyeIndex === 0)
        .map((region) => ({
          arrayLayer: region.eyeIndex,
          clipFromSource: warpMatrix(region, last, previous, extrapolation),
          colorScale: scales[region.eyeIndex] ?? 1,
        }));
      synthesizeFrame(textures, views, extrapolation);
      synthesized.add(layer);
    }
    return synthesized;
  }

  detach(): void {
    for (const surface of this.surfaces) {
      surface.context?.unconfigure();
      surface.device = null;
    }
    // The device restores the first canvas; the others are only IWER's.
    for (const { canvas } of this.surfaces.slice(1)) {
      canvas.remove();
    }
    this.surfaces.length = Math.min(this.surfaces.length, 1);
  }

  private surface(index: number): Surface {
    let surface = this.surfaces[index];
    if (!surface) {
      const canvas = document.createElement('canvas');
      surface = {
        canvas,
        context: canvas.getContext('webgpu') as GPUCanvasContext | null,
        device: null,
      };
      this.surfaces[index] = surface;
      const previous = this.surfaces[index - 1]?.canvas;
      if (previous?.parentElement) {
        // Stacked over the first canvas, which the device mounts like an app
        // canvas.
        Object.assign(canvas.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: previous.style.zIndex,
        });
        previous.after(canvas);
      }
    }
    return surface;
  }

  private viewRegions(session: XRSession): ViewRegion[] {
    const xrDevice = this.xrDevice;
    const stereo = xrDevice.stereoEnabled;
    const width = window.innerWidth;
    // Like the WebGL viewports, mono shows only the left view.
    const eyes = stereo ? [XREye.Left, XREye.Right] : [XREye.Left];
    return eyes.map((eye, eyeIndex) => {
      const view =
        mat4.invert(
          mat4.create(),
          XRSpaceUtils.calculateGlobalOffsetMatrix(xrDevice.viewSpaces[eye]),
        ) ?? mat4.create();
      return {
        eye,
        eyeIndex,
        x: stereo ? (eyeIndex * width) / 2 : 0,
        width: stereo ? width / 2 : width,
        projection: session[P_SESSION].getProjectionMatrix(eye),
        view,
        rotation: rotationOnly(mat4.create(), view),
      };
    });
  }

  private drawRun(
    surface: Surface,
    layers: XRCompositionLayer[],
    regions: ViewRegion[],
    synthesized: Set<XRCompositionLayer>,
  ): void {
    const device = layers[0][P_COMPOSITION_LAYER].textures.device as GPUDevice;
    const { canvas } = surface;
    if (canvas.width !== window.innerWidth) {
      canvas.width = window.innerWidth;
    }
    if (canvas.height !== window.innerHeight) {
      canvas.height = window.innerHeight;
    }
    const context = surface.context;
    if (!context) {
      return;
    }
    if (surface.device !== device) {
      context.configure({
        device,
        format: this.format,
        alphaMode: 'premultiplied',
      });
      surface.device = device;
    }

    const entry = getResources(device);
    const draws: Draw[] = [];
    const data = new ArrayBuffer(regions.length * layers.length * DRAW_STRIDE);
    for (const region of regions) {
      for (const layer of layers) {
        const draw = this.encodeDraw(
          device,
          layer,
          region,
          data,
          draws.length,
          synthesized.has(layer),
        );
        if (draw) {
          draws.push(draw);
        }
      }
    }
    if (!entry.uniforms || entry.uniforms.size < data.byteLength) {
      entry.uniforms?.destroy();
      entry.uniforms = device.createBuffer({
        label: 'IWER layer compositor draws',
        size: Math.max(data.byteLength, DRAW_STRIDE),
        usage: UNIFORM_BUFFER_USAGE,
      });
      entry.drawBindGroup = device.createBindGroup({
        layout: entry.drawLayout,
        entries: [
          { binding: 0, resource: { buffer: entry.uniforms, size: DRAW_SIZE } },
        ],
      });
    }
    if (data.byteLength > 0) {
      device.queue.writeBuffer(entry.uniforms, 0, data);
    }

    const encoder = device.createCommandEncoder({
      label: 'IWER layer compositor',
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    draws.forEach((draw, index) => {
      pass.setViewport(
        draw.region.x,
        0,
        draw.region.width,
        canvas.height,
        0,
        1,
      );
      pass.setPipeline(draw.pipeline);
      pass.setBindGroup(0, entry.drawBindGroup!, [index * DRAW_STRIDE]);
      pass.setBindGroup(1, draw.textureGroup);
      pass.draw(draw.vertexCount);
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // Fills in a draw's uniforms and returns how to issue it.
  private encodeDraw(
    device: GPUDevice,
    layer: XRCompositionLayer,
    region: ViewRegion,
    data: ArrayBuffer,
    index: number,
    synthesized: boolean,
  ): Draw | null {
    const state = layer[P_COMPOSITION_LAYER];
    const texture = (
      synthesized && layer instanceof XRProjectionLayer
        ? layer[P_COMPOSITION_LAYER].textures.synthesisTargets().color
        : state.textures.released!.color
    ) as GPUTexture;
    const media =
      state.textures instanceof GPUMediaTextures ? state.textures : null;
    // forceMonoPresentation shows the left eye's image to both eyes, and a
    // media layer's invertStereo swaps the eyes' halves of its video.
    let eyeIndex = state.forceMonoPresentation ? 0 : region.eyeIndex;
    if (media?.invertStereo) {
      eyeIndex = 1 - eyeIndex;
    }
    const offset = index * DRAW_STRIDE;
    const floats = new Float32Array(data, offset, DRAW_SIZE / 4);
    const uints = new Uint32Array(data, offset, DRAW_SIZE / 4);
    const uvRect = floats.subarray(20, 24);
    uvRect.set([0, 0, 1, 1]);
    floats[28] = state.opacity;
    floats[29] = state.blendTextureSourceAlpha ? 1 : 0;
    const sampler = getSampler(device, layer);
    const entry = getResources(device);

    if (layer instanceof XRProjectionLayer) {
      const projection = layer[P_PROJECTION_LAYER];
      const scale = projection.viewportScales[eyeIndex] ?? 1;
      uvRect.set([0, 0, scale, scale]);
      uints[27] = eyeIndex;
      floats[30] = projection.frameFixedFoveation;
      return {
        pipeline: getPipeline(device, this.format, 'projection'),
        textureGroup: getTextureBindGroup(
          device,
          texture,
          sampler,
          { dimension: '2d-array' },
          entry.arrayLayout,
        ),
        vertexCount: 3,
        region,
      };
    }

    const matrix = floats.subarray(0, 16);
    if (layer instanceof XRCubeLayer) {
      // Only the orientations count; the cube is seen from the view's centre.
      const { space, orientation } = layer[P_SPACE_LAYER];
      const model = rotationOnly(
        scratchModel,
        XRSpaceUtils.calculateGlobalOffsetMatrix(space),
      );
      quat.normalize(scratchRotation, [
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      ]);
      mat4.multiply(
        model,
        model,
        mat4.fromQuat(mat4.create(), scratchRotation),
      );
      const clipFromLayer = mat4.multiply(
        mat4.create(),
        region.projection,
        mat4.multiply(mat4.create(), region.rotation, model),
      );
      matrix.set(mat4.invert(mat4.create(), clipFromLayer) ?? mat4.create());
      const stereo = state.layout === 'stereo';
      return {
        pipeline: getPipeline(device, this.format, 'cube'),
        textureGroup: getTextureBindGroup(
          device,
          texture,
          sampler,
          {
            dimension: 'cube',
            baseArrayLayer: stereo ? eyeIndex * 6 : 0,
            arrayLayerCount: 6,
          },
          entry.cubeLayout,
        ),
        vertexCount: 3,
        region,
      };
    }

    // Quad, cylinder and equirect layers.
    const dims = floats.subarray(16, 20);
    let kind: number;
    let infinite = false;
    let columns = 1;
    let rows = 1;
    // The specs don't validate shapes; degenerate ones draw nothing.
    if (layer instanceof XRQuadLayer) {
      if (!(layer.width > 0 && layer.height > 0)) {
        return null;
      }
      kind = QUAD;
      dims.set([layer.width, layer.height, 0, 0]);
    } else if (layer instanceof XRCylinderLayer) {
      if (
        !(layer.radius >= 0 && layer.centralAngle > 0 && layer.aspectRatio > 0)
      ) {
        return null;
      }
      kind = CYLINDER;
      infinite = layer.radius <= 0;
      const radius = infinite ? 1 : layer.radius;
      dims.set([
        radius,
        layer.centralAngle,
        (radius * layer.centralAngle) / layer.aspectRatio,
        0,
      ]);
      columns = Math.max(
        8,
        Math.ceil((64 * Math.abs(layer.centralAngle)) / (2 * Math.PI)),
      );
    } else if (layer instanceof XREquirectLayer) {
      if (
        !(
          layer.radius >= 0 &&
          layer.centralHorizontalAngle > 0 &&
          layer.upperVerticalAngle > layer.lowerVerticalAngle
        )
      ) {
        return null;
      }
      kind = EQUIRECT;
      infinite = layer.radius <= 0;
      dims.set([
        infinite ? 1 : layer.radius,
        layer.centralHorizontalAngle,
        layer.upperVerticalAngle,
        layer.lowerVerticalAngle,
      ]);
      columns = Math.max(
        8,
        Math.ceil(
          (64 * Math.abs(layer.centralHorizontalAngle)) / (2 * Math.PI),
        ),
      );
      rows = Math.max(
        4,
        Math.ceil(
          (32 * Math.abs(layer.upperVerticalAngle - layer.lowerVerticalAngle)) /
            Math.PI,
        ),
      );
    } else {
      return null;
    }
    const { space, transform } = (layer as XRQuadLayer)[P_SPACE_LAYER];
    const model = mat4.multiply(
      scratchModel,
      XRSpaceUtils.calculateGlobalOffsetMatrix(space),
      transform.matrix,
    );
    // An infinitely far surface ignores translation.
    const view = infinite ? region.rotation : region.view;
    if (infinite) {
      rotationOnly(model, model);
    }
    mat4.multiply(
      matrix,
      region.projection,
      mat4.multiply(mat4.create(), view, model),
    );
    uints[24] = columns;
    uints[25] = rows;
    uints[26] = kind;
    floats[31] = infinite ? 1 : 0;
    switch (state.layout) {
      case 'stereo':
        // A video is one image, so both eyes see all of it.
        uints[27] = media ? 0 : eyeIndex;
        break;
      case 'stereo-left-right':
        uvRect.set([eyeIndex * 0.5, 0, 0.5, 1]);
        break;
      case 'stereo-top-bottom':
        uvRect.set([0, eyeIndex * 0.5, 1, 0.5]);
        break;
    }
    return {
      pipeline: getPipeline(device, this.format, 'surface'),
      textureGroup: getTextureBindGroup(
        device,
        texture,
        sampler,
        { dimension: '2d-array' },
        entry.arrayLayout,
      ),
      vertexCount: columns * rows * 6,
      region,
    };
  }
}
