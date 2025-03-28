import { Mesh, MeshMatcapMaterial } from 'three';
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

export class SpatialEntity extends Mesh {
	public name = 'generic spatial entity';
	public isSpatialEntity = true;
	private _spatialUUID: string;
	private _componentMap: Map<
		SpatialEntityComponentType,
		SpatialEntityComponent
	> = new Map();
	private _nativeEntity: NativePlane | NativeMesh | undefined;

	constructor(uuid: string = generateUUID()) {
		super(
			undefined,
			new MeshMatcapMaterial({
				color: 0xffffff * Math.random(),
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
				const polygon: DOMPointReadOnly[] = [
					new DOMPointReadOnly(offset.x, 0, offset.y),
					new DOMPointReadOnly(offset.x + extent.x, 0, offset.y),
					new DOMPointReadOnly(offset.x + extent.x, 0, offset.y + extent.y),
					new DOMPointReadOnly(offset.x, 0, offset.y + extent.y),
					new DOMPointReadOnly(offset.x, 0, offset.y),
				];
				this._nativeEntity = new NativePlane(
					xrRigidTransform,
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
				this._nativeEntity = new NativeMesh(
					xrRigidTransform,
					vertices,
					indices,
					semanticLabel,
				);
			}
		}
		return this._nativeEntity;
	}

	static fromPBJSON(json: any) {
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
			} else if (pbEntity.bounded3D_META) {
				spatialEntity.addComponent(
					SpatialEntityComponentType.Bounded3D,
					pbEntity.bounded3D_META,
				);
			} else if (pbEntity.triangleMesh_META) {
				spatialEntity.addComponent(
					SpatialEntityComponentType.TriangleMesh,
					pbEntity.triangleMesh_META,
				);
			}
			return spatialEntity;
		}
		return;
	}

	get entityType() {
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
