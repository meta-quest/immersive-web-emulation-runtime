import {
	BufferAttribute,
	BufferGeometry,
	Mesh,
	MeshBasicMaterial,
} from 'three';
import {
	SpatialEntityComponent,
	SpatialEntityComponentType,
} from './component.js';

import { TriangleMeshMETA } from '../../generated/protos/openxr_scene.js';
import { Vector3 } from '../../generated/protos/openxr_core.js';

function vec3ArrayToFloat32Array(arr: Vector3[]): Float32Array {
	const result = new Float32Array(arr.length * 3);
	let index = 0;
	for (const vec of arr) {
		result[index++] = vec.x;
		result[index++] = vec.y;
		result[index++] = vec.z;
	}
	return result;
}

export class TriangleMeshComponent extends SpatialEntityComponent {
	private _vertices: Vector3[];
	private _indices: number[];
	private _polygonCount: number = 0;
	private _vertexCount: number = 0;
	private _dimensions: Vector3 = { x: 0, y: 0, z: 0 };
	type = SpatialEntityComponentType.TriangleMesh;

	constructor(spatialEntity: Mesh, initData: TriangleMeshMETA) {
		super(spatialEntity);
		const { vertices, indices } = initData;
		const verticesArray = new Float32Array(vertices.buffer);
		const indicesArray = new Uint32Array(indices.buffer);
		const vec3Array = [];
		for (let i = 0; i < verticesArray.length / 3; i++) {
			vec3Array.push({
				x: verticesArray[3 * i],
				y: verticesArray[3 * i + 1],
				z: verticesArray[3 * i + 2],
			});
		}
		this._vertices = vec3Array;
		this._indices = [...indicesArray];
		this.buildGeometry();
		const material = spatialEntity.material as MeshBasicMaterial;
		material.polygonOffset = true;
		material.polygonOffsetFactor = 1;
		material.polygonOffsetUnits = 0.005;
		material.color.setHex(0xd4d4d4);
		spatialEntity.renderOrder = 999;
	}

	private buildGeometry() {
		const geometry = new BufferGeometry();
		const vertices = vec3ArrayToFloat32Array(this._vertices);
		geometry.setAttribute('position', new BufferAttribute(vertices, 3));
		geometry.setIndex(new BufferAttribute(new Uint16Array(this._indices), 1));
		this._spatialEntity.geometry?.dispose();
		this._spatialEntity.geometry = geometry;
		geometry.computeVertexNormals();
		this._vertexCount = geometry.attributes.position.count;
		this._polygonCount = geometry.index
			? geometry.index.count / 3
			: this._vertexCount / 3;
		geometry.computeBoundingBox();
		const boundingBox = geometry.boundingBox!;
		this._dimensions = {
			x: boundingBox.max.x - boundingBox.min.x,
			y: boundingBox.max.y - boundingBox.min.y,
			z: boundingBox.max.z - boundingBox.min.z,
		};
	}

	get vertexCount() {
		return this._vertexCount;
	}

	get polygonCount() {
		return this._polygonCount;
	}

	get dimensions() {
		return this._dimensions;
	}

	get initData() {
		return {
			vertices: this._vertices,
			indices: this._indices,
		};
	}

	get pbData() {
		const verticesArray = vec3ArrayToFloat32Array(this._vertices);
		const indicesArray = new Uint32Array(this._indices);
		return {
			vertices: new Uint8Array(verticesArray.buffer),
			indices: new Uint8Array(indicesArray.buffer),
		} as TriangleMeshMETA;
	}
}
