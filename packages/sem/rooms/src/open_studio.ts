// Open studio: a deliberately empty 6 x 6 m room for fitness, locomotion,
// large play spaces and baseline plane detection. Oak floor, plain walls.
//
// Layout (the viewer starts at the origin facing -Z, on open floor):
//   left wall  (-X)  one wide, low-sill window; the sun patch lands on the
//                    open floor ahead-left of the viewer; a small plant on the sill
//   back wall  (-Z)  low wooden bench, rolled yoga mat, door, floor plant
//   right wall (+X)  tall framed mirror panel
//   front wall (+Z)  plain
// A robot vacuum drives a loop across the open floor.
const room = createRoom({
  name: 'open_studio',
  width: 6,
  depth: 6,
  z0: -3.3,
  windows: [
    { wall: 'left', at: 0, width: 2.2, sill: 0.45, head: 2.3, sheers: false },
  ],
  doors: [{ wall: 'back', at: 1.3 }],
  floor: 'oak',
  wall: '#efe4d3',
  sun: { elevation: 32, azimuth: 25 },
  robot: { center: [0.2, -1.4], radius: [1.5, 0.9], speed: 0.3 },
});

// Warm oak for the bench, a shade richer than the floor.
const studioWood = once(() =>
  standard({ map: oakVeneerTexture(), color: '#c9ab8f', roughness: 0.5 }),
);

// Low slab bench: a thick top on two inset slab legs with a back apron.
function studioBench(
  g: THREE.Object3D,
  { width = 1.2, depth = 0.36, height = 0.45 } = {},
) {
  const wood = studioWood();
  const top = 0.045;
  const legHeight = height - top;
  mesh(roundedBox(width, top, depth, 0.008), wood, [0, height - top / 2, 0], g);
  for (const s of [-1, 1]) {
    mesh(
      roundedBox(0.05, legHeight, depth - 0.04, 0.006),
      wood,
      [s * (width / 2 - 0.13), legHeight / 2, 0],
      g,
    );
  }
  box(
    [width - 0.31, 0.06, 0.02],
    wood,
    [0, height - top - 0.03, -depth / 2 + 0.05],
    g,
  );
  volume('other', [width, height, depth], [0, height / 2, 0], g, 0.45);
  return g;
}

// Rolled yoga mat standing on end, with two carry straps (untagged).
function studioYogaMat(
  g: THREE.Object3D,
  { length = 0.61, radius = 0.065, color = '#6d7c5a' } = {},
) {
  cylinder(
    radius,
    radius,
    length,
    paintMaterial(color, 0.9),
    [0, length / 2, 0],
    g,
    32,
  );
  for (const y of [length * 0.22, length * 0.78]) {
    cylinder(
      radius + 0.003,
      radius + 0.003,
      0.025,
      mats.charcoal(),
      [0, y, 0],
      g,
      32,
    );
  }
  const end = mesh(
    own(new THREE.RingGeometry(radius * 0.25, radius * 0.97, 32)),
    paintMaterial('#56633f', 0.95),
    [0, length + 0.001, 0],
    g,
    { cast: false },
  );
  end.rotation.x = -Math.PI / 2;
  return g;
}

// Horizontal transom across the window frame, so the sun patch shows a cross.
function studioTransom(at: number, width: number, y: number) {
  const g = room.onWall('left', at, 0);
  box([width - 0.1, 0.045, 0.06], mats.trim(), [0, y, -0.12], g);
  return g;
}

studioTransom(0, 2.2, 1.45);
// Small plant on the window sill, at the front end of the window.
smallPlant(group(-0.85, 0.45, -0.02, 0, room.onWall('left', 0, 0)), {
  size: 0.34,
  pot: mats.pot(),
  seed: 4,
});

// Back wall: bench and yoga mat left of centre, the door, a plant in the corner.
studioBench(room.against('back', -1.45, 0.36));
studioYogaMat(room.place(-0.55, room.bounds.z0 + 0.1));
plant(room.place(2.6, room.bounds.z0 + 0.4), { height: 1.6, seed: 1 });

// Right wall: a tall mirror panel.
mirror(room.onWall('right', -0.6, 1.2), {
  width: 0.85,
  height: 1.75,
  frame: mats.oak(),
});

room.finish();
