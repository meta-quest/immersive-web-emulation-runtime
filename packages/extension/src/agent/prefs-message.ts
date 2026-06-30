/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { MSG, PREFS_CHANNEL } from './protocol.js';
import {
  DEVICE_CATALOG,
  ENVIRONMENT_CATALOG,
  type DefaultPose,
  type Handedness,
  type OriginPrefs,
  type PoseTransform,
} from './prefs.js';

export interface PrefsRuntimeMessage {
  type: typeof MSG.PREFS_WRITE;
  scope: 'origin' | 'global';
  patch: Record<string, unknown>;
}

const HANDEDNESSES = ['left', 'right'] as const;
const HAND_POSES = ['default', 'pinch', 'point'] as const;
const TRIGGER_MODES = ['slow', 'normal', 'fast', 'turbo'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumberInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80;
}

function sanitizeKeymap(value: unknown): OriginPrefs['keymap'] | undefined {
  if (!isRecord(value)) return undefined;
  const keymap: OriginPrefs['keymap'] = {};
  for (const handedness of HANDEDNESSES) {
    const handMap = value[handedness];
    if (!isRecord(handMap)) continue;
    const sanitized: Record<string, string> = {};
    for (const [action, keyCode] of Object.entries(handMap)) {
      if (isBoundedString(action) && isBoundedString(keyCode)) {
        sanitized[action] = keyCode;
      }
    }
    if (Object.keys(sanitized).length > 0) keymap[handedness] = sanitized;
  }
  return Object.keys(keymap).length > 0 ? keymap : undefined;
}

function sanitizeHandPoses(
  value: unknown,
):
  | Partial<Record<Handedness, OriginPrefs['handPoses'][Handedness]>>
  | undefined {
  if (!isRecord(value)) return undefined;
  const handPoses: Partial<
    Record<Handedness, OriginPrefs['handPoses'][Handedness]>
  > = {};
  for (const handedness of HANDEDNESSES) {
    const pose = value[handedness];
    if (HAND_POSES.includes(pose as never)) {
      handPoses[handedness] = pose as OriginPrefs['handPoses'][Handedness];
    }
  }
  return Object.keys(handPoses).length > 0 ? handPoses : undefined;
}

function sanitizePoseTransform(value: unknown): PoseTransform | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.position) ||
    !Array.isArray(value.quaternion)
  ) {
    return undefined;
  }
  if (
    value.position.length !== 3 ||
    value.quaternion.length !== 4 ||
    !value.position.every(
      (part) => typeof part === 'number' && Number.isFinite(part),
    ) ||
    !value.quaternion.every(
      (part) => typeof part === 'number' && Number.isFinite(part),
    )
  ) {
    return undefined;
  }
  return {
    position: [value.position[0], value.position[1], value.position[2]],
    quaternion: [
      value.quaternion[0],
      value.quaternion[1],
      value.quaternion[2],
      value.quaternion[3],
    ],
  };
}

function sanitizePoseMap(
  value: unknown,
): Partial<Record<Handedness, PoseTransform>> | undefined {
  if (!isRecord(value)) return undefined;
  const poses: Partial<Record<Handedness, PoseTransform>> = {};
  for (const handedness of HANDEDNESSES) {
    const pose = sanitizePoseTransform(value[handedness]);
    if (pose) poses[handedness] = pose;
  }
  return Object.keys(poses).length > 0 ? poses : undefined;
}

function sanitizeDefaultPose(value: unknown): DefaultPose | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const headset = sanitizePoseTransform(value.headset);
  if (!headset) return undefined;
  const defaultPose: DefaultPose = { headset };
  const controllers = sanitizePoseMap(value.controllers);
  const hands = sanitizePoseMap(value.hands);
  if (controllers) defaultPose.controllers = controllers;
  if (hands) defaultPose.hands = hands;
  return defaultPose;
}

function sanitizeRoomDimension(
  value: unknown,
): OriginPrefs['roomDimension'] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { x, y, z } = value;
  if (
    !isFiniteNumberInRange(x, 0.1, 100) ||
    !isFiniteNumberInRange(y, 0.1, 100) ||
    !isFiniteNumberInRange(z, 0.1, 100)
  ) {
    return undefined;
  }
  return { x, y, z };
}

function sanitizePrefsPatch(
  patch: Record<string, unknown>,
): Partial<OriginPrefs> {
  const out: Partial<OriginPrefs> = {};
  if (DEVICE_CATALOG.includes(patch.device as never)) {
    out.device = patch.device as OriginPrefs['device'];
  }
  if (ENVIRONMENT_CATALOG.includes(patch.environment as never)) {
    out.environment = patch.environment as OriginPrefs['environment'];
  }
  if (patch.inputMode === 'controller' || patch.inputMode === 'hand') {
    out.inputMode = patch.inputMode;
  }
  if (typeof patch.stereoEnabled === 'boolean') {
    out.stereoEnabled = patch.stereoEnabled;
  }
  if (isFiniteNumberInRange(patch.ipd, 0.04, 0.08)) {
    out.ipd = patch.ipd;
  }
  if (isFiniteNumberInRange(patch.fovy, Math.PI / 6, Math.PI / 1.5)) {
    out.fovy = patch.fovy;
  }
  const keymap = sanitizeKeymap(patch.keymap);
  if (keymap) out.keymap = keymap;
  const handPoses = sanitizeHandPoses(patch.handPoses);
  if (handPoses) out.handPoses = handPoses as OriginPrefs['handPoses'];
  const defaultPose = sanitizeDefaultPose(patch.defaultPose);
  if (defaultPose !== undefined) out.defaultPose = defaultPose;
  const roomDimension = sanitizeRoomDimension(patch.roomDimension);
  if (roomDimension !== undefined) out.roomDimension = roomDimension;
  if (TRIGGER_MODES.includes(patch.triggerMode as never)) {
    out.triggerMode = patch.triggerMode as OriginPrefs['triggerMode'];
  }
  for (const key of [
    'joystickSticky',
    'actionMappingOn',
    'agentAutoEnableEmulation',
  ] as const) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key];
  }
  return out;
}

export function prefsRuntimeMessageFromWindowMessage(
  data: unknown,
): PrefsRuntimeMessage | null {
  const msg = data as {
    channel?: string;
    scope?: 'origin' | 'global';
    patch?: unknown;
  } | null;
  if (
    !msg ||
    msg.channel !== PREFS_CHANNEL ||
    !msg.patch ||
    typeof msg.patch !== 'object' ||
    Array.isArray(msg.patch)
  ) {
    return null;
  }
  const patch = sanitizePrefsPatch(msg.patch as Record<string, unknown>);
  if (Object.keys(patch).length === 0) return null;
  return {
    type: MSG.PREFS_WRITE,
    scope: 'origin',
    patch,
  };
}
