// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// SQLite backend for IndexedDB (indexeddbshim over a WebSQL-style driver)
// and the Cache API. One connection per database file, each owned by its
// own serial worker thread so SQL never runs on the JS thread. Databases
// are opened in WAL mode with synchronous=FULL: a committed transaction
// survives an app crash and power loss.
//
// The batch contract matches websql-configurable's driver interface
// (`exec(queries, readOnly, cb)`): statements run in order, each gets its
// own result or error, a read-only batch refuses statements that would
// write ("could not prepare statement (23 not authorized)"). An atomic
// batch (the Cache API's mutations) runs as one transaction that is rolled
// back as a whole when any statement fails.

#ifndef IWN_STORAGE_SQL_DATABASE_H_
#define IWN_STORAGE_SQL_DATABASE_H_

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <variant>
#include <vector>

struct sqlite3;

namespace iwn::storage {

using SqlValue = std::variant<std::monostate, int64_t, double, std::string, std::vector<uint8_t>>;

struct SqlStatement {
  std::string sql;
  std::vector<SqlValue> args;
};

struct SqlResult {
  std::string error;          // empty on success
  int64_t insert_id = 0;
  int64_t rows_affected = 0;
  bool has_rows = false;      // a statement that returns rows (SELECT, PRAGMA ...)
  std::vector<std::string> columns;
  std::vector<std::vector<SqlValue>> rows;
};

class SqlDatabase {
 public:
  // Opens or creates `path`. Returns null and sets *error on failure.
  static std::unique_ptr<SqlDatabase> Open(const std::string& path, std::string* error);
  ~SqlDatabase();
  std::vector<SqlResult> ExecBatch(const std::vector<SqlStatement>& batch, bool read_only);
  // All-or-nothing: BEGIN IMMEDIATE, the statements, COMMIT. The first
  // failing statement rolls everything back; it keeps its error and the
  // statements after it report "not executed: transaction rolled back".
  // (A plain batch with BEGIN/END would commit the statements that ran
  // before a failure.)
  std::vector<SqlResult> ExecAtomic(const std::vector<SqlStatement>& batch);
  bool in_transaction() const;

 private:
  explicit SqlDatabase(sqlite3* db) : db_(db) {}
  SqlResult ExecOne(const SqlStatement& st, bool read_only);
  sqlite3* db_;
};

// Validates a database file name: no path separators, no "..", no NUL,
// 1..255 bytes. The service resolves names inside its base directory only.
bool IsSafeDatabaseName(const std::string& name);

// Owns the connections of one runtime. Thread-safe; completions run on the
// connection's worker thread (the V8 binding posts them to the JS thread).
class SqlService {
 public:
  explicit SqlService(std::string base_dir);
  ~SqlService();  // drains and closes everything

  using ExecCallback = std::function<void(std::vector<SqlResult>)>;
  using DoneCallback = std::function<void(std::string error)>;

  // Opens `name` (relative to base_dir) and returns a handle > 0, or 0 and
  // *error. Opening happens on the worker; this call only validates.
  int Open(const std::string& name, std::string* error);
  void Exec(int handle, std::vector<SqlStatement> batch, bool read_only, ExecCallback cb, bool atomic = false);
  void Close(int handle, DoneCallback cb);
  // Deletes the file (+ -wal/-shm). Fails if a connection to it is open.
  void Delete(const std::string& name, DoneCallback cb);
  const std::string& base_dir() const { return base_dir_; }
  uint64_t UsageBytes() const;

 private:
  struct Worker;
  std::string base_dir_;
  mutable std::mutex mu_;
  int next_handle_ = 1;
  std::map<int, std::shared_ptr<Worker>> workers_;
};

}  // namespace iwn::storage

#endif  // IWN_STORAGE_SQL_DATABASE_H_
