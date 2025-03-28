import { PlaneGeometry, Vector2 } from 'three';
import {
	SpatialEntityComponent,
	SpatialEntityComponentType,
} from './component.js';

import { Rect2D } from '../../generated/protos/openxr_core.js';
import { SpatialEntity } from '../entity.js';

export class Bounded2DComponent extends SpatialEntityComponent {
	private _offset: Vector2 = new Vector2();
	private _extent: Vector2 = new Vector2();
	type = SpatialEntityComponentType.Bounded2D;

	constructor(spatialEntity: SpatialEntity, initData: Rect2D) {
		super(spatialEntity);
		const { offset, extent } = initData;
		this._offset.set(offset!.x, offset!.y);
		this._extent.set(extent!.width, extent!.height);
		this.buildGeometry();
	}

	buildGeometry() {
		const geometry = new PlaneGeometry(this._extent.x, this._extent.y);
		geometry.translate(
			this._offset.x + this._extent.x / 2,
			this._offset.y + this._extent.y / 2,
			0,
		);
		geometry.rotateX(Math.PI / 2);
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

	get pbData(): Rect2D {
		return {
			offset: { x: this._offset.x, y: this._offset.y },
			extent: { width: this._extent.x, height: this._extent.y },
		} as Rect2D;
	}
}
