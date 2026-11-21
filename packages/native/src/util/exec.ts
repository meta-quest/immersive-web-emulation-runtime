/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export interface ExecResult {
  /** Exit code; null when the process could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary is missing (ENOENT) or timed out. */
  error?: 'not-found' | 'timeout' | 'failed';
}

export type Exec = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<ExecResult>;

/** Run a binary without a shell (no quoting pitfalls, no injection). */
export const defaultExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 15_000,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const e = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: unknown;
        };
        if (e.code === 'ENOENT')
          resolve({ code: null, stdout, stderr, error: 'not-found' });
        else if (e.killed)
          resolve({ code: null, stdout, stderr, error: 'timeout' });
        else
          resolve({
            code: typeof e.code === 'number' ? e.code : 1,
            stdout,
            stderr,
            error: 'failed',
          });
      },
    );
  });

export interface AdbLocation {
  /** What to execute: an absolute path or the bare name "adb" (PATH lookup). */
  command: string;
  /** Where it came from, for messages. */
  source: 'ADB' | 'ANDROID_HOME' | 'ANDROID_SDK_ROOT' | 'PATH';
}

/**
 * Pick the adb binary: `$ADB`, then the SDK's platform-tools, then PATH.
 * Does not run it; callers check it with `adb version`.
 */
export function locateAdb(
  env: NodeJS.ProcessEnv,
  isExecutable: (file: string) => boolean = canExecute,
): AdbLocation {
  if (env.ADB) return { command: env.ADB, source: 'ADB' };
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const source of ['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as const) {
    const sdk = env[source];
    if (!sdk) continue;
    const candidate = path.join(sdk, 'platform-tools', exe);
    if (isExecutable(candidate)) return { command: candidate, source };
  }
  return { command: 'adb', source: 'PATH' };
}

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface AdbDevice {
  serial: string;
  /** `device`, `unauthorized`, `offline`, … */
  state: string;
  model: string | null;
}

/** Parse `adb devices -l`. */
export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('List of devices') ||
      trimmed.startsWith('*')
    )
      continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const model =
      rest.find((r) => r.startsWith('model:'))?.slice('model:'.length) ?? null;
    devices.push({ serial, state, model });
  }
  return devices;
}

/** Parse the version out of `adb version`. */
export function parseAdbVersion(output: string): string | null {
  return /Android Debug Bridge version (\S+)/.exec(output)?.[1] ?? null;
}
