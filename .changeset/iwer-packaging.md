---
'iwer': patch
'@iwer/sem': patch
---

chore: packaging hygiene — sideEffects, clean builds, drop dead SEM codegen

- All publishable packages declare `"sideEffects": false` for better consumer tree-shaking.
- iwer and @iwer/sem builds run a portable clean step before tsc, fixing iwer's lib double-emit and ensuring removed outputs don't linger.
- @iwer/sem excludes the dead generated protobuf (validate.ts + descriptor.ts, imported by nothing) from its build, dropping ~16k lines / ~430KB from the shipped lib/.
- @iwer/sem stamps src/version.ts from package.json in prebuild (matching iwer/devui), so its VERSION can't drift from the published version used by the UMD capture-fetch URL.
