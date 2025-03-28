import { BoxGeometry, Mesh, Vector3 } from 'three';
import {
	SpatialEntityComponent,
	SpatialEntityComponentType,
} from './component.js';

import { Rect3D } from '../../generated/protos/openxr_core.js';

export class Bounded3DComponent extends SpatialEntityComponent {
	private _offset: Vector3 = new Vector3();
	private _extent: Vector3 = new Vector3();
	type = SpatialEntityComponentType.Bounded3D;

	constructor(spatialEntity: Mesh, initData: Rect3D) {
		super(spatialEntity);
		const { offset, extent } = initData;
		this._offset.set(offset!.x, offset!.y, offset!.z);
		this._extent.set(extent!.width, extent!.height, extent!.depth);
		this.buildGeometry();
	}

	buildGeometry() {
		const geometry = new BoxGeometry(
			this._extent.x,
			this._extent.y,
			this._extent.z,
		);
		geometry.translate(
			this._offset.x + this._extent.x / 2,
			this._offset.y + this._extent.y / 2,
			this._offset.z + this._extent.z / 2,
		);
		this._spatialEntity.geometry?.dispose();
		this._spatialEntity.geometry = geometry;
	}

	get offset() {
		return this._offset;
	}

	get extent() {
		return this._extent;
	}

	get initData() {
		return {
			offset: this.offset,
			extent: this.extent,
		};
	}

	get pbData() {
		return {
			offset: { x: this._offset.x, y: this._offset.y, z: this._offset.z },
			extent: {
				width: this._extent.x,
				height: this._extent.y,
				depth: this._extent.z,
			},
		} as Rect3D;
	}
}
