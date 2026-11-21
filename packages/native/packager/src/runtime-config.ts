/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The generated runtime config, `assets/iwn/config.json` (PKG-CFG-1,
 * PKG-CFG-3). Its shape is the runtime's (runtime/core `RuntimeConfig`,
 * runtime/net "network" section): the packer overlays the app's values on
 * the template's defaults, so runtime-owned keys (preludes, snapshot paths)
 * stay as the template ships them.
 *
 * No timestamps or absolute paths go in: packing is reproducible (PKG-9).
 */

import type { ResolvedNativeTarget } from '../../src/config/types.ts';
import type { IndexInfo } from './dist.ts';
import { SPLASH_RUNTIME_IMAGE } from './splash.ts';

export type BuildType = 'debug' | 'release';

export interface RuntimeConfigInput {
  target: ResolvedNativeTarget;
  buildType: BuildType;
  /** Release build that still serves the inspector/debug endpoint. */
  inspector: boolean;
  index: IndexInfo;
  packerVersion: string;
  templateVersion: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Deep merge: objects merge key by key, everything else is replaced. */
export function mergeJson(base: Json, over: Json): Json {
  if (
    base &&
    over &&
    typeof base === 'object' &&
    typeof over === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(over)
  ) {
    const out: { [key: string]: Json } = { ...base };
    for (const [k, v] of Object.entries(over))
      out[k] = k in base ? mergeJson(base[k], v) : v;
    return out;
  }
  return over;
}

/** Sort object keys recursively so the JSON text is stable. */
function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

export function appRuntimeConfig(input: RuntimeConfigInput): {
  [key: string]: Json;
} {
  const { target, buildType } = input;
  const debug = buildType === 'debug';
  const serves = debug || input.inspector;
  return {
    appRoot: 'app',
    index: 'index.html',
    app: {
      packageId: target.packageId,
      name: target.appName,
      versionName: target.version,
      versionCode: target.versionCode,
      buildType,
    },
    inspector: { enabled: serves },
    debug: { enabled: serves },
    // Launch extras may override the debug subset (PKG-CFG-3): always in
    // debug builds; in release builds only when packed with the inspector.
    launchOverrides: { allowed: serves },
    stats: { logIntervalMs: 2000 },
    network: { allow: [...target.network.allow], debug },
    xr: {
      frameRate: target.frameRate,
      foveation: {
        level: target.foveation.level,
        dynamic: target.foveation.dynamic,
      },
      features: { ...target.features },
      // XR-AR-1: immersive-ar (passthrough under the projection layer) is offered to apps that declare passthrough
      // (world.xr.mode "ar" implies it). Without it the key stays the template's (off by default).
      ...(target.features.passthrough ? { immersiveAr: true } : {}),
      // The loading screen until the app's first XR frame (runtime/xr
      // loading.h): the system splash image (splash.ts) with a spinner, on
      // the background ("black", "contextual" or "#rrggbb"). Without a splash
      // the background alone stays: what shows behind a frame without an
      // opaque layer is up to the system (Horizon OS can show passthrough).
      loading: target.splash.enabled
        ? {
            enabled: true,
            image: SPLASH_RUNTIME_IMAGE,
            background: target.splash.background,
          }
        : {
            enabled: true,
            image: null,
            spinner: false,
            background: target.splash.background,
          },
    },
    page: {
      title: input.index.title,
      entry: input.index.moduleScripts[0] ?? null,
    },
    pack: { packer: input.packerVersion, template: input.templateVersion },
  };
}

/** The final JSON text: template defaults + app values, canonical key order. */
export function buildRuntimeConfig(
  templateConfig: unknown,
  input: RuntimeConfigInput,
): string {
  const base = (
    templateConfig &&
    typeof templateConfig === 'object' &&
    !Array.isArray(templateConfig)
      ? templateConfig
      : {}
  ) as Json;
  return `${JSON.stringify(canonical(mergeJson(base, appRuntimeConfig(input) as Json)), null, 2)}\n`;
}
