/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Prelude entry (dist/workers.js, an IIFE the runtime evaluates in the page and in every worker global, after the
// web glue and the image prelude): installs Worker, MessageChannel, MessagePort and, in a worker, the worker global
// scope over globalThis.__iwn.workers. Without the natives (headless runner without the module) it does nothing.
import { installWorkers } from './install.ts';

installWorkers(globalThis);
