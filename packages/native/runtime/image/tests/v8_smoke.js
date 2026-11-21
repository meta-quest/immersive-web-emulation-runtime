/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Device smoke test of globalThis.__iwn.image (run by tests/v8_smoke.cc). `testData` holds ArrayBuffers built by the
// harness; `print` logs; the harness pumps tasks until globalThis.__result is set.
'use strict';
const img = globalThis.__iwn.image;
const failures = [];
function check(cond, what) {
  if (!cond) failures.push(what);
  print((cond ? 'ok   ' : 'FAIL ') + what);
}
function px(arr, w, x, y) {
  const i = (y * w + x) * 4;
  return [arr[i], arr[i + 1], arr[i + 2], arr[i + 3]];
}
async function expectReject(p, what) {
  try {
    await p;
    check(false, what + ' rejects');
  } catch (e) {
    check(typeof e.code === 'string', what + ' rejects with code ' + e.code);
  }
}

async function main() {
  const d = globalThis.testData;
  print('mode: ' + (img.needsPolling ? 'polling' : 'push'));

  // PNG corners: straight alpha by default (premultiplyAlpha 'default' / 'none').
  const h = await img.decode(d.png, {
    applyExif: true,
    flipY: false,
    alpha: 0,
  });
  check(h.width === 4 && h.height === 4, 'png 4x4');
  let p = img.readPixels(h, false);
  check(
    p instanceof Uint8ClampedArray && p.length === 64,
    'readPixels returns 64 bytes',
  );
  check(
    px(p, 4, 0, 0).join() === '255,0,0,128',
    'png top-left straight red a=128: ' + px(p, 4, 0, 0),
  );
  check(!h.premultiplied, 'png handle reports straight alpha');

  const pre = await img.decode(d.png, { alpha: 1 });
  check(pre.premultiplied, 'premultiply on request');
  check(
    px(img.readPixels(pre, true), 4, 0, 0).join() === '128,0,0,128',
    'premultiplied red: ' + px(img.readPixels(pre, true), 4, 0, 0),
  );

  const flipped = await img.decode(d.png, { flipY: true });
  check(
    px(img.readPixels(flipped, false), 4, 0, 0).join() === '0,0,255,128',
    'flipY puts blue on top',
  );

  // JPEG with EXIF orientation 6 (6x4 stored): from-image -> 4x6, none -> 6x4.
  const oriented = await img.decode(d.jpegExif6, { applyExif: true });
  check(
    oriented.width === 4 && oriented.height === 6,
    'jpeg exif 6 applied: ' + oriented.width + 'x' + oriented.height,
  );
  const raw = await img.decode(d.jpegExif6, { applyExif: false });
  check(
    raw.width === 6 && raw.height === 4,
    'jpeg exif ignored for none: ' + raw.width + 'x' + raw.height,
  );
  const op = img.readPixels(oriented, false);
  const rp = img.readPixels(raw, false);
  // Rotate 90 CW: displayed top-left = stored bottom-left.
  const a = px(op, 4, 0, 0),
    b = px(rp, 6, 0, 3);
  check(
    Math.abs(a[0] - b[0]) < 8 && Math.abs(a[1] - b[1]) < 8,
    'jpeg exif 6 pixel mapping ' + a + ' vs ' + b,
  );

  const webp = await img.decode(d.webpLossless, {});
  check(
    webp.width === 4 &&
      px(img.readPixels(webp, false), 4, 3, 3).join() === '255,255,0,128',
    'webp lossless alpha exact: ' + px(img.readPixels(webp, false), 4, 3, 3),
  );
  const webpLossy = await img.decode(d.webpLossy, {});
  check(
    webpLossy.width === 16 && webpLossy.height === 16,
    'webp lossy decodes',
  );

  const gif = await img.decode(d.gif, {});
  check(gif.width === 3 && gif.height === 2, 'gif first frame');

  for (const [name, bytes] of [
    ['abc_color_irot_alpha_NOirot.avif', d.avif],
    ['kodim03_yuv420_8bpc.avif', d.avif2],
    ['colors_sdr_srgb.avif', d.avif3],
  ]) {
    if (!bytes) continue;
    try {
      const av = await img.decode(bytes, {});
      print('info ' + name + ' decodes: ' + av.width + 'x' + av.height);
    } catch (e) {
      print(
        'info ' +
          name +
          ' not decodable on this OS: ' +
          e.code +
          ' (' +
          e.message +
          ')',
      );
    }
  }
  if (d.heic) {
    try {
      const he = await img.decode(d.heic, {});
      print('info heic decodes: ' + he.width + 'x' + he.height);
    } catch (e) {
      print('info heic not decodable on this OS: ' + e.code);
    }
  }

  await expectReject(img.decode(d.corrupt, {}), 'garbage');
  await expectReject(img.decode(d.truncatedPng, {}), 'truncated png');
  try {
    await img.decode(d.hugePng, {});
    check(false, 'png above 16384 px rejects');
  } catch (e) {
    check(
      e.code === 'too-large',
      'png above 16384 px rejects with too-large: ' + e.code,
    );
  }

  // fromPixels snapshots: later writes don't show.
  const pixels = new Uint8ClampedArray([
    10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 255,
  ]);
  const fp = img.fromPixels(pixels, 2, 2, false, { flipY: true });
  pixels[0] = 0;
  const fh = await fp;
  check(
    px(img.readPixels(fh, false), 2, 0, 1).join() === '10,20,30,40',
    'fromPixels snapshot + flip',
  );

  const cropped = await img.transform(h, {
    crop: [-1, -1, 3, 3],
    resizeWidth: 6,
    resizeHeight: 6,
    quality: 0,
  });
  check(cropped.width === 6 && cropped.height === 6, 'transform crop+resize');
  check(
    px(img.readPixels(cropped, false), 6, 0, 0)[3] === 0,
    'outside source rect is transparent',
  );
  check(
    px(img.readPixels(cropped, false), 6, 2, 2).join() === '255,0,0,128',
    'crop keeps source pixel',
  );

  const shared = img.share(h);
  img.close(h);
  check(h.width === 0 && h.height === 0, 'close zeroes size');
  check(
    shared.width === 4 && px(img.readPixels(shared, false), 4, 0, 0)[0] === 255,
    'shared handle survives close',
  );
  let threw = false;
  try {
    img.readPixels(h, false);
  } catch (e) {
    threw = true;
  }
  check(threw, 'readPixels on closed handle throws');

  const id = img.exportTransfer(webp);
  check(webp.width === 0, 'exportTransfer detaches');
  const back = img.importTransfer(id);
  check(back && back.width === 4, 'importTransfer restores');
  check(img.importTransfer(id) === null, 'transfer id is single-use');
  // Ids that are not positive integers below 2^53 are rejected before any double-to-integer conversion.
  const badIds = [NaN, -1, 0, 1.5, 2 ** 53, 2 ** 64, Infinity, -Infinity];
  check(
    badIds.every((v) => img.importTransfer(v) === null),
    'importTransfer rejects non-integer / out-of-range ids',
  );
  badIds.forEach((v) => img.discardTransfer(v));
  check(true, 'discardTransfer ignores non-integer / out-of-range ids');

  // fromPixels size arithmetic: 2^31 x 2^31 x 4 wraps to 0 in 64-bit, so an empty buffer once passed the size check
  // and the row copy ran out of bounds. Now rejected (sides 1..32768, at most 2^28 pixels) before anything is read.
  const throwsType = (fn) => {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof TypeError;
    }
  };
  check(
    throwsType(() =>
      img.fromPixels(new Uint8Array(0), 2 ** 31, 2 ** 31, false, {}),
    ),
    'fromPixels 2^31 x 2^31 rejected',
  );
  check(
    throwsType(() =>
      img.fromPixels(new Uint8Array(0), 0x40000000, 4, false, {}),
    ),
    'fromPixels 2^30 x 4 (wraps) rejected',
  );
  check(
    throwsType(() =>
      img.fromPixels(new Uint8Array(32769 * 4), 32769, 1, false, {}),
    ),
    'fromPixels 32769 wide rejected',
  );
  check(
    throwsType(() => img.fromPixels(new Uint8Array(15), 2, 2, false, {})),
    'fromPixels short buffer rejected',
  );

  // Many concurrent decodes.
  const many = [];
  for (let i = 0; i < 40; i++)
    many.push(img.decode(i % 2 ? d.png : d.webpLossy, { flipY: i % 3 === 0 }));
  const all = await Promise.all(many);
  check(
    all.every((x) => x.width > 0),
    '40 concurrent decodes',
  );

  // IMG-7: 500 dropped 1024x1024 handles (4 MB each, never closed) are collected because their pixels are reported
  // to V8 as external memory. RSS must come back within 50 MB of the baseline after a GC.
  if (typeof gc === 'function' && typeof rss === 'function') {
    gc();
    const base = rss();
    let peak = base;
    const src = new Uint8ClampedArray(1024 * 1024 * 4);
    const t0 = Date.now();
    for (let i = 0; i < 500; i++) {
      await img.fromPixels(src, 1024, 1024, false, {});
      if (i % 50 === 0) peak = Math.max(peak, rss());
    }
    const elapsed = Date.now() - t0;
    gc();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    gc();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const after = rss();
    print(
      `info IMG-7: rss base ${base.toFixed(1)} MB, peak ${peak.toFixed(1)} MB, after GC ${after.toFixed(1)} MB, ` +
        `500 x 4 MB in ${elapsed} ms, live handle bytes ${img.stats().bytes}`,
    );
    check(
      after - base < 50,
      'IMG-7: RSS back within 50 MB of baseline after dropping 500 1024^2 bitmaps',
    );
    check(
      peak - base < 1024,
      'IMG-7: external memory pressure keeps the peak under 1 GB above baseline',
    );
  }

  // Contract version 2: data: URL base64 decoded on the pool; cancel().
  check(img.version === 2, 'contract version 2');
  let b64 = '';
  {
    const bytes = new Uint8Array(d.png);
    const abc =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < bytes.length; i += 3) {
      const n =
        (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      b64 +=
        abc[(n >> 18) & 63] +
        abc[(n >> 12) & 63] +
        (i + 1 < bytes.length ? abc[(n >> 6) & 63] : '=') +
        (i + 2 < bytes.length ? abc[n & 63] : '=');
    }
  }
  const fromB64 = await img.decodeBase64(
    ' ' + b64.slice(0, 10) + '\n' + b64.slice(10),
    {},
  );
  check(
    fromB64.width === 4 &&
      px(img.readPixels(fromB64, false), 4, 0, 0).join() === '255,0,0,128',
    'decodeBase64 (forgiving whitespace)',
  );
  img.close(fromB64);
  await expectReject(img.decodeBase64('@@@@', {}), 'invalid base64');
  const twoByte = await img.decodeBase64(('\u20ac' + b64).slice(1), {}); // a two-byte string representation
  check(twoByte.width === 4, 'decodeBase64 of a two-byte string');
  img.close(twoByte);
  const victims = [];
  for (let i = 0; i < 6; i++)
    victims.push(
      img.fromPixels(
        new Uint8ClampedArray(1024 * 1024 * 4),
        1024,
        1024,
        false,
        { resizeWidth: 700, resizeHeight: 700, quality: 3 },
      ),
    );
  const last = victims[victims.length - 1];
  check(img.cancel(last) === true, 'cancel() of a pending job returns true');
  check(img.cancel(last) === false, 'cancel() twice returns false');
  try {
    await last;
    check(false, 'cancelled promise rejects');
  } catch (e) {
    check(
      e.code === 'cancelled',
      'cancelled promise rejects with code cancelled',
    );
  }
  for (const v of await Promise.all(victims.slice(0, -1))) img.close(v);

  // A page that defines throwing setters on Object.prototype must not crash the module (handles, errors, stats).
  for (const k of [
    'width',
    'height',
    'premultiplied',
    'opaque',
    'code',
    'pending',
    'mode',
  ]) {
    Object.defineProperty(Object.prototype, k, {
      set() {
        throw new Error('page setter ' + k);
      },
      configurable: true,
    });
  }
  const hostile = await img.decode(d.png, {});
  check(
    hostile.width === 4,
    'handles survive throwing Object.prototype setters',
  );
  await expectReject(
    img.decode(d.corrupt, {}),
    'errors survive throwing Object.prototype setters',
  );
  check(
    typeof img.stats().pending === 'number',
    'stats survive throwing Object.prototype setters',
  );
  img.close(hostile);
  check(
    hostile.width === 0,
    'close survives throwing Object.prototype setters',
  );
  for (const k of [
    'width',
    'height',
    'premultiplied',
    'opaque',
    'code',
    'pending',
    'mode',
  ])
    delete Object.prototype[k];

  // Options are read as own data properties only: getters (own or inherited) never run inside a native, so page JS
  // cannot close a handle or shrink a buffer between a native's checks and their use.
  {
    const victim = await img.decode(d.png, {});
    let ran = 0;
    const getterOpts = {
      get crop() {
        ran++;
        img.close(victim);
        return undefined;
      },
      flipY: true,
    };
    const t1 = await img.transform(victim, getterOpts);
    check(
      ran === 0 && victim.width === 4 && t1.width === 4,
      'transform: own getter in options never runs',
    );
    Object.defineProperty(Object.prototype, 'crop', {
      get() {
        ran++;
        img.close(victim);
        return undefined;
      },
      configurable: true,
    });
    const t2 = await img.transform(victim, { flipY: true });
    check(
      ran === 0 && victim.width === 4 && t2.width === 4,
      'transform: Object.prototype getter never runs',
    );
    delete Object.prototype.crop;
    let proxyTrap = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          proxyTrap++;
          img.close(victim);
        },
        getOwnPropertyDescriptor() {
          proxyTrap++;
        },
      },
    );
    check(
      throwsType(() => img.transform(victim, proxy)) &&
        proxyTrap === 0 &&
        victim.width === 4,
      'transform: proxy options rejected without running traps',
    );
    const rab = new ArrayBuffer(64, { maxByteLength: 128 });
    new Uint8Array(rab).fill(200);
    const shrink = {
      get resizeWidth() {
        ran++;
        rab.resize(0);
        return 2;
      },
    };
    const fp = await img.fromPixels(new Uint8Array(rab), 4, 4, false, shrink);
    check(
      ran === 0 && fp.width === 4 && rab.byteLength === 64,
      'fromPixels: getter that would shrink the buffer never runs',
    );
    const enc = new ArrayBuffer(d.png.byteLength, {
      maxByteLength: d.png.byteLength * 2,
    });
    new Uint8Array(enc).set(new Uint8Array(d.png));
    const dec = await img.decode(new Uint8Array(enc), {
      get flipY() {
        ran++;
        enc.resize(0);
        return true;
      },
    });
    check(
      ran === 0 && dec.width === 4,
      'decode: getter that would shrink the buffer never runs',
    );
    const arrGetter = [0, 0, 2, 2];
    Object.defineProperty(arrGetter, 1, {
      get() {
        ran++;
        return 0;
      },
    });
    check(
      throwsType(() => img.transform(victim, { crop: arrGetter })) && ran === 0,
      'transform: accessor in crop rejected',
    );
    img.close(victim);
  }

  const s = img.stats();
  print('stats ' + JSON.stringify(s));
  check(
    s.backends[0] === 'AImageDecoder',
    'AImageDecoder is the first backend',
  );
  check(s.pending === 0, 'no pending promises');
  check(s.bytes < 4 * 1024 * 1024, 'dropped handles were finalized');
}

main().then(
  () => {
    globalThis.__result = failures.length ? 'FAIL ' + failures.length : 'PASS';
  },
  (e) => {
    print('exception ' + e + '\n' + e.stack);
    globalThis.__result = 'FAIL exception';
  },
);
