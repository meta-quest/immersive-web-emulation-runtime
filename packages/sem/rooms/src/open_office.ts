// Open office: a team office area, 8 x 7 m with a 3 m ceiling. Replaces the
// office_large capture. A Quest room scan covers at most 10 x 10 m, so this
// is one team's corner of a floor, not a whole open-plan floor.
//
// Layout (the viewer starts at the origin facing -Z):
//   back wall  (-Z)  wall art behind the bench desk; sofa in the lounge
//   left wall  (-X)  whiteboard
//   right wall (+X)  three tall windows along the lounge
//   front wall (+Z)  door
//   centre-left      double-sided bench desk for six with monitors, a felt
//                    privacy screen and hanging acoustic baffles above
//   centre           planter cabinet run and a structural column
//   right            lounge: sofa, two lounge chairs, coffee table, rug
// A robot vacuum loops across the open floor at the front.
const room = createRoom({
  name: 'open_office',
  width: 8,
  depth: 7,
  height: 3,
  z0: -4.5,
  wall: '#eee9e1',
  windows: [
    {
      wall: 'right',
      at: -3.3,
      width: 1.5,
      sill: 0.6,
      head: 2.6,
      sheers: false,
    },
    {
      wall: 'right',
      at: -1.3,
      width: 1.5,
      sill: 0.6,
      head: 2.6,
      sheers: false,
    },
    { wall: 'right', at: 0.7, width: 1.5, sill: 0.6, head: 2.6, sheers: false },
  ],
  doors: [{ wall: 'front', at: -2.8 }],
  sun: { window: 1, elevation: 38, azimuth: 20 },
  texelsPerMeter: 12,
  robot: { center: [0, 1.25], radius: [2.1, 0.55], speed: 0.3 },
});

// Double-sided bench desk along local X with seats on both long sides: a
// 'desk' plane, a felt privacy screen, monitors and keyboards per seat.
function officeBench(
  g: THREE.Object3D,
  { length = 3.0, depth = 1.5, seatsPerSide = 3 } = {},
) {
  const height = 0.74;
  const top = mesh(
    roundedBox(length, 0.03, depth, 0.008),
    mats.oak(),
    [0, height - 0.015, 0],
    g,
  );
  top.userData.xrPlane = 'desk';
  const frame = paintMaterial('#e9e6e0', 0.5, 0.3);
  for (const x of [-length / 2 + 0.06, 0, length / 2 - 0.06]) {
    for (const z of [-depth / 2 + 0.08, depth / 2 - 0.08])
      box([0.05, height - 0.03, 0.05], frame, [x, (height - 0.03) / 2, z], g);
    box([0.05, 0.05, depth - 0.16], frame, [x, height - 0.055, 0], g);
  }
  box(
    [length - 0.1, 0.4, 0.03],
    fabricMaterial('#7d8a72', 60),
    [0, height + 0.2, 0],
    g,
  );
  const spacing = length / seatsPerSide;
  for (const side of [-1, 1]) {
    for (let i = 0; i < seatsPerSide; i++) {
      const x = -length / 2 + spacing * (i + 0.5);
      // Untracked, to stay within the objects a room scan reports.
      monitor(group(x, height, side * 0.3, side > 0 ? 0 : Math.PI, g), {
        width: 0.6,
        height: 0.35,
        tracked: false,
      });
      mesh(
        roundedBox(0.42, 0.015, 0.13, 0.004),
        mats.charcoal(),
        [x, height + 0.008, side * 0.55],
        g,
      );
    }
  }
  volume('desk', [length, height, depth], [0, height / 2, 0], g, 0.45);
  return g;
}

// Low storage run along local X topped with a planter of leafy plants.
function officePlanterCabinet(g: THREE.Object3D, length: number) {
  casegood(g, {
    width: length,
    height: 0.72,
    depth: 0.45,
    count: 4,
    body: mats.white(),
    front: mats.oak(),
    handles: 'none',
  });
  box([length - 0.1, 0.16, 0.32], mats.charcoal(), [0, 0.8, 0], g);
  const plants = Math.round(length / 0.45);
  for (let i = 0; i < plants; i++) {
    smallPlant(
      group(
        -length / 2 + 0.2 + (i * (length - 0.4)) / (plants - 1),
        0.8,
        0,
        i,
        g,
      ),
      { size: 0.42, pot: mats.charcoal(), seed: i },
    );
  }
  return g;
}

// Hanging felt baffles running along X, hung on thin cables.
function officeBaffles(
  x: number,
  z0: number,
  z1: number,
  count: number,
  length: number,
) {
  const felt = fabricMaterial('#a3ad94', 61);
  for (let i = 0; i < count; i++) {
    const z = z0 + ((z1 - z0) * i) / Math.max(1, count - 1);
    const baffle = group(x, 2.55, z);
    box([length, 0.32, 0.05], felt, [0, 0, 0], baffle);
    for (const dx of [-length / 2 + 0.2, length / 2 - 0.2])
      cylinder(0.002, 0.002, 0.29, mats.steel(), [dx, 0.305, 0], baffle, 4);
  }
}

// Work zone: bench desk for six, task chairs, baffles above, art and a
// whiteboard on the walls.
officeBench(room.place(-1.6, -2.4), { length: 3.0, depth: 1.5 });
for (const x of [-2.6, -1.6, -0.6]) {
  taskChair(room.place(x, -3.5, 0.06 * x));
  taskChair(room.place(x, -1.28, Math.PI - 0.06 * x));
}
officeBaffles(-1.6, -3.5, -1.3, 5, 2.8);
picture(room.onWall('back', -1.6, 1.75), {
  width: 1.4,
  height: 0.95,
  palette: ['#7d8a72', '#b9673f', '#e2d5bf', '#3e4a46'],
  seed: 11,
  frame: mats.oak(),
});
board(room.onWall('left', -2.4, 1.45), {
  width: 1.6,
  height: 1.0,
  kind: 'white',
});
plant(room.place(-3.55, -4.05), { height: 1.6, seed: 4 });

// Zone divider: planter cabinet run and a structural column.
officePlanterCabinet(room.place(0.6, -2.4, Math.PI / 2), 2.4);
{
  const column = room.place(0.6, -0.55);
  box([0.5, 3.0, 0.5], paintMaterial('#ece7df', 0.9), [0, 1.5, 0], column);
  volume('other', [0.5, 3.0, 0.5], [0, 1.5, 0], column, 0.6);
}

// Lounge by the windows: sofa, two lounge chairs, coffee table on a rug.
sofa(room.against('back', 2.45, 0.94), {
  width: 2.1,
  color: '#b2643e',
  pillows: ['#7d8a72', '#e8e2d5'],
});
loungeChair(room.place(3.44, -2.45, -1.86), { color: '#7d8a72' });
loungeChair(room.place(1.44, -2.35, 1.95), { color: '#7d8a72' });
const coffee = roundTable(room.place(2.45, -2.7), {
  radius: 0.45,
  height: 0.42,
  top: mats.walnut(),
});
smallPlant(group(0.1, 0.42, 0.05, 0, coffee), {
  size: 0.2,
  pot: mats.ceramic(),
  seed: 9,
});
box(
  [0.24, 0.03, 0.18],
  paintMaterial('#e2dacb', 0.8),
  [-0.15, 0.435, -0.05],
  coffee,
).rotation.y = 0.3;
rug(room.place(2.45, -2.95), {
  width: 2.8,
  depth: 2.3,
  style: 'border',
  field: '#d8cdb9',
  accent: '#9e927d',
});
officeBaffles(2.45, -3.6, -2.2, 3, 2.4);
plant(room.place(3.5, 1.95), { height: 1.5, seed: 6 });

room.finish();
