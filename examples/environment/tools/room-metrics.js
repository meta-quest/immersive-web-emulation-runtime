// Realism metrics of the environment SEM has loaded, computed in the page:
// render cost from SEM's current camera, lit lamps, and furniture volumes
// that overlap or lie outside the room. Shared by check.mjs and
// understanding.js; checkBudgets in understanding-checks.js holds them to the
// budgets in packages/sem/rooms/README.md.

// Volume pairs (sorted labels) that may overlap: a chair or stool tucked
// under a table, desk or counter.
const tuckIns = new Set(['desk+other', 'other+table']);

export function roomMetrics(sem) {
  const root = sem.sceneEnvironment.root;
  root.updateMatrixWorld(true);
  const boxOf = (o) => {
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    const e = o.matrixWorld.elements;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const x of [b.min.x, b.max.x]) {
      for (const y of [b.min.y, b.max.y]) {
        for (const z of [b.min.z, b.max.z]) {
          const p = [
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
          ];
          for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], p[i]);
            max[i] = Math.max(max[i], p[i]);
          }
        }
      }
    }
    return { min, max };
  };
  const round = (v) => v.map((n) => +n.toFixed(2));
  const volumes = [];
  const planes = [];
  let floor;
  let ceiling;
  let litLamps = 0;
  root.traverse((o) => {
    if (o.isPointLight || o.isSpotLight) litLamps++;
    if (!o.isMesh) return;
    if (o.userData.xrMesh)
      volumes.push({ label: o.userData.xrMesh, ...boxOf(o) });
    if (o.userData.xrPlane) {
      const b = boxOf(o);
      planes.push({ label: o.userData.xrPlane, ...b });
      if (o.userData.xrPlane === 'floor') floor = b;
      if (o.userData.xrPlane === 'ceiling') ceiling = b;
    }
  });
  const bounds = {
    x0: floor.min[0],
    x1: floor.max[0],
    z0: floor.min[2],
    z1: floor.max[2],
    height: ceiling.min[1],
  };
  const overlaps = [];
  for (let i = 0; i < volumes.length; i++) {
    for (let j = i + 1; j < volumes.length; j++) {
      const a = volumes[i];
      const b = volumes[j];
      const depth = [0, 1, 2].map(
        (k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]),
      );
      if (depth.every((d) => d > 0.01)) {
        const pair = [a.label, b.label].sort().join('+');
        overlaps.push({
          a: a.label,
          b: b.label,
          allowed: tuckIns.has(pair),
          depth: round(depth),
          aCenter: round(a.min.map((v, k) => (v + a.max[k]) / 2)),
          bCenter: round(b.min.map((v, k) => (v + b.max[k]) / 2)),
        });
      }
    }
  }
  const outside = [
    ...volumes,
    ...planes.filter(
      (p) => !['floor', 'ceiling', 'wall', 'window', 'door'].includes(p.label),
    ),
  ]
    .filter(
      (v) =>
        v.min[0] < bounds.x0 - 0.01 ||
        v.max[0] > bounds.x1 + 0.01 ||
        v.min[2] < bounds.z0 - 0.01 ||
        v.max[2] > bounds.z1 + 0.01 ||
        v.min[1] < -0.01 ||
        v.max[1] > bounds.height + 0.01,
    )
    .map((v) => ({ label: v.label, min: round(v.min), max: round(v.max) }));
  const count = (items) =>
    items.reduce(
      (acc, { label }) => ({ ...acc, [label]: (acc[label] ?? 0) + 1 }),
      {},
    );
  // One frame from SEM's camera, rendered here so other passes (depth
  // sensing) don't skew the renderer's counters.
  const { renderer } = sem;
  renderer.info.reset();
  renderer.render(sem.scene, sem.camera);
  return {
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    textures: renderer.info.memory.textures,
    litLamps,
    bounds: {
      x0: +bounds.x0.toFixed(2),
      x1: +bounds.x1.toFixed(2),
      z0: +bounds.z0.toFixed(2),
      z1: +bounds.z1.toFixed(2),
      height: +bounds.height.toFixed(2),
    },
    planes: count(planes),
    meshes: count(volumes),
    overlaps,
    outside,
  };
}
