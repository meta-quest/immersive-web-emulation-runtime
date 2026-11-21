/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

import { P_FRAME, P_VIEW } from '../private.js';
import type {
  XRDepthDataFormat,
  XRDepthStateInit,
  XRDepthUsage,
} from '../depth/XRDepthInformation.js';
import { XRWebGLDepthInformation } from '../depth/XRWebGLBinding.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import {
  XRRigidTransform,
  overwriteTransformMatrix,
} from '../primitives/XRRigidTransform.js';
import { XREye, XRView } from '../views/XRView.js';
import { invertAffine, multiplyInto } from './affine.js';
import { HOST_VIEW_STRIDE, hostPerspective, hostPoseMatrix } from './math.js';
import type { XRHostDepth, XRHostDepthSupport } from './types.js';
import type { XRHostViews } from './views.js';

/** XRHostBackend.reprojectDepth: the depth laid out in the render views, or null. */
export type XRHostDepthReprojector = (
  depth: XRHostDepth,
  matrices: Float32Array,
) => WebGLTexture | null;

// FOV angles sit after position (3) and orientation (4) in each view record
const FOV_OFFSET = 7;

/** What a session got from the host's depth sensing. */
export interface XRHostDepthChoice {
  usage: XRDepthUsage;
  dataFormat: XRDepthDataFormat;
}

/** The first preference the host offers; the host's own first for no preference. */
function pick<T>(
  preference: readonly T[] | undefined,
  offered: readonly T[],
): T | null {
  if (!preference || preference.length === 0) {
    return offered.length > 0 ? offered[0] : null;
  }
  for (const wanted of preference) {
    if (offered.includes(wanted)) {
      return wanted;
    }
  }
  return null;
}

/**
 * WebXR Depth Sensing's choice of usage and data format for a session that
 * asks for 'depth-sensing': the first of the page's preferences the host
 * offers, or null when either list has no match (the feature is then not
 * supported for the session).
 */
export function negotiateHostDepth(
  init: Partial<XRDepthStateInit> | undefined,
  support: XRHostDepthSupport,
): XRHostDepthChoice | null {
  const usage = pick(init?.usagePreference, support.usages);
  const dataFormat = pick(init?.dataFormatPreference, support.dataFormats);
  return usage !== null && dataFormat !== null ? { usage, dataFormat } : null;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type DepthInfo = Writable<XRWebGLDepthInformation>;

const renderInverse = mat4.create();
const depthWorld = mat4.create();
const placed = mat4.create();
const depthProjection = mat4.create();
const clipToWorld = mat4.create();
const matched = new Float32Array(32);
const IDENTITY = mat4.create();

/**
 * GPU depth for a host session (WebXR Depth Sensing, 'gpu-optimized'), fed
 * from `XRHostBackend.getDepth`. Each visible frame the host's depth becomes
 * one `XRWebGLDepthInformation` per eye in `frame.gpuDepthDataMap`, which
 * `XRWebGLBinding.getDepthInformation` reads, with the eye's layer as
 * `imageIndex`:
 * - `matchDepthView` (the default) and a host that reprojects: the depth
 *   laid out in the eye's render view (`XRHostBackend.reprojectDepth`, as
 *   Quest Browser 156 does), with the view's own projection and pose. Pages
 *   that sample depth by screen position (IWSDK) need this: the depth image
 *   comes from an earlier head pose, at its own rate;
 * - otherwise the host's image, and the depth view's projection and pose
 *   (relative to the eye's render view).
 * `placeTransform` puts the pose in the space of the view the page asks with.
 *
 * The objects are reused: two per eye, alternating with the frame id, so a
 * page that compares a result with the next frame's still reads the values
 * it was given, and steady frames allocate nothing.
 */
export class XRHostDepthSensing {
  // index: eye (0 left, 1 right) * 2 + frame parity
  private readonly infos: (DepthInfo | null)[] = [null, null, null, null];
  /** Each object's depth view pose relative to its eye's render view. */
  private readonly relative: mat4[] = [
    mat4.create(),
    mat4.create(),
    mat4.create(),
    mat4.create(),
  ];

  /**
   * Fills `frame.gpuDepthDataMap` from the host's depth, or empties it.
   * `reproject`: the host's reprojection when the session matches the depth
   * to its render views.
   */
  sync(
    frame: XRFrame,
    frameId: number,
    depth: XRHostDepth | null | undefined,
    views: XRHostViews,
    reproject?: XRHostDepthReprojector,
  ): void {
    const map = frame[P_FRAME].gpuDepthDataMap;
    map.clear();
    if (!depth || !depth.texture) {
      return;
    }
    const count = Math.min(depth.viewCount | 0, views.count, 2);
    const parity = frameId & 1;
    let texture: WebGLTexture | null = null;
    if (reproject) {
      // per view: render clip -> render view -> base space -> depth view -> depth clip
      for (let view = 0; view < count; view++) {
        const at = view * HOST_VIEW_STRIDE;
        const fov = at + FOV_OFFSET;
        hostPerspective(
          depthProjection,
          depth.views[fov],
          depth.views[fov + 1],
          depth.views[fov + 2],
          depth.views[fov + 3],
          depth.depthNear,
          depth.depthFar,
        );
        hostPoseMatrix(depthWorld, depth.views, at);
        invertAffine(renderInverse, depthWorld);
        if (
          !mat4.invert(clipToWorld, views.projection[view] as unknown as mat4)
        ) {
          continue;
        }
        mat4.multiply(clipToWorld, views.world[view], clipToWorld);
        mat4.multiply(clipToWorld, renderInverse, clipToWorld);
        mat4.multiply(clipToWorld, depthProjection, clipToWorld);
        matched.set(clipToWorld, view * 16);
      }
      texture = reproject(depth, matched);
    }
    for (let view = 0; view < count; view++) {
      const slot = view * 2 + parity;
      const info = this.infoAt(slot, depth, view, texture);
      if (texture) {
        // laid out in the render view: its projection and pose
        (info.projectionMatrix as Float32Array).set(views.projection[view]);
        mat4.copy(this.relative[slot], IDENTITY);
      } else {
        const at = view * HOST_VIEW_STRIDE;
        const fov = at + FOV_OFFSET;
        hostPerspective(
          info.projectionMatrix as unknown as mat4,
          depth.views[fov],
          depth.views[fov + 1],
          depth.views[fov + 2],
          depth.views[fov + 3],
          info.depthNear,
          info.depthFar,
        );
        hostPoseMatrix(depthWorld, depth.views, at);
        invertAffine(renderInverse, views.world[view]);
        multiplyInto(this.relative[slot], 0, renderInverse, depthWorld);
      }
      map.set(view === 0 ? XREye.Left : XREye.Right, info);
      if (count === 1) {
        map.set(XREye.None, info);
      }
    }
  }

  /**
   * Writes `info.transform`: the depth view's pose in the space of `view`'s
   * own transform (its reference space), from the render view's pose there.
   */
  placeTransform(info: XRWebGLDepthInformation, view: XRView): void {
    const slot = this.infos.indexOf(info as DepthInfo);
    if (slot < 0 || !info.transform) {
      return;
    }
    multiplyInto(
      placed,
      0,
      view[P_VIEW].transform.matrix as unknown as mat4,
      this.relative[slot],
    );
    overwriteTransformMatrix(info.transform, placed);
  }

  /** The reusable object of `slot`, brought up to date with `depth` (and its reprojected `texture`). */
  private infoAt(
    slot: number,
    depth: XRHostDepth,
    view: number,
    texture: WebGLTexture | null,
  ): DepthInfo {
    let info = this.infos[slot];
    if (!info) {
      info = new XRWebGLDepthInformation(
        texture ?? depth.texture,
        depth.width,
        depth.height,
        new XRRigidTransform(),
        depth.rawValueToMeters,
        depth.depthNear,
        depth.depthFar,
        'texture-array',
        view,
        new Float32Array(16),
        new XRRigidTransform(),
      ) as DepthInfo;
      this.infos[slot] = info;
      return info;
    }
    info.texture = texture ?? depth.texture;
    info.width = depth.width;
    info.height = depth.height;
    info.rawValueToMeters = depth.rawValueToMeters;
    info.depthNear = depth.depthNear;
    info.depthFar = depth.depthFar;
    return info;
  }
}
