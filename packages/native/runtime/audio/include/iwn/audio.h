// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// @iwer/native audio module: public entry points for the runtime host.
//
//   iwn_register_audio(...)            installs globalThis.__iwn.audio (see web/audio/src/natives.ts
//                                      for the JS-visible contract)
//   iwn::audio::setHostHooks(...)      lets render/decoder threads hand completions to the main JS
//                                      thread as tasks (PROC-2). Without hooks the JS layer polls
//                                      while it waits for something (ended events, decodes, renders).
//   iwn::audio::setOutputPaused(...)   AUD-2: lifecycle pause / XR session hidden. Thread-safe.
//   iwn::audio::shutdown()             PROC-7: stop every device and join every audio thread.
#pragma once

#include <cstdint>

namespace iwn::audio {

struct HostHooks {
  void* user = nullptr;
  // Thread-safe. Queues fn(arg) as a task on the main JS thread. Called from a dedicated
  // notifier thread (never from the realtime render callback). Return false if the loop is gone.
  bool (*postToMain)(void* user, void (*fn)(void*), void* arg) = nullptr;
};

void setHostHooks(const HostHooks& hooks);

enum PauseReason : uint32_t {
  kPauseLifecycle = 1u << 0,  // activity paused (PROC-6)
  kPauseXrHidden = 1u << 1,   // XR session visibilityState "hidden"
  kPauseHost = 1u << 2,       // anything else the host wants
};

// Pauses (or resumes) device output for every realtime context. While any reason is set, devices
// are paused, currentTime does not advance and the JS-visible `state` does not change.
void setOutputPaused(uint32_t reason, bool paused);
uint32_t outputPausedReasons();

// Stops and closes every audio device, finishes offline renders, joins decoder/notifier threads,
// forgets the host hooks and frees every context and registered buffer. After shutdown the module
// refuses new contexts until iwn_register_audio runs for a new runtime (a new activity in the same
// process), which re-arms it.
void shutdown();

struct Stats {
  uint32_t realtimeContexts;
  uint32_t offlineContexts;
  uint64_t xruns;
  double renderLoad;     // max over contexts: render time / callback period (0..1+)
  uint32_t liveNodes;
  uint32_t liveBuffers;
  uint32_t pendingDecodes;
  uint64_t rtAllocations;      // render-thread vector growths (fallback; 0 in steady state)
  uint64_t paramEventsMerged;  // automation events folded into a neighbour (param list cap)
};
Stats stats();

}  // namespace iwn::audio

#ifdef IWN_WITH_V8
#include <v8.h>
void iwn_register_audio(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);
#endif
