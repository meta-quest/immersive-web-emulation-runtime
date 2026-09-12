# @iwer/sem

## 2.4.0

### Minor Changes

- Versioned in lockstep with `iwer` 2.4.0; no package-specific behavior changes.

## 2.3.0

### Minor Changes

- Add typed environment loading with an `environmentchange` event.
- Make `loadDefaultEnvironment()` awaitable and reject when loading fails.
- Use deterministic per-entity material colors for stable synthetic-environment
  rendering and debugging.

### Patch Changes

- Improve SEM hit testing to raycast planes and boxes in addition to meshes.
- Use `Uint32Array` mesh indices when triangle meshes exceed 65k vertices.
- Tear down the prior native entity when replacing an entity with a duplicate
  UUID.
- Reduce allocation churn by reusing scratch color state and avoiding an
  unnecessary triangle-mesh array round trip.
- Improve package hygiene with pnpm monorepo support, clean builds, generated
  version stamping, `sideEffects: false`, and removal of unused generated
  protobuf output from the published build.
