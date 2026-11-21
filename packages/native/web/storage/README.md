# web/storage: Web Storage, navigator.storage, IndexedDB, Cache API

Over `globalThis.__iwn.storage` (runtime/storage). Two IIFE preludes:

| prelude | size (min / gzip) | installs | shipped |
|---|---|---|---|
| `dist/storage.min.js` | 4.3 KB / 1.7 KB | `localStorage`, `sessionStorage`, `Storage`, `navigator.storage.estimate` | always (window only) |
| `dist/idb.min.js` | 164 KB / 50 KB | `indexedDB` + `IDB*` classes (IndexedDBShim over native SQLite), `caches`/`CacheStorage`/`Cache`, `navigator.storage.{persist,persisted}` | **not shipped in the alpha** (IndexedDB persistence and the Cache API are out of the 2026-10-23 scope; NET-STORE-3 keeps them absent by default, so `typeof indexedDB === 'undefined'`); experimental opt-in, needs the net prelude for the Cache API |

```
npm ci --ignore-scripts   # --ignore-scripts: skips indexeddbshim's unused native `canvas` dep
npm run verify     # typecheck + build + 24 tests
```

Tests run against fake natives over `node:sqlite` with the same contract (`test/fake-natives.ts`); the native side
has its own host tests (runtime/storage). IndexedDB persistence and crash durability are checked across separate
Node processes (`test/idb-child.ts`); the bundles run in a bare `vm` context after the glue and net preludes.

## Behaviour

- `localStorage` (NET-STORE-1/2): reads from a JS map, every mutation mirrored to the native log (coalesced,
  ≤ 250 ms, off the main thread, flushed when the page is hidden and durable at exit). Quota 5 Mi UTF-16 code units
  of keys + values per area → `QuotaExceededError`. Named properties per WebIDL (prototype members win on get, any
  string key sets an item). No `storage` events (one document). The file is read on a native background thread
  when the module registers; a reload in the same process sees the current contents.
- `sessionStorage`: same object model, memory only.
- `navigator.storage`: `estimate()` returns native usage of `<files>/iwn` and the quota (512 MB or free space,
  smaller wins). Replaces the glue's placeholder `estimate()`. `persist()`/`persisted()` are absent (NET-STORE-3);
  the opt-in idb prelude adds them (resolving `true`: app-private storage is not evicted).
- IndexedDB: IndexedDBShim 19.0.7 with websql-configurable's WebSQL semantics over our driver; every database is a
  SQLite file, committed transactions durable (WAL + FULL), uncommitted ones roll back. One local fix for an upstream
  race (abort before the WebSQL transaction starts left it open; `src/indexeddb.ts`).
- Cache API: one SQLite database, every mutation one atomic transaction (rolled back entirely on any failure); `put`
  and `keys` never read stored bodies, `match` reads only the bodies it returns; query-cache matching with `ignoreSearch`,
  `ignoreMethod`, `ignoreVary` and `Vary`; `add`/`addAll` fetch through the runtime and store nothing if any request
  fails; responses are restored exactly (type, status incl. 0, url, redirected, headers).

## Open decision

Spec NET-STORE-3 says `indexedDB` and `caches` are absent unless a sample needs them; the module also implements
them. Both exist, in the opt-in `idb.min.js`. Suggested switch: a `native.storage` section in `iwsdk.config.json`
(`{"indexedDB": true}`) that makes the packer add the prelude.
