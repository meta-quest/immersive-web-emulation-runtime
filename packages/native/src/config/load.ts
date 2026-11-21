/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveNativeTarget, type PackageJsonLike } from './resolve.ts';
import {
  NATIVE_CONFIG_KEY,
  type ConfigIssue,
  type ResolvedNativeTarget,
} from './types.ts';
import {
  NativeConfigError,
  validateIwsdkConfigNativeSection,
} from './validate.ts';

export const IWSDK_CONFIG_FILE = 'iwsdk.config.json';

export interface LoadedNativeProject {
  projectRoot: string;
  configPath: string;
  target: ResolvedNativeTarget;
  /** Absolute paths of referenced files (they exist). */
  files: { icon: string | null; keystore: string | null; splash: string | null };
  warnings: ConfigIssue[];
}

/**
 * Read `iwsdk.config.json` (and `package.json` for defaults) from a project,
 * validate the native section, check referenced files exist, and resolve
 * defaults. Throws {@link NativeConfigError} with every problem found.
 */
export interface LoadNativeProjectOptions {
  /**
   * Whether a missing `signing.keystore` file is an error (default true).
   * Debug packs never use the release keystore, so they pass false: the
   * keystore usually lives only on release machines, while its path and
   * env-var names are committed in iwsdk.config.json (PKG-7).
   */
  requireKeystore?: boolean;
}

export function loadNativeProject(
  projectRoot: string,
  options: LoadNativeProjectOptions = {},
): LoadedNativeProject {
  const root = path.resolve(projectRoot);
  const configPath = path.join(root, IWSDK_CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new NativeConfigError(
      [
        {
          path: configPath,
          code: 'required',
          message: `no ${IWSDK_CONFIG_FILE} here; run this from an IWSDK project or pass --project <dir>`,
        },
      ],
      'Not an IWSDK project',
    );
  }
  const manifest = readJson(configPath);
  const pkgPath = path.join(root, 'package.json');
  const packageJson = existsSync(pkgPath)
    ? (readJson(pkgPath) as PackageJsonLike)
    : null;

  const validation = validateIwsdkConfigNativeSection(manifest);
  const errors = [...validation.errors];
  const native = (manifest as Record<string, unknown>)?.[NATIVE_CONFIG_KEY] as
    | {
        icon?: unknown;
        splash?: { image?: unknown };
        signing?: { keystore?: unknown };
      }
    | undefined;

  // File checks only make sense for values that passed the shape checks.
  const files = {
    icon: null as string | null,
    keystore: null as string | null,
    splash: null as string | null,
  };
  const failedPaths = new Set(errors.map((e) => e.path));
  if (
    typeof native?.icon === 'string' &&
    !failedPaths.has(`$.${NATIVE_CONFIG_KEY}.icon`)
  ) {
    files.icon = checkFile(
      root,
      native.icon,
      `$.${NATIVE_CONFIG_KEY}.icon`,
      'icon',
      errors,
    );
  }
  const splashImage =
    typeof native?.splash === 'object' && native.splash !== null
      ? native.splash.image
      : undefined;
  if (
    typeof splashImage === 'string' &&
    !failedPaths.has(`$.${NATIVE_CONFIG_KEY}.splash.image`)
  ) {
    files.splash = checkFile(
      root,
      splashImage,
      `$.${NATIVE_CONFIG_KEY}.splash.image`,
      'splash image',
      errors,
    );
  }
  const keystore = native?.signing?.keystore;
  if (
    typeof keystore === 'string' &&
    !failedPaths.has(`$.${NATIVE_CONFIG_KEY}.signing.keystore`)
  ) {
    const keystoreIssues: ConfigIssue[] = [];
    files.keystore = checkFile(
      root,
      keystore,
      `$.${NATIVE_CONFIG_KEY}.signing.keystore`,
      'keystore',
      keystoreIssues,
    );
    if (options.requireKeystore === false)
      validation.warnings.push(
        ...keystoreIssues.map((issue) => ({
          ...issue,
          message: `${issue.message} (only needed for release builds)`,
        })),
      );
    else errors.push(...keystoreIssues);
  }
  if (errors.length > 0) {
    throw new NativeConfigError(
      errors,
      `Invalid native target in ${configPath}`,
    );
  }

  const target = resolveNativeTarget(manifest, { packageJson });
  return {
    projectRoot: root,
    configPath,
    target,
    files,
    warnings: validation.warnings,
  };
}

function checkFile(
  root: string,
  file: string,
  p: string,
  what: string,
  errors: ConfigIssue[],
): string | null {
  const absolute = path.resolve(root, file);
  if (!existsSync(absolute)) {
    errors.push({
      path: p,
      code: 'invalid-path',
      message: `${what} file not found: ${absolute}`,
    });
    return null;
  }
  if (!statSync(absolute).isFile()) {
    errors.push({
      path: p,
      code: 'invalid-path',
      message: `${what} path is not a file: ${absolute}`,
    });
    return null;
  }
  return absolute;
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new NativeConfigError(
      [
        {
          path: file,
          code: 'invalid-path',
          message: `cannot read: ${(error as Error).message}`,
        },
      ],
      'Unreadable file',
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new NativeConfigError(
      [
        {
          path: file,
          code: 'format',
          message: `is not valid JSON: ${(error as Error).message}`,
        },
      ],
      'Invalid JSON',
    );
  }
}
