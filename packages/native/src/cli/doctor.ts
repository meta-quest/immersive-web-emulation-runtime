/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { IWSDK_CONFIG_FILE, loadNativeProject } from '../config/load.ts';
import { NativeConfigError } from '../config/validate.ts';
import {
  checkoutTemplatePath,
  openBundledTemplate,
  packageRoot,
  readBundledTemplate,
  readPinnedTemplate,
} from '../../packager/src/template.ts';
import {
  locateAdb,
  parseAdbDevices,
  parseAdbVersion,
  type Exec,
} from '../util/exec.ts';
import {
  isSupportedNodeVersion,
  SUPPORTED_NODE_DESCRIPTION,
} from '../util/node-version.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: 'node' | 'adb' | 'devices' | 'config' | 'signing-env' | 'template';
  status: CheckStatus;
  summary: string;
  /** What to do about it. */
  hint?: string;
  details?: string[];
}

export interface DoctorContext {
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  exec: Exec;
  /** Override for tests. */
  isExecutable?: (file: string) => boolean;
  /** Package root whose packager/templates.json and bundled template are checked (tests). */
  templateRoot?: string;
}

/** Run every check. Never throws; failures become `fail` checks. */
export async function runDoctor(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(
    isSupportedNodeVersion(ctx.nodeVersion)
      ? { id: 'node', status: 'ok', summary: `Node ${ctx.nodeVersion}` }
      : {
          id: 'node',
          status: 'fail',
          summary: `Node ${ctx.nodeVersion} is not supported`,
          hint: `Install Node ${SUPPORTED_NODE_DESCRIPTION} (the same range IWSDK needs).`,
        },
  );

  const adb = locateAdb(ctx.env, ctx.isExecutable);
  const version = await ctx.exec(adb.command, ['version'], {
    timeoutMs: 10_000,
  });
  const adbVersion =
    version.code === 0 ? parseAdbVersion(version.stdout) : null;
  if (adbVersion == null) {
    const why =
      version.error === 'not-found'
        ? `not found (looked at ${adb.source === 'PATH' ? 'PATH' : `$${adb.source}: ${adb.command}`})`
        : version.error === 'timeout'
          ? 'did not answer `adb version` within 10 s'
          : `\`${adb.command} version\` failed${version.stderr.trim() ? `: ${version.stderr.trim().split('\n')[0]}` : ''}`;
    checks.push({
      id: 'adb',
      status: 'fail',
      summary: `adb ${why}`,
      hint:
        'install and run need adb (pack does not). Install Android platform-tools and put adb on PATH, ' +
        'or set $ADB to its full path.',
    });
    checks.push({
      id: 'devices',
      status: 'skip',
      summary: 'no adb, so no device check',
    });
  } else {
    checks.push({
      id: 'adb',
      status: 'ok',
      summary: `adb ${adbVersion} (${adb.source === 'PATH' ? 'from PATH' : `from $${adb.source}`})`,
    });
    const listed = await ctx.exec(adb.command, ['devices', '-l'], {
      timeoutMs: 10_000,
    });
    checks.push(
      deviceCheck(listed.code === 0 ? listed.stdout : null, listed.stderr),
    );
  }

  checks.push(...configChecks(ctx));
  checks.push(templateCheck(ctx));
  return checks;
}

/** Which template `pack` will use, with the bundled template's checksum verified. */
export function templateCheck(ctx: DoctorContext): DoctorCheck {
  const explicit = ctx.env.IWER_NATIVE_TEMPLATE;
  if (explicit)
    return existsSync(explicit)
      ? {
          id: 'template',
          status: 'ok',
          summary: `template APK: ${explicit} (from $IWER_NATIVE_TEMPLATE)`,
        }
      : {
          id: 'template',
          status: 'fail',
          summary: `template APK: $IWER_NATIVE_TEMPLATE points at ${explicit}, which does not exist`,
          hint: 'Unset IWER_NATIVE_TEMPLATE to use the template bundled with @iwer/native.',
        };
  const root = ctx.templateRoot ?? packageRoot();
  try {
    const bundled = readBundledTemplate(root);
    if (bundled) {
      const loaded = openBundledTemplate(root);
      if (!loaded)
        return {
          id: 'template',
          status: 'fail',
          summary: `template APK: the bundled template is missing (${bundled.file})`,
          hint: 'Reinstall @iwer/native (npm install @iwer/native@alpha).',
        };
      return {
        id: 'template',
        status: 'ok',
        summary: `template APK: bundled, runtime ${bundled.version}, sha256 verified (${loaded.sha256.slice(0, 16)}...)`,
      };
    }
    const pinned = readPinnedTemplate(root);
    if (pinned)
      return {
        id: 'template',
        status: 'ok',
        summary: `template APK: runtime ${pinned.version}, downloaded on first pack (sha256 ${pinned.sha256.slice(0, 16)}...)`,
      };
  } catch (e) {
    return {
      id: 'template',
      status: 'fail',
      summary: `template APK: ${(e as Error).message.split('\n')[0]}`,
      hint: 'Reinstall @iwer/native (npm install @iwer/native@alpha), or pass --template <apk> to pack.',
    };
  }
  if (existsSync(checkoutTemplatePath(root)))
    return {
      id: 'template',
      status: 'ok',
      summary: 'template APK: built in this checkout',
    };
  return {
    id: 'template',
    status: 'warn',
    summary: 'template APK: none available, so pack needs --template <apk>',
    hint: 'This @iwer/native copy carries no template (a source checkout?). Install the published package or pass --template.',
  };
}

function deviceCheck(output: string | null, stderr: string): DoctorCheck {
  if (output == null) {
    return {
      id: 'devices',
      status: 'warn',
      summary: `\`adb devices\` failed: ${stderr.trim() || 'no output'}`,
    };
  }
  const devices = parseAdbDevices(output);
  const ready = devices.filter((d) => d.state === 'device');
  const details = devices.map(
    (d) => `${d.serial} ${d.state}${d.model ? ` (${d.model})` : ''}`,
  );
  if (devices.length === 0) {
    return {
      id: 'devices',
      status: 'warn',
      summary: 'no headset connected',
      hint: 'connect the headset over USB (or `adb connect <ip>`) and enable developer mode to install and run.',
    };
  }
  if (ready.length === 0) {
    const unauthorized = devices.some((d) => d.state === 'unauthorized');
    return {
      id: 'devices',
      status: 'warn',
      summary: `${devices.length} device(s) connected, none ready`,
      hint: unauthorized
        ? 'put the headset on and accept the "Allow USB debugging" prompt.'
        : 'reconnect the device; `adb kill-server` can help with offline devices.',
      details,
    };
  }
  return {
    id: 'devices',
    status: 'ok',
    summary: `${ready.length} device(s) ready${ready.length > 1 ? '; pass --serial to pick one' : ''}`,
    details,
  };
}

function configChecks(ctx: DoctorContext): DoctorCheck[] {
  const configPath = path.join(ctx.projectRoot, IWSDK_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return [
      {
        id: 'config',
        status: 'skip',
        summary: `no ${IWSDK_CONFIG_FILE} in ${ctx.projectRoot}; pass --project <dir> to check one`,
      },
    ];
  }
  try {
    // A debug machine usually has no release keystore: its absence is a warning here, as for pack (release only).
    const loaded = loadNativeProject(ctx.projectRoot, { requireKeystore: false });
    const checks: DoctorCheck[] = [
      {
        id: 'config',
        status: loaded.warnings.length > 0 ? 'warn' : 'ok',
        summary: `native target ${loaded.target.packageId} ${loaded.target.version} (${loaded.target.versionCode})`,
        details: loaded.warnings.map((w) => `${w.path}: ${w.message}`),
      },
    ];
    const signing = loaded.target.signing;
    if (signing.mode === 'release') {
      const names = [
        ...new Set([signing.storePasswordEnv, signing.keyPasswordEnv]),
      ];
      // Unset, not empty: pack accepts an empty password.
      const missing = names.filter((n) => ctx.env[n] === undefined);
      checks.push(
        missing.length === 0
          ? {
              id: 'signing-env',
              status: 'ok',
              summary: `release signing: ${names.join(', ')} set`,
            }
          : {
              id: 'signing-env',
              status: 'warn',
              summary: `release signing: ${missing.join(', ')} not set (needed for pack --release only)`,
              hint: 'export the keystore password(s) in those variables before pack --release (never in iwsdk.config.json).',
            },
      );
    } else {
      checks.push({
        id: 'signing-env',
        status: 'ok',
        summary:
          'debug signing (sideloading only); add "signing" for store builds',
      });
    }
    return checks;
  } catch (error) {
    if (error instanceof NativeConfigError) {
      const missingSection =
        error.issues.length === 1 &&
        error.issues[0].code === 'required' &&
        error.issues[0].path === '$.native';
      return [
        {
          id: 'config',
          status: missingSection ? 'warn' : 'fail',
          summary: missingSection
            ? 'iwsdk.config.json has no "native" section (needed by pack)'
            : 'native target config is invalid',
          details: error.issues.map((i) => `${i.path}: ${i.message}`),
        },
      ];
    }
    return [
      {
        id: 'config',
        status: 'fail',
        summary: `could not check config: ${(error as Error).message}`,
      },
    ];
  }
}
