/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The headset's room as IWER host mode's planes and meshes (docs/spec/08 XR-AR-2): XRHostBackend.getPlanes /
// getMeshes, which IWER reads for plane detection, mesh detection and its hit test (iwer src/host/scene.ts,
// host/hit-test.ts). The runtime's scene model (runtime/xr xr_scene.h) hands over each entity's geometry once per
// query (sceneData) and its pose every frame in a table of its own (scenePoses), not the frame record.
//
// What becomes what, as in Quest Browser: an entity with a 2D boundary (walls, floor, ceiling, table tops, doors,
// windows, ...) is a plane; one with a 3D bounding box (tables, couches, storage, ...) is a mesh of that box; the
// global mesh is a mesh. An entity can be both (a table: its top and its volume).

import {
  NativeMesh,
  NativePlane,
  XRRigidTransform,
  overwriteTransformMatrix,
} from 'iwer/host';
import type { HostPoint } from 'iwer/host';

import type { SceneData, SceneEntityData, XrNatives } from './natives.ts';

/** Floats per pose slot: x y z, qx qy qz qw, flags (bit 0: located this frame). */
export const SCENE_SLOT_FLOATS = 8;

/**
 * XR_FB_scene labels -> WebXR semantic labels (the immersive-web semantic-labels registry, which IWER's
 * XRSemanticLabels lists). STORAGE is the registry's "shelf"; invisible walls (a wall Space Setup could not see)
 * are walls. Unknown labels are "other".
 */
const LABELS: Record<string, string> = {
  TABLE: 'table',
  DESK: 'desk',
  COUCH: 'couch',
  FLOOR: 'floor',
  CEILING: 'ceiling',
  WALL_FACE: 'wall',
  INVISIBLE_WALL_FACE: 'wall',
  WINDOW_FRAME: 'window',
  DOOR_FRAME: 'door',
  STORAGE: 'shelf',
  BED: 'bed',
  SCREEN: 'screen',
  LAMP: 'lamp',
  PLANT: 'plant',
  WALL_ART: 'wall art',
  GLOBAL_MESH: 'global mesh',
  OTHER: 'other',
};

/** The WebXR label for an entity's comma-separated runtime labels: the first one WebXR knows. */
export function webxrLabel(labels: string): string {
  for (const raw of labels.split(',')) {
    const label = LABELS[raw.trim().toUpperCase()];
    if (label) return label;
  }
  return 'other';
}

/** The plane's polygon in plane space (y = 0, normal +Y) from a boundary in the entity's x-y plane (normal +Z). */
export function planePolygon(boundary: ArrayLike<number>): HostPoint[] {
  type PointCtor = new (
    x: number,
    y: number,
    z: number,
    w: number,
  ) => HostPoint;
  const Point = (globalThis as unknown as { DOMPointReadOnly: PointCtor })
    .DOMPointReadOnly;
  const out: HostPoint[] = [];
  for (let i = 0; i + 1 < boundary.length; i += 2)
    out.push(new Point(boundary[i], 0, -boundary[i + 1], 1));
  return out;
}

/** A box (offset x y z = minimum corner, extent w h d) as 8 vertices and 12 outward-facing (CCW) triangles. */
export function boxMesh(box: ArrayLike<number>): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const [ox, oy, oz, w, h, d] = [
    box[0],
    box[1],
    box[2],
    box[3],
    box[4],
    box[5],
  ];
  const vertices = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    vertices[i * 3] = ox + (i & 1 ? w : 0);
    vertices[i * 3 + 1] = oy + (i & 2 ? h : 0);
    vertices[i * 3 + 2] = oz + (i & 4 ? d : 0);
  }
  // corner i: bit 0 = +x, bit 1 = +y, bit 2 = +z
  const indices = new Uint32Array([
    0,
    4,
    6,
    0,
    6,
    2, // -x
    1,
    3,
    7,
    1,
    7,
    5, // +x
    0,
    1,
    5,
    0,
    5,
    4, // -y
    2,
    6,
    7,
    2,
    7,
    3, // +y
    0,
    2,
    3,
    0,
    3,
    1, // -z
    4,
    5,
    7,
    4,
    7,
    6, // +z
  ]);
  return { vertices, indices };
}

interface Entry {
  slot: number;
  labels: string;
  polygon: Float32Array | null;
  plane: NativePlane | null;
  mesh: NativeMesh | null;
  meshSource: Float32Array | null; // the box or the vertices the mesh was made from
  meshIndices: Uint32Array | null;
  /** The pose its transforms were last written from (scene entities are world-fixed: it rarely changes). */
  pose: Float32Array;
  posed: boolean;
}

/** Writes a pose (x y z qx qy qz qw) as a column-major matrix; `plane`: turned so +Y is the entity's +Z. */
function poseMatrix(
  out: Float32Array,
  p: Float32Array,
  at: number,
  plane: boolean,
): void {
  const x = p[at + 3],
    y = p[at + 4],
    z = p[at + 5],
    w = p[at + 6];
  const xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;
  // rotation columns: X, Y, Z of the entity's space
  const c0x = 1 - 2 * (yy + zz),
    c0y = 2 * (xy + wz),
    c0z = 2 * (xz - wy);
  const c1x = 2 * (xy - wz),
    c1y = 1 - 2 * (xx + zz),
    c1z = 2 * (yz + wx);
  const c2x = 2 * (xz + wy),
    c2y = 2 * (yz - wx),
    c2z = 1 - 2 * (xx + yy);
  out[0] = c0x;
  out[1] = c0y;
  out[2] = c0z;
  out[3] = 0;
  if (plane) {
    // a rotation of +90 degrees about X: plane +Y = entity +Z, plane +Z = entity -Y
    out[4] = c2x;
    out[5] = c2y;
    out[6] = c2z;
    out[8] = -c1x;
    out[9] = -c1y;
    out[10] = -c1z;
  } else {
    out[4] = c1x;
    out[5] = c1y;
    out[6] = c1z;
    out[8] = c2x;
    out[9] = c2y;
    out[10] = c2z;
  }
  out[7] = 0;
  out[11] = 0;
  out[12] = p[at];
  out[13] = p[at + 1];
  out[14] = p[at + 2];
  out[15] = 1;
}

export class NativeScene {
  private readonly natives: XrNatives;
  private readonly frameId: () => number;
  private poses: Float32Array | null = null;
  private version = -1;
  private readonly entries = new Map<string, Entry>();
  private readonly planeList: NativePlane[] = [];
  private readonly meshList: NativeMesh[] = [];
  private readonly matrix = new Float32Array(16);
  private updatedIn = -1;
  /** Frames in which at least one entity was listed (diagnostics). */
  listedFrames = 0;

  constructor(natives: XrNatives, frameId: () => number) {
    this.natives = natives;
    this.frameId = frameId;
  }

  get supported(): boolean {
    return (
      typeof this.natives.sceneData === 'function' &&
      typeof this.natives.scenePoses === 'function'
    );
  }

  /** A session wants scene data: the runtime queries the room now rather than on the first read. */
  start(): void {
    if (this.supported) this.update(true);
  }

  /** The planes located this frame. */
  planes(): readonly NativePlane[] {
    this.update(false);
    return this.planeList;
  }

  /** The meshes located this frame. */
  meshes(): readonly NativeMesh[] {
    this.update(false);
    return this.meshList;
  }

  /** What the scene holds now (diagnostics, tests). */
  summary(): {
    version: number;
    entities: number;
    planes: number;
    meshes: number;
  } {
    const entities = this.entries.size;
    return {
      version: this.version,
      entities,
      planes: this.planeList.length,
      meshes: this.meshList.length,
    };
  }

  private update(force: boolean): void {
    const frame = this.frameId();
    if (!force && frame === this.updatedIn) return; // getPlanes and getMeshes share one read per frame
    this.updatedIn = frame;
    if (!this.supported) return;
    const data = this.natives.sceneData!(this.version);
    if (data) this.adopt(data);
    if (!this.poses) this.poses = new Float32Array(this.natives.scenePoses!());
    const poses = this.poses;
    this.planeList.length = 0;
    this.meshList.length = 0;
    for (const entry of this.entries.values()) {
      const at = entry.slot * SCENE_SLOT_FLOATS;
      if (at + SCENE_SLOT_FLOATS > poses.length || (poses[at + 7] & 1) === 0)
        continue; // not located this frame
      // Rewriting an unchanged transform would bump its version and make IWER derive its orientation (a new
      // DOMPointReadOnly) for every plane every frame.
      const moved = !entry.posed || !samePose(entry.pose, poses, at);
      if (moved) {
        for (let k = 0; k < 7; k++) entry.pose[k] = poses[at + k];
        entry.posed = true;
      }
      if (entry.plane) {
        if (moved) {
          poseMatrix(this.matrix, poses, at, true);
          overwriteTransformMatrix(entry.plane.transform, this.matrix);
        }
        this.planeList.push(entry.plane);
      }
      if (entry.mesh) {
        if (moved) {
          poseMatrix(this.matrix, poses, at, false);
          overwriteTransformMatrix(entry.mesh.transform, this.matrix);
        }
        this.meshList.push(entry.mesh);
      }
    }
    if (this.planeList.length > 0 || this.meshList.length > 0)
      this.listedFrames++;
  }

  /**
   * A new query result: entities keep their NativePlane / NativeMesh objects (IWER's XRPlane / XRMesh identity)
   * when their id stays; changed geometry is a new array (IWER reports the change through lastChangedTime).
   */
  private adopt(data: SceneData): void {
    this.version = data.version;
    const seen = new Set<string>();
    for (const e of data.entities) {
      seen.add(e.id);
      const label = webxrLabel(e.labels);
      let entry = this.entries.get(e.id);
      if (!entry) {
        entry = {
          slot: e.slot,
          labels: '',
          polygon: null,
          plane: null,
          mesh: null,
          meshSource: null,
          meshIndices: null,
          pose: new Float32Array(7),
          posed: false,
        };
        this.entries.set(e.id, entry);
      }
      if (entry.slot !== e.slot) entry.posed = false;
      entry.slot = e.slot;
      this.adoptPlane(entry, e, label);
      this.adoptMesh(entry, e, label);
      entry.labels = e.labels;
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.entries.delete(id);
    }
  }

  private adoptPlane(entry: Entry, e: SceneEntityData, label: string): void {
    const polygon = e.polygon && e.polygon.length >= 6 ? e.polygon : null;
    if (!polygon) {
      entry.plane = null;
      entry.polygon = null;
      return;
    }
    if (!entry.plane) {
      entry.plane = new NativePlane(
        new XRRigidTransform(),
        planePolygon(polygon),
        label as never,
      );
      entry.posed = false; // a new transform: written at the next update
    } else {
      if (!sameNumbers(entry.polygon, polygon))
        entry.plane.polygon = planePolygon(polygon);
      if (entry.plane.semanticLabel !== label)
        entry.plane.semanticLabel = label as never;
    }
    entry.polygon = polygon;
  }

  private adoptMesh(entry: Entry, e: SceneEntityData, label: string): void {
    // the room mesh when the entity has one, else its box
    const room =
      e.vertices && e.indices && e.indices.length >= 3
        ? { vertices: e.vertices, indices: e.indices }
        : null;
    const source = room
      ? room.vertices
      : e.box && e.box.length >= 6
        ? e.box
        : null;
    if (!source) {
      entry.mesh = null;
      entry.meshSource = null;
      entry.meshIndices = null;
      return;
    }
    const indices = room ? room.indices : null;
    const changed =
      !sameNumbers(entry.meshSource, source) ||
      (indices !== null && !sameNumbers(entry.meshIndices, indices));
    if (!entry.mesh || changed) {
      const geometry = room ?? boxMesh(source);
      if (!entry.mesh) {
        entry.mesh = new NativeMesh(
          new XRRigidTransform(),
          geometry.vertices,
          geometry.indices,
          label as never,
        );
        entry.posed = false;
      } else {
        entry.mesh.vertices = geometry.vertices;
        entry.mesh.indices = geometry.indices;
      }
    }
    if (entry.mesh.semanticLabel !== label)
      entry.mesh.semanticLabel = label as never;
    entry.meshSource = source;
    entry.meshIndices = indices;
  }
}

function samePose(
  last: Float32Array,
  poses: Float32Array,
  at: number,
): boolean {
  for (let k = 0; k < 7; k++) {
    if (last[k] !== poses[at + k]) return false;
  }
  return true;
}

function sameNumbers(
  a: ArrayLike<number> | null,
  b: ArrayLike<number>,
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
