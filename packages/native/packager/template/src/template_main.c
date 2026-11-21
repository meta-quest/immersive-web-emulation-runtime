// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Placeholder native library for the packager's stand-in template APK
// (the packager's tests). The real template carries the @iwer/native runtime;
// this one only proves the packing contract on a device: it logs the packed
// runtime config, the app's entry document and whether large assets are
// stored uncompressed (mappable, NET-3), under logcat tag "iwn-template".
//
// Written from the Android NDK documentation for android/native_activity.h
// and android/asset_manager.h.

#include <android/asset_manager.h>
#include <android/log.h>
#include <android/native_activity.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define TAG "iwn-template"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

static void log_config(AAssetManager* am) {
  AAsset* cfg = AAssetManager_open(am, "iwn/config.json", AASSET_MODE_BUFFER);
  if (!cfg) {
    LOGI("config: missing (assets/iwn/config.json)");
    return;
  }
  off_t len = AAsset_getLength(cfg);
  const char* buf = (const char*)AAsset_getBuffer(cfg);
  LOGI("config: %ld bytes", (long)len);
  // Log the config in 600-byte slices (logcat truncates long lines).
  for (off_t off = 0; buf && off < len; off += 600) {
    int n = (int)((len - off) < 600 ? (len - off) : 600);
    LOGI("config[%ld]: %.*s", (long)off, n, buf + off);
  }
  AAsset_close(cfg);
}

static void log_dir(AAssetManager* am, const char* dir) {
  AAssetDir* d = AAssetManager_openDir(am, dir);
  if (!d) {
    LOGI("dir %s: cannot open", dir);
    return;
  }
  int files = 0, mappable = 0;
  long long bytes = 0;
  const char* name;
  char path[512];
  while ((name = AAssetDir_getNextFileName(d)) != NULL) {
    snprintf(path, sizeof path, "%s/%s", dir, name);
    AAsset* a = AAssetManager_open(am, path, AASSET_MODE_UNKNOWN);
    if (!a) continue;
    files++;
    bytes += AAsset_getLength64(a);
    off64_t start = 0, length = 0;
    int fd = AAsset_openFileDescriptor64(a, &start, &length);
    if (fd >= 0) {
      mappable++;
      close(fd);
    }
    AAsset_close(a);
  }
  AAssetDir_close(d);
  LOGI("dir %s: %d files, %lld bytes, %d stored uncompressed (mappable)", dir, files, bytes, mappable);
}

static void on_start(ANativeActivity* a) { LOGI("onStart"); }
static void on_resume(ANativeActivity* a) { LOGI("onResume"); }
static void on_pause(ANativeActivity* a) { LOGI("onPause"); }
static void on_stop(ANativeActivity* a) { LOGI("onStop"); }
static void on_destroy(ANativeActivity* a) { LOGI("onDestroy"); }
static void on_window_created(ANativeActivity* a, ANativeWindow* w) { LOGI("window created"); }

JNIEXPORT void ANativeActivity_onCreate(ANativeActivity* activity, void* saved_state, size_t saved_state_size) {
  LOGI("onCreate: sdk %d, data %s", activity->sdkVersion, activity->internalDataPath ? activity->internalDataPath : "?");
  activity->callbacks->onStart = on_start;
  activity->callbacks->onResume = on_resume;
  activity->callbacks->onPause = on_pause;
  activity->callbacks->onStop = on_stop;
  activity->callbacks->onDestroy = on_destroy;
  activity->callbacks->onNativeWindowCreated = on_window_created;
  AAssetManager* am = activity->assetManager;
  log_config(am);
  AAsset* index = AAssetManager_open(am, "app/index.html", AASSET_MODE_BUFFER);
  if (index) {
    LOGI("app/index.html: %ld bytes", (long)AAsset_getLength(index));
    AAsset_close(index);
  } else {
    LOGI("app/index.html: missing");
  }
  log_dir(am, "app");
  log_dir(am, "app/assets");
  LOGI("ready");
}
