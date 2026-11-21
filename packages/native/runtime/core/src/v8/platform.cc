// v8::Platform for the runtime (V8 embedder API, include/v8-platform.h and libplatform/libplatform.h).
#include "iwn/core/platform.h"

#include <libplatform/libplatform.h>

#include <mutex>
#include <unordered_map>

#include "iwn/core/log.h"

namespace iwn {
namespace {

// Foreground task runner of one isolate: posts into its EventLoop (thread-safe). After the isolate is gone, posts
// are dropped (TaskRunner contract: tasks may be posted after isolate destruction but need not run).
class LoopTaskRunner : public v8::TaskRunner {
 public:
  explicit LoopTaskRunner(EventLoop* loop) : loop_(loop) {}
  void shutdown() {
    std::lock_guard<std::mutex> lock(mu_);
    loop_ = nullptr;
  }
  bool IdleTasksEnabled() override { return false; }
  bool NonNestableTasksEnabled() const override { return true; }
  bool NonNestableDelayedTasksEnabled() const override { return true; }

 protected:
  void PostTaskImpl(std::unique_ptr<v8::Task> task, const v8::SourceLocation&) override { post(std::move(task), 0); }
  void PostNonNestableTaskImpl(std::unique_ptr<v8::Task> task, const v8::SourceLocation&) override {
    post(std::move(task), 0);
  }
  void PostDelayedTaskImpl(std::unique_ptr<v8::Task> task, double delay_s, const v8::SourceLocation&) override {
    post(std::move(task), delay_s);
  }
  void PostNonNestableDelayedTaskImpl(std::unique_ptr<v8::Task> task, double delay_s,
                                      const v8::SourceLocation&) override {
    post(std::move(task), delay_s);
  }
  void PostIdleTaskImpl(std::unique_ptr<v8::IdleTask>, const v8::SourceLocation&) override {}

 private:
  void post(std::unique_ptr<v8::Task> task, double delay_s) {
    std::lock_guard<std::mutex> lock(mu_);
    if (!loop_) return;
    auto shared = std::shared_ptr<v8::Task>(std::move(task));
    if (delay_s > 0) {
      loop_->post_delayed([shared] { shared->Run(); }, delay_s * 1000.0);
    } else {
      loop_->post_high([shared] { shared->Run(); });
    }
  }
  std::mutex mu_;
  EventLoop* loop_;
};

class RuntimePlatform : public v8::Platform {
 public:
  explicit RuntimePlatform(std::unique_ptr<v8::Platform> inner) : inner_(std::move(inner)) {}

  void register_isolate(v8::Isolate* isolate, EventLoop* loop) {
    std::lock_guard<std::mutex> lock(mu_);
    runners_[isolate] = std::make_shared<LoopTaskRunner>(loop);
  }
  void unregister_isolate(v8::Isolate* isolate) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = runners_.find(isolate);
    if (it != runners_.end()) {
      it->second->shutdown();
      runners_.erase(it);
    }
  }

  v8::PageAllocator* GetPageAllocator() override { return inner_->GetPageAllocator(); }
  void OnCriticalMemoryPressure() override { inner_->OnCriticalMemoryPressure(); }
  int NumberOfWorkerThreads() override { return inner_->NumberOfWorkerThreads(); }
  std::shared_ptr<v8::TaskRunner> GetForegroundTaskRunner(v8::Isolate* isolate, v8::TaskPriority priority) override {
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = runners_.find(isolate);
      if (it != runners_.end()) return it->second;
    }
    return inner_->GetForegroundTaskRunner(isolate, priority);
  }
  bool IdleTasksEnabled(v8::Isolate*) override { return false; }
  double MonotonicallyIncreasingTime() override { return inner_->MonotonicallyIncreasingTime(); }
  double CurrentClockTimeMillis() override { return inner_->CurrentClockTimeMillis(); }
  v8::TracingController* GetTracingController() override { return inner_->GetTracingController(); }
  StackTracePrinter GetStackTracePrinter() override { return inner_->GetStackTracePrinter(); }

 protected:
  std::unique_ptr<v8::JobHandle> CreateJobImpl(v8::TaskPriority priority, std::unique_ptr<v8::JobTask> job_task,
                                               const v8::SourceLocation& location) override {
    return inner_->CreateJob(priority, std::move(job_task), location);
  }
  void PostTaskOnWorkerThreadImpl(v8::TaskPriority priority, std::unique_ptr<v8::Task> task,
                                  const v8::SourceLocation& location) override {
    inner_->PostTaskOnWorkerThread(priority, std::move(task), location);
  }
  void PostDelayedTaskOnWorkerThreadImpl(v8::TaskPriority priority, std::unique_ptr<v8::Task> task, double delay_s,
                                         const v8::SourceLocation& location) override {
    inner_->PostDelayedTaskOnWorkerThread(priority, std::move(task), delay_s, location);
  }

 private:
  std::unique_ptr<v8::Platform> inner_;
  std::mutex mu_;
  std::unordered_map<v8::Isolate*, std::shared_ptr<LoopTaskRunner>> runners_;
};

std::mutex g_init_mu;
RuntimePlatform* g_platform = nullptr;
std::string g_flags_applied;
std::shared_ptr<AssetBytes> g_snapshot;
v8::StartupData g_startup{};

// Flags the runtime always sets, after any diagnostic flags, so an app config or a launch override cannot weaken
// what JS-1 requires (JS-3): every JIT tier (Sparkplug, Maglev, TurboFan) and WebAssembly with Liftoff and tier-up.
// These are V8's defaults on arm64; re-asserting them undoes e.g. --jitless or --no-maglev. Each is applied with its
// own SetFlagsFromString call: V8 stops at the first unknown flag and ignores the rest of the string.
// Heap size and the stack limit are set per isolate (ResourceConstraints / SetStackLimit), not by flags.
constexpr const char kRuntimeFlags[] =
    "--no-jitless --no-lite-mode --sparkplug --maglev --turbofan --liftoff --wasm-tier-up";

}  // namespace

const char* runtime_v8_flags() { return kRuntimeFlags; }

bool v8_initialized() {
  std::lock_guard<std::mutex> lock(g_init_mu);
  return g_platform != nullptr;
}

bool initialize_v8(const V8InitOptions& options) {
  std::lock_guard<std::mutex> lock(g_init_mu);
  if (g_platform) {
    if (options.diagnostic_flags != g_flags_applied) {
      log(LogLevel::kWarn, "V8 already initialised in this process; ignoring flags \"%s\" (applied: \"%s\")",
          options.diagnostic_flags.c_str(), g_flags_applied.c_str());
    }
    return true;
  }
  if (!options.diagnostic_flags.empty()) {
    // V8 prints unknown flags to stderr (redirected to logcat) and ignores them (JS-3).
    log(LogLevel::kWarn, "applying diagnostic V8 flags: %s", options.diagnostic_flags.c_str());
    v8::V8::SetFlagsFromString(options.diagnostic_flags.c_str(), options.diagnostic_flags.size());
  }
  {
    std::string all(kRuntimeFlags);
    size_t i = 0;
    while (i < all.size()) {
      size_t e = all.find(' ', i);
      if (e == std::string::npos) e = all.size();
      if (e > i) v8::V8::SetFlagsFromString(all.data() + i, e - i);
      i = e + 1;
    }
  }
  g_flags_applied = options.diagnostic_flags;
  if (!options.snapshot || options.snapshot->size() == 0) {
    log(LogLevel::kError, "V8 snapshot missing: cannot start the engine");
    return false;
  }
  g_snapshot = options.snapshot;
  g_startup.data = reinterpret_cast<const char*>(g_snapshot->data());
  g_startup.raw_size = static_cast<int>(g_snapshot->size());
  v8::V8::SetSnapshotDataBlob(&g_startup);
  auto inner = v8::platform::NewDefaultPlatform(options.worker_threads, v8::platform::IdleTaskSupport::kDisabled);
  g_platform = new RuntimePlatform(std::move(inner));  // process lifetime
  v8::V8::InitializePlatform(g_platform);
  if (!v8::V8::Initialize()) {
    log(LogLevel::kError, "v8::V8::Initialize failed");
    return false;
  }
  log(LogLevel::kInfo, "V8 %s initialised (%d worker threads)", v8::V8::GetVersion(), options.worker_threads);
  return true;
}

v8::Isolate* new_isolate(const v8::Isolate::CreateParams& params, EventLoop* loop) {
  v8::Isolate* isolate = v8::Isolate::Allocate();
  g_platform->register_isolate(isolate, loop);
  v8::Isolate::Initialize(isolate, params);
  return isolate;
}

void dispose_isolate(v8::Isolate* isolate) {
  g_platform->unregister_isolate(isolate);
  isolate->Dispose();
}

}  // namespace iwn
