/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRViewport } from '../views/XRViewport.js';

type GL = WebGLRenderingContext | WebGL2RenderingContext;

// WebGL enums, spelled out because the context may be a WebGL1 context or a
// host binding without every constant on it
const FRAMEBUFFER = 0x8d40;
const DRAW_FRAMEBUFFER = 0x8ca9;
const FRAMEBUFFER_BINDING = 0x8ca6; // same value as DRAW_FRAMEBUFFER_BINDING
const RENDERBUFFER = 0x8d41;
const RENDERBUFFER_BINDING = 0x8ca7;
const COLOR_ATTACHMENT0 = 0x8ce0;
const DEPTH_ATTACHMENT = 0x8d00;
const DEPTH_STENCIL_ATTACHMENT = 0x821a;
const TEXTURE_2D = 0x0de1;
const DEPTH_COMPONENT24 = 0x81a6;
const DEPTH24_STENCIL8 = 0x88f0;

/**
 * Whether `gl` is a WebGL2 context, so DRAW_FRAMEBUFFER can be bound on its
 * own. Hosts may hand in a binding object that is not a real
 * WebGL2RenderingContext, so WebGL2-only members count as well; the presence
 * of one optional method (invalidateFramebuffer) is not enough on its own.
 */
function isWebGL2(gl: GL): boolean {
  if (
    typeof WebGL2RenderingContext !== 'undefined' &&
    gl instanceof WebGL2RenderingContext
  ) {
    return true;
  }
  const members = gl as unknown as Record<string, unknown>;
  return (
    members.DRAW_FRAMEBUFFER === DRAW_FRAMEBUFFER ||
    typeof members.blitFramebuffer === 'function' ||
    typeof members.invalidateFramebuffer === 'function'
  );
}

export interface XRHostLayerTargetOptions {
  width: number;
  height: number;
  depth: boolean;
  stencil: boolean;
  /** Discard depth at the end of each frame (needs invalidateFramebuffer). */
  discardDepth: boolean;
  /** Turns a swapchain image's GL name into a WebGLTexture. */
  wrapTexture: (name: number) => WebGLTexture | null;
}

/**
 * The framebuffer behind an `XRWebGLLayer` in host mode.
 *
 * The layer owns one framebuffer the size of the host's side-by-side
 * swapchain image, plus depth (and stencil) storage of its own. Every
 * visible frame its colour attachment is moved to the image the host
 * acquired for that frame.
 *
 * three.js keeps its own record of which framebuffer is bound and skips
 * `bindFramebuffer` calls that would not change it, so IWER must leave the
 * page's bindings exactly as it found them. On WebGL2 it only touches the
 * DRAW_FRAMEBUFFER binding (the READ binding is never disturbed) and puts
 * that back afterwards; on WebGL1 it does the same with FRAMEBUFFER.
 */
export class XRHostLayerTarget {
  readonly framebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
  /** [left, right]: the left eye gets floor(width / 2) columns, the right the rest. */
  readonly viewports: [XRViewport, XRViewport];
  private readonly gl: GL;
  private readonly wrapTexture: (name: number) => WebGLTexture | null;
  private readonly target: number;
  // what to discard after the last draw of a frame; allocated once
  private readonly discardList: number[] | null = null;
  private readonly wrappers = new Map<number, WebGLTexture | null>();
  private attached: WebGLTexture | null | undefined = undefined;

  constructor(gl: GL, options: XRHostLayerTargetOptions) {
    this.gl = gl;
    this.wrapTexture = options.wrapTexture;
    this.width = options.width;
    this.height = options.height;
    const leftWidth = Math.floor(options.width / 2);
    this.viewports = [
      new XRViewport(0, 0, leftWidth, options.height),
      new XRViewport(leftWidth, 0, options.width - leftWidth, options.height),
    ];
    const webgl2 = isWebGL2(gl);
    this.target = webgl2 ? DRAW_FRAMEBUFFER : FRAMEBUFFER;
    this.framebuffer = gl.createFramebuffer();

    if (options.depth || options.stencil) {
      const attachment = options.stencil
        ? DEPTH_STENCIL_ATTACHMENT
        : DEPTH_ATTACHMENT;
      const storage = gl.createRenderbuffer();
      const previousRenderbuffer = gl.getParameter(RENDERBUFFER_BINDING);
      gl.bindRenderbuffer(RENDERBUFFER, storage);
      gl.renderbufferStorage(
        RENDERBUFFER,
        options.stencil ? DEPTH24_STENCIL8 : DEPTH_COMPONENT24,
        options.width,
        options.height,
      );
      gl.bindRenderbuffer(RENDERBUFFER, previousRenderbuffer);
      const pageBinding = this.bindOwn();
      gl.framebufferRenderbuffer(
        this.target,
        attachment,
        RENDERBUFFER,
        storage,
      );
      this.restore(pageBinding);
      if (
        options.discardDepth &&
        webgl2 &&
        typeof (gl as WebGL2RenderingContext).invalidateFramebuffer ===
          'function'
      ) {
        this.discardList = [attachment];
      }
    }
  }

  /** Binds the layer's framebuffer and returns the page's binding. */
  private bindOwn(): WebGLFramebuffer | null {
    const pageBinding = this.gl.getParameter(FRAMEBUFFER_BINDING);
    this.gl.bindFramebuffer(this.target, this.framebuffer);
    return pageBinding;
  }

  private restore(pageBinding: WebGLFramebuffer | null): void {
    this.gl.bindFramebuffer(this.target, pageBinding);
  }

  /** Before the frame's callbacks: render into swapchain image `name`. */
  beginFrame(name: number): void {
    let texture = this.wrappers.get(name);
    if (texture === undefined) {
      texture = this.wrapTexture(name);
      this.wrappers.set(name, texture);
    }
    if (texture === this.attached) {
      return;
    }
    this.attached = texture;
    const pageBinding = this.bindOwn();
    this.gl.framebufferTexture2D(
      this.target,
      COLOR_ATTACHMENT0,
      TEXTURE_2D,
      texture,
      0,
    );
    this.restore(pageBinding);
  }

  /**
   * After the frame's last draw. The layer reports `ignoreDepthValues`, so
   * the host never hands its depth to the compositor; OpenGL ES 3.0's
   * glInvalidateFramebuffer lets the driver treat that content as undefined
   * and skip writing it back to memory, which saves bandwidth on tiled GPUs.
   * Colour is never discarded: the compositor reads it.
   */
  endFrame(): void {
    const list = this.discardList;
    if (list === null) {
      return;
    }
    const pageBinding = this.bindOwn();
    (this.gl as WebGL2RenderingContext).invalidateFramebuffer(
      this.target,
      list,
    );
    this.restore(pageBinding);
  }
}
