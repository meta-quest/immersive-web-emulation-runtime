/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Loads built-in captures and rooms in the prebuilt ES bundles (build/es*),
// which rollup builds with this file in place of loaders.ts. They fetch the
// package's files by URL instead of embedding a copy.

import type { Scene as SceneFile } from './generated/protos/openxr_scene.js';
import { fetchJSON } from './fetch-json.js';

export async function loadCaptureFile(envId: string): Promise<SceneFile> {
  return fetchJSON(packageURL(`captures/${envId}.json`));
}

export async function loadRoomSource(roomId: string): Promise<string> {
  const url = packageURL(`rooms/${roomId}.js`).href;
  return (await import(/* @vite-ignore */ /* webpackIgnore: true */ url))
    .default;
}

// The bundles (build/es*/index.js) are two levels below the package root.
// The base is a variable so bundlers do not mistake this for an asset
// reference and emit copies.
function packageURL(path: string) {
  const base = import.meta.url;
  return new URL(`../../${path}`, base);
}
