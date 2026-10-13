// Room understanding check: loads one environment (?env=<id>, a built-in
// GLTS room or a legacy scan) and runs a WebXR AR session with plane
// detection, mesh detection, hit test, anchors and CPU depth sensing,
// recording what an app would see into window.report. Without ?env it lists
// SEM's environments in window.environments. Driven by understanding.mjs and
// tests/rooms.spec.js (through understanding-runner.js).
import { XRDevice, metaQuest3 } from 'iwer';
import { SyntheticEnvironmentModule } from '@iwer/sem';
import { roomMetrics } from './room-metrics.js';

const env = new URLSearchParams(location.search).get('env');
const xrDevice = new XRDevice(metaQuest3);
xrDevice.installRuntime({ forceInstall: true });
xrDevice.installSEM(SyntheticEnvironmentModule);
window.xrDevice = xrDevice;
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2', { xrCompatible: true });
let loadMs = 0;
if (env) {
  const loadStart = performance.now();
  try {
    await xrDevice.sem.loadDefaultEnvironment(env);
    loadMs = Math.round(performance.now() - loadStart);
    document.body.append(canvas);
    const button = document.createElement('button');
    button.textContent = 'Start';
    document.body.append(button);
    button.onclick = start;
    window.ready = true;
  } catch (error) {
    // Report the failure right away rather than never showing Start.
    window.report = { env, errors: [`load: ${error?.message ?? error}`] };
  }
} else {
  window.environments = xrDevice.sem.environments.map((id) => ({
    id,
    kind: xrDevice.sem.environmentInfo(id)?.kind,
  }));
}

const v = (p) => [p.x, p.y, p.z];
const round = (a, n = 3) => a.map((x) => +x.toFixed(n));

// Applies a column-major 4x4 matrix to a point.
function apply(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// Rays from the viewer's start (inside every room) in 26 directions, and 25
// straight down on a grid over the detected floor (inset 15% from its edges).
function rays(floor) {
  const list = [];
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (!x && !y && !z) continue;
        const n = Math.hypot(x, y, z);
        list.push({
          kind: 'around',
          origin: [0, 1.5, 0],
          direction: [x / n, y / n, z / n],
        });
      }
    }
  }
  for (const u of [0.15, 0.325, 0.5, 0.675, 0.85]) {
    for (const w of [0.15, 0.325, 0.5, 0.675, 0.85]) {
      const x = floor.min[0] + u * (floor.max[0] - floor.min[0]);
      const z = floor.min[2] + w * (floor.max[2] - floor.min[2]);
      list.push({
        kind: 'down',
        origin: [+x.toFixed(2), 1.5, +z.toFixed(2)],
        direction: [0, -1, 0],
      });
    }
  }
  return list;
}

async function start() {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: [
      'local-floor',
      'plane-detection',
      'mesh-detection',
      'hit-test',
      'anchors',
      'depth-sensing',
    ],
    depthSensing: {
      usagePreference: ['cpu-optimized'],
      dataFormatPreference: ['float32'],
    },
  });
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const space = await session.requestReferenceSpace('local-floor');
  const viewerSpace = await session.requestReferenceSpace('viewer');
  const sources = [];
  let sourcesRequested = false;
  const requestSources = async (floor) => {
    for (const ray of rays(floor)) {
      const [ox, oy, oz] = ray.origin;
      const [dx, dy, dz] = ray.direction;
      const source = await session.requestHitTestSource({
        space,
        offsetRay: new XRRay(
          { x: ox, y: oy, z: oz, w: 1 },
          { x: dx, y: dy, z: dz, w: 0 },
        ),
      });
      sources.push({ ray, source });
    }
  };
  const forward = await session.requestHitTestSource({ space: viewerSpace });
  const report = { env, errors: [], frames: 0, loadMs };
  const planeTimes = new Map();
  let anchor = null;
  let anchorRequested = false;

  const onFrame = (time, frame) => {
    try {
      report.frames++;
      const pose = frame.getViewerPose(space);
      for (const plane of frame.detectedPlanes ?? []) {
        const times = planeTimes.get(plane) ?? new Set();
        times.add(plane.lastChangedTime);
        planeTimes.set(plane, times);
      }
      if (!sourcesRequested) {
        const floor = [...(frame.detectedPlanes ?? [])].find(
          (p) => p.semanticLabel === 'floor',
        );
        if (floor) {
          sourcesRequested = true;
          const m = frame.getPose(floor.planeSpace, space).transform.matrix;
          const points = floor.polygon.map((p) => apply(m, [p.x, p.y, p.z]));
          const min = [0, 1, 2].map((k) =>
            Math.min(...points.map((p) => p[k])),
          );
          const max = [0, 1, 2].map((k) =>
            Math.max(...points.map((p) => p[k])),
          );
          report.floor = { min: round(min, 2), max: round(max, 2) };
          requestSources({ min, max }).catch((error) =>
            report.errors.push(`hit test: ${error.message}`),
          );
        }
      }
      if (report.frames === 10 && !anchorRequested) {
        const hit = frame.getHitTestResults(forward)[0];
        anchorRequested = true;
        if (hit?.createAnchor) {
          hit.createAnchor().then(
            (created) => (anchor = created),
            (error) => report.errors.push(`anchor: ${error.message}`),
          );
        } else
          report.anchor = {
            created: false,
            reason: hit ? 'no createAnchor' : 'no forward hit',
          };
      }
      if ((report.frames < 30 || sources.length < 51) && report.frames < 300) {
        session.requestAnimationFrame(onFrame);
        return;
      }

      // Planes.
      report.planes = [...frame.detectedPlanes].map((plane) => {
        const m = frame.getPose(plane.planeSpace, space).transform.matrix;
        const polygon = plane.polygon.map((p) => [p.x, p.y, p.z]);
        const first = polygon[0];
        const last = polygon[polygon.length - 1];
        let area = 0;
        for (let i = 0; i < polygon.length - 1; i++)
          area +=
            polygon[i][0] * polygon[i + 1][2] -
            polygon[i + 1][0] * polygon[i][2];
        const world = polygon.map((p) => apply(m, p));
        const center = world
          .slice(0, -1)
          .reduce(
            (acc, p) => acc.map((a, k) => a + p[k] / (world.length - 1)),
            [0, 0, 0],
          );
        return {
          label: plane.semanticLabel ?? null,
          orientation: plane.orientation ?? null,
          points: polygon.length,
          closed: Math.hypot(first[0] - last[0], first[2] - last[2]) < 1e-6,
          flat: polygon.every((p) => Math.abs(p[1]) < 1e-6),
          signedArea: +(area / 2).toFixed(3),
          center: round(center),
          normal: round([m[4], m[5], m[6]]),
          changes: planeTimes.get(plane)?.size ?? 0,
        };
      });

      // Meshes.
      report.meshes = [...frame.detectedMeshes].map((mesh) => {
        const m = frame.getPose(mesh.meshSpace, space).transform.matrix;
        const vertices = mesh.vertices;
        const indices = mesh.indices;
        const count = vertices.length / 3;
        let valid = indices.length % 3 === 0;
        for (const i of indices) if (i >= count) valid = false;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < vertices.length; i += 3) {
          const p = apply(m, [vertices[i], vertices[i + 1], vertices[i + 2]]);
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[k]);
            max[k] = Math.max(max[k], p[k]);
          }
        }
        return {
          label: mesh.semanticLabel ?? null,
          vertices: count,
          triangles: indices.length / 3,
          valid,
          min: round(min, 2),
          max: round(max, 2),
        };
      });

      // Hit tests.
      report.hits = sources.map(({ ray, source }) => {
        const result = frame.getHitTestResults(source)[0];
        if (!result) return { ...ray, hit: false };
        const point = v(result.getPose(space).transform.position);
        const distance = Math.hypot(...point.map((p, k) => p - ray.origin[k]));
        return {
          ...ray,
          hit: true,
          point: round(point),
          distance: +distance.toFixed(3),
        };
      });
      const forwardHit = frame.getHitTestResults(forward)[0];
      const viewerPosition = v(pose.transform.position);
      report.forward = forwardHit
        ? {
            distance: +Math.hypot(
              ...v(forwardHit.getPose(space).transform.position).map(
                (p, k) => p - viewerPosition[k],
              ),
            ).toFixed(3),
            viewer: round(viewerPosition),
          }
        : null;

      // Depth.
      const depth = frame.getDepthInformation(pose.views[0]);
      if (depth) {
        let valid = 0;
        let total = 0;
        let min = Infinity;
        let max = 0;
        for (let y = 0.05; y < 1; y += 0.1) {
          for (let x = 0.05; x < 1; x += 0.1) {
            const d = depth.getDepthInMeters(x, y);
            total++;
            if (d > 0 && d < 20) {
              valid++;
              min = Math.min(min, d);
              max = Math.max(max, d);
            }
          }
        }
        report.depth = {
          width: depth.width,
          height: depth.height,
          rawValueToMeters: depth.rawValueToMeters,
          center: +depth.getDepthInMeters(0.5, 0.5).toFixed(3),
          validRatio: valid / total,
          min: +min.toFixed(2),
          max: +max.toFixed(2),
        };
      } else report.depth = null;

      // Anchor.
      if (anchor && report.frames >= 40) {
        const tracked = frame.trackedAnchors?.has(anchor) ?? false;
        const anchorPose = frame.getPose(anchor.anchorSpace, space);
        report.anchor = {
          created: true,
          tracked,
          position: anchorPose ? round(v(anchorPose.transform.position)) : null,
        };
      }
      if (report.frames >= 45) {
        // GLTS environments only; captures have no scene to measure.
        if (xrDevice.sem.sceneEnvironment) {
          report.metrics = roomMetrics(xrDevice.sem);
        }
        window.report = report;
        session.end();
        return;
      }
    } catch (error) {
      report.errors.push(String(error?.stack ?? error));
      window.report = report;
      session.end();
      return;
    }
    session.requestAnimationFrame(onFrame);
  };
  session.requestAnimationFrame(onFrame);
}
