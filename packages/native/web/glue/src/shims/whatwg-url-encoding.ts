/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Build-time replacement for whatwg-url's lib/encoding.js, which constructs a global TextEncoder and
// TextDecoder when it loads (before the glue has installed them). Uses the glue's own codecs.
import { TextDecoder, utf8Encode as encode } from '../encoding.ts';

let decoder: TextDecoder | null = null;

export function utf8Encode(string: string): Uint8Array {
  return encode(string);
}

export function utf8DecodeWithoutBOM(bytes: Uint8Array): string {
  decoder ??= new TextDecoder('utf-8', { ignoreBOM: true });
  return decoder.decode(bytes);
}
