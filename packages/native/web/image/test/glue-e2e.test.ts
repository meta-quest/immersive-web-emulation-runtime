/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// End to end over the shipped bundles: web/glue's bundle (built from its own build options) and web/image's bundle
// evaluated in a fresh V8 context (node:vm: only V8 builtins, like the runtime's isolate) over the fake natives.
// WRK-5: structuredClone of ImageData and ImageBitmap through the glue's clone registry, transfer of ImageBitmap.
// IMG-6: createImageBitmap's 'default' premultiplyAlpha premultiplies, as in Chrome.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createFakeImageNatives } from '../fake-natives.ts';
import { corners, encodePng } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', '..');
const requireFromGlue = createRequire(join(webDir, 'glue', 'package.json'));

async function bundles(): Promise<{ glue: string; image: string }> {
  type BuildResult = { outputFiles?: { text: string }[] };
  const { build } = requireFromGlue('esbuild') as { build(options: object): Promise<BuildResult> };
  const { buildOptions } = (await import(join(webDir, 'glue', 'build.mjs'))) as { buildOptions: object };
  const glue = await build({ ...buildOptions, minify: true, write: false, outfile: 'glue.min.js' } as never);
  const image = await build({
    entryPoints: [join(here, '..', 'entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'es2024',
    minify: true,
    write: false,
    outfile: 'image.min.js',
    logLevel: 'warning',
  });
  return { glue: glue.outputFiles![0]!.text, image: image.outputFiles![0]!.text };
}

test('structuredClone / transfer of ImageData and ImageBitmap through the real glue (WRK-5)', async () => {
  const { glue, image } = await bundles();
  const natives = createFakeImageNatives();
  const ctx = vm.createContext({ __iwn: { image: natives }, setTimeout, clearTimeout, console });
  vm.runInContext(glue, ctx, { filename: 'glue.min.js' });
  vm.runInContext(image, ctx, { filename: 'image.min.js' });
  (ctx as Record<string, unknown>).png = encodePng(4, 4, corners());
  const out = (await vm.runInContext(
    `(async () => {
      const r = {};
      const id = new ImageData(2, 1);
      id.data.set([1, 2, 3, 4, 5, 6, 7, 8]);
      const c = structuredClone(id);
      r.imageData = { isImageData: c instanceof ImageData, tag: Object.prototype.toString.call(c), w: c.width,
        h: c.height, data: Array.from(c.data), distinct: c.data !== id.data, colorSpace: c.colorSpace };
      const nested = structuredClone({ list: [id, id] });
      r.nestedSame = nested.list[0] === nested.list[1] && nested.list[0] instanceof ImageData;
      const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      const reg = globalThis[Symbol.for('iwn.image')];
      r.defaultAlphaPremultiplied = reg.bitmapHandle(bmp).premultiplied;
      const cb = structuredClone(bmp);
      r.cloneBitmap = { isImageBitmap: cb instanceof ImageBitmap, w: cb.width, sourceStillOpen: bmp.width === 4 };
      cb.close();
      r.afterCloneClosed = bmp.width;
      const t = structuredClone(bmp, { transfer: [bmp] });
      r.transfer = { isImageBitmap: t instanceof ImageBitmap, w: t.width, sourceDetached: bmp.width === 0 };
      try { structuredClone(bmp); r.detachedClone = 'no error'; } catch (e) { r.detachedClone = e.name; }
      try { structuredClone(t, { transfer: [t, t] }); r.dupTransfer = 'no error'; } catch (e) { r.dupTransfer = e.name; }
      return JSON.stringify(r);
    })()`,
    ctx,
  )) as string;
  const r = JSON.parse(out);
  assert.deepEqual(r.imageData, {
    isImageData: true,
    tag: '[object ImageData]',
    w: 2,
    h: 1,
    data: [1, 2, 3, 4, 5, 6, 7, 8],
    distinct: true,
    colorSpace: 'srgb',
  });
  assert.equal(r.nestedSame, true);
  assert.equal(r.defaultAlphaPremultiplied, true);
  assert.deepEqual(r.cloneBitmap, { isImageBitmap: true, w: 4, sourceStillOpen: true });
  assert.equal(r.afterCloneClosed, 4);
  assert.deepEqual(r.transfer, { isImageBitmap: true, w: 4, sourceDetached: true });
  assert.equal(r.detachedClone, 'DataCloneError');
  assert.equal(r.dupTransfer, 'DataCloneError');
});
