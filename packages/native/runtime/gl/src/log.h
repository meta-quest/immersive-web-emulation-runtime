// Logging for the GL module: logcat on Android (tag "iwn-gl"), stderr on the host.
#pragma once

#if defined(__ANDROID__)
#include <android/log.h>
#define IWN_GL_LOG_INFO(...) __android_log_print(ANDROID_LOG_INFO, "iwn-gl", __VA_ARGS__)
#define IWN_GL_LOG_WARN(...) __android_log_print(ANDROID_LOG_WARN, "iwn-gl", __VA_ARGS__)
#define IWN_GL_LOG_ERROR(...) __android_log_print(ANDROID_LOG_ERROR, "iwn-gl", __VA_ARGS__)
#else
#include <cstdio>
#define IWN_GL_LOG_INFO(...) (std::getenv("IWN_GL_VERBOSE") ? (std::fprintf(stderr, "[iwn-gl] " __VA_ARGS__), std::fputc('\n', stderr)) : 0)
#define IWN_GL_LOG_WARN(...) (std::fprintf(stderr, "[iwn-gl] warn: " __VA_ARGS__), std::fputc('\n', stderr))
#define IWN_GL_LOG_ERROR(...) (std::fprintf(stderr, "[iwn-gl] error: " __VA_ARGS__), std::fputc('\n', stderr))
#include <cstdlib>
#endif
