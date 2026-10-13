// Turns a report from understanding.html into a list of issues: what a WebXR
// app relying on room understanding would get wrong in this environment, and
// (checkBudgets) where a built-in room exceeds its realism budgets. Shared by
// understanding.mjs and tests/rooms.spec.js.

const inward = new Set(['floor', 'ceiling', 'wall', 'window', 'door']);

// `convex: false` (irregular captured rooms with alcoves) checks only the
// floor and ceiling for room-facing normals, and not whether the global mesh
// stays within the floor's bounds.
export function analyze(report, { convex = true } = {}) {
  const issues = [];
  const planes = report.planes ?? [];
  const meshes = report.meshes ?? [];
  const floor = planes.find((p) => p.label === 'floor');
  // Inside the room: above the floor's centre (valid for convex rooms).
  const centre = floor ? [floor.center[0], 1.3, floor.center[2]] : [0, 1.3, 0];
  for (const p of planes) {
    if (!p.closed) issues.push(`plane ${p.label}: polygon not closed`);
    if (!p.flat) issues.push(`plane ${p.label}: polygon not flat`);
    if (p.changes !== 1) {
      issues.push(
        `plane ${p.label}: lastChangedTime changed ${p.changes - 1} times`,
      );
    }
    const ny = Math.abs(p.normal[1]);
    const expected = ny > 0.9 ? 'horizontal' : ny < 0.1 ? 'vertical' : null;
    if (p.orientation && expected && p.orientation !== expected) {
      issues.push(
        `plane ${p.label}: orientation ${p.orientation} but normal ${p.normal}`,
      );
    }
    const facingChecked = convex
      ? inward.has(p.label)
      : p.label === 'floor' || p.label === 'ceiling';
    if (facingChecked) {
      const to = centre.map((c, k) => c - p.center[k]);
      if (
        to[0] * p.normal[0] + to[1] * p.normal[1] + to[2] * p.normal[2] <=
        0
      ) {
        issues.push(
          `plane ${p.label} at ${p.center}: normal ${p.normal} faces out of the room`,
        );
      }
    }
  }
  for (const m of meshes) {
    if (!m.valid) issues.push(`mesh ${m.label}: index out of range`);
  }
  const globalMesh = meshes.find((m) => m.label === 'global mesh');
  if (!globalMesh) issues.push('no global mesh');
  // The scanned room only: nothing outside (views, corridors) is merged in.
  const ceiling = planes.find((p) => p.label === 'ceiling');
  if (convex && globalMesh && report.floor && ceiling) {
    const min = [report.floor.min[0] - 0.2, -0.2, report.floor.min[2] - 0.2];
    const max = [
      report.floor.max[0] + 0.2,
      ceiling.center[1] + 0.2,
      report.floor.max[2] + 0.2,
    ];
    if (
      [0, 1, 2].some(
        (k) => globalMesh.min[k] < min[k] || globalMesh.max[k] > max[k],
      )
    ) {
      issues.push(
        `global mesh ${globalMesh.min} to ${globalMesh.max} reaches outside the room`,
      );
    }
  }
  const hits = report.hits ?? [];
  const missed = hits.filter((h) => !h.hit);
  if (!hits.length) issues.push('no hit-test results');
  if (missed.length) {
    issues.push(`${missed.length}/${hits.length} hit-test rays found nothing`);
  }
  const below = hits.filter(
    (h) =>
      h.kind === 'down' && h.hit && (h.point[1] < -0.01 || h.distance > 1.51),
  );
  if (below.length)
    issues.push(`${below.length} downward hits below the floor`);
  if (report.depth && report.forward) {
    // Depth sees what hit test hits: an invisible surface in depth only (such
    // as a shadow-only slab 3 cm in front of a wall) shows up here.
    const delta = Math.abs(report.depth.center - report.forward.distance);
    if (delta > 0.015) {
      issues.push(
        `depth ${report.depth.center} m vs forward hit ${report.forward.distance} m`,
      );
    }
    if (report.depth.validRatio < 0.95) {
      issues.push(
        `only ${(report.depth.validRatio * 100).toFixed(0)}% of depth samples valid`,
      );
    }
  } else {
    issues.push(
      `depth ${report.depth ? 'ok' : 'missing'}, forward hit ${report.forward ? 'ok' : 'missing'}`,
    );
  }
  if (!report.anchor?.created || !report.anchor?.tracked) {
    issues.push(`anchor ${JSON.stringify(report.anchor)}`);
  }
  issues.push(
    ...(report.errors ?? []).map((e) => `error: ${e.split('\n')[0]}`),
  );
  return issues;
}

// Realism budgets of a built-in room (packages/sem/rooms/README.md), from
// the report's metrics. Load time is checked loosely: it depends on the
// machine.
export const budgets = {
  entities: 41, // 40 tagged objects plus the global mesh
  drawCalls: 60,
  triangles: 60000,
  litLamps: 2,
  loadMs: 3000,
};

export function checkBudgets(report) {
  const issues = [];
  const m = report.metrics;
  if (!m) return ['no metrics'];
  const entities = (report.planes?.length ?? 0) + (report.meshes?.length ?? 0);
  const over = (name, value) => {
    if (value > budgets[name]) {
      issues.push(`${name} ${value} over the budget of ${budgets[name]}`);
    }
  };
  over('entities', entities);
  over('drawCalls', m.drawCalls);
  over('triangles', m.triangles);
  over('litLamps', m.litLamps);
  over('loadMs', report.loadMs);
  for (const o of m.overlaps.filter((o) => !o.allowed)) {
    issues.push(
      `volumes ${o.a} at ${o.aCenter} and ${o.b} at ${o.bCenter} overlap`,
    );
  }
  for (const o of m.outside) {
    issues.push(`${o.label} ${o.min} to ${o.max} is outside the room`);
  }
  return issues;
}

// Counts by label, e.g. "wall x4, floor".
export function labels(items) {
  const counts = items.reduce(
    (acc, { label }) => ({ ...acc, [label]: (acc[label] ?? 0) + 1 }),
    {},
  );
  return Object.entries(counts)
    .map(([label, n]) => `${label}${n > 1 ? ` x${n}` : ''}`)
    .join(', ');
}
