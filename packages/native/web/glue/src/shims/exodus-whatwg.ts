/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Build-time replacement for `@exodus/bytes/whatwg.js` inside whatwg-url: URL Standard "percent-encode
// after encoding" for UTF-8 only. The runtime's documents are always UTF-8 (whatwg-url then never asks
// for a legacy encoder), so the multi-byte tables (~150 KB) stay out of the bundle.
import { utf8Encode } from '../encoding.ts';

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(`%${i.toString(16).toUpperCase().padStart(2, '0')}`);

export function percentEncodeAfterEncoding(
  encoding: string,
  input: string,
  percentEncodeSet: string,
  spaceAsPlus = false,
): string {
  if (String(encoding).toLowerCase() !== 'utf-8') {
    throw new RangeError(`percentEncodeAfterEncoding: only UTF-8 is supported (got ${encoding})`);
  }
  const bytes = utf8Encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (spaceAsPlus && b === 0x20) out += '+';
    else if (b < 0x20 || b > 0x7e || percentEncodeSet.includes(String.fromCharCode(b))) out += HEX[b];
    else out += String.fromCharCode(b);
  }
  return out;
}
