/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface GoldenCase {
  name: string;
  w: number;
  h: number;
  tolerance?: number;
  draw(ctx: any, env: any): void;
}
export const cases: GoldenCase[];
export const metricCases: { font: string; text: string; baseline: string; align: string }[];
export const METRIC_KEYS: string[];
export function drawChecker(ctx: any): void;
