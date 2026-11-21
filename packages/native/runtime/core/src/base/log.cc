#include "iwn/core/log.h"

#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

#include <unistd.h>

#if defined(__ANDROID__)
#include <android/log.h>
#include <pthread.h>
#endif

namespace iwn {
namespace {

std::mutex& sink_mutex() {
  static std::mutex m;
  return m;
}
LogSink& sink_slot() {
  static LogSink s;
  return s;
}

void platform_write(const char* tag, LogLevel level, std::string_view line) {
#if defined(__ANDROID__)
  static const int kPrio[] = {ANDROID_LOG_DEBUG, ANDROID_LOG_INFO, ANDROID_LOG_WARN, ANDROID_LOG_ERROR};
  // __android_log_write needs a NUL-terminated string.
  std::string copy(line);
  __android_log_write(kPrio[static_cast<int>(level)], tag, copy.c_str());
#else
  static const char kLetter[] = {'D', 'I', 'W', 'E'};
  fprintf(stderr, "%c/%s: %.*s\n", kLetter[static_cast<int>(level)], tag, static_cast<int>(line.size()), line.data());
#endif
}

}  // namespace

void split_log_text(std::string_view text, size_t max_bytes, const std::function<void(std::string_view)>& emit) {
  if (max_bytes < 8) max_bytes = 8;
  if (text.empty()) {
    emit(text);
    return;
  }
  while (!text.empty()) {
    if (text.size() <= max_bytes) {
      emit(text);
      return;
    }
    size_t cut = max_bytes;
    // Prefer the last newline in the window (but not one at the very start: no empty chunks).
    size_t nl = text.rfind('\n', max_bytes - 1);
    bool at_newline = false;
    if (nl != std::string_view::npos && nl > 0) {
      cut = nl;
      at_newline = true;
    } else {
      // Back off to a UTF-8 lead byte so no sequence is split.
      while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80) --cut;
      if (cut == 0) cut = max_bytes;  // malformed input: split anyway
    }
    emit(text.substr(0, cut));
    text.remove_prefix(at_newline ? cut + 1 : cut);
  }
}

void log_text(const char* tag, LogLevel level, std::string_view text) {
  LogSink sink;
  {
    std::lock_guard<std::mutex> lock(sink_mutex());
    sink = sink_slot();
  }
  split_log_text(text, kMaxLogEntryBytes, [&](std::string_view chunk) {
    if (sink) {
      sink(tag, level, chunk);
    } else {
      platform_write(tag, level, chunk);
    }
  });
}

void vlog(LogLevel level, const char* fmt, va_list args) {
  char stack_buf[1024];
  va_list copy;
  va_copy(copy, args);
  int n = vsnprintf(stack_buf, sizeof(stack_buf), fmt, copy);
  va_end(copy);
  if (n < 0) return;
  if (static_cast<size_t>(n) < sizeof(stack_buf)) {
    log_text(kRuntimeLogTag, level, std::string_view(stack_buf, n));
    return;
  }
  std::vector<char> heap(static_cast<size_t>(n) + 1);
  vsnprintf(heap.data(), heap.size(), fmt, args);
  log_text(kRuntimeLogTag, level, std::string_view(heap.data(), n));
}

void log(LogLevel level, const char* fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vlog(level, fmt, args);
  va_end(args);
}

void set_log_sink(LogSink sink) {
  std::lock_guard<std::mutex> lock(sink_mutex());
  sink_slot() = std::move(sink);
}

void redirect_stdio_to_log() {
#if defined(__ANDROID__)
  static std::once_flag once;
  std::call_once(once, [] {
    int fds[2];
    if (pipe(fds) != 0) return;
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    dup2(fds[1], STDOUT_FILENO);
    dup2(fds[1], STDERR_FILENO);
    close(fds[1]);
    int read_fd = fds[0];
    std::thread([read_fd] {
      pthread_setname_np(pthread_self(), "iwn-stdio");
      std::string pending;
      char buf[1024];
      for (;;) {
        ssize_t n = read(read_fd, buf, sizeof(buf));
        if (n <= 0) break;
        pending.append(buf, static_cast<size_t>(n));
        size_t pos;
        while ((pos = pending.find('\n')) != std::string::npos) {
          if (pos > 0) log_text(kRuntimeLogTag, LogLevel::kWarn, std::string_view(pending.data(), pos));
          pending.erase(0, pos + 1);
        }
        if (pending.size() > kMaxLogEntryBytes) {
          log_text(kRuntimeLogTag, LogLevel::kWarn, pending);
          pending.clear();
        }
      }
    }).detach();
  });
#endif
}

}  // namespace iwn
