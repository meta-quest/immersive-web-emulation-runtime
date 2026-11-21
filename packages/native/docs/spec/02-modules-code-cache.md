# 02. JavaScript engine, ES modules and the code cache

Sources: ECMA-262 (module records, `import()`, top-level await, `import.meta`); HTML §8.1.5 (module
scripts, module map, `import.meta.url`/`import.meta.resolve`, `modulepreload`); V8 embedder guide and
headers (`ScriptCompiler`, `CachedData`, `Module`, host callbacks); the V8 15.5 Android build
(arm64, NDK libc++, pointer compression on, sandbox off).

## Engine

**JS-1 (MUST).** The engine is V8 15.5 or newer, built for Android arm64 with the JIT tiers enabled
(Sparkplug, Maglev, TurboFan), WebAssembly (including SIMD and threads-off), pointer compression on, the
V8 sandbox off, and a libc++ ABI that matches the NDK the runtime is built with. `Intl` is present
unless a no-Intl build ships with the `Intl.Segmenter` fallback of JS-6.
*Check:* the debug endpoint's `info` (DBG-6) reports the V8 version string; `WebAssembly.validate` of a
SIMD module is true; a mismatched-ABI build fails a CI symbol check (`llvm-nm` shows the NDK namespace,
not Chromium's) before it reaches a device.

**JS-2 (MUST).** The main page and each worker are separate JS realms with separate heaps (no JS object is
shared between them). Memory handed between them by transfer (WRK-5) is freed exactly once, whichever
side drops it last, including after the side that created it has terminated or the process is exiting.
*Check:* transfer 1,000 buffers main→worker→main, terminate the worker, exit: no crash, no leak in
`dumpsys meminfo` across 10 cycles.

**JS-3 (MUST).** The runtime fixes the V8 flags it needs for correctness and performance and documents
them. An app cannot weaken them. Unknown or malformed flags supplied for diagnosis (for example through a
debug launch override) are logged and ignored, never fatal.
*Check:* a debug launch with an unknown flag `--no-such-flag` logs one warning and the app runs.

**JS-4 (MUST).** Heap limits: the main isolate's old-space limit is at least 1 GB on Quest 3/3S; a
near-heap-limit callback logs heap statistics once and raises the limit by 25 % once before letting V8
fail, so an out-of-memory is diagnosable.
*Check:* a test app that allocates until failure logs the statistics line before the crash.

**JS-5 (MUST).** Microtask policy is explicit: the runtime runs checkpoints per LOOP-1; V8 never runs
microtasks on its own in the middle of a native call.
*Check:* covered by LOOP-1's test.

**JS-6 (MUST).** `Intl.Segmenter` with `granularity: 'grapheme'` and `'word'` works for at least Latin,
CJK and emoji input, either from V8's ICU or from a JS fallback installed only when `Intl.Segmenter` is
missing. Other `Intl` constructors may be absent only in a no-Intl build, and then
`Intl.NumberFormat`/`DateTimeFormat`/`Collator` must not throw on construction for `en-US` (a minimal
fallback is acceptable).
*Check:* segment "é👍🏽漢字 word" and compare with Node's output.

## Module loading

**MOD-1 (MUST).** The bundle's entry is the `<script type="module" src>` of the dist's `index.html` (whether
it is located at pack time or at launch is the implementer's choice; PKG-5 requires the packer to reject a
dist without one). The runtime loads it as an ES module graph. Classic scripts listed in `index.html` (`<script src>` without `type="module"`) run
before the entry in document order.
*Check:* a dist with a classic script that sets a global and an entry that reads it.

**MOD-2 (MUST).** URL space. The app is served from a fixed origin (default `https://app.local`,
configurable). Module specifiers resolve per the HTML resolve-a-module-specifier algorithm: relative and
root-relative against the referrer URL, absolute URLs as-is. Same-origin URLs read from the packaged
`dist/`; `blob:` URLs read from the object-URL store; `data:` URLs decode inline; cross-origin `https:`
module URLs are fetched only if allowlisted (NET-5) and otherwise fail the import with a `TypeError`.
Bare specifiers fail with a `TypeError` naming the specifier (import maps: MOD-9).
*Check:* hello-js equivalent: relative, root-relative, `data:` and `blob:` imports all load; a bare
`import 'lodash'` rejects with a message containing `lodash`.

**MOD-3 (MUST).** `import.meta.url` is the module's absolute URL in the app's URL space
(for example `<origin>/assets/main.js` for a chunk at `dist/assets/main.js`), never a file path. `import.meta.resolve(spec)` returns the
resolved URL string.
*Check:* the entry logs both; `new URL('./worker.js', import.meta.url).href` equals the asset URL.

**MOD-4 (MUST).** The module map is keyed by absolute URL: a module imported from two places evaluates
once; a module that failed to fetch or parse fails every importer with the same error; cyclic graphs and
top-level `await` follow ECMA-262.
*Check:* WPT-style tests (diamond import evaluates once; TLA ordering).

**MOD-5 (MUST).** Dynamic `import()` works from modules, classic scripts, `eval`'d code, debug-endpoint
evaluation, and **inside workers** (regression guard: workers without dynamic `import()` or
`import.meta.url` break chunked loaders; see GAP-4). The referrer of `import()` in a classic script is the script's URL, or the
document base when there is none.
*Check:* a module worker that does `await import('./chunk.js')` and logs `import.meta.url`.

**MOD-6 (MUST).** Errors name their source: a syntax error reports the module URL, line and column; a
failed fetch reports the URL and the reason (missing asset, blocked origin).
*Check:* tests for each failure.

**MOD-7 (MUST).** `<link rel="modulepreload">` elements created by Vite's preload helper load (or no-op)
and fire `load`; `HTMLLinkElement.relList.supports('modulepreload')` returns true so Vite's polyfill does
not install its MutationObserver fallback. Preloaded modules are not evaluated until imported.
*Check:* the showcase dist boots with no preload-helper warnings; the MutationObserver constructor is not
called during boot (spy in a runtime test).

**MOD-8 (SHOULD).** Modules listed as `modulepreload` in `index.html` are fetched and compiled in parallel
with the entry (on a background thread where V8 allows: streaming/background compile), so boot is not
serialised on one 6–7 MB chunk.
*Check:* boot timeline (DBG-STATS boot marks) shows compile of preload chunks overlapping.

**MOD-9 (MAY).** `<script type="importmap">` from `index.html` applies to module resolution.
*Check:* only if implemented: a mapped bare specifier loads.

## Code cache

**CC-1 (MUST).** The runtime keeps a V8 code cache per script/module so a warm start skips full parsing
and compilation. Cache entries are keyed by (script URL, a hash of the full source, V8 version and flag
hash); any change to one invalidates the entry. A cache the engine rejects is discarded and regenerated,
never trusted.
*Check:* first launch writes entries; second launch logs "consumed" for the entry chunk; changing one byte
of the chunk (re-pack) logs "rejected/miss" for that chunk only; a corrupted cache file (truncate it) is
detected and regenerated with no crash.

**CC-2 (MUST).** Cache creation happens after the code has run long enough to include lazily compiled
functions that ran during boot (e.g. after the first XR frame, or after boot plus N seconds), off the
frame-critical path (never inside an XR frame).
*Check:* the cache write appears in the boot timeline after the first XR frame and no frame in that second
is stale.

**CC-3 (SHOULD).** The packer can produce the code cache at pack time only if it can do so with a
byte-identical V8 (same version, flags, arm64); otherwise the cache is created on device on first run.
Shipping a cache that the device rejects is allowed (CC-1 handles it) but must not be the default.
*Check:* documented decision; pack-time cache measured as accepted on device or not offered.

**CC-4 (MUST).** Cache storage lives in the app's private cache directory, is bounded (default 64 MB,
LRU eviction), and is cleared when the APK's version code changes.
*Check:* upgrade install with a new version code; first launch shows misses then repopulates.

**CC-5 (SHOULD).** Workers use the code cache for their scripts too (KTX2 transcoder glue, MSDF worker),
keyed the same way (blob: scripts keyed by source hash only).
*Check:* second launch logs consumed entries for worker scripts.

**Budget:** warm boot (process start to entry evaluated) at least 30 % faster than cold for the
showcase; target in PERF-BOOT-*.
