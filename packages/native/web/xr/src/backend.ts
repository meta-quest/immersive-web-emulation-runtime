/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IWER host mode's XRHostBackend over the native XR module (docs/spec/09 XRF-B-1..4).

import type {
  NativeMesh,
  NativePlane,
  XRHostAnchor,
  XRHostBackend,
  XRHostErrorSource,
  XRHostLayer,
  XRHostSwapchain,
  XRHostSwapchainOptions,
} from 'iwer/host';

import { NativeAnchors } from './anchors.ts';
import type { RuntimeStore } from './anchors.ts';
import type { NativeAnchor } from './anchors.ts';
import type { GraphicsBridge } from './graphics.ts';
import type { LayerBuffer } from './layers.ts';
import type { WebGLHooks, XrNatives } from './natives.ts';
import type { NativeScene } from './scene.ts';

type ReportError = (error: unknown) => void;

export class NativeHostBackend implements XRHostBackend {
  /** XR-LIFE-2: granted at once unless the runtime runs in explicit-grant mode (set from the capabilities). */
  autoGrantOfferedSession = true;
  /** XRWebGLLayer: discard its depth after each frame (GL-PERF-5). */
  invalidateDepth = true;
  /** Spatial anchors (XR-ANCHOR-1); the hooks below delegate to it. */
  readonly anchors: NativeAnchors;
  private readonly natives: XrNatives;
  private readonly gfx: GraphicsBridge;
  private readonly hooks: WebGLHooks | null;
  private readonly report: ReportError;
  private readonly schedule: (cb: () => void) => void;
  private readonly layers: LayerBuffer | null;
  /** XR-LAYER-1 quad and cylinder layers: absent (IWER then throws NotSupportedError) without the native side. */
  getLayerColorTexture?: (id: number) => object | null;
  /** The room (XR-AR-2); null without the scene natives. */
  scene: NativeScene | null = null;

  constructor(
    natives: XrNatives,
    gfx: GraphicsBridge,
    hooks: WebGLHooks | null,
    report: ReportError,
    schedule: (cb: () => void) => void,
    layers: LayerBuffer | null = null,
  ) {
    this.natives = natives;
    this.gfx = gfx;
    this.hooks = hooks;
    this.report = report;
    this.schedule = schedule;
    this.layers = layers;
    if (layers && typeof natives.beginLayerSwapchain === 'function') {
      this.getLayerColorTexture = (id) => this.gfx.layerTexture(id);
    }
    // the app's persisted anchors live in localStorage's runtime entries, which the page cannot clear (anchors.ts)
    this.anchors = new NativeAnchors(
      natives,
      () => (globalThis as { __iwnRuntimeStorage?: RuntimeStore }).__iwnRuntimeStorage ?? null,
    );
  }

  beginSwapchain(o: XRHostSwapchainOptions): XRHostSwapchain | null {
    if (o.layer) return this.beginLayerSwapchain(o);
    const r = this.natives.beginSwapchain(
      o.arraySize,
      o.scale,
      o.format,
      typeof o.foveation === 'number' ? o.foveation : -1,
      o.passthrough === true,
      o.unpremultiplied === true,
    );
    if (!r) return null;  // IWER throws OperationError from the layer constructor
    this.gfx.onSwapchain(r.arraySize);
    const answer: XRHostSwapchain = {
      width: r.width,
      height: r.height,
      arraySize: r.arraySize,
      rates: r.rates,
      rate: r.rate,
      hasStage: r.hasStage,
      stageWidth: r.stageWidth,
      stageDepth: r.stageDepth,
    };
    if (typeof r.foveation === 'number') answer.foveation = r.foveation;
    return answer;
  }

  /** A quad or cylinder layer's own swapchain (XR-LAYER-1): sized by IWER in pixels, `id` for later calls. */
  private beginLayerSwapchain(o: XRHostSwapchainOptions): XRHostSwapchain | null {
    const begin = this.natives.beginLayerSwapchain;
    if (!begin || !this.layers) return null;
    // a 'texture-array' layer is drawn through a TEXTURE_2D_ARRAY, also a mono one (an array of one layer)
    const textureArray = o.textureType === 'texture-array' || o.arraySize >= 2;
    const r = begin.call(
      this.natives,
      o.layer === 'cylinder' ? 3 : 2,
      o.width ?? 0,
      o.height ?? 0,
      o.arraySize,
      o.format,
      o.isStatic === true,
      o.mipLevels ?? 1,
      textureArray,
    );
    if (!r) return null;  // IWER throws OperationError from createQuadLayer / createCylinderLayer
    this.gfx.addLayer(r.id, textureArray);
    return { id: r.id, width: r.width, height: r.height, arraySize: r.arraySize };
  }

  /** layer.destroy(). */
  releaseSwapchain(id: number): void {
    this.gfx.dropLayer(id);
    this.natives.destroyLayerSwapchain?.(id);
  }

  /** The frame's layer list (renderState.layers order) for the XR thread, through the shared buffer. */
  submitLayers(list: readonly XRHostLayer[]): void {
    this.layers?.write(list);
  }

  endSession(): void {
    this.gfx.onSessionEnd();
    this.natives.endSession();
  }

  requestFrameRate(rate: number): boolean {
    return this.natives.requestFrameRate(rate);
  }

  setFixedFoveation(level: number): void {
    this.natives.setFoveation(level);
  }

  setPassthroughVisible(visible: boolean): void {
    this.natives.setPassthroughVisible(visible);
  }

  /** Plane detection and hit test (IWER reads these at most once per frame; see scene.ts). */
  getPlanes(): readonly NativePlane[] | null {
    return this.scene ? this.scene.planes() : null;
  }

  /** Mesh detection and hit test. */
  getMeshes(): readonly NativeMesh[] | null {
    return this.scene ? this.scene.meshes() : null;
  }

  getOpaqueColorTexture(): object | null {
    return this.gfx.opaqueTexture();
  }

  wrapTexture(name: number): object | null {
    return this.gfx.wrap(name);
  }

  /**
   * Window rAF callbacks for this frame. The `time` IWER passes (the predicted display time) is ignored: window
   * callbacks get the frame's start time, which the native side holds (XRF-B-2, TMR-5).
   */
  runWindowFrame(_time: number): void {
    this.natives.runWindowFrame();
    this.hooks?.afterAnimationFrame();
  }

  /** A task after the current frame (IWER finishes an end() called from an XR callback this way). */
  postTask(callback: () => void): void {
    this.schedule(callback);
  }

  // Anchors (XR-ANCHOR-1): IWER offers them only to sessions granted 'anchors', which needs the native support.
  createAnchor(transform: Float32Array): Promise<XRHostAnchor> {
    return this.anchors.create(transform);
  }

  getAnchorPose(anchor: XRHostAnchor, out: Float32Array): boolean {
    return this.anchors.pose(anchor as NativeAnchor, out);
  }

  deleteAnchor(anchor: XRHostAnchor): void {
    this.anchors.destroy(anchor as NativeAnchor);
  }

  persistAnchor(anchor: XRHostAnchor): Promise<string> {
    return this.anchors.persist(anchor as NativeAnchor);
  }

  restoreAnchor(uuid: string): Promise<XRHostAnchor> {
    return this.anchors.restore(uuid);
  }

  erasePersistentAnchor(uuid: string): Promise<void> {
    return this.anchors.erase(uuid);
  }

  getPersistentAnchors(): readonly string[] {
    return this.anchors.persisted();
  }

  /** XR-LOOP-3: exceptions from XR callbacks are reported like uncaught ones; the frame goes on. */
  reportError(error: unknown, _source: XRHostErrorSource): void {
    this.report(error);
  }
}
