/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

import { P_FRAME, P_HIT_TEST, P_RAY, P_SESSION } from '../private.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import {
  XRHitTestResult,
  XRHitTestTrackableType,
  XRTransientInputHitTestResult,
} from '../hittest/XRHitTest.js';
import type { XRRay } from '../hittest/XRRay.js';
import type { XRInputSource } from '../input/XRInputSource.js';
import { XRSemanticLabels } from '../labels/labels.js';
import type { NativeMesh } from '../meshes/XRMesh.js';
import type { NativePlane } from '../planes/XRPlane.js';
import type { XRSession } from '../session/XRSession.js';
import { XRSpace, XRSpaceUtils } from '../spaces/XRSpace.js';

type Source<T> = ReadonlySet<T> | readonly T[] | null | undefined;

/** A ray in the base space: origin and unit direction. */
interface Ray {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
}

/** One intersection, in the base space; the normal faces the ray's origin. */
interface Hit {
  t: number;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
}

const EPSILON = 1e-7;
const LEAF_TRIANGLES = 8;
/** Nodes built between two looks at the clock. */
const NODES_PER_CHECK = 16;

/**
 * A bounding volume hierarchy over a mesh's triangles, in mesh space. A room
 * mesh has tens of thousands of triangles and a hit-test source asks every
 * frame, so the triangles are visited through boxes; the tree is built once
 * per vertices/indices pair (a mesh's geometry changes rarely). Building one
 * for a room mesh takes tens to hundreds of milliseconds, so it is built a
 * slice per frame (build()) and the mesh is left out of hit tests until the
 * tree is ready.
 */
class TriangleTree {
  /** Per node: min x, y, z, max x, y, z. */
  readonly bounds: Float32Array;
  /** Per node: first child (inner) or first triangle slot (leaf), and count (0 for an inner node). */
  readonly first: Uint32Array;
  readonly count: Uint32Array;
  /** Triangle numbers in leaf order. */
  readonly order: Uint32Array;
  nodes = 0;
  private readonly vertices: ArrayLike<number>;
  private readonly indices: ArrayLike<number>;
  private centroid: Float32Array | null = null;
  /** Nodes still to build: [node, start, end] each; empty once ready. */
  private readonly pending: number[] = [];

  constructor(vertices: ArrayLike<number>, indices: ArrayLike<number>) {
    const triangles = Math.floor(indices.length / 3);
    // a binary tree whose leaves hold at least one triangle has fewer than 2n nodes
    const maxNodes = Math.max(1, 2 * triangles);
    this.vertices = vertices;
    this.indices = indices;
    this.bounds = new Float32Array(maxNodes * 6);
    this.first = new Uint32Array(maxNodes);
    this.count = new Uint32Array(maxNodes);
    this.order = new Uint32Array(triangles);
    this.pending.push(this.allocate(), 0, triangles);
  }

  get ready(): boolean {
    return this.pending.length === 0;
  }

  /**
   * Builds nodes until the tree is ready or `deadline` (performance.now()) has
   * passed, at least a few. Returns whether it is ready.
   */
  build(deadline: number): boolean {
    const vertices = this.vertices;
    const indices = this.indices;
    const triangles = this.order.length;
    if (!this.centroid) {
      const centroid = (this.centroid = new Float32Array(triangles * 3));
      for (let i = 0; i < triangles; i++) {
        this.order[i] = i;
        for (let axis = 0; axis < 3; axis++) {
          centroid[i * 3 + axis] =
            (vertices[indices[i * 3] * 3 + axis] +
              vertices[indices[i * 3 + 1] * 3 + axis] +
              vertices[indices[i * 3 + 2] * 3 + axis]) /
            3;
        }
      }
    }
    const centroid = this.centroid;
    // iterative build: [node, start, end]
    const stack = this.pending;
    let built = 0;
    while (stack.length > 0) {
      if (++built % NODES_PER_CHECK === 0 && performance.now() > deadline) {
        return false;
      }
      const end = stack.pop()!;
      const start = stack.pop()!;
      const node = stack.pop()!;
      const b = node * 6;
      let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
      let cMinX = Infinity,
        cMinY = Infinity,
        cMinZ = Infinity,
        cMaxX = -Infinity,
        cMaxY = -Infinity,
        cMaxZ = -Infinity;
      for (let i = start; i < end; i++) {
        const tri = this.order[i];
        for (let k = 0; k < 3; k++) {
          const v = indices[tri * 3 + k] * 3;
          const x = vertices[v],
            y = vertices[v + 1],
            z = vertices[v + 2];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
        const cx = centroid[tri * 3],
          cy = centroid[tri * 3 + 1],
          cz = centroid[tri * 3 + 2];
        if (cx < cMinX) cMinX = cx;
        if (cy < cMinY) cMinY = cy;
        if (cz < cMinZ) cMinZ = cz;
        if (cx > cMaxX) cMaxX = cx;
        if (cy > cMaxY) cMaxY = cy;
        if (cz > cMaxZ) cMaxZ = cz;
      }
      this.bounds[b] = minX;
      this.bounds[b + 1] = minY;
      this.bounds[b + 2] = minZ;
      this.bounds[b + 3] = maxX;
      this.bounds[b + 4] = maxY;
      this.bounds[b + 5] = maxZ;
      const n = end - start;
      const ex = cMaxX - cMinX,
        ey = cMaxY - cMinY,
        ez = cMaxZ - cMinZ;
      if (n <= LEAF_TRIANGLES || Math.max(ex, ey, ez) <= 0) {
        this.first[node] = start;
        this.count[node] = n;
        continue;
      }
      // split at the centroids' midpoint along the longest axis
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const split =
        axis === 0
          ? (cMinX + cMaxX) / 2
          : axis === 1
            ? (cMinY + cMaxY) / 2
            : (cMinZ + cMaxZ) / 2;
      let i = start;
      let j = end - 1;
      while (i <= j) {
        if (centroid[this.order[i] * 3 + axis] < split) {
          i++;
        } else {
          const swap = this.order[i];
          this.order[i] = this.order[j];
          this.order[j] = swap;
          j--;
        }
      }
      let mid = i;
      if (mid === start || mid === end) {
        mid = (start + end) >> 1;
      }
      const left = this.allocate();
      const right = this.allocate();
      this.first[node] = left;
      this.count[node] = 0;
      stack.push(left, start, mid, right, mid, end);
    }
    this.centroid = null;
    return true;
  }

  private allocate(): number {
    return this.nodes++;
  }
}

const trees = new WeakMap<object, { vertices: object; tree: TriangleTree }>();

function treeFor(mesh: NativeMesh): TriangleTree {
  const known = trees.get(mesh.indices);
  if (known && known.vertices === mesh.vertices) {
    return known.tree;
  }
  const tree = new TriangleTree(mesh.vertices, mesh.indices);
  trees.set(mesh.indices, { vertices: mesh.vertices, tree });
  return tree;
}

/** Slab test: the ray's entry distance into a node's box, or Infinity. */
function boxEntry(b: Float32Array, at: number, r: Ray, limit: number): number {
  let near = 0;
  let far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? r.ox : axis === 1 ? r.oy : r.oz;
    const d = axis === 0 ? r.dx : axis === 1 ? r.dy : r.dz;
    const lo = b[at + axis];
    const hi = b[at + 3 + axis];
    if (Math.abs(d) < EPSILON) {
      if (o < lo || o > hi) {
        return Infinity;
      }
      continue;
    }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) {
      const s = t0;
      t0 = t1;
      t1 = s;
    }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) {
      return Infinity;
    }
  }
  return near;
}

const scratchInverse = mat4.create();
const scratchSource = mat4.create();

/** The ray transformed by a rigid matrix (column-major). */
function transformRay(out: Ray, m: ArrayLike<number>, r: Ray): Ray {
  const { ox, oy, oz, dx, dy, dz } = r;
  out.ox = m[0] * ox + m[4] * oy + m[8] * oz + m[12];
  out.oy = m[1] * ox + m[5] * oy + m[9] * oz + m[13];
  out.oz = m[2] * ox + m[6] * oy + m[10] * oz + m[14];
  out.dx = m[0] * dx + m[4] * dy + m[8] * dz;
  out.dy = m[1] * dx + m[5] * dy + m[9] * dz;
  out.dz = m[2] * dx + m[6] * dy + m[10] * dz;
  return out;
}

/** Even-odd test of (x, z) against a polygon given as points in the x-z plane. */
function insidePolygon(
  polygon: readonly DOMPointReadOnly[],
  x: number,
  z: number,
): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x,
      zi = polygon[i].z,
      xj = polygon[j].x,
      zj = polygon[j].z;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Hit test for a host session (WebXR Hit Test module) against the planes and
 * meshes the host reports (`XRHostBackend.getPlanes` / `getMeshes`), which a
 * host reads from its scene model whether or not the session enabled plane or
 * mesh detection.
 *
 * Each source's ray (its space this frame, then its offset ray) is cast into
 * planes (the polygon in plane space, where the plane is y = 0; either side)
 * and mesh triangles (the front face only, counter-clockwise as seen from the
 * ray, as Quest Browser does: a ray from inside a furniture volume does not
 * hit the inside of its box). Results are sorted by distance; a result's pose
 * sits at the intersection with +Y along the surface normal, turned towards
 * the ray's origin, and +Z along the ray's direction projected onto the
 * surface, pointing back towards the origin.
 *
 * Entity types: 'plane' hits planes, 'mesh' and 'point' hit meshes (the room
 * mesh stands in for feature points). A source made without `entityTypes`
 * hits what Quest Browser's does: the global mesh alone when the room has one
 * (not the planes, not the furniture boxes), else the planes (WebXR's default
 * entity type).
 */
export class XRHostHitTest {
  /** Time per frame for building mesh trees (tests set it). */
  static buildBudgetMs = 2;

  private readonly globalSpace: XRSpace;
  private readonly hits: Hit[] = [];
  private hitCount = 0;
  /** This frame's global mesh with a ready tree, if the room has one. */
  private globalMesh: NativeMesh | null = null;
  /** The cast in progress hits the global mesh only (a source without entityTypes). */
  private onlyGlobal = false;
  private readonly local: Ray = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0 };
  private readonly world: Ray = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0 };
  // reused every cast: the per-frame cost should be the result objects only
  private readonly stack: number[] = [];
  private readonly visitPlane = (plane: NativePlane) => this.castPlane(plane);
  private readonly visitMesh = (mesh: NativeMesh) => this.castMesh(mesh);
  private buildDeadline = 0;
  private readonly visitTree = (mesh: NativeMesh) => {
    const tree = treeFor(mesh);
    if (!tree.ready) {
      tree.build(this.buildDeadline);
    }
    if (
      tree.ready &&
      this.globalMesh === null &&
      mesh.semanticLabel === XRSemanticLabels.GlobalMesh
    ) {
      this.globalMesh = mesh;
    }
  };

  constructor(globalSpace: XRSpace) {
    this.globalSpace = globalSpace;
  }

  /** Fills the frame's hit-test results for every source of the session. */
  compute(
    frame: XRFrame,
    session: XRSession,
    planes: Source<NativePlane>,
    meshes: Source<NativeMesh>,
  ): void {
    const s = session[P_SESSION];
    const results = frame[P_FRAME].hitTestResultsMap;
    const transient = frame[P_FRAME].transientHitTestResultsMap;
    // every source has an answer for this frame, even if a later step throws
    s.hitTestSources.forEach((source) => results.set(source, []));
    s.transientHitTestSources.forEach((source) => transient.set(source, []));
    // mesh trees: a slice of the build per frame; the global mesh once ready
    this.globalMesh = null;
    this.buildDeadline = performance.now() + XRHostHitTest.buildBudgetMs;
    forEach(meshes, this.visitTree);

    s.hitTestSources.forEach((source) => {
      const state = source[P_HIT_TEST];
      results.set(
        source,
        this.cast(
          frame,
          state.space,
          state.offsetRay,
          state.entityTypes,
          planes,
          meshes,
        ),
      );
    });

    if (s.transientHitTestSources.size === 0) {
      return;
    }
    const inputs = s.activeInputSources;
    s.transientHitTestSources.forEach((source) => {
      const state = source[P_HIT_TEST];
      const list: XRTransientInputHitTestResult[] = [];
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        if (!matchesTransient(input, state.profile)) {
          continue;
        }
        list.push(
          new XRTransientInputHitTestResult(
            input,
            this.cast(
              frame,
              input.targetRaySpace,
              state.offsetRay,
              state.entityTypes,
              planes,
              meshes,
            ),
          ),
        );
      }
      transient.set(source, list);
    });
  }

  private cast(
    frame: XRFrame,
    space: XRSpace,
    offsetRay: XRRay,
    entityTypes: XRHitTestTrackableType[] | undefined,
    planes: Source<NativePlane>,
    meshes: Source<NativeMesh>,
  ): XRHitTestResult[] {
    if (
      !XRSpaceUtils.calculateTrackedGlobalOffsetMatrix(space, scratchSource)
    ) {
      return [];
    }
    const ray = offsetRay[P_RAY];
    const world = this.world;
    world.ox = ray.origin.x;
    world.oy = ray.origin.y;
    world.oz = ray.origin.z;
    world.dx = ray.direction.x;
    world.dy = ray.direction.y;
    world.dz = ray.direction.z;
    transformRay(world, scratchSource, world);
    const length = Math.hypot(world.dx, world.dy, world.dz);
    if (!(length > 0)) {
      return [];
    }
    world.dx /= length;
    world.dy /= length;
    world.dz /= length;

    // Quest Browser's default: the global mesh when there is one, else planes
    this.onlyGlobal = !entityTypes;
    const wantPlanes = entityTypes
      ? entityTypes.includes('plane')
      : this.globalMesh === null;
    const wantMeshes = entityTypes
      ? entityTypes.includes('mesh') || entityTypes.includes('point')
      : this.globalMesh !== null;
    this.hitCount = 0;
    if (wantPlanes && planes) {
      forEach(planes, this.visitPlane);
    }
    if (wantMeshes && meshes) {
      forEach(meshes, this.visitMesh);
    }
    if (this.hitCount === 0) {
      return [];
    }
    // nearest first; a handful of hits, so an in-place insertion sort of the pool
    const hits = this.hits;
    for (let i = 1; i < this.hitCount; i++) {
      const hit = hits[i];
      let j = i - 1;
      for (; j >= 0 && hits[j].t > hit.t; j--) {
        hits[j + 1] = hits[j];
      }
      hits[j + 1] = hit;
    }
    const out: XRHitTestResult[] = new Array(this.hitCount);
    for (let i = 0; i < this.hitCount; i++) {
      out[i] = new XRHitTestResult(
        frame,
        new XRSpace(this.globalSpace, poseMatrix(hits[i], world)),
      );
    }
    return out;
  }

  private castPlane(plane: NativePlane): void {
    const polygon = plane.polygon;
    if (!polygon || polygon.length < 3) {
      return;
    }
    const m = plane.transform.matrix;
    if (!mat4.invert(scratchInverse, m)) {
      return;
    }
    const r = transformRay(this.local, scratchInverse, this.world);
    if (Math.abs(r.dy) < EPSILON) {
      return;
    }
    const t = -r.oy / r.dy;
    if (!(t > 0)) {
      return;
    }
    const x = r.ox + t * r.dx;
    const z = r.oz + t * r.dz;
    if (!insidePolygon(polygon, x, z)) {
      return;
    }
    // plane +Y in the base space
    this.push(t, m[4], m[5], m[6]);
  }

  private castMesh(mesh: NativeMesh): void {
    const vertices = mesh.vertices;
    const indices = mesh.indices;
    if (!vertices || !indices || indices.length < 3) {
      return;
    }
    if (this.onlyGlobal && mesh !== this.globalMesh) {
      return;
    }
    const tree = treeFor(mesh);
    if (!tree.ready) {
      return; // still being built (compute())
    }
    const m = mesh.transform.matrix;
    if (!mat4.invert(scratchInverse, m)) {
      return;
    }
    const r = transformRay(this.local, scratchInverse, this.world);
    let best = Infinity;
    let bnx = 0,
      bny = 0,
      bnz = 0;
    const stack = this.stack;
    stack.length = 0;
    stack.push(0);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (boxEntry(tree.bounds, node * 6, r, best) === Infinity) {
        continue;
      }
      const count = tree.count[node];
      if (count === 0) {
        stack.push(tree.first[node], tree.first[node] + 1);
        continue;
      }
      const start = tree.first[node];
      for (let i = start; i < start + count; i++) {
        const tri = tree.order[i];
        const a = indices[tri * 3] * 3;
        const b = indices[tri * 3 + 1] * 3;
        const c = indices[tri * 3 + 2] * 3;
        // Möller-Trumbore, front faces only (det > 0: counter-clockwise as
        // seen from the ray's origin)
        const e1x = vertices[b] - vertices[a],
          e1y = vertices[b + 1] - vertices[a + 1],
          e1z = vertices[b + 2] - vertices[a + 2];
        const e2x = vertices[c] - vertices[a],
          e2y = vertices[c + 1] - vertices[a + 1],
          e2z = vertices[c + 2] - vertices[a + 2];
        const px = r.dy * e2z - r.dz * e2y,
          py = r.dz * e2x - r.dx * e2z,
          pz = r.dx * e2y - r.dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det < EPSILON) {
          continue;
        }
        const inv = 1 / det;
        const sx = r.ox - vertices[a],
          sy = r.oy - vertices[a + 1],
          sz = r.oz - vertices[a + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) {
          continue;
        }
        const qx = sy * e1z - sz * e1y,
          qy = sz * e1x - sx * e1z,
          qz = sx * e1y - sy * e1x;
        const v = (r.dx * qx + r.dy * qy + r.dz * qz) * inv;
        if (v < 0 || u + v > 1) {
          continue;
        }
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > EPSILON && t < best) {
          best = t;
          bnx = e1y * e2z - e1z * e2y;
          bny = e1z * e2x - e1x * e2z;
          bnz = e1x * e2y - e1y * e2x;
        }
      }
    }
    if (best === Infinity) {
      return;
    }
    // the face normal in the base space (rigid transform: the rotation part)
    this.push(
      best,
      m[0] * bnx + m[4] * bny + m[8] * bnz,
      m[1] * bnx + m[5] * bny + m[9] * bnz,
      m[2] * bnx + m[6] * bny + m[10] * bnz,
    );
  }

  /** Records a hit at distance t along the world ray with an (unnormalised) normal. */
  private push(t: number, nx: number, ny: number, nz: number): void {
    const w = this.world;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) {
      return;
    }
    nx /= length;
    ny /= length;
    nz /= length;
    if (nx * w.dx + ny * w.dy + nz * w.dz > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    let hit = this.hits[this.hitCount];
    if (!hit) {
      hit = this.hits[this.hitCount] = {
        t: 0,
        px: 0,
        py: 0,
        pz: 0,
        nx: 0,
        ny: 0,
        nz: 0,
      };
    }
    this.hitCount++;
    hit.t = t;
    hit.px = w.ox + t * w.dx;
    hit.py = w.oy + t * w.dy;
    hit.pz = w.oz + t * w.dz;
    hit.nx = nx;
    hit.ny = ny;
    hit.nz = nz;
  }
}

function forEach<T>(source: Source<T>, visit: (item: T) => void): void {
  if (!source) {
    return;
  }
  if (Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) {
      visit(source[i]);
    }
  } else {
    (source as ReadonlySet<T>).forEach(visit);
  }
}

/** WebXR Hit Test: transient input sources (screen taps, transient pointers) whose profiles list the profile. */
function matchesTransient(input: XRInputSource, profile: string): boolean {
  const mode = input.targetRayMode as string;
  if (mode !== 'transient-pointer' && mode !== 'screen') {
    return false;
  }
  return profile === '' || input.profiles.includes(profile);
}

/** The result pose: at the hit, +Y the normal, +Z the ray direction projected onto the surface, reversed. */
function poseMatrix(hit: Hit, ray: Ray): mat4 {
  const yx = hit.nx,
    yy = hit.ny,
    yz = hit.nz;
  const along = ray.dx * yx + ray.dy * yy + ray.dz * yz;
  let zx = -(ray.dx - along * yx),
    zy = -(ray.dy - along * yy),
    zz = -(ray.dz - along * yz);
  let length = Math.hypot(zx, zy, zz);
  if (length < 1e-6) {
    // the ray runs along the normal: any direction in the surface will do
    const ax = Math.abs(yx) < 0.9 ? 1 : 0;
    const az = ax === 1 ? 0 : 1;
    // z = a x y
    zx = 0 * yz - az * yy;
    zy = az * yx - ax * yz;
    zz = ax * yy - 0 * yx;
    length = Math.hypot(zx, zy, zz);
  }
  zx /= length;
  zy /= length;
  zz /= length;
  // x = y x z
  const xx = yy * zz - yz * zy,
    xy = yz * zx - yx * zz,
    xz = yx * zy - yy * zx;
  return mat4.fromValues(
    xx,
    xy,
    xz,
    0,
    yx,
    yy,
    yz,
    0,
    zx,
    zy,
    zz,
    0,
    hit.px,
    hit.py,
    hit.pz,
    1,
  );
}
