/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { detectRuntime } from '@harness/runtime-detect';
import { startWebGPUSession, withFrame, cleanup } from '@harness/xr-helpers';
import {
  createWebGLContext,
  makeXRCompatible,
  destroyWebGLContext,
} from '@harness/webgl-helper';

const COLOR_FORMATS = ['rgba8unorm', 'bgra8unorm', 'rgba16float'];

// WebGPU flags, which TypeScript's DOM types don't declare: GPUTextureUsage
// RENDER_ATTACHMENT | COPY_SRC, GPUBufferUsage MAP_READ | COPY_DST, and
// GPUMapMode.READ.
const FRAME_USAGE = 0x11;
const READBACK_USAGE = 0x09;
const MAP_READ = 0x01;
// GPUTextureUsage RENDER_ATTACHMENT | COPY_DST, for layers a test writes to.
const WRITABLE_USAGE = 0x12;

// Fills a subimage's view of its color texture with one color.
function fill(
  device: GPUDevice,
  subImage: XRGPUSubImage,
  color: number[],
): void {
  const encoder = device.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [
        {
          view: subImage.colorTexture.createView(subImage.getViewDescriptor()),
          clearValue: color,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    .end();
  device.queue.submit([encoder.finish()]);
}

// Clears a subimage's depth and motion vectors, as an app rendering for space
// warp does.
function fillMotion(
  device: GPUDevice,
  subImage: XRGPUSubImage,
  motion: number[],
  depth: number,
): void {
  const view = subImage.getViewDescriptor();
  const encoder = device.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [
        {
          view: subImage.motionVectorTexture!.createView(view),
          clearValue: motion,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: subImage.depthStencilTexture!.createView(view),
        depthClearValue: depth,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })
    .end();
  device.queue.submit([encoder.finish()]);
}

// Writes a subimage's view as quadrants: red and green on top, blue and white
// below. Its layer needs WRITABLE_USAGE.
function fillQuadrants(device: GPUDevice, subImage: XRGPUSubImage): void {
  const { x, y, width, height } = subImage.viewport;
  const bgra = subImage.colorTexture.format.startsWith('bgra');
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ].map(([r, g, b]) => (bgra ? [b, g, r, 255] : [r, g, b, 255]));
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const quadrant =
        (row < height / 2 ? 0 : 2) + (column < width / 2 ? 0 : 1);
      data.set(colors[quadrant], (row * width + column) * 4);
    }
  }
  device.queue.writeTexture(
    {
      texture: subImage.colorTexture,
      origin: [x, y, subImage.getViewDescriptor().baseArrayLayer ?? 0],
    },
    data,
    { bytesPerRow: width * 4, rowsPerImage: height },
    [width, height, 1],
  );
}

/**
 * Headless Chromium's software WebGPU adapter can't present canvases, so in
 * IWER mode the WebGPU canvases IWER draws layers on get a stand-in context:
 * each frame goes to a plain texture on the configured device, which tests can
 * read back. Everything else IWER does on the device is real. Returns a
 * function that restores getContext.
 */
function useTextureCanvases(): {
  textureOf: (canvas: HTMLCanvasElement) => GPUTexture | undefined;
  restore: () => void;
} {
  const getContext = HTMLCanvasElement.prototype.getContext;
  const textures = new WeakMap<HTMLCanvasElement, GPUTexture>();
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...args: unknown[]
  ) {
    if (type !== 'webgpu') {
      return (getContext as any).call(this, type, ...args);
    }
    const canvas = this;
    let configuration: GPUCanvasConfiguration | null = null;
    return {
      canvas,
      configure(config: GPUCanvasConfiguration) {
        configuration = config;
      },
      unconfigure() {
        configuration = null;
      },
      getConfiguration: () => configuration,
      getCurrentTexture() {
        let texture = textures.get(canvas);
        if (
          !texture ||
          texture.width !== canvas.width ||
          texture.height !== canvas.height
        ) {
          texture?.destroy();
          texture = configuration!.device.createTexture({
            size: [canvas.width, canvas.height],
            format: configuration!.format,
            usage: FRAME_USAGE,
          });
          textures.set(canvas, texture);
        }
        return texture;
      },
    } as unknown as GPUCanvasContext;
  } as typeof getContext;
  return {
    textureOf: (canvas) => textures.get(canvas),
    restore: () => {
      HTMLCanvasElement.prototype.getContext = getContext;
    },
  };
}

// Reads the RGB of pixels of an 8-bit RGBA or BGRA texture, at points given
// as fractions of its size, as "r,g,b" strings.
async function readPixels(
  device: GPUDevice,
  texture: GPUTexture,
  points: [number, number][],
): Promise<string[]> {
  const buffers = points.map(([fx, fy]) => {
    const buffer = device.createBuffer({
      size: 256,
      usage: READBACK_USAGE,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      {
        texture,
        origin: [
          Math.floor(fx * texture.width),
          Math.floor(fy * texture.height),
        ],
      },
      { buffer, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([encoder.finish()]);
    return buffer;
  });
  return Promise.all(
    buffers.map(async (buffer) => {
      await buffer.mapAsync(MAP_READ);
      const [a, b, c] = new Uint8Array(buffer.getMappedRange());
      buffer.destroy();
      return (texture.format.startsWith('bgra') ? [c, b, a] : [a, b, c]).join();
    }),
  );
}

/**
 * WebXR/WebGPU binding: XRGPUBinding, XRGPUSubImage and WebGPU layers, on a
 * real GPUDevice. Runs where the browser can provide a WebGPU adapter, and any
 * WebGPU validation error fails a test.
 */
export function registerXRGPUBindingTests(harness: TestHarness): void {
  harness.describe('WebXR/WebGPU binding', () => {
    let device: GPUDevice | null = null;
    let session: XRSession | null = null;
    let canvases: ReturnType<typeof useTextureCanvases> | null = null;
    const gpuErrors: string[] = [];

    harness.beforeAll(async () => {
      const adapter = await navigator.gpu?.requestAdapter({
        xrCompatible: true,
      } as GPURequestAdapterOptions);
      device = adapter ? await adapter.requestDevice() : null;
      device?.addEventListener('uncapturederror', (event) => {
        gpuErrors.push((event as GPUUncapturedErrorEvent).error.message);
      });
      if (device && detectRuntime() === 'iwer') {
        canvases = useTextureCanvases();
      }
    });

    harness.afterAll(() => {
      canvases?.restore();
    });

    harness.beforeEach(() => {
      gpuErrors.length = 0;
    });

    harness.afterEach(async () => {
      await cleanup(session, null);
      session = null;
    });

    const start = async (features: string[] = []) => {
      harness.skipIf(!device, 'No WebGPU adapter');
      session = await startWebGPUSession('immersive-vr', features);
      return session;
    };

    // Waits for the device to finish, then fails on any validation error.
    const assertNoGPUErrors = async () => {
      await device!.queue.onSubmittedWorkDone();
      harness.assert(
        gpuErrors.length === 0,
        `WebGPU errors: ${gpuErrors.join(' | ')}`,
      );
    };

    // What IWER last drew on its canvas, at points given as fractions.
    const shownPixels = (
      xrDevice: { appCanvas?: HTMLCanvasElement },
      points: [number, number][],
    ) => readPixels(device!, canvases!.textureOf(xrDevice.appCanvas!)!, points);

    harness.it(
      "grants 'webgpu' with an empty layers render state",
      async () => {
        const s = await start();
        harness.assert(
          s.enabledFeatures.includes('webgpu'),
          "'webgpu' should be enabled",
        );
        harness.assert(
          Array.isArray(s.renderState.layers),
          'renderState.layers should be an array',
        );
        harness.assertEqual(s.renderState.layers!.length, 0);
        harness.assertEqual(s.renderState.baseLayer, null);
      },
    );

    harness.it(
      'XRGPUBinding reports a color format and scale factor',
      async () => {
        const binding = new XRGPUBinding(await start(), device!);
        harness.assert(
          COLOR_FORMATS.includes(binding.getPreferredColorFormat()),
          `unexpected format ${binding.getPreferredColorFormat()}`,
        );
        harness.assertGreaterThan(binding.nativeProjectionScaleFactor, 0);
        harness.assertEqual(binding.usesDepthValues, false);
      },
    );

    harness.it(
      'XRWebGLLayer throws InvalidStateError in a WebGPU session',
      async () => {
        const s = await start();
        const { canvas, gl } = createWebGLContext();
        try {
          await makeXRCompatible(gl);
          harness.assertThrows(
            () => new XRWebGLLayer(s, gl),
            'InvalidStateError',
          );
        } finally {
          destroyWebGLContext(canvas);
        }
      },
    );

    harness.it(
      'createProjectionLayer makes one texture layer per view',
      async () => {
        const s = await start();
        const binding = new XRGPUBinding(s, device!);
        const layer = binding.createProjectionLayer({
          colorFormat: binding.getPreferredColorFormat(),
        });
        // Frames only run while the render state has a layer.
        s.updateRenderState({ layers: [layer] });
        const space = await s.requestReferenceSpace('local');
        const views = await withFrame(
          s,
          (_t, frame) => frame.getViewerPose(space)!.views.length,
        );
        harness.assertGreaterThan(layer.textureWidth, 0);
        harness.assertGreaterThan(layer.textureHeight, 0);
        harness.assertEqual(layer.textureArrayLength, views);
        harness.assertEqual(layer.ignoreDepthValues, true);
      },
    );

    harness.it(
      'getViewSubImage gives each view its layer of one texture',
      async () => {
        const s = await start();
        const binding = new XRGPUBinding(s, device!);
        const layer = binding.createProjectionLayer({
          colorFormat: binding.getPreferredColorFormat(),
          depthStencilFormat: 'depth24plus',
        });
        s.updateRenderState({ layers: [layer] });
        const space = await s.requestReferenceSpace('local');
        await withFrame(s, (_t, frame) => {
          const subImages = frame
            .getViewerPose(space)!
            .views.map((view) => binding.getViewSubImage(layer, view));
          subImages.forEach((subImage, index) => {
            harness.assertEqual(
              subImage.colorTexture,
              subImages[0].colorTexture,
            );
            harness.assertEqual(
              subImage.colorTexture.width,
              layer.textureWidth,
            );
            harness.assertEqual(
              subImage.getViewDescriptor().baseArrayLayer,
              index,
            );
            harness.assertEqual(
              subImage.depthStencilTexture!.format,
              'depth24plus',
            );
            harness.assertEqual(subImage.motionVectorTexture, null);
            const { x, y, width, height } = subImage.viewport;
            harness.assert(
              x >= 0 &&
                y >= 0 &&
                x + width <= layer.textureWidth &&
                y + height <= layer.textureHeight,
              'viewport should lie inside the texture',
            );
          });
        });
        await assertNoGPUErrors();
      },
    );

    harness.it("a frame's textures are destroyed when it ends", async () => {
      const s = await start();
      const binding = new XRGPUBinding(s, device!);
      const layer = binding.createProjectionLayer({
        colorFormat: binding.getPreferredColorFormat(),
      });
      s.updateRenderState({ layers: [layer] });
      const space = await s.requestReferenceSpace('local');
      let view: XRView;
      const subImage = await withFrame(s, (_t, frame) => {
        view = frame.getViewerPose(space)!.views[0];
        return binding.getViewSubImage(layer, view);
      });
      harness.assertThrows(
        () => binding.getViewSubImage(layer, view),
        'InvalidStateError',
      );
      await assertNoGPUErrors();
      device!.pushErrorScope('validation');
      fill(device!, subImage, [1, 0, 0, 1]);
      const error = await device!.popErrorScope();
      harness.assert(error !== null, 'drawing after the frame should fail');
    });

    harness.it('[iwer] shows what the app drew in each view', async (ctx) => {
      harness.skipIf(ctx.mode !== 'iwer', 'Reads back what IWER draws');
      const s = await start();
      const binding = new XRGPUBinding(s, device!);
      const layer = binding.createProjectionLayer({
        colorFormat: binding.getPreferredColorFormat(),
      });
      s.updateRenderState({ layers: [layer] });
      const space = await s.requestReferenceSpace('local');
      const colors = [
        [1, 0, 0, 1],
        [0, 0, 1, 1],
      ];
      await withFrame(s, (_t, frame) => {
        frame.getViewerPose(space)!.views.forEach((view, index) => {
          fill(device!, binding.getViewSubImage(layer, view), colors[index]);
        });
      });
      const [left, right] = await shownPixels(ctx.xrDevice!, [
        [0.25, 0.5],
        [0.75, 0.5],
      ]);
      harness.assertEqual(left, '255,0,0', 'left view');
      harness.assertEqual(right, '0,0,255', 'right view');
      await assertNoGPUErrors();
    });

    // Non-default quality layers sample anisotropically, which WebGPU only
    // accepts with linear filters.
    for (const quality of ['default', 'text-optimized'] as const) {
      harness.it(
        `[iwer] 'layers' shows a ${quality} quad over the projection layer`,
        async (ctx) => {
          harness.skipIf(ctx.mode !== 'iwer', 'Reads back what IWER draws');
          const s = await start(['layers']);
          const binding = new XRGPUBinding(s, device!);
          const format = binding.getPreferredColorFormat();
          const space = await s.requestReferenceSpace('local');
          const projection = binding.createProjectionLayer({
            colorFormat: format,
          });
          const quad = binding.createQuadLayer({
            colorFormat: format,
            space,
            viewPixelWidth: 64,
            viewPixelHeight: 32,
            transform: new XRRigidTransform({ x: 0, y: 0, z: -2, w: 1 }),
          });
          quad.quality = quality;
          s.updateRenderState({ layers: [projection, quad] });
          await withFrame(s, (_t, frame) => {
            for (const view of frame.getViewerPose(space)!.views) {
              fill(
                device!,
                binding.getViewSubImage(projection, view),
                [0, 0, 1, 1],
              );
            }
            const subImage = binding.getSubImage(quad, frame);
            harness.assertEqual(subImage.colorTexture.width, 64);
            harness.assertEqual(subImage.colorTexture.height, 32);
            fill(device!, subImage, [1, 0, 0, 1]);
          });
          const [quadPixel, corner] = await shownPixels(ctx.xrDevice!, [
            [0.25, 0.5],
            [0.01, 0.01],
          ]);
          harness.assertEqual(quadPixel, '255,0,0', 'the quad');
          harness.assertEqual(corner, '0,0,255', 'the projection layer');
          await assertNoGPUErrors();
        },
      );
    }

    harness.it(
      "'space-warp' adds motion vectors and synthesizes frames",
      async (ctx) => {
        const s = await start(['space-warp']);
        const binding = new XRGPUBinding(s, device!);
        harness.assertEqual(binding.usesDepthValues, true);
        const layer = binding.createProjectionLayer({
          colorFormat: binding.getPreferredColorFormat(),
          depthStencilFormat: 'depth24plus',
        });
        harness.assertEqual(layer.ignoreDepthValues, false);
        s.updateRenderState({ layers: [layer] });
        const space = await s.requestReferenceSpace('local');
        let frames = 0;
        await withFrame(s, (_t, frame) => {
          for (const view of frame.getViewerPose(space)!.views) {
            const subImage = binding.getViewSubImage(layer, view);
            const motion = subImage.motionVectorTexture!;
            harness.assertEqual(motion.format, 'rgba16float');
            harness.assertEqual(
              motion.width,
              subImage.depthStencilTexture!.width,
            );
            harness.assertEqual(
              motion.height,
              subImage.depthStencilTexture!.height,
            );
            fill(device!, subImage, [0, 1, 0, 1]);
            fillMotion(device!, subImage, [0, 0, 0, 0], 0.5);
          }
        });
        if (ctx.mode === 'iwer') {
          // IWER synthesizes the next frame, so the app's callback waits a frame.
          s.requestAnimationFrame(() => frames++);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          harness.assertEqual(frames, 0, 'the app should skip a frame');
          const [shown] = await shownPixels(ctx.xrDevice!, [[0.25, 0.5]]);
          harness.assertEqual(shown, '0,255,0', 'the synthesized frame');
        }
        await assertNoGPUErrors();
      },
    );

    harness.it(
      "[iwer] 'space-warp' runs at full rate when the app draws only color",
      async (ctx) => {
        harness.skipIf(ctx.mode !== 'iwer', 'Checks when IWER synthesizes');
        const s = await start(['space-warp']);
        const binding = new XRGPUBinding(s, device!);
        const layer = binding.createProjectionLayer({
          colorFormat: binding.getPreferredColorFormat(),
          depthStencilFormat: 'depth24plus',
        });
        s.updateRenderState({ layers: [layer] });
        const space = await s.requestReferenceSpace('local');
        await withFrame(s, (_t, frame) => {
          for (const view of frame.getViewerPose(space)!.views) {
            fill(device!, binding.getViewSubImage(layer, view), [0, 1, 0, 1]);
          }
        });
        let frames = 0;
        s.requestAnimationFrame(() => frames++);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        harness.assertEqual(frames, 1, 'the app should get the next frame');
        await assertNoGPUErrors();
      },
    );

    harness.it(
      '[iwer] synthesized frames move pixels along their motion vectors',
      async (ctx) => {
        harness.skipIf(ctx.mode !== 'iwer', 'Reads back what IWER draws');
        const s = await start(['space-warp']);
        const binding = new XRGPUBinding(s, device!);
        const layer = binding.createProjectionLayer({
          colorFormat: binding.getPreferredColorFormat(),
          depthStencilFormat: 'depth24plus',
          textureUsage: WRITABLE_USAGE,
        });
        s.updateRenderState({ layers: [layer] });
        const space = await s.requestReferenceSpace('local');
        await withFrame(s, (_t, frame) => {
          for (const view of frame.getViewerPose(space)!.views) {
            const subImage = binding.getViewSubImage(layer, view);
            fillQuadrants(device!, subImage);
            // Up and to the right, in NDC.
            fillMotion(device!, subImage, [0.4, 0.4, 0, 0], 0.5);
          }
        });
        // IWER extrapolates part of a frame interval, so the synthesized frame
        // moves the image by 0.06 to 0.2 of a view. The left view is the left
        // half of the canvas.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const [rightOfEdge, aboveEdge, topLeft, bottomRight] =
          await shownPixels(ctx.xrDevice!, [
            [0.265, 0.25],
            [0.125, 0.47],
            [0.125, 0.25],
            [0.375, 0.75],
          ]);
        harness.assertEqual(rightOfEdge, '255,0,0', 'red should move right');
        harness.assertEqual(aboveEdge, '0,0,255', 'blue should move up');
        harness.assertEqual(topLeft, '255,0,0', 'top-left stays red');
        harness.assertEqual(bottomRight, '255,255,255', 'bottom-right stays');
        await assertNoGPUErrors();
      },
    );
  });
}
