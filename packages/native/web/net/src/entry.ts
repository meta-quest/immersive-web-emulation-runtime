/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IIFE entry of dist/net.min.js: a runtime prelude evaluated after the glue (it needs URL, Blob,
// EventTarget, DOMException, AbortController, TextEncoder) and before the app's entry module, in the
// window context and in every worker.
import { installNet } from './install.ts';

installNet(globalThis);
