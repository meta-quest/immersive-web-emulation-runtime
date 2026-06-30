/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Screenshot remap + size-ceiling policy. `browser_screenshot` is a
 * BROWSER-HOST tool: the extension's service worker captures the visible tab
 * (chrome.tabs.captureVisibleTab) and downscales/re-encodes it with
 * OffscreenCanvas, returning `{ imageData (base64, no data: URI), format,
 * width, height }` — NOT the MCP image shape. A full frame can blow Claude
 * Code's ~25k image token cap, so the daemon:
 *   1. remaps to MCP image content,
 *   2. defaults to a downscaled JPEG,
 *   3. enforces a hard base64 ceiling by RE-REQUESTING the capture at smaller
 *      maxWidth/quality (the extension re-encodes each request via
 *      OffscreenCanvas), rather than re-encoding in the daemon.
 *
 * Screenshotting is deliberately NOT an IWER `device.remote` capability — it is
 * the host's job (mirrors IWSDK, where the managed Playwright browser owns it).
 * The host (extension) captures the composited frame, so it works on any page
 * regardless of WebGL `preserveDrawingBuffer`.
 */

export interface CaptureResult {
  imageData: string;
  width?: number;
  height?: number;
  format?: string;
  timestamp?: number;
}

export interface CaptureParams {
  maxWidth?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
}

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** Aggressive defaults so screenshots stay within model image budgets. */
export const DEFAULT_CAPTURE_PARAMS: Required<CaptureParams> = {
  maxWidth: 768,
  format: 'jpeg',
  quality: 0.7,
};

/** Hard ceiling on the base64 STRING length (~ proxy for image tokens). */
export const MAX_IMAGE_BASE64_BYTES = 180_000;

/** Lower bound on maxWidth — below this we stop shrinking and return as-is. */
export const MIN_RECAPTURE_WIDTH = 240;

/** Merge agent-provided params over the daemon defaults. */
export function mergeCaptureParams(
  agent: CaptureParams | undefined,
): Required<CaptureParams> {
  return {
    maxWidth: agent?.maxWidth ?? DEFAULT_CAPTURE_PARAMS.maxWidth,
    format: agent?.format ?? DEFAULT_CAPTURE_PARAMS.format,
    quality: agent?.quality ?? DEFAULT_CAPTURE_PARAMS.quality,
  };
}

/** Remap an IWER capture result into MCP image content. */
export function toImageContent(result: CaptureResult): McpImageContent {
  const format = (result.format || 'png').toLowerCase();
  return { type: 'image', data: result.imageData, mimeType: `image/${format}` };
}

/** True when the base64 payload exceeds the ceiling. */
export function isOverCeiling(
  result: CaptureResult,
  ceiling: number = MAX_IMAGE_BASE64_BYTES,
): boolean {
  return (
    typeof result.imageData === 'string' && result.imageData.length > ceiling
  );
}

/**
 * Compute smaller capture params for a retry, or null when we should stop
 * shrinking. Forces JPEG (smallest) and steps width down 30% and quality down
 * 0.15 (floor 0.4) each attempt.
 */
export function planReducedParams(
  current: Required<CaptureParams>,
): Required<CaptureParams> | null {
  const nextWidth = Math.floor(current.maxWidth * 0.7);
  if (nextWidth < MIN_RECAPTURE_WIDTH) return null;
  return {
    maxWidth: nextWidth,
    format: 'jpeg',
    quality: Math.max(0.4, Math.round((current.quality - 0.15) * 100) / 100),
  };
}

export interface EnforceCeilingResult {
  result: CaptureResult;
  attempts: number;
  /** True if still over ceiling after exhausting retries. */
  stillOver: boolean;
  finalParams: Required<CaptureParams>;
}

/**
 * Enforce the base64 ceiling by re-requesting captures at progressively smaller
 * params. `capture` performs one capture with the given params.
 */
export async function enforceImageCeiling(
  capture: (params: Required<CaptureParams>) => Promise<CaptureResult>,
  initialParams: Required<CaptureParams>,
  ceiling: number = MAX_IMAGE_BASE64_BYTES,
  maxAttempts = 4,
): Promise<EnforceCeilingResult> {
  let params = initialParams;
  let result = await capture(params);
  let attempts = 1;
  while (isOverCeiling(result, ceiling) && attempts < maxAttempts) {
    const reduced = planReducedParams(params);
    if (!reduced) break;
    params = reduced;
    result = await capture(params);
    attempts += 1;
  }
  return {
    result,
    attempts,
    stillOver: isOverCeiling(result, ceiling),
    finalParams: params,
  };
}
