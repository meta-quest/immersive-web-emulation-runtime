// Home office: a small study, 3.5 x 4 m. Replaces the office_small capture.
//
// Layout (the viewer starts at the origin facing -Z):
//   back wall  (-Z)  window with a roller blind, desk with monitor and lamp
//   left wall  (-X)  wide bookshelf
//   right wall (+X)  filing cabinet, two-seat sofa under a pinboard
//   front wall (+Z)  door, framed print, side table
const room = createRoom({
  name: 'home_office',
  width: 3.5,
  depth: 4,
  z0: -2.4,
  windows: [
    { wall: 'back', at: 0, width: 1.4, sill: 0.85, head: 2.25, blind: 0.18 },
  ],
  doors: [{ wall: 'front', at: -0.6 }],
  sun: { azimuth: 20 },
});

// Desk under the window, with a monitor, keyboard, lamp and a small plant.
const workDesk = desk(room.against('back', 0, 0.7), {
  width: 1.5,
  depth: 0.7,
  drawers: 'right',
});
{
  const top = 0.74;
  monitor(group(-0.12, top, -0.14, 0, workDesk), { width: 0.62, height: 0.36 });
  mesh(
    roundedBox(0.42, 0.015, 0.13, 0.004),
    paintMaterial('#2b2b2d', 0.6),
    [-0.12, top + 0.008, 0.12],
    workDesk,
  );
  mesh(
    roundedBox(0.06, 0.012, 0.1, 0.004),
    paintMaterial('#2b2b2d', 0.6),
    [0.17, top + 0.006, 0.13],
    workDesk,
  );
  box(
    [0.2, 0.02, 0.27],
    paintMaterial('#a65f40', 0.8),
    [0.42, top + 0.01, 0.06],
    workDesk,
  ).rotation.y = -0.2;
  deskLamp(group(0.55, top, -0.18, -0.4, workDesk));
  smallPlant(group(-0.6, top, -0.2, 0, workDesk), { size: 0.24 });
}
taskChair(room.place(-0.08, -1.32, Math.PI + 0.25));

// Wide bookshelf along the left wall.
bookshelf(room.against('left', -1.3, 0.34), {
  width: 1.6,
  height: 2.0,
  levels: 5,
  wood: mats.oak(),
});

// Filing cabinet and sofa on the right wall, a pinboard above the sofa.
const cabinet = casegood(room.against('right', -1.2, 0.5), {
  width: 0.45,
  height: 0.7,
  depth: 0.5,
  fronts: 'drawers',
  count: 3,
  body: mats.charcoal(),
});
smallPlant(group(0, 0.7, 0, 0, cabinet), {
  size: 0.26,
  pot: mats.ceramic(),
  seed: 3,
});
sofa(room.against('right', 0.25, 0.94), {
  width: 1.6,
  color: '#7d8a6a',
  pillows: ['#a65f40', '#c79e68'],
});
board(room.onWall('right', 0.25, 1.55), {
  width: 1.1,
  height: 0.75,
  kind: 'cork',
});

// Side table by the sofa, a floor plant by the door, a print on the front wall.
const side = roundTable(room.place(1.42, 1.28), {
  radius: 0.22,
  height: 0.52,
  top: mats.walnut(),
});
smallPlant(group(0, 0.52, 0, 0, side), { size: 0.2, seed: 5 });
plant(room.place(-1.42, 1.22), { height: 1.4, seed: 2 });
picture(room.onWall('front', 0.75, 1.5), {
  width: 0.6,
  height: 0.8,
  art: 'botanical',
  frame: mats.walnut(),
});

rug(room.place(0.05, -0.15), {
  width: 1.7,
  depth: 2.2,
  style: 'border',
  field: '#d8c9ae',
  accent: '#b5a283',
});

room.finish();
