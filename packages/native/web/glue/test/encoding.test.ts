/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// NET-16: TextEncoder/TextDecoder and atob/btoa, conformance against Node's implementations (ICU /
// simdutf) with a seeded fuzz corpus, plus the native UTF-8 fast path contract.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { both, createGlueContext, fakeNatives } from './harness.ts';

// Deterministic PRNG for the fuzz corpus.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpusBytes(): number[][] {
  const r = rng(42);
  const out: number[][] = [
    [],
    [0xef, 0xbb, 0xbf, 0x41],
    [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf],
    [0xfe, 0xff, 0x00, 0x41],
    [0xff, 0xfe, 0x41, 0x00],
    [0xc0, 0x80],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf0, 0x9f, 0x98],
    [0xf0, 0x9f, 0x98, 0x80],
    [0x80, 0xbf, 0xfe, 0xff],
    [0xe2, 0x82],
    [0x00, 0xd8, 0x00, 0xdc],
    [0x00, 0xd8, 0x41, 0x00],
    [0x00, 0xdc],
    [0x41],
  ];
  // Valid multi-byte text and random bytes biased towards UTF-8 lead/continuation bytes.
  out.push(Array.from(Buffer.from('héllo wörld — 日本語 😀 \u{10FFFF}', 'utf8')));
  for (let i = 0; i < 300; i++) {
    const n = Math.floor(r() * 24);
    const a: number[] = [];
    for (let j = 0; j < n; j++) {
      const k = r();
      a.push(k < 0.3 ? Math.floor(r() * 0x80) : k < 0.6 ? 0x80 + Math.floor(r() * 0x40) : 0xc0 + Math.floor(r() * 0x40));
    }
    out.push(a);
  }
  return out;
}

function corpusStrings(): string[] {
  const r = rng(7);
  const out = ['', 'abc', '\uD800', '\uDC00', 'a\uD800b', '😀', '\uDE00\uD83D', 'é日😀', '\u0000\u007f\u0080߿ࠀ￿'];
  for (let i = 0; i < 200; i++) {
    let s = '';
    const n = Math.floor(r() * 20);
    for (let j = 0; j < n; j++) {
      const k = r();
      s += String.fromCharCode(k < 0.4 ? Math.floor(r() * 0x80) : k < 0.6 ? Math.floor(r() * 0x800) : k < 0.8 ? 0xd800 + Math.floor(r() * 0x800) : Math.floor(r() * 0x10000));
    }
    out.push(s);
  }
  return out;
}

describe('TextDecoder (NET-16)', () => {
  const bytes = JSON.stringify(corpusBytes());

  // Node 24 decodes windows-1252 as ISO-8859-1 (0x80..0x9F unmapped), which the Encoding Standard
  // and Chromium do not, so windows-1252 is checked against the standard's index instead (below).
  for (const enc of ['utf-8', 'utf-16le', 'utf-16be']) {
    test(`${enc}: replacement, fatal and ignoreBOM match Node`, async () => {
      const r = await both(`
        const corpus = ${bytes};
        const out = [];
        for (const a of corpus) {
          const u8 = new Uint8Array(a);
          out.push(new TextDecoder('${enc}').decode(u8));
          out.push(new TextDecoder('${enc}', { ignoreBOM: true }).decode(u8));
          try { out.push(new TextDecoder('${enc}', { fatal: true }).decode(u8)); } catch (e) { out.push(e.name); }
        }
        return out;
      `);
      assert.deepEqual(r.glue, r.node);
    });

    test(`${enc}: streaming at every split point matches Node`, async () => {
      const r = await both(`
        const corpus = ${bytes}.slice(0, 120);
        const out = [];
        for (const a of corpus) {
          const u8 = new Uint8Array(a);
          for (let cut = 0; cut <= u8.length; cut++) {
            const d = new TextDecoder('${enc}');
            out.push(d.decode(u8.subarray(0, cut), { stream: true }) + '|' + d.decode(u8.subarray(cut)));
          }
        }
        return out;
      `);
      assert.deepEqual(r.glue, r.node);
    });
  }

  test('windows-1252 decodes every byte per the Encoding Standard index', async () => {
    // index-windows-1252.txt, pointers 0..31 (bytes 0x80..0x9F); every other byte maps to itself.
    const high = [
      0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
      0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
    ];
    const want = Array.from({ length: 256 }, (_, b) => (b >= 0x80 && b < 0xa0 ? high[b - 0x80]! : b));
    const { run } = await createGlueContext();
    for (const label of ['windows-1252', 'latin1', 'ascii', 'iso-8859-1', 'us-ascii']) {
      const got = run<string>(`new TextDecoder('${label}').decode(new Uint8Array(256).map((_, i) => i))`);
      assert.deepEqual(Array.from(got, (c) => c.codePointAt(0)), want, label);
    }
    // windows-1252 has no BOM handling and never fails.
    assert.equal(run(`new TextDecoder('latin1', { fatal: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf]))`), '\u00ef\u00bb\u00bf');
  });

  test('labels and errors match Node', async () => {
    const r = await both(`
      const out = [new TextDecoder('ascii').encoding, new TextDecoder(' UTF8 ').encoding,
        new TextDecoder('utf-16').encoding, new TextDecoder('unicodefffe').encoding, new TextDecoder().encoding];
      for (const bad of ['replacement', 'iso-2022-kr', 'nope']) {
        try { new TextDecoder(bad); out.push('ok'); } catch (e) { out.push(e.name); }
      }
      const d = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      out.push(d.fatal, d.ignoreBOM, Object.prototype.toString.call(d));
      out.push(new TextDecoder().decode(new Uint16Array([0x6948]).buffer), new TextDecoder().decode(new DataView(new Uint8Array([0x41, 0x42]).buffer, 1)));
      try { new TextDecoder().decode('x'); } catch (e) { out.push(e.name); }
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('a fatal error resets the streaming state', async () => {
    const r = await both(`
      const d = new TextDecoder('utf-8', { fatal: true });
      const out = [d.decode(new Uint8Array([0xe2, 0x82]), { stream: true })];
      try { d.decode(new Uint8Array([0x41])); } catch (e) { out.push(e.name); }
      out.push(d.decode(new Uint8Array([0x41])));
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });
});

describe('TextEncoder (NET-16)', () => {
  test('encode / encodeInto match Node on a fuzz corpus with lone surrogates', async () => {
    const strings = JSON.stringify(corpusStrings());
    const r = await both(`
      const corpus = ${strings};
      const e = new TextEncoder();
      const out = [e.encoding];
      for (const s of corpus) {
        out.push(Array.from(e.encode(s)));
        for (const cap of [0, 1, 2, 3, 5, 8]) {
          const dst = new Uint8Array(cap);
          const res = e.encodeInto(s, dst);
          out.push([res.read, res.written, Array.from(dst)]);
        }
      }
      out.push(Array.from(e.encode()), Array.from(e.encode(undefined)), Array.from(e.encode(123)));
      try { e.encodeInto('x', new Uint16Array(2)); } catch (err) { out.push(err.name); }
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('large strings use the native UTF-8 hooks when the host provides them', async () => {
    const { natives, calls } = fakeNatives({
      encoding: {
        decodeUtf8(bytes: Uint8Array, fatal: boolean) {
          calls.decodeUtf8++;
          try {
            return new TextDecoder('utf-8', { fatal, ignoreBOM: true }).decode(bytes);
          } catch {
            return null;
          }
        },
        encodeUtf8(text: string) {
          calls.encodeUtf8++;
          return new TextEncoder().encode(text);
        },
      },
    });
    const { run } = await createGlueContext({ natives });
    const ok = run<boolean>(`
      const big = '\\uFEFF' + 'héllo '.repeat(100);
      const bytes = new TextEncoder().encode(big);
      const back = new TextDecoder().decode(bytes);
      let fatal = '';
      try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(300).fill(0xff)); } catch (e) { fatal = e.name; }
      back === big.slice(1) && fatal === 'TypeError' && new TextDecoder().decode(new TextEncoder().encode('short')) === 'short';
    `);
    assert.equal(ok, true);
    assert.equal(calls.encodeUtf8, 1);
    assert.equal(calls.decodeUtf8, 2);
  });
});

describe('atob / btoa (NET-16)', () => {
  test('match Node, including InvalidCharacterError', async () => {
    const r = await both(`
      const out = [];
      for (const s of ['', 'f', 'fo', 'foo', 'foob', '\\u00ff\\u00fe', 'Zm9v', 'Zm9vYg==', 'Zm9vYg', ' Zm 9v\\nYg== ', 'Zm9vY', '=Zm9v', 'Zm9v====', 'ab~c', 'YQ', 'YR==']) {
        try { out.push(btoa(s)); } catch (e) { out.push([e.name, e.code]); }
        try { out.push(atob(s)); } catch (e) { out.push([e.name, e.code]); }
      }
      try { btoa('\\u0100'); } catch (e) { out.push([e.name, e.code, e instanceof DOMException]); }
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });
});
