// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Per-isolate IwnLoopHooks registry (C++ inline functions: one instance per
// linked binary, no link dependency between modules). The runtime core binds
// each isolate's loop (main thread and every worker) BEFORE calling the
// modules' iwn_register_<module>(), and unbinds it before disposing the
// isolate:
//
//   static IwnLoopHooks hooks = {loop, &Post, &Ref, &Unref};
//   iwn::BindLoopHooks(isolate, &hooks);
//   iwn_register_net(isolate, context, natives);
//   ...
//   iwn::UnbindLoopHooks(isolate);   // modules then drop late completions

#ifndef IWN_LOOP_HOOKS_REGISTRY_H_
#define IWN_LOOP_HOOKS_REGISTRY_H_

#include <map>
#include <mutex>

#include "iwn/loop_hooks.h"

namespace iwn {

namespace loop_hooks_detail {
inline std::mutex& Mutex() {
  static std::mutex mu;
  return mu;
}
inline std::map<const void*, const IwnLoopHooks*>& Map() {
  static std::map<const void*, const IwnLoopHooks*> map;
  return map;
}
}  // namespace loop_hooks_detail

inline void BindLoopHooks(const void* isolate, const IwnLoopHooks* hooks) {
  std::lock_guard<std::mutex> lock(loop_hooks_detail::Mutex());
  loop_hooks_detail::Map()[isolate] = hooks;
}

inline void UnbindLoopHooks(const void* isolate) {
  std::lock_guard<std::mutex> lock(loop_hooks_detail::Mutex());
  loop_hooks_detail::Map().erase(isolate);
}

inline const IwnLoopHooks* LoopHooksFor(const void* isolate) {
  std::lock_guard<std::mutex> lock(loop_hooks_detail::Mutex());
  auto it = loop_hooks_detail::Map().find(isolate);
  return it == loop_hooks_detail::Map().end() ? nullptr : it->second;
}

}  // namespace iwn

#endif  // IWN_LOOP_HOOKS_REGISTRY_H_
