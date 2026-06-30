/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { PREFS_SEED_CHANNEL } from './protocol.js';
import { STORAGE_KEY, resolveAll } from './prefs.js';
import { extractDomain } from './domain.js';

async function seed(): Promise<void> {
  // Always post — even on error — so the MAIN-world shell's awaitPrefsSeed never
  // waits out its full timeout on a storage failure.
  try {
    const domain = extractDomain(window.location.href);
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const prefs = resolveAll(stored[STORAGE_KEY], domain);
    window.postMessage({ channel: PREFS_SEED_CHANNEL, prefs }, '*');
  } catch {
    window.postMessage({ channel: PREFS_SEED_CHANNEL, prefs: {} }, '*');
  }
}

void seed();
