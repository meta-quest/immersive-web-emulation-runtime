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

export class TriangleMeshComponent extends SpatialEntityComponent {
  private _vertices: Float32Array;
  private _indices: number[];
  private _polygonCount: number = 0;
  private _vertexCount: number = 0;
  private _dimensions: Vector3 = { x: 0, y: 0, z: 0 };
  type = SpatialEntityComponentType.TriangleMesh;

  constructor(spatialEntity: Mesh, initData: TriangleMeshMETA) {
    super(spatialEntity);
    const { vertices, indices } = initData;
    const indicesArray = new Uint32Array(indices.buffer);
    // Keep the decoded vertex positions as a flat Float32Array and feed it
    // straight into the position BufferAttribute; materialize Vector3 objects
    // only where consumers actually need them (initData).
    this._vertices = new Float32Array(vertices.buffer);
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
    geometry.setAttribute('position', new BufferAttribute(this._vertices, 3));
    // Indices are decoded as Uint32; pick a 16- or 32-bit index buffer based on
    // the max index so meshes with >65535 vertices aren't silently truncated.
    const maxIndex = this._indices.reduce((max, i) => (i > max ? i : max), 0);
    const indexArray =
      maxIndex < 65536
        ? new Uint16Array(this._indices)
        : new Uint32Array(this._indices);
    geometry.setIndex(new BufferAttribute(indexArray, 1));
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
    const vertices: Vector3[] = [];
    for (let i = 0; i < this._vertices.length / 3; i++) {
      vertices.push({
        x: this._vertices[3 * i],
        y: this._vertices[3 * i + 1],
        z: this._vertices[3 * i + 2],
      });
    }
    return {
      vertices,
      indices: this._indices,
    };
  }

  get pbData() {
    const indicesArray = new Uint32Array(this._indices);
    return {
      vertices: new Uint8Array(this._vertices.buffer),
      indices: new Uint8Array(indicesArray.buffer),
    } as TriangleMeshMETA;
  }
}
