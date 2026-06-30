/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { OriginPrefs } from './prefs.js';
import { PREFS_SEED_CHANNEL } from './protocol.js';

// Generous timeout: the seeder is a document_start content script that always
// posts (even {} on error), so the seed normally arrives within a storage read.
// This bound only matters on a pathological cold start; if it is hit and the
// real seed lands later, onLate fires so the shell can recover (reload).
const DEFAULT_TIMEOUT_MS = 1500;

export function awaitPrefsSeed(
  onLate?: (prefs: Partial<OriginPrefs>) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Partial<OriginPrefs>> {
  return new Promise((resolve) => {
    let resolved = false;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const msg = event.data as {
        channel?: string;
        prefs?: Partial<OriginPrefs>;
      } | null;
      if (msg?.channel !== PREFS_SEED_CHANNEL) return;
      // The seeder posts exactly once; stop listening after it arrives.
      window.removeEventListener('message', onMessage);
      const prefs = msg.prefs ?? {};
      if (resolved) {
        onLate?.(prefs); // real seed after the timeout fallback already resolved
      } else {
        resolved = true;
        resolve(prefs);
      }
    };
    window.addEventListener('message', onMessage);
    // On timeout, fall back to defaults but KEEP listening so a late seed can
    // still reach onLate.
    window.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({});
    }, timeoutMs);
  });
}
