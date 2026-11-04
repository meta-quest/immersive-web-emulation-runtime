/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_FRAME, P_MESH, P_PLANE } from '../private.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { NativeMesh, XRMesh } from '../meshes/XRMesh.js';
import { NativePlane, XRPlane, planeOrientation } from '../planes/XRPlane.js';
import { XRSpace, XRSpaceUtils } from '../spaces/XRSpace.js';

type Source<T> = ReadonlySet<T> | readonly T[] | null | undefined;

/**
 * Plane and mesh detection for a host session (WebXR Plane Detection and
 * Mesh Detection modules), fed from `XRHostBackend.getPlanes` / `getMeshes`.
 *
 * Every visible frame the host's current list is compared with what the
 * session tracks: new native objects get an `XRPlane` / `XRMesh` whose space
 * hangs off the global (base) space, known ones have their space moved and
 * their attributes refreshed, and objects the host no longer lists are
 * dropped. `lastChangedTime` is the frame time at which an object appeared
 * or one of its attributes (polygon, orientation, semantic label, vertices,
 * indices) changed; moving does not count, since the pose is not an
 * attribute of the object. Nothing is allocated for objects already known.
 */
export class XRHostScene {
  private readonly globalSpace: XRSpace;
  private readonly planes: Map<NativePlane, XRPlane>;
  private readonly meshes: Map<NativeMesh, XRMesh>;
  // frame id each tracked object was last listed in
  private readonly listedIn = new WeakMap<object, number>();
  // state of the pass in progress, read by the persistent callbacks below
  private frame: XRFrame | null = null;
  private frameId = 0;
  private time = 0;

  constructor(
    globalSpace: XRSpace,
    planes: Map<NativePlane, XRPlane>,
    meshes: Map<NativeMesh, XRMesh>,
  ) {
    this.globalSpace = globalSpace;
    this.planes = planes;
    this.meshes = meshes;
  }

  /** Brings the session's planes and `frame.detectedPlanes` up to date. */
  syncPlanes(frame: XRFrame, source: Source<NativePlane>): void {
    this.begin(frame);
    this.visit(source, this.visitPlane);
    this.planes.forEach(this.prunePlane);
    frame[P_FRAME].detectedPlanes.forEach(this.unlistPlane);
    this.frame = null;
  }

  /** Brings the session's meshes and `frame.detectedMeshes` up to date. */
  syncMeshes(frame: XRFrame, source: Source<NativeMesh>): void {
    this.begin(frame);
    this.visit(source, this.visitMesh);
    this.meshes.forEach(this.pruneMesh);
    frame[P_FRAME].detectedMeshes.forEach(this.unlistMesh);
    this.frame = null;
  }

  /**
   * When the host's plane list could not be read this frame: the frame
   * reports the planes already tracked, unchanged, instead of none.
   */
  keepPlanes(frame: XRFrame): void {
    this.frame = null;
    const detected = frame[P_FRAME].detectedPlanes;
    detected.clear();
    this.planes.forEach((plane) => {
      plane[P_PLANE].frame = frame;
      detected.add(plane);
    });
  }

  /** Like `keepPlanes`, for meshes. */
  keepMeshes(frame: XRFrame): void {
    this.frame = null;
    const detected = frame[P_FRAME].detectedMeshes;
    detected.clear();
    this.meshes.forEach((mesh) => {
      mesh[P_MESH].frame = frame;
      detected.add(mesh);
    });
  }

  private begin(frame: XRFrame): void {
    this.frame = frame;
    this.frameId = frame[P_FRAME].id;
    this.time = frame[P_FRAME].predictedDisplayTime;
  }

  private visit<T>(source: Source<T>, visitor: (item: T) => void): void {
    if (!source) {
      return;
    }
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) {
        visitor(source[i]);
      }
    } else {
      (source as ReadonlySet<T>).forEach(visitor);
    }
  }

  private readonly visitPlane = (native: NativePlane) => {
    const frame = this.frame!;
    let plane = this.planes.get(native);
    if (!plane) {
      plane = new XRPlane(
        native,
        new XRSpace(this.globalSpace, native.transform.matrix),
        native.polygon,
        native.semanticLabel,
      );
      plane[P_PLANE].lastChangedTime = this.time;
      this.planes.set(native, plane);
    } else {
      const state = plane[P_PLANE];
      XRSpaceUtils.updateOffsetMatrix(
        plane.planeSpace,
        native.transform.matrix,
      );
      let changed = false;
      if (state.polygon !== native.polygon) {
        state.polygon = native.polygon;
        changed = true;
      }
      if (state.semanticLabel !== native.semanticLabel) {
        state.semanticLabel = native.semanticLabel;
        changed = true;
      }
      const orientation = planeOrientation(native, native.semanticLabel);
      if (state.orientation !== orientation) {
        state.orientation = orientation;
        changed = true;
      }
      if (changed) {
        state.lastChangedTime = this.time;
      }
    }
    plane[P_PLANE].frame = frame;
    this.listedIn.set(plane, this.frameId);
    frame[P_FRAME].detectedPlanes.add(plane);
  };

  private readonly prunePlane = (plane: XRPlane, native: NativePlane) => {
    if (this.listedIn.get(plane) !== this.frameId) {
      this.planes.delete(native);
    }
  };

  // The frame's set is brought up to date in place rather than cleared and
  // refilled: V8 gives a Set a new table on clear() and grows it again on
  // the adds, while a steady room changes nothing here. (Deleting during
  // Set.prototype.forEach is well defined.)
  private readonly unlistPlane = (plane: XRPlane) => {
    if (this.listedIn.get(plane) !== this.frameId) {
      this.frame![P_FRAME].detectedPlanes.delete(plane);
    }
  };

  private readonly visitMesh = (native: NativeMesh) => {
    const frame = this.frame!;
    let mesh = this.meshes.get(native);
    if (!mesh) {
      mesh = new XRMesh(
        native,
        new XRSpace(this.globalSpace, native.transform.matrix),
        native.vertices,
        native.indices,
        native.semanticLabel,
      );
      mesh[P_MESH].lastChangedTime = this.time;
      this.meshes.set(native, mesh);
    } else {
      const state = mesh[P_MESH];
      XRSpaceUtils.updateOffsetMatrix(mesh.meshSpace, native.transform.matrix);
      let changed = false;
      if (state.vertices !== native.vertices) {
        state.vertices = native.vertices;
        changed = true;
      }
      if (state.indices !== native.indices) {
        state.indices = native.indices;
        changed = true;
      }
      if (state.semanticLabel !== native.semanticLabel) {
        state.semanticLabel = native.semanticLabel;
        changed = true;
      }
      if (changed) {
        state.lastChangedTime = this.time;
      }
    }
    mesh[P_MESH].frame = frame;
    this.listedIn.set(mesh, this.frameId);
    frame[P_FRAME].detectedMeshes.add(mesh);
  };

  private readonly pruneMesh = (mesh: XRMesh, native: NativeMesh) => {
    if (this.listedIn.get(mesh) !== this.frameId) {
      this.meshes.delete(native);
    }
  };

  private readonly unlistMesh = (mesh: XRMesh) => {
    if (this.listedIn.get(mesh) !== this.frameId) {
      this.frame![P_FRAME].detectedMeshes.delete(mesh);
    }
  };
}
