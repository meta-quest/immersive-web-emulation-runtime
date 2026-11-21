# web/image

The JS half of the image stream: `HTMLImageElement` / `Image()`, `ImageData`, `ImageBitmap`, `createImageBitmap`
over the native image module (`globalThis.__iwn.image`). Design, checks and the interop contract with WebGL,
Canvas 2D, workers and the DOM stand-ins: [`../../runtime/image/README.md`](../../runtime/image/README.md) and
[`../../runtime/image/INTEROP.md`](../../runtime/image/INTEROP.md).

```bash
# from packages/native, Node 24
node --test --test-concurrency=8 web/image/test/*.test.ts
node_modules/.bin/tsc -p web/image
node web/image/build.mjs      # dist/image.js + dist/image.min.js (esbuild from web/glue's devDependencies)
```

`fake-natives.ts` implements the native contract in TypeScript (PNG via `node:zlib`, the pipeline without the
`medium`/`high` resize filters and without EXIF) for these tests and for the headless runner.
