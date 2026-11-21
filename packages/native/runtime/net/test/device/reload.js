/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Phase 2 of the device test: runs in a new context of the same isolate after the natives were
// registered again (location.reload() as the core implements it).
(async () => {
  const results = {};
  const check = async (name, fn) => {
    try {
      results[name] = { ok: true, value: await fn() };
    } catch (e) {
      results[name] = { ok: false, error: String((e && e.stack) || e) };
    }
  };
  // NET-STORE-1 / PROC-5: the reloaded page sees what the previous context wrote this session.
  await check('localStorage_after_reload', () => {
    const v = {
      launches: localStorage.getItem('launches'),
      marker: localStorage.getItem('reload_marker'),
      removedStaysRemoved: localStorage.getItem('to_remove') === null,
      length: localStorage.length,
    };
    localStorage.setItem('after_reload', String(localStorage.getItem('launches')));
    return v;
  });
  await check('fetch_after_reload', async () => {
    const r = await fetch('/_app/x.js');
    return [r.status, (await r.text()).length];
  });
  await check('indexeddb_after_reload', async () => {
    const req = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
    const open = indexedDB.open('devtest', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('launches', { autoIncrement: true });
    const db = await req(open);
    const tx = db.transaction('launches', 'readwrite');
    tx.objectStore('launches').add({ reload: true });
    await new Promise((res, rej) => ((tx.oncomplete = res), (tx.onerror = () => rej(tx.error))));
    const n = await req(db.transaction('launches').objectStore('launches').count());
    db.close();
    return n;
  });
  __iwn.test.done(JSON.stringify(results));
})();
