/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { MSG } from './protocol.js';
import { WHATS_NEW_FLAG } from './prefs.js';

document.getElementById('done')?.addEventListener('click', () => {
  void chrome.storage.local.set({ [WHATS_NEW_FLAG]: true });
  void chrome.runtime.sendMessage({ type: MSG.CLEAR_NEW_BADGE });
  window.close();
});
