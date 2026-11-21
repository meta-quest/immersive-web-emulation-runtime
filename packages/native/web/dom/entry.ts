/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The shipped prelude (dist/dom.min.js): installs the DOM stand-ins on the page global; a no-op in workers.
import { installDom } from './src/install.ts';

installDom(globalThis);
