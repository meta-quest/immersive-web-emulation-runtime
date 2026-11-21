/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Node versions supported, matching IWSDK's `engines` (Vite 7's floor):
 * 20.19+, 22.12+, or 24+. Odd majors are not supported.
 */
export const SUPPORTED_NODE_RANGES: ReadonlyArray<{
  major: number;
  minMinor: number;
  orLater?: boolean;
}> = [
  { major: 20, minMinor: 19 },
  { major: 22, minMinor: 12 },
  { major: 24, minMinor: 0, orLater: true },
];

export const SUPPORTED_NODE_DESCRIPTION = '20.19+, 22.12+ or 24+';

export function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isSupportedNodeVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return SUPPORTED_NODE_RANGES.some((r) =>
    r.orLater
      ? major > r.major || (major === r.major && minor >= r.minMinor)
      : major === r.major && minor >= r.minMinor,
  );
}
