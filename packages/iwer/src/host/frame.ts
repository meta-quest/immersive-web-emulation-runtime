/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

import {
  P_FRAME,
  P_JOINT_POSE,
  P_JOINT_SPACE,
  P_SESSION,
  P_VIEW,
  P_VIEWER_POSE,
} from '../private.js';
import { overwriteTransformMatrix } from '../primitives/XRRigidTransform.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSpace, XRSpaceUtils } from '../spaces/XRSpace.js';
import { XREye, XRView } from '../views/XRView.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { XRJointPose } from '../pose/XRJointPose.js';
import type { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRPose } from '../pose/XRPose.js';
import type { XRReferenceSpace } from '../spaces/XRReferenceSpace.js';
import { XRViewerPose } from '../pose/XRViewerPose.js';

/*
 * XRFrame pose queries for host mode.
 *
 * Goal: a page that asks for the same poses every frame causes no
 * allocation, while every result object stays a faithful snapshot for as
 * long as a page can reasonably compare it with newer data.
 *
 * Each (space, base space) combination owns a ledger. A ledger remembers the
 * answer it gave for the latest frame id (so repeated questions within a
 * frame get the very same object, or null again) and keeps a small stock of
 * pose objects, each stamped with the frame id it was last written in. A
 * pose stamped in frame F is only rewritten from frame F + 2 on: a page that
 * keeps a result and compares it inside the next frame's callbacks still
 * reads the values it was given. A page that queries every frame therefore
 * settles on two pose objects per ledger; one that queries less often needs
 * one.
 */

/** A reusable result object and the frame id it was last written in. */
type Stocked<T> = { pose: T; writtenIn: number };

type Ledger<T> = {
  answeredFrame: number;
  answer: T | null;
  stock: Stocked<T>[];
};

/*
 * Ledgers are filed by located space, then by base space, both weakly: an
 * engine that changes its reference space (a teleport, or a new offset space
 * every frame for smooth locomotion) leaves the old base's ledger to the
 * garbage collector along with that base, and finding a ledger costs the
 * same however many bases a space has been located against.
 */
type Book<T> = WeakMap<XRSpace, WeakMap<XRSpace, Ledger<T>>>;

const poseLedgers: Book<XRPose> = new WeakMap();
const jointLedgers: Book<XRJointPose> = new WeakMap();
const viewerLedgers: Book<XRViewerPose> = new WeakMap();

function ledgerOf<T>(book: Book<T>, space: XRSpace, base: XRSpace): Ledger<T> {
  let byBase = book.get(space);
  if (byBase === undefined) {
    byBase = new WeakMap();
    book.set(space, byBase);
  }
  let ledger = byBase.get(base);
  if (ledger === undefined) {
    ledger = { answeredFrame: -1, answer: null, stock: [] };
    byBase.set(base, ledger);
  }
  return ledger;
}

/**
 * A stocked pose that may be rewritten in `frameId`, or null when every
 * stocked pose is still protected (the caller then makes a new one).
 * `fits` lets the viewer pose reject objects built for another view count.
 */
function reusable<T>(
  ledger: Ledger<T>,
  frameId: number,
  fits?: (pose: T) => boolean,
): Stocked<T> | null {
  const stock = ledger.stock;
  for (let i = 0; i < stock.length; i++) {
    const entry = stock[i];
    if (entry.writtenIn <= frameId - 2 && (!fits || fits(entry.pose))) {
      return entry;
    }
  }
  return null;
}

// Scratch matrices. Each query fully uses them before returning.
const spaceWorld = mat4.create();
const baseWorld = mat4.create();
const worldToBase = mat4.create();
const located = mat4.create();

/**
 * Loads `worldToBase` with the inverse of the base space's world matrix.
 * False when the base (or one of its ancestors) is untracked or singular.
 */
function prepareBase(base: XRSpace): boolean {
  return (
    XRSpaceUtils.calculateTrackedGlobalOffsetMatrix(base, baseWorld) &&
    mat4.invert(worldToBase, baseWorld) !== null
  );
}

/**
 * `located` = the space's pose in the base space, assuming `prepareBase`
 * succeeded. False when the space (or an ancestor) is untracked.
 */
function locateIn(space: XRSpace): boolean {
  if (!XRSpaceUtils.calculateTrackedGlobalOffsetMatrix(space, spaceWorld)) {
    return false;
  }
  mat4.multiply(located, worldToBase, spaceWorld);
  return true;
}

export function hostGetPose(
  frame: XRFrame,
  space: XRSpace,
  baseSpace: XRSpace,
): XRPose | null {
  const frameId = frame[P_FRAME].id;
  const ledger = ledgerOf(poseLedgers, space, baseSpace);
  if (ledger.answeredFrame === frameId) {
    return ledger.answer;
  }
  ledger.answeredFrame = frameId;
  ledger.answer = null;
  if (!prepareBase(baseSpace) || !locateIn(space)) {
    return null;
  }
  let entry = reusable(ledger, frameId);
  if (entry === null) {
    entry = { pose: new XRPose(new XRRigidTransform(), false), writtenIn: -1 };
    ledger.stock.push(entry);
  }
  overwriteTransformMatrix(entry.pose.transform, located);
  entry.writtenIn = frameId;
  ledger.answer = entry.pose;
  return entry.pose;
}

export function hostGetJointPose(
  frame: XRFrame,
  joint: XRJointSpace,
  baseSpace: XRSpace,
): XRJointPose | null {
  const frameId = frame[P_FRAME].id;
  const ledger = ledgerOf(jointLedgers, joint, baseSpace);
  if (ledger.answeredFrame === frameId) {
    return ledger.answer;
  }
  ledger.answeredFrame = frameId;
  ledger.answer = null;
  if (!prepareBase(baseSpace) || !locateIn(joint)) {
    return null;
  }
  let entry = reusable(ledger, frameId);
  if (entry === null) {
    entry = {
      pose: new XRJointPose(new XRRigidTransform(), 0, false),
      writtenIn: -1,
    };
    ledger.stock.push(entry);
  }
  overwriteTransformMatrix(entry.pose.transform, located);
  entry.pose[P_JOINT_POSE].radius = joint[P_JOINT_SPACE].radius;
  entry.writtenIn = frameId;
  ledger.answer = entry.pose;
  return entry.pose;
}

/** WebXR XREye values for a frame with `count` views. */
function eyeFor(index: number, count: number): XREye {
  if (count === 1) {
    return XREye.None;
  }
  return index === 0 ? XREye.Left : XREye.Right;
}

export function hostGetViewerPose(
  frame: XRFrame,
  referenceSpace: XRReferenceSpace,
): XRViewerPose | null {
  const session = frame[P_FRAME].session;
  const host = session[P_SESSION].host!;
  const viewerSpace = session[P_SESSION].device.viewerSpace;
  const frameId = frame[P_FRAME].id;
  const viewCount = host.views.count;
  const ledger = ledgerOf(viewerLedgers, referenceSpace, referenceSpace);
  if (
    ledger.answeredFrame === frameId &&
    (ledger.answer === null ||
      ledger.answer[P_VIEWER_POSE].views.length === viewCount)
  ) {
    return ledger.answer;
  }
  ledger.answeredFrame = frameId;
  ledger.answer = null;
  if (!prepareBase(referenceSpace) || !locateIn(viewerSpace)) {
    return null;
  }
  let entry = reusable(
    ledger,
    frameId,
    (pose) => pose[P_VIEWER_POSE].views.length === viewCount,
  );
  if (entry === null) {
    const views: XRView[] = [];
    for (let i = 0; i < viewCount; i++) {
      views.push(
        new XRView(
          eyeFor(i, viewCount),
          host.views.projection[i],
          new XRRigidTransform(),
          session,
        ),
      );
    }
    entry = {
      pose: new XRViewerPose(new XRRigidTransform(), views, false),
      writtenIn: -1,
    };
    ledger.stock.push(entry);
  }
  const pose = entry.pose;
  overwriteTransformMatrix(pose.transform, located);
  // the views are given in the base (global) space; move them into the
  // reference space with the same inverse
  const views = pose[P_VIEWER_POSE].views;
  for (let i = 0; i < viewCount; i++) {
    mat4.multiply(located, worldToBase, host.views.world[i]);
    const viewState = views[i][P_VIEW];
    overwriteTransformMatrix(viewState.transform, located);
    viewState.projectionMatrix = host.views.projection[i];
  }
  entry.writtenIn = frameId;
  ledger.answer = pose;
  return pose;
}

/**
 * `XRFrame.fillPoses` in host mode: 16 numbers per space, column-major, each
 * pose relative to `baseSpace`. A space that cannot be located (or any space,
 * when the base cannot) gets 16 NaNs, and the call then returns false, as
 * HOST-INPUT.md specifies. Allocates nothing.
 */
export function hostFillPoses(
  spaces: readonly XRSpace[],
  baseSpace: XRSpace,
  transforms: Float32Array,
): boolean {
  const baseOk = prepareBase(baseSpace);
  let complete = true;
  for (let i = 0, at = 0; i < spaces.length; i++, at += 16) {
    if (baseOk && locateIn(spaces[i])) {
      transforms.set(located, at);
    } else {
      transforms.fill(NaN, at, at + 16);
      complete = false;
    }
  }
  return complete;
}
