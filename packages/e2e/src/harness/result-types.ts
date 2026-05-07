/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  name: string;
  status: TestStatus;
  error?: string;
  skipReason?: string;
  duration: number;
}

export interface SuiteResult {
  suite: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
}
