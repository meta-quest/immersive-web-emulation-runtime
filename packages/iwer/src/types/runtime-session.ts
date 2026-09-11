/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { mat4 } from 'gl-matrix';
import type { ActionPlayer } from '../action/ActionPlayer.js';
import type { XRSessionMode, XRVisibilityState } from '../session/XRSession.js';

/** @internal Runtime-neutral session data used by RemoteControlInterface. */
export interface XRRuntimeSession {
  readonly mode: XRSessionMode;
  readonly enabledFeatures: readonly string[];
  readonly visibilityState: XRVisibilityState;
  readonly originOffsetMatrix: mat4 | null;
  end(): void | Promise<void>;
}

/** @internal Adapter for either IWER's emulated runtime or a native override. */
export interface XRRuntimeAdapter {
  readonly kind: 'emulated' | 'native';
  getSession(): XRRuntimeSession | null;
  /** Optional hook for runtimes that need to instrument action playback. */
  onActionPlayerCreated?(player: ActionPlayer): void;
}
