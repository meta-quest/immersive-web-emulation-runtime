/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { XRGlobalObject } from '../device/XRDevice.js';

export type NativeOverridePhase =
  | 'uninstalled'
  | 'installed'
  | 'attached'
  | 'active';

/**
 * Scope of a native WebXR override.
 *
 * `full` replaces viewer and input tracking for deterministic automation.
 * `gaze-only` preserves every browser-owned pose, source, and input event and
 * adds only the synthetic gaze source requested by the application.
 */
export type NativeOverrideMode = 'full' | 'gaze-only';

export interface NativeOverrideEnvironment {
  /** Browser-owned XRSystem to inspect or patch. Defaults to navigator.xr. */
  xrSystem?: XRSystem;
  /** Native constructor source. Defaults to globalThis. */
  globalObject?: XRGlobalObject;
}

export interface NativeOverrideOptions extends NativeOverrideEnvironment {
  /** Override scope. Defaults to `full`. */
  mode?: NativeOverrideMode;
  /**
   * Behavior when the native runtime cannot be hooked. Defaults to `warn`.
   * A session requesting optional gaze still degrades to the unmodified
   * native session, preserving WebXR optional-feature negotiation semantics.
   */
  onUnsupported?: 'throw' | 'warn';
}

export interface NativeOverrideCapabilities {
  /** Farthest lifecycle phase reached during the current installation. */
  readonly phase: NativeOverridePhase;
  readonly supported: boolean;
  readonly requestSession: boolean;
  /** Whether the optional XRSystem.offerSession method is also intercepted. */
  readonly offerSession: boolean;
  readonly inputSources: boolean;
  readonly inputEvents: boolean;
  readonly brandedInputEvents: boolean;
  /** Whether synthetic feature aliases are exposed through session.enabledFeatures. */
  readonly enabledFeatures: boolean;
  readonly viewerSpaceTagging: boolean;
  readonly poseOverride: boolean;
  readonly batchPoses: boolean;
  readonly viewerPose: boolean;
  readonly viewTransforms: boolean;
  /** Synthetic hand input sources can be published on an attached session. */
  readonly handInput: boolean;
  /** XRFrame.getJointPose and XRFrame.fillJointRadii are overridden. */
  readonly jointPoses: boolean;
  /** A recording has driven at least one native frame. */
  readonly actionPlayback: boolean;
  /** XRFrame.createAnchor accepted an IWER-controlled space. */
  readonly anchors: boolean;
  /** XRSession.requestHitTestSource accepted an IWER-controlled space. */
  readonly hitTest: boolean;
  readonly notes: readonly string[];
}

/** Snapshot of an attached browser-owned immersive session. */
export interface NativeSessionInfo {
  readonly session: XRSession;
  readonly mode: 'immersive-vr' | 'immersive-ar';
  readonly primary: boolean;
  /** Browser-owned reference space used as the synthetic coordinate origin. */
  readonly anchorSpace: XRReferenceSpace;
}

/**
 * Structural lifecycle handle returned by native-override lookup. This is a
 * cross-version contract: `installed` and `uninstall` are the only members the
 * runtime lookup validates, so any member added later must be optional.
 */
export interface NativeOverrideHandle {
  readonly installed: boolean;
  /** Installed override scope, when exposed by this IWER version. */
  readonly mode?: NativeOverrideMode;
  readonly capabilities: NativeOverrideCapabilities;
  readonly sessions: readonly NativeSessionInfo[];
  uninstall(): void;
}

export type NativeOverrideSupport = Pick<
  NativeOverrideCapabilities,
  'supported' | 'requestSession' | 'notes'
>;
