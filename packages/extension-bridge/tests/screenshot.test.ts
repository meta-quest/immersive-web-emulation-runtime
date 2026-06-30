/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  DEFAULT_CAPTURE_PARAMS,
  enforceImageCeiling,
  isOverCeiling,
  mergeCaptureParams,
  planReducedParams,
  toImageContent,
  type CaptureParams,
  type CaptureResult,
} from '../src/screenshot.js';

describe('screenshot remap + ceiling', () => {
  it('remaps an IWER capture result to MCP image content', () => {
    const img = toImageContent({ imageData: 'AAAA', format: 'jpeg' });
    expect(img).toEqual({
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/jpeg',
    });
    // Defaults to png when format absent.
    expect(toImageContent({ imageData: 'BBBB' }).mimeType).toBe('image/png');
  });

  it('merges agent params over the aggressive defaults', () => {
    expect(mergeCaptureParams(undefined)).toEqual(DEFAULT_CAPTURE_PARAMS);
    expect(mergeCaptureParams({ maxWidth: 1024 })).toEqual({
      maxWidth: 1024,
      format: 'jpeg',
      quality: 0.7,
    });
    expect(mergeCaptureParams({ format: 'png', quality: 1 })).toEqual({
      maxWidth: 768,
      format: 'png',
      quality: 1,
    });
  });

  it('detects over-ceiling payloads', () => {
    expect(isOverCeiling({ imageData: 'x'.repeat(100) }, 50)).toBe(true);
    expect(isOverCeiling({ imageData: 'x'.repeat(10) }, 50)).toBe(false);
  });

  it('reduces params on each retry and stops below the floor', () => {
    let params = mergeCaptureParams({ maxWidth: 768, quality: 0.7 });
    const widths: number[] = [params.maxWidth];
    for (;;) {
      const next = planReducedParams(params);
      if (!next) break;
      params = next;
      widths.push(params.maxWidth);
    }
    // Strictly decreasing, all >= floor (240).
    for (let i = 1; i < widths.length; i += 1)
      expect(widths[i]).toBeLessThan(widths[i - 1]);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(240);
    expect(params.quality).toBeGreaterThanOrEqual(0.4);
  });

  it('enforceImageCeiling re-requests until under the ceiling', async () => {
    // The fake capture returns a payload whose size shrinks with maxWidth.
    const capture = async (
      p: Required<CaptureParams>,
    ): Promise<CaptureResult> => ({
      imageData: 'x'.repeat(p.maxWidth * 2),
      width: p.maxWidth,
      format: p.format,
    });
    const ceiling = 800; // 768*2 = 1536 over; must shrink at least once.
    const { result, attempts, stillOver } = await enforceImageCeiling(
      capture,
      mergeCaptureParams(undefined),
      ceiling,
    );
    expect(attempts).toBeGreaterThan(1);
    expect(stillOver).toBe(false);
    expect(result.imageData.length).toBeLessThanOrEqual(ceiling);
  });

  it('enforceImageCeiling reports stillOver when it cannot get under the ceiling', async () => {
    const capture = async (): Promise<CaptureResult> => ({
      imageData: 'x'.repeat(10_000),
    });
    const { stillOver, attempts } = await enforceImageCeiling(
      capture,
      mergeCaptureParams(undefined),
      100,
    );
    expect(stillOver).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(1);
  });
});
