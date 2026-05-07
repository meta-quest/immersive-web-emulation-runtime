/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { TestHarness } from '@harness/test-harness';
import { detectRuntime, hasNativeXR } from '@harness/runtime-detect';
import { UIReporter } from '@harness/ui-reporter';
import { setupIwer } from '@setup/iwer-setup';
import type { XRDevice } from 'iwer';
import type { SuiteResult } from '@harness/result-types';

// Import all test suites
import { registerXRSystemTests } from '@suites/xr-system.spec';
import { registerXRSessionTests } from '@suites/xr-session.spec';
import { registerXRRenderStateTests } from '@suites/xr-render-state.spec';
import { registerXRFrameTests } from '@suites/xr-frame.spec';
import { registerXRSpaceTests } from '@suites/xr-space.spec';
import { registerXRBoundedRefSpaceTests } from '@suites/xr-bounded-ref-space.spec';
import { registerXRViewTests } from '@suites/xr-view.spec';
import { registerXRRigidTransformTests } from '@suites/xr-rigid-transform.spec';
import { registerXRPoseTests } from '@suites/xr-pose.spec';
import { registerXRInputSourceTests } from '@suites/xr-input-source.spec';
import { registerXRLayerTests } from '@suites/xr-layer.spec';
import { registerXREventsTests } from '@suites/xr-events.spec';
import { registerXRRayTests } from '@suites/xr-ray.spec';
import { registerXRHandTrackingTests } from '@suites/xr-hand-tracking.spec';
import { registerXRAnchorsTests } from '@suites/xr-anchors.spec';
import { registerXRHitTestTests } from '@suites/xr-hit-test.spec';
import { registerXRPlanesTests } from '@suites/xr-planes.spec';
import { registerXRMeshesTests } from '@suites/xr-meshes.spec';

declare global {
  interface Window {
    __E2E_RESULTS__: SuiteResult[];
    __E2E_DONE__: boolean;
  }
}

function registerAll(harness: TestHarness) {
  registerXRSystemTests(harness);
  registerXRSessionTests(harness);
  registerXRRenderStateTests(harness);
  registerXRFrameTests(harness);
  registerXRSpaceTests(harness);
  registerXRBoundedRefSpaceTests(harness);
  registerXRViewTests(harness);
  registerXRRigidTransformTests(harness);
  registerXRPoseTests(harness);
  registerXRInputSourceTests(harness);
  registerXRLayerTests(harness);
  registerXREventsTests(harness);
  registerXRRayTests(harness);
  registerXRHandTrackingTests(harness);
  registerXRAnchorsTests(harness);
  registerXRHitTestTests(harness);
  registerXRPlanesTests(harness);
  registerXRMeshesTests(harness);
}

async function main() {
  let xrDevice: XRDevice | undefined;

  const nativeXR = await hasNativeXR();
  if (!nativeXR) {
    xrDevice = await setupIwer();
  }

  const mode = detectRuntime();
  const harness = new TestHarness({ mode, xrDevice });
  const reporter = new UIReporter();

  registerAll(harness);

  if (nativeXR) {
    // Native headset: show interactive suite picker
    const names = harness.getSuiteNames();
    const allResults: SuiteResult[] = [];
    const completed = new Set<number>();
    let running = false;

    reporter.renderSuiteList(names, async (index: number) => {
      if (running || completed.has(index)) return;
      running = true;
      reporter.markSuiteRunning(index);

      try {
        const result = await harness.runSuite(index);
        allResults.push(result);
        completed.add(index);
        reporter.updateSuiteResult(index, result);

        // Update results progressively for Playwright
        window.__E2E_RESULTS__ = [...allResults];

        if (completed.size === names.length) {
          reporter.markAllDone(allResults);
          window.__E2E_DONE__ = true;
        }
      } finally {
        running = false;
      }
    });
  } else {
    // iwer: auto-run all suites
    const results = await harness.run();
    reporter.renderResults(results);
    window.__E2E_RESULTS__ = results;
    window.__E2E_DONE__ = true;
  }
}

main().catch((err) => {
  console.error('E2E test runner failed:', err);
  document.body.innerHTML = `<pre style="color:red;padding:16px">${err.stack || err.message}</pre>`;
  window.__E2E_DONE__ = true;
  window.__E2E_RESULTS__ = [];
});
