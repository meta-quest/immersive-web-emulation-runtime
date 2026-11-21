/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Entry point for consumers of TexImageSource / CanvasImageSource (web/webgl's texImage2D/texSubImage2D, the canvas
// stream's drawImage/createPattern): validates the source as WebGL 2.0 §5.14.8/GL-17 and HTML drawImage require and
// returns the pixel descriptor. Contract: runtime/image/INTEROP.md.

import {
  type ImageSourceDescriptor,
  isImageSourceProvider,
  isVideoLike,
  IMAGE_SOURCE,
} from './source.ts';

/**
 * Returns the source's pixels or throws:
 *  - TypeError for video sources that are not image sources (only a <video> playing a camera stream is one) and for
 *    values that are not image sources;
 *  - DOMException InvalidStateError (from the source) for a closed ImageBitmap, an image that is not loaded or is
 *    broken, or a detached ImageData.
 * `api` names the calling method for error messages, e.g. "texImage2D" on "WebGL2RenderingContext".
 */
export function getImageSource(
  source: unknown,
  api = 'texImage2D',
): ImageSourceDescriptor {
  if (isVideoLike(source)) {
    throw new TypeError(
      `Failed to execute '${api}': video sources are not supported by this runtime.`,
    );
  }
  if (!isImageSourceProvider(source)) {
    throw new TypeError(
      `Failed to execute '${api}': The provided value is not an image source.`,
    );
  }
  return source[IMAGE_SOURCE]();
}
