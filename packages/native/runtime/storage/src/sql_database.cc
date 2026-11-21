// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/storage/sql_database.h"

#include <unistd.h>

#include "iwn/storage/fs_util.h"
#include "sqlite3.h"

namespace iwn::storage {

bool IsSafeDatabaseName(const std::string& name) {
  if (name.empty() || name.size() > 255) return false;
  if (name == "." || name == ".." || name.rfind("..", 0) == 0) return false;
  for (char c : name) {
    if (c == '/' || c == '\\' || c == '\0') return false;
  }
  return true;
}

std::unique_ptr<SqlDatabase> SqlDatabase::Open(const std::string& path, std::string* error) {
  sqlite3* db = nullptr;
  int rc = sqlite3_open_v2(path.c_str(), &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, nullptr);
  if (rc != SQLITE_OK) {
    if (error) *error = db ? sqlite3_errmsg(db) : sqlite3_errstr(rc);
    sqlite3_close(db);
    return nullptr;
  }
  sqlite3_busy_timeout(db, 5000);
  // WAL + FULL: durable commits (fsync of the WAL on every commit).
  sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;", nullptr, nullptr, nullptr);
  return std::unique_ptr<SqlDatabase>(new SqlDatabase(db));
}

SqlDatabase::~SqlDatabase() { sqlite3_close_v2(db_); }

bool SqlDatabase::in_transaction() const { return !sqlite3_get_autocommit(db_); }

SqlResult SqlDatabase::ExecOne(const SqlStatement& st, bool read_only) {
  SqlResult r;
  sqlite3_stmt* stmt = nullptr;
  const char* tail = nullptr;
  int rc = sqlite3_prepare_v2(db_, st.sql.c_str(), static_cast<int>(st.sql.size()), &stmt, &tail);
  if (rc != SQLITE_OK) {
    r.error = std::string("could not prepare statement (") + std::to_string(rc) + " " + sqlite3_errmsg(db_) + ")";
    return r;
  }
  if (!stmt) return r;  // empty statement
  if (read_only && !sqlite3_stmt_readonly(stmt)) {
    sqlite3_finalize(stmt);
    r.error = "could not prepare statement (23 not authorized)";
    return r;
  }
  int params = sqlite3_bind_parameter_count(stmt);
  for (int i = 0; i < params; ++i) {
    int idx = i + 1;
    if (static_cast<size_t>(i) >= st.args.size()) {
      sqlite3_bind_null(stmt, idx);
      continue;
    }
    const SqlValue& v = st.args[i];
    if (std::holds_alternative<std::monostate>(v)) {
      sqlite3_bind_null(stmt, idx);
    } else if (auto* n = std::get_if<int64_t>(&v)) {
      sqlite3_bind_int64(stmt, idx, *n);
    } else if (auto* d = std::get_if<double>(&v)) {
      sqlite3_bind_double(stmt, idx, *d);
    } else if (auto* s = std::get_if<std::string>(&v)) {
      sqlite3_bind_text(stmt, idx, s->data(), static_cast<int>(s->size()), SQLITE_TRANSIENT);
    } else if (auto* b = std::get_if<std::vector<uint8_t>>(&v)) {
      sqlite3_bind_blob(stmt, idx, b->data(), static_cast<int>(b->size()), SQLITE_TRANSIENT);
    }
  }
  int cols = sqlite3_column_count(stmt);
  r.has_rows = cols > 0;
  for (int c = 0; c < cols; ++c) {
    const char* name = sqlite3_column_name(stmt, c);
    r.columns.emplace_back(name ? name : "");
  }
  for (;;) {
    rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
      std::vector<SqlValue> row;
      row.reserve(static_cast<size_t>(cols));
      for (int c = 0; c < cols; ++c) {
        switch (sqlite3_column_type(stmt, c)) {
          case SQLITE_INTEGER:
            row.emplace_back(static_cast<int64_t>(sqlite3_column_int64(stmt, c)));
            break;
          case SQLITE_FLOAT:
            row.emplace_back(sqlite3_column_double(stmt, c));
            break;
          case SQLITE_TEXT: {
            const unsigned char* t = sqlite3_column_text(stmt, c);
            row.emplace_back(std::string(reinterpret_cast<const char*>(t), static_cast<size_t>(sqlite3_column_bytes(stmt, c))));
            break;
          }
          case SQLITE_BLOB: {
            const uint8_t* b = static_cast<const uint8_t*>(sqlite3_column_blob(stmt, c));
            int n = sqlite3_column_bytes(stmt, c);
            row.emplace_back(std::vector<uint8_t>(b, b + n));
            break;
          }
          default:
            row.emplace_back(std::monostate{});
        }
      }
      r.rows.push_back(std::move(row));
      continue;
    }
    if (rc == SQLITE_DONE) break;
    r.error = std::string("could not execute statement (") + std::to_string(rc) + " " + sqlite3_errmsg(db_) + ")";
    r.rows.clear();
    break;
  }
  if (r.error.empty() && !r.has_rows) {
    r.rows_affected = sqlite3_changes64(db_);
    r.insert_id = sqlite3_last_insert_rowid(db_);
  }
  sqlite3_finalize(stmt);
  return r;
}

std::vector<SqlResult> SqlDatabase::ExecBatch(const std::vector<SqlStatement>& batch, bool read_only) {
  std::vector<SqlResult> out;
  out.reserve(batch.size());
  for (const SqlStatement& st : batch) out.push_back(ExecOne(st, read_only));
  return out;
}

std::vector<SqlResult> SqlDatabase::ExecAtomic(const std::vector<SqlStatement>& batch) {
  std::vector<SqlResult> out(batch.size());
  auto fail_all = [&](const std::string& why, size_t from) {
    for (size_t i = from; i < out.size(); ++i) {
      if (out[i].error.empty()) {
        out[i] = SqlResult{};
        out[i].error = why;
      }
    }
  };
  if (in_transaction()) {
    fail_all("could not start transaction: one is already open", 0);
    return out;
  }
  SqlResult begin = ExecOne({"BEGIN IMMEDIATE", {}}, false);
  if (!begin.error.empty()) {
    fail_all(begin.error, 0);
    return out;
  }
  for (size_t i = 0; i < batch.size(); ++i) {
    out[i] = ExecOne(batch[i], false);
    if (!out[i].error.empty()) {
      ExecOne({"ROLLBACK", {}}, false);
      fail_all("not executed: transaction rolled back", i + 1);
      return out;
    }
  }
  SqlResult commit = ExecOne({"COMMIT", {}}, false);
  if (!commit.error.empty()) {
    if (in_transaction()) ExecOne({"ROLLBACK", {}}, false);
    for (auto& r : out) {
      r = SqlResult{};
      r.error = "commit failed: " + commit.error;
    }
  }
  return out;
}

struct SqlService::Worker {
  std::string path;
  std::string name;
  std::mutex mu;
  std::condition_variable cv;
  std::deque<std::function<void()>> tasks;
  bool stop = false;
  std::thread thread;
  std::unique_ptr<SqlDatabase> db;
  std::string open_error;

  void Post(std::function<void()> fn) {
    {
      std::lock_guard<std::mutex> lock(mu);
      tasks.push_back(std::move(fn));
    }
    cv.notify_one();
  }
  void Run() {
    for (;;) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lock(mu);
        cv.wait(lock, [&] { return stop || !tasks.empty(); });
        if (tasks.empty()) return;
        task = std::move(tasks.front());
        tasks.pop_front();
      }
      task();
    }
  }
  void StopAndJoin() {
    {
      std::lock_guard<std::mutex> lock(mu);
      stop = true;
    }
    cv.notify_one();
    if (thread.joinable()) thread.join();
  }
};

SqlService::SqlService(std::string base_dir) : base_dir_(std::move(base_dir)) {
  sqlite3_initialize();
}

SqlService::~SqlService() {
  std::map<int, std::shared_ptr<Worker>> workers;
  {
    std::lock_guard<std::mutex> lock(mu_);
    workers.swap(workers_);
  }
  for (auto& [h, w] : workers) {
    w->Post([w] {
      // Roll back anything left open by a page that never finished.
      if (w->db && w->db->in_transaction()) w->db->ExecBatch({{"ROLLBACK;", {}}}, false);
      w->db.reset();
    });
    w->StopAndJoin();
  }
}

int SqlService::Open(const std::string& name, std::string* error) {
  if (!IsSafeDatabaseName(name)) {
    if (error) *error = "invalid database name";
    return 0;
  }
  if (!EnsureDir(base_dir_)) {
    if (error) *error = "cannot create " + base_dir_;
    return 0;
  }
  auto w = std::make_shared<Worker>();
  w->name = name;
  w->path = base_dir_ + "/" + name;
  w->thread = std::thread([w] { w->Run(); });
  w->Post([w] { w->db = SqlDatabase::Open(w->path, &w->open_error); });
  std::lock_guard<std::mutex> lock(mu_);
  int h = next_handle_++;
  workers_[h] = w;
  return h;
}

void SqlService::Exec(int handle, std::vector<SqlStatement> batch, bool read_only, ExecCallback cb, bool atomic) {
  std::shared_ptr<Worker> w;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = workers_.find(handle);
    if (it != workers_.end()) w = it->second;
  }
  if (!w) {
    std::vector<SqlResult> results(batch.size());
    for (auto& r : results) r.error = "database is closed";
    cb(std::move(results));
    return;
  }
  w->Post([w, batch = std::move(batch), read_only, atomic, cb = std::move(cb)] {
    if (!w->db) {
      std::vector<SqlResult> results(batch.size());
      for (auto& r : results) r.error = "could not open database: " + w->open_error;
      cb(std::move(results));
      return;
    }
    cb(atomic && !read_only ? w->db->ExecAtomic(batch) : w->db->ExecBatch(batch, read_only));
  });
}

void SqlService::Close(int handle, DoneCallback cb) {
  std::shared_ptr<Worker> w;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = workers_.find(handle);
    if (it != workers_.end()) {
      w = it->second;
      workers_.erase(it);
    }
  }
  if (!w) {
    cb("");
    return;
  }
  w->Post([w, cb = std::move(cb)] {
    if (w->db && w->db->in_transaction()) w->db->ExecBatch({{"ROLLBACK;", {}}}, false);
    w->db.reset();
    cb("");
    // The worker thread cannot join itself; a detached helper joins it.
    std::thread([w] { w->StopAndJoin(); }).detach();
  });
}

void SqlService::Delete(const std::string& name, DoneCallback cb) {
  if (!IsSafeDatabaseName(name)) {
    cb("invalid database name");
    return;
  }
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (auto& [h, w] : workers_) {
      if (w->name == name) {
        cb("database is open");
        return;
      }
    }
  }
  std::string path = base_dir_ + "/" + name;
  std::thread([path, cb = std::move(cb)] {
    bool missing = access(path.c_str(), F_OK) != 0;
    unlink((path + "-wal").c_str());
    unlink((path + "-shm").c_str());
    if (!missing && unlink(path.c_str()) != 0) {
      cb("cannot delete " + path);
      return;
    }
    FsyncDir(path);
    cb("");
  }).detach();
}

uint64_t SqlService::UsageBytes() const { return DirectorySize(base_dir_); }

}  // namespace iwn::storage
