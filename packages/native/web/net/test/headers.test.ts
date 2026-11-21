/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Headers (NET-9): cases in the spirit of WPT fetch/api/headers/* that need no server.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Headers, setGuard } from '../src/headers.ts';

test('case-insensitive names, combined values, sorted iteration', () => {
  const h = new Headers([
    ['B', '1'],
    ['a', '2'],
    ['b', '3'],
  ]);
  assert.equal(h.get('b'), '1, 3');
  assert.equal(h.get('A'), '2');
  assert.ok(h.has('B'));
  assert.deepEqual([...h], [
    ['a', '2'],
    ['b', '1, 3'],
  ]);
  assert.deepEqual([...h.keys()], ['a', 'b']);
  assert.deepEqual([...h.values()], ['2', '1, 3']);
  const seen: string[] = [];
  h.forEach((v, k, parent) => {
    assert.equal(parent, h);
    seen.push(`${k}=${v}`);
  });
  assert.deepEqual(seen, ['a=2', 'b=1, 3']);
});

test('set replaces all values in place; delete removes all', () => {
  const h = new Headers({ 'X-A': '1' });
  h.append('x-b', '2');
  h.append('X-a', '3');
  h.set('x-A', '4');
  assert.equal(h.get('x-a'), '4');
  h.delete('X-B');
  assert.equal(h.get('x-b'), null);
  assert.deepEqual([...h], [['x-a', '4']]);
});

test('set-cookie is never combined', () => {
  const h = new Headers();
  h.append('Set-Cookie', 'a=1');
  h.append('set-cookie', 'b=2');
  assert.deepEqual(h.getSetCookie(), ['a=1', 'b=2']);
  assert.deepEqual([...h], [
    ['set-cookie', 'a=1'],
    ['set-cookie', 'b=2'],
  ]);
  assert.equal(h.get('set-cookie'), 'a=1, b=2');
});

test('values are trimmed of HTTP whitespace; invalid names and values throw TypeError', () => {
  const h = new Headers();
  h.append('x', ' \t v \r\n');
  assert.equal(h.get('x'), 'v');
  assert.throws(() => h.append('bad name', 'v'), TypeError);
  assert.throws(() => h.append('x', 'a\0b'), TypeError);
  assert.throws(() => h.append('x', 'a\nb'), TypeError);
  assert.throws(() => h.get('a:b'), TypeError);
  assert.throws(() => new Headers([['a']] as unknown as [string, string][]), TypeError);
  assert.throws(() => new Headers('nope' as unknown as Record<string, string>), TypeError);
});

test('guards: immutable throws, request drops forbidden headers, response drops set-cookie', () => {
  const imm = new Headers({ a: '1' });
  setGuard(imm, 'immutable');
  assert.throws(() => imm.set('a', '2'), TypeError);
  assert.throws(() => imm.delete('a'), TypeError);
  const req = new Headers();
  setGuard(req, 'request');
  req.set('Host', 'evil');
  req.append('Sec-Fetch-Mode', 'x');
  req.append('Proxy-Authorization', 'x');
  req.append('X-HTTP-Method-Override', 'TRACE');
  req.append('Content-Type', 'text/plain');
  assert.deepEqual([...req], [['content-type', 'text/plain']]);
  const res = new Headers();
  setGuard(res, 'response');
  res.append('Set-Cookie', 'a=b');
  res.append('X-Ok', '1');
  assert.deepEqual([...res], [['x-ok', '1']]);
});

test('constructing from another Headers and from a record copies', () => {
  const a = new Headers({ x: '1' });
  const b = new Headers(a);
  b.set('x', '2');
  assert.equal(a.get('x'), '1');
  assert.equal(Object.prototype.toString.call(b), '[object Headers]');
});
