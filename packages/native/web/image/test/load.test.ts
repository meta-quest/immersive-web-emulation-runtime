/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// NET-12: data: URL parsing for images; forgiving-base64.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgivingBase64, parseDataURL } from '../load.ts';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

test('base64 data URLs decode, whitespace and padding forgiven', () => {
  assert.equal(text(parseDataURL('data:text/plain;base64,aGVsbG8=')!.bytes), 'hello');
  assert.equal(text(parseDataURL('data:;base64,aGVs bG8')!.bytes), 'hello');
  assert.equal(text(parseDataURL('DATA:image/png ; BASE64 ,aGVsbG8')!.bytes), 'hello');
  assert.equal(parseDataURL('data:image/png;base64,aGVsbG8=')!.type, 'image/png');
  assert.equal(text(parseDataURL('data:image/png;base64,aGVs%62G8=')!.bytes), 'hello');
});

test('percent-encoded data URLs decode', () => {
  assert.equal(text(parseDataURL('data:,a%20b%2Cc')!.bytes), 'a b,c');
  assert.equal(parseDataURL('data:,x')!.type, 'text/plain');
  assert.equal(parseDataURL('data:;charset=utf-8,x')!.type, 'text/plain');
});

test('malformed data URLs are rejected', () => {
  assert.equal(parseDataURL('data:image/png;base64'), null);
  assert.equal(parseDataURL('data:image/png;base64,a'), null);
  assert.equal(parseDataURL('data:image/png;base64,ab$c'), null);
  assert.equal(parseDataURL('https://x/'), null);
});

test('forgiving-base64 matches Buffer for random inputs', () => {
  for (let n = 0; n < 50; n++) {
    const bytes = new Uint8Array(n * 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + n) & 0xff;
    const b64 = Buffer.from(bytes).toString('base64');
    assert.deepEqual(forgivingBase64(b64), bytes);
    assert.deepEqual(forgivingBase64(b64.replace(/=+$/, '')), bytes);
  }
  assert.equal(forgivingBase64('abc=d'), null);
});

test('resolveImageURL: data: URLs skip the URL parser but serialize like it', async () => {
  const { resolveImageURL } = await import('../load.ts');
  const cases = [
    'data:image/png;base64,iVBORw0KGgo=',
    '  data:image/png;base64,iVBO\nRw0K\tGgo=  ',
    'DATA:image/png;base64,AAAA',
    '\u0001data:text/plain,hello%20world',
    'data:,',
  ];
  for (const c of cases) assert.equal(resolveImageURL(c, 'https://app.local/'), new URL(c).href, JSON.stringify(c));
  assert.equal(resolveImageURL('a/b.png', 'https://app.local/x/'), 'https://app.local/x/a/b.png');
  assert.throws(() => resolveImageURL('http://[', 'https://app.local/'));
});
