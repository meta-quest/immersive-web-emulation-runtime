/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { XRHostBackend } from './types.js';

/**
 * How many host frames an accepted `updateTargetFrameRate` request waits for
 * the display to report the new rate before its promise is settled anyway
 * (a runtime may accept a rate and never report it, and the promise must not
 * hang). 90 frames is 0.75 to 1.25 seconds at 72 to 120 Hz.
 */
export const RATE_CONFIRMATION_FRAME_LIMIT = 90;

/**
 * Display refresh rate of a host session: what the host reports, the rates
 * the page may pick, and the page's outstanding `updateTargetFrameRate`
 * promises.
 */
export class XRHostFrameRate {
  private readonly backend: XRHostBackend;
  /** Current rate in Hz, 0 while unknown. */
  current = 0;
  /** Rates the page may request (empty: any rate may be tried). */
  supported: Float32Array = new Float32Array(0);
  private waiting: Array<{
    resolve: () => void;
    reject: (reason: DOMException) => void;
  }> = [];
  private framesWaited = 0;

  constructor(backend: XRHostBackend) {
    this.backend = backend;
  }

  /** Takes the rates and the current rate from the swapchain answer. */
  adopt(supported: Float32Array, current: number): void {
    if (supported.length > 0) {
      this.supported = supported;
    }
    if (current > 0) {
      this.current = current;
    }
  }

  /**
   * The page's request. `ended` is the session's ended flag. Resolves once a
   * new rate has been observed (see `observe`), or after
   * RATE_CONFIRMATION_FRAME_LIMIT frames without one.
   */
  request(rate: number, ended: boolean): Promise<void> {
    if (ended) {
      return Promise.reject(
        new DOMException('XRSession has already ended.', 'InvalidStateError'),
      );
    }
    const target = Number(rate);
    if (this.supported.length > 0 && !this.supported.includes(target)) {
      return Promise.reject(
        new DOMException(
          'Requested frame rate not supported.',
          'InvalidStateError',
        ),
      );
    }
    if (target === this.current) {
      return Promise.resolve();
    }
    let accepted: boolean;
    try {
      accepted = Boolean(this.backend.requestFrameRate?.(target));
    } catch (error) {
      console.warn(
        'updateTargetFrameRate: the host threw while switching rates',
        error,
      );
      accepted = false;
    }
    if (!accepted) {
      return Promise.reject(
        new DOMException(
          `The host did not switch the display to ${target} Hz.`,
          'InvalidStateError',
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      if (this.waiting.length === 0) {
        this.framesWaited = 0;
      }
      this.waiting.push({ resolve, reject });
    });
  }

  /**
   * Records a rate reported by the host (in a frame or an event). Returns
   * true when it differs from the known rate; the caller must then dispatch
   * `frameratechange` and call `settle()`, in that order.
   */
  observe(rate: number): boolean {
    if (!(rate > 0) || rate === this.current) {
      return false;
    }
    this.current = rate;
    return true;
  }

  /** Resolves every outstanding request. */
  settle(): void {
    if (this.waiting.length === 0) {
      return;
    }
    const waiting = this.waiting;
    this.waiting = [];
    for (const request of waiting) {
      request.resolve();
    }
  }

  /** Counts one host frame against outstanding requests. */
  countFrame(): void {
    if (
      this.waiting.length > 0 &&
      ++this.framesWaited > RATE_CONFIRMATION_FRAME_LIMIT
    ) {
      this.settle();
    }
  }

  /**
   * The session ended: WebXR's "shut down the session" rejects promises
   * still outstanding with InvalidStateError.
   */
  abandon(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const request of waiting) {
      request.reject(
        new DOMException(
          'The XRSession ended before the frame rate changed.',
          'InvalidStateError',
        ),
      );
    }
  }
}
