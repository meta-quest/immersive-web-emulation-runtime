/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Installs the image globals (ImageData, ImageBitmap, createImageBitmap, and on window globals HTMLImageElement and
// Image) and publishes the image registry other runtime JS uses: the DOM stand-ins (document.createElement('img')),
// the canvas and WebGL streams (image-source protocol) and workers (ImageBitmap transfer).
// Runs after the web glue (web/glue) so EventTarget, Event, DOMException, Blob and URL exist.

import {
  createImageEnv,
  type ImageEnv,
  type ImageEnvOverrides,
} from './env.ts';
import { makeCreateImageBitmap } from './create-image-bitmap.ts';
import {
  defineImageElement,
  imageElementHandle,
  isImageElement,
} from './html-image-element.ts';
import {
  bitmapHandle,
  cloneBitmap,
  exportBitmap,
  ImageBitmap,
  importBitmap,
  isImageBitmap,
  setImageBitmapErrors,
  transferBitmap,
  wrapBitmap,
} from './image-bitmap.ts';
import { cloneImageData, ImageData, setImageDataErrors } from './image-data.ts';
import type { ImageNatives, NativeImageHandle } from './natives.ts';
import { IMAGE_SOURCE } from './source.ts';
import { getImageSource } from './tex-source.ts';

export const IMAGE_REGISTRY_KEY: unique symbol = Symbol.for(
  'iwn.image',
) as never;

export interface InstallImageOptions extends ImageEnvOverrides {
  /**
   * Worker globals get ImageData, ImageBitmap, createImageBitmap only (WRK-2). Default: true when the global has
   * importScripts or WorkerGlobalScope.
   */
  worker?: boolean;
  /** Base class for HTMLImageElement (default: globalThis.HTMLElement if defined, else EventTarget). */
  Base?: new () => object;
  /** 'missing' keeps globals that already exist; 'all' replaces them. Default 'all'. */
  mode?: 'missing' | 'all';
}

/** Published at globalThis[Symbol.for('iwn.image')]. */
export interface ImageRegistry {
  version: 1;
  env: ImageEnv;
  IMAGE_SOURCE: typeof IMAGE_SOURCE;
  /** For document.createElement('img') / createElementNS(xhtml|svg, 'img'); undefined in workers. */
  createImageElement?: () => object;
  getImageSource: typeof getImageSource;
  wrapBitmap(handle: NativeImageHandle): ImageBitmap;
  bitmapHandle: typeof bitmapHandle;
  imageElementHandle: typeof imageElementHandle;
  isImageBitmap: typeof isImageBitmap;
  isImageElement: typeof isImageElement;
  /** structuredClone / postMessage hooks (WRK-5) for the glue's clone registry and the worker serializer. */
  clone: {
    cloneBitmap: typeof cloneBitmap;
    transferBitmap: typeof transferBitmap;
    exportBitmap: typeof exportBitmap;
    importBitmap(token: { iwnImageBitmap: number }): ImageBitmap;
    cloneImageData: typeof cloneImageData;
  };
}

interface CloneRegistryLike {
  registerCloneable(t: {
    is(v: object): boolean;
    clone(v: object, inner: (v: unknown) => unknown): unknown;
  }): void;
  registerTransferable(t: {
    is(v: object): boolean;
    transfer(v: object): unknown;
  }): void;
}

export function installImage(
  global: typeof globalThis,
  options: InstallImageOptions = {},
): ImageRegistry {
  const env = createImageEnv(global, options);
  setImageDataErrors(env.domException);
  setImageBitmapErrors(env.domException);
  const g = global as unknown as Record<string | symbol, unknown>;
  const mode = options.mode ?? 'all';
  const worker =
    options.worker ??
    (typeof g.importScripts === 'function' ||
      typeof g.WorkerGlobalScope === 'function');
  const def = (name: string, value: unknown) => {
    if (mode === 'missing' && name in g) return;
    Object.defineProperty(global, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  def('ImageData', ImageData);
  def('ImageBitmap', ImageBitmap);
  def('createImageBitmap', makeCreateImageBitmap(env));

  let createImageElement: (() => object) | undefined;
  if (!worker) {
    const Base =
      options.Base ??
      (typeof g.HTMLElement === 'function'
        ? (g.HTMLElement as new () => object)
        : undefined);
    const classes = defineImageElement(env, Base);
    def('HTMLImageElement', classes.HTMLImageElement);
    def('Image', classes.Image);
    createImageElement = classes.createImageElement;
  }

  const natives: ImageNatives = env.natives;
  const registry: ImageRegistry = {
    version: 1,
    env,
    IMAGE_SOURCE,
    createImageElement,
    getImageSource,
    wrapBitmap: (handle) => wrapBitmap(handle, natives),
    bitmapHandle,
    imageElementHandle,
    isImageBitmap,
    isImageElement,
    clone: {
      cloneBitmap,
      transferBitmap,
      exportBitmap,
      importBitmap: (token) => importBitmap(token, natives),
      cloneImageData,
    },
  };

  // Same-realm structuredClone through the glue's registry, when it exposes one.
  const glue = g[Symbol.for('iwn.glue')] as
    | { cloneRegistry?: CloneRegistryLike }
    | undefined;
  if (glue?.cloneRegistry) {
    glue.cloneRegistry.registerCloneable({
      is: (v) => v instanceof ImageData,
      clone: (v) => cloneImageData(v as ImageData),
    });
    glue.cloneRegistry.registerCloneable({
      is: isImageBitmap,
      clone: (v) => cloneBitmap(v as ImageBitmap),
    });
    glue.cloneRegistry.registerTransferable({
      is: isImageBitmap,
      transfer: (v) => transferBitmap(v as ImageBitmap),
    });
  }

  Object.defineProperty(global, IMAGE_REGISTRY_KEY, {
    value: registry,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  return registry;
}
