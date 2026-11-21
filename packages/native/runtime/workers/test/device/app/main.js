// Device test bundle for runtime/workers (spec 05). Logs `WORKERS PASS n/m` and keeps the results on
// globalThis.__workers for the runner (debug endpoint eval). Each case has its own timeout.
const results = [];
const state = { done: false, results, ticks: 0, baselineLive: 0, summary: '' };
globalThis.__workers = state;
const live = () => __iwn.workers.info().live;
// Terminated workers release their slot when their thread has finished tearing down: tests that count slots first
// wait for the earlier tests' workers to be gone.
const idle = () => waitFor(() => live() === state.baselineLive, 10000, 2);

function once(target, type = 'message', ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    target.addEventListener(type, (e) => {
      clearTimeout(t);
      resolve(e);
    }, { once: true });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, step = 2) {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error('condition not met in ' + ms + ' ms');
    await sleep(step);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function test(id, name, fn, ms = 30000) {
  const t0 = performance.now();
  try {
    const detail = await Promise.race([fn(), sleep(ms).then(() => { throw new Error('test timeout'); })]);
    results.push({ id, name, ok: true, ms: +(performance.now() - t0).toFixed(1), detail });
    console.log(`PASS ${id} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  } catch (e) {
    results.push({ id, name, ok: false, ms: +(performance.now() - t0).toFixed(1), error: String(e && e.stack || e) });
    console.error(`FAIL ${id} ${name}: ${e && e.stack || e}`);
  }
}

state.baselineLive = live();

await test('WRK-2', 'classic worker global scope', async () => {
  const w = new Worker('./workers/echo.js', { name: 'echo' });
  w.postMessage('report');
  const { data } = await once(w);
  w.terminate();
  assert(data.missing.length === 0, 'missing: ' + data.missing);
  assert(data.unexpected.length === 0, 'unexpected: ' + data.unexpected);
  assert(data.name === 'echo' && data.href === 'https://app.local/workers/echo.js', 'name/href ' + data.name + ' ' + data.href);
  assert(data.locTag === '[object WorkerLocation]', data.locTag);
  assert(data.nav[1] === 4 && navigator.hardwareConcurrency === 4, 'hardwareConcurrency cap (WRK-12) ' + data.nav[1]);
  assert(data.coi === true && data.sab === 'function' && data.wgs === true, 'coi/sab/wgs');
  return data.nav;
});

await test('WRK-3', 'module worker: static + dynamic import, import.meta', async () => {
  const w = new Worker('./workers/mod.js', { type: 'module' });
  const { data } = await once(w);
  w.terminate();
  assert(data.meta === 'https://app.local/workers/mod.js', 'meta ' + data.meta);
  assert(data.a === 'A' && data.b === 'B' && data.bMeta === 'https://app.local/lib/b.js', JSON.stringify(data));
  assert(data.resolved === 'https://app.local/workers/x.js', data.resolved);
  assert(data.typeofImportScripts === 'TypeError', data.typeofImportScripts);
  return data;
});

await test('WRK-1', 'data: and blob: workers (classic and module), relative fetch/importScripts in blob: worker', async () => {
  const src = `onmessage = async () => {
    let fetchErr = 'none', impErr = 'none';
    try { await fetch('lib/data.json'); } catch (e) { fetchErr = e.name; }
    try { importScripts('x.js'); } catch (e) { impErr = e.name; }
    postMessage([location.protocol, self.origin, fetchErr, impErr]);
  };`;
  const w1 = new Worker('data:text/javascript,' + encodeURIComponent(src));
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const w2 = new Worker(url);
  URL.revokeObjectURL(url);
  const murl = URL.createObjectURL(new Blob([`postMessage(import.meta.url.slice(0, 5))`], { type: 'text/javascript' }));
  const w3 = new Worker(murl, { type: 'module' });
  w1.postMessage(0);
  w2.postMessage(0);
  const [a, b, c] = await Promise.all([once(w1), once(w2), once(w3)]);
  [w1, w2, w3].forEach((w) => w.terminate());
  assert(a.data[0] === 'data:' && a.data[1] === 'null' && a.data[3] === 'SyntaxError', 'data: ' + a.data);
  assert(b.data[0] === 'blob:' && b.data[1] === 'https://app.local' && b.data[3] === 'SyntaxError', 'blob: ' + b.data);
  state.relativeFetch = [a.data[2], b.data[2]];  // checked by WRK-2-fetch (web/net resolves fetch URLs)
  assert(c.data === 'blob:', 'module blob ' + c.data);
  let sec = 'none';
  try { new Worker('https://cdn.example/w.js'); } catch (e) { sec = e.name; }
  assert(sec === 'SecurityError', sec);
  return [a.data, b.data];
});

await test('WRK-2-fetch', 'relative fetch() in data:/blob: workers rejects with TypeError (web/net)', async () => {
  assert(JSON.stringify(state.relativeFetch) === '["TypeError","TypeError"]', 'got ' + JSON.stringify(state.relativeFetch));
});

await test('WRK-4', 'importScripts: same-origin, data:, worker-made blob:, failures; import() from a classic worker', async () => {
  const w = new Worker('./workers/imp.js');
  const { data } = await once(w);
  w.terminate();
  assert(JSON.stringify(data.order) === '["lib","data","blob"]', 'order ' + data.order);
  assert(JSON.stringify(data.errs) === '["NetworkError","SyntaxError"]', 'errs ' + data.errs);
  assert(data.dynamicFromClassic === 'A', data.dynamicFromClassic);
  return data;
});

await test('WRK-5', 'structured clone across threads (round trip)', async () => {
  const w = new Worker('./workers/echo.js');
  const err = new RangeError('r', { cause: 'why' });
  const o = {
    n: -0, big: 2n ** 70n, s: 'ü€😀', b: new Boolean(false), d: new Date(1234), re: /a+/gimsuy, err,
    map: new Map([[1, { x: 1 }]]), set: new Set(['a']), u8: new Uint8Array([1, 2, 255]), f64: new Float64Array([1.5]),
    dv: new DataView(new ArrayBuffer(4)), arr: [1, , 3], blob: new Blob(['blob!'], { type: 'text/x' }),
    file: new File(['f'], 'n.txt', { lastModified: 9 }), id: new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1),
  };
  o.self = o;
  w.postMessage(o);
  const { data: r } = await once(w);
  const errs = [];
  for (const bad of [() => 1, Symbol('s'), { w }]) {
    try { w.postMessage(bad); errs.push('ok'); } catch (e) { errs.push(e.name); }
  }
  w.terminate();
  assert(r.self === r && Object.is(r.n, -0) && r.big === 2n ** 70n && r.s === o.s, 'primitives/cycle');
  assert(r.b instanceof Boolean && r.d.getTime() === 1234 && r.re.flags === 'dgimsuy'.replace('d', '') && r.re.source === 'a+', 're/date ' + r.re.flags);
  assert(r.err instanceof RangeError && r.err.message === 'r' && r.err.cause === 'why' && typeof r.err.stack === 'string', 'error');
  assert(r.map.get(1).x === 1 && r.set.has('a') && r.u8[2] === 255 && r.f64[0] === 1.5 && r.dv.byteLength === 4, 'collections');
  assert(!(1 in r.arr) && r.arr.length === 3, 'holes');
  assert(r.blob instanceof Blob && (await r.blob.text()) === 'blob!' && r.blob.type === 'text/x', 'blob');
  assert(r.file instanceof File && r.file.name === 'n.txt' && r.file.lastModified === 9, 'file');
  assert(r.id instanceof ImageData && r.id.width === 1 && r.id.data[3] === 4, 'imagedata');
  assert(errs.join() === 'DataCloneError,DataCloneError,DataCloneError', 'DataCloneError ' + errs);
  return 'ok';
});

await test('WRK-5b', 'transfer of a 64 MB ArrayBuffer: detached at the sender, < 2 ms, same memory back', async () => {
  const w = new Worker('./workers/echo.js');
  w.postMessage('warm');
  await once(w);
  const buf = new ArrayBuffer(64 << 20);
  new Uint8Array(buf)[123] = 77;
  const t0 = performance.now();
  w.postMessage({ cmd: 'echo-transfer', payload: buf }, [buf]);
  const sendMs = performance.now() - t0;
  assert(buf.byteLength === 0, 'sender not detached');
  const t1 = performance.now();
  const { data } = await once(w);
  const rtMs = performance.now() - t1;
  w.terminate();
  assert(data.byteLength === 64 << 20 && new Uint8Array(data)[123] === 77, 'payload');
  assert(sendMs < 2, 'postMessage took ' + sendMs.toFixed(2) + ' ms');
  return { sendMs: +sendMs.toFixed(3), roundTripMs: +rtMs.toFixed(2) };
});

await test('WRK-6', 'MessagePort transferred to a worker: RPC round trips, queued-before-start order', async () => {
  const w = new Worker('./workers/port.js');
  const ch = new MessageChannel();
  for (let i = 0; i < 3; i++) ch.port1.postMessage({ id: i, a: i, b: 10 });  // queued before the far end starts
  w.postMessage(null, [ch.port2]);
  await once(w);
  const got = [];
  ch.port1.onmessage = (e) => got.push(e.data);
  for (let i = 3; i < 100; i++) ch.port1.postMessage({ id: i, a: i, b: 10 });
  await waitFor(() => got.length === 100);
  w.terminate();
  assert(got.every((m, i) => m.id === i && m.sum === i + 10), 'order/sums');
  assert(ch.port2.postMessage('x') === undefined, 'transferred port is inert');
  return got.length;
});

await test('WRK-6c', 'comlink wrap/expose through a transferred port (MSDF-worker pattern)', async () => {
  const Comlink = await import('./vendor/comlink.mjs');
  const w = new Worker('./workers/comlink.js', { type: 'module', name: 'comlink' });
  const ch = new MessageChannel();
  w.postMessage(null, [ch.port2]);
  const api = Comlink.wrap(ch.port1);
  const a = await api.inc(2);
  const b = await api.inc(3);
  const atlas = await api.atlas(1 << 20);
  const viaCallback = await api.callback(Comlink.proxy((x) => x * 2));
  const counter = await api.counter;
  w.terminate();
  assert(a === 2 && b === 5 && counter === 5, `counter ${a} ${b} ${counter}`);
  assert(atlas.byteLength === 1 << 20 && atlas[123] === 7, 'transferred atlas');
  assert(viaCallback === 42, 'proxy callback ' + viaCallback);
  return { a, b, atlas: atlas.byteLength, viaCallback };
});

await test('WRK-7', 'errors: ErrorEvent with location at the Worker; load failure is a plain error event', async () => {
  const w = new Worker('./workers/thrower.js', { name: 'thrower' });
  const ev = await once(w, 'error');
  ev.preventDefault();
  w.terminate();
  assert(ev instanceof ErrorEvent && /worker failure on purpose/.test(ev.message), 'message ' + ev.message);
  assert(ev.filename === 'https://app.local/workers/thrower.js' && ev.lineno === 3 && ev.colno > 0, `location ${ev.filename}:${ev.lineno}:${ev.colno}`);
  const bad = new Worker('./workers/does-not-exist.js');
  const e2 = await once(bad, 'error');
  assert(!(e2 instanceof ErrorEvent), 'load failure must not be an ErrorEvent');
  return { msg: ev.message, line: ev.lineno, col: ev.colno };
});

await test('WRK-8', 'terminate() a worker in a JS loop and in a wasm loop within 50 ms', async () => {
  const out = {};
  for (const kind of ['js', 'wasm']) {
    await idle();
    const before = live();
    const w = new Worker('./workers/spin.js', { name: 'spin-' + kind });
    w.postMessage(kind);
    await once(w);
    await sleep(20);
    assert(live() === before + 1, 'worker not counted');
    const t0 = performance.now();
    w.terminate();
    await waitFor(() => live() === before, 2000, 0);
    out[kind] = +(performance.now() - t0).toFixed(1);
    assert(out[kind] < 50, kind + ' took ' + out[kind] + ' ms');
  }
  return out;
});

await test('WRK-8b', 'terminate at random points while 64 KB buffers fly both ways: 300 cycles, slots back to baseline', async () => {
  await idle();
  const before = live();
  let bounced = 0;
  for (let i = 0; i < 300; i++) {
    const w = new Worker('./workers/stress.js');
    w.onmessage = (e) => {
      bounced++;
      if (e.data.byteLength) w.postMessage(e.data, [e.data]);
    };
    for (let k = 0; k < 4; k++) {
      const b = new ArrayBuffer(64 << 10);
      w.postMessage(b, [b]);
    }
    // Mostly early (during boot), every 10th cycle after the bounce loop is running.
    await sleep(i % 10 === 0 ? 120 : i % 7);
    w.terminate();
  }
  await waitFor(() => live() === before, 10000, 5);
  assert(bounced > 0, 'no buffer came back');
  return { bounced, live: live() };
}, 120000);

await test('WRK-9', 'worker limit: creating one past the cap throws NotSupportedError', async () => {
  await idle();
  const info = __iwn.workers.info();
  const room = info.maxWorkers - info.live;
  const ws = [];
  for (let i = 0; i < room; i++) ws.push(new Worker('data:text/javascript,0'));
  let err = 'none';
  try { ws.push(new Worker('data:text/javascript,0')); } catch (e) { err = e.name + ': ' + e.message; }
  ws.forEach((w) => w.terminate());
  await idle();
  assert(err.startsWith('NotSupportedError'), err);
  return { max: info.maxWorkers, err };
});

await test('SAB', 'SharedArrayBuffer + Atomics: wait in a worker, notify from the page, waitAsync back', async () => {
  assert(crossOriginIsolated === true, 'crossOriginIsolated');
  const sab = new SharedArrayBuffer(16);
  const i32 = new Int32Array(sab);
  const w = new Worker('./workers/atomics.js');
  w.postMessage(sab);
  await once(w);
  let mainWait = 'none';
  try { Atomics.wait(i32, 2, 0, 1); } catch (e) { mainWait = e.name; }
  const wa = Atomics.waitAsync(i32, 1, 0, 5000);
  await sleep(10);
  Atomics.store(i32, 0, 7);
  Atomics.notify(i32, 0);
  const r = await wa.value;
  const { data } = await once(w);
  w.terminate();
  assert(r === 'ok' && Atomics.load(i32, 1) === 42, 'waitAsync ' + r);
  assert(data.waitResult === 'ok' && data.seen === 7 && data.coi === true, JSON.stringify(data));
  assert(mainWait === 'TypeError', 'Atomics.wait on the page thread must throw: ' + mainWait);
  return { waitAsync: r, worker: data };
});

await test('SIMD', 'WASM SIMD with a real library: Rapier SIMD build in a module worker vs the page', async () => {
  const w = new Worker('./workers/rapier.js', { type: 'module', name: 'rapier' });
  const { data } = await once(w, 'message', 30000);
  w.terminate();
  const RAPIER = (await import('./vendor/rapier.mjs')).default;
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.1, 10));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
  world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
  for (let i = 0; i < 240; i++) world.step();
  const y = body.translation().y;
  assert(Math.abs(data.y - 0.6) < 0.05, 'ball should rest on the ground, y=' + data.y);
  assert(data.y === y, `worker and page differ: ${data.y} vs ${y}`);
  return data;
});

await test('HAVOK', 'Havok (IWSDK physics) in a module worker', async () => {
  const w = new Worker('./workers/havok.js', { type: 'module', name: 'havok' });
  const { data } = await once(w, 'message', 30000);
  w.terminate();
  assert(data.y < 0 && data.y > -6, 'free fall for 1 s should be ~-4.9: ' + data.y);
  return data;
});

await test('THREADS', 'WASM threads with a real library: wasm-vips (pthreads, shared memory, module workers)', async () => {
  await idle();
  const before = live();
  const Vips = (await import('./vendor/vips-es6.js')).default;
  const vips = await Vips({ dynamicLibraries: [] });
  if (vips.Cache && typeof vips.Cache.max === 'function') vips.Cache.max(0);  // no libvips operation cache
  let salt = 0;
  const run = (threads) => {
    vips.concurrency(threads);
    const t0 = performance.now();
    let avg = 0;
    for (let i = 0; i < 2; i++) {
      salt += 1;
      // A fresh pipeline each time (different constant), so nothing is served from a cache.
      avg = vips.Image.black(2048, 2048).add(100 + salt * 1e-3).gaussblur(8).avg();
    }
    return { avg, ms: +(performance.now() - t0).toFixed(1) };
  };
  run(4);  // warm up (the pthread pool, the compiled code)
  const one = run(1);
  const four = run(4);
  const workers = live() - before;
  assert(Math.abs(one.avg - 100) < 0.5 && Math.abs(four.avg - 100) < 0.5, 'avg ' + one.avg + ' ' + four.avg);
  assert(workers >= 2, 'expected pthread workers, live delta ' + workers);
  assert(four.ms < one.ms * 0.8, `no parallel speedup: 1 thread ${one.ms} ms, 4 threads ${four.ms} ms`);
  globalThis.__vips = vips;  // keep the pool alive for inspection
  return { workers, oneThreadMs: one.ms, fourThreadsMs: four.ms, speedup: +(one.ms / four.ms).toFixed(2), version: vips.version() };
}, 90000);

await test('IMG', 'ImageBitmap transfer to a worker, OffscreenCanvas 2D + fetch there, bitmap back', async () => {
  const w = new Worker('./workers/bitmap.js');
  const px = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < px.length; i += 4) px.set([255, 0, 0, 255], i);
  const bmp = await createImageBitmap(new ImageData(px, 4, 4));
  w.postMessage({ bitmap: bmp }, [bmp]);
  assert(bmp.width === 0, 'sent bitmap not detached');
  const { data } = await once(w);
  w.terminate();
  assert(!data.error, data.error);
  assert(data.w === 4 && data.h === 4 && data.px[0] === 255 && data.px[1] === 0, 'pixels ' + data.px);
  assert(data.back instanceof ImageBitmap && data.back.width === 4, 'bitmap back');
  assert(data.json.hello === 'worker', 'fetch in worker');
  assert(data.imageData instanceof ImageData && data.imageData.data[1] === 255, 'ImageData back');
  state.transferToImageBitmapIsImageBitmap = data.transferToImageBitmapIsImageBitmap;
  return { px: data.px, transferToImageBitmapIsImageBitmap: data.transferToImageBitmapIsImageBitmap };
});

await test('NEST', 'nested worker', async () => {
  const w = new Worker('./workers/nested.js');
  w.postMessage('hi');
  const { data } = await once(w);
  w.terminate();
  assert(data === 'inner echoed hi', data);
  return data;
});

await test('CC-5', 'worker code cache: preludes compiled once per process', async () => {
  const s = __iwn.workers.stats();
  assert(s.codeCacheHits > 0, 'no code cache hits: ' + JSON.stringify(s));
  return s;
});

// Long-lived ticker for the pause/resume check (the runner reads __workers.ticks).
const ticker = new Worker('./workers/ticker.js', { name: 'ticker' });
ticker.onmessage = (e) => {
  state.ticks = e.data;
};
await sleep(300);

const passed = results.filter((r) => r.ok).length;
state.summary = `WORKERS ${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length}`;
state.done = true;
console.log(state.summary);
