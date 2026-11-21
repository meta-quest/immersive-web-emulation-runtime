// End-to-end check of web/image on the real native module, after web/glue/dist/glue.js and web/image/dist/image.js
// (run by tests/v8_smoke.cc on a headset). Uses the glue's Blob, URL.createObjectURL, DOMException, btoa.
'use strict';
const failures = [];
function check(cond, what) {
  if (!cond) failures.push(what);
  print((cond ? 'ok   ' : 'FAIL ') + what);
}
const registry = globalThis[Symbol.for('iwn.image')];
const pixels = (bitmapOrImage) => {
  const h = registry.bitmapHandle(bitmapOrImage) || registry.imageElementHandle(bitmapOrImage);
  return globalThis.__iwn.image.readPixels(h, false);
};
const px = (arr, w, x, y) => Array.from(arr.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
const loaded = (img) =>
  new Promise((resolve) => {
    img.onload = () => resolve('load');
    img.onerror = () => resolve('error');
  });

async function main() {
  const d = globalThis.testData;
  check(typeof createImageBitmap === 'function' && typeof Image === 'function' && typeof ImageData === 'function',
    'globals installed');
  const blob = new Blob([d.png], { type: 'image/png' });

  // three.js ImageBitmapLoader's call.
  const bm = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  check(bm instanceof ImageBitmap && bm.width === 4 && bm.height === 4, 'createImageBitmap(blob) 4x4');
  check(px(pixels(bm), 4, 0, 0).join() === '0,0,255,128', 'flipY + premultiplyAlpha none: blue straight on top');
  const pre = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
  check(registry.getImageSource(pre).premultiplied === true, 'premultiply reported to consumers');
  bm.close();
  check(bm.width === 0, 'close()');
  try {
    registry.getImageSource(bm);
    check(false, 'closed bitmap upload throws');
  } catch (e) {
    check(e instanceof DOMException && e.name === 'InvalidStateError', 'closed bitmap upload throws InvalidStateError');
  }

  // EXIF orientation through a Blob.
  const jpeg = new Blob([d.jpegExif6], { type: 'image/jpeg' });
  const oriented = await createImageBitmap(jpeg);
  const raw = await createImageBitmap(jpeg, { imageOrientation: 'none' });
  check(oriented.width === 4 && oriented.height === 6, 'from-image applies EXIF 6');
  check(raw.width === 6 && raw.height === 4, "'none' ignores EXIF");

  // Crop + resize.
  const small = await createImageBitmap(blob, 0, 0, 2, 2, { resizeWidth: 8, resizeQuality: 'pixelated' });
  check(small.width === 8 && small.height === 8, 'crop + one-sided resize');

  // ImageData source.
  const data = new ImageData(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]), 2, 1);
  const fromData = await createImageBitmap(data);
  check(px(pixels(fromData), 2, 1, 0).join() === '4,5,6,255', 'ImageData source');

  // <img> with a blob: URL, then a data: URL, then a revoked URL.
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  check(img.complete === false, 'loading image is not complete');
  check((await loaded(img)) === 'load' && img.naturalWidth === 4, 'Image + blob: URL loads');
  let b64 = '';
  for (const b of new Uint8Array(d.png)) b64 += String.fromCharCode(b);
  const img2 = new Image();
  img2.src = 'data:image/png;base64,' + btoa(b64);
  await img2.decode();
  check(img2.naturalHeight === 4 && img2.complete, 'Image + data: URL, decode()');
  const fromImg = await createImageBitmap(img2, { imageOrientation: 'flipY' });
  check(px(pixels(fromImg), 4, 0, 0).join() === '0,0,255,128', 'createImageBitmap(img, flipY)');
  URL.revokeObjectURL(url);
  const img3 = new Image();
  img3.src = url;
  check((await loaded(img3)) === 'error', 'revoked blob: URL fires error');

  // IMG-6: premultiplyAlpha 'default' premultiplies, as in Chrome.
  const def = await createImageBitmap(blob);
  check(registry.getImageSource(def).premultiplied === true, "premultiplyAlpha 'default' premultiplies");
  check(px(globalThis.__iwn.image.readPixels(registry.bitmapHandle(def), true), 4, 0, 0).join() === '128,0,0,128',
    'default: stored premultiplied red');

  // WRK-5: structuredClone through the glue's clone registry.
  const idc = structuredClone(data);
  check(idc instanceof ImageData && idc.width === 2 && idc.data[4] === 4 && idc.data !== data.data, 'structuredClone(ImageData)');
  const bc = structuredClone(def);
  check(bc instanceof ImageBitmap && bc.width === 4 && def.width === 4, 'structuredClone(ImageBitmap) shares pixels');
  const moved = structuredClone(def, { transfer: [def] });
  check(moved instanceof ImageBitmap && moved.width === 4 && def.width === 0, 'transfer detaches the source');

  // The previous image stays current while a new src loads.
  img2.src = 'data:image/png;base64,' + btoa(b64);
  check(img2.naturalWidth === 4 && img2.complete === false, 'previous image stays current while the new src loads');
  check((await loaded(img2)) === 'load', 'reload of the same data: URL');

  try {
    await createImageBitmap(new Blob([d.corrupt]));
    check(false, 'corrupt blob rejects');
  } catch (e) {
    check(e instanceof DOMException && e.name === 'InvalidStateError', 'corrupt blob rejects with InvalidStateError');
  }
  const s = globalThis.__iwn.image.stats();
  print('stats ' + JSON.stringify(s));
  check(s.pending === 0, 'nothing pending');
}

main().then(
  () => { globalThis.__result = failures.length ? 'FAIL ' + failures.length : 'PASS'; },
  (e) => { print('exception ' + e + '\n' + (e && e.stack)); globalThis.__result = 'FAIL exception'; });
