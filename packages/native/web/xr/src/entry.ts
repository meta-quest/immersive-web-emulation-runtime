/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Prelude entry (dist/xr.min.js): evaluated after the web glue and the WebGL prelude, before the page. Without the
// native XR module (headless runner without XR natives) it leaves navigator.xr alone. The passthrough cameras
// (getUserMedia, XR-CAM-1) install on their own natives, and only for apps that declare the camera; a camera opens
// only once the user granted the camera permissions (XR-PERM-1's helper).
import { installCamera, type CameraNatives } from './camera.ts';
import { installNativeXR, type NativeXR } from './install.ts';
import type { WebGLHooks, XrNatives } from './natives.ts';
import { CAMERA_PERMISSIONS } from './permissions.ts';

type Global = Record<string, unknown> & typeof globalThis;
const g = globalThis as Global;
const natives = (g.__iwn as { xr?: XrNatives } | undefined)?.xr;
let xr: NativeXR | null = null;
if (natives) {
  try {
    xr = installNativeXR(
      g,
      natives,
      (g.__iwnWebGL as WebGLHooks | undefined) ?? null,
    );
  } catch (error) {
    console.error('@iwer/native: WebXR could not be installed', error);
  }
}

const iwn = g.__iwn as
  | {
      camera?: CameraNatives;
      image?: { close(handle: object): void; share(handle: object): object };
    }
  | undefined;
if (iwn?.camera) {
  try {
    const permissions = xr;
    const image = iwn.image;
    installCamera(g, iwn.camera, {
      closeHandle: (handle) => image?.close(handle),
      shareHandle: image ? (handle) => image.share(handle) : undefined,
      requestPermission: permissions
        ? () =>
            permissions
              .requestPermissions(CAMERA_PERMISSIONS)
              .then((held) => CAMERA_PERMISSIONS.every((p) => held[p]))
        : undefined,
    });
  } catch (error) {
    console.error('@iwer/native: the camera could not be installed', error);
  }
}
