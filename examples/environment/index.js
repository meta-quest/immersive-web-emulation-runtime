import * as THREE from 'three';
import { XRDevice, metaQuest3 } from 'iwer';
import { DevUI } from '@iwer/devui';
import { SyntheticEnvironmentModule } from '@iwer/sem';

// Emulate a Quest 3 and use one of SEM's GLTS rooms as the real world behind
// the app.
const xrDevice = new XRDevice(metaQuest3);
xrDevice.installRuntime({ forceInstall: true });
xrDevice.installDevUI(DevUI);
window.xrDevice = xrDevice; // for tests and console tinkering
xrDevice.installSEM(SyntheticEnvironmentModule);
// SEM's built-in GLTS rooms (and the legacy scans) are listed in the DevUI
// environment menu. ?room=<id> picks the starting room.
const room =
  new URLSearchParams(location.search).get('room') ?? 'sunlit_living_room';
const loadStart = performance.now();
await xrDevice.sem.loadDefaultEnvironment(room);
window.environmentLoadMs = performance.now() - loadStart;

// A plain three.js AR app that draws what WebXR reports.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 'yellow' }),
);
reticle.matrixAutoUpdate = false;
scene.add(reticle);

const outlines = new Map();
const wireframe = new THREE.MeshBasicMaterial({
  color: '#00ff88',
  wireframe: true,
});

function outlinePlane(plane) {
  const shape = new THREE.Shape(
    plane.polygon.map((p) => new THREE.Vector2(p.x, -p.z)),
  );
  const geometry = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
  return new THREE.Mesh(geometry, wireframe);
}

function outlineMesh(mesh) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(mesh.vertices, 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return new THREE.Mesh(geometry, wireframe);
}

// Draws planes/meshes at their poses and returns a summary for tests.
// ?outlines=0 hides the detected plane/mesh outlines.
const showOutlines =
  new URLSearchParams(location.search).get('outlines') !== '0';
function track(frame, entities, outline, spaceOf) {
  const refSpace = renderer.xr.getReferenceSpace();
  return [...entities].map((entity) => {
    let object = outlines.get(entity);
    if (!object) {
      object = outline(entity);
      object.matrixAutoUpdate = false;
      object.visible = showOutlines;
      outlines.set(entity, object);
      scene.add(object);
    }
    const pose = frame.getPose(spaceOf(entity), refSpace);
    object.matrix.fromArray(pose.transform.matrix);
    const { x, y, z } = pose.transform.position;
    return {
      label: entity.semanticLabel,
      position: [x, y, z],
      // Plane space +Y is the plane normal.
      normal: object.matrix.elements.slice(4, 7),
      lastChangedTime: entity.lastChangedTime,
    };
  });
}

let hitTestSource = null;
window.xrState = { frames: 0 };
renderer.setAnimationLoop((_time, frame) => {
  if (!frame) return;
  const planes = track(
    frame,
    frame.detectedPlanes,
    outlinePlane,
    (p) => p.planeSpace,
  );
  const meshes = track(
    frame,
    frame.detectedMeshes,
    outlineMesh,
    (m) => m.meshSpace,
  );
  // Drop outlines of planes/meshes that are no longer detected, e.g. after
  // switching environments.
  for (const [entity, object] of outlines) {
    if (frame.detectedPlanes.has(entity) || frame.detectedMeshes.has(entity)) {
      continue;
    }
    outlines.delete(entity);
    object.removeFromParent();
    object.geometry.dispose();
  }
  const hits = hitTestSource ? frame.getHitTestResults(hitTestSource) : [];
  reticle.visible = hits.length > 0;
  if (hits.length > 0) {
    const pose = hits[0].getPose(renderer.xr.getReferenceSpace());
    reticle.matrix.fromArray(pose.transform.matrix);
  }
  window.xrState = {
    frames: window.xrState.frames + 1,
    planes,
    meshes,
    outlines: outlines.size,
    hit: reticle.visible ? reticle.matrix.elements.slice(12, 15) : null,
  };
  renderer.render(scene, camera);
});

const button = document.createElement('button');
button.textContent = 'Enter AR';
button.style.cssText = 'position:fixed;bottom:20px;left:50%;padding:12px 24px';
document.body.appendChild(button);
button.onclick = async () => {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: [
      'local-floor',
      'plane-detection',
      'mesh-detection',
      'hit-test',
    ],
  });
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
  button.remove();
};
