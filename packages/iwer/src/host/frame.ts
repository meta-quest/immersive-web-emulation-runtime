/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

import { invertAffine, multiplyInto } from './affine.js';

import {
  P_FRAME,
  P_JOINT_POSE,
  P_JOINT_SPACE,
  P_RIGID_TRANSFORM,
  P_SESSION,
  P_SPACE,
  P_VIEW,
  P_VIEWER_POSE,
} from '../private.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRSpace } from '../spaces/XRSpace.js';
import { XREye, XRView } from '../views/XRView.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { XRJointPose } from '../pose/XRJointPose.js';
import type { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRPose } from '../pose/XRPose.js';
import type { XRReferenceSpace } from '../spaces/XRReferenceSpace.js';
import type { XRSession } from '../session/XRSession.js';
import { XRViewerPose } from '../pose/XRViewerPose.js';

/*
 * XRFrame pose queries for host mode.
 *
 * Goals: a page that asks for the same poses every frame allocates nothing
 * and pays for as little matrix work as possible, while every result object
 * stays a faithful snapshot for as long as a page can reasonably compare it
 * with newer data.
 *
 * Matrix work. Poses do not change while a frame's rAF callbacks run: the
 * host writes every space's offset (views, reference spaces, input, planes)
 * before the first callback, and no page-facing API moves an existing space.
 * So each space's world matrix (its pose in IWER's global space) is computed
 * at most once per pose epoch and kept on the space, stamped with the epoch;
 * a base space's inverse world matrix likewise. A query is then one 4x4
 * multiply. The host session starts a new epoch (invalidateHostPoses) when
 * a frame starts and again once input sources have been updated, because
 * input event handlers run during that update. Host-tracked sources are all
 * written before any of their events fire (device/host-input-frame.ts), but
 * emulated ones move their spaces in turn, after earlier sources' handlers
 * may have asked about them; the second epoch keeps such an answer from
 * reaching the rAF callbacks. Epochs never repeat, so a stamp cannot be
 * mistaken for a later one.
 *
 * World matrices are resolved without recursion: a page may derive each
 * offset reference space from the previous one, making parent chains of any
 * depth, and those must keep working (in O(depth) per frame).
 *
 * Result objects. Each space keeps, per result type, a small stock of pose
 * objects, each stamped with the frame id it was last written in, and the
 * answers it gave in the current epoch (base space -> pose or null), so
 * repeated questions within a frame's callbacks get the very same object,
 * or null again. A pose stamped in frame F is only rewritten from frame
 * F + 2 on (an event handler's answer and the callbacks' answer in the same
 * frame are two objects): a page that keeps a result and compares it inside
 * the next frame's callbacks still reads the values it was given. A page that asks about a space
 * against one base every frame therefore settles on two pose objects; one
 * that asks less often needs one; k bases a frame need 2k. Nothing is filed
 * by base beyond the current frame, so a page that makes a new base space
 * every frame (smooth locomotion) neither leaks nor allocates poses.
 */

/**
 * A reusable result object, the internal record of its transform (written
 * directly), and the frame id it was last written in.
 */
type Stocked<T> = {
  pose: T;
  rigid: XRRigidTransform[typeof P_RIGID_TRANSFORM];
  writtenIn: number;
};

function stocked<T extends XRPose>(pose: T): Stocked<T> {
  return { pose, rigid: pose.transform[P_RIGID_TRANSFORM], writtenIn: -1 };
}

/** One space's results of one type: this epoch's answers and the stock. */
class PoseBook<T> {
  /** Pose epoch the answers belong to. */
  epoch = -1;
  /** Base spaces asked about in `epoch`, and the answer for each. */
  readonly bases: (XRSpace | null)[] = [];
  readonly answers: (T | null)[] = [];
  count = 0;
  readonly stock: Stocked<T>[] = [];
}

/**
 * Index of `base` among the book's answers for `epoch`, or -1. Starts a
 * new epoch's answers when the book holds an older epoch's (the arrays keep
 * their length, so steady frames allocate nothing).
 */
function answerIndex<T>(
  book: PoseBook<T>,
  base: XRSpace,
  epoch: number,
): number {
  const count = book.count;
  if (book.epoch !== epoch) {
    for (let i = 0; i < count; i++) {
      book.bases[i] = null;
      book.answers[i] = null;
    }
    book.count = 0;
    book.epoch = epoch;
    return -1;
  }
  const bases = book.bases;
  for (let i = 0; i < count; i++) {
    if (bases[i] === base) {
      return i;
    }
  }
  return -1;
}

/** Records the answer for `base` in the current epoch. */
function recordAnswer<T>(book: PoseBook<T>, base: XRSpace, answer: T | null) {
  const at = book.count++;
  book.bases[at] = base;
  book.answers[at] = answer;
}

/**
 * The viewer pose of one reference space: one answer per epoch. The views
 * belong to a session (XRWebGLLayer.getViewport checks it), and the viewer
 * reference space is shared by every session of a device, so the stock is
 * emptied when another session asks.
 */
class ViewerBook {
  answeredEpoch = -1;
  answer: XRViewerPose | null = null;
  session: XRSession | null = null;
  readonly stock: Stocked<XRViewerPose>[] = [];
}

/**
 * Per-space host-mode state, kept in the space's internal record (made on
 * the first query, so spaces that are never located cost nothing).
 */
class SpacePoseCache {
  /** Pose epoch `world` was computed for. */
  worldEpoch = -1;
  /** False when the space (or an ancestor) is untracked in `worldEpoch`. */
  worldOk = false;
  /** `world` is the identity (a root space that was never moved). */
  worldIsIdentity = false;
  /**
   * The space's world matrix for `worldEpoch`: `own`, or the space's offset
   * matrix itself when its parent's world is the identity (no copy).
   */
  world: mat4;
  readonly own: mat4;
  /** Pose epoch `inverse` was computed for (as a base space). */
  inverseEpoch = -1;
  inverseOk = false;
  readonly inverse = mat4.create();
  /** The parent space and its cache, as last resolved. */
  parent: XRSpace | null = null;
  parentCache: SpacePoseCache | null = null;
  // results of getPose / getJointPose for this space, and of
  // getViewerPose(this reference space); made on first use
  poses: PoseBook<XRPose> | null = null;
  joints: PoseBook<XRJointPose> | null = null;
  viewer: ViewerBook | null = null;

  constructor() {
    this.own = mat4.create();
    this.world = this.own;
  }
}

/** The space record, with the slot XRSpace reserves for this cache. */
type CachedSpaceState = XRSpace[typeof P_SPACE] & {
  hostPose?: SpacePoseCache | null;
};

function cacheOf(space: XRSpace): SpacePoseCache {
  return cacheIn(space[P_SPACE] as CachedSpaceState);
}

function cacheIn(state: CachedSpaceState): SpacePoseCache {
  let cache = state.hostPose;
  if (cache === null || cache === undefined) {
    cache = new SpacePoseCache();
    state.hostPose = cache;
  }
  return cache;
}

/**
 * The first stocked pose that may be rewritten in `frameId`, or null when
 * every stocked pose is still protected (the caller then makes a new one).
 */
function reusable<T>(
  stock: readonly Stocked<T>[],
  frameId: number,
): Stocked<T> | null {
  for (let i = 0; i < stock.length; i++) {
    if (stock[i].writtenIn <= frameId - 2) {
      return stock[i];
    }
  }
  return null;
}

function isIdentity(m: mat4): boolean {
  return (
    m[0] === 1 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[3] === 0 &&
    m[4] === 0 &&
    m[5] === 1 &&
    m[6] === 0 &&
    m[7] === 0 &&
    m[8] === 0 &&
    m[9] === 0 &&
    m[10] === 1 &&
    m[11] === 0 &&
    m[12] === 0 &&
    m[13] === 0 &&
    m[14] === 0 &&
    m[15] === 1
  );
}

/** The current pose epoch (see the header and invalidateHostPoses). */
let poseEpoch = 0;

/**
 * Starts a new pose epoch: every cached world matrix, inverse and answer is
 * recomputed on its next query. The host session calls this whenever spaces
 * may have moved since the last query (see the header).
 */
export function invalidateHostPoses(): void {
  poseEpoch++;
}

/**
 * The space's cache with `world` valid for `epoch`, or null when the space
 * or an ancestor is untracked. Ancestors are resolved (and cached) first.
 */
function worldOf(space: XRSpace, epoch: number): SpacePoseCache | null {
  const state = space[P_SPACE] as CachedSpaceState;
  return currentWorld(state, cacheIn(state), epoch);
}

/**
 * worldOf for a space whose record and cache the caller already holds (the
 * record is read through a site that sees every space class, so callers
 * read it once).
 */
function currentWorld(
  state: CachedSpaceState,
  cache: SpacePoseCache,
  epoch: number,
): SpacePoseCache | null {
  if (cache.worldEpoch === epoch) {
    return cache.worldOk ? cache : null;
  }
  return resolveWorld(state, cache, epoch);
}

/** The parent's cache, remembered on the child's (no lookup when unchanged). */
function parentCacheOf(cache: SpacePoseCache, parent: XRSpace): SpacePoseCache {
  let parentCache = cache.parentCache;
  if (cache.parent !== parent || parentCache === null) {
    parentCache = cacheOf(parent);
    cache.parent = parent;
    cache.parentCache = parentCache;
  }
  return parentCache;
}

/**
 * Resolves one space for `epoch` from its parent's cache (`above`, already
 * resolved; null for a root space). Returns whether it is located.
 */
function settle(
  state: CachedSpaceState,
  cache: SpacePoseCache,
  above: SpacePoseCache | null,
  epoch: number,
): boolean {
  cache.worldEpoch = epoch;
  const ok = (above === null || above.worldOk) && state.tracked !== false;
  cache.worldOk = ok;
  if (ok) {
    const offset = state.offsetMatrix;
    if (above === null) {
      cache.world = offset;
      cache.worldIsIdentity = isIdentity(offset);
    } else {
      if (above.worldIsIdentity) {
        // no copy: the offset matrix is the world matrix
        cache.world = offset;
      } else {
        multiplyInto(cache.own, 0, above.world, offset);
        cache.world = cache.own;
      }
      cache.worldIsIdentity = false;
    }
  }
  return ok;
}

/** worldOf's work for a space whose cache is not current. */
function resolveWorld(
  state: CachedSpaceState,
  cache: SpacePoseCache,
  epoch: number,
): SpacePoseCache | null {
  // the common case: a root, or a parent already resolved this epoch
  const parent = state.parentSpace;
  let above: SpacePoseCache | null = null;
  if (parent !== undefined) {
    above = parentCacheOf(cache, parent);
    if (above.worldEpoch !== epoch) {
      // the parent is the root (the global space, first asked about this
      // epoch): no chain to walk; anything deeper goes to resolveChain
      const parentState = parent[P_SPACE] as CachedSpaceState;
      if (parentState.parentSpace !== undefined) {
        return resolveChain(state, cache, epoch);
      }
      settle(parentState, above, null, epoch);
    }
  }
  return settle(state, cache, above, epoch) ? cache : null;
}

/**
 * The spaces resolveChain still has to resolve, the space asked about
 * first. Reused, and emptied after each resolve so they keep no space alive.
 */
const pendingStates: (CachedSpaceState | null)[] = [];
const pendingCaches: (SpacePoseCache | null)[] = [];

/**
 * resolveWorld when the parent is not resolved yet: walks up the parent
 * chain to the first ancestor already resolved in this epoch (or the root),
 * then resolves downwards, so chain depth costs time but no stack.
 */
function resolveChain(
  state: CachedSpaceState,
  cache: SpacePoseCache,
  epoch: number,
): SpacePoseCache | null {
  let count = 0;
  let s = state;
  let c = cache;
  // the resolved ancestor the walk stopped at, or null at the root
  let above: SpacePoseCache | null = null;
  for (;;) {
    pendingStates[count] = s;
    pendingCaches[count] = c;
    count++;
    const parent = s.parentSpace;
    if (parent === undefined) {
      break;
    }
    const parentCache = parentCacheOf(c, parent);
    if (parentCache.worldEpoch === epoch) {
      above = parentCache;
      break;
    }
    s = parent[P_SPACE] as CachedSpaceState;
    c = parentCache;
  }
  for (let i = count - 1; i >= 0; i--) {
    const ch = pendingCaches[i]!;
    settle(pendingStates[i]!, ch, above, epoch);
    pendingStates[i] = null;
    pendingCaches[i] = null;
    above = ch;
  }
  return cache.worldOk ? cache : null;
}

/**
 * The inverse of the base space's world matrix for `epoch`, or null when
 * the base (or an ancestor) is untracked or its matrix is singular.
 */
function inverseOf(base: XRSpace, epoch: number): mat4 | null {
  const cache = cacheOf(base);
  if (cache.inverseEpoch !== epoch) {
    cache.inverseEpoch = epoch;
    cache.inverseOk =
      worldOf(base, epoch) !== null && invertAffine(cache.inverse, cache.world);
  }
  return cache.inverseOk ? cache.inverse : null;
}

/** Writes `a * b` into a transform's matrix and marks it rewritten. */
function writeTransform(
  rigid: XRRigidTransform[typeof P_RIGID_TRANSFORM],
  a: mat4,
  b: mat4,
): void {
  multiplyInto(rigid.matrix, 0, a, b);
  rigid.version++;
}

export function hostGetPose(
  frame: XRFrame,
  space: XRSpace,
  baseSpace: XRSpace,
): XRPose | null {
  const frameId = frame[P_FRAME].id;
  const state = space[P_SPACE] as CachedSpaceState;
  const cache = cacheIn(state);
  let book = cache.poses;
  if (book === null) {
    book = cache.poses = new PoseBook<XRPose>();
  }
  const epoch = poseEpoch;
  const asked = answerIndex(book, baseSpace, epoch);
  if (asked >= 0) {
    return book.answers[asked];
  }
  const toBase = inverseOf(baseSpace, epoch);
  if (toBase === null || currentWorld(state, cache, epoch) === null) {
    recordAnswer(book, baseSpace, null);
    return null;
  }
  let entry = reusable(book.stock, frameId);
  if (entry === null) {
    entry = stocked(new XRPose(new XRRigidTransform(), false));
    book.stock.push(entry);
  }
  writeTransform(entry.rigid, toBase, cache.world);
  entry.writtenIn = frameId;
  recordAnswer(book, baseSpace, entry.pose);
  return entry.pose;
}

export function hostGetJointPose(
  frame: XRFrame,
  joint: XRJointSpace,
  baseSpace: XRSpace,
): XRJointPose | null {
  const frameId = frame[P_FRAME].id;
  const state = joint[P_SPACE] as CachedSpaceState;
  const cache = cacheIn(state);
  let book = cache.joints;
  if (book === null) {
    book = cache.joints = new PoseBook<XRJointPose>();
  }
  const epoch = poseEpoch;
  const asked = answerIndex(book, baseSpace, epoch);
  if (asked >= 0) {
    return book.answers[asked];
  }
  const toBase = inverseOf(baseSpace, epoch);
  if (toBase === null || currentWorld(state, cache, epoch) === null) {
    recordAnswer(book, baseSpace, null);
    return null;
  }
  let entry = reusable(book.stock, frameId);
  if (entry === null) {
    entry = stocked(new XRJointPose(new XRRigidTransform(), 0, false));
    book.stock.push(entry);
  }
  const pose = entry.pose;
  writeTransform(entry.rigid, toBase, cache.world);
  pose[P_JOINT_POSE].radius = joint[P_JOINT_SPACE].radius;
  entry.writtenIn = frameId;
  recordAnswer(book, baseSpace, pose);
  return pose;
}

/** WebXR XREye values for a frame with `count` views. */
function eyeFor(index: number, count: number): XREye {
  if (count === 1) {
    return XREye.None;
  }
  return index === 0 ? XREye.Left : XREye.Right;
}

/** A stocked viewer pose with `viewCount` views that may be rewritten now. */
function reusableViewerPose(
  stock: readonly Stocked<XRViewerPose>[],
  frameId: number,
  viewCount: number,
): Stocked<XRViewerPose> | null {
  for (let i = 0; i < stock.length; i++) {
    const entry = stock[i];
    if (
      entry.writtenIn <= frameId - 2 &&
      entry.pose[P_VIEWER_POSE].views.length === viewCount
    ) {
      return entry;
    }
  }
  return null;
}

export function hostGetViewerPose(
  frame: XRFrame,
  referenceSpace: XRReferenceSpace,
): XRViewerPose | null {
  const frameState = frame[P_FRAME];
  const session = frameState.session;
  const sessionState = session[P_SESSION];
  const views = sessionState.host!.views;
  const frameId = frameState.id;
  const viewCount = views.count;
  const epoch = poseEpoch;
  const refCache = cacheOf(referenceSpace);
  let book = refCache.viewer;
  if (book === null) {
    book = refCache.viewer = new ViewerBook();
  }
  if (book.session !== session) {
    // views made for another session must not be handed out
    book.session = session;
    book.answeredEpoch = -1;
    book.answer = null;
    const stock = book.stock;
    while (stock.length > 0) {
      stock.pop();
    }
  }
  const answer = book.answer;
  if (
    book.answeredEpoch === epoch &&
    (answer === null || answer[P_VIEWER_POSE].views.length === viewCount)
  ) {
    return answer;
  }
  book.answeredEpoch = epoch;
  book.answer = null;
  const toBase = inverseOf(referenceSpace, epoch);
  if (toBase === null) {
    return null;
  }
  const viewer = worldOf(sessionState.device.viewerSpace, epoch);
  if (viewer === null) {
    return null;
  }
  let entry = reusableViewerPose(book.stock, frameId, viewCount);
  if (entry === null) {
    const made: XRView[] = [];
    for (let i = 0; i < viewCount; i++) {
      made.push(
        new XRView(
          eyeFor(i, viewCount),
          views.projection[i],
          new XRRigidTransform(),
          session,
        ),
      );
    }
    entry = stocked(new XRViewerPose(new XRRigidTransform(), made, false));
    book.stock.push(entry);
  }
  const pose = entry.pose;
  writeTransform(entry.rigid, toBase, viewer.world);
  // the eyes are given in the base (global) space; move them into the
  // reference space with the same inverse
  const poseViews = pose[P_VIEWER_POSE].views;
  for (let i = 0; i < viewCount; i++) {
    const viewState = poseViews[i][P_VIEW];
    writeTransform(
      viewState.transform[P_RIGID_TRANSFORM],
      toBase,
      views.world[i],
    );
    viewState.projectionMatrix = views.projection[i];
  }
  entry.writtenIn = frameId;
  book.answer = pose;
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
  const epoch = poseEpoch;
  const toBase = inverseOf(baseSpace, epoch);
  let complete = true;
  for (let i = 0, at = 0; i < spaces.length; i++, at += 16) {
    const located = toBase === null ? null : worldOf(spaces[i], epoch);
    if (located === null) {
      transforms.fill(NaN, at, at + 16);
      complete = false;
    } else {
      multiplyInto(transforms, at, toBase!, located.world);
    }
  }
  return complete;
}
