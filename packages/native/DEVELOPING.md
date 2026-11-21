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
npm ci               # typescript, @types/node only
npm test             # node:test, headless: no adb, no headset, no network
npm run typecheck
npm run build        # tsc → lib/ (the bin runs lib/src/cli/main.js; works on Node 20.19+)
npm run verify       # all of the above + bin --help
npm run release:check   # notices up to date, every bundled dependency recorded (THIRD_PARTY.md)
```

Formatting follows the IWER monorepo's `.prettierrc.json`.

## Repository notes

The package is `"private": true` in this tree (PKG-15) and is not in the IWER changesets `fixed` group. The public
alpha is published from a staged copy with `private` removed (`release/stage-package.mjs`; see RELEASE.md). The
package lives in `packages/native/` of the IWER monorepo but stays out of its pnpm workspace (it has its own
`package-lock.json`), its root eslint/prettier runs and the changesets `fixed` group
(`privatePackages: { version: false, tag: false }`).

## Open questions

- The key name (`native` vs `metavr`), the default foveation (`none` here; the runtime applies it before the
  first frame), and the frame-rate list are guesses to confirm.
- The feature → permission names come from Meta's public Horizon OS docs; re-check them against the release
  template.
