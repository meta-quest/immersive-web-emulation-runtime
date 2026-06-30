/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Tracks the active browser tab id/generation carried on each response and
 * emits a one-line warning to the agent when the bound tab changes or reloads,
 * so it knows cached state (poses, world state) is stale. Adapted from IWSDK's
 * `mcp-stdio.ts` `createTabTracker` (plan §7 reuse map).
 */

export interface TabMeta {
  _tabId?: string;
  _tabGeneration?: number;
}

export interface TabTracker {
  /** Returns a warning string if the tab changed/reloaded since last call. */
  noteResponse(meta: TabMeta): string | null;
}

export function createTabTracker(): TabTracker {
  let lastTabId: string | null = null;
  let lastGen: number | null = null;

  return {
    noteResponse(meta: TabMeta): string | null {
      const tabId = meta._tabId;
      const gen = meta._tabGeneration;
      const prevId = lastTabId;
      const prevGen = lastGen;

      const tabChanged = prevId !== null && tabId != null && tabId !== prevId;
      const tabReloaded =
        prevId !== null &&
        prevId === tabId &&
        prevGen !== null &&
        typeof gen === 'number' &&
        gen !== prevGen;

      if (tabId != null) {
        lastTabId = tabId;
        lastGen = typeof gen === 'number' ? gen : null;
      }

      if (tabChanged) {
        return `WARNING: Active browser tab changed (previous: ${prevId}, current: ${tabId}). Previously cached state (device poses, world state) is now invalid — re-query before proceeding.`;
      }
      if (tabReloaded) {
        return `WARNING: Active browser tab reloaded (tab ${tabId}, generation ${prevGen} -> ${gen}). Previously cached state is now invalid — re-query before proceeding.`;
      }
      return null;
    },
  };
}
