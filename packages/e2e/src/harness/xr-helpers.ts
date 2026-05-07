/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { RuntimeMode } from './runtime-detect.js';
import type { XRDevice } from 'iwer';
import {
  createWebGLContext,
  makeXRCompatible,
  destroyWebGLContext,
} from './webgl-helper.js';

export interface TestContext {
  mode: RuntimeMode;
  xrDevice?: XRDevice;
}

/**
 * Ensure the browser has transient user activation, which is required
 * by native WebXR for immersive session requests.
 * In iwer mode this is a no-op. On native hardware, shows a
 * "Tap to continue" overlay when activation has expired.
 */
async function ensureUserActivation(mode: XRSessionMode): Promise<void> {
  // Only immersive modes require user activation
  if (mode === 'inline') return;
  // iwer doesn't enforce user activation
  if ((globalThis as any).__IWER_INJECTED__) return;
  // Already have transient activation
  if (navigator.userActivation?.isActive) return;

  return new Promise<void>((resolve) => {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      background: 'rgba(0,0,0,0.85)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '99999',
      cursor: 'pointer',
    });
    overlay.innerHTML = `
			<div style="text-align:center;color:#fff;font-family:system-ui,sans-serif">
				<div style="font-size:24px;margin-bottom:8px">Tap to continue</div>
				<div style="font-size:14px;opacity:0.7">User activation required for XR session</div>
			</div>
		`;
    document.body.appendChild(overlay);

    overlay.addEventListener(
      'click',
      () => {
        document.body.removeChild(overlay);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Request an XR session with a WebGL layer already configured.
 * Waits for the first frame so renderState is applied.
 */
export async function startSession(
  mode: XRSessionMode,
  options?: XRSessionInit,
): Promise<{
  session: XRSession;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
}> {
  const { canvas, gl } = createWebGLContext();
  await makeXRCompatible(gl);
  await ensureUserActivation(mode);

  const session = await navigator.xr!.requestSession(mode, options);

  const layer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: layer });

  // Wait one frame for renderState to be applied
  await new Promise<void>((resolve) => {
    session.requestAnimationFrame(() => resolve());
  });

  return { session, gl, canvas };
}

/**
 * Request an XR session WITHOUT setting baseLayer or waiting for a frame.
 * Useful for testing initial renderState defaults (baseLayer=null, etc.).
 */
export async function startSessionRaw(
  mode: XRSessionMode,
  options?: XRSessionInit,
): Promise<{
  session: XRSession;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
}> {
  const { canvas, gl } = createWebGLContext();
  await makeXRCompatible(gl);
  await ensureUserActivation(mode);

  const session = await navigator.xr!.requestSession(mode, options);

  return { session, gl, canvas };
}

/**
 * Run a callback inside an XR animation frame.
 * Returns whatever the callback returns.
 */
export function withFrame<T>(
  session: XRSession,
  fn: (time: DOMHighResTimeStamp, frame: XRFrame) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    session.requestAnimationFrame((time, frame) => {
      try {
        resolve(fn(time, frame));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * End a session and wait for the 'end' event to ensure iwer clears
 * its internal activeSession tracking before creating a new one.
 */
async function endSession(session: XRSession): Promise<void> {
  return new Promise<void>((resolve) => {
    const onEnd = () => {
      session.removeEventListener('end', onEnd);
      resolve();
    };
    session.addEventListener('end', onEnd);
    session.end().catch(() => {
      // Already ended — still wait briefly for event
      setTimeout(resolve, 0);
    });
  });
}

/**
 * Clean up a session and its associated WebGL context.
 */
export async function cleanup(
  session: XRSession | null,
  canvas: HTMLCanvasElement | null,
): Promise<void> {
  if (session) {
    try {
      await endSession(session);
    } catch (_) {
      // already ended
    }
  }
  if (canvas) {
    destroyWebGLContext(canvas);
  }
}

// --- Device manipulation helpers (iwer-only) ---

/**
 * Press a button on a controller and advance one frame.
 */
export async function pressButton(
  ctx: TestContext,
  session: XRSession,
  hand: 'left' | 'right',
  button: string,
): Promise<void> {
  const controller = ctx.xrDevice!.controllers[hand];
  if (controller) {
    controller.updateButtonValue(button, 1.0);
    await withFrame(session, () => {});
  }
}

/**
 * Release a button on a controller and advance one frame.
 */
export async function releaseButton(
  ctx: TestContext,
  session: XRSession,
  hand: 'left' | 'right',
  button: string,
): Promise<void> {
  const controller = ctx.xrDevice!.controllers[hand];
  if (controller) {
    controller.updateButtonValue(button, 0.0);
    await withFrame(session, () => {});
  }
}

/**
 * Advance n sequential animation frames.
 */
export async function advanceFrames(
  session: XRSession,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await withFrame(session, () => {});
  }
}

/**
 * Switch the XR device to hand input mode and advance one frame
 * to trigger the inputsourceschange event.
 */
export async function switchToHandInput(
  ctx: TestContext,
  session: XRSession,
): Promise<void> {
  ctx.xrDevice!.primaryInputMode = 'hand';
  await withFrame(session, () => {});
}

/**
 * Switch the XR device back to controller input mode and advance one frame
 * to trigger the inputsourceschange event.
 */
export async function switchToControllerInput(
  ctx: TestContext,
  session: XRSession,
): Promise<void> {
  ctx.xrDevice!.primaryInputMode = 'controller';
  await withFrame(session, () => {});
}

/**
 * Clear persistent anchors from localStorage to prevent cross-test pollution.
 */
export function clearPersistentAnchors(): void {
  localStorage.removeItem(
    '@immersive-web-emulation-runtime/persistent-anchors',
  );
}
