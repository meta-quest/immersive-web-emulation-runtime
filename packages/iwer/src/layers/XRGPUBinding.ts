/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  P_COMPOSITION_LAYER,
  P_DEPTH_INFO,
  P_DEVICE,
  P_FRAME,
  P_GPU_BINDING,
  P_GPU_SUB_IMAGE,
  P_PROJECTION_LAYER,
  P_SESSION,
  P_SUB_IMAGE,
  P_VIEW,
} from '../private.js';
import { XREye, type XRView } from '../views/XRView.js';
import {
  XRCompositionLayer,
  XRProjectionLayer,
  type XRLayerLayout,
} from './XRProjectionLayer.js';
import {
  XRCubeLayer,
  XRCylinderLayer,
  XREquirectLayer,
  XRQuadLayer,
  checkLayerSpace,
} from './XRSpaceLayers.js';
import { GPULayerTextures } from './GPULayerTextures.js';
import { XRViewport } from '../views/XRViewport.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import type { XRSession } from '../session/XRSession.js';
import type { XRSpace } from '../spaces/XRSpace.js';
import type {
  WebGPUDevice,
  WebGPUTexture,
  WebGPUTextureFormat,
  WebGPUTextureViewDescriptor,
} from '../types/webgpu.js';

export interface XRGPUProjectionLayerInit {
  colorFormat: WebGPUTextureFormat;
  depthStencilFormat?: WebGPUTextureFormat;
  textureUsage?: number;
  scaleFactor?: number;
}

export interface XRGPULayerInit {
  colorFormat: WebGPUTextureFormat;
  depthStencilFormat?: WebGPUTextureFormat;
  textureUsage?: number;
  space: XRSpace;
  mipLevels?: number;
  viewPixelWidth: number;
  viewPixelHeight: number;
  layout?: XRLayerLayout;
  isStatic?: boolean;
}

export interface XRGPUQuadLayerInit extends XRGPULayerInit {
  transform?: XRRigidTransform | null;
  width?: number;
  height?: number;
}

export interface XRGPUCylinderLayerInit extends XRGPULayerInit {
  transform?: XRRigidTransform | null;
  radius?: number;
  centralAngle?: number;
  aspectRatio?: number;
}

export interface XRGPUEquirectLayerInit extends XRGPULayerInit {
  transform?: XRRigidTransform | null;
  radius?: number;
  centralHorizontalAngle?: number;
  upperVerticalAngle?: number;
  lowerVerticalAngle?: number;
}

export interface XRGPUCubeLayerInit extends XRGPULayerInit {
  orientation?: DOMPointReadOnly | null;
}

// GPUTextureUsage flags, inlined so this module loads without WebGPU globals.
const COPY_DST = 0x02;
const STORAGE_BINDING = 0x08;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;
const KNOWN_TEXTURE_USAGE = 0x1f;

const COLOR_FORMATS: WebGPUTextureFormat[] = [
  'rgba8unorm',
  'bgra8unorm',
  'rgba16float',
];
const DEPTH_STENCIL_FORMATS: WebGPUTextureFormat[] = [
  'stencil8',
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
  'depth32float-stencil8',
];
const LAYOUTS: XRLayerLayout[] = [
  'default',
  'mono',
  'stereo',
  'stereo-left-right',
  'stereo-top-bottom',
];

const MIN_SCALE_FACTOR = 0.2;

// Immersive sessions always report a left and a right view.
const VIEW_COUNT = 2;

// Array layer of an eye's view in the layer and depth textures.
const arrayLayer = (eye: XREye) => (eye === XREye.Right ? 1 : 0);

const lostDevices = new WeakSet<WebGPUDevice>();

const notSupported = (message: string) =>
  new DOMException(message, 'NotSupportedError');
const invalidState = (message: string) =>
  new DOMException(message, 'InvalidStateError');

// WebIDL unsigned long: values wrap modulo 2^32 and non-numbers become 0.
const toUnsignedLong = (value: unknown): number => {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? ((number % 2 ** 32) + 2 ** 32) % 2 ** 32 : 0;
};

// WebIDL float with a dictionary default: non-finite values throw.
const toFloat = (value: number | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError('Layer dimensions must be finite numbers.');
  }
  return number;
};

// Missing required members and unknown enum values throw while the init
// dictionary is converted, before the method runs.
const readLayerInit = (init: XRGPULayerInit) => {
  for (const member of [
    'colorFormat',
    'space',
    'viewPixelWidth',
    'viewPixelHeight',
  ] as const) {
    if (init?.[member] === undefined) {
      throw new TypeError(
        `The layer init is missing the required '${member}'.`,
      );
    }
  }
  const layout = init.layout ?? 'mono';
  if (!LAYOUTS.includes(layout)) {
    throw new TypeError(`Unknown layer layout '${layout}'.`);
  }
  return {
    colorFormat: init.colorFormat,
    depthStencilFormat: init.depthStencilFormat ?? undefined,
    textureUsage:
      init.textureUsage === undefined
        ? RENDER_ATTACHMENT
        : toUnsignedLong(init.textureUsage),
    space: init.space,
    mipLevels:
      init.mipLevels === undefined ? 1 : toUnsignedLong(init.mipLevels),
    viewPixelWidth: toUnsignedLong(init.viewPixelWidth),
    viewPixelHeight: toUnsignedLong(init.viewPixelHeight),
    layout,
    isStatic: Boolean(init.isStatic),
  };
};

// createTexture() reports validation errors asynchronously, so reject what it
// would refuse up front, as "create an XR GPU texture descriptor" requires.
const createDescriptor = (
  device: WebGPUDevice,
  label: string,
  width: number,
  height: number,
  arrayLayerCount: number,
  mipLevelCount: number,
  format: WebGPUTextureFormat,
  usage: number,
): GPUTextureDescriptor => {
  const isDepthStencil = DEPTH_STENCIL_FORMATS.includes(format);
  const { maxTextureDimension2D, maxTextureArrayLayers = 256 } = device.limits;
  if (usage === 0 || usage & ~KNOWN_TEXTURE_USAGE) {
    throw notSupported(`Unsupported textureUsage ${usage}.`);
  }
  if (width > maxTextureDimension2D || height > maxTextureDimension2D) {
    throw notSupported(
      `${width}x${height} exceeds the device's maxTextureDimension2D.`,
    );
  }
  if (arrayLayerCount > maxTextureArrayLayers) {
    throw notSupported(
      `${arrayLayerCount} array layers exceed the device's maxTextureArrayLayers.`,
    );
  }
  if (
    format === 'depth32float-stencil8' &&
    !device.features.has('depth32float-stencil8')
  ) {
    throw notSupported(
      "depth32float-stencil8 requires the 'depth32float-stencil8' device feature.",
    );
  }
  if (
    usage & STORAGE_BINDING &&
    (isDepthStencil ||
      (format === 'bgra8unorm' && !device.features.has('bgra8unorm-storage')))
  ) {
    throw notSupported('STORAGE_BINDING is not supported for this format.');
  }
  return {
    label,
    size: [width, height, arrayLayerCount],
    mipLevelCount,
    sampleCount: 1,
    dimension: '2d',
    format,
    usage,
    viewFormats: [],
  };
};

export class XRSubImage {
  [P_SUB_IMAGE]: {
    viewport: XRViewport;
  };

  constructor(viewport: XRViewport) {
    this[P_SUB_IMAGE] = { viewport };
  }

  get viewport(): XRViewport {
    return this[P_SUB_IMAGE].viewport;
  }
}

export class XRGPUSubImage extends XRSubImage {
  [P_GPU_SUB_IMAGE]: {
    colorTexture: WebGPUTexture;
    depthStencilTexture: WebGPUTexture | null;
    motionVectorTexture: WebGPUTexture | null;
    arrayLayerIndex: number;
  };

  constructor(
    viewport: XRViewport,
    colorTexture: WebGPUTexture,
    depthStencilTexture: WebGPUTexture | null,
    motionVectorTexture: WebGPUTexture | null,
    arrayLayerIndex: number,
  ) {
    super(viewport);
    this[P_GPU_SUB_IMAGE] = {
      colorTexture,
      depthStencilTexture,
      motionVectorTexture,
      arrayLayerIndex,
    };
  }

  get colorTexture(): WebGPUTexture {
    return this[P_GPU_SUB_IMAGE].colorTexture;
  }

  get depthStencilTexture(): WebGPUTexture | null {
    return this[P_GPU_SUB_IMAGE].depthStencilTexture;
  }

  get motionVectorTexture(): WebGPUTexture | null {
    return this[P_GPU_SUB_IMAGE].motionVectorTexture;
  }

  getViewDescriptor(): WebGPUTextureViewDescriptor {
    return {
      dimension: '2d',
      mipLevelCount: 1,
      arrayLayerCount: 1,
      baseArrayLayer: this[P_GPU_SUB_IMAGE].arrayLayerIndex,
    };
  }
}

export class XRGPUDepthInformation {
  [P_DEPTH_INFO]: {
    texture: WebGPUTexture;
    width: number;
    height: number;
    normDepthBufferFromNormView: XRRigidTransform;
    rawValueToMeters: number;
    arrayLayer: number;
  };

  constructor(
    texture: WebGPUTexture,
    width: number,
    height: number,
    rawValueToMeters: number,
    arrayLayer: number,
  ) {
    this[P_DEPTH_INFO] = {
      texture,
      width,
      height,
      normDepthBufferFromNormView: new XRRigidTransform(),
      rawValueToMeters,
      arrayLayer,
    };
  }

  get texture(): WebGPUTexture {
    return this[P_DEPTH_INFO].texture;
  }

  get width(): number {
    return this[P_DEPTH_INFO].width;
  }

  get height(): number {
    return this[P_DEPTH_INFO].height;
  }

  get normDepthBufferFromNormView(): XRRigidTransform {
    return this[P_DEPTH_INFO].normDepthBufferFromNormView;
  }

  get rawValueToMeters(): number {
    return this[P_DEPTH_INFO].rawValueToMeters;
  }

  getViewDescriptor(): WebGPUTextureViewDescriptor {
    return {
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: this[P_DEPTH_INFO].arrayLayer,
      arrayLayerCount: 1,
    };
  }
}

type LayerInit = ReturnType<typeof readLayerInit>;

// "Determine a WebGPU layer texture layout".
const layoutSize = ({ viewPixelWidth, viewPixelHeight, layout }: LayerInit) => {
  switch (layout) {
    case 'stereo':
      return [viewPixelWidth, viewPixelHeight, 2] as const;
    case 'stereo-left-right':
      return [viewPixelWidth * 2, viewPixelHeight, 1] as const;
    case 'stereo-top-bottom':
      return [viewPixelWidth, viewPixelHeight * 2, 1] as const;
    case 'default':
      throw new TypeError(
        'The "default" layout is not valid for layers other than projection layers.',
      );
    default:
      return [viewPixelWidth, viewPixelHeight, 1] as const;
  }
};

const copyTransform = (transform: XRRigidTransform | null | undefined) => {
  if (transform === null || transform === undefined) {
    return new XRRigidTransform();
  }
  if (!(transform instanceof XRRigidTransform)) {
    throw new TypeError('A layer transform must be an XRRigidTransform.');
  }
  return new XRRigidTransform(transform.position, transform.orientation);
};

export class XRGPUBinding {
  [P_GPU_BINDING]: {
    session: XRSession;
    device: WebGPUDevice;
    depthTextures: WeakMap<XRFrame, WebGPUTexture>;
  };

  constructor(session: XRSession, device: WebGPUDevice) {
    if (session[P_SESSION].ended) {
      throw invalidState('XRSession has already ended.');
    }
    if (!session[P_SESSION].hasWebGPU) {
      throw invalidState(
        "XRGPUBinding requires an immersive session with the 'webgpu' feature.",
      );
    }
    if (lostDevices.has(device)) {
      throw invalidState('GPUDevice is lost.');
    }
    device.lost?.then(() => lostDevices.add(device));
    this[P_GPU_BINDING] = { session, device, depthTextures: new WeakMap() };
  }

  get nativeProjectionScaleFactor(): number {
    return 1.0;
  }

  get usesDepthValues(): boolean {
    return false;
  }

  getPreferredColorFormat(): WebGPUTextureFormat {
    return navigator.gpu.getPreferredCanvasFormat();
  }

  createProjectionLayer(init: XRGPUProjectionLayerInit): XRProjectionLayer {
    if (init?.colorFormat === undefined) {
      throw new TypeError(
        "XRGPUProjectionLayerInit is missing the required 'colorFormat'.",
      );
    }
    const { session, device } = this[P_GPU_BINDING];
    if (session[P_SESSION].ended) {
      throw invalidState('XRSession has already ended.');
    }
    if (lostDevices.has(device)) {
      throw invalidState('GPUDevice is lost.');
    }
    const {
      colorFormat,
      depthStencilFormat,
      textureUsage = RENDER_ATTACHMENT,
      scaleFactor = 1.0,
    } = init;
    if (!COLOR_FORMATS.includes(colorFormat)) {
      throw notSupported(`Unsupported colorFormat '${colorFormat}'.`);
    }
    if (
      depthStencilFormat != null &&
      !DEPTH_STENCIL_FORMATS.includes(depthStencilFormat)
    ) {
      throw notSupported(
        `Unsupported depthStencilFormat '${depthStencilFormat}'.`,
      );
    }

    const viewSize =
      session[P_SESSION].device[P_DEVICE].getRecommendedViewResolution();
    const scale = Math.min(
      Math.max(scaleFactor, MIN_SCALE_FACTOR),
      Math.max(this.nativeProjectionScaleFactor, 1.0),
    );
    let width = Math.max(1, Math.floor(viewSize.width * scale));
    let height = Math.max(1, Math.floor(viewSize.height * scale));
    const maxDimension = device.limits.maxTextureDimension2D;
    if (width > maxDimension || height > maxDimension) {
      const fit = maxDimension / Math.max(width, height);
      width = Math.max(1, Math.floor(width * fit));
      height = Math.max(1, Math.floor(height * fit));
    }
    const usage = toUnsignedLong(textureUsage);
    const color = createDescriptor(
      device,
      'XRProjectionLayer color',
      width,
      height,
      VIEW_COUNT,
      1,
      colorFormat,
      usage,
    );
    const depthStencil =
      depthStencilFormat != null
        ? createDescriptor(
            device,
            'XRProjectionLayer depth/stencil',
            width,
            height,
            VIEW_COUNT,
            1,
            depthStencilFormat,
            usage,
          )
        : null;
    return new XRProjectionLayer(
      session,
      new GPULayerTextures(device, { color, depthStencil, motionVector: null }),
      true,
    );
  }

  createQuadLayer(init: XRGPUQuadLayerInit): XRQuadLayer {
    const layerInit = readLayerInit(init);
    const transform = copyTransform(init.transform);
    const width = toFloat(init.width, 1.0);
    const height = toFloat(init.height, 1.0);
    this.validateLayerCreation();
    const { session, compositionInit } = this.initializeLayer(
      layerInit,
      layoutSize(layerInit),
      'XRQuadLayer',
    );
    return new XRQuadLayer(session, compositionInit, {
      space: layerInit.space,
      onredraw: null,
      transform,
      width,
      height,
    });
  }

  createCylinderLayer(init: XRGPUCylinderLayerInit): XRCylinderLayer {
    const layerInit = readLayerInit(init);
    const transform = copyTransform(init.transform);
    const radius = toFloat(init.radius, 2.0);
    const centralAngle = toFloat(init.centralAngle, 0.78539);
    const aspectRatio = toFloat(init.aspectRatio, 2.0);
    this.validateLayerCreation();
    const { session, compositionInit } = this.initializeLayer(
      layerInit,
      layoutSize(layerInit),
      'XRCylinderLayer',
    );
    return new XRCylinderLayer(session, compositionInit, {
      space: layerInit.space,
      onredraw: null,
      transform,
      radius,
      centralAngle,
      aspectRatio,
    });
  }

  createEquirectLayer(init: XRGPUEquirectLayerInit): XREquirectLayer {
    const layerInit = readLayerInit(init);
    const transform = copyTransform(init.transform);
    const radius = toFloat(init.radius, 0);
    const centralHorizontalAngle = toFloat(
      init.centralHorizontalAngle,
      6.28318,
    );
    const upperVerticalAngle = toFloat(init.upperVerticalAngle, 1.570795);
    const lowerVerticalAngle = toFloat(init.lowerVerticalAngle, -1.570795);
    this.validateLayerCreation();
    checkLayerSpace(this[P_GPU_BINDING].session, layerInit.space, true);
    const { session, compositionInit } = this.initializeLayer(
      layerInit,
      layoutSize(layerInit),
      'XREquirectLayer',
    );
    return new XREquirectLayer(session, compositionInit, {
      space: layerInit.space,
      onredraw: null,
      transform,
      radius,
      centralHorizontalAngle,
      upperVerticalAngle,
      lowerVerticalAngle,
    });
  }

  createCubeLayer(init: XRGPUCubeLayerInit): XRCubeLayer {
    const layerInit = readLayerInit(init);
    const orientation = init.orientation ?? null;
    if (orientation !== null && !(orientation instanceof DOMPointReadOnly)) {
      throw new TypeError(
        'A cube layer orientation must be a DOMPointReadOnly.',
      );
    }
    this.validateLayerCreation();
    checkLayerSpace(this[P_GPU_BINDING].session, layerInit.space, true);
    if (layerInit.layout !== 'mono' && layerInit.layout !== 'stereo') {
      throw new TypeError(
        'Cube layers must use the "mono" or "stereo" layout.',
      );
    }
    if (layerInit.viewPixelWidth !== layerInit.viewPixelHeight) {
      throw new TypeError('Cube layer faces must be square.');
    }
    const { session, compositionInit } = this.initializeLayer(
      layerInit,
      [
        layerInit.viewPixelWidth,
        layerInit.viewPixelHeight,
        layerInit.layout === 'mono' ? 6 : 12,
      ],
      'XRCubeLayer',
      'cube',
    );
    return new XRCubeLayer(session, compositionInit, {
      space: layerInit.space,
      onredraw: null,
      orientation: DOMPointReadOnly.fromPoint(
        orientation ?? { x: 0, y: 0, z: 0, w: 1 },
      ),
    });
  }

  getSubImage(
    layer: XRCompositionLayer,
    frame: XRFrame,
    eye: XREye = XREye.None,
  ): XRGPUSubImage {
    if (![XREye.None, XREye.Left, XREye.Right].includes(eye)) {
      throw new TypeError(`Unknown eye '${eye}'.`);
    }
    if (
      !this[P_GPU_BINDING].session[P_SESSION].enabledFeatures.includes('layers')
    ) {
      throw notSupported("getSubImage requires the 'layers' feature.");
    }
    this.validateSubImage(layer, frame);
    if (layer instanceof XRProjectionLayer) {
      throw new TypeError('Use getViewSubImage for projection layers.');
    }
    const eyeIndex = eye === XREye.Right ? 1 : 0;
    const { layout, textures } = layer[P_COMPOSITION_LAYER];
    if (layout !== 'mono' && eye === XREye.None) {
      throw new TypeError(`A "${layout}" layer needs an eye.`);
    }
    const current = textures.acquire(frame);
    const [width, height] = textures.descriptors.color.size as number[];
    let viewport = new XRViewport(0, 0, width, height);
    if (layout === 'stereo-left-right') {
      viewport = new XRViewport((width / 2) * eyeIndex, 0, width / 2, height);
    } else if (layout === 'stereo-top-bottom') {
      viewport = new XRViewport(0, (height / 2) * eyeIndex, width, height / 2);
    }
    const arrayLayerIndex =
      layout !== 'stereo'
        ? 0
        : layer instanceof XRCubeLayer
          ? eyeIndex * 6
          : eyeIndex;
    return new XRGPUSubImage(
      viewport,
      current.color,
      current.depthStencil,
      null,
      arrayLayerIndex,
    );
  }

  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRGPUSubImage {
    if (!(layer instanceof XRProjectionLayer)) {
      throw new TypeError('getViewSubImage needs an XRProjectionLayer.');
    }
    const { session } = this[P_GPU_BINDING];
    if (view[P_VIEW].session !== session) {
      throw invalidState("View's session differs from the binding's session.");
    }
    // IWER's views don't keep their frame; they're only valid in the active one.
    const frame = session[P_SESSION].activeFrame;
    this.validateSubImage(layer, frame);
    const { textures } = layer[P_COMPOSITION_LAYER];
    const current = textures.acquire(frame!);
    const index = arrayLayer(view[P_VIEW].eye);
    // Like XRWebGLLayer.getViewport: a requested scale takes effect on the
    // first subimage of the view in a frame, then holds for that frame.
    const viewportScale = session[P_SESSION].viewportScales.get(
      view[P_VIEW].eye,
    )!;
    if (
      viewportScale.modifiable &&
      viewportScale.requested !== viewportScale.current
    ) {
      viewportScale.current = viewportScale.requested;
    }
    viewportScale.modifiable = false;
    const scale = viewportScale.current;
    layer[P_PROJECTION_LAYER].frameViewportScales[index] = scale;
    const [width, height] = textures.descriptors.color.size as number[];
    return new XRGPUSubImage(
      new XRViewport(
        0,
        0,
        Math.max(1, Math.floor(width * scale)),
        Math.max(1, Math.floor(height * scale)),
      ),
      current.color,
      current.depthStencil,
      current.motionVector,
      index,
    );
  }

  // "Validate WebGPU layer creation".
  private validateLayerCreation(): void {
    const { session, device } = this[P_GPU_BINDING];
    if (session[P_SESSION].ended) {
      throw invalidState('XRSession has already ended.');
    }
    if (lostDevices.has(device)) {
      throw invalidState('GPUDevice is lost.');
    }
    if (!session[P_SESSION].enabledFeatures.includes('layers')) {
      throw notSupported("Creating this layer requires the 'layers' feature.");
    }
  }

  // "Initialize a WebGPU-backed layer", up to its texture descriptors.
  private initializeLayer(
    init: LayerInit,
    [width, height, arrayLayerCount]: readonly [number, number, number],
    label: string,
    viewDimension: 'cube' | '2d-array' = '2d-array',
  ) {
    const { session, device } = this[P_GPU_BINDING];
    if (width === 0 || height === 0) {
      throw new TypeError('viewPixelWidth and viewPixelHeight must not be 0.');
    }
    if (!COLOR_FORMATS.includes(init.colorFormat)) {
      throw notSupported(`Unsupported colorFormat '${init.colorFormat}'.`);
    }
    if (
      init.depthStencilFormat !== undefined &&
      !DEPTH_STENCIL_FORMATS.includes(init.depthStencilFormat)
    ) {
      throw notSupported(
        `Unsupported depthStencilFormat '${init.depthStencilFormat}'.`,
      );
    }
    if (init.mipLevels < 1) {
      throw invalidState('mipLevels must be at least 1.');
    }
    const mipLevelCount = Math.min(
      init.mipLevels,
      Math.floor(Math.log2(Math.max(width, height))) + 1,
    );
    const color = createDescriptor(
      device,
      `${label} color`,
      width,
      height,
      arrayLayerCount,
      mipLevelCount,
      init.colorFormat,
      init.textureUsage,
    );
    const depthStencil =
      init.depthStencilFormat !== undefined
        ? createDescriptor(
            device,
            `${label} depth/stencil`,
            width,
            height,
            arrayLayerCount,
            mipLevelCount,
            init.depthStencilFormat,
            init.textureUsage,
          )
        : null;
    checkLayerSpace(session, init.space, false);
    return {
      session,
      compositionInit: {
        layout: init.layout,
        isStatic: init.isStatic,
        mipLevels: mipLevelCount,
        textures: new GPULayerTextures(
          device,
          { color, depthStencil, motionVector: null },
          false,
          viewDimension,
        ),
      },
    };
  }

  // "Validate WebGPU subimage creation".
  private validateSubImage(
    layer: XRCompositionLayer,
    frame: XRFrame | null | undefined,
  ): asserts frame is XRFrame {
    const { session, device } = this[P_GPU_BINDING];
    if (!(layer instanceof XRCompositionLayer)) {
      throw invalidState('The layer is not a WebGPU layer.');
    }
    const state = layer[P_COMPOSITION_LAYER];
    if (state.destroyed) {
      throw invalidState('The layer has been destroyed.');
    }
    if (state.session !== session) {
      throw invalidState("The layer's session differs from the binding's.");
    }
    if (state.textures.device !== device) {
      throw invalidState('The layer was created with a different GPUDevice.');
    }
    if (lostDevices.has(device)) {
      throw invalidState('GPUDevice is lost.');
    }
    if (!frame || frame[P_FRAME].session !== session) {
      throw invalidState('The frame belongs to a different XRSession.');
    }
    if (!frame[P_FRAME].active || !frame[P_FRAME].animationFrame) {
      throw invalidState(
        'Subimages are only available during an XRFrame callback.',
      );
    }
    if (!session[P_SESSION].renderState.layers?.includes(layer)) {
      throw new TypeError(
        "The layer is not in the session's renderState.layers.",
      );
    }
    if (state.isStatic && !state.needsRedraw) {
      throw invalidState(
        'A static layer can only be drawn while needsRedraw is true.',
      );
    }
  }

  getDepthInformation(view: XRView): XRGPUDepthInformation | null {
    const { session, device, depthTextures } = this[P_GPU_BINDING];
    if (view[P_VIEW].session !== session) {
      throw new DOMException(
        "View's session differs from the binding's session.",
        'InvalidStateError',
      );
    }
    if (!session[P_SESSION].enabledFeatures.includes('depth-sensing')) {
      throw new DOMException(
        'depth-sensing feature is not enabled on this session.',
        'NotSupportedError',
      );
    }
    if (session[P_SESSION].depthSensingUsage !== 'gpu-optimized') {
      throw new DOMException(
        'getDepthInformation on XRGPUBinding requires gpu-optimized depth sensing usage.',
        'InvalidStateError',
      );
    }
    if (lostDevices.has(device)) {
      throw new DOMException('GPUDevice is lost.', 'InvalidStateError');
    }
    const frame = session[P_SESSION].activeFrame;
    if (!frame?.[P_FRAME].active || !frame[P_FRAME].animationFrame) {
      throw new DOMException(
        'getDepthInformation must be called during an XRFrame callback.',
        'InvalidStateError',
      );
    }

    const depthData = frame[P_FRAME].webgpuDepthDataMap;
    const viewDepth = depthData.get(view[P_VIEW].eye);
    if (!viewDepth) {
      return null;
    }
    let texture = depthTextures.get(frame);
    if (!texture) {
      // 'unsigned-short' depth is 16-bit millimeters, 'float32' is meters.
      const unsignedShort =
        session[P_SESSION].depthSensingDataFormat === 'unsigned-short';
      texture = device.createTexture({
        label: 'XRGPUDepthInformation',
        size: [viewDepth.width, viewDepth.height, VIEW_COUNT],
        format: unsignedShort ? 'r16uint' : 'r32float',
        usage: TEXTURE_BINDING | COPY_DST,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
      });
      // Linear depth, rows from the top like normalized view coordinates.
      for (const [eye, { data, width, height }] of depthData) {
        device.queue.writeTexture(
          { texture, origin: [0, 0, arrayLayer(eye)] },
          data,
          {
            bytesPerRow: width * (unsignedShort ? 2 : 4),
            rowsPerImage: height,
          },
          [width, height, 1],
        );
      }
      depthTextures.set(frame, texture);
      frame[P_FRAME].webgpuDepthTextures.push(texture);
    }
    return new XRGPUDepthInformation(
      texture,
      viewDepth.width,
      viewDepth.height,
      viewDepth.rawValueToMeters,
      arrayLayer(view[P_VIEW].eye),
    );
  }
}
