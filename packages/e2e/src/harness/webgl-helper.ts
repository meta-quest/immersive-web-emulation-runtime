/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Creates a WebGL2 rendering context suitable for XR.
 * Returns both the canvas and context so tests can use them.
 */
export function createWebGLContext(): {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
} {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  document.body.appendChild(canvas);

  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  if (!gl) {
    throw new Error(
      'WebGL2 not available. Tests require a WebGL2-capable environment.',
    );
  }
  return { canvas, gl };
}

/**
 * Make a WebGL context XR-compatible.
 */
export async function makeXRCompatible(
  gl: WebGL2RenderingContext,
): Promise<void> {
  await (gl as any).makeXRCompatible();
}

/**
 * Clean up a canvas created by createWebGLContext.
 */
export function destroyWebGLContext(canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext('webgl2');
  if (gl) {
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) {
      ext.loseContext();
    }
  }
  canvas.remove();
}
