#include "iwn/core/serial_worker.h"

#include <pthread.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <climits>
#include <system_error>

namespace iwn {

SerialWorker::SerialWorker(std::string name, int nice, size_t max_pending)
    : name_(std::move(name)), nice_(nice), max_pending_(max_pending) {}

SerialWorker::~SerialWorker() { stop(); }

bool SerialWorker::post(Job& job) {
  std::unique_lock<std::mutex> lock(mu_);
  if (stop_.load() || jobs_.size() >= max_pending_) return false;
  if (!thread_.joinable()) {
    try {
      thread_ = std::thread([this] { run(); });
    } catch (const std::system_error&) {
      return false;  // out of threads: the caller does the work itself
    }
  }
  jobs_.push_back(std::move(job));
  lock.unlock();
  cv_.notify_one();
  return true;
}

void SerialWorker::stop() {
  std::deque<Job> dropped;
  std::thread t;
  {
    std::lock_guard<std::mutex> lock(mu_);
    stop_.store(true);
    dropped.swap(jobs_);
    t = std::move(thread_);
  }
  cv_.notify_all();
  if (t.joinable()) t.join();
  // `dropped` is destroyed here, on the caller's thread.
}

size_t SerialWorker::pending() const {
  std::lock_guard<std::mutex> lock(mu_);
  return jobs_.size();
}

bool SerialWorker::started() const {
  std::lock_guard<std::mutex> lock(mu_);
  return thread_.joinable();
}

void SerialWorker::run() {
  pthread_setname_np(pthread_self(), name_.substr(0, 15).c_str());
  if (nice_ != INT_MIN) setpriority(PRIO_PROCESS, static_cast<id_t>(syscall(SYS_gettid)), nice_);
  for (;;) {
    Job job;
    {
      std::unique_lock<std::mutex> lock(mu_);
      while (!stop_.load() && jobs_.empty()) cv_.wait(lock);
      if (stop_.load()) return;
      job = std::move(jobs_.front());
      jobs_.pop_front();
    }
    job(stop_);
  }
}

}  // namespace iwn
