/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export const STORAGE_KEY = 'iwe-prefs:v1';
export const ENABLED_DOMAINS_KEY = 'iwe-enabled-domains:v1';
export const WHATS_NEW_FLAG = 'iwe:seenWhatsNew:v2';
export const WELCOME_FLAG = 'iwe:seenWelcome';

export type DeviceId =
  | 'oculusQuest1'
  | 'metaQuest2'
  | 'metaQuestPro'
  | 'metaQuest3';
export type EnvironmentId =
  | 'living_room'
  | 'meeting_room'
  | 'music_room'
  | 'office_large'
  | 'office_small'
  | 'none';
export type InputMode = 'controller' | 'hand';
export type HandPoseId = 'default' | 'pinch' | 'point';
export type Handedness = 'left' | 'right';
export type KeyMapType = Partial<Record<Handedness, Record<string, string>>>;

export interface PoseTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface DefaultPose {
  headset: PoseTransform;
  controllers?: Partial<Record<Handedness, PoseTransform>>;
  hands?: Partial<Record<Handedness, PoseTransform>>;
}

export interface OriginPrefs {
  device: DeviceId;
  environment: EnvironmentId;
  inputMode: InputMode;
  stereoEnabled: boolean;
  ipd: number;
  fovy: number;
  keymap: KeyMapType;
  handPoses: Record<Handedness, HandPoseId>;
  defaultPose: DefaultPose | null;
  roomDimension: { x: number; y: number; z: number } | null;
  triggerMode: 'slow' | 'normal' | 'fast' | 'turbo';
  joystickSticky: boolean;
  actionMappingOn: boolean;
  agentAutoEnableEmulation: boolean;
}

export interface UiPrefs {
  seenWhatsNew?: boolean;
  seenWelcome?: boolean;
  lastInstallClient?: string;
}

export interface PrefsBlob {
  version: 1;
  global?: Partial<OriginPrefs>;
  ui?: UiPrefs;
  origins?: Record<string, Partial<OriginPrefs>>;
}

export type PrefsScope = 'origin' | 'global' | 'ui';
export type PrefsPatch = Partial<OriginPrefs> | Partial<UiPrefs>;

export const DEVICE_CATALOG: readonly DeviceId[] = [
  'oculusQuest1',
  'metaQuest2',
  'metaQuestPro',
  'metaQuest3',
];

export const ENVIRONMENT_CATALOG: readonly EnvironmentId[] = [
  'living_room',
  'meeting_room',
  'music_room',
  'office_large',
  'office_small',
  'none',
];

export const DEFAULT_KEYMAP: Readonly<KeyMapType> = Object.freeze({
  left: Object.freeze({
    'thumbstick-up': 'KeyW',
    'thumbstick-down': 'KeyS',
    'thumbstick-left': 'KeyA',
    'thumbstick-right': 'KeyD',
    thumbstick: 'KeyR',
    'x-button': 'KeyX',
    'y-button': 'KeyZ',
    trigger: 'KeyQ',
    squeeze: 'KeyE',
    pinch: 'MouseLeft',
    pose: 'KeyF',
  }),
  right: Object.freeze({
    'thumbstick-up': 'ArrowUp',
    'thumbstick-down': 'ArrowDown',
    'thumbstick-left': 'ArrowLeft',
    'thumbstick-right': 'ArrowRight',
    thumbstick: 'Slash',
    'a-button': 'Enter',
    'b-button': 'ShiftRight',
    trigger: 'MouseLeft',
    squeeze: 'MouseRight',
    pinch: 'MouseRight',
    pose: 'Backslash',
  }),
});

export const DEFAULTS: Readonly<OriginPrefs> = Object.freeze({
  device: 'metaQuest3',
  environment: 'living_room',
  inputMode: 'controller',
  stereoEnabled: false,
  ipd: 0.063,
  fovy: Math.PI / 2,
  keymap: DEFAULT_KEYMAP,
  handPoses: Object.freeze({ left: 'default', right: 'default' }),
  defaultPose: null,
  roomDimension: null,
  triggerMode: 'normal',
  joystickSticky: false,
  actionMappingOn: true,
  agentAutoEnableEmulation: false,
});

function clone<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, val]) => val !== undefined),
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function normalizePrefsBlob(value: unknown): PrefsBlob {
  if (!value || typeof value !== 'object') {
    return { version: 1, global: {}, ui: {}, origins: {} };
  }
  const blob = value as Partial<PrefsBlob>;
  if (blob.version !== 1) {
    return { version: 1, global: {}, ui: {}, origins: {} };
  }
  return {
    version: 1,
    global: compact((blob.global ?? {}) as Record<string, unknown>),
    ui: compact((blob.ui ?? {}) as Record<string, unknown>),
    origins: { ...(blob.origins ?? {}) },
  } as PrefsBlob;
}

export function mergeKeymap(
  ...layers: Array<KeyMapType | undefined>
): KeyMapType {
  const out: KeyMapType = {};
  for (const layer of layers) {
    for (const handedness of ['left', 'right'] as const) {
      if (!layer?.[handedness]) continue;
      out[handedness] = {
        ...(out[handedness] ?? {}),
        ...layer[handedness],
      };
    }
  }
  return out;
}

export function resolve<K extends keyof OriginPrefs>(
  blobInput: unknown,
  domain: string | null | undefined,
  key: K,
): OriginPrefs[K] {
  const blob = normalizePrefsBlob(blobInput);
  const origin = domain ? blob.origins?.[domain] : undefined;
  const globalPrefs = blob.global ?? {};
  if (key === 'keymap') {
    return mergeKeymap(
      DEFAULTS.keymap,
      globalPrefs.keymap,
      origin?.keymap,
    ) as OriginPrefs[K];
  }
  if (key === 'handPoses') {
    // Deep-merge like keymap: a partial override (e.g. only the left hand) must
    // still resolve to a complete { left, right } object, not drop the other.
    return {
      ...DEFAULTS.handPoses,
      ...globalPrefs.handPoses,
      ...origin?.handPoses,
    } as OriginPrefs[K];
  }
  return clone(
    (origin?.[key] ?? globalPrefs[key] ?? DEFAULTS[key]) as OriginPrefs[K],
  );
}

export function resolveAll(
  blobInput: unknown,
  domain: string | null | undefined,
): OriginPrefs {
  const out = {} as OriginPrefs;
  for (const key of Object.keys(DEFAULTS) as Array<keyof OriginPrefs>) {
    (out as unknown as Record<string, unknown>)[key] = resolve(
      blobInput,
      domain,
      key,
    );
  }
  return out;
}

export function isOverridden(
  blobInput: unknown,
  domain: string | null | undefined,
  key: keyof OriginPrefs,
): boolean {
  if (!domain) return false;
  const blob = normalizePrefsBlob(blobInput);
  return Object.prototype.hasOwnProperty.call(
    blob.origins?.[domain] ?? {},
    key,
  );
}

export interface MergePrefsOptions {
  resetKey?: keyof OriginPrefs;
  clear?: 'origin' | 'global' | 'all';
}

export function mergePrefs(
  blobInput: unknown,
  scope: PrefsScope,
  domain: string | null | undefined,
  patch: PrefsPatch = {},
  options: MergePrefsOptions = {},
): PrefsBlob {
  if (options.clear === 'all') {
    return { version: 1, global: {}, ui: {}, origins: {} };
  }
  const blob = normalizePrefsBlob(blobInput);
  const next: PrefsBlob = {
    version: 1,
    global: { ...(blob.global ?? {}) },
    ui: { ...(blob.ui ?? {}) },
    origins: { ...(blob.origins ?? {}) },
  };
  if (options.clear === 'global') {
    next.global = {};
    return next;
  }
  if (options.clear === 'origin' && domain) {
    delete next.origins?.[domain];
    return next;
  }
  if (scope === 'ui') {
    next.ui = { ...(next.ui ?? {}), ...(patch as Partial<UiPrefs>) };
    return next;
  }

  const target =
    scope === 'global'
      ? { ...(next.global ?? {}) }
      : { ...(domain ? next.origins?.[domain] : {}) };
  if (options.resetKey) {
    delete target[options.resetKey];
  } else {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === 'keymap') {
        target.keymap = mergeKeymap(
          target.keymap,
          value as KeyMapType | undefined,
        );
      } else if (key === 'handPoses') {
        target.handPoses = {
          ...(target.handPoses ?? {}),
          ...(value as OriginPrefs['handPoses']),
        };
      } else {
        (target as Record<string, unknown>)[key] = clone(value);
      }
    }
  }

  // Prune overrides that add nothing over what they'd inherit. Compare the
  // value RESOLVED WITH the override against the resolved baseline — keymap and
  // handPoses are deep-merged partials, so a raw deepEqual(target[key], ...)
  // would never match and they'd never prune.
  if (scope === 'global') {
    const baseline = resolveAll({ version: 1, global: {}, origins: {} }, null);
    const withTarget = resolveAll(
      { version: 1, global: target, origins: {} },
      null,
    );
    for (const key of Object.keys(target) as Array<keyof OriginPrefs>) {
      if (deepEqual(withTarget[key], baseline[key])) delete target[key];
    }
    next.global = target;
    return next;
  }
  if (!domain) return next;
  const inherited = resolveAll({ ...next, origins: {} }, null);
  const withTarget = resolveAll(
    { ...next, origins: { [domain]: target } },
    domain,
  );
  for (const key of Object.keys(target) as Array<keyof OriginPrefs>) {
    if (deepEqual(withTarget[key], inherited[key])) delete target[key];
  }
  if (Object.keys(target).length === 0) {
    delete next.origins?.[domain];
  } else {
    next.origins = { ...(next.origins ?? {}), [domain]: target };
  }
  return next;
}

export function majorOf(version: string | undefined): number {
  return Number.parseInt(String(version ?? '').split('.')[0] ?? '', 10) || 0;
}

export function shouldShowMovedNotice(
  previousVersion: string | undefined,
  currentVersion: string,
  seen: boolean,
): boolean {
  if (seen || !previousVersion || previousVersion === currentVersion) {
    return false;
  }
  return majorOf(previousVersion) < 2 && majorOf(currentVersion) >= 2;
}
