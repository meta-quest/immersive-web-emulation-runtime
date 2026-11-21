# runtime/storage: localStorage file, SQLite for IndexedDB / Cache API

Native half of Web Storage, IndexedDB and the Cache API. JS sees it as `globalThis.__iwn.storage` (contract:
`binding/storage_binding.cc` header comment and `web/storage/src/natives.ts`). Spec: NET-STORE-1..3, PROC-7 exit
flush.

| target                                         | what                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `iwn_sqlite3`                                  | SQLite 3.53.2 amalgamation (sqlite.org, our flags)                                                                           |
| `iwn_storage_core`                             | `KvStore` (localStorage log), `SqlDatabase`/`SqlService` (one worker thread per database), fs helpers; host + Android, no V8 |
| `iwn_storage`                                  | the V8 binding, `iwn_register_storage`                                                                                       |
| `iwn_storage_core_test`, `iwn_kv_crash_helper` | host tests (incl. killing a writer process)                                                                                  |

```bash
cmake -S runtime/storage -B /tmp/st -G Ninja && ninja -C /tmp/st -j 16 && /tmp/st/iwn_storage_core_test   # 13 tests
```

## localStorage (`KvStore`)

The JS map answers every read; each mutation is mirrored to native. A writer thread coalesces them: the first
pending mutation starts a 250 ms deadline (NET-STORE-2), repeated writes of one key inside the window collapse to the
last value (a `clear()` drops everything queued before it), then the batch is appended to
`<files>/iwn/local-storage.kv` and `fdatasync`'d. The file is read on a background thread started when the module is
registered, so the first `localStorage` access does no I/O on the JS thread. The writer keeps its own replica, so compaction (temp file +
fsync + rename + directory fsync) never touches the JS thread. Records carry a CRC-32; a torn tail is truncated on
load, a corrupt header is moved to `.corrupt`, and a file that cannot be read (I/O error) is left alone (the session
runs in memory). A failed append is not reported durable: the writer truncates the partial record and retries with a
full compaction on the next flush. Strings are UTF-16 code units (lone surrogates survive).
`iwn_storage_flush_all()` blocks until durable (pause/exit; registered as a core shutdown hook automatically).
1,000 `setItem` calls cost < 20 ms on the host and produce one flush. A reload (new context in the same process)
sees the current contents, not the file's state at startup.

## SQLite (`SqlService`)

Databases live in `<files>/iwn/idb/` and `<files>/iwn/cache/`; names are relative and checked
(`IsSafeDatabaseName`). Opened `journal_mode=WAL`, `synchronous=FULL`: a committed transaction survives an app crash
and power loss. Batches follow websql-configurable's driver contract (per-statement results; a read-only batch
refuses writing statements with WebSQL's "23 not authorized"). An `atomic` batch (Cache API) runs as one transaction
that is rolled back entirely if any statement fails. Uncommitted transactions roll back on close and at
shutdown.

## Integration with the runtime core

With `iwn_core` linked the binding posts through the core `Runtime` and registers `iwn_storage_flush_all` as a
shutdown hook. Registering again for a new context of the same isolate (reload) closes the old context's SQL
connections (open transactions roll back) and drops its callbacks. Without `iwn_storage_configure()` the data directory defaults to `/data/data/<package>/files`
(package from `/proc/self/cmdline`); the shell should pass `Context.getFilesDir()` / `internalDataPath` explicitly.
See `include/iwn/storage/module.h`.
