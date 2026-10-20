/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  P_COMPOSITION_LAYER,
  P_DEVICE,
  P_PROJECTION_LAYER,
} from '../private.js';
import type { XRDevice } from '../device/XRDevice.js';
import type { XRProjectionLayer } from './XRProjectionLayer.js';

// Draws one view of the layer's texture array across the current viewport;
// the instance index selects the array layer.
const COMPOSITE_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat, either) layer: u32,
};

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let uv = vec2f(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var output: VertexOutput;
  output.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  output.uv = uv;
  output.layer = instanceIndex;
  return output;
}

@group(0) @binding(0) var layerSampler: sampler;
@group(0) @binding(1) var layerTexture: texture_2d_array<f32>;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(layerTexture, layerSampler, input.uv, input.layer);
}
`;

type Compositor = {
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
  bindGroups: WeakMap<GPUTexture, GPUBindGroup>;
};

const compositors = new WeakMap<GPUDevice, Map<GPUTextureFormat, Compositor>>();

const getCompositor = (
  device: GPUDevice,
  format: GPUTextureFormat,
): Compositor => {
  let formatCompositors = compositors.get(device);
  if (!formatCompositors) {
    formatCompositors = new Map();
    compositors.set(device, formatCompositors);
  }
  let compositor = formatCompositors.get(format);
  if (!compositor) {
    const module = device.createShaderModule({
      label: 'IWER layer compositor',
      code: COMPOSITE_SHADER,
    });
    compositor = {
      pipeline: device.createRenderPipeline({
        label: 'IWER layer compositor',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
      }),
      sampler: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      }),
      bindGroups: new WeakMap(),
    };
    formatCompositors.set(format, compositor);
  }
  return compositor;
};

const getBindGroup = (
  device: GPUDevice,
  compositor: Compositor,
  texture: GPUTexture,
): GPUBindGroup => {
  let bindGroup = compositor.bindGroups.get(texture);
  if (!bindGroup) {
    bindGroup = device.createBindGroup({
      layout: compositor.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: compositor.sampler },
        {
          binding: 1,
          resource: texture.createView({ dimension: '2d-array' }),
        },
      ],
    });
    compositor.bindGroups.set(texture, bindGroup);
  }
  return bindGroup;
};

// Clears color to 0, depth to 1 and stencil to 0, as the next frame expects.
export const clearArrayLayers = (
  encoder: GPUCommandEncoder,
  colorTexture: GPUTexture,
  depthStencilTexture: GPUTexture | null,
) => {
  for (let i = 0; i < colorTexture.depthOrArrayLayers; i++) {
    const viewDescriptor: GPUTextureViewDescriptor = {
      dimension: '2d',
      baseArrayLayer: i,
      arrayLayerCount: 1,
    };
    let depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (depthStencilTexture) {
      depthStencilAttachment = {
        view: depthStencilTexture.createView(viewDescriptor),
      };
      // Load and store ops may only be set for aspects the format has.
      if (depthStencilTexture.format !== 'stencil8') {
        depthStencilAttachment.depthClearValue = 1.0;
        depthStencilAttachment.depthLoadOp = 'clear';
        depthStencilAttachment.depthStoreOp = 'store';
      }
      if (depthStencilTexture.format.includes('stencil')) {
        depthStencilAttachment.stencilClearValue = 0;
        depthStencilAttachment.stencilLoadOp = 'clear';
        depthStencilAttachment.stencilStoreOp = 'store';
      }
    }
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: colorTexture.createView(viewDescriptor),
            clearValue: [0, 0, 0, 0],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment,
      })
      .end();
  }
};

/**
 * Shows the projection layer of a WebGPU session on an IWER-owned canvas,
 * mounted where a WebGL session's canvas would be.
 */
export class XRGPUPresenter {
  private xrDevice: XRDevice;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext | null;
  private format: GPUTextureFormat;
  private configuredDevice: GPUDevice | null = null;

  constructor(xrDevice: XRDevice) {
    this.xrDevice = xrDevice;
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext | null;
    this.format = navigator.gpu.getPreferredCanvasFormat();
  }

  attach(): void {
    this.xrDevice[P_DEVICE].mountCanvas(this.canvas);
  }

  // Hides the last presented image while no usable layer is set.
  setVisible(visible: boolean): void {
    this.canvas.style.visibility = visible ? '' : 'hidden';
  }

  present(layer: XRProjectionLayer): void {
    const context = this.context;
    if (!context || layer[P_COMPOSITION_LAYER].destroyed) {
      return;
    }
    const { device, colorTexture, depthStencilTexture } =
      layer[P_PROJECTION_LAYER];
    try {
      if (this.configuredDevice !== device) {
        context.configure({
          device,
          format: this.format,
          alphaMode: 'premultiplied',
        });
        this.configuredDevice = device;
      }
      const canvas = this.canvas;
      if (canvas.width !== window.innerWidth) {
        canvas.width = window.innerWidth;
      }
      if (canvas.height !== window.innerHeight) {
        canvas.height = window.innerHeight;
      }

      const compositor = getCompositor(device, this.format);
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
      pass.setPipeline(compositor.pipeline);
      pass.setBindGroup(0, getBindGroup(device, compositor, colorTexture));
      // Like the WebGL viewports, mono shows only the left view.
      const viewCount = this.xrDevice.stereoEnabled ? 2 : 1;
      const viewWidth = canvas.width / viewCount;
      const forceMono = layer[P_COMPOSITION_LAYER].forceMonoPresentation;
      for (let view = 0; view < viewCount; view++) {
        pass.setViewport(view * viewWidth, 0, viewWidth, canvas.height, 0, 1);
        pass.draw(3, 1, 0, forceMono ? 0 : view);
      }
      pass.end();
      clearArrayLayers(encoder, colorTexture, depthStencilTexture);
      device.queue.submit([encoder.finish()]);
    } catch (error) {
      console.error(error);
    }
  }

  detach(): void {
    this.context?.unconfigure();
    this.configuredDevice = null;
  }
}
