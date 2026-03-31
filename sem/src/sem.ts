/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	Camera,
	Color,
	GridHelper,
	Group,
	Matrix3,
	Matrix4,
	MeshDepthMaterial,
	Object3D,
	PerspectiveCamera,
	Quaternion,
	RGBADepthPacking,
	Raycaster,
	Scene,
	Vector3,
	WebGLRenderer,
	WebGLRenderTarget,
} from 'three';
import { NativeMesh, NativePlane, XRDevice } from 'iwer';
import { SpatialEntity, SpatialEntityType } from './native/entity.js';

import { Environments } from './registry.js';
import { Scene as SceneFile } from './generated/protos/openxr_scene.js';
import { VERSION } from './version.js';
import { mat4 } from 'gl-matrix';

const forwardVector = new Vector3(0, 0, -1);

export class SyntheticEnvironmentModule extends EventTarget {
	public readonly trackedPlanes: Set<NativePlane> = new Set();
	public readonly trackedMeshes: Set<NativeMesh> = new Set();
	public readonly version = VERSION;

	private renderer: WebGLRenderer;
	private scene: Scene;
	private camera: PerspectiveCamera;
	private objectMap: Map<string, SpatialEntity> = new Map();
	private planes = new Group();
	private boxes = new Group();
	private meshes = new Group();
	private tempPosition = new Vector3();
	private tempQuaternion = new Quaternion();
	private tempDirection = new Vector3();
	private tempScale = new Vector3();
	private tempMatrix = new Matrix4();
	private raycaster = new Raycaster();
	private hitTestTarget = new Group();
	private hitTestMarker = new Object3D();
	private worldNormal = new Vector3();
	private normalMatrix = new Matrix3();

	// Depth sensing
	private depthRenderTarget: WebGLRenderTarget | null = null;
	private depthMaterial = new MeshDepthMaterial({
		depthPacking: RGBADepthPacking,
	});
	private depthCamera: Camera;
	private depthReadBuffer: Uint8Array | null = null;

	constructor(private xrDevice: XRDevice) {
		super();
		this.scene = new Scene();
		this.scene.background = new Color(0x3e3e3e);
		this.camera = new PerspectiveCamera(
			50,
			window.innerWidth / window.innerHeight,
			0.1,
			40,
		);
		this.camera.position.set(0, 1.6, 5);

		const gridHelper = new GridHelper(50, 50);
		this.scene.add(gridHelper);

		this.scene.add(this.planes, this.boxes, this.meshes);
		this.planes.renderOrder = 1;
		this.boxes.renderOrder = 2;
		this.meshes.renderOrder = 3;
		this.planes.visible = false;
		this.boxes.visible = false;

		this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.renderer.domElement.style.position = 'fixed';
		this.renderer.domElement.style.top = '50vh';
		this.renderer.domElement.style.left = '50vw';
		this.renderer.domElement.style.transform = 'translate(-50%, -50%)';

		this.hitTestTarget.add(this.hitTestMarker);
		this.hitTestMarker.rotateX(Math.PI / 2);

		this.depthCamera = new Camera();
		this.depthCamera.matrixWorldAutoUpdate = false;
		this.depthCamera.matrixAutoUpdate = false;
	}

	get environmentCanvas() {
		return this.renderer.domElement;
	}

	get planesVisible() {
		return this.planes.visible;
	}

	set planesVisible(visible: boolean) {
		this.planes.visible = visible;
	}

	get boundingBoxesVisible() {
		return this.boxes.visible;
	}

	set boundingBoxesVisible(visible: boolean) {
		this.boxes.visible = visible;
	}

	get meshesVisible() {
		return this.meshes.visible;
	}

	set meshesVisible(visible: boolean) {
		this.meshes.visible = visible;
	}

	render() {
		this.camera.position.copy(this.xrDevice.position);
		this.camera.quaternion.copy(this.xrDevice.quaternion);
		const xrDeviceFOV = (this.xrDevice.fovy / Math.PI) * 180;
		let cameraMatrixNeedsUpdate = false;
		if (this.camera.fov !== xrDeviceFOV) {
			this.camera.fov = xrDeviceFOV;
			cameraMatrixNeedsUpdate = true;
		}
		const iwerCanvasDimension = this.xrDevice.canvasDimensions;
		if (iwerCanvasDimension) {
			const canvas = this.renderer.domElement;
			const resizeNeeded =
				canvas.width !== iwerCanvasDimension.width ||
				canvas.height !== iwerCanvasDimension.height;
			if (resizeNeeded) {
				this.camera.aspect =
					iwerCanvasDimension.width / iwerCanvasDimension.height;
				this.renderer.setSize(
					iwerCanvasDimension.width,
					iwerCanvasDimension.height,
				);
				cameraMatrixNeedsUpdate = true;
			}
		}
		if (cameraMatrixNeedsUpdate) {
			this.camera.updateProjectionMatrix();
		}
		this.renderer.render(this.scene, this.camera);
	}

	deleteAll() {
		[...this.objectMap.values()].forEach((object) => {
			object.removeFromParent();
		});
		this.objectMap.clear();
		this.trackedMeshes.clear();
		this.trackedPlanes.clear();
	}

	loadEnvironment(json: any) {
		this.deleteAll();
		(json as SceneFile).spatialEntities.forEach((spatialEntityJSON) => {
			const spatialEntity = SpatialEntity.fromPBJSON(spatialEntityJSON);
			if (spatialEntity) {
				switch (spatialEntity.entityType) {
					case SpatialEntityType.Box:
						this.boxes.add(spatialEntity);
						this.trackedMeshes.add(spatialEntity.nativeEntity as NativeMesh);
						break;
					case SpatialEntityType.Plane:
						this.planes.add(spatialEntity);
						this.trackedPlanes.add(spatialEntity.nativeEntity as NativePlane);
						break;
					case SpatialEntityType.Mesh:
						this.meshes.add(spatialEntity);
						this.trackedMeshes.add(spatialEntity.nativeEntity as NativeMesh);
						break;
				}
				const oldMesh = this.objectMap.get(spatialEntityJSON.uuid);
				if (oldMesh) {
					oldMesh.removeFromParent();
				}
				this.objectMap.set(spatialEntityJSON.uuid, spatialEntity);
			}
		});
	}

	loadDefaultEnvironment(envId: string) {
		if (typeof __IS_UMD__ !== 'undefined' && __IS_UMD__) {
			// Use fetch for UMD builds to load JSON from CDN
			const url = `https://www.unpkg.com/@iwer/sem@${VERSION}/captures/${envId}.json`;
			fetch(url)
				.then((response) => {
					if (!response.ok) {
						throw new Error(
							`Network response was not ok: ${response.statusText}`,
						);
					}
					return response.json();
				})
				.then((envJson) => {
					this.loadEnvironment(envJson);
				})
				.catch((error) => {
					console.error(`Error loading environment ${envId} from CDN`, error);
				});
		} else {
			// Use dynamic import for ES builds
			const importEnv = Environments[envId];
			if (!importEnv) {
				console.error(`Requested environment ${envId} does not exist`);
				return;
			}
			importEnv()
				.then((module) => {
					const envJson = module.default;
					this.loadEnvironment(envJson);
				})
				.catch((error) => {
					console.error(`Error loading environment ${envId} locally`, error);
				});
		}
	}

	computeHitTestResults(mat4: mat4) {
		this.tempMatrix.fromArray(mat4);
		this.tempMatrix.decompose(
			this.tempPosition,
			this.tempQuaternion,
			this.tempScale,
		);

		this.tempDirection
			.copy(forwardVector)
			.applyQuaternion(this.tempQuaternion)
			.normalize();
		this.raycaster.set(this.tempPosition, this.tempDirection);
		const intersections = this.raycaster.intersectObject(this.meshes, true);
		const results = intersections.map((intersection) => {
			const point = intersection.point;
			this.hitTestTarget.position.copy(point);
			if (intersection.face?.normal) {
				this.worldNormal.copy(intersection.face.normal);
				const object = intersection.object;
				this.worldNormal
					.applyMatrix3(this.normalMatrix.getNormalMatrix(object.matrixWorld))
					.normalize();
				this.hitTestTarget.lookAt(
					this.tempPosition.addVectors(point, this.worldNormal),
				);
			} else {
				this.hitTestTarget.quaternion.set(0, 0, 0, 1);
			}
			this.hitTestTarget.updateMatrixWorld(true);
			return this.hitTestMarker.matrixWorld.toArray();
		});

		return results;
	}

	computeDepthBuffer(
		viewMatrix: mat4,
		projectionMatrix: mat4,
		width: number,
		height: number,
		depthNear: number,
		depthFar: number,
	): { data: ArrayBuffer; width: number; height: number; rawValueToMeters: number } | null {
		if (this.trackedMeshes.size === 0) {
			return null;
		}

		// Create or resize render target
		if (
			!this.depthRenderTarget ||
			this.depthRenderTarget.width !== width ||
			this.depthRenderTarget.height !== height
		) {
			this.depthRenderTarget?.dispose();
			this.depthRenderTarget = new WebGLRenderTarget(width, height);
			this.depthReadBuffer = new Uint8Array(width * height * 4);
		}

		// Set up depth camera from view & projection matrices
		this.depthCamera.matrixWorldInverse.fromArray(viewMatrix);
		this.depthCamera.matrixWorld.copy(
			this.depthCamera.matrixWorldInverse,
		).invert();
		this.depthCamera.projectionMatrix.fromArray(projectionMatrix);
		this.depthCamera.projectionMatrixInverse.copy(
			this.depthCamera.projectionMatrix,
		).invert();

		// Save visibility state and force environment geometry visible for depth
		const prevMeshesVisible = this.meshes.visible;
		const prevBoxesVisible = this.boxes.visible;
		this.meshes.visible = true;
		this.boxes.visible = true;

		// Render with depth material into the render target
		const prevOverrideMaterial = this.scene.overrideMaterial;
		const prevBackground = this.scene.background;
		this.scene.overrideMaterial = this.depthMaterial;
		this.scene.background = null;

		this.renderer.setRenderTarget(this.depthRenderTarget);
		this.renderer.clear();
		this.renderer.render(this.scene, this.depthCamera);
		this.renderer.setRenderTarget(null);

		this.scene.overrideMaterial = prevOverrideMaterial;
		this.scene.background = prevBackground;

		// Restore visibility state
		this.meshes.visible = prevMeshesVisible;
		this.boxes.visible = prevBoxesVisible;

		// Read back RGBA pixels (depth encoded via RGBADepthPacking)
		this.renderer.readRenderTargetPixels(
			this.depthRenderTarget,
			0,
			0,
			width,
			height,
			this.depthReadBuffer!,
		);

		// Output as float32 (one depth-in-meters value per pixel)
		const depthRange = depthFar - depthNear;
		const rawValueToMeters = 1.0; // float32 values are already in meters
		const outputBuffer = new ArrayBuffer(width * height * 4); // 4 bytes per float
		const output = new Float32Array(outputBuffer);
		const rgba = this.depthReadBuffer!;

		for (let row = 0; row < height; row++) {
			// Flip vertically: readRenderTargetPixels returns bottom-to-top rows,
			// but view coordinates expect top-to-bottom
			const srcRow = height - 1 - row;
			for (let col = 0; col < width; col++) {
				const srcIdx = srcRow * width + col;
				const dstIdx = row * width + col;

				const r = rgba[srcIdx * 4] / 255;
				const g = rgba[srcIdx * 4 + 1] / 255;
				const b = rgba[srcIdx * 4 + 2] / 255;
				const a = rgba[srcIdx * 4 + 3] / 255;

				// Decode depth from RGBA packing — this is gl_FragCoord.z (0..1)
				const normalizedDepth = r + g / 256 + b / 65536 + a / 16777216;

				// Convert from non-linear gl_FragCoord.z to linear eye-space depth
				let depthMeters: number;
				if (normalizedDepth >= 1.0) {
					depthMeters = depthFar;
				} else if (normalizedDepth <= 0.0) {
					depthMeters = depthFar; // no geometry hit → treat as far plane
				} else {
					depthMeters = (depthNear * depthFar) / (depthFar - normalizedDepth * depthRange);
				}

				output[dstIdx] = depthMeters;
			}
		}

		return {
			data: outputBuffer,
			width,
			height,
			rawValueToMeters,
		};
	}
}
