# web/canvas2d: Canvas 2D for @iwer/native (JS half)

`CanvasRenderingContext2D`, `OffscreenCanvas`, `OffscreenCanvasRenderingContext2D`, `Path2D`, `CanvasGradient`,
`CanvasPattern`, `TextMetrics`, `ImageData` (when the image module has not installed its own), `FontFace`,
`FontFaceSet` (`document.fonts` / `self.fonts`), over the native core in [`../../runtime/canvas2d`](../../runtime/canvas2d/README.md)
(`globalThis.__iwn.canvas2d`). Spec: `docs/spec/06-images-canvas2d.md` (C2D-1..13, IMG-5).

| file | what |
|---|---|
| `src/context2d.ts` | the context: attribute validation, state stack (pooled), current default path in device space, every overload, errors |
| `src/path.ts` | CanvasPath methods → move/line/quad/cubic/close commands (arcs/ellipses as cubics), `roundRect` (all radius forms), SVG path data |
| `src/color.ts`, `src/font.ts` | CSS colours (named, hex, rgb/hsl/hwb in legacy and modern syntax, lab/lch/oklab/oklch, `color()` in the CSS Color 4 spaces) and the `font` shorthand, with Chrome's serialization |
| `src/fonts.ts` | FontFace / FontFaceSet (CSS Font Loading 3) and CSS Fonts 4 font matching (stretch → style → weight, synthesis flags) |
| `src/canvas.ts` | `CanvasHost` (bitmap/context bookkeeping), `OffscreenCanvas`, `installCanvasElementSupport(HTMLCanvasElement.prototype)` for the DOM module, WebGL contexts through the WebGL prelude, texImage2D source protocols |
| `src/sources.ts` | CanvasImageSource resolution: own canvases (native surface, no copy), the image module's `Symbol.for('iwn.image.source')` providers, resolvers, the `Symbol.for('iwn.pixels')` protocol |
| `src/natives.ts` | the native API contract and the per-context state block layout (one `Float64Array`, no per-call allocation) |
| `src/install.ts`, `entry.ts`, `build.mjs` | `installCanvas2D(global)`; `dist/canvas2d.min.js` (75 KB, 26 KB gzip) as a runtime prelude after glue, net and image |
| `test/` | `unit.test.ts` (spec semantics, CSS Color 4, WOFF/WOFF2, kerning, C2D-12 allocation check via `alloc-probe.ts`), `webgl-interop.test.ts` (texImage2D from 2D canvases, WebGL contexts, WebGL canvases as sources; real GL through Mesa when web/webgl's host addon is built), `golden.test.ts` (C2D-11 images + C2D-8 metrics vs Chrome), `golden/cases.mjs` (100 cases, shared with Chrome; synthetic bold/italic use the regular-only family `IwnRegular`), `golden/chrome/` (goldens) |
| `tools/gen-goldens.mjs` | renders the goldens in headless Chrome (playwright-core + chrome-headless-shell, software, unhinted text) |
| `tools/bench-label.ts` | C2D-12 label micro-benchmark |

## Interop

- **WebGL, texImage2D from a canvas (C2D-2, GL-17):** canvases with a 2D context (or none) implement both protocols
  web/webgl reads: `[Symbol.for('iwn.image.source')]()` -> `{kind: 'pixels', origin: 'canvas', premultiplied: true,
  data}` (INTEROP.md §2/§3, what web/webgl prefers) and `[Symbol.for('iwn.texImageSource')]()` -> straight-alpha RGBA
  (web/webgl's own protocol). Both read into one shared buffer (no allocation per upload; the consumer reads it during
  the call; web/webgl currently converts the pixels for FLIP_Y / straight alpha in JS and allocates a full-size array per
upload, about 0.7 ms per 512x128 label on x86: a native unpremultiply+flip upload from the surface handle needs
a WebGL binding change, see below). Canvases with a WebGL context expose no tex-source (web/webgl reads their drawing buffer itself) and give
  image-source/drawImage pixels by reading the drawing buffer through the context's public API (bindings and pack
  state restored). Zero-copy alternative for natives: `[Symbol.for('iwn.canvas2d.surface')]()` returns the native
  surface handle; `iwn::canvas2d::SurfaceFromValue(isolate, handle)` gives the `Surface` (premultiplied RGBA8, top row
  first, `generation()` changes on every draw). Not used by runtime/gl or web/webgl yet (a later WebGL change).
- **WebGL contexts:** `getContext('webgl' | 'webgl2' | 'experimental-webgl')` uses a factory registered with
  `registerContextFactory`, else the WebGL prelude's `globalThis.__iwnWebGL.createContext(canvas, type, attrs)`, else
  the `getContext` the DOM module's `HTMLCanvasElement` had before canvas behaviour was added to it (also used for any
  other context type this module does not create).
- **DOM:** call `installCanvasElementSupport(HTMLCanvasElement.prototype)` (or let `installCanvas2D` find
  `globalThis.HTMLCanvasElement`).
- **Images:** `drawImage`/`createPattern` accept the image module's providers (handles are drawn natively from its
  PixelStore); a loading `HTMLImageElement` draws nothing; `ImageData` is rejected with TypeError.

## C2D-12: no JS allocation per call

Hot paths keep their data in reused typed arrays and objects: the state block, path buffers, parsed colour and font
strings (realm-wide caches, shared immutable style objects), the resolved native font (cached on the state until a
text attribute or the font set changes, and per parsed font + text options in the font manager, so switching between
fonts finds the native font without building a key string or an options object), the canvas surface descriptor and
one reused result for image-module sources used by `drawImage`, recycled clip handles (a clip made at a save depth is
unreachable once replaced or restored, and its handle takes the next clip's mask), `setLineDash` with the values
already in effect is a no-op, and `letterSpacing` / `wordSpacing` strings are parsed once (realm-wide cache; an `em` value is kept as em and resolved
against the font when text is drawn or measured, as in Chrome). Arcs, ellipses and
rounded rectangles write straight into the path buffer (no closures, tuples or per-segment calls with double
arguments, which V8 boxes). `unit.test.ts` measures it: `alloc-probe.ts` runs each operation at steady state in a
child process with a 64 MB young generation (no scavenge can hide allocations) and checks the JS heap growth.
Result (Node 24, bytes per call): fillStyle/font assignment, fillRect, set/transform/rotate/resetTransform,
save/restore, arc and roundRect paths, drawImage (3 and 9 args, canvas and image-module sources), fillText, a full
label redraw, alternating two fonts with fillText, save/font/fillText/restore, setLineDash with unchanged values and
with `[]`, save/clip/fill/restore and nested clips all 0 (budget 8); measureText about 350 (the TextMetrics object the
API returns). The caller's own literals (`setLineDash([4, 2])` written inline) are the caller's allocation; the probe
hoists them.

## Tests

```bash
# from packages/native, Node 24; the golden/context tests need the addon (runtime/canvas2d README)
export IWN_CANVAS2D_ADDON=<build>/canvas2d.node     # or build/canvas2d-host/canvas2d.node
node --test --test-concurrency=8 web/canvas2d/test/*.test.ts
node_modules/.bin/tsc -p web/canvas2d
IWN_GOLDEN_SUMMARY=1 IWN_GOLDEN_OUT=/tmp/c2d node --test web/canvas2d/test/golden.test.ts   # per-case diffs + images
node web/canvas2d/build.mjs
```

Goldens: Chrome 145 headless shell, `--disable-gpu --font-render-hinting=none`, `willReadFrequently` canvases;
text uses the family `IwnTest` = the bundled Roboto files loaded with `FontFace` in both environments. Compare rule
(C2D-11): fraction of pixels whose premultiplied channels differ by more than 16/255.

**C2D-11 status: 88 of 100 cases meet the spec's 2 %; 12 exceed it** (each has a commented per-case bound just above
its measured value): stroke-miterlimit 2.5 %, stroke-dash 3.7 %, stroke-circle 3.0 %,
stroke-nonuniform-scale 4.1 %, pattern-settransform 3.2 %, text-12px-aligns 3.4 %, text-12px-baselines 3.1 %,
text-stroke 3.6 %, text-gradient-fill 2.1 %, text-rotated 2.6 %, text-greek-cyrillic 2.1 %, text-synthetic-italic
2.3 %. What remains is
anti-aliasing, not what is drawn, and mostly Chrome's: measured against 16x16-supersampled analytic coverage, our
filled circles (radius 6-40) are within 1/255 on average with no edge pixel off by more than 16/255, while Chrome's
edge pixels average 11-26/255 below analytic coverage (Skia approximates curves with quadratics/conics and short
chords and samples coverage by supersampling); Chrome's strokes offset curves with quadratic approximations; at 12 px
the glyph edges scatter both ways by up to ~100/255 per pixel with no systematic transfer curve (no gamma/contrast to
match). Matching those cases within 2 % would mean reproducing Skia's approximations rather than the geometry.
measureText: width equal to Chrome's in all 81 rows; font ascent/descent and alphabetic baseline within 1 px
(Chrome 145 reports no emHeightAscent/emHeightDescent, so those are not compared).

Hit testing follows HTML: points on the path (rectangle edges and corners, both sides and the ends of a stroke outline)
are inside for `isPointInPath` / `isPointInStroke`, as in Chrome. `OffscreenCanvas` width/height are `[EnforceRange]`
(TypeError for negative, non-finite or > 2^32 - 1 values, as Chrome); element width/height wrap per WebIDL and fall
back to the default above 2^31 - 1 (HTML reflection). `font = '0 sans-serif'` (unitless zero) is accepted. Font sizes
clamp to 10000 px (Chrome's computed value, so the getter, metrics and drawing agree). `getContextAttributes()`
returns `colorType` and `toneMapping` as Chrome 145 does. Bitmaps follow Chrome's limits (32767 px per side,
16384 x 16384 pixels): a larger canvas keeps its width/height but has no bitmap, draws nothing, and reads (including
`texImage2D`) are transparent black, never the shared readback buffer's previous contents.

Other Chrome comparisons (manual, outside the repo): 78 attribute/argument cases differ
in 2 (`font = '50% sans-serif'` reads back 0px in Chrome's OffscreenCanvas; system font keywords resolve to Chrome's
own UI font); international text with Noto fonts (Arabic and Hebrew with digits and Latin in both directions,
Devanagari, Thai, CJK, colour emoji with ZWJ and keycap sequences, variable weights) within 0.8-3 % per image and
equal measureText widths, except colour-emoji advances (0.065 px narrower per emoji than Chrome, inside C2D-8's 5 %).
Colour emoji are minified from box-filtered mip levels of the ~136 px CBDT strike and always filtered (browsers do not
apply `imageSmoothingEnabled` to text): the emoji cases went from 5.6 / 6.4 % to 2.2 / 1.2 % of pixels
differing from Chrome.

## Not implemented yet

`filter` (setting a non-`none` value logs once and draws unfiltered, as C2D-4 allows), `bitmaprenderer` contexts
(throws, C2D-13), COLR v1 colour glyphs, explicit bidi embedding/isolate controls (treated as neutral), mipmapped
downscaling for `imageSmoothingQuality` medium/high, relative colour syntax and system colours, `alpha: false` beyond
clearing to opaque black (clearRect fills the rect with opaque black, source-over, clipped; only the rect changes), FontFace `unicodeRange`/`featureSettings`/`variationSettings` (stored, not applied),
`fontVariantCaps` values other than small-caps/all-small-caps (accepted, no effect).
