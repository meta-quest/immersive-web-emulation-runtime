// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Public entry points of the storage module for the runtime core.
//
//   1. once per process:  iwn_storage_configure({data_dir = Context.getFilesDir()})
//   2. per isolate/context:  iwn::BindLoopHooks(isolate, &hooks);
//      iwn_register_storage(isolate, context, natives)  → globalThis.__iwn.storage
//   3. on pause and before exit:  iwn_storage_flush_all()  (blocks until durable;
//      NET-STORE-2, PROC exit order)
//   4. before disposing an isolate:  iwn_storage_dispose_isolate(isolate)
//
// Files under data_dir/iwn/: local-storage.kv (localStorage), idb/ (IndexedDB
// databases, one SQLite file each + __sysdb__), cache/ (Cache API).

#ifndef IWN_STORAGE_MODULE_H_
#define IWN_STORAGE_MODULE_H_

#include <cstdint>
#include <string>

namespace v8 {
class Isolate;
class Context;
class Object;
template <class T>
class Local;
}  // namespace v8

struct IwnStorageOptions {
  std::string data_dir;                       // app-private, survives restarts
  uint64_t quota_bytes = 512ull * 1024 * 1024;  // reported by estimate(); IDB/Cache cap
};

void iwn_storage_configure(const IwnStorageOptions& options);
void iwn_register_storage(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);
void iwn_storage_flush_all();
void iwn_storage_dispose_isolate(v8::Isolate* isolate);

#endif  // IWN_STORAGE_MODULE_H_
