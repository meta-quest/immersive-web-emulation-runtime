/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The native-target section of `iwsdk.config.json` (key {@link NATIVE_CONFIG_KEY}).
 *
 * Everything here is JSON-safe and declarative. Secrets never live in this
 * file: signing names the environment variables that hold them.
 */
export const NATIVE_CONFIG_KEY = 'native' as const;

/** WebXR features the native target knows how to declare in the APK manifest. */
export const NATIVE_FEATURE_NAMES = [
  'handTracking',
  'anchors',
  'hitTest',
  'planeDetection',
  'meshDetection',
  'depthSensing',
  'passthrough',
  'gazeTracking',
  'camera',
] as const;
export type NativeFeatureName = (typeof NATIVE_FEATURE_NAMES)[number];

/**
 * How a feature is requested. `true` and `"optional"` mean the app works
 * without it; `"required"` (or `{ required: true }`) means the store and the
 * installer may refuse devices without it. `false` turns it off.
 */
export type NativeFeatureFlag =
  | boolean
  | 'required'
  | 'optional'
  | { required?: boolean };

/** OpenXR `XR_FB_foveation` levels. */
export const FOVEATION_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type FoveationLevel = (typeof FOVEATION_LEVELS)[number];

export type NativeFoveationOption =
  | FoveationLevel
  | { level?: FoveationLevel; dynamic?: boolean };

/**
 * Display refresh rates (Hz) the app may ask for: every rate a current Quest headset offers apps (Quest 2 and Pro:
 * 60, 72, 80, 90, 120; Quest 3 and 3S add 96 and 100). Which of them a given headset offers is only known on the
 * device (xrEnumerateDisplayRefreshRatesFB), so the runtime keeps its default rate when the headset lacks the one
 * asked for; the list here still catches typos (75) when the config is validated without a device.
 */
export const FRAME_RATES = [60, 72, 80, 90, 96, 100, 120] as const;
export type NativeFrameRate = (typeof FRAME_RATES)[number];

/** The named `native.splash.background` values; any `#rrggbb` / `#rgb` colour is accepted too. */
export const SPLASH_BACKGROUND_NAMES = ['black', 'contextual'] as const;

export interface NativeNetworkOptions {
  /**
   * Origins (`https://host[:port]`, optionally `https://*.host`) the runtime's
   * fetch may reach. Everything else is served from the APK or refused.
   */
  allow?: string[];
}

/**
 * The launch splash: Horizon OS's system splash while the app starts, then the
 * runtime's loading screen (the same image with an animated spinner) until
 * the app's first XR frame. On by default.
 */
export interface NativeSplashOptions {
  /**
   * Project-relative PNG to show. Default: generated from the icon and
   * `appName` (icon above the name on transparency, 1024x512).
   */
  image?: string;
  /**
   * What the system splash and the loading screen show behind the image.
   * `"black"`: always black (the default for apps without passthrough, i.e.
   * VR apps). `"contextual"`: the user's room for a user whose home is
   * passthrough, black otherwise (Horizon OS's `com.oculus.ossplash.background`
   * "passthrough-contextual" for the system splash; the runtime's own
   * passthrough layer, following the system's passthrough recommendation, for
   * the loading screen). It needs passthrough declared (`features.passthrough`,
   * which `world.xr.mode: "ar"` implies) and is the default for those apps.
   * `"#rrggbb"` or `"#rgb"`: that colour on the loading screen (the system
   * splash, which knows only black or contextual, stays black).
   */
  background?: string;
}

export interface NativeSigningOptions {
  /** Keystore file (PKCS#12, any extension). Project-relative or absolute. */
  keystore: string;
  /** Key alias inside the keystore. Defaults to the keystore's only key. */
  keyAlias?: string;
  /** NAME of the environment variable that holds the keystore password. */
  storePasswordEnv: string;
  /** NAME of the environment variable that holds the key password. Defaults to storePasswordEnv. */
  keyPasswordEnv?: string;
}

export interface NativeTargetConfig {
  /** Android application id, e.g. `com.example.showcase`. */
  packageId: string;
  /** Launcher label. Defaults to package.json `name`. */
  appName?: string;
  /** User-visible version (Android versionName). Defaults to package.json `version`. */
  version?: string;
  /** Monotonic integer version (Android versionCode). Derived from `version` when omitted. */
  versionCode?: number;
  /** Project-relative PNG or WebP launcher icon. */
  icon?: string;
  /**
   * Launch splash and loading screen. `false` turns the image and the spinner
   * off (until its first XR frame the app shows the default background alone).
   * Default: on, generated from the icon and app name.
   */
  splash?: boolean | NativeSplashOptions;
  /** Preferred display refresh rate in Hz. */
  frameRate?: NativeFrameRate;
  /** Fixed foveated rendering applied before the first frame. */
  foveation?: NativeFoveationOption;
  /**
   * WebXR features to declare. Defaults to the ones in `world.xr.features` (passthrough for `world.xr.mode: "ar"`,
   * camera for `world.features.camera`). `camera` is the passthrough cameras through `getUserMedia`.
   */
  features?: Partial<Record<NativeFeatureName, NativeFeatureFlag>>;
  /** Extra Android permissions, fully qualified. */
  permissions?: string[];
  network?: NativeNetworkOptions;
  /** Release signing. Omit to sign with a generated debug key (sideloading only). */
  signing?: NativeSigningOptions;
}

export type ConfigIssueCode =
  | 'conflict'
  | 'enum'
  | 'format'
  | 'invalid-path'
  | 'range'
  | 'required'
  | 'secret'
  | 'type'
  | 'unknown-key';

export interface ConfigIssue {
  /** JSONPath-like location, e.g. `$.native.signing.keystore`. */
  path: string;
  code: ConfigIssueCode;
  message: string;
}

export interface NativeConfigValidationResult {
  valid: boolean;
  /** Problems that stop a build. */
  errors: ConfigIssue[];
  /** Things that build but are probably not what the developer wants. */
  warnings: ConfigIssue[];
}

export type FeatureRequirement = 'required' | 'optional';

/** An Android manifest entry implied by a feature or permission. */
export interface ManifestFeature {
  name: string;
  required: boolean;
}

/** Fully defaulted target, ready for the packer. */
export interface ResolvedNativeTarget {
  packageId: string;
  appName: string;
  version: string;
  versionCode: number;
  icon: string | null;
  /**
   * The launch splash; `image` null: generated from the icon and app name; `background` is `"black"`,
   * `"contextual"` (only with passthrough declared) or a lowercase `#rrggbb` (with `enabled` false too: the
   * background without an image or spinner).
   */
  splash: { enabled: boolean; image: string | null; background: string };
  frameRate: NativeFrameRate | null;
  foveation: { level: FoveationLevel; dynamic: boolean };
  features: Partial<Record<NativeFeatureName, FeatureRequirement>>;
  /**
   * The features were derived (no `native.features`): from `world`, and at pack time from the dist (a non-IWSDK
   * bundle that calls `getUserMedia` gets `camera`). Absent or false: `native.features` is authoritative.
   */
  featuresDerived?: boolean;
  /** Sorted, de-duplicated `<uses-permission>` names. */
  permissions: string[];
  /** Sorted, de-duplicated `<uses-feature>` entries. */
  usesFeatures: ManifestFeature[];
  network: { allow: string[] };
  signing:
    | { mode: 'debug' }
    | {
        mode: 'release';
        keystore: string;
        keyAlias: string | null;
        storePasswordEnv: string;
        keyPasswordEnv: string;
      };
}
