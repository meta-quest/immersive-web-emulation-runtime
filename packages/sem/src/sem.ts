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
  LoadingManager,
  MathUtils,
  Matrix3,
  Matrix4,
  Mesh,
  NoToneMapping,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import type { ToneMapping } from 'three';
import { NativeMesh, NativePlane, XRDevice } from 'iwer';
import { SpatialEntity, SpatialEntityType } from './native/entity.js';
import {
  createEnvironmentDepthMaterial,
  perspectiveDepthToMeters,
  unpackRGBADepthBytes,
} from './depth-packing.js';

import { EnvironmentObject, SceneEnvironment } from './scene-environment.js';
import { Environments, captureIds } from './registry.js';
import { Scene as SceneFile } from './generated/protos/openxr_scene.js';
import { VERSION } from './version.js';
import { mat4 } from 'gl-matrix';

const forwardVector = new Vector3(0, 0, -1);
const defaultBackground = new Color(0x3e3e3e);
// Cap the per-frame delta so animations/physics don't jump after the tab was
// hidden.
const maxDeltaSeconds = 0.1;

// Root presentation profile of a GLTS scene (`scene.rendering`).
type RenderingProfile = {
  shadows?: boolean;
  toneMapping?: ToneMapping;
  toneMappingExposure?: number;
};
// Scratch Color reused to read back the renderer's clear color before depth
// passes. getClearColor() copies into this and the value is consumed (restored
// via setClearColor) within the same call, so it never escapes to callers.
const tempClearColor = new Color();

// Mirrors iwer's XRHitTestTrackableType. Declared locally because iwer does not
// re-export the type from its package entry point.
type HitTestTrackableType = 'point' | 'plane' | 'mesh';

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
  private grid = new GridHelper(50, 50);
  private sceneEnvironment: SceneEnvironment | null = null;
  private lastRenderTime: number | null = null;
  private addedEnvironments = new Map<string, string | URL>();
  // Bumped whenever the environment changes, so a slow load that finishes
  // after a newer one is dropped.
  private loadId = 0;
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
  private depthMaterial = createEnvironmentDepthMaterial();
  private depthCamera: Camera;
  private _tempMatrix = new Matrix4();
  private depthReadBuffer: Uint8Array | null = null;

  constructor(private xrDevice: XRDevice) {
    super();
    this.scene = new Scene();
    this.scene.background = defaultBackground;
    this.camera = new PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      40,
    );
    this.camera.position.set(0, 1.6, 5);

    this.scene.add(this.grid);

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
    // Sprites in a scene environment need a camera to be raycast.
    this.raycaster.camera = this.camera;
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

  render(time: number) {
    const environment = this.sceneEnvironment;
    if (environment) {
      // Clamped: time can also jump backwards, e.g. across XR sessions.
      const delta = MathUtils.clamp(
        (time - (this.lastRenderTime ?? time)) / 1000,
        0,
        maxDeltaSeconds,
      );
      environment.update(delta, this.trackedPlanes, this.trackedMeshes);
      const root = environment.root as Partial<Scene> & {
        rendering?: RenderingProfile;
      };
      this.scene.background = root.background ?? defaultBackground;
      this.scene.environment = root.environment ?? null;
      this.scene.fog = root.fog ?? null;
      this.applyRendering(root.rendering);
    }
    this.lastRenderTime = time;

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
    this.loadId++;
    [...this.objectMap.values()].forEach((object) => {
      object.removeFromParent();
    });
    this.objectMap.clear();
    this.trackedMeshes.clear();
    this.trackedPlanes.clear();
    this.sceneEnvironment?.dispose();
    this.sceneEnvironment = null;
    this.grid.visible = true;
    this.scene.background = defaultBackground;
    this.scene.environment = null;
    this.scene.fog = null;
    this.applyRendering(undefined);
  }

  private applyRendering(rendering?: RenderingProfile) {
    this.renderer.shadowMap.enabled = rendering?.shadows ?? false;
    this.renderer.toneMapping = rendering?.toneMapping ?? NoToneMapping;
    this.renderer.toneMappingExposure = rendering?.toneMappingExposure ?? 1;
  }

  /** Environment ids: the built-in captures plus added ones. */
  get environments(): string[] {
    return [...captureIds, ...this.addedEnvironments.keys()];
  }

  /**
   * Adds a `.glts` environment under `id` (listed in the DevUI environment
   * menu); load it with {@link loadDefaultEnvironment}. See
   * scene-environment.ts for how its objects become planes and meshes.
   */
  addEnvironment(id: string, url: string | URL) {
    if (captureIds.includes(id)) {
      throw new Error(`Environment ${id} is a built-in capture`);
    }
    this.addedEnvironments.set(id, url);
  }

  private loadSceneEnvironment(object: EnvironmentObject) {
    this.deleteAll();
    const environment = new SceneEnvironment(object);
    this.sceneEnvironment = environment;
    this.grid.visible = false;
    // The scene is the environment's "mesh", toggled like a capture's global
    // mesh; reported planes and meshes are overlays toggled with the planes
    // and bounding boxes.
    this.meshes.add(object);
    this.planes.add(environment.planeOverlays);
    this.boxes.add(environment.meshOverlays);
    // Report planes and meshes right away, not only once AR renders.
    environment.update(0, this.trackedPlanes, this.trackedMeshes);
    this.dispatchEvent(
      new CustomEvent('environmentchange', {
        detail: {
          entityCount: this.trackedPlanes.size + this.trackedMeshes.size,
        },
      }),
    );
  }

  loadEnvironment(json: SceneFile) {
    this.deleteAll();
    (json as SceneFile).spatialEntities.forEach((spatialEntityJSON) => {
      const spatialEntity = SpatialEntity.fromPBJSON(spatialEntityJSON);
      if (spatialEntity) {
        // Tear down any prior entity sharing this uuid (duplicate within a single
        // load) before adding the replacement, so its nativeEntity isn't left
        // dangling in trackedMeshes/trackedPlanes.
        const oldMesh = this.objectMap.get(spatialEntityJSON.uuid);
        if (oldMesh) {
          oldMesh.removeFromParent();
          this.trackedMeshes.delete(oldMesh.nativeEntity as NativeMesh);
          this.trackedPlanes.delete(oldMesh.nativeEntity as NativePlane);
        }
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
        this.objectMap.set(spatialEntityJSON.uuid, spatialEntity);
      }
    });
    // Notify listeners (e.g. agent tooling) that the loaded environment
    // changed. Additive: callers that don't subscribe are unaffected.
    this.dispatchEvent(
      new CustomEvent('environmentchange', {
        detail: { entityCount: this.objectMap.size },
      }),
    );
  }

  async loadDefaultEnvironment(envId: string): Promise<void> {
    // Taken before loading, so a slower earlier load can't replace this one.
    const id = ++this.loadId;
    try {
      const url = this.addedEnvironments.get(envId);
      if (url) {
        const scene = await loadGLTS(url);
        if (id === this.loadId) this.loadSceneEnvironment(scene);
        else scene.dispose?.();
        return;
      }
      const json = await loadCapture(envId);
      if (id === this.loadId) this.loadEnvironment(json);
    } catch (error) {
      console.error(`Error loading environment ${envId}`, error);
      throw error;
    }
  }

  computeHitTestResults(mat4: mat4, entityTypes?: HitTestTrackableType[]) {
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
    // Raycast against every tracked entity group, not just meshes, so plane and
    // box hits are reported too. When an entityTypes filter is supplied, restrict
    // to the requested groups; otherwise default to all.
    const targets: Object3D[] = [];
    if (!entityTypes || entityTypes.includes('mesh')) {
      targets.push(this.meshes, this.boxes);
    }
    if (!entityTypes || entityTypes.includes('plane')) {
      targets.push(this.planes);
    }
    // intersectObjects keeps results distance-sorted across all targets.
    // Only meshes are hit-testable (a scene environment may contain lines,
    // points or sprites).
    const intersections = this.raycaster
      .intersectObjects(targets, true)
      .filter((intersection) => (intersection.object as Mesh).isMesh);
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
  ): {
    data: ArrayBuffer;
    width: number;
    height: number;
    rawValueToMeters: number;
  } | null {
    if (this.trackedMeshes.size === 0 && !this.sceneEnvironment) {
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

    // Set up depth camera from view & projection matrices.
    // Decompose into position/quaternion/scale so Three.js's
    // updateMatrixWorld() computes correct matrices during render.
    this._tempMatrix.fromArray(viewMatrix);
    this._tempMatrix.invert();
    this._tempMatrix.decompose(
      this.depthCamera.position,
      this.depthCamera.quaternion,
      this.depthCamera.scale,
    );
    this.depthCamera.projectionMatrix.fromArray(projectionMatrix);
    this.depthCamera.projectionMatrixInverse
      .copy(this.depthCamera.projectionMatrix)
      .invert();

    // Save visibility state and force environment geometry visible for depth
    const prevMeshesVisible = this.meshes.visible;
    const prevBoxesVisible = this.boxes.visible;
    this.meshes.visible = true;
    // A scene environment's real geometry is in `meshes`; its boxes are only
    // coarse overlays of the reported meshes.
    this.boxes.visible = !this.sceneEnvironment;

    // Render with depth material into the render target
    const prevOverrideMaterial = this.scene.overrideMaterial;
    const prevBackground = this.scene.background;
    this.scene.overrideMaterial = this.depthMaterial;
    this.scene.background = null;

    this.renderer.setRenderTarget(this.depthRenderTarget);
    const prevClearColor = this.renderer.getClearColor(tempClearColor);
    const prevClearAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.setClearColor(prevClearColor, prevClearAlpha);
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

        // Decode depth from RGBA packing — this is gl_FragCoord.z (0..1)
        const normalizedDepth = unpackRGBADepthBytes(
          rgba[srcIdx * 4],
          rgba[srcIdx * 4 + 1],
          rgba[srcIdx * 4 + 2],
          rgba[srcIdx * 4 + 3],
        );

        // Convert from non-linear gl_FragCoord.z to linear eye-space depth.
        output[dstIdx] = perspectiveDepthToMeters(
          normalizedDepth,
          depthNear,
          depthFar,
        );
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

async function loadGLTS(url: string | URL): Promise<EnvironmentObject> {
  if (typeof __IS_UMD__ !== 'undefined' && __IS_UMD__) {
    throw new Error('GLTS environments need the ES module build of @iwer/sem');
  } else {
    const { GLTSLoader } = await import('@drawcall/glts');
    return new GLTSLoader(new LoadingManager()).loadAsync(url);
  }
}

async function loadCapture(envId: string): Promise<SceneFile> {
  if (typeof __IS_UMD__ !== 'undefined' && __IS_UMD__) {
    // UMD builds fetch the capture JSON from the CDN.
    const url = `https://www.unpkg.com/@iwer/sem@${VERSION}/captures/${envId}.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Network response was not ok: ${response.statusText}`);
    }
    return response.json();
  } else {
    const importEnv = Environments[envId];
    if (!importEnv) {
      throw new Error(`Requested environment ${envId} does not exist`);
    }
    return (await importEnv()).default;
  }
}
