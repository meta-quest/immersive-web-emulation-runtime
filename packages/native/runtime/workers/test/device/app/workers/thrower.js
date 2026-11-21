/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Uncaught error in a task (WRK-7): reaches the Worker as an ErrorEvent with a location.
setTimeout(function boom() {
  throw new TypeError('worker failure on purpose');
}, 0);
