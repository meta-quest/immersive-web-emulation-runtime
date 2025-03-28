import {
	SpatialEntityComponent,
	SpatialEntityComponentType,
} from './component.js';

import { Mesh } from 'three';
import { Pose } from '../../generated/protos/openxr_core.js';

export class LocatableComponent extends SpatialEntityComponent {
	type = SpatialEntityComponentType.Locatable;

	constructor(spatialEntity: Mesh, initData: Pose) {
		super(spatialEntity);
		if (initData.position) {
			this.position.copy(initData.position);
		}
		if (initData.orientation) {
			this.orientation.copy(initData.orientation);
		}
	}

	get position() {
		return this._spatialEntity.position;
	}

	get rotation() {
		return this._spatialEntity.rotation;
	}

	get orientation() {
		return this._spatialEntity.quaternion;
	}

	get initData() {
		return {
			position: {
				x: this.position.x,
				y: this.position.y,
				z: this.position.z,
			},
			orientation: {
				x: this.orientation.x,
				y: this.orientation.y,
				z: this.orientation.z,
				w: this.orientation.w,
			},
		};
	}

	get pbData() {
		return {
			position: {
				x: this._spatialEntity.position.x,
				y: this._spatialEntity.position.y,
				z: this._spatialEntity.position.z,
			},
			orientation: {
				x: this._spatialEntity.quaternion.x,
				y: this._spatialEntity.quaternion.y,
				z: this._spatialEntity.quaternion.z,
				w: this._spatialEntity.quaternion.w,
			},
		} as Pose;
	}
}
