/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  XRHostBackend,
  XRHostSwapchain,
  XRHostSwapchainOptions,
} from './types.js';

/** GL_RGBA8, the sized format three.js also asks for. */
const RGBA8 = 0x8058;

/**
 * Fixed foveation a session starts with when it requests one of Quest
 * Browser's startup foveation features. The levels themselves still need to
 * be confirmed against Quest Browser.
 */
const STARTUP_FOVEATION: ReadonlyArray<readonly [string, number]> = [
  ['high-fixed-foveation-level', 1],
  ['medium-fixed-foveation-level', 2 / 3],
  ['low-fixed-foveation-level', 1 / 3],
];

const NO_BOUNDS: readonly DOMPointReadOnly[] = Object.freeze([]);

/**
 * The stage outline for bounded-floor, worked out once from a swapchain
 * answer: a rectangle of the reported size, centred on the stage origin, on
 * the floor (y = 0). WebXR wants the points clockwise when seen from above.
 * Seen from +y looking down, +x is to the right and -z is up the page, so
 * the order below (back right, back left, front left, front right) goes
 * round clockwise.
 */
function stageOutline(answer: XRHostSwapchain): readonly DOMPointReadOnly[] {
  if (answer.hasStage !== true) {
    return NO_BOUNDS;
  }
  const width = Number(answer.stageWidth);
  const depth = Number(answer.stageDepth);
  if (!(width > 0) || !(depth > 0)) {
    // a stage without a usable area has no outline to report
    return NO_BOUNDS;
  }
  const right = width * 0.5;
  const back = depth * 0.5;
  const corner = (x: number, z: number) => new DOMPointReadOnly(x, 0, z, 1);
  return Object.freeze([
    corner(right, back),
    corner(-right, back),
    corner(-right, -back),
    corner(right, -back),
  ]);
}

/** What the first layer of a session asks for. */
export interface XRHostLayerRequest {
  /** 2 for a texture-array projection layer, 1 for a side-by-side image. */
  arraySize: number;
  /** Requested scale; anything that is not a positive number means 1. */
  scale: unknown;
  /** The layer's colour format, or undefined / 0 for the default. */
  colorFormat: number | undefined;
  /** The page's GL context, consulted for its premultipliedAlpha attribute. */
  context: WebGLRenderingContext | WebGL2RenderingContext | null;
}

/** Session properties that shape the swapchain request. */
export interface XRHostOutputConfig {
  immersiveAR: boolean;
  wantsScene: boolean;
  enabledFeatures: readonly string[];
}

function premultipliesAlpha(
  context: WebGLRenderingContext | WebGL2RenderingContext | null,
): boolean {
  if (!context || typeof context.getContextAttributes !== 'function') {
    return true;
  }
  try {
    const attributes = context.getContextAttributes();
    return !attributes || attributes.premultipliedAlpha !== false;
  } catch {
    return true;
  }
}

/**
 * Everything a host session presents through: the swapchain behind its
 * layers, the fixed foveation level, the passthrough toggle and the stage
 * bounds the swapchain answer describes.
 */
export class XRHostOutput {
  private readonly backend: XRHostBackend;
  private readonly config: XRHostOutputConfig;
  /** Null until the first layer creates it, and again after the session ends. */
  swapchain: XRHostSwapchain | null = null;
  /** Current fixed foveation, 0..1. */
  foveation = 0;
  /** Refresh rates the swapchain answer listed (empty until then). */
  offeredRates: Float32Array = new Float32Array(0);
  /** Refresh rate the swapchain answer reported, 0 if none. */
  initialRate = 0;
  private passthroughVisible = true;
  private colorTexture: WebGLTexture | null = null;
  private colorTextureFetched = false;
  private outline: readonly DOMPointReadOnly[] = NO_BOUNDS;

  constructor(backend: XRHostBackend, config: XRHostOutputConfig) {
    this.backend = backend;
    this.config = config;
  }

  /** The startup foveation the session's features ask for, or null. */
  private startupFoveation(): number | null {
    const features = this.config.enabledFeatures;
    for (const [feature, level] of STARTUP_FOVEATION) {
      if (features.includes(feature)) {
        return level;
      }
    }
    return null;
  }

  /**
   * Returns the session's swapchain, asking the host for it if this is the
   * first layer. A later layer always gets the existing swapchain, even if it
   * would have asked for a different texture type.
   */
  acquire(request: XRHostLayerRequest): XRHostSwapchain {
    if (this.swapchain) {
      if (this.swapchain.arraySize !== request.arraySize) {
        console.warn(
          'IWER host mode: this session already presents through a ' +
            `${this.swapchain.arraySize}-layer swapchain; the new layer ` +
            `(${request.arraySize} layer(s) requested) will share it.`,
        );
      }
      return this.swapchain;
    }

    const scale = Number(request.scale);
    // Colour: three.js renders sRGB-encoded values into whatever format it
    // is given, and asks for RGBA8 itself. Requesting the plain (not _SRGB)
    // RGBA8 format keeps those values untouched on the way to the
    // compositor, which then treats the 8-bit eye buffer as sRGB content.
    const options: XRHostSwapchainOptions = {
      arraySize: request.arraySize,
      scale: scale > 0 ? scale : 1,
      format: request.colorFormat || RGBA8,
    };
    if (this.config.immersiveAR) {
      options.passthrough = true;
      if (!premultipliesAlpha(request.context)) {
        options.unpremultiplied = true;
      }
    }
    if (this.config.wantsScene) {
      options.scene = true;
    }
    const startup = this.startupFoveation();
    if (startup !== null) {
      options.foveation = startup;
    }

    const created = this.backend.beginSwapchain(options);
    if (!created) {
      throw new DOMException(
        'IWER host mode: the host could not create a swapchain for this layer.',
        'OperationError',
      );
    }
    this.swapchain = created;
    this.outline = stageOutline(created);
    if (created.rates && created.rates.length > 0) {
      this.offeredRates = Float32Array.from(created.rates);
    }
    if (created.rate !== undefined && created.rate > 0) {
      this.initialRate = created.rate;
    }
    if (typeof created.foveation === 'number') {
      this.foveation = created.foveation;
    } else if (startup !== null) {
      this.foveation = startup;
    }
    return created;
  }

  /** Sets fixed foveation: clamped to 0..1, NaN treated as 0. */
  setFoveation(level: number): void {
    const value = Number(level);
    const clamped = value > 1 ? 1 : value > 0 ? value : 0;
    this.foveation = clamped;
    this.backend.setFixedFoveation?.(clamped);
  }

  /** The one colour texture projection sub-images report (fetched lazily). */
  opaqueColorTexture(): WebGLTexture | null {
    if (!this.colorTextureFetched) {
      this.colorTextureFetched = true;
      this.colorTexture = this.backend.getOpaqueColorTexture?.() ?? null;
    }
    return this.colorTexture;
  }

  /** immersive-ar: tells the host about a passthrough change, only on change. */
  syncPassthrough(fullyObscured: boolean | undefined): void {
    if (!this.config.immersiveAR) {
      return;
    }
    const visible = fullyObscured !== true;
    if (visible !== this.passthroughVisible) {
      this.passthroughVisible = visible;
      this.backend.setPassthroughVisible?.(visible);
    }
  }

  /** Whether the host said it has no stage (unknown before the first layer). */
  get lacksStage(): boolean {
    return this.swapchain !== null && this.swapchain.hasStage === false;
  }

  /**
   * `boundsGeometry` of bounded-floor (see `stageOutline`). Nothing before
   * the first layer has brought the host's answer, nor after the session;
   * the same frozen array in between.
   */
  stageBounds(): readonly DOMPointReadOnly[] {
    return this.outline;
  }

  /** Forgets the swapchain once the session is over. */
  release(): void {
    this.swapchain = null;
    this.outline = NO_BOUNDS;
  }
}
