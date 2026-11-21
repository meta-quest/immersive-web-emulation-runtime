/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Build-time replacement for the `tr46` package inside whatwg-url. tr46 carries the full UTS #46
// mapping table (~240 KB minified); this keeps the bundle small by approximating the UTS #46 mapping
// step with NFKC + lower-casing (V8's ICU), then running the real Punycode conversion and the
// validity rules that WPT exercises (invalid / empty / all-ASCII "xn--" labels fail). whatwg-url only
// calls toASCII for non-ASCII domains in non-strict mode, so ASCII hosts are unaffected.
// Known gap: code points UTS #46 marks "disallowed" are not rejected (documented in THIRD_PARTY.md).
import punycode from 'punycode/punycode.es6.js';

interface Options {
  checkHyphens?: boolean;
  useSTD3ASCIIRules?: boolean;
  verifyDNSLength?: boolean;
}

const LABEL_SEPARATORS = /[.\u3002\uFF0E\uFF61]/g;
// UTS #46 "ignored" code points (mapped to nothing): soft hyphen, CGJ, Mongolian FVS, ZWSP, word
// joiner, invisible plus, variation selectors, BOM, shorthand format controls.
const IGNORED =
  /[\u00AD\u034F\u180B-\u180F\u200B\u2060\u2064\u206A-\u206F\uFE00-\uFE0F\uFEFF\u{1BCA0}-\u{1BCA3}\u{E0100}-\u{E01EF}]/gu;
// Approximation of UTS #46 "disallowed": controls, unassigned, private use, surrogates, format
// characters other than the joiners (checked by CheckJoiners below), separators, ideographic
// description characters, U+FFFD.
const DISALLOWED =
  /[\p{Cc}\p{Cn}\p{Co}\p{Cs}\p{Zs}\p{Zl}\p{Zp}\u2FF0-\u2FFF\uFFFD]|(?![\u200C\u200D])\p{Cf}/u;
// CheckJoiners (RFC 5892 Appendix A.1/A.2), approximated: ZWJ must follow a combining mark (virama);
// ZWNJ must follow one, or sit between two letters of a cursive-joining script.
const BAD_ZWJ = /(^|[^\p{M}])\u200D/u;
const JOINING =
  '\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Nko}\\p{Script=Mongolian}\\p{Script=Mandaic}\\p{Script=Manichaean}\\p{Script=Psalter_Pahlavi}\\p{Script=Adlam}';
const GOOD_ZWNJ = new RegExp(
  `(\\p{M}|[${JOINING}]\\p{M}*)\\u200C(?=\\p{M}*[${JOINING}])|\\p{M}\\u200C`,
  'gu',
);
function badJoiner(label: string): boolean {
  return BAD_ZWJ.test(label) || label.replace(GOOD_ZWNJ, '').includes('\u200C');
}
// CheckBidi (RFC 5893), approximated with the right-to-left blocks: in a domain that has any RTL
// character, an RTL label must start with an RTL character and contain no other-script letters, and
// an LTR label must contain no RTL character.
const RTL =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const RTL_START =
  /^[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LTR_LETTER =
  /(?![\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}])\p{L}/u;
const LEADING_MARK = /^\p{M}/u;

function isASCII(s: string): boolean {
  return /^[\x00-\x7F]*$/.test(s);
}

export function toASCII(domain: string, options: Options = {}): string | null {
  // A compatibility mapping that produces a label separator (U+2025 -> "..", U+FE12 -> U+3002) is
  // disallowed, not a separator.
  for (const ch of domain) {
    LABEL_SEPARATORS.lastIndex = 0;
    if (LABEL_SEPARATORS.test(ch)) continue;
    LABEL_SEPARATORS.lastIndex = 0;
    if (LABEL_SEPARATORS.test(ch.normalize('NFKC'))) return null;
  }
  LABEL_SEPARATORS.lastIndex = 0;
  // Approximate UTS #46 §4 "Map" + "Normalize": compatibility decomposition and case folding.
  const mapped = domain
    .replace(IGNORED, '')
    .normalize('NFKC')
    // UTS #46 maps U+03A3 to U+03C3 everywhere; toLowerCase() would apply the final-sigma rule.
    .replace(/\u03A3/g, '\u03C3')
    .toLowerCase()
    .normalize('NFC')
    .replace(LABEL_SEPARATORS, '.');
  if (DISALLOWED.test(mapped)) return null;
  const labels = mapped.split('.');
  const bidiDomain =
    RTL.test(mapped) ||
    labels.some((l) => l.startsWith('xn--') && RTL.test(safeDecode(l)));
  const out: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    let unicode = label;
    if (label.startsWith('xn--')) {
      try {
        unicode = punycode.decode(label.slice(4));
      } catch {
        return null;
      }
      if (unicode === '' || isASCII(unicode)) return null;
      if (unicode.normalize('NFC') !== unicode || DISALLOWED.test(unicode))
        return null;
    }
    if (LEADING_MARK.test(unicode) || badJoiner(unicode)) return null;
    if (bidiDomain && unicode !== '') {
      if (
        RTL_START.test(unicode) ? LTR_LETTER.test(unicode) : RTL.test(unicode)
      )
        return null;
    }
    if (options.checkHyphens) {
      if (
        unicode.startsWith('-') ||
        unicode.endsWith('-') ||
        unicode.slice(2, 4) === '--'
      )
        return null;
    } else if (!label.startsWith('xn--') && unicode.startsWith('xn--')) {
      return null;
    }
    if (
      options.useSTD3ASCIIRules &&
      /[^a-z0-9\-\u0080-\u{10FFFF}]/u.test(unicode)
    )
      return null;
    out.push(isASCII(label) ? label : `xn--${punycode.encode(label)}`);
  }
  const result = out.join('.');
  if (options.verifyDNSLength) {
    const trimmed = result.endsWith('.') ? result.slice(0, -1) : result;
    if (trimmed.length < 1 || trimmed.length > 253) return null;
    if (trimmed.split('.').some((l) => l.length < 1 || l.length > 63))
      return null;
  }
  return result;
}

function safeDecode(label: string): string {
  try {
    return punycode.decode(label.slice(4));
  } catch {
    return '';
  }
}

export function toUnicode(domain: string): { domain: string; error: boolean } {
  const labels = domain.split('.');
  try {
    return {
      domain: labels
        .map((l) => (l.startsWith('xn--') ? punycode.decode(l.slice(4)) : l))
        .join('.'),
      error: false,
    };
  } catch {
    return { domain, error: true };
  }
}
