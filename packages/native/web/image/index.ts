/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// web/image: HTMLImageElement / Image, ImageData, ImageBitmap, createImageBitmap over the native image module.
// Spec IDs: IMG-1..IMG-7, NET-12 (data: images), NET-14/15 (blob: images), GL-16/GL-17 (source protocol), WRK-5
// (ImageBitmap/ImageData clone + transfer hooks).

export {
  installImage,
  IMAGE_REGISTRY_KEY,
  type ImageRegistry,
  type InstallImageOptions,
} from './install.ts';
export {
  createImageEnv,
  type ImageEnv,
  type ImageEnvOverrides,
} from './env.ts';
export { ImageData, cloneImageData } from './image-data.ts';
export {
  ImageBitmap,
  wrapBitmap,
  bitmapHandle,
  isImageBitmap,
  cloneBitmap,
  transferBitmap,
  exportBitmap,
  importBitmap,
} from './image-bitmap.ts';
export {
  defineImageElement,
  imageElementHandle,
  isImageElement,
} from './html-image-element.ts';
export { makeCreateImageBitmap } from './create-image-bitmap.ts';
export { loadImageBytes, parseDataURL, forgivingBase64 } from './load.ts';
export {
  IMAGE_SOURCE,
  isImageSourceProvider,
  type ImageSourceDescriptor,
  type HandleDescriptor,
  type PixelsDescriptor,
  type ImageSourceProvider,
  type ImageSourceOrigin,
} from './source.ts';
export { getImageSource } from './tex-source.ts';
export type {
  ImageNatives,
  NativeImageHandle,
  NativeProcessOptions,
  NativeImageErrorCode,
} from './natives.ts';
