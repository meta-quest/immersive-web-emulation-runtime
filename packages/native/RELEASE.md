# @iwer/native release procedure

**Nothing here publishes.** @iwer/native is published by IWER's `pnpm release` with the rest of the changesets
`fixed` group (section 9), after the open-source review in section 6; this file covers what it needs on top: the
template APK. Every command runs from `immersive-web-emulation-runtime/packages/native/` with Node 24 (or 22.18+) on PATH.

## 1. Release design and open decisions

| item                                     | design                                                                                                                                                                                                                                                                                                           | open                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Template APK delivery                    | **Bundled in the npm package** (`prebuilt/iwer-native-template.apk`, SHA-256 pinned in `packager/templates.json` as `"bundled"`, checked on every pack).                                                                                                                                                         | Deviates from PKG-2 (on-demand download); confirm for the alpha.                               |
| Versioning                               | In IWER's changesets `fixed` group with `iwer`, `@iwer/devui`, `@iwer/sem` and `@iwer/extension-bridge`: one version for all, bumped by `pnpm version`, published by `pnpm release` from the tree (section 9).                                                                                                   |                                                                                                |
| Package name                             | `@iwer/native` (working name).                                                                                                                                                                                                                                                                                   | Confirm the final name.                                                                        |
| Issue tracker / repository URLs          | `meta-quest/immersive-web-emulation-runtime` (issues titled `[native]`). The source is in that repository under `packages/native/`; package.json has `repository` (with `"directory": "packages/native"`), `homepage` and `bugs`.                                                                                |                                                                                                |
| Android API level of the native build    | `android-29` (= template `minSdkVersion`). The release build compiles at android-29 (runtime/audio calls `syscall(__NR_memfd_create)`).                                                                                                                                                                          |                                                                                                |
| IWSDK release with native-target support | `@iwsdk/core`, `@iwsdk/vite-plugin-dev` and `@iwsdk/create` must ship the `native` key, the `metavr` build mode and `--metavr-native` (section 8). They ship in **IWSDK 1.2.0** (their changesets bump the minor version; 1.1.0 and earlier reject the `native` key), and the README names 1.2.0 as the minimum. | Publish IWSDK 1.2.0 right after this package (section 8).                                      |
| Unscoped bin name `iwer-native`          | The bin differs from the package name, so a bare `npx iwer-native` without a local install looks up the unregistered unscoped `iwer-native` on npm. The README documents `npx -p @iwer/native iwer-native ...`.                                                                                                  | Optionally reserve the unscoped name with a placeholder package that points at `@iwer/native`. |

**Why bundle the template for the alpha.** PKG-2 asks for an on-demand download with a pinned checksum, which keeps
`npm install` under 5 MB. For the alpha that cannot work yet:

- No public host exists. The packer's download path (`templates.json` `"template"`) needs an HTTPS URL that any
  developer can reach, and a public GitHub release or CDN bucket needs the same open-source sign-off as the package.
- The npm registry is already public, already signs and checksums the tarball (sha512 `integrity`), is mirrored
  everywhere, and works offline from the npm cache. A bundled template has no second point of failure and needs
  no proxy settings (Node's `fetch` honours `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1`).
- The cost is size: the tarball is about 17.5 MiB instead of about 0.3 MB (section 4). npm takes packages this size
  (Electron binaries, esbuild/Sharp platform packages), and it is one download per version.
- The download path stays in the code. When a public host exists, set `"bundled": null`, fill in `"template":
{version, url, sha256, size}`, drop `prebuilt/` from `files`, and the package is back under 1 MB (PKG-2).

**Checksum verification.** `release/stage-package.mjs --template <apk>` writes
`{file, version, sha256, size}` into the staged `packager/templates.json`. On every `pack`,
`packager/src/template.ts` (`openBundledTemplate`) re-hashes the bundled file and refuses to pack when it does not
match: "the template bundled with @iwer/native … does not match its checksum … reinstall it". Resolution order:
`--template` / `$IWER_NATIVE_TEMPLATE` → bundled (verified) → pinned download (verified, cached) → checkout build.
The tarball itself is covered by the registry's sha512 integrity, which `npm install` checks.

## 2. Build (CI-reproducible)

```bash
release/build-release.sh            # build + checks + staged package; add --pack to also write the .tgz
OUT=/some/dir release/build-release.sh --skip-web   # reuse the web/*/dist bundles of an earlier run (same tree)
```

It runs from a clean checkout: `node_modules/`, `web/*/dist/`, `lib/` and IWER's generated `src/version.ts` are
gitignored, and the script recreates them. Dependencies come from the IWER workspace's committed
`pnpm-lock.yaml` (`pnpm install --frozen-lockfile` at the workspace root). The build id is computed before the script writes anything into the checkout, so a fresh
clone of the release commit gets a bare commit id. `--skip-web` only works in a tree where step 2 already ran.

Inputs (environment, required): `ANDROID_HOME` (Android SDK with build-tools 35.0.0 and platforms/android-34, from
dl.google.com `build-tools_r35_linux.zip`, sha1 2cfaa0bbb2336e9ec18ed3ecea84fa2e2af607bc, and
`platform-34-ext7_r02.zip`, sha1 f09b07da8aea238a81b71d6fedb815e13aa13e58), `ANDROID_NDK_HOME` (NDK r30
30.0.16248370 from dl.google.com: V8 was built against its libc++), `IWN_V8_DIR` (V8 15.5.35.25 prebuilt),
`IWN_V8_SRC` (its source tree, for the licence files) and `IWN_THIRD_PARTY_DIR` (the upstream third-party source
trees, one directory per project: `openxr`, `jsoncpp`, `oboe`, `dr_libs`, `libogg`, `libvorbis`, `freetype`,
`harfbuzz`, `brotli`, `stb` and `skia` for its licence; THIRD_PARTY.md gives the upstream and version of each).
Optional: `IWN_SQLITE_DIR` (default `$IWN_THIRD_PARTY_DIR/sqlite`), `IWN_CONTENT_DENYLIST` (section 3),
`NPM_REGISTRY` (default: npm's configured registry), `IWN_FORBIDDEN_ROOTS` (colon-separated directories that no
input may resolve into), `JOBS` (default 8), `ANDROID_PLATFORM` (default android-29). Outside CI the script
refuses to start with less than 60 GB of available memory.

What it does (see the header of `release/build-release.sh`):

1. **Toolchain check.** Every input must exist and must not resolve under a directory in `IWN_FORBIDDEN_ROOTS`.
2. **Web preludes:** `pnpm install --frozen-lockfile` at the workspace root when `node_modules` is missing. Every dependency that reaches a shipped bundle is also
   pinned to an exact version in package.json, and `verify-third-party.mjs` checks the bundled versions against
   THIRD_PARTY.md. The tools whose output ships are pinned exactly too (esbuild in every web area, the package's
   TypeScript), and `verify-third-party.mjs` fails on a range. Before web/xr, IWER's `src/version.ts` is generated
   with IWER's own `prebuild` script when missing. Then `node build.mjs` in glue, dom, net, storage, image, canvas2d,
   webgl, audio, xr and workers.
3. **Native:** CMake (Android arm64-v8a, `Release`, `-DIWN_BUILD_TESTS=OFF`, `IWN_RUNTIME_VERSION=<version>`,
   `IWN_BUILD_ID=<build id>`, `CMAKE_EXPORT_COMPILE_COMMANDS=ON`), then
   `ninja -j8 iwernative`, with `-ffile-prefix-map` for the checkout, the third-party trees, SQLite, V8, the NDK and `$OUT` so no
   build-machine path reaches the binary. The unstripped `.so` files are kept in `$OUT/symbols/` (PKG-1 asks for
   symbols); the `llvm-strip --strip-unneeded` copies go into the APK, and the script fails if one of them still
   contains `/home/`, `/data/users/` or `/Users/`.
4. **Notices:** `release/notices.mjs --check` checks that `THIRD_PARTY_NOTICES.txt` is current.
5. **Build id** (computed before step 2): `IWN_BUILD_ID` = the commit (`git rev-parse --short=12 HEAD`), plus
   `-dirty-<digest>` of every uncommitted change in this package and in the IWER sources when the tree is not
   clean (`nogit` outside a git checkout). It goes to CMake (embedded in `libiwernative.so`, reported by
   info/stats and the boot line) and to `build-template.mjs` (`template.json`), so both carry the same id; a
   release build shows a bare commit.
   **Template:** `release/stage-template-assets.mjs` lays out `assets/iwn/` from `release/template-assets.json`
   (preludes in order, `config.json`, V8 snapshot, fonts, licences including `NOTICES.txt`). Then
   `packager/template/build-template.mjs --native-lib … --lib-name iwernative --native-build release` builds the
   APK: unsigned, `template.json` metadata, placeholder icons, VR manifest. Then come the PKG-3 checks
   (`zipalign -c -P 16 4`, `llvm-readelf` 16 KB LOAD alignment) and `release/verify-third-party.mjs --apk <apk>
--build <native build dir>`: besides the CMake text scan, every source in the build's `compile_commands.json`
   must sit in this package, in a recorded vendored `third_party/` dir or under a recorded `IWN_<X>_DIR` (generic
   roots such as `IWN_THIRD_PARTY_DIR` do not count), and every npm package named by an esbuild path comment in an
   unminified shipped bundle must have an entry.
6. **Package:** `pnpm run build` (no source maps), `pnpm test`
   (`node --test --test-concurrency=4`), `release/support-matrix.ts --check` (README matrix current), then
   `release/stage-package.mjs --template <apk>`. That step copies the `files` whitelist into
   `$OUT/package/`, bundles the template and runs `npm pack --dry-run`, with the same checks `pnpm release` runs
   before publishing (`release/prepublish.mjs`). It writes the size
   report and `build-info.json` (version, template sha256, tarball shasum/integrity).

Before the release candidate, also run:

```bash
pnpm run verify                    # typecheck + the node:test suite + build + bin --help
pnpm run release:check             # notices current + every bundled native/JS dependency recorded
node release/support-matrix.ts --write   # after `node compat/scripts/snapshot.mjs` refreshes the inventory
```

## 3. What the package contains (`npm pack --dry-run`)

```
@iwer/native@<version>   about 85 files
  ~46.8 MB  prebuilt/iwer-native-template.apk
   ~590 KB  lib/**            (CLI, config, packer, compat checker: compiled JS + .d.ts; built without source maps)
   ~850 KB  compat/data/surface-snapshot.json, static-baseline.json
   ~205 KB  THIRD_PARTY_NOTICES.txt
             README.md, package.json, LICENSE (MIT),
             packager/templates.json ("bundled": prebuilt/iwer-native-template.apk + sha256), bin/iwer-native.mjs
tarball about 18.3 MB (17.5 MiB)
```

The full list is in `$OUT/pack-dry-run.json`. The stage step fails when any of these is in the package:
`node_modules/`, `test/`, `*.test.*`, keystores (`.jks .p12 .pfx .keystore .pem .key`), `.map`, `.env`, `.npmrc`,
or a `.ts` that is not a `.d.ts`. It also fails on internal-only content in any shipped text file
(`CONTENT_DENYLIST` in `release/stage-package.mjs`: build-machine paths, review metadata, work-stream labels; plus
the patterns in the file `IWN_CONTENT_DENYLIST` names, one regular expression per line, which lists the publishing
organisation's own hosts, repositories and tools so the tree does not have to), on a shipped `.js`/`.d.ts` whose
`sourceMappingURL` names a file that is not
shipped, and without LICENSE, the notices, or a README that opens with the alpha disclaimer. Developer notes are
in DEVELOPING.md, which is not shipped. `build-release.sh` also fails when a stripped `.so` contains a
build-machine path; the native build maps source paths with `-ffile-prefix-map` (for example
`iwer-native/runtime/image/v8/binding.cc`).

## 4. Size report

| item                                                                      | size                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| npm tarball (what `npm install` downloads)                                | about 17.5 MiB / 18.3 MB (budget in `stage-package.mjs`: 24 MiB) |
| template APK, unpacked / gzip -9                                          | about 44.6 MiB / 17.2 MiB                                        |
| `lib/arm64-v8a/libv8android.so` (stored, 16 KB aligned; gzip -9 12.9 MiB) | 37.1 MiB                                                         |
| `lib/arm64-v8a/libiwernative.so` (all modules, stripped; gzip -9 2.5 MiB) | about 5.3 MiB                                                    |
| `lib/arm64-v8a/libc++_shared.so` (gzip -9 0.44 MiB)                       | 1.36 MiB                                                         |
| JS preludes (11 files)                                                    | about 0.9 MiB                                                    |
| fonts (Roboto Regular/Bold, Roboto Mono)                                  | 0.39 MiB                                                         |

`$OUT/size-report.md` has the numbers of each build. The README states the runtime overhead as "about 47 MB
(44.6 MiB)" in the APK (the template's unpacked size, which `pack` reports as `runtime`; the native libraries are
stored uncompressed) and "about 18 MB (17.2 MiB)" compressed, and the download as "about 18 MB (17.4 MiB)". Update
them when the sizes change.

**PKG-SIZE-1 is missed.** The target is ≤ 12 MB compressed runtime overhead per APK; this build is about 17.2 MiB.
V8 15.5's library is 39 MB stripped (V8 10.0 was 24.9 MB). The levers: a no-Intl V8 (GAP-12 fallback for
`Intl.Segmenter`), `v8_enable_webassembly` trimming, and LTO/ICF on `libiwernative.so`. The README lists it as a
known limitation of the alpha.

## 5. Signing of the template APK

- The template is **unsigned by design**. The packer drops `META-INF/*` and signs every app APK it writes (APK
  Signature Scheme v2 + v3) with the developer's key (release) or the per-machine debug key (debug). A signature
  on the template would never reach a device.
- Its integrity comes from the SHA-256 in `packager/templates.json`, checked on every pack, plus the registry's
  sha512 over the whole tarball. `build-info.json` records both, so they can be compared after publishing
  (`npm view @iwer/native@<version> dist.integrity`).
- npm provenance (`--provenance`) needs a supported CI (GitHub Actions/GitLab). IWER's release runs by
  hand, not from CI, so it goes out without provenance. Publish from an account with
  2FA (`auth-and-writes`).
- The unstripped libraries (`$OUT/symbols/`) and `build-info.json` are kept with the release for symbolicating
  crash reports. Do not publish them.

## 6. Open-source review (before the first `pnpm release` with @iwer/native)

1. **Approval:** confirm the release with Meta open source (the package, its notices and the template APK).
2. **Source:** the package is MIT and its source, native runtime included, is public in
   `immersive-web-emulation-runtime/packages/native/`, which package.json's `repository` points at.
3. **Third-party notices:** `THIRD_PARTY_NOTICES.txt` (generated from `release/components.json`) ships in the
   package and inside every APK (`assets/iwn/licenses/`). Points for the review:
   - FreeType FTL credit line (in `NOTICE.txt`; FTL also asks for a credit in the app's documentation);
   - the OFL-1.1 fonts (Roboto, Roboto Mono; the C2D-9 font choice is spec open question 8);
   - the Unicode licence text is the 2016-2020 wording (the current v3 text could not be fetched);
   - the notices for the OpenXR loader (MIT, taken from the files' SPDX `Apache-2.0 OR MIT` header) and SHA-256 /
     libunwind are rendered from copyright lines, because the source tree has no licence file for them;
   - V8's statically linked dependencies (ICU, Abseil, simdutf, fast_float, dragonbox, FP16, zlib, fdlibm, LLVM
     libc/libc++/libunwind, inspector_protocol, the UTF-8 decoder, rapidhash, Highway, cpu_features, HalfSipHash)
     use texts from the V8 15.5.35.25 tree, checked against V8's `BUILD.gn` (`v8_base` deps and sources),
     `third_party/zlib/BUILD.gn` and `llvm-nm` of the unstripped library. Since `verify-third-party.mjs` treats
     `libv8android.so` as one component, redo this check whenever V8 changes;
   - rapidhash (BSD-2-Clause) requires the notice in binary redistributions: it is in the notices file, which ships
     inside every APK;
   - the notices' Source lines name upstream projects only; `release/stage-package.mjs` rejects build-machine paths,
     review metadata and the names in `IWN_CONTENT_DENYLIST` in every shipped text file.
4. **npm scope and name:** confirm that Meta's npm org owns `@iwer` (the IWER packages publish there) and that
   `@iwer/native` is the final name. It publishes as `latest` at the group's version (`publishConfig:
{access: public}`), with the README's alpha disclaimer.
5. **Trademarks:** the description and README say "Meta Quest" and "Horizon OS"; check the wording.
6. **Privacy/telemetry:** the runtime sends nothing off the device. The debug endpoint and inspector listen on
   127.0.0.1 in debug builds only.
7. **Licences of npm polyfills in the preludes:** whatwg-url, webidl-conversions, punycode, @noble/hashes,
   web-streams-polyfill and gl-matrix (all MIT/BSD-2) are in the notices. indexeddbshim/websql-configurable stay
   out (idb.min.js is not shipped).
8. **Keystores:** the packer reads PKCS#12 with PBES2/AES only and refuses JKS and legacy 3DES/RC2 PKCS#12 with
   the keytool conversion command, so it carries no reader built from OpenJDK's undocumented JKS format and no
   hand-written legacy cipher.

## 7. Known limitations

The README's "Known limitations" section and support matrix are the user-facing list (WebXR features not yet
supported, out-of-scope web APIs, size, controller details, what has not been tried with
real hands). The support matrix is generated (`node release/support-matrix.ts --write`) from the
compat checker's inventory and the alpha scope in `release/support-matrix.ts`.

## 8. IWSDK release (needed by the README's IWSDK path)

- `@iwsdk/core`: accepts an object-only top-level `native` key in the manifest validator, the JSON schema and the
  types (`packages/core/src/project/*`, `packages/core/schemas/iwsdk-project.v1.schema.json`);
- `@iwsdk/vite-plugin-dev`: never injects the emulator into `vite build --mode metavr` (or
  `IWSDK_BUILD_TARGET=metavr`) and keeps the `native` section out of the browser bundle
  (`packages/vite-plugin-dev/src/native-target.ts`);
- `@iwsdk/create`: `--metavr-native` (VR only) adds `build:metavr`, `@iwer/native@0.1.0-alpha.0`, a `native` section
  (`packageId`, `appName`, and `network.allow: ["https://cdn.jsdelivr.net"]` for the starter's controller models)
  and `dist-metavr/` in .gitignore (`packages/create/src/native-alpha.ts`).

IWSDK versions without these changes reject `native` with `unknown property`, and `@iwsdk/vite-plugin-dev` asserts
the manifest, so even `npm run dev` fails on those versions once the section is added. The IWSDK packages are one
changesets `fixed` group, so these changes ship as one IWSDK version for all nine packages.

Plan (IWSDK's own release process; nothing here publishes):

1. Land the IWSDK changes after the IWSDK 1.1.0 release prep, with their changesets (`minor` for the native target,
   a new opt-in feature; `patch` for the light-target fix), so they ship in IWSDK 1.2.0. IWSDK 1.1.0 and earlier
   reject the `native` key.
2. Publish IWSDK 1.2.0 (optionally a 1.2.0 prerelease on `next` first).
3. The README says "1.2.0 or later". If the alpha goes out while only a prerelease has the feature, change the
   README's minimum to that exact prerelease (for example `1.2.0-rc.0`, `npm create @iwsdk@next`) before staging.
   If these changes miss 1.2.0, change the README's minimum to the version that ships them. Whenever that version
   changes, make the compat baseline again for it (the gate in section 9).
4. Order: @iwer/native first (the create template pins `@iwer/native@0.1.0-alpha.0`, which must resolve), then
   IWSDK 1.2.0 (or its prerelease). Between the two, the README's IWSDK path does not work yet; the plain Vite path
   does.

## 9. Publish (with `pnpm release`)

@iwer/native is published by IWER's release together with the rest of the changesets `fixed` group (`iwer`,
`@iwer/devui`, `@iwer/sem`, `@iwer/extension-bridge`, `@iwer/native`), all at one version. The one step of its own is
the template APK: it needs the Android NDK and the prebuilt V8 (section 2), so it is built before `pnpm release`
and handed to it as a file.

Gates before `pnpm release`:

- [ ] section 6 signed off;
- [ ] `release/build-release.sh --pack` passes on the release commit from a fresh clone (not a working tree with
      `node_modules/` and `dist/` already present), and `template.json`'s `buildId` is that commit with no `-dirty-`;
      `IWN_CONTENT_DENYLIST` names the publishing organisation's list of its own hosts, repositories and tools, and
      the stage step's content check reports those patterns;
- [ ] the device sweep ran the release template on a headset (the README may say "tested on" only then);
- [ ] every row the README's support matrix calls **supported** was exercised in that sweep (or by a device test
      the sweep ran); a row that was not is marked `deviceUntested` in `release/support-matrix.ts` (it then reads
      "implemented, not yet device-tested") or demoted to "not yet", and `node release/support-matrix.ts --write`
      reruns before the release build;
- [ ] the IWSDK version in the README matches a version that is published or is published right after this package
      (section 8), and the smoke test below passed against local tarballs of both;
- [ ] `compat/data/static-baseline.json` records that same IWSDK version (`"iwsdk"`). When the IWSDK version
      changes, make the baseline again from that version's create templates (compat/README.md, "Running the
      sweep"; `--iwsdk <version>` labels tarballs that still carry the previous version) and rerun `pnpm test`, so
      apps on the README's IWSDK get no baseline-version warning from `pack`.

```bash
cd immersive-web-emulation-runtime
pnpm version                                 # changeset version: the fixed group's next version + CHANGELOGs; land it

# On the release commit, from a fresh clone, with the inputs of section 2:
cd packages/native
export IWN_CONTENT_DENYLIST=<file>           # your organisation's internal names, one regular expression per line
OUT=/tmp/iwn-release release/build-release.sh --pack   # template APK + staged package + $OUT/iwer-native-<version>.tgz
cat /tmp/iwn-release/size-report.md /tmp/iwn-release/build-info.json
mkdir -p prebuilt && cp /tmp/iwn-release/template/iwer-native-template.apk prebuilt/   # gitignored; or IWN_TEMPLATE_APK
```

Smoke test before publishing: a fresh IWSDK project wired to local tarballs of the IWSDK packages and of
@iwer/native (no Android SDK on PATH):

```bash
VERSION=$(node -p "require('./package.json').version")
NATIVE_DIR=$PWD
NATIVE_TGZ=/tmp/iwn-release/iwer-native-$VERSION.tgz
IWSDK=$(cd ../../../immersive-web-sdk && pwd)  # an IWSDK checkout next to this repository; adjust the path
(cd "$IWSDK" && corepack pnpm@10.18.3 run build:tgz:dev) # packages/<name>/iwsdk-<name>.tgz
cd /tmp && node "$IWSDK/packages/create/dist/cli.js" native-smoke --yes --metavr-native --no-install  # a bare name: create rejects paths
cd /tmp/native-smoke
for tgz in "$IWSDK"/packages/*/iwsdk-*.tgz; do       # direct deps and overrides must use the same spec (EOVERRIDE)
  name="@iwsdk/$(basename "$tgz" .tgz | sed 's/^iwsdk-//')"
  for field in dependencies devDependencies; do
    [ -n "$(npm pkg get "$field.$name" | tr -d '{}')" ] && npm pkg set "$field.$name=file:$tgz"
  done
  npm pkg set "overrides.$name=file:$tgz"
done
npm pkg set "devDependencies.@iwer/native=file:$NATIVE_TGZ"
npm install          # add --ignore-scripts where onnxruntime-node's install script cannot download its binaries
npm run build && npm run build:metavr      # both must pass: IWSDK accepts "native"; metavr build has no emulator
npx iwer-native install && npx iwer-native run    # enters XR on a headset
cd "$NATIVE_DIR"
```

Then publish the whole group from `immersive-web-emulation-runtime/` (public registry, 2FA):

```bash
cd ../..
npm whoami --registry https://registry.npmjs.org/        # logged in, and the network reaches the public registry
pnpm release        # build:all; @iwer/native's release:ready; changeset publish
npm view @iwer/native dist.integrity                     # compare with /tmp/iwn-release/build-info.json
npm dist-tag ls @iwer/native
```

`pnpm release` runs `@iwer/native`'s `release:ready` (`release/prepublish.mjs --check`) before `changeset publish`:
the template must be there, be a release build whose runtime version is this package's version, and the package
with it bundled must pass every staged-package check (section 3). When it fails, nothing in the group publishes.
While `changeset publish` packs @iwer/native, `prepublishOnly` records the template in `packager/templates.json`
(`"bundled"`, with its sha256 and size) so the tarball carries it, and `postpack` puts the tree's `"bundled": null`
back. The tree never holds the binary or its checksum.

If something goes wrong after publishing: `npm deprecate @iwer/native@<version> "<reason>"`. Within 72 hours,
`npm unpublish @iwer/native@<version>` is possible, but that version number can never be reused.
