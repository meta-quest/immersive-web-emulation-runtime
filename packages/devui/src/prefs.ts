/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export const IWE_PREFS_CHANNEL = 'iwer-prefs';

export type DevUIPrefsPatch = Record<string, unknown>;

export function emitPrefsPatch(patch: DevUIPrefsPatch): void {
  if (typeof window === 'undefined' || !patch) return;
  const targetOrigin =
    window.location.origin === 'null' ? '*' : window.location.origin;
  window.postMessage(
    {
      channel: IWE_PREFS_CHANNEL,
      scope: 'origin',
      patch,
    },
    targetOrigin,
  );
}

// Trailing-edge debounce for high-frequency controls (e.g. the FOV slider drag)
// so a continuous gesture coalesces into a single persisted write instead of
// flooding the extension's storage layer. Patches are shallow-merged across the
// window; only top-level keys are emitted here so that is sufficient.
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let debouncedPatch: DevUIPrefsPatch | null = null;

export function emitPrefsPatchDebounced(
  patch: DevUIPrefsPatch,
  delayMs = 200,
): void {
  if (typeof window === 'undefined' || !patch) return;
  debouncedPatch = { ...(debouncedPatch ?? {}), ...patch };
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const pending = debouncedPatch;
    debouncedPatch = null;
    debounceTimer = null;
    if (pending) emitPrefsPatch(pending);
  }, delayMs);
}

// Environment loading is host-owned: the extension shell statically bundles the
// capture JSON and registers a loader here, so the in-page dropdown uses the
// exact same source as load-time hydration and never falls back to a network
// fetch (loadDefaultEnvironment fetches a CDN in the UMD build). Standalone
// DevUI (no registered loader) keeps the previous behavior.
export type EnvironmentLoader = (environmentId: string) => void;

let environmentLoader: EnvironmentLoader | null = null;

export function setEnvironmentLoader(loader: EnvironmentLoader | null): void {
  environmentLoader = loader;
}

export function getEnvironmentLoader(): EnvironmentLoader | null {
  return environmentLoader;
}
