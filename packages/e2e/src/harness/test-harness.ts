/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestResult, SuiteResult, TestStatus } from './result-types.js';
import type { RuntimeMode } from './runtime-detect.js';
import type { XRDevice } from 'iwer';

export interface TestContext {
  mode: RuntimeMode;
  xrDevice?: XRDevice;
}

type TestFn = (ctx: TestContext) => void | Promise<void>;
type LifecycleFn = () => void | Promise<void>;

interface TestEntry {
  name: string;
  fn: TestFn;
  skip: boolean;
}

interface SuiteEntry {
  name: string;
  tests: TestEntry[];
  beforeAll: LifecycleFn[];
  afterAll: LifecycleFn[];
  beforeEach: LifecycleFn[];
  afterEach: LifecycleFn[];
}

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export class SkipError extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipError';
    this.reason = reason;
  }
}

const TEST_TIMEOUT_MS = 5000;

/**
 * Minimal test harness with zero external dependencies.
 * Runs in any browser including Quest 3.
 */
export class TestHarness {
  private suites: SuiteEntry[] = [];
  private currentSuite: SuiteEntry | null = null;
  private ctx: TestContext;

  constructor(ctx: TestContext) {
    this.ctx = ctx;
  }

  describe(name: string, fn: () => void): void {
    const suite: SuiteEntry = {
      name,
      tests: [],
      beforeAll: [],
      afterAll: [],
      beforeEach: [],
      afterEach: [],
    };
    const prevSuite = this.currentSuite;
    this.currentSuite = suite;
    fn();
    this.currentSuite = prevSuite;
    this.suites.push(suite);
  }

  it(name: string, fn: TestFn): void {
    if (!this.currentSuite) {
      throw new Error('it() must be called inside describe()');
    }
    this.currentSuite.tests.push({ name, fn, skip: false });
  }

  skip(name: string, _fn?: TestFn): void {
    if (!this.currentSuite) {
      throw new Error('skip() must be called inside describe()');
    }
    this.currentSuite.tests.push({
      name,
      fn: () => {},
      skip: true,
    });
  }

  beforeAll(fn: LifecycleFn): void {
    if (!this.currentSuite) {
      throw new Error('beforeAll() must be called inside describe()');
    }
    this.currentSuite.beforeAll.push(fn);
  }

  afterAll(fn: LifecycleFn): void {
    if (!this.currentSuite) {
      throw new Error('afterAll() must be called inside describe()');
    }
    this.currentSuite.afterAll.push(fn);
  }

  beforeEach(fn: LifecycleFn): void {
    if (!this.currentSuite) {
      throw new Error('beforeEach() must be called inside describe()');
    }
    this.currentSuite.beforeEach.push(fn);
  }

  afterEach(fn: LifecycleFn): void {
    if (!this.currentSuite) {
      throw new Error('afterEach() must be called inside describe()');
    }
    this.currentSuite.afterEach.push(fn);
  }

  // --- Skip support ---

  skipIf(condition: boolean, reason: string): void {
    if (condition) {
      throw new SkipError(reason);
    }
  }

  // --- Assertions ---

  assert(condition: boolean, msg: string): void {
    if (!condition) {
      throw new AssertionError(msg);
    }
  }

  assertEqual<T>(actual: T, expected: T, msg?: string): void {
    if (actual !== expected) {
      throw new AssertionError(
        msg ||
          `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  assertNotEqual<T>(actual: T, expected: T, msg?: string): void {
    if (actual === expected) {
      throw new AssertionError(
        msg || `Expected value to differ from ${JSON.stringify(expected)}`,
      );
    }
  }

  assertApprox(
    actual: number,
    expected: number,
    epsilon: number,
    msg?: string,
  ): void {
    if (Math.abs(actual - expected) > epsilon) {
      throw new AssertionError(
        msg || `Expected ~${expected} (±${epsilon}), got ${actual}`,
      );
    }
  }

  assertThrows(fn: () => void, errorType?: string, msg?: string): void {
    let threw = false;
    try {
      fn();
    } catch (e: any) {
      threw = true;
      if (
        errorType &&
        e.name !== errorType &&
        e.constructor.name !== errorType
      ) {
        throw new AssertionError(
          msg ||
            `Expected ${errorType} but got ${e.name || e.constructor.name}: ${e.message}`,
        );
      }
    }
    if (!threw) {
      throw new AssertionError(
        msg || `Expected function to throw${errorType ? ` ${errorType}` : ''}`,
      );
    }
  }

  async assertRejects(
    fn: () => Promise<any>,
    errorType?: string,
    msg?: string,
  ): Promise<void> {
    let threw = false;
    try {
      await fn();
    } catch (e: any) {
      threw = true;
      if (
        errorType &&
        e.name !== errorType &&
        e.constructor.name !== errorType
      ) {
        throw new AssertionError(
          msg ||
            `Expected ${errorType} but got ${e.name || e.constructor.name}: ${e.message}`,
        );
      }
    }
    if (!threw) {
      throw new AssertionError(
        msg ||
          `Expected promise to reject${errorType ? ` with ${errorType}` : ''}`,
      );
    }
  }

  assertInstanceOf(value: any, ctor: Function, msg?: string): void {
    if (!(value instanceof ctor)) {
      throw new AssertionError(
        msg ||
          `Expected instance of ${ctor.name}, got ${value?.constructor?.name || typeof value}`,
      );
    }
  }

  assertType(value: any, type: string, msg?: string): void {
    if (typeof value !== type) {
      throw new AssertionError(
        msg || `Expected typeof ${type}, got ${typeof value}`,
      );
    }
  }

  assertProperty(obj: any, prop: string, msg?: string): void {
    if (!(prop in obj)) {
      throw new AssertionError(
        msg || `Expected property "${prop}" to exist on object`,
      );
    }
  }

  assertTruthy(value: any, msg?: string): void {
    if (!value) {
      throw new AssertionError(
        msg || `Expected truthy value, got ${JSON.stringify(value)}`,
      );
    }
  }

  assertArray(value: any, msg?: string): void {
    if (!Array.isArray(value)) {
      throw new AssertionError(msg || `Expected array, got ${typeof value}`);
    }
  }

  assertGreaterThan(actual: number, expected: number, msg?: string): void {
    if (actual <= expected) {
      throw new AssertionError(msg || `Expected ${actual} > ${expected}`);
    }
  }

  assertReadonly(obj: any, prop: string, msg?: string): void {
    const original = obj[prop];
    try {
      obj[prop] = typeof original === 'number' ? original + 1 : 'test_sentinel';
    } catch (_) {
      // Setter threw — readonly confirmed
      return;
    }
    const unchanged = obj[prop] === original;
    if (!unchanged) {
      // Restore original if possible
      try {
        obj[prop] = original;
      } catch (_) {}
    }
    if (!unchanged) {
      throw new AssertionError(
        msg ||
          `Expected "${prop}" to be readonly, but assignment changed the value`,
      );
    }
  }

  assertFrozen(arr: any, msg?: string): void {
    if (!Object.isFrozen(arr)) {
      throw new AssertionError(msg || `Expected array to be frozen`);
    }
  }

  assertDOMException(fn: () => void, name: string, msg?: string): void {
    let threw = false;
    try {
      fn();
    } catch (e: any) {
      threw = true;
      const isDOMException =
        e instanceof DOMException || e.constructor?.name === 'DOMException';
      if (!isDOMException) {
        throw new AssertionError(
          msg ||
            `Expected DOMException but got ${e.constructor?.name || typeof e}: ${e.message}`,
        );
      }
      if (e.name !== name) {
        throw new AssertionError(
          msg ||
            `Expected DOMException with name "${name}" but got "${e.name}": ${e.message}`,
        );
      }
    }
    if (!threw) {
      throw new AssertionError(
        msg || `Expected function to throw DOMException("${name}")`,
      );
    }
  }

  async assertDOMExceptionAsync(
    fn: () => Promise<any>,
    name: string,
    msg?: string,
  ): Promise<void> {
    let threw = false;
    try {
      await fn();
    } catch (e: any) {
      threw = true;
      const isDOMException =
        e instanceof DOMException || e.constructor?.name === 'DOMException';
      if (!isDOMException) {
        throw new AssertionError(
          msg ||
            `Expected DOMException but got ${e.constructor?.name || typeof e}: ${e.message}`,
        );
      }
      if (e.name !== name) {
        throw new AssertionError(
          msg ||
            `Expected DOMException with name "${name}" but got "${e.name}": ${e.message}`,
        );
      }
    }
    if (!threw) {
      throw new AssertionError(
        msg || `Expected promise to reject with DOMException("${name}")`,
      );
    }
  }

  // --- Runner ---

  /** Returns the registered suite names in order. */
  getSuiteNames(): string[] {
    return this.suites.map((s) => s.name);
  }

  /** Runs a single suite by index and returns its result. */
  async runSuite(index: number): Promise<SuiteResult> {
    const suite = this.suites[index];
    if (!suite) {
      throw new Error(`No suite at index ${index}`);
    }

    const suiteStart = performance.now();
    const testResults: TestResult[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // Run beforeAll hooks
    let beforeAllError: string | undefined;
    try {
      for (const bfn of suite.beforeAll) {
        await bfn();
      }
    } catch (e: any) {
      beforeAllError = e.message || String(e);
    }

    // If beforeAll failed, mark all non-skipped tests as failed
    if (beforeAllError) {
      for (const test of suite.tests) {
        if (test.skip) {
          testResults.push({ name: test.name, status: 'skipped', duration: 0 });
          skipped++;
        } else {
          testResults.push({
            name: test.name,
            status: 'failed',
            error: `beforeAll failed: ${beforeAllError}`,
            duration: 0,
          });
          failed++;
        }
      }
    } else {
      for (const test of suite.tests) {
        if (test.skip) {
          testResults.push({
            name: test.name,
            status: 'skipped',
            duration: 0,
          });
          skipped++;
          continue;
        }

        const testStart = performance.now();
        let status: TestStatus = 'passed';
        let error: string | undefined;
        let skipReason: string | undefined;

        try {
          const testBody = async () => {
            for (const bfn of suite.beforeEach) {
              await bfn();
            }
            await test.fn(this.ctx);
          };

          await Promise.race([
            testBody(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(`Test timed out after ${TEST_TIMEOUT_MS}ms`),
                  ),
                TEST_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (e: any) {
          if (e instanceof SkipError) {
            status = 'skipped';
            skipReason = e.reason;
          } else {
            status = 'failed';
            error = e.message || String(e);
          }
        } finally {
          try {
            for (const afn of suite.afterEach) {
              await afn();
            }
          } catch (_) {
            // cleanup errors shouldn't mask test failures
          }
        }

        const duration = performance.now() - testStart;
        testResults.push({
          name: test.name,
          status,
          error,
          skipReason,
          duration,
        });
        if (status === 'passed') passed++;
        else if (status === 'skipped') skipped++;
        else failed++;
      }
    }

    // Run afterAll hooks
    try {
      for (const afn of suite.afterAll) {
        await afn();
      }
    } catch (_) {
      // afterAll errors shouldn't mask test failures
    }

    return {
      suite: suite.name,
      tests: testResults,
      passed,
      failed,
      skipped,
      duration: performance.now() - suiteStart,
    };
  }

  async run(suiteFilter?: string): Promise<SuiteResult[]> {
    const results: SuiteResult[] = [];
    const suitesToRun = suiteFilter
      ? this.suites
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => s.name.includes(suiteFilter!))
      : this.suites.map((s, i) => ({ s, i }));

    for (const { i } of suitesToRun) {
      results.push(await this.runSuite(i));
    }

    return results;
  }
}
