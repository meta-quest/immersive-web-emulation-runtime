/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Loads built-in captures in lib/, through lazy imports that the app's
// bundler resolves. The prebuilt ES bundles use loaders.bundle.ts instead
// (see rollup.config.js). UMD builds (SEM's own, and apps that bundle lib/ as
// UMD with __IS_UMD__, such as the IWER extension) cannot split chunks, so
// they fetch captures from the CDN.

import { Environments } from './registry.js';
import type { Scene as SceneFile } from './generated/protos/openxr_scene.js';
import { VERSION } from './version.js';
import { fetchJSON } from './fetch-json.js';

export async function loadCaptureFile(envId: string): Promise<SceneFile> {
  if (typeof __IS_UMD__ !== 'undefined' && __IS_UMD__) {
    return fetchJSON(
      `https://www.unpkg.com/@iwer/sem@${VERSION}/captures/${envId}.json`,
    );
  }
  return (await Environments[envId]()).default;
}
