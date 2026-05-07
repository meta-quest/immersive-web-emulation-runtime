/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { test, expect } from '@playwright/test';
import type { SuiteResult } from '../src/harness/result-types';

test('WebXR spec compliance tests pass', async ({ page }) => {
  // Forward page errors to test output
  page.on('pageerror', (err) => console.error(`[browser] ${err.message}`));

  // Navigate to the test runner page
  await page.goto('http://localhost:5173/test-runner.html', {
    waitUntil: 'domcontentloaded',
  });

  // Wait for tests to complete
  await page.waitForFunction(
    () => (window as any).__E2E_DONE__ === true,
    null,
    { timeout: 60_000, polling: 500 },
  );

  // Extract results
  const results: SuiteResult[] = await page.evaluate(
    () => (window as any).__E2E_RESULTS__ as SuiteResult[],
  );

  expect(results.length).toBeGreaterThan(0);

  // Report results
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const failures: string[] = [];

  for (const suite of results) {
    totalPassed += suite.passed;
    totalFailed += suite.failed;
    totalSkipped += suite.skipped;

    for (const t of suite.tests) {
      if (t.status === 'failed') {
        failures.push(`[${suite.suite}] ${t.name}: ${t.error}`);
      }
    }
  }

  console.log(
    `\nResults: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`,
  );

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ✗ ${f}`);
    }
  }

  expect(failures).toEqual([]);
});
