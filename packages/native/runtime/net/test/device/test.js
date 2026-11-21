/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Device checks for the net and storage modules, run by devtest_main.cc after the preludes.
// Host side (adb reverse): http :18080, self-signed https :18443, ws :18081 (host-servers.mjs).
(async () => {
  const results = {};
  const check = async (name, fn) => {
    const t0 = Date.now();
    try {
      results[name] = { ok: true, value: await fn(), ms: Date.now() - t0 };
    } catch (e) {
      results[name] = {
        ok: false,
        error: String((e && e.stack) || e),
        cause: e && e.cause,
        ms: Date.now() - t0,
      };
    }
  };
  const timeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('timeout ' + ms)), ms),
      ),
    ]);
  const hex = (buf) =>
    Array.from(new Uint8Array(buf), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  // SHA-256 (FIPS 180-4) in plain JS: crypto.subtle is opt-in in the glue (NET-STORE-4).
  const sha256 = (buf) => {
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const src = new Uint8Array(buf);
    const n = src.length;
    const total = Math.ceil((n + 9) / 64) * 64;
    const m = new Uint8Array(total);
    m.set(src);
    m[n] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor((n * 8) / 2 ** 32));
    dv.setUint32(total - 4, (n * 8) >>> 0);
    const H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    const W = new Uint32Array(64);
    const r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + 4 * i);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15],
          b = W[i - 2];
        W[i] =
          W[i - 16] +
          (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) +
          W[i - 7] +
          (r(b, 17) ^ r(b, 19) ^ (b >>> 10));
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 =
          (h +
            (r(e, 6) ^ r(e, 11) ^ r(e, 25)) +
            ((e & f) ^ (~e & g)) +
            K[i] +
            W[i]) >>>
          0;
        const t2 =
          ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>>
          0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      H[0] += a;
      H[1] += b;
      H[2] += c;
      H[3] += d;
      H[4] += e;
      H[5] += f;
      H[6] += g;
      H[7] += h;
    }
    const out = new DataView(new ArrayBuffer(32));
    H.forEach((v, i) => out.setUint32(4 * i, v));
    return out.buffer;
  };

  await check('globals', () =>
    [
      'fetch',
      'Headers',
      'Request',
      'Response',
      'WebSocket',
      'XMLHttpRequest',
      'ReadableStream',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'caches',
    ].map((n) => n + ':' + typeof globalThis[n]),
  );
  // NET-1/2/3/4: assets from the APK (uncompressed .glb is mapped from the APK).
  await check('asset_small', async () => {
    const r = await fetch('/_app/x.js');
    return [r.status, r.headers.get('content-type'), await r.text()];
  });
  await check('asset_unicode_and_dot', async () => [
    await (await fetch('/%C3%BC.txt')).text(),
    await (await fetch('/.well-known/y.json')).text(),
  ]);
  await check('asset_big_sha256', async () => {
    const t0 = Date.now();
    const r = await fetch('/assets/big.glb');
    const ab = await r.arrayBuffer();
    const fetchMs = Date.now() - t0;
    const digest = hex(sha256(ab));
    return {
      bytes: ab.byteLength,
      sha256: digest,
      type: r.headers.get('content-type'),
      fetchMs,
    };
  });
  await check('asset_404', async () => [
    (await fetch('/missing.js')).status,
    (await fetch('/assets/%2e%2e/%2e%2e/x')).status,
  ]);
  // NET-5/6: network through the platform TLS stack.
  await check('https_public', () =>
    timeout(
      (async () => {
        const r = await fetch('https://www.google.com/generate_204');
        return [r.status, r.url, r.type];
      })(),
      20000,
    ),
  );
  await check('https_cdn_jsdelivr', () =>
    timeout(
      (async () => {
        const r = await fetch(
          'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/profilesList.json',
        );
        const j = await r.json();
        return [
          r.status,
          Object.keys(j).length > 5,
          r.headers.get('content-type'),
        ];
      })(),
      20000,
    ),
  );
  await check('https_self_signed_rejected', async () => {
    try {
      await timeout(fetch('https://localhost:18443/'), 15000);
      return 'UNEXPECTED: request succeeded';
    } catch (e) {
      return [
        e instanceof TypeError,
        String(e.message),
        e.cause && e.cause.kind,
      ];
    }
  });
  await check('http_loopback_debug', () =>
    timeout(
      (async () => {
        const r = await fetch('http://localhost:18080/echo', {
          method: 'POST',
          body: 'device-body',
          headers: { 'X-Dev': '1' },
        });
        return [r.status, await r.text()];
      })(),
      15000,
    ),
  );
  await check('blocked_origin', async () => {
    try {
      await fetch('https://example.org/');
      return 'UNEXPECTED';
    } catch (e) {
      return [e instanceof TypeError, String(e.message)];
    }
  });
  await check('websocket_echo', () =>
    timeout(
      new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://localhost:18081/');
        ws.binaryType = 'arraybuffer';
        const got = [];
        ws.onopen = () => {
          ws.send('hello-device');
          ws.send(new Uint8Array([1, 2, 3]));
        };
        ws.onmessage = (e) => {
          got.push(
            typeof e.data === 'string' ? e.data : 'ab' + e.data.byteLength,
          );
          if (got.length === 2) ws.close(1000, 'bye');
        };
        ws.onerror = () => got.push('error');
        ws.onclose = (e) => resolve({ got, code: e.code, clean: e.wasClean });
      }),
      15000,
    ),
  );
  await check('wss_public_echo', () =>
    timeout(
      new Promise((resolve) => {
        const ws = new WebSocket('wss://echo.websocket.org/');
        const got = [];
        ws.onopen = () => ws.send('tls-hello');
        ws.onmessage = (e) => {
          got.push(String(e.data).slice(0, 40));
          if (got.includes('tls-hello')) ws.close();
        };
        ws.onerror = () => got.push('error');
        ws.onclose = (e) => resolve({ got, code: e.code, clean: e.wasClean });
      }),
      20000,
    ),
  );
  await check(
    'xhr_asset',
    () =>
      new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open('GET', '/_app/x.js');
        x.onload = () => resolve([x.status, x.responseText.length]);
        x.onerror = () => resolve('error');
        x.send();
      }),
  );
  // NET-STORE-1/2: launch counter persists across cold starts.
  await check('localStorage_counter', () => {
    const n = Number(localStorage.getItem('launches') || '0') + 1;
    localStorage.setItem('launches', String(n));
    for (let i = 0; i < 1000; i++) localStorage.setItem('bulk', String(i)); // one coalesced write
    return n;
  });
  // IndexedDB persistence: count records written by earlier launches, then add one.
  await check('indexeddb_persist', async () => {
    const req = (r) =>
      new Promise(
        (res, rej) => (
          (r.onsuccess = () => res(r.result)),
          (r.onerror = () => rej(r.error))
        ),
      );
    const open = indexedDB.open('devtest', 1);
    open.onupgradeneeded = () =>
      open.result.createObjectStore('launches', { autoIncrement: true });
    const db = await req(open);
    const before = await req(
      db.transaction('launches').objectStore('launches').count(),
    );
    const tx = db.transaction('launches', 'readwrite');
    tx.objectStore('launches').add({
      at: Date.now(),
      bytes: new Uint8Array([7, 7]),
    });
    await new Promise(
      (res, rej) => ((tx.oncomplete = res), (tx.onerror = () => rej(tx.error))),
    );
    const after = await req(
      db.transaction('launches').objectStore('launches').count(),
    );
    db.close();
    return { before, after };
  });
  await check('cache_api', async () => {
    const c = await caches.open('dev');
    const had = !!(await c.match('https://app.local/cached'));
    await c.put(
      'https://app.local/cached',
      new Response('cached-' + Date.now()),
    );
    return {
      hadFromEarlierLaunch: had,
      now: (await (await c.match('https://app.local/cached')).text()).slice(
        0,
        7,
      ),
    };
  });
  await check('storage_estimate', () => navigator.storage.estimate());

  // --- revision 2 -------------------------------------------------------------------------------
  // NET-6: a TLS handshake to a peer that never answers ends at the request timeout (8 s here).
  await check('tls_silent_peer_times_out', async () => {
    const t0 = Date.now();
    try {
      await timeout(fetch('https://localhost:28443/'), 30000);
      return 'UNEXPECTED: resolved';
    } catch (e) {
      return {
        typeError: e instanceof TypeError,
        kind: e.cause && e.cause.kind,
        ms: Date.now() - t0,
        message: String(e.message),
      };
    }
  });
  // ...and is abortable: 16 hung handshakes aborted after 300 ms all reject promptly and free their
  // slots, so a following request is served.
  await check('tls_silent_peer_abort_frees_slots', async () => {
    const t0 = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 300);
        try {
          await timeout(
            fetch('https://localhost:28443/h' + i, { signal: ac.signal }),
            20000,
          );
          return 'resolved';
        } catch (e) {
          return e.name;
        }
      }),
    );
    const abortedMs = Date.now() - t0;
    const r = await timeout(
      fetch('http://localhost:18080/after-aborts'),
      15000,
    );
    return {
      aborted: outcomes.filter((n) => n === 'AbortError').length,
      abortedMs,
      after: [r.status, (await r.text()).slice(0, 24)],
    };
  });
  await check('wss_silent_peer_close_while_connecting', () =>
    timeout(
      new Promise((resolve) => {
        const ws = new WebSocket('wss://localhost:28443/');
        const t0 = Date.now();
        const seen = [];
        ws.onerror = () => seen.push('error');
        ws.onclose = (e) =>
          resolve({ seen, code: e.code, ms: Date.now() - t0 });
        setTimeout(() => ws.close(), 300);
      }),
      15000,
    ),
  );
  // NET-11: blocking natives exist in isolates without the core page runtime (workers); this test
  // context has none, so synchronous XHR works here exactly as in a worker.
  await check('sync_xhr_worker_path', () => {
    const x = new XMLHttpRequest();
    x.open('POST', 'http://localhost:18080/sync', false);
    x.send('sync-body');
    const a = new XMLHttpRequest();
    a.open('GET', '/_app/x.js', false);
    a.send();
    return {
      post: [x.status, x.responseText],
      asset: [a.status, a.responseText.length],
      hasHttpSync: typeof __iwn.net.httpSync,
    };
  });
  // Values for the reload phase (reload.js) to find.
  await check('reload_setup', () => {
    localStorage.setItem(
      'reload_marker',
      'set-before-reload-' + results.localStorage_counter.value,
    );
    localStorage.setItem('to_remove', 'x');
    localStorage.removeItem('to_remove');
    return {
      afterReloadFromPreviousLaunch: localStorage.getItem('after_reload'),
      expected: String(results.localStorage_counter.value - 1),
    };
  });
  // An open WebSocket of the old page must be closed by the reload (checked natively: no leak).
  globalThis.__oldSocket = new WebSocket('ws://localhost:18081/');
  await new Promise((r) => {
    __oldSocket.onopen = r;
    __oldSocket.onerror = r;
    setTimeout(r, 3000);
  });
  __iwn.test.done(JSON.stringify(results));
})();
