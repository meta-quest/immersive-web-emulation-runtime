// Kitchen with a dining corner, 5 x 5 m. Its worktops, island and table give
// developers horizontal surfaces at several heights.
//
// Layout (the viewer starts at the origin facing -Z):
//   back wall  (-Z)  counter run with the sink under a window, upper
//                    cabinets either side, a tall fridge column
//   left wall  (-X)  counter run with cooktop and oven, an open shelf
//   right wall (+X)  window, round dining table with two chairs, a print
//   front wall (+Z)  door
//   centre           island with a stone top and three counter stools
const room = createRoom({
  name: 'kitchen',
  width: 5,
  depth: 5,
  z0: -3.2,
  wall: '#efe9df',
  windows: [
    {
      wall: 'back',
      // Clear of the viewer's forward ray, which would graze its edge.
      at: -0.65,
      width: 1.2,
      sill: 1.05,
      head: 2.25,
      sheers: false,
    },
    {
      wall: 'right',
      at: -1.0,
      width: 1.3,
      sill: 0.8,
      head: 2.25,
      sheers: false,
    },
  ],
  doors: [{ wall: 'front', at: -1.3 }],
  sun: { window: 1, elevation: 40, azimuth: 18 },
});

const WORKTOP = 0.92;
const kitchenFront = paintMaterial('#7d8a72', 0.55);
const kitchenTile = once(() =>
  standard({ map: tileTexture('#cf8a6c'), roughness: 0.35 }),
);

// Base cabinets along local X (facing +Z) with an oak worktop (a 'table'
// plane). Modules are 0.6 m: door pairs and drawer stacks; `sink`,
// `cooktop` and `oven` are local x positions.
function kitchenBaseRun(
  g: THREE.Object3D,
  length: number,
  { sink = NaN, cooktop = NaN, oven = NaN } = {},
) {
  const depth = 0.62;
  const plinth = 0.1;
  const carcass = WORKTOP - 0.04 - plinth;
  box(
    [length, plinth, depth - 0.08],
    paintMaterial('#3a3836', 0.9),
    [0, plinth / 2, -0.04],
    g,
  );
  box(
    [length, carcass, depth - 0.02],
    kitchenFront,
    [0, plinth + carcass / 2, -0.01],
    g,
  );
  const modules = Math.max(1, Math.round(length / 0.6));
  const width = length / modules;
  for (let i = 0; i < modules; i++) {
    const x = -length / 2 + width * (i + 0.5);
    const isOven = Math.abs(x - oven) < width / 2;
    if (isOven) {
      box(
        [width - 0.006, carcass - 0.2, 0.02],
        paintMaterial('#1c1c1e', 0.15, 0.3),
        [x, plinth + (carcass - 0.2) / 2, depth / 2],
        g,
      );
      box(
        [width - 0.006, 0.18, 0.02],
        kitchenFront,
        [x, plinth + carcass - 0.09, depth / 2],
        g,
      );
      box(
        [width * 0.7, 0.014, 0.02],
        mats.steel(),
        [x, plinth + carcass - 0.25, depth / 2 + 0.02],
        g,
      );
      continue;
    }
    const drawers = i % 3 === 1;
    const rows = drawers ? 3 : 1;
    for (let r = 0; r < rows; r++) {
      const h = carcass / rows;
      const y = plinth + h * (r + 0.5);
      box(
        [width - 0.006, h - 0.006, 0.018],
        kitchenFront,
        [x, y, depth / 2 - 0.01],
        g,
      );
      if (drawers)
        box(
          [0.14, 0.012, 0.014],
          mats.blackMetal(),
          [x, y + h * 0.25, depth / 2 + 0.006],
          g,
        );
      else
        box(
          [0.012, 0.16, 0.014],
          mats.blackMetal(),
          [x + width / 2 - 0.05, y + h * 0.3, depth / 2 + 0.006],
          g,
        );
    }
  }
  const top = box(
    [length, 0.04, depth + 0.02],
    mats.oak(),
    [0, WORKTOP - 0.02, 0],
    g,
  );
  top.userData.xrPlane = 'table';
  if (!Number.isNaN(sink)) {
    box([0.62, 0.004, 0.42], mats.steel(), [sink, WORKTOP + 0.002, 0.02], g);
    box(
      [0.56, 0.003, 0.36],
      paintMaterial('#55575a', 0.35, 0.8),
      [sink, WORKTOP + 0.0045, 0.02],
      g,
    );
    cylinder(
      0.018,
      0.022,
      0.26,
      mats.blackMetal(),
      [sink, WORKTOP + 0.13, -0.2],
      g,
      12,
    );
    const spout = mesh(
      own(new THREE.TorusGeometry(0.1, 0.012, 8, 24, Math.PI)),
      mats.blackMetal(),
      [sink, WORKTOP + 0.26, -0.1],
      g,
    );
    spout.rotation.y = Math.PI / 2;
  }
  if (!Number.isNaN(cooktop)) {
    box(
      [0.6, 0.006, 0.5],
      paintMaterial('#111113', 0.08, 0.2),
      [cooktop, WORKTOP + 0.003, 0.02],
      g,
    );
    const ring = own(new THREE.RingGeometry(0.075, 0.085, 32));
    for (const [dx, dz] of [
      [-0.15, -0.12],
      [0.15, -0.12],
      [-0.15, 0.13],
      [0.15, 0.13],
    ]) {
      mesh(
        ring,
        paintMaterial('#5c5c5e', 0.4),
        [cooktop + dx, WORKTOP + 0.0065, 0.02 + dz],
        g,
        { cast: false },
      ).rotation.x = -Math.PI / 2;
    }
  }
  // A counter is scanned like a table: a top plane plus a volume.
  volume('table', [length, WORKTOP, depth], [0, WORKTOP / 2, 0], g, 0.75);
  return g;
}

// Tile backsplash on a wall group, from the worktop up to `top`.
function kitchenBacksplash(g: THREE.Object3D, width: number, top: number) {
  box(
    [width, top - WORKTOP, 0.01],
    kitchenTile(),
    [0, (top + WORKTOP) / 2 - g.position.y, 0.005],
    g,
  );
  return g;
}

// Tall fridge column with two panel doors (an XRMesh 'other').
function kitchenFridge(
  g: THREE.Object3D,
  { width = 0.75, height = 2.2, depth = 0.65 } = {},
) {
  box([width, height, depth - 0.02], kitchenFront, [0, height / 2, -0.01], g);
  const split = 1.35;
  box(
    [width - 0.006, split - 0.006, 0.02],
    kitchenFront,
    [0, split / 2, depth / 2],
    g,
  );
  box(
    [width - 0.006, height - split - 0.006, 0.02],
    kitchenFront,
    [0, split + (height - split) / 2, depth / 2],
    g,
  );
  box(
    [0.014, 0.7, 0.02],
    mats.blackMetal(),
    [width / 2 - 0.06, split - 0.45, depth / 2 + 0.02],
    g,
  );
  box(
    [0.014, 0.3, 0.02],
    mats.blackMetal(),
    [width / 2 - 0.06, split + 0.2, depth / 2 + 0.02],
    g,
  );
  volume('other', [width, height, depth], [0, height / 2, 0], g, 0.75);
  return g;
}

// Island: sage cabinets under a stone top that overhangs the +Z side for
// stools. The top is a 'table' plane.
function kitchenIsland(g: THREE.Object3D, { width = 1.8, depth = 0.95 } = {}) {
  const body = depth - 0.25;
  box(
    [width - 0.08, 0.1, body - 0.08],
    paintMaterial('#3a3836', 0.9),
    [0, 0.05, -0.125],
    g,
  );
  box(
    [width - 0.04, WORKTOP - 0.14, body],
    kitchenFront,
    [0, 0.1 + (WORKTOP - 0.14) / 2, -0.125],
    g,
  );
  for (const x of [-width / 2 + 0.3, 0, width / 2 - 0.3]) {
    box(
      [0.56, WORKTOP - 0.16, 0.018],
      kitchenFront,
      [x, 0.1 + (WORKTOP - 0.14) / 2, -0.125 - body / 2 - 0.009],
      g,
    );
  }
  const top = mesh(
    roundedBox(width, 0.04, depth, 0.01),
    mats.stone(),
    [0, WORKTOP - 0.02, 0],
    g,
  );
  top.userData.xrPlane = 'table';
  volume('table', [width, WORKTOP, depth], [0, WORKTOP / 2, 0], g, 0.6);
  return g;
}

// Back wall: counter run with the sink, uppers either side of the window,
// backsplash, fridge.
const backRun = kitchenBaseRun(room.against('back', -0.74, 0.62), 3.48, {
  sink: 0.09, // under the window
});
smallPlant(group(-1.25, WORKTOP, -0.15, 0, backRun), {
  size: 0.24,
  pot: mats.ceramic(),
  seed: 4,
});
for (const [x, size] of [
  [1.2, 0.14],
  [1.36, 0.1],
] as const) {
  cylinder(
    size * 0.45,
    size * 0.45,
    size,
    mats.stoneware(),
    [x, WORKTOP + size / 2, -0.18],
    backRun,
    20,
  );
}
casegood(room.onWall('back', -1.89, 1.5, 0.19), {
  width: 1.18,
  height: 0.72,
  depth: 0.35,
  count: 3,
  body: kitchenFront,
});
casegood(room.onWall('back', 0.55, 1.5, 0.19), {
  width: 0.9,
  height: 0.72,
  depth: 0.35,
  count: 2,
  body: kitchenFront,
});
// Either side of and below the window (opening x -1.25 to -0.05).
kitchenBacksplash(room.onWall('back', -1.865, WORKTOP), 1.23, 1.5);
kitchenBacksplash(room.onWall('back', -0.65, WORKTOP), 1.2, 1.03);
kitchenBacksplash(room.onWall('back', 0.475, WORKTOP), 1.05, 1.5);
kitchenFridge(room.against('back', 1.395, 0.65));

// Left wall: counter run with cooktop and oven, open shelf with jars,
// cutting boards against the backsplash.
const leftRun = kitchenBaseRun(room.against('left', -1.58, 0.62), 1.96, {
  cooktop: 0.05,
  oven: 0.05,
});
kitchenBacksplash(room.onWall('left', -1.58, WORKTOP), 1.96, 1.45);
for (const [x, w, h, tilt] of [
  [-0.7, 0.24, 0.36, -0.1],
  [-0.55, 0.18, 0.3, -0.12],
] as const) {
  const boardPiece = box(
    [w, h, 0.02],
    mats.oak(),
    [x, WORKTOP + h / 2, -0.27],
    leftRun,
  );
  boardPiece.rotation.x = tilt;
}
{
  const shelf = room.onWall('left', -1.55, 1.55);
  box([1.5, 0.035, 0.25], mats.oak(), [0, 0, 0.125], shelf);
  for (const x of [-0.6, 0.6])
    box([0.02, 0.12, 0.2], mats.blackMetal(), [x, -0.075, 0.1], shelf);
  for (const [x, r, h, material] of [
    [-0.55, 0.05, 0.16, mats.ceramic()],
    [-0.4, 0.045, 0.2, mats.glass()],
    [-0.25, 0.05, 0.13, mats.ceramic()],
    [0.15, 0.06, 0.1, mats.stoneware()],
    [0.32, 0.045, 0.18, mats.ceramic()],
  ] as const) {
    cylinder(r, r, h, material, [x, 0.0175 + h / 2, 0.12], shelf, 20);
  }
  for (let i = 0; i < 3; i++)
    cylinder(
      0.09 - i * 0.008,
      0.07 - i * 0.008,
      0.03,
      mats.ceramic(),
      [0.55, 0.035 + i * 0.03, 0.12],
      shelf,
      24,
    );
  volume('shelf', [1.5, 0.25, 0.25], [0, 0.1, 0.125], shelf, 0.3);
}

// Island with stools on its overhang side, a fruit bowl and a pendant above.
const island = kitchenIsland(room.place(-0.3, -1.2));
{
  const bowl = mesh(
    own(
      new THREE.SphereGeometry(
        0.14,
        32,
        10,
        0,
        Math.PI * 2,
        Math.PI / 2,
        Math.PI / 2,
      ),
    ),
    standard({ color: '#6b4a32', roughness: 0.5, side: THREE.DoubleSide }),
    [0.15, WORKTOP + 0.075, -0.05],
    island,
  );
  bowl.scale.y = 0.55;
  for (const [x, z, color] of [
    [0.12, -0.04, '#d39a3a'],
    [0.19, -0.08, '#8fa35a'],
    [0.16, 0.02, '#c4543a'],
  ] as const) {
    mesh(
      own(new THREE.SphereGeometry(0.038, 16, 12)),
      paintMaterial(color, 0.6),
      [x, WORKTOP + 0.045, z],
      island,
    );
  }
}
for (const x of [-0.85, -0.3, 0.25])
  stool(room.place(x, -0.58), { height: 0.65 });
pendant(room.place(-0.3, -1.2, 0, 2.7), {
  drop: 0.85,
  color: '#b5654a',
  radius: 0.22,
});

// Dining corner by the right window, a print beside it.
roundTable(room.place(1.75, -0.6), { radius: 0.45 });
woodChair(room.place(1.75, -1.25, 0.1));
woodChair(room.place(1.75, 0.05, Math.PI - 0.1));
smallPlant(group(1.68, 0.74, -0.62), { size: 0.22, seed: 6 });
picture(room.onWall('right', 0.75, 1.55), {
  width: 0.6,
  height: 0.8,
  palette: ['#b5654a', '#7d8a72', '#d7a24b', '#e9dcc4'],
  seed: 7,
  frame: mats.oak(),
});
plant(room.place(2.12, -2.78), { height: 1.3, seed: 1 });

room.finish();
