/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export type RuntimeMode = 'iwer' | 'native';

export function detectRuntime(): RuntimeMode {
  if ((globalThis as any).__IWER_INJECTED__) {
    return 'iwer';
  }
  return 'native';
}

/**
 * Detects whether the browser has real native XR hardware support.
 * Headless Chrome has navigator.xr but no actual device, so we
 * probe isSessionSupported to distinguish.
 */
export async function hasNativeXR(): Promise<boolean> {
  if (!('xr' in navigator) || !navigator.xr) {
    return false;
  }
  if ((globalThis as any).__IWER_INJECTED__) {
    return false;
  }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    return supported;
  } catch {
    return false;
  }
}
