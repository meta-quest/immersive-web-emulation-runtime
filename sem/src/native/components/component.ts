import { Mesh } from 'three';

export enum SpatialEntityComponentType {
	Locatable = 'locatable',
	Bounded3D = 'bounded3D',
	Bounded2D = 'bounded2D',
	TriangleMesh = 'triangleMesh',
	SemanticLabels = 'semanticLabels',
}

export abstract class SpatialEntityComponent extends EventTarget {
	constructor(protected _spatialEntity: Mesh) {
		super();
	}
	abstract get initData(): any;
	abstract get pbData(): any;
	abstract type: SpatialEntityComponentType;
}
