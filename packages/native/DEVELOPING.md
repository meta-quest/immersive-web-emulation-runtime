# Developing @iwer/native

For runtime developers working in this checkout. This file is not part of the npm package (`release/stage-package.mjs`
keeps build-machine paths, review metadata and the names listed in `IWN_CONTENT_DENYLIST` out of the shipped files).

- `src/config/`: the `native` section: types, validator (`validate.ts`), defaults and the manifest
  permissions/features it implies (`resolve.ts`, `features.ts`), project loading with file checks (`load.ts`), and a
  JSON Schema for editors (`schema.ts`). Node-only, no dependencies.
- `src/cli/`: `iwer-native` (`main.ts`) and `doctor` checks (`doctor.ts`). Every side effect goes through an
  injectable `CliIo` (`exec`, `env`, output), so the tests run headless without adb or a headset.
- `packager/`: the Node packer/signer: template APK + dist → signed APK, no Android SDK needed.
- `compat/`: the compat checker and the API inventory the support matrix is generated from.
- `runtime/`, `web/`: the native runtime (C++, CMake) and its JS preludes. They are built into the template APK by
  `release/build-release.sh` and are not part of the npm package.
- `release/`: release engineering (notices, third-party verification, support matrix, staging). See
  [RELEASE.md](RELEASE.md).

Node 24 (or 22.18+) runs the TypeScript sources directly (type stripping), so tests need no build step.

```bash
pnpm install         # once, from the IWER monorepo root: the whole workspace, this package and web/* included
pnpm test            # node:test, headless: no adb, no headset, no network
pnpm run typecheck   # typecheck:all adds every web/* package
pnpm run build       # tsc → lib/ (the bin runs lib/src/cli/main.js; works on Node 20.19+)
pnpm run test:all    # the package's tests and every web/* suite (what the root `pnpm test:all` runs)
pnpm run build:web   # every web/* prelude bundle, in dependency order (glue first)
pnpm run verify      # typecheck + tests + build + bin --help
pnpm run release:check   # notices up to date, every bundled dependency recorded (THIRD_PARTY.md)
```

From the monorepo root, `pnpm build:all`, `pnpm typecheck`, `pnpm test:all`, `pnpm lint` and `pnpm format:check`
cover this package like every other; prettier and eslint use the root configs.

## Repository notes

@iwer/native is a regular package of the IWER monorepo: a pnpm workspace member (with its private build-time
packages in `web/*`), in the changesets `fixed` group with `iwer`, `@iwer/devui`, `@iwer/sem` and
`@iwer/extension-bridge`, and published by `pnpm release` (RELEASE.md, section 9). `src/version.ts` is generated
from package.json before build, typecheck and test, as in `iwer`. The template APK is the one part the root scripts
do not build: `release/build-release.sh` needs the Android NDK and the prebuilt V8.

## Open questions

- The key name (`native` vs `metavr`), the default foveation (`none` here; the runtime applies it before the
  first frame), and the frame-rate list are guesses to confirm.
- The feature → permission names come from Meta's public Horizon OS docs; re-check them against the release
  template.
