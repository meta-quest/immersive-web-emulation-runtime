/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Public entry points of the canvas2d module for the runtime host and other native modules.
#pragma once

#include <v8.h>

#include "iwn/canvas2d/canvas.h"

#if defined(__ANDROID__)
struct AAssetManager;
#endif

// Installs globalThis.__iwn.canvas2d (the JS-facing API in binding/api.h, consumed by web/canvas2d).
void iwn_register_canvas2d(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);

namespace iwn::canvas2d {

// The surface behind a JS surface handle (what the 2D canvas source protocol hands to texImage2D), or nullptr.
// Valid while the handle is reachable from JS. Thread: the isolate's thread.
Surface* SurfaceFromValue(v8::Isolate* isolate, v8::Local<v8::Value> value);

// Frees the native memory of every canvas2d handle still alive in `isolate` (surfaces, clips, fonts, ...). Call it
// before Isolate::Dispose() for isolates that ran canvas2d (workers): V8 does not run weak callbacks at teardown, so
// without it those handles leak. The isolate must still be valid; JS must not touch the handles afterwards.
void DisposeIsolate(v8::Isolate* isolate);

#if defined(__ANDROID__)
// Bundled fonts (C2D-9) are read from APK assets under "fonts/". Call once at startup.
void InstallAndroidAssetReader(AAssetManager* manager);
#endif

}  // namespace iwn::canvas2d
