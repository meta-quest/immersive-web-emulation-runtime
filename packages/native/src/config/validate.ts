/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {
  FOVEATION_LEVELS,
  FRAME_RATES,
  NATIVE_CONFIG_KEY,
  NATIVE_FEATURE_NAMES,
  SPLASH_BACKGROUND_NAMES,
  type ConfigIssue,
  type ConfigIssueCode,
  type NativeConfigValidationResult,
  type NativeTargetConfig,
} from './types.ts';

type JsonObject = Record<string, unknown>;

/** Keys accepted in the native section, in documentation order. */
export const NATIVE_CONFIG_KEYS = [
  'packageId',
  'appName',
  'version',
  'versionCode',
  'icon',
  'splash',
  'frameRate',
  'foveation',
  'features',
  'permissions',
  'network',
  'signing',
] as const;
export const NATIVE_CONFIG_REQUIRED_KEYS = ['packageId'] as const;
export const SPLASH_KEYS = ['image', 'background'] as const;
export const SIGNING_KEYS = [
  'keystore',
  'keyAlias',
  'storePasswordEnv',
  'keyPasswordEnv',
] as const;
export const SIGNING_REQUIRED_KEYS = ['keystore', 'storePasswordEnv'] as const;
export const NETWORK_KEYS = ['allow'] as const;
export const FOVEATION_KEYS = ['level', 'dynamic'] as const;

/** Largest versionCode Google Play and the Meta Horizon Store accept. */
export const MAX_VERSION_CODE = 2_100_000_000;

/** Image formats Android accepts for a launcher icon without conversion. */
const ICON_EXTENSIONS = ['.png', '.webp'];
/** Horizon OS reads the system splash as a PNG (assets/vr_splash.png). */
const SPLASH_EXTENSIONS = ['.png'];
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const KEYSTORE_EXTENSIONS = ['.jks', '.keystore', '.p12', '.pfx'];
/** Folders whose contents end up inside the APK: a keystore there would ship. */
const SHIPPED_FOLDERS = ['public', 'dist', 'dist-metavr'];

/** Java keywords and literals; aapt2 rejects them as package-name segments. */
const JAVA_RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'false', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'null', 'package', 'private', 'protected', 'public', 'return',
  'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'true', 'try', 'void', 'volatile', 'while',
]); // prettier-ignore

const PACKAGE_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PERMISSION_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
/** Keys that look like they hold a secret value instead of naming a variable. */
const SECRET_KEY = /(pass(word|phrase)?|secret|token|pin|credential)s?$/i;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Error carrying every problem found, one per line. */
export class NativeConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(
    issues: readonly ConfigIssue[],
    heading = 'Invalid native target config',
  ) {
    super(
      `${heading}:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`,
    );
    this.name = 'NativeConfigError';
    this.issues = issues;
  }
}

class Collector {
  readonly errors: ConfigIssue[] = [];
  readonly warnings: ConfigIssue[] = [];
  error(path: string, code: ConfigIssueCode, message: string): void {
    this.errors.push({ path, code, message });
  }
  warn(path: string, code: ConfigIssueCode, message: string): void {
    this.warnings.push({ path, code, message });
  }
  result(): NativeConfigValidationResult {
    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}

/**
 * Validate the native section of a whole `iwsdk.config.json` document.
 * Reports a helpful error when the section is missing.
 */
export function validateIwsdkConfigNativeSection(
  manifest: unknown,
): NativeConfigValidationResult {
  if (!isObject(manifest)) {
    const c = new Collector();
    c.error(
      '$',
      'type',
      `iwsdk.config.json must be a JSON object, got ${describe(manifest)}`,
    );
    return c.result();
  }
  if (!(NATIVE_CONFIG_KEY in manifest)) {
    const c = new Collector();
    c.error(
      `$.${NATIVE_CONFIG_KEY}`,
      'required',
      `iwsdk.config.json has no "${NATIVE_CONFIG_KEY}" section. Add at least ` +
        `{ "${NATIVE_CONFIG_KEY}": { "packageId": "com.yourcompany.yourapp" } }`,
    );
    return c.result();
  }
  return validateNativeTargetConfig(manifest[NATIVE_CONFIG_KEY], undefined, {
    world: manifest.world,
  });
}

/**
 * Validate the native section on its own. `context.world` is the document's
 * `world` section, for the checks that depend on the features it implies when
 * the native section declares none (validateIwsdkConfigNativeSection passes it).
 */
export function validateNativeTargetConfig(
  value: unknown,
  basePath = `$.${NATIVE_CONFIG_KEY}`,
  context?: { world?: unknown },
): NativeConfigValidationResult {
  const c = new Collector();
  reportSecretKeys(value, basePath, c);
  const root = objectValue(
    value,
    basePath,
    NATIVE_CONFIG_KEYS,
    NATIVE_CONFIG_REQUIRED_KEYS,
    c,
    undefined,
    isSecretKey,
  );
  if (root == null) return c.result();

  if ('packageId' in root)
    validatePackageId(root.packageId, `${basePath}.packageId`, c);
  if ('appName' in root)
    validateAppName(root.appName, `${basePath}.appName`, c);
  if ('version' in root)
    validateVersionName(root.version, `${basePath}.version`, c);
  if ('versionCode' in root)
    validateVersionCode(root.versionCode, `${basePath}.versionCode`, c);
  if ('icon' in root) validateIcon(root.icon, `${basePath}.icon`, c);
  if ('splash' in root) validateSplash(root.splash, `${basePath}.splash`, c);
  if ('frameRate' in root) {
    const p = `${basePath}.frameRate`;
    if (typeof root.frameRate !== 'number') {
      c.error(
        p,
        'type',
        `must be a number (Hz), one of ${FRAME_RATES.join(', ')}; got ${describe(root.frameRate)}`,
      );
    } else if (!(FRAME_RATES as readonly number[]).includes(root.frameRate)) {
      c.error(
        p,
        'enum',
        `${root.frameRate} Hz is not a headset refresh rate; use one of ${FRAME_RATES.join(', ')}`,
      );
    }
  }
  if ('foveation' in root)
    validateFoveation(root.foveation, `${basePath}.foveation`, c);
  if ('features' in root)
    validateFeatures(root.features, `${basePath}.features`, c);
  if ('permissions' in root)
    validatePermissions(root.permissions, `${basePath}.permissions`, c);
  if ('network' in root)
    validateNetwork(root.network, `${basePath}.network`, c);
  if ('signing' in root)
    validateSigning(root.signing, `${basePath}.signing`, c);
  checkContextualSplash(root, basePath, context, c);
  return c.result();
}

export function isNativeTargetConfig(
  value: unknown,
): value is NativeTargetConfig {
  return validateNativeTargetConfig(value).valid;
}

/** Throw a {@link NativeConfigError} listing every problem, or return the typed section. */
export function assertValidNativeTargetConfig(
  value: unknown,
): NativeTargetConfig {
  const result = validateNativeTargetConfig(value);
  if (!result.valid) throw new NativeConfigError(result.errors);
  return value as NativeTargetConfig;
}

// ---------------------------------------------------------------------------

function validatePackageId(value: unknown, p: string, c: Collector): void {
  if (typeof value !== 'string') {
    c.error(
      p,
      'type',
      `must be a string like "com.yourcompany.yourapp", got ${describe(value)}`,
    );
    return;
  }
  if (value.includes('-')) {
    c.error(
      p,
      'format',
      `"${value}" contains "-": Android package ids allow letters, digits, "_" and "."; try "${value.replace(/-/g, '_')}"`,
    );
    return;
  }
  const segments = value.split('.');
  if (segments.length < 2) {
    c.error(
      p,
      'format',
      `"${value}" needs at least two dot-separated segments, e.g. "com.yourcompany.${value || 'yourapp'}"`,
    );
    return;
  }
  for (const segment of segments) {
    if (segment === '') {
      c.error(
        p,
        'format',
        `"${value}" has an empty segment (leading, trailing or doubled ".")`,
      );
      return;
    }
    if (!PACKAGE_SEGMENT.test(segment)) {
      c.error(
        p,
        'format',
        `segment "${segment}" of "${value}" must start with a letter and contain only letters, digits and "_"`,
      );
      return;
    }
    if (JAVA_RESERVED.has(segment)) {
      c.error(
        p,
        'format',
        `segment "${segment}" of "${value}" is a Java keyword, which Android rejects; rename it (e.g. "${segment}app")`,
      );
      return;
    }
  }
  if (value.length > 255)
    c.error(
      p,
      'range',
      `is ${value.length} characters long; keep it under 256`,
    );
  if (/^com\.example(\.|$)/.test(value)) {
    c.warn(
      p,
      'format',
      `"${value}" uses the com.example namespace: fine for sideloading, but stores reject it`,
    );
  }
}

function validateAppName(value: unknown, p: string, c: Collector): void {
  if (typeof value !== 'string') {
    c.error(p, 'type', `must be a string, got ${describe(value)}`);
  } else if (value.trim() === '') {
    c.error(p, 'required', 'must not be empty (it is the launcher label)');
  } else if (CONTROL_CHARS.test(value)) {
    c.error(p, 'format', 'must not contain control characters or line breaks');
  } else if (value.length > 50) {
    c.warn(
      p,
      'range',
      `is ${value.length} characters; launchers truncate long labels (keep it under 50)`,
    );
  }
}

function validateVersionName(value: unknown, p: string, c: Collector): void {
  if (typeof value !== 'string') {
    c.error(p, 'type', `must be a string like "1.2.0", got ${describe(value)}`);
  } else if (value.trim() === '') {
    c.error(p, 'required', 'must not be empty');
  } else if (CONTROL_CHARS.test(value)) {
    c.error(p, 'format', 'must not contain control characters or line breaks');
  } else if (value.length > 100) {
    c.error(p, 'range', `is ${value.length} characters; keep it under 100`);
  }
}

function validateVersionCode(value: unknown, p: string, c: Collector): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    c.error(p, 'type', `must be a whole number, got ${describe(value)}`);
  } else if (!Number.isInteger(value)) {
    c.error(p, 'type', `must be a whole number, got ${value}`);
  } else if (value < 1 || value > MAX_VERSION_CODE) {
    c.error(
      p,
      'range',
      `must be between 1 and ${MAX_VERSION_CODE}, got ${value}`,
    );
  }
}

function validateSplash(value: unknown, p: string, c: Collector): void {
  if (typeof value === 'boolean') return; // true: the default splash; false: none
  const o = objectValue(
    value,
    p,
    SPLASH_KEYS,
    [],
    c,
    'true, false or { "image", "background" }',
  );
  if (o == null) return;
  if ('image' in o) {
    const ip = `${p}.image`;
    const rel = projectRelativePath(o.image, ip, c, 'splash');
    if (rel != null) {
      const ext = path.posix.extname(rel).toLowerCase();
      if (!SPLASH_EXTENSIONS.includes(ext))
        c.error(
          ip,
          'format',
          `must be a PNG image (Horizon OS reads the system splash as vr_splash.png), got "${ext || 'no extension'}"`,
        );
    }
  }
  if ('background' in o) {
    // "black", "contextual" (Horizon OS's passthrough-contextual; needs passthrough, checkContextualSplash) or a
    // colour for the loading screen.
    const bp = `${p}.background`;
    const names = SPLASH_BACKGROUND_NAMES as readonly string[];
    if (typeof o.background !== 'string')
      c.error(
        bp,
        'type',
        `must be "black", "contextual" or a colour like "#000000", got ${describe(o.background)}`,
      );
    else if (!names.includes(o.background) && !HEX_COLOR.test(o.background))
      c.error(
        bp,
        'format',
        `"${o.background}" is not "black", "contextual" or a colour ("#rrggbb" or "#rgb", e.g. "#000000")${suggest(o.background, names)}`,
      );
  }
}

/**
 * `splash.background: "contextual"` shows the user's room behind the splash
 * and the loading screen, which only an app that declares passthrough can do:
 * the runtime shows it with its own passthrough layer (XR_FB_passthrough,
 * which Horizon OS offers only to apps whose manifest declares
 * com.oculus.feature.PASSTHROUGH). The features come from the native section,
 * else from `world` (`world.xr.mode: "ar"` implies passthrough); with neither
 * known (the native section alone) there is nothing to check.
 */
function checkContextualSplash(
  root: JsonObject,
  p: string,
  context: { world?: unknown } | undefined,
  c: Collector,
): void {
  if (!isObject(root.splash) || root.splash.background !== 'contextual') return;
  let declared: boolean;
  if ('features' in root) {
    if (!isObject(root.features)) return; // reported by validateFeatures
    const flag = root.features.passthrough;
    declared = flag !== undefined && flag !== false;
  } else if (context) {
    const world = context.world;
    declared = isObject(world) && isObject(world.xr) && world.xr.mode === 'ar';
  } else {
    return;
  }
  if (!declared)
    c.error(
      `${p}.splash.background`,
      'conflict',
      `"contextual" shows the user's room behind the splash, which needs passthrough: add "passthrough": "optional" to "features" (world.xr.mode "ar" implies it), or use "black"`,
    );
}

function validateIcon(value: unknown, p: string, c: Collector): void {
  const rel = projectRelativePath(value, p, c, 'icon');
  if (rel == null) return;
  const ext = path.posix.extname(rel).toLowerCase();
  if (!ICON_EXTENSIONS.includes(ext)) {
    c.error(
      p,
      'format',
      `must be a ${ICON_EXTENSIONS.join(' or ')} image, got "${ext || 'no extension'}"`,
    );
  }
}

function validateFoveation(value: unknown, p: string, c: Collector): void {
  if (typeof value === 'string') {
    enumString(value, p, FOVEATION_LEVELS, c);
    return;
  }
  const o = objectValue(
    value,
    p,
    FOVEATION_KEYS,
    [],
    c,
    `a level (${FOVEATION_LEVELS.map((l) => `"${l}"`).join(', ')}) or { "level", "dynamic" }`,
  );
  if (o == null) return;
  if ('level' in o) {
    if (typeof o.level !== 'string')
      c.error(
        `${p}.level`,
        'type',
        `must be a string, got ${describe(o.level)}`,
      );
    else enumString(o.level, `${p}.level`, FOVEATION_LEVELS, c);
  }
  if ('dynamic' in o && typeof o.dynamic !== 'boolean') {
    c.error(
      `${p}.dynamic`,
      'type',
      `must be true or false, got ${describe(o.dynamic)}`,
    );
  }
  if (o.level === 'none' && o.dynamic === true) {
    c.warn(p, 'enum', 'dynamic foveation has no effect with level "none"');
  }
}

function validateFeatures(value: unknown, p: string, c: Collector): void {
  const o = objectValue(value, p, NATIVE_FEATURE_NAMES, [], c);
  if (o == null) return;
  for (const [name, flag] of Object.entries(o)) {
    const fp = `${p}.${name}`;
    if (typeof flag === 'boolean' || flag === 'required' || flag === 'optional')
      continue;
    if (typeof flag === 'string') {
      c.error(
        fp,
        'enum',
        `must be true, false, "required" or "optional", got "${flag}"${suggest(flag, ['required', 'optional'])}`,
      );
      continue;
    }
    const fo = objectValue(
      flag,
      fp,
      ['required'],
      [],
      c,
      'true, false, "required", "optional" or { "required": boolean }',
    );
    if (fo != null && 'required' in fo && typeof fo.required !== 'boolean') {
      c.error(
        `${fp}.required`,
        'type',
        `must be true or false, got ${describe(fo.required)}`,
      );
    }
  }
}

function validatePermissions(value: unknown, p: string, c: Collector): void {
  if (!Array.isArray(value)) {
    c.error(
      p,
      'type',
      `must be an array of permission names, got ${describe(value)}`,
    );
    return;
  }
  const seen = new Set<string>();
  value.forEach((perm, i) => {
    const ip = `${p}[${i}]`;
    if (typeof perm !== 'string') {
      c.error(ip, 'type', `must be a string, got ${describe(perm)}`);
    } else if (!PERMISSION_NAME.test(perm)) {
      const hint = /^[A-Z_]+$/.test(perm)
        ? `; did you mean "android.permission.${perm}"?`
        : '';
      c.error(
        ip,
        'format',
        `"${perm}" is not a fully qualified permission name${hint}`,
      );
    } else if (seen.has(perm)) {
      c.warn(ip, 'format', `"${perm}" is listed twice`);
    } else {
      seen.add(perm);
    }
  });
}

function validateNetwork(value: unknown, p: string, c: Collector): void {
  const o = objectValue(value, p, NETWORK_KEYS, [], c);
  if (o == null || !('allow' in o)) return;
  const ap = `${p}.allow`;
  if (!Array.isArray(o.allow)) {
    c.error(
      ap,
      'type',
      `must be an array of origins like "https://cdn.example.com", got ${describe(o.allow)}`,
    );
    return;
  }
  o.allow.forEach((entry, i) => validateOrigin(entry, `${ap}[${i}]`, c));
}

function validateOrigin(value: unknown, p: string, c: Collector): void {
  if (typeof value !== 'string') {
    c.error(
      p,
      'type',
      `must be an origin string like "https://cdn.example.com", got ${describe(value)}`,
    );
    return;
  }
  if (value === '*' || value === 'https://*') {
    c.error(
      p,
      'format',
      'a catch-all origin defeats the allowlist; list the origins the app fetches from',
    );
    return;
  }
  const wildcard = value.match(/^(https?):\/\/\*\.(.+)$/);
  const probe = wildcard ? `${wildcard[1]}://wildcard.${wildcard[2]}` : value;
  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    c.error(
      p,
      'format',
      `"${value}" is not a valid origin; expected "https://host" or "https://*.host"`,
    );
    return;
  }
  if (url.hostname.includes('*') || (value.includes('*') && !wildcard)) {
    c.error(
      p,
      'format',
      `"${value}": "*" is only allowed as the whole first label, as in "https://*.example.com"`,
    );
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    c.error(p, 'format', `"${value}": only https origins are supported`);
    return;
  }
  if (url.username || url.password) {
    c.error(p, 'secret', 'must not contain credentials');
    return;
  }
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    /\/./.test(value.replace(/^https?:\/\//, ''))
  ) {
    c.error(
      p,
      'format',
      `"${value}" must be an origin only (scheme, host, optional port), without a path; use "${url.protocol}//${wildcard ? '*.' + wildcard[2].split('/')[0] : url.host}"`,
    );
    return;
  }
  if (url.protocol === 'http:') {
    const local =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    if (local) {
      c.warn(
        p,
        'format',
        `"${value}" is cleartext; fine for adb-reversed dev servers only`,
      );
    } else {
      c.error(
        p,
        'format',
        `"${value}" uses cleartext http, which Android blocks by default; use https`,
      );
    }
  }
}

function validateSigning(value: unknown, p: string, c: Collector): void {
  reportSecretKeys(value, p, c);
  const o = objectValue(
    value,
    p,
    SIGNING_KEYS,
    SIGNING_REQUIRED_KEYS,
    c,
    undefined,
    isSecretKey,
  );
  if (o == null) return;
  if ('keystore' in o) validateKeystore(o.keystore, `${p}.keystore`, c);
  if ('keyAlias' in o) {
    if (typeof o.keyAlias !== 'string')
      c.error(
        `${p}.keyAlias`,
        'type',
        `must be a string, got ${describe(o.keyAlias)}`,
      );
    else if (o.keyAlias.trim() === '')
      c.error(
        `${p}.keyAlias`,
        'required',
        "must not be empty; omit it to use the keystore's only key",
      );
  }
  for (const key of ['storePasswordEnv', 'keyPasswordEnv'] as const) {
    if (key in o) validateEnvName(o[key], `${p}.${key}`, c);
  }
}

function validateKeystore(value: unknown, p: string, c: Collector): void {
  if (typeof value !== 'string') {
    c.error(
      p,
      'type',
      `must be a path to a .jks or .p12 keystore, got ${describe(value)}`,
    );
    return;
  }
  if (value.trim() === '') {
    c.error(p, 'required', 'must not be empty');
    return;
  }
  if (!path.isAbsolute(value)) {
    const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
    const top = normalized.replace(/^\.\//, '').split('/')[0];
    if (SHIPPED_FOLDERS.includes(top)) {
      c.error(
        p,
        'invalid-path',
        `the keystore is under "${top}/", which is copied into the app; move it outside the project or into an ignored folder`,
      );
      return;
    }
  }
  const ext = path.extname(value).toLowerCase();
  if (!KEYSTORE_EXTENSIONS.includes(ext)) {
    c.warn(
      p,
      'format',
      `unusual keystore extension "${ext || 'none'}"; expected ${KEYSTORE_EXTENSIONS.join(', ')}`,
    );
  }
}

function validateEnvName(value: unknown, p: string, c: Collector): void {
  if (typeof value !== 'string') {
    c.error(
      p,
      'type',
      `must be the NAME of an environment variable, got ${describe(value)}`,
    );
  } else if (!ENV_VAR_NAME.test(value)) {
    // Do not echo the value: a developer may have pasted the password here.
    c.error(
      p,
      'secret',
      'must be the NAME of an environment variable (letters, digits and "_", e.g. IWER_NATIVE_STORE_PASSWORD), ' +
        'not the password itself. If you pasted a password here, remove it and rotate it.',
    );
  } else if (value !== value.toUpperCase()) {
    c.warn(
      p,
      'format',
      `"${value}": environment variable names are conventionally UPPER_SNAKE_CASE`,
    );
  }
}

// ---------------------------------------------------------------------------

function isSecretKey(key: string): boolean {
  return !key.endsWith('Env') && SECRET_KEY.test(key);
}

/** Flag keys that look like they carry a secret value. Never echoes the value. */
function reportSecretKeys(value: unknown, p: string, c: Collector): void {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!isSecretKey(key)) continue;
    c.error(
      `${p}.${key}`,
      'secret',
      `secrets must never be written in iwsdk.config.json (it is committed and read by build tools). ` +
        `Remove "${key}", put the value in an environment variable, and name that variable in ` +
        `"signing.storePasswordEnv" / "signing.keyPasswordEnv". If this was a real secret, rotate it.`,
    );
  }
}

function projectRelativePath(
  value: unknown,
  p: string,
  c: Collector,
  what: string,
): string | null {
  if (typeof value !== 'string') {
    c.error(
      p,
      'type',
      `must be a project-relative path string, got ${describe(value)}`,
    );
    return null;
  }
  if (value.trim() === '') {
    c.error(p, 'required', 'must not be empty');
    return null;
  }
  const slashed = value.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(slashed) ||
    /^[A-Za-z]:\//.test(slashed) ||
    /^[a-z]+:\/\//i.test(slashed)
  ) {
    c.error(
      p,
      'invalid-path',
      `the ${what} must be a path inside the project, like "./public/${what}.png", not "${value}"`,
    );
    return null;
  }
  const normalized = path.posix.normalize(slashed);
  if (normalized === '..' || normalized.startsWith('../')) {
    c.error(
      p,
      'invalid-path',
      `"${value}" points outside the project; keep the ${what} inside it`,
    );
    return null;
  }
  return normalized;
}

function enumString(
  value: string,
  p: string,
  allowed: readonly string[],
  c: Collector,
): void {
  if (!allowed.includes(value)) {
    c.error(
      p,
      'enum',
      `"${value}" is not one of ${allowed.map((a) => `"${a}"`).join(', ')}${suggest(value, allowed)}`,
    );
  }
}

function objectValue(
  value: unknown,
  p: string,
  allowed: readonly string[],
  required: readonly string[],
  c: Collector,
  expected = 'an object',
  skipUnknown: (key: string) => boolean = () => false,
): JsonObject | null {
  if (!isObject(value)) {
    c.error(p, 'type', `must be ${expected}, got ${describe(value)}`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && !skipUnknown(key)) {
      c.error(
        `${p}.${key}`,
        'unknown-key',
        `unknown key "${key}"${suggest(key, allowed)}; allowed: ${allowed.join(', ')}`,
      );
    }
  }
  for (const key of required) {
    if (!(key in value))
      c.error(`${p}.${key}`, 'required', `"${key}" is required`);
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string`;
  return typeof value === 'object'
    ? 'an object'
    : `${typeof value} ${String(value)}`;
}

/** ` (did you mean "x"?)` for the closest candidate within a small edit distance. */
export function suggest(input: string, candidates: readonly string[]): string {
  const lower = input.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d =
      candidate.toLowerCase() === lower
        ? 0
        : editDistance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  const limit = Math.max(2, Math.floor(input.length / 4));
  return best != null && bestDistance <= limit
    ? ` (did you mean "${best}"?)`
    : '';
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}
