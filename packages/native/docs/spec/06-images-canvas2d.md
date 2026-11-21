# 06. Images, ImageBitmap, canvases and Canvas 2D (including text)

Sources: HTML §4.8.3 (`img`), §4.12.5 (the `canvas` element, `CanvasRenderingContext2D`,
`OffscreenCanvas`, `ImageData`, `ImageBitmap`, `createImageBitmap`), CSS Fonts 4 (font shorthand
parsing), WebGL 2.0 §5.14/§5.35 (`texImage2D` from `TexImageSource`, `UNPACK_*_WEBGL`); PNG/JPEG/WebP
specs; the showcase's map plates and sound-pad labels (they need `fillText`, `stroke` and `roundRect`);
the showcase's source (`src/map.ts`, `src/clay.ts` draw with Canvas
2D); three's `GLTFLoader` (textures via `createImageBitmap`).

## Decode

**IMG-1 (MUST).** PNG (8/16-bit, palette, grey, alpha, interlaced), JPEG (baseline and progressive, EXIF
orientation honoured only when `imageOrientation: 'from-image'`), WebP (lossy, lossless, alpha), GIF
(first frame) decode to RGBA8. AVIF and HDR/EXR are not image-decoder formats here (three decodes
`.hdr`/`.exr` in JS). Decode runs on a background pool; the main thread only receives finished pixels.
*Check:* a decode test set (PNGSuite subset, JPEG progressive/CMYK, WebP lossless+alpha) matches
reference decodes (libpng/libjpeg-turbo/libwebp output, or Chrome's) within ±1 per channel.

**IMG-2 (MUST).** Undecodable bytes reject with `InvalidStateError` (createImageBitmap) or fire `error`
(`Image`), never crash; decoders are memory-safe on fuzzed input (fuzz the chosen decoders for 1 CPU-hour
in CI).
*Check:* fuzz job report; truncated-file tests.

**IMG-3 (MUST).** Decoded images larger than the GL `MAX_TEXTURE_SIZE` still decode (an app may resize);
images above 16384 px in either dimension or 256 MP total reject with `InvalidStateError`.
*Check:* tests.

## Image element, ImageData, ImageBitmap

**IMG-4 (MUST).** `new Image()`, `document.createElement('img')`, `createElementNS(xhtml|svg, 'img')`:
`src` (fetch with NET rules, then decode), `crossOrigin` (stored), `decoding`, `complete`,
`naturalWidth/naturalHeight`, `width/height` (attributes or natural), `decode()` promise, `onload`/
`onerror` and `addEventListener('load'|'error')`; setting `src` again while a load is pending cancels the earlier load (only the newest one fires an event).
*Check:* three's `ImageLoader` and `TextureLoader` paths; runtime tests.

**IMG-5 (MUST).** `ImageData(w, h)`, `ImageData(data, w[, h])` with spec validation (`IndexSizeError`,
`InvalidStateError`), `data` a `Uint8ClampedArray`, `colorSpace` `'srgb'`.
*Check:* tests.

**IMG-6 (MUST).** `createImageBitmap(source[, sx, sy, sw, sh][, options])` for `Blob`, `ImageData`,
`ImageBitmap`, `HTMLImageElement` (loaded; unloaded rejects `InvalidStateError`), `HTMLCanvasElement`,
`OffscreenCanvas` (2D and WebGL canvases). Options: `imageOrientation` (`from-image`, `flipY`, `none`),
`premultiplyAlpha` (`default`, `premultiply`, `none`), `colorSpaceConversion` (`default`, `none`: no
colour management is done either way, documented), `resizeWidth/resizeHeight/resizeQuality` (at least
`low` = bilinear/nearest; `high` may equal `medium`). The options decide the bitmap's pixels as the HTML
spec says; uploading the bitmap to a texture later reproduces those pixels and ignores the
`UNPACK_FLIP_Y_WEBGL`/`UNPACK_PREMULTIPLY_ALPHA_WEBGL` settings (WebGL 2.0 §5.14.8), and costs no more
than uploading raw RGBA of the same size (PERF budget in C2D-12). `ImageBitmap.close()` releases the
pixels; `width/height` become 0; uploading a closed bitmap throws `InvalidStateError`.
*Check:* decode a 4×4 PNG whose four corners have distinct colours and half-transparent alpha; read the
uploaded texture back through a framebuffer for each combination of `imageOrientation` and
`premultiplyAlpha`, and compare against the values Chrome produces for the same calls; a glTF with
textures loads through three's `GLTFLoader` with the same texels as Chrome.

**IMG-7 (MUST).** Pixel memory of bitmaps and canvases lives outside the JS heap and is reported to V8 as
external memory so GC pressure accounts for it.
*Check:* create and drop 500 1024² bitmaps without `close()`; RSS returns within 50 MB of baseline after
a GC.

## Canvas element and contexts

**C2D-1 (MUST).** `document.createElement('canvas')` / `new OffscreenCanvas(w, h)`: default 300×150,
`width/height` setters reallocate and clear, `getContext('2d' | 'webgl2' | 'webgl', attrs)` returns the
same context object on repeated calls for the same type and `null` for a different type after the first,
`toBlob(cb, type, quality)` (PNG always; JPEG and WebP optional, falling back to PNG), `toDataURL`,
`OffscreenCanvas.convertToBlob`, `transferToImageBitmap` (hands over the pixels, leaves a fresh cleared
buffer), `transferControlToOffscreen` absent.
*Check:* tests.

**C2D-2 (MUST).** Any number of canvases may hold WebGL contexts. Each behaves as an independent WebGL
context: its own default framebuffer, state, objects and extension objects; state changes in one are
never observable in another; its content can be used as a `TexImageSource` in other contexts and in
`drawImage`/`createImageBitmap`, upright (top row first in canvas space). The context whose rendering
reaches the headset is the one the app hands to WebXR (`XRWebGLBinding`, or `XRWebGLLayer` after
`makeXRCompatible()`), whichever canvas it belongs to and whenever it was created; a library that creates
a WebGL canvas earlier does not change that. All layers of one session use one context; creating a layer
for a different context in the same session throws `InvalidStateError` (documented runtime limit). A new
session may use a different context.
*Check:* a test that interleaves calls on two contexts (bind a texture in A, draw in B, read A's binding:
unchanged); a texture rendered in a second context and uploaded into the XR context with
`texImage2D(…, canvas)` shows the same texels as Chrome; an app that creates an unrelated WebGL canvas
before its renderer still renders in the headset.

**C2D-3 (SHOULD).** Cost of several WebGL contexts, as observed: with only one context, binding cost
meets GL-PERF-1; creating a second context raises the first context's ns/call by at most 5 %; uploading a
1024×1024 canvas from another context into a texture costs ≤ 0.2 ms main-thread CPU on Quest 3.
*Check:* gl-bench ns/call with 1 and 2 contexts (GL-PERF-1); upload micro-benchmark on device.

## Canvas 2D

**C2D-4 (MUST).** State and transforms: `save/restore`, `globalAlpha`, `globalCompositeOperation`
(`source-over` required; `copy`, `destination-out`, `lighter`, `multiply` SHOULD), `translate/rotate/
scale/transform/setTransform/getTransform/resetTransform`, `imageSmoothingEnabled/Quality`, `reset()`;
`filter` SHOULD (`none` and every CSS Filter Effects 1 filter function: `blur()`, `brightness()`,
`contrast()`, `drop-shadow()`, `grayscale()`, `hue-rotate()`, `invert()`, `opacity()`, `saturate()`,
`sepia()`; `url()` references to SVG filters are not supported, as there is no SVG document; no IWSDK
package, example or the showcase uses `filter` today; until implemented, setting a non-`none` value logs
once and draws unfiltered).
*Check:* per-feature golden images (see C2D-11).

**C2D-5 (MUST).** Pixels: `fillRect/clearRect/strokeRect`, `putImageData` (with dirty rect),
`getImageData` (with `willReadFrequently` accepted), `createImageData`, `drawImage` in 3/5/9-argument
forms from bitmaps, images, canvases (2D and WebGL), `ImageData` is not a drawImage source (TypeError).
*Check:* tests.

**C2D-6 (MUST).** Paths and fills: `beginPath/closePath/moveTo/lineTo/bezierCurveTo/quadraticCurveTo/arc/
arcTo/ellipse/rect/roundRect` (all radius forms), `fill(rule)`, `fill(Path2D, rule)`, `Path2D`
(constructor from path or SVG path string, `addPath`, same methods), `clip`, `isPointInPath`;
`fillStyle`/`strokeStyle` as CSS colours (named, hex 3/4/6/8, `rgb[a]()`, `hsl[a]()` in legacy and space
syntax, `transparent`), `CanvasGradient` (linear, radial, conic SHOULD) and `CanvasPattern` (repeat modes)
with anti-aliased edges (coverage AA; exact sample positions may differ from Skia).
*Check:* golden images; `roundRect` at module top level does not throw (the showcase's first boot
blocker).

**C2D-7 (MUST).** Strokes: `stroke()`, `stroke(Path2D)`, `strokeRect`, `lineWidth`, `lineCap` (butt,
round, square), `lineJoin` (miter, round, bevel), `miterLimit`, `setLineDash/getLineDash/
lineDashOffset`; hairlines (< 1 px) render with reduced coverage, not vanishing. (Regression guard: a
`stroke()` that draws nothing; GAP-1.)
*Check:* golden images for each cap/join; the showcase's map pill outlines appear.

**C2D-8 (MUST).** Text: `font` (CSS font shorthand: style, variant small-caps optional, weight
100–900/bold/normal, size in px/pt/em/rem/%, line-height ignored, family list with generic families),
`textAlign` (start, end, left, right, center), `textBaseline` (top, hanging, middle, alphabetic,
ideographic, bottom), `direction` (ltr; rtl SHOULD), `letterSpacing`/`wordSpacing` SHOULD,
`fillText(text, x, y[, maxWidth])` and `strokeText(...)` rasterise glyph outlines with the current fill/
stroke style, transform, alpha, shadows (SHOULD) and clip; `measureText` returns `TextMetrics` with
`width`, `actualBoundingBoxLeft/Right/Ascent/Descent`, `fontBoundingBoxAscent/Descent`, `emHeightAscent/
Descent`, `alphabeticBaseline`, `hangingBaseline`, `ideographicBaseline`, consistent with what
`fillText` draws. (Regression guard: a `fillText` that draws nothing and an estimated `measureText` leave
the labels blank; GAP-1.)
*Check:* golden images of "Ag Showcase 123" at 12/24/48 px in each alignment/baseline; `measureText
('M').width` within ±5 % of Chrome on Quest for the same font file; the showcase's map plates and
PLAY/STOP labels are legible in a headset screenshot.

**C2D-9 (MUST).** Fonts: the runtime ships at least one sans-serif font with Latin, Latin-1 supplement,
Greek, Cyrillic and common symbols, licensed for redistribution in every APK (OFL/Apache; the choice is an
open question), mapped to the generic families `sans-serif`, `system-ui`, `serif` (fallback), `monospace`
(a monospace face SHOULD ship). Unknown family names fall back to `sans-serif`. Glyph lookup falls back
per character to a second font for CJK/emoji only if one is configured (not shipped by default; missing
glyphs draw the font's `.notdef`).
*Check:* license file in the APK; `ctx.font = '20px "Some Missing Font", sans-serif'` renders with the
shipped face.

**C2D-10 (MUST).** `FontFace` and `document.fonts`: `new FontFace(family, source: ArrayBuffer | url())`,
`load()`, `document.fonts.add/delete/has/check/load/ready`, so an app can register its own TTF/OTF/WOFF2
for canvas text. WOFF2 decoding SHOULD be supported; TTF/OTF MUST.
*Check:* register a TTF from the dist and render with it; `document.fonts.ready` resolves.

**C2D-11 (MUST).** Canvas 2D conformance: a golden-image suite of ≥ 60 small cases (fill, stroke, text,
gradients, patterns, transforms, clip, compositing, filters once implemented, drawImage scaling) rendered by the runtime
in Node (fake natives where needed) and on device, compared against Chrome-rendered goldens with a
per-case tolerance (anti-aliasing differences allowed: ≤ 2 % pixels differing by more than 16/255).
*Check:* the suite runs in CI headlessly.

**C2D-12 (MUST).** Canvas 2D cost: rasterising is CPU work off the XR frame's critical path where
possible; a 512×128 label with 20 characters draws in under 2 ms on Quest 3, and steady-state drawing
allocates no JS objects per call beyond what the spec returns (`getImageData`, `measureText`).
*Check:* micro-benchmark on device.

**C2D-13 (MUST).** Unimplemented 2D methods throw a `TypeError` that names the method and says the
runtime lacks it, rather than being silently absent or no-ops (no silent blank output).
*Check:* call a deliberately unimplemented method; the message names it.
