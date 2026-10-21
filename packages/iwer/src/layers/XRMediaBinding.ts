/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  P_COMPOSITION_LAYER,
  P_MEDIA_BINDING,
  P_REF_SPACE,
  P_SESSION,
} from '../private.js';
import { XRSession } from '../session/XRSession.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { GPUMediaTextures } from './GPUMediaTextures.js';
import { LAYOUTS, copyTransform, toFloat } from './XRGPUBinding.js';
import {
  XRCylinderLayer,
  XREquirectLayer,
  XRQuadLayer,
  checkLayerSpace,
} from './XRSpaceLayers.js';
import type { XRCompositionLayer, XRLayerLayout } from './XRProjectionLayer.js';
import type { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRSpace } from '../spaces/XRSpace.js';

export interface XRMediaLayerInit {
  space: XRSpace;
  layout?: XRLayerLayout;
  invertStereo?: boolean;
}

export interface XRMediaQuadLayerInit extends XRMediaLayerInit {
  transform?: XRRigidTransform | null;
  width?: number | null;
  height?: number | null;
}

export interface XRMediaCylinderLayerInit extends XRMediaLayerInit {
  transform?: XRRigidTransform | null;
  radius?: number;
  centralAngle?: number;
  aspectRatio?: number | null;
}

export interface XRMediaEquirectLayerInit extends XRMediaLayerInit {
  transform?: XRRigidTransform | null;
  radius?: number;
  centralHorizontalAngle?: number;
  upperVerticalAngle?: number;
  lowerVerticalAngle?: number;
}

const notSupported = (message: string) =>
  new DOMException(message, 'NotSupportedError');
const invalidState = (message: string) =>
  new DOMException(message, 'InvalidStateError');

// A nullable WebIDL float, where null and undefined both mean "not given".
const toOptionalFloat = (value: number | null | undefined) =>
  value === null || value === undefined ? undefined : toFloat(value, 0);

// Converts what every create method takes, before the method's own steps.
const readMediaInit = (video: HTMLVideoElement, init: XRMediaLayerInit) => {
  if (!(video instanceof HTMLVideoElement)) {
    throw new TypeError('Media layers need an HTMLVideoElement.');
  }
  if (init?.space === undefined) {
    throw new TypeError(
      "The media layer init is missing the required 'space'.",
    );
  }
  const layout = init.layout ?? 'mono';
  if (!LAYOUTS.includes(layout)) {
    throw new TypeError(`Unknown layer layout '${layout}'.`);
  }
  return {
    space: init.space,
    layout,
    invertStereo: Boolean(init.invertStereo),
  };
};

type MediaInit = ReturnType<typeof readMediaInit>;

// "Calculate the aspect ratio" of a video shown with a layout.
const aspectRatio = (video: HTMLVideoElement, layout: XRLayerLayout) => {
  let width = video.videoWidth;
  let height = video.videoHeight;
  if (layout === 'stereo-left-right') {
    width /= 2;
  }
  if (layout === 'stereo-top-bottom') {
    height /= 2;
  }
  return width / height;
};

/**
 * Creates layers that show a video, for WebGPU sessions with the 'layers'
 * feature. IWER copies the video's current frame each time it composites.
 */
export class XRMediaBinding {
  [P_MEDIA_BINDING]: { session: XRSession };

  constructor(session: XRSession) {
    if (!(session instanceof XRSession)) {
      throw new TypeError('XRMediaBinding needs an XRSession.');
    }
    if (session[P_SESSION].ended) {
      throw invalidState('XRSession has already ended.');
    }
    if (session[P_SESSION].mode === 'inline') {
      throw invalidState('XRMediaBinding needs an immersive session.');
    }
    this[P_MEDIA_BINDING] = { session };
  }

  createQuadLayer(
    video: HTMLVideoElement,
    init: XRMediaQuadLayerInit = {} as XRMediaQuadLayerInit,
  ): XRQuadLayer {
    const media = readMediaInit(video, init);
    const transform = copyTransform(init.transform);
    let width = toOptionalFloat(init.width);
    let height = toOptionalFloat(init.height);
    const session = this.validateCreation(media);
    const space = checkLayerSpace(session, media.space, false);
    const ratio = aspectRatio(video, media.layout);
    if (width === undefined && height === undefined) {
      width = 1;
    }
    height ??= width! / ratio;
    width ??= height * ratio;
    return mediaLayer(
      new XRQuadLayer(session, compositionInit(video, media), {
        space,
        onredraw: null,
        transform,
        width,
        height,
      }),
    );
  }

  createCylinderLayer(
    video: HTMLVideoElement,
    init: XRMediaCylinderLayerInit = {} as XRMediaCylinderLayerInit,
  ): XRCylinderLayer {
    const media = readMediaInit(video, init);
    const transform = copyTransform(init.transform);
    const radius = toFloat(init.radius, 2.0);
    const centralAngle = toFloat(init.centralAngle, 0.78539);
    const ratio = toOptionalFloat(init.aspectRatio);
    const session = this.validateCreation(media);
    const space = checkLayerSpace(session, media.space, false);
    return mediaLayer(
      new XRCylinderLayer(session, compositionInit(video, media), {
        space,
        onredraw: null,
        transform,
        radius,
        centralAngle,
        aspectRatio: ratio ?? aspectRatio(video, media.layout),
      }),
    );
  }

  createEquirectLayer(
    video: HTMLVideoElement,
    init: XRMediaEquirectLayerInit = {} as XRMediaEquirectLayerInit,
  ): XREquirectLayer {
    const media = readMediaInit(video, init);
    const transform = copyTransform(init.transform);
    const radius = toFloat(init.radius, 0);
    const centralHorizontalAngle = toFloat(
      init.centralHorizontalAngle,
      6.28318,
    );
    const upperVerticalAngle = toFloat(init.upperVerticalAngle, 1.570795);
    const lowerVerticalAngle = toFloat(init.lowerVerticalAngle, -1.570795);
    const session = this.validateCreation(media);
    if (
      !(media.space instanceof XRReferenceSpace) ||
      media.space[P_REF_SPACE].type === XRReferenceSpaceType.Viewer
    ) {
      throw invalidState(
        'Media equirect layers need a reference space other than "viewer".',
      );
    }
    const space = checkLayerSpace(session, media.space, true);
    return mediaLayer(
      new XREquirectLayer(session, compositionInit(video, media), {
        space,
        onredraw: null,
        transform,
        radius,
        centralHorizontalAngle,
        upperVerticalAngle,
        lowerVerticalAngle,
      }),
    );
  }

  // The steps every create method shares once its arguments are converted.
  private validateCreation(media: MediaInit): XRSession {
    const { session } = this[P_MEDIA_BINDING];
    if (!session[P_SESSION].enabledFeatures.includes('layers')) {
      throw notSupported("Media layers need the 'layers' feature.");
    }
    if (session[P_SESSION].ended) {
      throw invalidState('XRSession has already ended.');
    }
    if (media.layout === 'default') {
      throw new TypeError('Media layers cannot use the "default" layout.');
    }
    return session;
  }
}

const compositionInit = (video: HTMLVideoElement, media: MediaInit) => ({
  layout: media.layout,
  isStatic: false,
  mipLevels: 1,
  textures: new GPUMediaTextures(video, media.invertStereo),
});

// Media layers never need the app to draw them.
const mediaLayer = <T extends XRCompositionLayer>(layer: T): T => {
  layer[P_COMPOSITION_LAYER].needsRedraw = false;
  return layer;
};

/**
 * Makes XRMediaBinding IWER's while a WebGPU session with layers runs, and
 * returns a function that puts back what was there before. IWER doesn't keep
 * it defined: the WebXR Layers polyfill, which draws WebGL sessions' layers,
 * only installs itself where XRMediaBinding is missing.
 */
export const defineMediaBinding = (): (() => void) => {
  const global = globalThis as { XRMediaBinding?: unknown };
  const previous = Object.getOwnPropertyDescriptor(global, 'XRMediaBinding');
  global.XRMediaBinding = XRMediaBinding;
  return () => {
    if (global.XRMediaBinding !== XRMediaBinding) {
      return;
    }
    if (previous) {
      Object.defineProperty(global, 'XRMediaBinding', previous);
    } else {
      delete global.XRMediaBinding;
    }
  };
};
