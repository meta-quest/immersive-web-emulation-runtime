// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// The contract between the runtime's event loop and modules that
// complete work on background threads (net, storage). Plain C, no V8, so it
// can be shared by every module without a link dependency.
//
// Spec: LOOP-1 (completions are tasks on the JS thread), PROC-* (the loop
// stays alive while work is pending).

#ifndef IWN_LOOP_HOOKS_H_
#define IWN_LOOP_HOOKS_H_

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*IwnTaskFn)(void* arg);

typedef struct IwnLoopHooks {
  void* user;
  // Thread-safe. Queues fn(arg) to run as a task on the JS thread that owns
  // the isolate, inside its event loop turn (not inside a microtask
  // checkpoint). Must not run fn synchronously. Returns 0 when the loop is
  // shutting down (fn will never run; the caller frees arg).
  int (*post)(void* user, IwnTaskFn fn, void* arg);
  // Keep-alive: while ref count > 0 the loop must not exit for lack of work
  // (an in-flight request is pending work). JS thread only.
  void (*ref)(void* user);
  void (*unref)(void* user);
} IwnLoopHooks;

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // IWN_LOOP_HOOKS_H_
