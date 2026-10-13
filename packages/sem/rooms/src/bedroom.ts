// Bedroom: a calm 4.5 x 4.5 m bedroom with a queen bed. The only room with
// a 'bed' label.
//
// Layout (the viewer starts at the origin facing -Z, looking at the bed):
//   back wall  (-Z)  floor plant in the corner, three-door wardrobe, queen bed
//                    between two oak nightstands with lamps, landscape print
//   left wall  (-X)  window with sheers, reading chair and floor lamp
//   right wall (+X)  low dresser under an oval mirror
//   front wall (+Z)  door
const room = createRoom({
  name: 'bedroom',
  width: 4.5,
  depth: 4.5,
  z0: -3.0,
  windows: [{ wall: 'left', at: -0.75, width: 1.1, sill: 0.8, head: 2.25 }],
  doors: [{ wall: 'front', at: 1.0 }],
  sun: { azimuth: 20 },
});

// Four slim tapered legs under a w x d footprint, splayed outwards a little.
function bedroomLegs(
  g: THREE.Object3D,
  width: number,
  depth: number,
  height: number,
  wood: THREE.Material,
  inset = 0.04,
  splay = 0.06,
) {
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      const leg = cylinder(
        0.018,
        0.012,
        height,
        wood,
        [x * (width / 2 - inset), height / 2, z * (depth / 2 - inset)],
        g,
        8,
      );
      leg.rotation.set(-z * splay, 0, x * splay);
    }
  }
}

// Queen bed: upholstered base and headboard on oak legs, mattress, a linen
// duvet with a turned-down top, a throw across the foot, two sleeping pillows
// and two accent cushions. Faces +Z (headboard at local -Z).
function bedroomBed(
  g: THREE.Object3D,
  {
    width = 1.6,
    length = 2.0,
    frame = '#cbc3b6',
    linen = '#ece6db',
    sheet = '#f4f1ea',
    throwColor = '#87906d',
    cushions = ['#b0603c', '#7b8766'],
    wood = mats.oak() as THREE.Material,
  } = {},
) {
  const upholstery = fabricMaterial(frame, 61);
  const duvet = fabricMaterial(linen, 62);
  const sheets = fabricMaterial(sheet, 62);
  const W = width + 0.06; // base footprint
  const L = length + 0.06;
  const T = L + 0.1; // with the headboard
  const legs = 0.12;
  const baseZ = 0.05;
  const top = legs + 0.22 + 0.2; // mattress top
  // Base, legs and headboard.
  mesh(roundedBox(W, 0.22, L, 0.04), upholstery, [0, legs + 0.11, baseZ], g);
  bedroomLegs(group(0, 0, baseZ, 0, g), W, L, legs, wood, 0.1, 0.08);
  mesh(
    roundedBox(W + 0.06, 1.1, 0.1, 0.045, 0, 4),
    upholstery,
    [0, 0.6, -T / 2 + 0.05],
    g,
  );
  // Mattress (seen at the head end) and duvet draped over the sides.
  mesh(
    roundedBox(width, 0.2, length, 0.05),
    sheets,
    [0, legs + 0.22 + 0.1, baseZ],
    g,
  );
  const duvetStart = baseZ - length / 2 + 0.48;
  const duvetEnd = baseZ + length / 2 + 0.05;
  const duvetLength = duvetEnd - duvetStart;
  mesh(
    roundedBox(W + 0.06, 0.3, duvetLength, 0.07, 0.02, 6),
    duvet,
    [0, top + 0.065 - 0.15, (duvetStart + duvetEnd) / 2],
    g,
  );
  mesh(
    roundedBox(W + 0.09, 0.33, 0.3, 0.06, 0.012),
    duvet,
    [0, top + 0.095 - 0.165, duvetStart + 0.14],
    g,
  );
  // Throw across the foot of the bed.
  mesh(
    roundedBox(W + 0.1, 0.31, 0.55, 0.04, 0.004),
    fabricMaterial(throwColor, 63),
    [0, top + 0.105 - 0.155, duvetEnd - 0.42],
    g,
  );
  // Sleeping pillows leaning on the headboard, accent cushions in front.
  const headZ = -T / 2 + 0.1;
  for (const s of [-1, 1]) {
    const pillow = mesh(
      roundedBox(0.7, 0.16, 0.44, 0.07, 0.035, 6),
      sheets,
      [s * 0.38, top + 0.2, headZ + 0.16],
      g,
    );
    pillow.rotation.set(1.1, s * 0.03, 0);
  }
  cushions.forEach((color, i) => {
    const s = i === 0 ? -1 : 1;
    const cushion = mesh(
      roundedBox(0.44, 0.13, 0.4, 0.06, 0.03, 6),
      fabricMaterial(color, 64),
      [s * 0.2, top + 0.18, headZ + 0.36],
      g,
    );
    cushion.rotation.set(1.2, s * 0.12, -s * 0.06);
  });
  // A room scan reports a bed as a volume plus a (here invisible) top plane.
  const bedTop = mesh(unitPlane, mats.hidden(), [0, top + 0.05, baseZ], g, {
    cast: false,
    receive: false,
  });
  bedTop.rotation.x = -Math.PI / 2;
  bedTop.scale.set(W, L, 1);
  bedTop.userData.xrPlane = 'bed';
  volume('bed', [W + 0.06, 1.15, T], [0, 0.575, 0], g, 0.85);
  return g;
}

// Oak nightstand on legs: two drawers, its top a 'table' plane.
function bedroomNightstand(
  g: THREE.Object3D,
  {
    width = 0.44,
    depth = 0.38,
    height = 0.56,
    legs = 0.14,
    wood = mats.oak() as THREE.Material,
  } = {},
) {
  casegood(group(0, legs, 0, 0, g), {
    width,
    height: height - legs - 0.02,
    depth,
    fronts: 'drawers',
    count: 2,
    body: wood,
    label: '',
  });
  const top = mesh(
    roundedBox(width + 0.02, 0.02, depth + 0.02, 0.006),
    wood,
    [0, height - 0.01, 0],
    g,
  );
  top.userData.xrPlane = 'table';
  bedroomLegs(g, width, depth, legs, wood);
  volume(
    'table',
    [width + 0.02, height, depth + 0.04],
    [0, height / 2, 0.01],
    g,
    0.6,
  );
  return g;
}

// Low six-drawer dresser on legs (two columns of three drawers).
function bedroomDresser(
  g: THREE.Object3D,
  {
    width = 1.3,
    depth = 0.46,
    height = 0.82,
    legs = 0.1,
    wood = mats.oak() as THREE.Material,
  } = {},
) {
  for (const s of [-1, 1]) {
    casegood(group((s * width) / 4, legs, 0, 0, g), {
      width: width / 2,
      height: height - legs,
      depth,
      fronts: 'drawers',
      count: 3,
      body: wood,
      label: '',
    });
  }
  bedroomLegs(g, width, depth, legs, wood, 0.05, 0.04);
  volume('shelf', [width, height, depth + 0.04], [0, height / 2, 0.01], g, 0.7);
  return g;
}

// Oak veneer with vertical grain, for tall doors.
const bedroomVerticalOak = once(() => {
  const map = own(oakVeneerTexture().clone());
  map.rotation = Math.PI / 2;
  map.needsUpdate = true;
  return standard({ map, roughness: 0.55 });
});

// Back wall: plant in the corner, wardrobe, bed between nightstands.
const bedX = 0.8;
bedroomBed(room.against('back', bedX, 2.16));
picture(room.onWall('back', bedX, 1.68), {
  width: 0.9,
  height: 0.68,
  art: 'landscape',
  seed: 2,
  frame: mats.oak(),
});
const nightstands = [bedX - 1.12, bedX + 1.12].map((x) =>
  bedroomNightstand(room.against('back', x, 0.4)),
);
nightstands.forEach((stand, i) =>
  tableLamp(group(0, 0.56, -0.02, 0, stand), { lit: i === 0 }),
);
casegood(room.against('back', -1.105, 0.58), {
  width: 1.05,
  height: 2.25,
  depth: 0.58,
  fronts: 'doors',
  count: 3,
  body: bedroomVerticalOak(),
});
plant(room.place(-1.93, -2.68), { height: 1.5, seed: 1 });

// Soft wool rug under the bed, extending past its foot.
rug(room.place(bedX, -1.3), {
  width: 2.4,
  depth: 2.4,
  style: 'plain',
  field: '#f1eadc',
});

// Reading corner by the window: lounge chair with a cushion, floor lamp.
const chair = loungeChair(room.place(-1.55, -0.2, 1.0), {
  color: '#ddd3c3',
  wood: mats.oak(),
});
mesh(
  roundedBox(0.42, 0.12, 0.4, 0.055, 0.03, 6),
  fabricMaterial('#b0603c', 64),
  [-0.12, 0.69, -0.1],
  chair,
).rotation.set(1.25, 0, 0.12);
floorLamp(room.place(-1.95, 0.62));

// Dresser on the right wall under an oval mirror, with a few things on top.
const dresser = bedroomDresser(room.against('right', 0.3, 0.46));
{
  const top = 0.82;
  smallPlant(group(-0.42, top, -0.06, 0, dresser), {
    size: 0.3,
    pot: paintMaterial('#6f7c5e', 0.5),
    seed: 4,
  });
  box(
    [0.26, 0.03, 0.19],
    mats.white(),
    [0.1, top + 0.015, 0.02],
    dresser,
  ).rotation.y = 0.15;
  box(
    [0.24, 0.025, 0.17],
    paintMaterial('#6f7c5e', 0.5),
    [0.1, top + 0.0425, 0.02],
    dresser,
  ).rotation.y = 0.05;
  cylinder(
    0.1,
    0.06,
    0.06,
    mats.walnut(),
    [0.42, top + 0.03, 0.02],
    dresser,
    24,
  );
}
// Oval mirror (a stretched round one) with an oak rim over the kit's ring.
{
  const wall = room.onWall('right', 0.3, 1.5);
  wall.scale.set(1, 1.4, 1);
  mirror(wall, { radius: 0.3 });
  mesh(
    own(new THREE.TorusGeometry(0.315, 0.022, 12, 96)),
    mats.oak(),
    [0, 0, 0.022],
    wall,
  );
}

room.finish();
