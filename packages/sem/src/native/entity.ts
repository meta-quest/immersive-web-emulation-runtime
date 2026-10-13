import { Mesh, MeshMatcapMaterial, Quaternion } from 'three';
import {
  NativeMesh,
  NativePlane,
  XRRigidTransform,
  XRSemanticLabels,
} from 'iwer';
import {
  SpatialEntity as PBSpatialEntity,
  SemanticLabelMETA,
} from '../generated/protos/openxr_scene.js';
import {
  SpatialEntityComponent,
  SpatialEntityComponentType,
} from './components/component.js';

import { Bounded2DComponent } from './components/bounded2d.js';
import { Bounded3DComponent } from './components/bounded3d.js';
import { LocatableComponent } from './components/locatable.js';
import { SemanticLabelComponent } from './components/semanticlabel.js';
import { TriangleMeshComponent } from './components/trianglemesh.js';
import { generateUUID } from 'three/src/math/MathUtils.js';

export enum SpatialEntityType {
  Plane = 'plane',
  Box = 'box',
  Mesh = 'mesh',
}

// Derive a stable 24-bit color from a string (the entity's spatialUUID or
// semantic label) so material colors are deterministic across loads and
// screenshots are reproducible. Replaces the previous Math.random() source.
const colorFromString = (source: string): number => {
  // djb2 string hash → 32-bit unsigned.
  let hash = 5381;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 33) ^ source.charCodeAt(i);
  }
  return (hash >>> 0) & 0xffffff;
};

const WebXRSemanticLabelMap: Record<SemanticLabelMETA, XRSemanticLabels> = {
  [SemanticLabelMETA.OTHER]: XRSemanticLabels.Other,
  [SemanticLabelMETA.TABLE]: XRSemanticLabels.Table,
  [SemanticLabelMETA.COUCH]: XRSemanticLabels.Couch,
  [SemanticLabelMETA.FLOOR]: XRSemanticLabels.Floor,
  [SemanticLabelMETA.CEILING]: XRSemanticLabels.Ceiling,
  [SemanticLabelMETA.WALL_FACE]: XRSemanticLabels.Wall,
  [SemanticLabelMETA.INVISIBLE_WALL_FACE]: XRSemanticLabels.Window,
  [SemanticLabelMETA.INNER_WALL_FACE]: XRSemanticLabels.Wall,
  [SemanticLabelMETA.DOOR_FRAME]: XRSemanticLabels.Door,
  [SemanticLabelMETA.WINDOW_FRAME]: XRSemanticLabels.Window,
  [SemanticLabelMETA.WALL_ART]: XRSemanticLabels.WallArt,
  [SemanticLabelMETA.STORAGE]: XRSemanticLabels.Shelf,
  [SemanticLabelMETA.BED]: XRSemanticLabels.Bed,
  [SemanticLabelMETA.LAMP]: XRSemanticLabels.Lamp,
  [SemanticLabelMETA.SCREEN]: XRSemanticLabels.Screen,
  [SemanticLabelMETA.PLANT]: XRSemanticLabels.Plant,
  [SemanticLabelMETA.GLOBAL_MESH]: XRSemanticLabels.GlobalMesh,
  [SemanticLabelMETA.CHAIR]: XRSemanticLabels.Couch,
  [SemanticLabelMETA.UNKNOWN]: XRSemanticLabels.Other,
  [SemanticLabelMETA.OTHER_ROOM_FACE]: XRSemanticLabels.Other,
  [SemanticLabelMETA.OPENING]: XRSemanticLabels.Other,
  [SemanticLabelMETA.UNRECOGNIZED]: XRSemanticLabels.Other,
};

const halfTurnX = new Quaternion(1, 0, 0, 0);

export class SpatialEntity extends Mesh {
  public name = 'generic spatial entity';
  public isSpatialEntity = true;
  private _spatialUUID: string;
  private _componentMap: Map<
    SpatialEntityComponentType,
    SpatialEntityComponent
  > = new Map();
  private _nativeEntity: NativePlane | NativeMesh | undefined;
  private _entityType: SpatialEntityType | undefined;

  constructor(uuid: string = generateUUID()) {
    super(
      undefined,
      new MeshMatcapMaterial({
        // Deterministic per-entity color derived from the uuid, so repeated
        // loads of the same scene produce identical screenshots. The
        // TriangleMesh component still overrides this with a fixed color.
        color: colorFromString(uuid),
        flatShading: true,
      }),
    );
    this._spatialUUID = uuid;
  }

  get spatialUUID() {
    return this._spatialUUID;
  }

  updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
  }

  addComponent(componentType: SpatialEntityComponentType, initData: any) {
    let component: SpatialEntityComponent | null = null;
    switch (componentType) {
      case SpatialEntityComponentType.Locatable:
        component = new LocatableComponent(this, initData);
        break;
      case SpatialEntityComponentType.Bounded3D:
        component = new Bounded3DComponent(this, initData);
        break;
      case SpatialEntityComponentType.Bounded2D:
        component = new Bounded2DComponent(this, initData);
        break;
      case SpatialEntityComponentType.TriangleMesh:
        component = new TriangleMeshComponent(this, initData);
        break;
      case SpatialEntityComponentType.SemanticLabel:
        component = new SemanticLabelComponent(this, initData);
        break;
    }
    if (component) {
      this._componentMap.set(componentType, component);
    }
  }

  getComponent(componentType: SpatialEntityComponentType) {
    return this._componentMap.get(componentType);
  }

  duplicate() {
    const clone = new SpatialEntity();
    this._componentMap.forEach((component, _k, _m) => {
      clone.addComponent(component.type, component.initData);
    });
    return clone;
  }

  get nativeEntity() {
    if (!this._nativeEntity) {
      const xrRigidTransform = new XRRigidTransform(
        {
          x: this.position.x,
          y: this.position.y,
          z: this.position.z,
          w: 1,
        },
        {
          x: this.quaternion.x,
          y: this.quaternion.y,
          z: this.quaternion.z,
          w: this.quaternion.w,
        },
      );
      const semanticLabel =
        WebXRSemanticLabelMap[
          (
            this.getComponent(
              SpatialEntityComponentType.SemanticLabel,
            ) as SemanticLabelComponent
          ).semanticLabel
        ];

      if (this.entityType === SpatialEntityType.Plane) {
        const { offset, extent } = this.getComponent(
          SpatialEntityComponentType.Bounded2D,
        ) as Bounded2DComponent;
        // Captured plane poses have local -Y facing into the room, but WebXR
        // plane space +Y is the plane normal. Report the pose turned half a
        // turn about X, with the polygon mirrored (and reversed to keep its
        // winding) so its footprint is unchanged.
        const flipped = this.quaternion.clone().multiply(halfTurnX);
        const planeTransform = new XRRigidTransform(
          { x: this.position.x, y: this.position.y, z: this.position.z, w: 1 },
          { x: flipped.x, y: flipped.y, z: flipped.z, w: flipped.w },
        );
        const [x0, x1] = [offset.x, offset.x + extent.x];
        const [z0, z1] = [-offset.y, -(offset.y + extent.y)];
        const polygon: DOMPointReadOnly[] = [
          new DOMPointReadOnly(x0, 0, z0),
          new DOMPointReadOnly(x0, 0, z1),
          new DOMPointReadOnly(x1, 0, z1),
          new DOMPointReadOnly(x1, 0, z0),
          new DOMPointReadOnly(x0, 0, z0),
        ];
        this._nativeEntity = new NativePlane(
          planeTransform,
          polygon,
          semanticLabel,
        );
      } else if (
        this.entityType === SpatialEntityType.Box ||
        this.entityType === SpatialEntityType.Mesh
      ) {
        const vertices = this.geometry.getAttribute('position')
          .array as Float32Array;
        const indices = new Uint32Array(this.geometry.index!.array);
        // Quest only exposes a triangle mesh for the room's global mesh; one
        // capture (office_large) labels it UNRECOGNIZED.
        const label =
          this.entityType === SpatialEntityType.Mesh
            ? XRSemanticLabels.GlobalMesh
            : semanticLabel;
        this._nativeEntity = new NativeMesh(
          xrRigidTransform,
          vertices,
          indices,
          label,
        );
      }
    }
    return this._nativeEntity;
  }

  static fromPBJSON(json: PBSpatialEntity) {
    const pbEntity = PBSpatialEntity.fromJSON(json);
    if (pbEntity.locatable_META) {
      const spatialEntity = new SpatialEntity(pbEntity.uuid);
      spatialEntity.addComponent(
        SpatialEntityComponentType.Locatable,
        pbEntity.locatable_META,
      );
      if (pbEntity.semanticLabel_META) {
        spatialEntity.addComponent(
          SpatialEntityComponentType.SemanticLabel,
          pbEntity.semanticLabel_META,
        );
      }
      if (pbEntity.bounded2D_META) {
        spatialEntity.addComponent(
          SpatialEntityComponentType.Bounded2D,
          pbEntity.bounded2D_META,
        );
        spatialEntity._entityType = SpatialEntityType.Plane;
      } else if (pbEntity.bounded3D_META) {
        spatialEntity.addComponent(
          SpatialEntityComponentType.Bounded3D,
          pbEntity.bounded3D_META,
        );
        spatialEntity._entityType = SpatialEntityType.Box;
      } else if (pbEntity.triangleMesh_META) {
        spatialEntity.addComponent(
          SpatialEntityComponentType.TriangleMesh,
          pbEntity.triangleMesh_META,
        );
        spatialEntity._entityType = SpatialEntityType.Mesh;
      }
      return spatialEntity;
    }
    return;
  }

  get entityType() {
    // Resolved once in fromPBJSON; fall back to component lookups for entities
    // constructed via other paths (e.g. duplicate()).
    if (this._entityType !== undefined) {
      return this._entityType;
    }
    if (this.getComponent(SpatialEntityComponentType.Bounded2D)) {
      return SpatialEntityType.Plane;
    } else if (this.getComponent(SpatialEntityComponentType.Bounded3D)) {
      return SpatialEntityType.Box;
    } else if (this.getComponent(SpatialEntityComponentType.TriangleMesh)) {
      return SpatialEntityType.Mesh;
    }
    return;
  }

  static toPBJSON(entity: SpatialEntity) {
    const pbEntity: PBSpatialEntity = {
      uuid: entity.spatialUUID,
      locatable_META: entity.getComponent(SpatialEntityComponentType.Locatable)
        ?.pbData,
      boundary2D_META: undefined,
      bounded2D_META: entity.getComponent(SpatialEntityComponentType.Bounded2D)
        ?.pbData,
      bounded3D_META: entity.getComponent(SpatialEntityComponentType.Bounded3D)
        ?.pbData,
      semanticLabel_META: entity.getComponent(
        SpatialEntityComponentType.SemanticLabel,
      )?.pbData,
      roomLayout_META: undefined,
      spaceContainer_META: undefined,
      triangleMesh_META: entity.getComponent(
        SpatialEntityComponentType.TriangleMesh,
      )?.pbData,
      dynamicObject_META: undefined,
    };
    return pbEntity;
  }
}
