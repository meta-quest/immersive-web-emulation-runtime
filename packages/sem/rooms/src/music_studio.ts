// Music studio: a home music room, 5 x 4.5 m. Replaces the music_room
// capture. Instruments give developers irregular, non-box objects.
//
// Layout (the viewer starts at the origin facing -Z):
//   back wall  (-Z)  floor plant, two guitars on stands, window with a
//                    roller blind, desk with keyboard controller and studio
//                    monitors, lit floor lamp; diffusers and felt panels
//   left wall  (-X)  upright piano with bench under a diffuser, a guitar
//   right wall (+X)  record shelf with turntable, lounge chair, side table
//   front wall (+Z)  door
const room = createRoom({
  name: 'music_studio',
  width: 5,
  depth: 4.5,
  z0: -2.9,
  wall: '#ede7dd',
  // A blind rather than sheers: sheers would hang into the desk and stands.
  windows: [
    { wall: 'back', at: -0.4, width: 1.2, sill: 0.8, head: 2.25, blind: 0.2 },
  ],
  doors: [{ wall: 'front', at: -1.4 }],
  sun: { azimuth: -12, elevation: 36 },
});

const studioLacquer = paintMaterial('#1f1c1b', 0.25);
const studioWhite = paintMaterial('#f4f1ea', 0.35);
const studioBlack = paintMaterial('#141414', 0.4);

// Upright piano facing +Z with 52 white and 36 black keys (instanced).
function studioPiano(g: THREE.Object3D) {
  const width = 1.5;
  box([width, 0.62, 0.36], studioLacquer, [0, 0.31, -0.12], g);
  for (const x of [-0.68, 0.68])
    box([0.07, 0.62, 0.07], studioLacquer, [x, 0.31, 0.2], g);
  box([width, 0.07, 0.26], studioLacquer, [0, 0.665, 0.17], g);
  box([width, 0.56, 0.3], studioLacquer, [0, 0.98, -0.15], g);
  box([width + 0.02, 0.03, 0.34], studioLacquer, [0, 1.275, -0.14], g);
  box([1.32, 0.26, 0.03], studioLacquer, [0, 0.9, 0.03], g).rotation.x = -0.12;
  for (const x of [-width / 2 + 0.035, width / 2 - 0.035])
    box([0.07, 0.12, 0.27], studioLacquer, [x, 0.74, 0.17], g);
  for (const x of [-0.08, 0, 0.08])
    box([0.025, 0.012, 0.07], mats.brass(), [x, 0.06, 0.1], g);
  const keys = 52;
  const keyWidth = (width - 0.16) / keys;
  const whites = own(
    new THREE.InstancedMesh(
      own(new THREE.BoxGeometry(keyWidth - 0.0015, 0.022, 0.15)),
      studioWhite,
      keys,
    ),
  );
  const blacks = own(
    new THREE.InstancedMesh(
      own(new THREE.BoxGeometry(keyWidth * 0.55, 0.018, 0.09)),
      studioBlack,
      36,
    ),
  );
  const matrix = new THREE.Matrix4();
  let black = 0;
  for (let i = 0; i < keys; i++) {
    const x = -width / 2 + 0.08 + keyWidth * (i + 0.5);
    whites.setMatrixAt(i, matrix.makeTranslation(x, 0.711, 0.22));
    // A black key follows A, C, D, F and G (the keyboard starts on A).
    const note = (5 + i) % 7;
    if ([0, 1, 3, 4, 5].includes(note) && i < keys - 1 && black < 36) {
      blacks.setMatrixAt(
        black++,
        matrix.makeTranslation(x + keyWidth / 2, 0.728, 0.185),
      );
    }
  }
  blacks.count = black;
  whites.castShadow = blacks.castShadow = true;
  g.add(whites, blacks);
  volume('other', [width + 0.02, 1.29, 0.6], [0, 0.645, 0.02], g, 0.7);
  return g;
}

// Padded piano bench.
function studioBench(g: THREE.Object3D) {
  mesh(
    roundedBox(0.78, 0.08, 0.34, 0.03, 0.01, 4),
    paintMaterial('#2a2624', 0.6),
    [0, 0.5, 0],
    g,
  );
  for (const x of [-0.34, 0.34]) {
    for (const z of [-0.13, 0.13])
      box([0.04, 0.46, 0.04], studioLacquer, [x, 0.23, z], g);
  }
  volume('other', [0.78, 0.54, 0.34], [0, 0.27, 0], g, 0.3);
  return g;
}

// Guitar on an A-frame stand, facing +Z. 'acoustic' or 'electric'.
function studioGuitar(
  g: THREE.Object3D,
  kind: 'acoustic' | 'electric',
  color: string,
) {
  const electric = kind === 'electric';
  const body = new THREE.Group();
  body.position.set(0, 0.12, 0);
  body.rotation.x = -0.18;
  g.add(body);
  const finish = paintMaterial(color, 0.3);
  const thickness = electric ? 0.045 : 0.1;
  const [lower, upper] = electric ? [0.165, 0.125] : [0.19, 0.145];
  for (const [r, y] of [
    [lower, lower],
    [upper, lower * 2 + upper * 0.55],
  ]) {
    const bout = cylinder(r, r, thickness, finish, [0, y, 0], body, 40);
    bout.rotation.x = Math.PI / 2;
  }
  const front = thickness / 2 + 0.001;
  if (electric) {
    const guard = mesh(
      own(new THREE.CircleGeometry(0.1, 24)),
      studioWhite,
      [0.03, lower * 0.9, front],
      body,
      { cast: false },
    );
    guard.scale.set(1, 1.4, 1);
    box(
      [0.07, 0.012, 0.004],
      paintMaterial('#cfcfcf', 0.3, 0.8),
      [0, lower * 1.3, front + 0.002],
      body,
    );
  } else {
    mesh(
      own(new THREE.CircleGeometry(0.045, 24)),
      studioBlack,
      [0, lower * 2 + 0.02, front],
      body,
      { cast: false },
    );
    box(
      [0.12, 0.02, 0.012],
      mats.darkWalnut(),
      [0, lower * 0.7, front + 0.004],
      body,
    );
  }
  const neckBase = lower * 2 + upper * 1.3;
  box([0.05, 0.46, 0.025], mats.darkWalnut(), [0, neckBase + 0.21, 0.01], body);
  box(
    [0.075, 0.17, 0.02],
    electric ? finish : mats.darkWalnut(),
    [0, neckBase + 0.52, 0.0],
    body,
  );
  // Stand: two front legs and a back leg.
  for (const s of [-1, 1]) {
    const leg = cylinder(
      0.008,
      0.008,
      0.62,
      mats.blackMetal(),
      [s * 0.12, 0.3, 0.06],
      g,
      6,
    );
    leg.rotation.z = s * 0.25;
  }
  const back = cylinder(
    0.008,
    0.008,
    0.78,
    mats.blackMetal(),
    [0, 0.37, -0.12],
    g,
    6,
  );
  back.rotation.x = 0.35;
  box([0.3, 0.025, 0.05], mats.blackMetal(), [0, 0.13, 0.1], g);
  volume('other', [0.42, 1.05, 0.36], [0, 0.525, 0], g, 0.3);
  return g;
}

// Studio monitor speaker (put `g` on the desk).
function studioSpeaker(g: THREE.Object3D) {
  box([0.17, 0.27, 0.21], studioBlack, [0, 0.135, 0], g);
  cylinder(
    0.06,
    0.06,
    0.012,
    paintMaterial('#d8d4cc', 0.5),
    [0, 0.09, 0.106],
    g,
    24,
  ).rotation.x = Math.PI / 2;
  cylinder(
    0.022,
    0.022,
    0.012,
    paintMaterial('#9a9690', 0.4),
    [0, 0.205, 0.106],
    g,
    16,
  ).rotation.x = Math.PI / 2;
  return g;
}

// 49-key controller keyboard (put `g` on the desk).
function studioController(g: THREE.Object3D) {
  box([0.82, 0.045, 0.26], mats.charcoal(), [0, 0.0225, 0], g);
  box([0.72, 0.012, 0.12], studioWhite, [0.02, 0.05, 0.05], g);
  const blacks = own(
    new THREE.InstancedMesh(
      own(new THREE.BoxGeometry(0.008, 0.012, 0.07)),
      studioBlack,
      20,
    ),
  );
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 20; i++)
    blacks.setMatrixAt(
      i,
      matrix.makeTranslation(-0.32 + i * 0.035, 0.058, 0.03),
    );
  g.add(blacks);
  for (let i = 0; i < 8; i++)
    cylinder(
      0.008,
      0.008,
      0.012,
      studioWhite,
      [-0.36 + i * 0.03, 0.05, -0.08],
      g,
      10,
    );
  return g;
}

// Wooden diffuser: a grid of oak blocks of varying depth on a backing board
// (on a wall group).
function studioDiffuser(g: THREE.Object3D, size: number, cells = 6, seed = 0) {
  box([size, size, 0.02], mats.darkWalnut(), [0, 0, 0.01], g);
  const cell = size / cells;
  const blocks = own(
    new THREE.InstancedMesh(
      own(new THREE.BoxGeometry(cell * 0.92, cell * 0.92, 1)),
      mats.walnut(),
      cells * cells,
    ),
  );
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const depth = 0.02 + hash(i, j, seed) * 0.08;
      matrix.compose(
        new THREE.Vector3(
          -size / 2 + cell * (i + 0.5),
          -size / 2 + cell * (j + 0.5),
          0.02 + depth / 2,
        ),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, depth),
      );
      blocks.setMatrixAt(i * cells + j, matrix);
    }
  }
  blocks.castShadow = blocks.receiveShadow = true;
  g.add(blocks);
  return g;
}

// Low record shelf: open walnut shelving with instanced sleeves and a
// turntable on top.
function studioRecordShelf(g: THREE.Object3D) {
  const width = 1.6;
  casegood(g, {
    width,
    height: 0.75,
    depth: 0.4,
    fronts: 'open',
    count: 2,
    body: mats.walnut(),
  });
  const palette = [
    '#2f3e46',
    '#b9673f',
    '#e3dccf',
    '#55624a',
    '#d7a24b',
    '#3c3c3c',
    '#8c4f3b',
    '#cbb79a',
  ];
  const sleeves = own(
    new THREE.InstancedMesh(
      own(new THREE.BoxGeometry(1, 1, 1)),
      mats.book(),
      120,
    ),
  );
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  let count = 0;
  for (let level = 0; level < 2; level++) {
    const y = 0.02 + level * 0.365 + 0.01;
    for (
      let x = -width / 2 + 0.05;
      x < width / 2 - 0.06 && count < 120;
      x += 0.009
    ) {
      const tilt = Math.sin(x * 9 + level) * 0.04;
      matrix.compose(
        new THREE.Vector3(x, y + 0.16, 0),
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          tilt,
        ),
        new THREE.Vector3(0.007, 0.31, 0.31),
      );
      sleeves.setMatrixAt(count, matrix);
      sleeves.setColorAt(
        count,
        color
          .set(palette[Math.floor(hash(count, 3, 11) * palette.length)])
          .multiplyScalar(0.8 + hash(count, 4, 11) * 0.3),
      );
      count++;
    }
  }
  sleeves.count = count;
  g.add(sleeves);
  const deck = group(0.35, 0.75, 0, 0, g);
  box([0.45, 0.09, 0.36], mats.walnut(), [0, 0.045, 0], deck);
  cylinder(0.15, 0.15, 0.015, studioBlack, [-0.05, 0.1, 0], deck, 40);
  box([0.015, 0.012, 0.2], mats.steel(), [0.15, 0.105, 0.0], deck).rotation.y =
    0.3;
  return g;
}

// Back wall, left of the window: plant, two guitars, a diffuser above.
plant(room.place(-2.15, -2.55), { height: 1.35, seed: 3 });
studioGuitar(room.place(-1.55, -2.62, 0.15), 'electric', '#b5562e');
studioGuitar(room.place(-1.04, -2.6, -0.1), 'acoustic', '#c99a5e');
studioDiffuser(room.onWall('back', -1.95, 1.85), 0.6, 5, 1);

// Back wall, right of the window: desk with controller, monitors and a
// laptop, task chair, lit floor lamp, felt panels and a diffuser.
const studioDesk = desk(room.against('back', 1.15, 0.65), {
  width: 1.4,
  depth: 0.65,
  top: mats.walnut(),
  drawers: 'none',
});
studioController(group(-0.05, 0.74, 0.04, 0, studioDesk));
studioSpeaker(group(-0.56, 0.74, -0.12, 0.2, studioDesk));
studioSpeaker(group(0.5, 0.74, -0.12, -0.2, studioDesk));
box(
  [0.32, 0.018, 0.22],
  mats.steel(),
  [0.3, 0.749, -0.13],
  studioDesk,
).rotation.y = 0.1;
taskChair(room.place(1.1, -1.82, Math.PI + 0.15), { color: '#7d8a6a' });
floorLamp(room.place(2.15, -2.55), { lit: true });
acousticPanel(room.onWall('back', 0.98, 1.7), {
  width: 0.42,
  height: 0.9,
  color: '#7d8a6a',
});
studioDiffuser(room.onWall('back', 1.5, 1.7), 0.55, 5, 2);
acousticPanel(room.onWall('back', 2.02, 1.7), {
  width: 0.42,
  height: 0.9,
  color: '#7d8a6a',
});

// Left wall: upright piano with bench, a diffuser between felt panels, and
// an acoustic guitar near the front.
const piano = studioPiano(room.against('left', -1.0, 0.6));
studioBench(group(0, 0, 0.55, 0, piano));
studioDiffuser(room.onWall('left', -1.0, 1.85), 0.8, 6, 3);
acousticPanel(room.onWall('left', -2.05, 1.75), {
  width: 0.5,
  height: 1.0,
  color: '#6f7a63',
});
acousticPanel(room.onWall('left', 0.05, 1.75), {
  width: 0.5,
  height: 1.0,
  color: '#6f7a63',
});
studioGuitar(room.place(-2.1, 0.55, 1.2), 'acoustic', '#b98a54');

// Right wall: record shelf with a slat panel above, lounge chair and side table.
studioRecordShelf(room.against('right', -0.7, 0.4));
{
  const slats = room.onWall('right', -0.7, 1.65);
  box([1.2, 0.9, 0.015], fabricMaterial('#3c3f38', 60), [0, 0, 0.008], slats);
  for (let i = 0; i < 16; i++)
    box(
      [0.035, 0.9, 0.025],
      mats.walnut(),
      [-0.5625 + i * 0.075, 0, 0.028],
      slats,
    );
}
loungeChair(room.place(1.38, 0.98, -2.3), { color: '#7d8a6a' });
const studioSide = roundTable(room.place(2.24, 0.72), {
  radius: 0.22,
  height: 0.5,
  top: mats.walnut(),
});
cylinder(0.08, 0.06, 0.05, mats.oak(), [0, 0.525, 0], studioSide, 24);

rug(room.place(0.05, -0.55), {
  width: 2.6,
  depth: 2.0,
  style: 'border',
  field: '#c9b48f',
  accent: '#a8916a',
});

room.finish();
