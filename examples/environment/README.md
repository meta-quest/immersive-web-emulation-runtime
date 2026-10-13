# Environment example

Uses [`public/living_room.glts`](public/living_room.glts) as the emulated real world in IWER's AR mode, with DevUI to move around. The room is procedural (baked lighting, a static sun shadow, a box-projected reflection probe) and labelled for plane and mesh detection: floor, ceiling, walls, window, door, tables, couch, shelves, screen, lamp, plant and wall art. A robot vacuum drives loops across the floor (`onFrame`): visible, hit-testable and in depth, but (as on real devices) not a tracked mesh. The app draws the planes and meshes WebXR reports, plus a hit-test reticle.

```sh
pnpm build:all                                   # from the repo root
pnpm install --ignore-workspace --no-lockfile   # here
pnpm dev     # open the page and press "Enter AR"; ?outlines=0 hides outlines
pnpm test    # Playwright: planes, meshes, hit-test, robot motion, DevUI toggles and environment switching
```
