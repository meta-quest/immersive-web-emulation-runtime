// Logging: two stable logcat tags (LOG-1), one for the runtime's own messages and one for JS console output and
// JS errors. On the host the same calls go to stderr (tests can capture them with set_log_sink).
#pragma once

#include <cstdarg>
#include <functional>
#include <string>
#include <string_view>

namespace iwn {

// Working names; the final names are open (spec README, open question 1).
inline constexpr const char* kRuntimeLogTag = "iwn";
inline constexpr const char* kJsLogTag = "iwn-js";

enum class LogLevel { kDebug = 0, kInfo = 1, kWarn = 2, kError = 3 };

// Largest payload of one logcat entry we emit; longer messages are split into several entries (CON-2), on UTF-8
// boundaries and preferably at newlines.
inline constexpr size_t kMaxLogEntryBytes = 4000;

// Runtime tag, printf-style.
void log(LogLevel level, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
void vlog(LogLevel level, const char* fmt, va_list args);
// Any tag, preformatted text; splits long messages.
void log_text(const char* tag, LogLevel level, std::string_view text);
// JS tag (console and JS errors).
inline void log_js(LogLevel level, std::string_view text) { log_text(kJsLogTag, level, text); }

// Splits text into chunks of at most max_bytes, never inside a UTF-8 sequence, preferring the last newline in the
// window (the newline itself is dropped at a split). Exposed for tests.
void split_log_text(std::string_view text, size_t max_bytes, const std::function<void(std::string_view)>& emit);

// Test hook: replaces the platform sink (logcat/stderr). Pass nullptr to restore it.
using LogSink = std::function<void(const char* tag, LogLevel level, std::string_view line)>;
void set_log_sink(LogSink sink);

// Android: redirects this process's stdout/stderr into logcat (runtime tag, W for stderr) on a named thread, so
// V8's own diagnostics (unknown flags, fatal errors) are visible (JS-3). No-op on the host.
void redirect_stdio_to_log();

}  // namespace iwn
