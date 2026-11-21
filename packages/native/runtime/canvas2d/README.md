# runtime/canvas2d: Canvas 2D raster core and text

Native half of `CanvasRenderingContext2D` / `OffscreenCanvasRenderingContext2D` with text. The JS half (spec
semantics, state, paths, fonts API) is [`../../web/canvas2d`](../../web/canvas2d/README.md). Spec IDs: C2D-1..13,
IMG-5, IMG-7, REG-1, REG-15 (`docs/spec/06-images-canvas2d.md`). GAP-1 (showcase labels visible in an XR
screenshot) and C2D-8's headset map-plate screenshot are not verified yet: they need the M3/M4 integration.

## Layout

| path | what |
|---|---|
| `include/iwn/canvas2d/types.h` | matrices, colours, composite ops, path command format |
| `include/iwn/canvas2d/canvas.h` | `Surface` (premultiplied RGBA8), `Gradient`, `Pattern`, `ClipMask`, `Canvas` (fill, stroke, clearRect, drawImage, clip, hit tests, get/putImageData), `ReadPixels`, `EncodeImage` |
| `include/iwn/canvas2d/text.h` | `Face` (FreeType + HarfBuzz), `Font` (fallback, shaping, TextMetrics, drawing), `FontRegistry` (bundled + system fonts), fonts.xml parser |
| `src/raster.*` | anti-aliased scanline rasterizer (exact area coverage, nonzero/even-odd, no size limits) |
| `src/geometry.*` | flattening, stroker (caps, joins, miter limit, hairlines), dasher, point-in-path |
| `src/shader.*`, `src/blend.*` | solid/linear/radial/conic gradients, patterns and image sampling (nearest/bilinear); all 26 composite operations |
| `src/canvas.cc` | draw pipeline, shadows (3-pass box blur, Filter Effects sizes), clip masks, pixel access, encoders |
| `src/font.cc`, `src/text.cc`, `src/fonts_xml.cc` | faces, CBDT colour strikes, COLR v0 layers, per-character fallback, script itemisation (UAX #24), HarfBuzz shaping, metrics, glyph drawing |
| `src/bidi.*` | the Unicode Bidirectional Algorithm (UAX #9) for one paragraph: W1-W7, N0 (bracket pairs), N1-N2, I1-I2, L1; visual run order (L2) is in `text.cc` |
| `src/codec.cc` | stb_image_write (PNG/JPEG for toBlob/toDataURL), stb_image (PNG in CBDT emoji); all stb symbols file-static |
| `binding/api.*` | engine-neutral operations behind the JS API; state-block layout |
| `binding/v8_binding.cc`, `canvas2d_v8.h` | `iwn_register_canvas2d`, `SurfaceFromValue` (zero-copy uploads), `DisposeIsolate` (workers), `InstallAndroidAssetReader` (hosts without the core runtime) |
| `binding/napi_binding.cc` | the same API as a Node addon, for the headless golden tests (not shipped) |
| `third_party/*.cmake` | FreeType 2.14.2, HarfBuzz 14.0.0, Brotli 1.2.0 (upstream sources under `IWN_THIRD_PARTY_DIR`), minimal configurations |
| `fonts/` | bundled faces (C2D-9): Roboto Regular/Bold, Roboto Mono Regular (SIL OFL 1.1, licence files next to them) |
| `licenses/`, `apk-assets.json` | third-party notices (FreeType credit, HarfBuzz, Brotli, zlib, stb, Unicode) and the list of files the APK needs (fonts to `assets/iwn/fonts/`, notices to `assets/iwn/licenses/canvas2d/`) |
| `test/` | host unit tests (rasterizer, strokes, canvas ops, fonts, shaping, fonts.xml, bidi levels and visual order, emoji sequence itemisation, variable-font weight clamping, shadow/dash bounds, clip memory, curve accuracy vs analytic coverage; `bounds_test.cc`: shadow cost vs canvas size, extreme stroke widths, left-of-clip edges, hit testing on the boundary, fonts.xml wght axes, colour emoji memory/mips/smoothing with `IWN_C2D_EMOJI_FONT=<NotoColorEmoji.ttf>`, culled off-canvas dashes, dashes on ~1e37-long segments (in a child process with a 2 GB address-space limit), overflowing edge slopes, bounded LRU glyph caches; `stroke_raster_test.cc`: thin strokes under non-uniform scales, dashes along a compressed axis and a 44,100-sample waveform (both in memory-capped children), banded and dense sweeps equal to the plain one, non-finite paths, cell-sum overflow, the leading zero-length dash, the CBDT PNG size cap) |

## Rasterizer choice (vs. the ≤ 12 MB runtime budget, PKG-SIZE-1)

| option | per-APK cost (arm64, compressed) | notes |
|---|---|---|
| **chosen: own rasterizer + FreeType + HarfBuzz** | **~655 KB code** (whole module: raster, text, FreeType, HarfBuzz, Brotli for WOFF2, stb; zlib -9 of the stripped module) **+ 406 KB fonts** (stored uncompressed, see below): about 1.06 MB | stripped module 1,285,048 B (`.text` 794 KB, `.rodata` 314 KB), measured on an arm64 link of the V8 binding + api + core + FreeType + HarfBuzz + Brotli with gc-sections and an exports map; HarfBuzz ~40 %, FreeType ~21 %, Brotli ~11 % (dictionary), our code + stb ~11 %. (Earlier README figures, 1.21 MB and 586 KB, came from a narrower link.) |
| Skia CPU-only, built from source | ≥ 2–3 MB | GN-only build (~950 sources), would need a hand-made CMake port; the V8 15.5 library alone is already 38.9 MB uncompressed |
| CanvasKit (WASM) | ~7 MB + JIT/Wasm memory | fallback only if native were infeasible |
| FreeType's own gray rasterizer for paths | 0 KB extra | rejected: `FT_Outline` caps a path at 65,535 points with 26.6 coordinates; canvas paths exceed that |

The path rasterizer is the well-known sparse cell / exact-area algorithm (as described for libart, FreeType's smooth
rasterizer and font-rs), written here from that description: 24.8 fixed point, edges canonicalised top-to-bottom so
shared edges cancel exactly (the stroker unions per-segment pieces). Curves are flattened at 0.06 device px with the
chords' inward bias compensated (interior points move outward by 2/3 of the local sagitta), so curved edges match
analytic coverage (mean error under 1/255 on circles of radius 6-40; it was about -20/255 with plain 0.2 px chords). Text goes through the same rasterizer
(glyph outlines from FreeType, unhinted), so transforms, gradients, patterns, shadows, clips and compositing apply to
text as to paths. Edges are recorded first (20 bytes each) and walked into cells at Finish(); a shape whose edges would
make more than 2^21 cells (long polylines whose segments span many rows) is swept in horizontal bands, so the
rasterizer's memory is bounded instead of growing with edges x rows. Rows with many cells sum them into per-column
accumulators instead of sorting them (same result, O(cells + width)). A random 44,100-sample waveform stroked on
1024x1024: 0.5 s and +146 MB peak RSS (was 2.9 s and +913 MB; Chrome's software canvas 0.17 s); 100,000 samples on
2048x1024: 1.0 s and +153 MB (was 7.1 s and 2.1 GB). Axis-aligned glyphs snap to 1/4 px horizontally and whole pixels vertically, like browsers'
glyph caches; ascent/descent are reported in whole pixels as Chrome does.

Fonts in the APK: Roboto Regular 159,108 B + Roboto Bold 159,900 B + Roboto Mono 87,540 B = 406 KB. `apk-assets.json`
stores them uncompressed (`"compress": false`) so the asset can be mapped instead of inflated into heap memory; deflated
they would be about 242 KB (164 KB less download, at the cost of a heap copy of each face that is used).

## Bounds and robustness

- Shadows: sigma (= shadowBlur / 2) is capped at 532 px (beyond that the shadow is a faint uniform wash; Skia caps
  too), and blurs with sigma above 32 px run on an alpha plane downsampled by ceil(sigma / 32) and sampled back
  bilinearly, so one shadowed draw costs bounded time and memory for any shadowBlur (40x40 square with blur 1e4 on a
  512x128 canvas: was 32.8 s and ~3.2 GB, now well under 1 ms of extra work; a shape far larger than the canvas with
  blur 1e4: < 0.1 s).
- Shadow cost follows the shape, not the canvas: with bounded composite operators the shadow and shape passes visit
  only the shadow's footprint and the shape's pixels (20x20 rect with shadowBlur 4: 0.039 ms on 4096x4096, was
  17.7 ms; shadowBlur 100: 0.85 ms, was 140.7 ms). When a large shadow offset puts the shadow source far from the
  canvas, the shape and the source are rasterised separately instead of over their common bounding box (a stroke
  covering everything with offset (-60000, 50000) on 160x96: 17.3 s before, 0.05 s now).
- Rasterizer: edge intercepts at the clip box are convex combinations (t in [0, 1], halved operands), never a slope:
  with finite endpoints and an x scale of ~1e308 over a sub-pixel dy, the slope (x1 - x0) / (y1 - y0) overflowed, the
  clipped x became inf, the split at the clip edge produced NaN rows and Finish() wrote outside its row table (heap
  overflow found by fuzzing). Non-finite results are dropped, and cells outside the clip rows are discarded
  before indexing (defence in depth). A path with a NaN or infinite vertex (beyond float range, or a transform that
  overflows) is not drawn at all, as in Skia/Chrome; dropping just that edge left the contour open and filled out to
  the clip edge. A cell's int sums are flushed into a new cell for the same pixel before they could overflow (40,000
  loops inside one pixel overflowed them: UB); the sweep adds cells up in 64 bits. Edges left of the clip box add their cover per row through a difference array
  (O(1) per edge) instead of walking a cell per row; images and patterns reduce texel coordinates into range before converting to int
  (extreme pattern transforms or CTMs were undefined behaviour). A raster fuzzer (3,000 random draws with
  values up to 1e30) runs clean under ASan + UBSan (float-cast-overflow included) on three seeds; its slowest single
  call in a release build went from 18 s to 1.2 s (shadowBlur capped at sigma 532 over a 3,000 px source area with a
  pattern paint; bounded, not free).
- Thin strokes: hairline treatment follows Skia's test, the line width along each user axis mapped to device. Only
  a stroke at most one device pixel thick in both directions becomes a 1 px device-space line with coverage equal to
  the mean of the two widths; otherwise the true geometry is stroked. (The old test used the mean scale sqrt|det| and
  an isotropic user-space half-width, so under scale(0.096, 32) a lineWidth 0.08 sparkline became an 18 px pale band
  instead of Chrome's ~2.5 px line.)
- Dashes: only the part of each segment inside the cull box (the clip box mapped to user space, grown by the stroke's
  reach) is walked dash by dash; the parts outside advance the pattern arithmetically. The dash-count bound counts
  only that visible length: patterns whose period is under half a device pixel along the path (the visible part's
  device length over its user length, so a pattern compressed by scale(1e-4, 1) counts as tiny), or whose visible
  part would produce more than 1,000,000 dashes (Skia's limit), more than 4e6 outline vertices or more than 8e6
  raster rows, are stroked undashed with the
  pattern's average "on" coverage (caps included), which is what the dashes average to on screen ([1e-5, 1e-5] on a
  500 px line: was 8.7 s and 2 GB, now microseconds; a 4e8 px line with [190, 232] and round caps: 0.1-2 ms at
  lineWidth 1-1e4, was 0.5-14 s). The walk measures positions from the clipped entry point, and that point is
  interpolated from the segment end nearer to the cull edge: on a segment ~1e37 long, a position measured from its
  start plus a 135 px dash did not move, so the walk never ended and allocated until the process was killed (found
  by the extreme-value fuzzer at ~100 GB). Each step now always advances, and the walk stops at 2,000,000 pieces.
  scale(1e-4, 1) with lineWidth 1 and [20, 20] across 1024 px: under 1 ms and 1 row (was 5.2 s, 1.6 GB, 100 rows).
  A zero-length "on" dash at a subpath start draws its dot there (setLineDash([0, n]) dotted lines start at the
  first point, as in HTML and Chrome).
- Colour glyph PNGs (CBDT) larger than 1024 px on a side are rejected from the PNG header before decoding, so a
  crafted font loaded through FontFace cannot make one glyph allocate gigabytes.
- Extreme-value fuzzing (a fuzzer with values up to DBL_MAX in transforms, paths, shadows, strokes,
  text and clips): release build, 9 seeds x 1,500 draws, slowest single call 0.8 s, peak RSS 643 MB; ASan + UBSan
  (float-cast-overflow included), 5 seeds x 600 draws: no reports.
- No C++ exception crosses into the engine: every V8 and Node-API callback catches; allocation failure becomes a JS
  `RangeError`, anything else an `Error`.
- Glyph caches are per face, least recently used, with byte budgets: 4 MB of outlines and 12 MB of colour bitmaps
  (with their mips, about 130 colour emoji). Drawing 945 distinct NotoColorEmoji glyphs grows the native heap by
  12 MB (was 84.5 MB, unbounded).
- Memory: canvases share their thread's rasterizer scratch (trimmed back after unusually large draws) instead of
  each keeping its own high-water buffers; clip masks store only the area the clip path covers, not the whole canvas.
- Per isolate: the handle template is per context (the callbacks' data), so nothing is cached per isolate address.
  Live handles are tracked per isolate; `iwn::canvas2d::DisposeIsolate(isolate)` frees them (V8 runs no weak
  callbacks at isolate teardown). Inside the runtime the main isolate registers that as a core shutdown hook; a
  worker host must call it before `Isolate::Dispose()`.

## Fonts

- Bundled faces (C2D-9) are read through `FontRegistry::SetAssetReader`. Inside the runtime the V8 binding installs a
  reader over the core's `AssetSource` (`iwn::Runtime::assets()`) for `assets/iwn/fonts/<file>`; the packer has to
  copy the files listed in `apk-assets.json` (the release build does: `release/stage-template-assets.mjs`). Other hosts can call
  `iwn::canvas2d::InstallAndroidAssetReader(AAssetManager*)` (asset path `fonts/<file>`). Without bundled files the
  registry falls back to `/system/fonts/<file>` (Quest has `Roboto-Regular.ttf`; measured below).
- System fonts: `/system/etc/fonts.xml` is parsed lazily; named families (sans-serif, serif, monospace, aliases)
  are offered to the JS family matcher, unnamed families form the per-character fallback chain (emoji, CJK,
  Arabic, Devanagari, ...). Colour fonts are preferred for emoji presentation (CBDT strikes decoded from PNG).
- Text runs: per-character font choice, script itemisation (UAX #24: Inherited characters such as ZWJ, variation
  selectors and the keycap mark always take the previous character's script, so emoji ZWJ and keycap sequences reach
  HarfBuzz whole even without letters), bidi levels (UAX #9, paragraph direction from `ctx.direction`), runs split
  on face/script/level and reordered visually (L2), odd levels shaped right to left. Explicit embedding/isolate
  controls (U+202A-202E, U+2066-2069) are treated as neutral, not as embeddings.
- Variable faces are instantiated at the requested weight clamped to the face's CSS weight range (the `FontFace`
  weight descriptor, the fonts.xml weight, or the font's own axis); synthetic bold applies when that range is below
  600, as in CSS Fonts 4 / Chrome.
- COLR v1 paint graphs are not drawn (documented gap: a COLR v1-only emoji font shows nothing; Quest's system emoji
  font is CBDT).

## Build and test

```bash
# host (x86_64): unit tests + the Node addon used by web/canvas2d's golden tests
cmake -S runtime/canvas2d -B build/canvas2d-host -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DIWN_NODE_API_INCLUDE_DIR=<node-api-headers>/include      # npm pack node-api-headers@1.9.0
ninja -C build/canvas2d-host -j 16 && build/canvas2d-host/iwn_canvas2d_tests
# as part of the runtime (runtime/CMakeLists.txt adds this directory): the module target is iwn_canvas2d
```

`IWN_THIRD_PARTY_DIR` (default `$IWN_THIRD_PARTY_DIR`), `IWN_FREETYPE_DIR`, `IWN_HARFBUZZ_DIR`, `IWN_BROTLI_DIR`
and `IWN_STB_DIR` (defaults: `freetype/`, `harfbuzz/`, `brotli/` and `stb/` under it; THIRD_PARTY.md),
`IWN_V8_INCLUDE_DIR` and `IWN_CANVAS2D_WOFF2` (default ON) are cache variables. With `runtime/image` present the V8
binding draws `ImageBitmap`/`HTMLImageElement` handles straight from the image module's `PixelStore`
(`runtime/image/INTEROP.md` §4).

## Measured

- Host: unit tests 39/39; web/canvas2d 145 tests (golden images, metrics, unit, WebGL interop with Mesa, C2D-12
  allocation probe). Golden status vs Chrome 145: `web/canvas2d/README.md` (88 of 100 within 2 %, 12 with documented
  anti-aliasing bounds; measureText widths equal to Chrome's in all 81 rows).
- Quest 3S, 2026-10-20, release APK (runtime snapshot of that afternoon with the
  glue, net, image, webgl and canvas2d preludes and the `apk-assets.json` files; suite in
  `web/canvas2d/tools/device-suite/`):
  - all 100 golden cases rendered on the device are **bit-identical** to the host rendering and within their limits
    against Chrome; the 81 measureText rows equal Chrome's widths exactly (C2D-11 on device);
  - bundled faces loaded from `assets/iwn/fonts/` through the core asset reader (sans-serif Roboto 400/700 and
    monospace Roboto Mono, which `/system/fonts` does not have); `'20px "Some Missing Font", sans-serif'` measures like
    the bundled Roboto (C2D-9); 33 system families from fonts.xml; three `FontFace(url())` faces loaded through fetch
    and `document.fonts.ready` resolved (C2D-10);
  - the family emoji (ZWJ) and the keycap 1 measure as one glyph each (34.86 px at 28 px, like a single emoji);
  - texImage2D from a 2D canvas into a WebGL2 texture (FLIP_Y): red, red, half-transparent blue / red, red,
    transparent, read back exactly (C2D-2, GL-17);
  - 512x128 label with 20 characters: **0.90-1.00 ms** per draw (C2D-12: < 2 ms on Quest 3);
  - IMG-7: RSS 195 MB before the loop, at most 262 MB while 500 1024² canvases (2 GB of pixels) were created and
    dropped, 210 MB right after and 189 MB 30 s later (spec: within 50 MB of baseline).
