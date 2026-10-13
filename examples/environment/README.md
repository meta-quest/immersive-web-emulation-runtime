# Environment example

Uses one of SEM's built-in GLTS rooms as the emulated real world in IWER's AR mode, with DevUI to move around. The rooms (`packages/sem/rooms`) are procedural (baked lighting, a static sun shadow, a box-projected reflection probe) and labelled for plane and mesh detection like a Quest room scan, including a 'global mesh'. Some have a robot vacuum driving loops across the floor (`onFrame`): visible, hit-testable and in depth, but (as on real devices) not a tracked mesh. The app draws the planes and meshes WebXR reports, plus a hit-test reticle.

```sh
pnpm build:all                                   # from the repo root
pnpm install --ignore-workspace --no-lockfile   # here
pnpm dev     # open the page and press "Enter AR"; ?room=<id> picks the room, ?outlines=0 hides outlines
pnpm test    # Playwright: room understanding and budgets per room, legacy scans, DevUI toggles and menu, robot motion
```

The DevUI environment menu lists the rooms (sunlit_living_room, home_office, conference_room, open_office, kitchen, bedroom, music_studio, open_studio) and, under "Legacy scans", the older room captures. `tools/` has `check.mjs` (metrics and screenshots of a room) and `understanding.mjs` (room understanding report); see `packages/sem/rooms/README.md`.
