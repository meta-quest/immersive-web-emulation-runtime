/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Fetching an image's bytes for HTMLImageElement.src: data: URLs (Fetch "data: URL processor", decoded here without
// a round trip through fetch), blob: URLs (the glue's blob URL store, NET-14/15) and everything else through fetch
// (APK assets and allowlisted origins, NET-1..NET-6). NET-12.

import type { ImageEnv } from './env.ts';

export class ImageLoadError extends Error {}

export interface LoadedBytes {
  bytes: Uint8Array;
  type: string;
  url: string;
}

/** A data: URL whose base64 payload is left for the native module to decode off the JS thread. */
export interface LoadedBase64 {
  base64: string;
  type: string;
  url: string;
}

/**
 * Resolves an image URL. data: URLs skip the URL parser: they are absolute, and running a multi-megabyte string
 * through the JS URL polyfill costs far more than the decode (REG-16). Only what the URL parser would change for a
 * data: URL is applied: leading/trailing C0 controls and spaces are stripped, tab and newlines removed, the scheme
 * lowercased. Throws TypeError for an invalid URL.
 */
export function resolveImageURL(src: string, base: string): string {
  let start = 0;
  let end = src.length;
  while (start < end && src.charCodeAt(start) <= 0x20) start++;
  if (
    end - start >= 5 &&
    src.slice(start, start + 5).toLowerCase() === 'data:'
  ) {
    while (end > start && src.charCodeAt(end - 1) <= 0x20) end--;
    let s = start === 0 && end === src.length ? src : src.slice(start, end);
    if (s.indexOf('\t') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0)
      s = s.replace(/[\t\n\r]/g, '');
    return s.startsWith('data:') ? s : 'data:' + s.slice(5);
  }
  return new URL(src, base).href;
}

const ASCII_WS = /[\t\n\f\r ]/g;

/** Forgiving-base64 decode (Infra standard). Returns null on failure. */
export function forgivingBase64(input: string): Uint8Array | null {
  let s = input.replace(ASCII_WS, '');
  if (s.length % 4 === 0) {
    if (s.endsWith('==')) s = s.slice(0, -2);
    else if (s.endsWith('=')) s = s.slice(0, -1);
  }
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v =
      c >= 65 && c <= 90
        ? c - 65
        : c >= 97 && c <= 122
          ? c - 71
          : c >= 48 && c <= 57
            ? c + 4
            : c === 43
              ? 62
              : 63;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Percent-decodes a string's UTF-8 bytes (URL standard "percent-decode"). */
function percentDecode(s: string): Uint8Array {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c === 0x25 &&
      i + 2 < s.length &&
      /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c < 0x80) {
      bytes.push(c);
    } else {
      // Non-ASCII code points (a serialized URL never has them, but be lenient): UTF-8.
      const cp = s.codePointAt(i)!;
      const chunk = enc.encode(String.fromCodePoint(cp));
      for (const b of chunk) bytes.push(b);
      if (cp > 0xffff) i++;
    }
  }
  return Uint8Array.from(bytes);
}

interface DataURLParts {
  /** The MIME type's essence ('text/plain' when empty). */
  type: string;
  base64: boolean;
  /** The body after the comma, fragment removed, not yet decoded. */
  body: string;
}

/** Splits a data: URL (Fetch's data: URL processor, steps before decoding the body). Null when malformed. */
export function splitDataURL(href: string): DataURLParts | null {
  if (href.length < 5 || href.slice(0, 5).toLowerCase() !== 'data:')
    return null;
  const hash = href.indexOf('#', 5);
  const comma = href.indexOf(',', 5);
  if (comma < 0 || (hash >= 0 && hash < comma)) return null;
  let mime = href.slice(5, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  const body = hash >= 0 ? href.slice(comma + 1, hash) : href.slice(comma + 1);
  const b64 = /;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i.exec(mime);
  if (b64) mime = mime.slice(0, b64.index);
  if (mime.startsWith(';')) mime = 'text/plain' + mime;
  return {
    type: mime.split(';')[0]!.trim().toLowerCase() || 'text/plain',
    base64: b64 !== null,
    body,
  };
}

/** Fetch's data: URL processor. Returns null for a malformed URL (the image then fires `error`). */
export function parseDataURL(
  href: string,
): { bytes: Uint8Array; type: string } | null {
  const parts = splitDataURL(href);
  if (!parts) return null;
  const { body } = parts;
  let bytes: Uint8Array;
  if (parts.base64) {
    let text = body;
    if (body.includes('%')) {
      // Rare: percent-encoded base64. Rebuild the text from the decoded bytes in chunks.
      const raw = percentDecode(body);
      const parts: string[] = [];
      for (let i = 0; i < raw.length; i += 8192)
        parts.push(String.fromCharCode(...raw.subarray(i, i + 8192)));
      text = parts.join('');
    }
    const decoded = forgivingBase64(text);
    if (!decoded) return null;
    bytes = decoded;
  } else {
    bytes = percentDecode(body);
  }
  return { bytes, type: parts.type };
}

/**
 * Resolves `src` against the base URL and returns its bytes. Rejects with ImageLoadError on a bad URL, an unknown
 * or revoked blob URL, a network error or a non-OK status (images fire `error` for 404 like browsers).
 */
export async function loadImageBytes(
  src: string,
  env: ImageEnv,
  crossOrigin: string | null,
  options: { allowBase64?: boolean } = {},
): Promise<LoadedBytes | LoadedBase64> {
  let href: string;
  try {
    href = resolveImageURL(src, env.baseURL());
  } catch {
    throw new ImageLoadError(`Invalid image URL: ${src}`);
  }
  if (href.startsWith('data:')) {
    // Base64 payloads go to the native module as text (decoded on the pool) unless percent-encoded (rare).
    if (options.allowBase64 && env.decodeBase64) {
      const parts = splitDataURL(href);
      if (!parts) throw new ImageLoadError('Malformed data: URL');
      if (parts.base64 && parts.body.indexOf('%') < 0)
        return { base64: parts.body, type: parts.type, url: href };
    }
    const parsed = parseDataURL(href);
    if (!parsed) throw new ImageLoadError('Malformed data: URL');
    return { ...parsed, url: href };
  }
  if (/^blob:/i.test(href)) {
    const hit = env.resolveBlobURL(href);
    if (!hit) throw new ImageLoadError(`Unknown or revoked blob URL: ${href}`);
    return { ...hit, url: href };
  }
  if (!env.fetch) throw new ImageLoadError('fetch is not available');
  let response;
  try {
    response = await env.fetch(href, {
      credentials:
        crossOrigin === 'use-credentials' ? 'include' : 'same-origin',
    });
  } catch (e) {
    throw new ImageLoadError(
      `Network error loading ${href}: ${String((e as Error)?.message ?? e)}`,
    );
  }
  if (!response.ok)
    throw new ImageLoadError(`HTTP ${response.status} loading ${href}`);
  const buffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    type: response.headers?.get('content-type') ?? '',
    url: href,
  };
}
