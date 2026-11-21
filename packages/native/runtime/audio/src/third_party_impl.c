// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Single translation unit for the header-only MP3 decoder (kept apart from our C++ so its macros
// do not leak): dr_mp3 v0.7.3.
#define DR_MP3_IMPLEMENTATION
#define DR_MP3_NO_STDIO
#include "dr_mp3.h"
