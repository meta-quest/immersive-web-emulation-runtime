/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// One place that includes the Khronos OpenXR headers with the platform macros this module uses. The V8-free core
// only needs the plain types (XrPosef, XrFovf, XrTime, XrHandJointLocationEXT, ...), which build on the host too;
// the Android side also needs the Android/GLES platform structs (openxr_platform.h).
// Source: Khronos OpenXR SDK 1.1.63 headers (github.com/KhronosGroup/OpenXR-SDK, Apache-2.0 OR MIT).
#pragma once

#if defined(__ANDROID__)
#include <EGL/egl.h>
#include <jni.h>
#include <time.h>
#ifndef XR_USE_TIMESPEC
#define XR_USE_TIMESPEC 1  // XR_KHR_convert_timespec_time
#endif
#ifndef XR_USE_PLATFORM_ANDROID
#define XR_USE_PLATFORM_ANDROID 1
#endif
#ifndef XR_USE_GRAPHICS_API_OPENGL_ES
#define XR_USE_GRAPHICS_API_OPENGL_ES 1
#endif
#endif

#include <openxr/openxr.h>

#if defined(__ANDROID__)
#include <openxr/openxr_platform.h>
#endif
