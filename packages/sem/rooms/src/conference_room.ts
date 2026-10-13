// Conference room: an eight-seat meeting room, 4.5 x 6 m. Replaces the
// meeting_room capture.
//
// Layout (the viewer starts at the origin facing -Z, down the table):
//   back wall  (-Z)  large wall-mounted display over a low walnut credenza
//   left wall  (-X)  interior glass onto the corridor, with a frosted band
//   right wall (+X)  two outside windows with roller blinds, a whiteboard
//                    and a felt acoustic panel between them
//   front wall (+Z)  door to the corridor, two more felt panels
//   centre           3.2 x 1.2 m light-oak table, eight shell chairs
const room = createRoom({
  name: 'conference_room',
  width: 4.5,
  depth: 6,
  height: 2.75,
  z0: -5.4,
  wall: '#ece6dc',
  windows: [
    {
      wall: 'left',
      at: -2.35,
      width: 5.3,
      sill: 0.1,
      head: 2.6,
      view: 'corridor',
      mullions: 4,
    },
    { wall: 'right', at: -4.55, width: 1.0, sill: 0.9, head: 2.4, blind: 0.42 },
    { wall: 'right', at: -0.75, width: 1.6, sill: 0.9, head: 2.4, blind: 0.3 },
  ],
  doors: [{ wall: 'front', at: -1.5 }],
  sun: { window: 1, elevation: 52, azimuth: -8 },
  downlights: [],
  // The long glass wall adds many window samples to the bake; coarser
  // lightmaps keep the load time down without a visible difference.
  texelsPerMeter: 12,
});

// Conference table: a light-oak top on four square legs with a recessed
// apron and two cable ports. Long side along local Z.
function conferenceTable(
  g: THREE.Object3D,
  { width = 1.2, length = 3.2, height = 0.74 } = {},
) {
  const wood = mats.oak();
  const t = 0.04;
  const top = mesh(
    roundedBox(width, t, length, 0.008),
    wood,
    [0, height - t / 2, 0],
    g,
  );
  top.userData.xrPlane = 'table';
  const legHeight = height - t;
  const leg = 0.075;
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      mesh(
        roundedBox(leg, legHeight, leg, 0.006),
        wood,
        [
          x * (width / 2 - 0.02 - leg / 2),
          legHeight / 2,
          z * (length / 2 - 0.02 - leg / 2),
        ],
        g,
      );
    }
    box(
      [0.022, 0.08, length - 0.3],
      wood,
      [x * (width / 2 - 0.09), legHeight - 0.04, 0],
      g,
    );
  }
  for (const z of [-1, 1])
    box(
      [width - 0.3, 0.08, 0.022],
      wood,
      [0, legHeight - 0.04, z * (length / 2 - 0.09)],
      g,
    );
  for (const z of [-0.55, 0.55]) {
    box([0.15, 0.003, 0.09], mats.charcoal(), [0, height + 0.0015, z], g);
    box([0.11, 0.002, 0.012], mats.steel(), [0, height + 0.0035, z - 0.02], g);
  }
  volume('table', [width, height, length], [0, height / 2, 0], g, 0.45);
  return g;
}

// Linear LED strips flush in the ceiling (the only lights on).
const conferenceGlow = once(() => {
  const material = own(new THREE.MeshBasicMaterial({ color: '#fff4e4' }));
  material.color.multiplyScalar(2.2);
  return material;
});
function conferenceLightStrip(x: number, z: number, length: number) {
  box(
    [0.05, 0.012, length],
    conferenceGlow(),
    [x, room.bounds.height - 0.006, z],
    scene,
  ).castShadow = false;
  box(
    [0.08, 0.006, length + 0.03],
    mats.trim(),
    [x, room.bounds.height - 0.003, z],
    scene,
  ).castShadow = false;
}

// Display wall: a low walnut credenza, a 98" display above it, a plant.
const credenza = casegood(room.against('back', 0, 0.45), {
  width: 3.4,
  height: 0.6,
  depth: 0.45,
  fronts: 'doors',
  count: 5,
  body: mats.walnut(),
  handles: 'none',
});
// Two leaf sets share one pot (the second pot hides inside the first).
smallPlant(group(1.42, 0.6, 0.02, 0, credenza), {
  size: 0.56,
  pot: mats.ceramic(),
  seed: 4,
});
smallPlant(group(1.42, 0.6, 0.02, 0.26, credenza), {
  size: 0.5,
  pot: mats.ceramic(),
  seed: 9,
});
wallScreen(room.onWall('back', 0, 1.47), { width: 2.16, height: 1.22 });

// Table down the middle of the room, its near end in front of the viewer.
const tableZ = -2.6;
const tableLength = 3.2;
conferenceTable(room.place(0, tableZ), { width: 1.2, length: tableLength });

// Eight shell chairs: three along each side, two at the near end, tucked in
// a little unevenly, in a mix of sage and charcoal.
const sage = '#6f7a5e';
const charcoal = '#3d3f42';
// [side (-1 left, +1 right), z offset from the table centre, pull-out, yaw jitter, color]
const sideChairs: [number, number, number, number, string][] = [
  [-1, -1.0, 0.0, 0.05, sage],
  [-1, 0.0, 0.07, -0.08, charcoal],
  [-1, 1.0, 0.1, 0.1, charcoal],
  [1, -1.0, 0.04, -0.06, charcoal],
  [1, 0.0, 0.0, 0.04, sage],
  [1, 1.0, 0.08, -0.1, charcoal],
];
for (const [side, dz, pull, yaw, color] of sideChairs) {
  shellChair(
    room.place(side * (0.76 + pull), tableZ + dz, (-side * Math.PI) / 2 + yaw),
    { color },
  );
}
const nearEnd = tableZ + tableLength / 2;
shellChair(room.place(-0.36, nearEnd + 0.28, Math.PI + 0.08), { color: sage });
shellChair(room.place(0.36, nearEnd + 0.31, Math.PI - 0.1), {
  color: charcoal,
});

// Right wall: whiteboard and a felt panel between the two windows.
board(room.onWall('right', -3.15, 1.45), { width: 1.4, height: 1.15 });
acousticPanel(room.onWall('right', -2.05, 1.45), {
  width: 0.45,
  height: 1.3,
  color: sage,
});

// Front wall: two more felt panels opposite the display.
for (const [x, color] of [
  [0.55, charcoal],
  [1.07, sage],
] as const)
  acousticPanel(room.onWall('front', x, 1.4), {
    width: 0.45,
    height: 1.3,
    color,
  });

// Ceiling: two linear light strips along the table.
for (const x of [-0.75, 0.75]) conferenceLightStrip(x, tableZ, 4.2);

room.finish();
