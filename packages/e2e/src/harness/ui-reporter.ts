/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { SuiteResult, TestResult } from './result-types.js';

/**
 * DOM-based reporter for displaying test results.
 * Works in any browser including Quest 3.
 */
export class UIReporter {
  private container: HTMLElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'e2e-results';
    Object.assign(this.container.style, {
      fontFamily: 'monospace',
      fontSize: '14px',
      padding: '16px',
      maxWidth: '960px',
      margin: '0 auto',
    });
    document.body.appendChild(this.container);
  }

  renderResults(suites: SuiteResult[]): void {
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalDuration = 0;

    for (const s of suites) {
      totalPassed += s.passed;
      totalFailed += s.failed;
      totalSkipped += s.skipped;
      totalDuration += s.duration;
    }

    const summaryColor = totalFailed > 0 ? '#e74c3c' : '#27ae60';
    this.container.innerHTML = `
			<h1 style="margin:0 0 8px">WebXR Spec E2E Tests</h1>
			<div style="color:${summaryColor};font-size:18px;margin-bottom:16px">
				${totalPassed} passed · ${totalFailed} failed · ${totalSkipped} skipped · ${totalDuration.toFixed(0)}ms
			</div>
		`;

    for (const suite of suites) {
      this.container.appendChild(this.renderSuite(suite));
    }
  }

  private renderSuite(suite: SuiteResult): HTMLElement {
    const section = document.createElement('details');
    section.open = suite.failed > 0;

    const summary = document.createElement('summary');
    const statusIcon = suite.failed > 0 ? '✗' : '✓';
    const statusColor = suite.failed > 0 ? '#e74c3c' : '#27ae60';
    summary.innerHTML = `
			<span style="color:${statusColor};font-weight:bold">${statusIcon}</span>
			<strong>${suite.suite}</strong>
			<span style="color:#888">(${suite.passed}/${suite.tests.length} passed, ${suite.duration.toFixed(0)}ms)</span>
		`;
    section.appendChild(summary);

    const list = document.createElement('ul');
    list.style.listStyle = 'none';
    list.style.paddingLeft = '24px';

    for (const test of suite.tests) {
      list.appendChild(this.renderTest(test));
    }

    section.appendChild(list);
    return section;
  }

  // --- Interactive suite picker (native headset) ---

  private suiteRows: HTMLElement[] = [];
  private runningIndex: number | null = null;

  /**
   * Renders a scrollable list of suites, each with a name and "Enter XR" button.
   * Clicking the button calls onRun(index) and disables all buttons while running.
   */
  renderSuiteList(names: string[], onRun: (index: number) => void): void {
    this.container.innerHTML = '';

    const header = document.createElement('h1');
    header.style.margin = '0 0 4px';
    header.textContent = 'WebXR E2E Tests';
    this.container.appendChild(header);

    const subheader = document.createElement('div');
    Object.assign(subheader.style, {
      color: '#888',
      marginBottom: '16px',
      fontSize: '14px',
    });
    subheader.textContent = 'Tap a group to enter XR and run tests';
    this.container.appendChild(subheader);

    this.suiteRows = [];

    for (let i = 0; i < names.length; i++) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        borderBottom: '1px solid #333',
        background: i % 2 === 0 ? '#1a1a2e' : '#16213e',
      });

      const label = document.createElement('span');
      label.textContent = names[i];
      label.style.color = '#fff';
      row.appendChild(label);

      const btn = document.createElement('button');
      btn.textContent = 'Enter XR';
      btn.dataset.index = String(i);
      Object.assign(btn.style, {
        padding: '8px 16px',
        fontSize: '14px',
        border: '2px solid #fff',
        borderRadius: '6px',
        background: 'transparent',
        color: '#fff',
        cursor: 'pointer',
        flexShrink: '0',
        marginLeft: '12px',
      });
      btn.addEventListener(
        'click',
        () => {
          onRun(i);
        },
        { once: true },
      );
      row.appendChild(btn);

      this.container.appendChild(row);
      this.suiteRows.push(row);
    }
  }

  /**
   * Disables all suite buttons while a suite is running, and shows a running indicator.
   */
  markSuiteRunning(index: number): void {
    this.runningIndex = index;
    for (const row of this.suiteRows) {
      const btn = row.querySelector('button');
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.4';
        btn.style.cursor = 'default';
      }
    }
    const runningRow = this.suiteRows[index];
    if (runningRow) {
      const btn = runningRow.querySelector('button');
      if (btn) {
        btn.textContent = 'Running…';
        btn.style.opacity = '1';
        btn.style.borderColor = '#f39c12';
        btn.style.color = '#f39c12';
      }
    }
  }

  /**
   * Replaces a suite's row with pass/fail summary and expandable test details.
   * Re-enables buttons on suites that haven't been run yet.
   */
  updateSuiteResult(index: number, result: SuiteResult): void {
    this.runningIndex = null;
    const row = this.suiteRows[index];
    if (!row) return;

    // Replace row content with result summary
    row.innerHTML = '';
    Object.assign(row.style, {
      display: 'block',
      padding: '10px 12px',
    });

    const details = document.createElement('details');
    details.open = result.failed > 0;

    const summary = document.createElement('summary');
    summary.style.cursor = 'pointer';
    const statusIcon = result.failed > 0 ? '✗' : '✓';
    const statusColor = result.failed > 0 ? '#e74c3c' : '#27ae60';
    summary.innerHTML = `
			<span style="color:${statusColor};font-weight:bold">${statusIcon}</span>
			<strong style="color:#fff">${result.suite}</strong>
			<span style="color:#888">${result.passed}/${result.tests.length} passed (${result.duration.toFixed(0)}ms)</span>
		`;
    details.appendChild(summary);

    const list = document.createElement('ul');
    list.style.listStyle = 'none';
    list.style.paddingLeft = '24px';
    for (const test of result.tests) {
      list.appendChild(this.renderTest(test));
    }
    details.appendChild(list);
    row.appendChild(details);

    // Re-enable buttons on rows that haven't been run yet
    for (const r of this.suiteRows) {
      const btn = r.querySelector('button');
      if (btn && !btn.disabled) continue;
      // Only re-enable if still has a button (hasn't been replaced with results)
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.style.borderColor = '#fff';
        btn.style.color = '#fff';
        btn.textContent = 'Enter XR';
      }
    }
  }

  /**
   * Shows a final summary header when all suites have been run.
   */
  markAllDone(results: SuiteResult[]): void {
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalDuration = 0;

    for (const s of results) {
      totalPassed += s.passed;
      totalFailed += s.failed;
      totalSkipped += s.skipped;
      totalDuration += s.duration;
    }

    const summaryColor = totalFailed > 0 ? '#e74c3c' : '#27ae60';
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      color: summaryColor,
      fontSize: '18px',
      margin: '16px 0',
      padding: '12px',
      border: `2px solid ${summaryColor}`,
      borderRadius: '8px',
      textAlign: 'center',
    });
    banner.textContent = `All done: ${totalPassed} passed · ${totalFailed} failed · ${totalSkipped} skipped · ${totalDuration.toFixed(0)}ms`;

    // Insert after the subheader (before first suite row)
    const firstRow = this.suiteRows[0];
    if (firstRow) {
      this.container.insertBefore(banner, firstRow);
    } else {
      this.container.appendChild(banner);
    }
  }

  private renderTest(test: TestResult): HTMLElement {
    const li = document.createElement('li');
    li.style.margin = '2px 0';

    const colors: Record<string, string> = {
      passed: '#27ae60',
      failed: '#e74c3c',
      skipped: '#f39c12',
    };
    const icons: Record<string, string> = {
      passed: '✓',
      failed: '✗',
      skipped: '○',
    };

    li.innerHTML = `
			<span style="color:${colors[test.status]}">${icons[test.status]}</span>
			${test.name}
			${test.skipReason ? `<span style="color:#f39c12;font-size:12px"> — ${test.skipReason}</span>` : ''}
			<span style="color:#888">(${test.duration.toFixed(0)}ms)</span>
		`;

    if (test.error) {
      const err = document.createElement('pre');
      Object.assign(err.style, {
        color: '#e74c3c',
        fontSize: '12px',
        margin: '4px 0 4px 20px',
        whiteSpace: 'pre-wrap',
      });
      err.textContent = test.error;
      li.appendChild(err);
    }

    return li;
  }
}
