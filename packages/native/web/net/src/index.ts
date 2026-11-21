/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export {
  installNet,
  NET_REGISTRY_KEY,
  type InstallNetOptions,
  type NetRegistry,
} from './install.ts';
export { Headers } from './headers.ts';
export { Request } from './request.ts';
export { Response } from './response.ts';
export { WebSocket, CloseEvent } from './websocket.ts';
export { XMLHttpRequest, XMLHttpRequestUpload } from './xhr.ts';
export { processDataURL, forgivingBase64Decode } from './fetch.ts';
export { parseAllowlist, checkOrigin } from './allowlist.ts';
export type { NetNatives, NetConfig, NativeHttpRequest } from './natives.ts';
