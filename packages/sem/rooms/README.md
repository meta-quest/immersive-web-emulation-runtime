# Built-in GLTS rooms

SEM's built-in rooms: procedural GLTS scenes used as the emulated real world. Kit-based rooms are `src/<id>.ts`; `build.mjs` concatenates `src/kit.ts` in front of each (GLTS scripts cannot import local files) and writes `<id>.js`, a module whose default export is the room's GLTS source. Standalone rooms are `src/<id>.glts` (the living room). SEM's build runs `build.mjs`, and the room ids become built-in environments (`sem.environments`, `loadDefaultEnvironment(id)`).

```sh
pnpm --filter @iwer/sem run build            # rooms, registry, lib and bundles
pnpm --filter @iwer/sem run typecheck:rooms  # typecheck every room
```

To see and check a room, run the environment example (`examples/environment`, `npx vite --port 5180`, then `/?room=<id>`) and its tools:

```sh
node tools/check.mjs <id>          # metrics + screenshots in tools/.check/<id>/
node tools/understanding.mjs [ids] # room understanding report (planes, meshes, hit test, depth, anchors)
```

`check.mjs` loads `/?room=<id>` in headless Chromium, enters AR and reports: page errors, load time, draw calls, triangles, lit lamps, planes and meshes by label, overlapping furniture volumes, objects outside the room, and screenshots from six views (plus two with the app's plane/mesh outlines). Add views with `--view name:px,py,pz:tx,ty,tz`. The example's `tests/rooms.spec.js` runs every room through the room understanding checks and the budgets below (`pnpm test` reuses a running dev server on port 5180).

## Writing a room

```ts
const room = createRoom({
  name: 'home_office',
  width: 3.5,
  depth: 4,
  z0: -2.4, // x in [-1.75, 1.75], z in [-2.4, 1.6]
  windows: [{ wall: 'back', at: 0, width: 1.4, sill: 0.85, blind: 0.2 }],
  doors: [{ wall: 'front', at: -0.6 }],
  sun: { azimuth: 20 },
});
desk(room.against('back', 0, 0.7), { width: 1.5 });
taskChair(room.place(0, -1.3, Math.PI));
picture(room.onWall('front', 0.8, 1.5), { art: 'botanical' });
room.finish();
```

Conventions (meters): +Y up; the viewer starts at the origin facing -Z, so keep the origin on open floor. Walls are `back` (-Z), `front` (+Z), `left` (-X), `right` (+X). `at` along a wall is world x for back/front and world z for left/right. Builders face +Z (back at local -Z).

Placement:

- `room.place(x, z, rotationY)`: a group on the floor.
- `room.against(wall, at, depth)`: a group for furniture of that depth standing against a wall, facing into the room.
- `room.onWall(wall, at, y)`: a group on the wall surface at height y (pictures, screens, boards), local +Z into the room.
- `group(x, y, z, rotationY, parent)`: a child group, e.g. on a table top (`group(0, 0.74, 0, 0, deskGroup)`).

Room spec: `windows` (`view: 'corridor'` for interior glazing; `sheers`, `blind`, `mullions`, `sill`, `head`), `doors`, `floor` (`'oak' | 'carpet' | 'concrete'`), `wall` color, `sun` (`window`, an index into the outside windows only; `elevation`, `azimuth`), `downlights`, `robot` (an animated robot vacuum loop), `height`.

Builders (kit.ts): `sofa`, `armchair`, `loungeChair`, `woodChair`, `taskChair`, `shellChair`, `stool`, `table`, `roundTable`, `desk`, `casegood` (cabinets, sideboards, dressers, nightstands, wardrobes, open shelving), `bookshelf`, `tableLamp`, `floorLamp`, `pendant`, `deskLamp`, `plant`, `smallPlant`, `rug`, `picture`, `mirror`, `wallScreen`, `monitor`, `board`, `acousticPanel`. Primitives for room-specific pieces: `mesh`, `box`, `roundedBox`, `cylinder`, `group`, `volume`, `panel`, `unitPlane`; materials `mats.*`, `paintMaterial(color, roughness, metalness)`, `fabricMaterial(color)`, `tileTexture(color)`.

WebXR tags:

- Planes: `object.userData.xrPlane = '<label>'` on a flat mesh (normal = thinnest axis). Table tops, desks, wall art, doors and windows are planes; the kit's builders already tag them.
- Meshes: `volume(label, [w, h, d], [x, y, z], parent)` adds an invisible box reported as an XRMesh; it also occludes the baked lighting. One per piece of furniture.
- Labels: `desk, couch, floor, ceiling, wall, door, window, table, shelf, bed, screen, lamp, plant, wall art, other`.
- Global mesh: SEM also reports the scene's static geometry as one 'global mesh' XRMesh, as Quest does for a scanned room. Tag objects that move, or parts outside the room (the view behind a window), with `userData.xrGlobalMesh = false`; the kit does this for its robot vacuum and window views. `finish()` merges untagged static meshes that share a material, so an animated object must be tagged or added after `finish()`.

## Budgets and realism

A Quest room scan covers at most 10 x 10 m (SLAM roomscale) and reports a few dozen objects, so rooms must stay realistic:

- Size: at most 10 x 10 m (enforced by `createRoom`, which also rejects windows, sheers and doors that do not fit their wall or overlap); typical homes are 3-6 m per side.
- Detected entities (planes + meshes): at most 40 (`finish()` warns; the office_large scan has 38). Tag what a room scan would find (furniture, screens, wall art), not every small object, and mirror how it reports them: tables, desks, couches and beds as a top or seat plane plus a volume; screens, storage, lamps and plants as volumes; wall art, doors and windows as planes.
- Under 60 draw calls and 60k triangles from the viewer's start; load time under 1.5 s (the test allows 3 s, since it depends on the machine).
- Furniture pieces stay simple: rounded boxes and cylinders, about 5-15 meshes each; repeat via loops or instancing. Static meshes are merged per material, so draw calls follow materials, not objects.
- At most two lit lamps (`lit: true` adds a point light).
- No volume overlaps except chairs and stools (`other`) tucked under a table or desk; nothing outside the room. The global mesh stays within 0.2 m of the walls, floor and ceiling.

`tests/rooms.spec.js` enforces all of these (`checkBudgets` in `tools/understanding-checks.js`).
