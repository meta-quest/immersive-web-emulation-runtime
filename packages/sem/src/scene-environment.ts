/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Light,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from 'three';
import {
  NativeMesh,
  NativePlane,
  XRRigidTransform,
  XRSemanticLabels,
} from 'iwer';

/**
 * A three.js subtree used as the emulated real world, e.g. a scene loaded with
 * `GLTSLoader` from `@drawcall/glts`. `update(delta)` is called every frame
 * when present, which drives GLTS `onFrame` callbacks.
 *
 * Meshes opt into WebXR real-world geometry through `userData`:
 * - `userData.xrPlane = 'floor'` reports an XRPlane. Its normal is the
 *   thinnest axis of the geometry's local bounding box, its polygon that
 *   bounding box's face.
 * - `userData.xrMesh = 'table'` reports an XRMesh from the geometry.
 *
 * Values are WebXR semantic labels (`true` means 'other'). Geometry and scale
 * are captured when an object is first seen; afterwards only its pose is
 * tracked. Adding or removing labelled objects adds or removes the plane/mesh.
 *
 * Every reported plane/mesh also gets a translucent overlay (in
 * `planeOverlays` / `meshOverlays`) that follows it, for debugging.
 *
 * The scene's static geometry is also reported as one 'global mesh' XRMesh
 * (see buildGlobalMesh). Tag moving objects, or parts outside the room
 * such as a view behind a window, with `userData.xrGlobalMesh = false`.
 */
export type EnvironmentObject = Object3D & {
  update?: (delta: number) => void;
  dispose?: () => void;
};

type Tracked<T> = {
  native: T;
  /** Object-local frame of the plane/mesh (plane: maps +Y to the normal). */
  frame: Matrix4;
  /** Last reported pose, to skip unchanged transforms. */
  pose: Matrix4;
  /** Debug visualization of what WebXR reports. */
  overlay: Mesh;
};

const overlayMaterial = (color: string) =>
  new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.35,
    side: DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

const labels = new Set<string>(Object.values(XRSemanticLabels));
const yToX = new Matrix4().makeRotationZ(-Math.PI / 2);
const yToZ = new Matrix4().makeRotationX(Math.PI / 2);

const tempMatrix = new Matrix4();
const tempPosition = new Vector3();
const tempQuaternion = new Quaternion();
const tempScale = new Vector3();
const tempVector = new Vector3();
const tempPose = new Matrix4();

export class SceneEnvironment {
  readonly planeOverlays = new Group();
  readonly meshOverlays = new Group();
  private planes = new Map<Mesh, Tracked<NativePlane>>();
  private meshes = new Map<Mesh, Tracked<NativeMesh>>();
  private planeMaterial = overlayMaterial('#2f9bff');
  private meshMaterial = overlayMaterial('#ff9a2f');
  private globalMesh: NativeMesh | null | undefined;

  constructor(
    public readonly root: EnvironmentObject,
    private readonly disposeRoot = () => root.dispose?.(),
  ) {}

  /** Detaches and disposes the scene and its overlays. */
  dispose() {
    this.root.removeFromParent();
    this.planeOverlays.removeFromParent();
    this.meshOverlays.removeFromParent();
    try {
      // three.js frees a light's shadow map only in light.dispose(), which
      // removing the light from the scene does not call.
      this.root.traverse((object) => {
        if ((object as Light).isLight) (object as Light).dispose();
      });
      this.disposeRoot();
    } finally {
      for (const tracked of [
        ...this.planes.values(),
        ...this.meshes.values(),
      ]) {
        tracked.overlay.geometry.dispose();
      }
      this.planeMaterial.dispose();
      this.meshMaterial.dispose();
    }
  }

  /**
   * Meshes that are drawn but are not surfaces (materials that write no
   * color, such as shadow-only casters), hidden from the depth pass so depth
   * agrees with hit tests and the global mesh.
   */
  nonSurfaces(): Mesh[] {
    const list: Mesh[] = [];
    this.root.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh && !surfaceMaterial(mesh) && mesh.visible) {
        list.push(mesh);
      }
    });
    return list;
  }

  /** Advances the environment and mirrors it into the tracked sets. */
  update(
    delta: number,
    trackedPlanes: Set<NativePlane>,
    trackedMeshes: Set<NativeMesh>,
  ) {
    this.root.update?.(delta);
    this.root.updateMatrixWorld();
    if (this.globalMesh === undefined)
      this.globalMesh = buildGlobalMesh(this.root);
    if (this.globalMesh) trackedMeshes.add(this.globalMesh);

    const seenPlanes = new Set<Mesh>();
    const seenMeshes = new Set<Mesh>();
    this.root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const { xrPlane, xrMesh } = mesh.userData;
      if (xrPlane) {
        seenPlanes.add(mesh);
        let tracked = this.planes.get(mesh);
        if (!tracked) {
          tracked = createPlane(mesh, toLabel(xrPlane), this.planeMaterial);
          this.planes.set(mesh, tracked);
          this.planeOverlays.add(tracked.overlay);
        }
        updatePose(mesh, tracked);
        trackedPlanes.add(tracked.native);
      }
      if (xrMesh) {
        seenMeshes.add(mesh);
        let tracked = this.meshes.get(mesh);
        if (!tracked) {
          tracked = createMesh(mesh, toLabel(xrMesh), this.meshMaterial);
          this.meshes.set(mesh, tracked);
          this.meshOverlays.add(tracked.overlay);
        }
        updatePose(mesh, tracked);
        trackedMeshes.add(tracked.native);
      }
    });

    for (const [mesh, tracked] of this.planes) {
      if (seenPlanes.has(mesh)) continue;
      this.planes.delete(mesh);
      trackedPlanes.delete(tracked.native);
      removeOverlay(tracked);
    }
    for (const [mesh, tracked] of this.meshes) {
      if (seenMeshes.has(mesh)) continue;
      this.meshes.delete(mesh);
      trackedMeshes.delete(tracked.native);
      removeOverlay(tracked);
    }
  }
}

/** The material (of a hit face, when given) is visible and writes color. */
function surfaceMaterial(mesh: Mesh, materialIndex?: number) {
  const materials: Material[] = Array.isArray(mesh.material)
    ? materialIndex === undefined
      ? mesh.material
      : [mesh.material[materialIndex]]
    : [mesh.material];
  return materials.some((m) => m && m.visible && m.colorWrite);
}

/**
 * True if `object` is a real surface of the environment under `root`: it and
 * its ancestors up to `root` are visible, and its material is visible and
 * writes color. Invisible detection proxies (e.g. a furniture volume) and
 * shadow-only casters are not.
 */
export function isSurface(
  object: Object3D,
  root: Object3D,
  materialIndex?: number,
) {
  const mesh = object as Mesh;
  if (!mesh.isMesh || !surfaceMaterial(mesh, materialIndex)) return false;
  for (let o: Object3D | null = object; o; o = o.parent) {
    if (!o.visible) return false;
    if (o === root) return true;
  }
  return false;
}

/**
 * Quest-specific: besides the planes and volumes of a scanned room, Quest's
 * room setup reports a "global mesh", one triangle mesh of the whole room
 * (an XRMesh labelled 'global mesh'), and apps use it for physics and
 * occlusion. A scene environment has no scan, so its global mesh is the
 * scene's static geometry merged once, when the environment loads: every
 * surface (see isSurface), except objects (or their children) tagged
 * `userData.xrGlobalMesh = false`. Like a scan, it does not
 * follow objects that move later.
 */
function buildGlobalMesh(root: Object3D): NativeMesh | null {
  const positions: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();
  const matrix = new Matrix4();
  const instanceMatrix = new Matrix4();
  const excluded = (object: Object3D) => {
    for (let o: Object3D | null = object; o; o = o.parent) {
      if (o.userData.xrGlobalMesh === false) return true;
    }
    return false;
  };
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!isSurface(mesh, root) || excluded(mesh)) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const index = mesh.geometry.getIndex();
    const instanced = (mesh as InstancedMesh).isInstancedMesh
      ? (mesh as InstancedMesh)
      : null;
    for (let i = 0; i < (instanced ? instanced.count : 1); i++) {
      matrix.copy(mesh.matrixWorld);
      if (instanced) matrix.multiply(instanced.getMatrixAt(i, instanceMatrix));
      const base = positions.length / 3;
      for (let v = 0; v < position.count; v++) {
        point.fromBufferAttribute(position, v).applyMatrix4(matrix);
        positions.push(point.x, point.y, point.z);
      }
      const count = index ? index.count : position.count;
      for (let k = 0; k < count; k++) {
        indices.push(base + (index ? index.getX(k) : k));
      }
    }
  });
  if (!indices.length) return null;
  return new NativeMesh(
    new XRRigidTransform(),
    new Float32Array(positions),
    new Uint32Array(indices),
    XRSemanticLabels.GlobalMesh,
  );
}

function removeOverlay(tracked: Tracked<unknown>) {
  tracked.overlay.removeFromParent();
  tracked.overlay.geometry.dispose();
}

function overlayMesh(
  geometry: BufferGeometry,
  material: MeshBasicMaterial,
  pose: Matrix4,
) {
  const overlay = new Mesh(geometry, material);
  overlay.raycast = () => {}; // debug only: not hit-testable
  overlay.matrixAutoUpdate = false;
  overlay.matrix.copy(pose);
  return overlay;
}

function toLabel(value: unknown): XRSemanticLabels {
  if (typeof value === 'string' && labels.has(value)) {
    return value as XRSemanticLabels;
  }
  if (value !== true) {
    console.warn(`Unknown semantic label ${String(value)}, using 'other'`);
  }
  return XRSemanticLabels.Other;
}

/** Rigid world pose of `mesh` composed with its local `frame`. */
function worldPose(mesh: Mesh, frame: Matrix4, target: Matrix4) {
  tempMatrix.multiplyMatrices(mesh.matrixWorld, frame);
  tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
  return target.compose(tempPosition, tempQuaternion, tempScale.set(1, 1, 1));
}

function toTransform(pose: Matrix4) {
  pose.decompose(tempPosition, tempQuaternion, tempScale);
  return new XRRigidTransform(
    { x: tempPosition.x, y: tempPosition.y, z: tempPosition.z, w: 1 },
    {
      x: tempQuaternion.x,
      y: tempQuaternion.y,
      z: tempQuaternion.z,
      w: tempQuaternion.w,
    },
  );
}

function updatePose(mesh: Mesh, tracked: Tracked<NativePlane | NativeMesh>) {
  const pose = worldPose(mesh, tracked.frame, tempPose);
  if (pose.equals(tracked.pose)) return;
  tracked.pose.copy(pose);
  tracked.overlay.matrix.copy(pose);
  tracked.native.transform = toTransform(pose);
}

function createPlane(
  mesh: Mesh,
  label: XRSemanticLabels,
  material: MeshBasicMaterial,
): Tracked<NativePlane> {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox as Box3;
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());

  const frame = new Matrix4().makeTranslation(center.x, center.y, center.z);
  if (size.x <= size.y && size.x <= size.z) frame.multiply(yToX);
  else if (size.z < size.y) frame.multiply(yToZ);

  // The frame is axis-aligned with the box, so the box in pose space is the
  // plane rectangle (with ~zero height along the normal).
  const pose = worldPose(mesh, frame, new Matrix4());
  const { min, max } = box
    .clone()
    .applyMatrix4(pose.clone().invert().multiply(mesh.matrixWorld));
  const polygon = [
    new DOMPointReadOnly(min.x, 0, min.z),
    new DOMPointReadOnly(max.x, 0, min.z),
    new DOMPointReadOnly(max.x, 0, max.z),
    new DOMPointReadOnly(min.x, 0, max.z),
    new DOMPointReadOnly(min.x, 0, min.z),
  ];

  // Shape XY maps to plane XZ after rotating -90 degrees about X.
  const shape = new Shape(
    polygon.slice(0, -1).map((p) => new Vector2(p.x, -p.z)),
  );
  const outline = new ShapeGeometry(shape).rotateX(-Math.PI / 2);
  return {
    native: new NativePlane(toTransform(pose), polygon, label),
    frame,
    pose,
    overlay: overlayMesh(outline, material, pose),
  };
}

function createMesh(
  mesh: Mesh,
  label: XRSemanticLabels,
  material: MeshBasicMaterial,
): Tracked<NativeMesh> {
  const frame = new Matrix4();
  const pose = worldPose(mesh, frame, new Matrix4());
  const toPose = pose.clone().invert().multiply(mesh.matrixWorld);

  const position = mesh.geometry.getAttribute('position');
  const vertices = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    tempVector.fromBufferAttribute(position, i).applyMatrix4(toPose);
    tempVector.toArray(vertices, i * 3);
  }
  const index = mesh.geometry.getIndex();
  const indices = index
    ? Uint32Array.from(index.array)
    : Uint32Array.from({ length: position.count }, (_, i) => i);

  const outline = new BufferGeometry();
  outline.setAttribute('position', new BufferAttribute(vertices, 3));
  outline.setIndex(new BufferAttribute(indices, 1));
  return {
    native: new NativeMesh(toTransform(pose), vertices, indices, label),
    frame,
    pose,
    overlay: overlayMesh(outline, material, pose),
  };
}
