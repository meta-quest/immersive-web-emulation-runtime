/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  FEATURE_MANIFEST,
  INTERNET_PERMISSION,
  IWSDK_FEATURE_ALIASES,
} from './features.ts';
import {
  NATIVE_CONFIG_KEY,
  SPLASH_BACKGROUND_NAMES,
  type FeatureRequirement,
  type ManifestFeature,
  type NativeFeatureFlag,
  type NativeFeatureName,
  type NativeTargetConfig,
  type ResolvedNativeTarget,
} from './types.ts';
import {
  MAX_VERSION_CODE,
  NativeConfigError,
  validateIwsdkConfigNativeSection,
} from './validate.ts';

export interface PackageJsonLike {
  name?: unknown;
  version?: unknown;
}

export interface ResolveOptions {
  /** The project's package.json, for appName/version defaults. */
  packageJson?: PackageJsonLike | null;
}

/** Default when neither the native section nor package.json gives a version. */
export const DEFAULT_VERSION = '1.0.0';

/**
 * Validate the native section of a whole `iwsdk.config.json` and fill in every
 * default the packer needs. Throws {@link NativeConfigError} on invalid input.
 */
export function resolveNativeTarget(
  manifest: unknown,
  options: ResolveOptions = {},
): ResolvedNativeTarget {
  const result = validateIwsdkConfigNativeSection(manifest);
  if (!result.valid) throw new NativeConfigError(result.errors);
  const doc = manifest as Record<string, unknown>;
  const native = doc[NATIVE_CONFIG_KEY] as NativeTargetConfig;
  const pkg = options.packageJson ?? {};

  const version =
    native.version ??
    (typeof pkg.version === 'string' && pkg.version.trim() !== ''
      ? pkg.version
      : DEFAULT_VERSION);
  const versionCode = native.versionCode ?? deriveVersionCode(version);

  const features = native.features
    ? normalizeFeatures(native.features)
    : featuresFromWorld(doc.world);

  const allow = [...new Set(native.network?.allow ?? [])];
  const needs = manifestNeeds(features, native.permissions ?? [], allow);

  const foveation =
    typeof native.foveation === 'string'
      ? { level: native.foveation, dynamic: false }
      : {
          level: native.foveation?.level ?? 'none',
          dynamic: native.foveation?.dynamic ?? false,
        };

  return {
    packageId: native.packageId,
    appName: native.appName ?? defaultAppName(pkg.name, native.packageId),
    version,
    versionCode,
    icon: native.icon ?? null,
    splash: resolveSplash(native.splash, features),
    frameRate: native.frameRate ?? null,
    foveation,
    features,
    featuresDerived: !native.features,
    ...needs,
    network: { allow },
    signing: native.signing
      ? {
          mode: 'release',
          keystore: native.signing.keystore,
          keyAlias: native.signing.keyAlias ?? null,
          storePasswordEnv: native.signing.storePasswordEnv,
          keyPasswordEnv:
            native.signing.keyPasswordEnv ?? native.signing.storePasswordEnv,
        }
      : { mode: 'debug' },
  };
}

/**
 * The manifest entries for a feature set: each feature's permissions and
 * `<uses-feature>` names (required if any feature needing it is), the extra
 * permissions, and INTERNET with a non-empty network allowlist.
 */
function manifestNeeds(
  features: Partial<Record<NativeFeatureName, FeatureRequirement>>,
  extraPermissions: readonly string[],
  allow: readonly string[],
): Pick<ResolvedNativeTarget, 'permissions' | 'usesFeatures'> {
  const permissions = new Set<string>(extraPermissions);
  const usesFeatures = new Map<string, boolean>();
  for (const [name, requirement] of Object.entries(features) as [
    NativeFeatureName,
    FeatureRequirement,
  ][]) {
    const needs = FEATURE_MANIFEST[name];
    for (const perm of needs.permissions) permissions.add(perm);
    for (const feature of needs.usesFeatures) {
      usesFeatures.set(
        feature,
        (usesFeatures.get(feature) ?? false) || requirement === 'required',
      );
    }
  }
  if (allow.length > 0) permissions.add(INTERNET_PERMISSION);
  return {
    permissions: [...permissions].sort(),
    usesFeatures: [...usesFeatures]
      .map(([name, required]): ManifestFeature => ({ name, required }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * `target` with one more feature and its manifest entries (pack-time
 * derivation from the dist). A feature it already has keeps its requirement.
 */
export function withFeature(
  target: ResolvedNativeTarget,
  name: NativeFeatureName,
  requirement: FeatureRequirement,
): ResolvedNativeTarget {
  if (target.features[name]) return target;
  const features = { ...target.features, [name]: requirement };
  // target.permissions already holds the other features' permissions, the extra ones and INTERNET
  return {
    ...target,
    features,
    ...manifestNeeds(features, target.permissions, []),
  };
}

/**
 * Default background of the system splash and the loading screen for apps
 * without passthrough (VR apps): black, Horizon OS's own default.
 */
export const DEFAULT_SPLASH_BACKGROUND = 'black';

/**
 * The default `native.splash.background` for an app's features:
 * `"contextual"` when it declares passthrough (`features.passthrough`, which
 * `world.xr.mode: "ar"` implies): the user's room behind the splash for a user
 * whose home is passthrough, as Meta recommends for mixed reality apps;
 * `"black"` otherwise (only an app with passthrough can show the room itself).
 */
export function defaultSplashBackground(
  features: Partial<Record<NativeFeatureName, FeatureRequirement>> = {},
): string {
  return features.passthrough ? 'contextual' : DEFAULT_SPLASH_BACKGROUND;
}

/** `#rgb` / `#rrggbb` (validated) → lowercase `#rrggbb`. */
export function normalizeHexColor(color: string): string {
  const hex = color.slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((ch) => ch + ch).join('') : hex}`;
}

/** A validated `native.splash.background` → `"black"`, `"contextual"` or lowercase `#rrggbb`. */
export function normalizeSplashBackground(background: string): string {
  return (SPLASH_BACKGROUND_NAMES as readonly string[]).includes(background)
    ? background
    : normalizeHexColor(background);
}

export function resolveSplash(
  splash: NativeTargetConfig['splash'],
  features: Partial<Record<NativeFeatureName, FeatureRequirement>> = {},
): ResolvedNativeTarget['splash'] {
  const background = defaultSplashBackground(features);
  // `false` drops the image and the spinner, not the background behind them.
  if (splash === false) return { enabled: false, image: null, background };
  const o = typeof splash === 'object' && splash !== null ? splash : {};
  return {
    enabled: true,
    image: o.image ?? null,
    background: o.background
      ? normalizeSplashBackground(o.background)
      : background,
  };
}

/**
 * `major.minor.patch` → `major * 1_000_000 + minor * 1_000 + patch`, so later
 * releases always get larger codes. Pre-release tags are ignored. Throws when
 * the version is not plain semver or does not fit; then set `versionCode`.
 */
export function deriveVersionCode(version: string): number {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  const fail = (why: string) =>
    new NativeConfigError([
      {
        path: `$.${NATIVE_CONFIG_KEY}.versionCode`,
        code: 'required',
        message: `cannot derive a versionCode from version "${version}" (${why}); set "versionCode" explicitly`,
      },
    ]);
  if (!match) throw fail('not major.minor.patch');
  const [major, minor, patch] = match.slice(1).map(Number);
  if (minor > 999 || patch > 999)
    throw fail('minor and patch must be below 1000');
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (code > MAX_VERSION_CODE) throw fail(`exceeds ${MAX_VERSION_CODE}`);
  return Math.max(1, code);
}

function normalizeFlag(
  flag: NativeFeatureFlag | undefined,
): FeatureRequirement | null {
  if (flag === undefined || flag === false) return null;
  if (flag === true || flag === 'optional') return 'optional';
  if (flag === 'required') return 'required';
  return flag.required ? 'required' : 'optional';
}

function normalizeFeatures(
  features: Partial<Record<NativeFeatureName, NativeFeatureFlag>>,
): Partial<Record<NativeFeatureName, FeatureRequirement>> {
  const out: Partial<Record<NativeFeatureName, FeatureRequirement>> = {};
  for (const [name, flag] of Object.entries(features) as [
    NativeFeatureName,
    NativeFeatureFlag,
  ][]) {
    const requirement = normalizeFlag(flag);
    if (requirement) out[name] = requirement;
  }
  return out;
}

/**
 * Derive features from IWSDK's `world` (already validated by IWSDK): `world.xr`
 * (AR mode implies passthrough) and `world.features.camera` (IWSDK's camera
 * feature, getUserMedia over the passthrough cameras).
 */
export function featuresFromWorld(
  world: unknown,
): Partial<Record<NativeFeatureName, FeatureRequirement>> {
  const out: Partial<Record<NativeFeatureName, FeatureRequirement>> = {};
  const w = world as
    | { xr?: { mode?: unknown; features?: unknown }; features?: unknown }
    | undefined;
  const xr = w?.xr;
  if (xr?.features && typeof xr.features === 'object') {
    for (const [key, flag] of Object.entries(
      xr.features as Record<string, unknown>,
    )) {
      const name = IWSDK_FEATURE_ALIASES[key];
      if (!name) continue;
      const requirement =
        typeof flag === 'object' && flag !== null
          ? normalizeFlag({
              required: (flag as { required?: unknown }).required === true,
            })
          : normalizeFlag(flag === true ? true : undefined);
      if (requirement && out[name] !== 'required') out[name] = requirement;
    }
  }
  if (xr?.mode === 'ar') out.passthrough = 'required';
  const camera =
    w?.features && typeof w.features === 'object'
      ? (w.features as Record<string, unknown>).camera
      : undefined;
  // IWSDK starts the camera on demand (CameraSource), and the app runs without it
  if (camera !== undefined && camera !== false && camera !== null)
    out.camera = 'optional';
  return out;
}

function defaultAppName(name: unknown, packageId: string): string {
  if (typeof name === 'string' && name.trim() !== '') {
    return name.replace(/^@[^/]+\//, '');
  }
  return packageId.split('.').pop() ?? packageId;
}
