/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Bundle entry (dist/image.js): installs the image globals on the current global (window or worker), after the web
// glue bundle.
import { installImage } from './install.ts';

installImage(globalThis);
