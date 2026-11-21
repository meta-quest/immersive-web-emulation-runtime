/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// protocol.ts must mirror runtime/audio/src/protocol.h exactly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as P from '../src/protocol.ts';

const header = readFileSync(
  fileURLToPath(new URL('../../../runtime/audio/src/protocol.h', import.meta.url)),
  'utf8',
);

function enumBody(name: string): Map<string, number> {
  const m = header.match(new RegExp(`enum ${name} : int \\{([\\s\\S]*?)\\};`));
  assert.ok(m, `enum ${name} not found`);
  const out = new Map<string, number>();
  for (const e of m[1].matchAll(/k(\w+)\s*=\s*(\d+)/g)) out.set(e[1], Number(e[2]));
  return out;
}

function check(name: string, prefix: string, ts: Record<string, number>, skip: string[] = []): void {
  const native = enumBody(name);
  for (const [k, v] of native) {
    const key = k.startsWith(prefix) ? k.slice(prefix.length) : k;
    if (skip.includes(key)) continue;
    assert.equal(ts[key], v, `${name}.${k}`);
  }
  for (const [k, v] of Object.entries(ts)) {
    assert.equal(native.get(prefix + k), v, `TS ${name}.${k} has no native twin`);
  }
}

test('opcodes, node types, props, events and shared slots match protocol.h', () => {
  check('Op', '', P.Op);
  check('NodeType', '', P.NodeType, ['NodeTypeCount']);
  check('Prop', 'Prop', P.Prop);
  check('EventType', 'Ev', P.EventType);
  check('SharedSlot', 'Shared', P.Shared, ['Count']);
  const version = header.match(/constexpr int kVersion = (\d+);/);
  assert.equal(Number(version?.[1]), P.PROTOCOL_VERSION);
  const listener = header.match(/constexpr int kListenerSlots = (\d+);/);
  assert.equal(Number(listener?.[1]), P.LISTENER_SLOTS);
});

test('param counts per node type match protocol.h', () => {
  const body = header.match(/constexpr int paramCount\(int type\) \{([\s\S]*?)\n\}/);
  assert.ok(body);
  const native = new Map<string, number>();
  for (const m of body[1].matchAll(/case k(\w+): return (\d+);/g)) native.set(m[1], Number(m[2]));
  for (const [name, type] of Object.entries(P.NodeType)) {
    assert.equal(P.PARAM_COUNT[type] ?? 0, native.get(name) ?? 0, name);
  }
});

test('argument counts match the fake decoder used by tests', () => {
  const body = header.match(/constexpr int argCount\(int op\) \{([\s\S]*?)\n\}/);
  assert.ok(body);
  const counts = new Map<string, number>();
  for (const m of body[1].matchAll(/case k(\w+): return (\d+);/g)) counts.set(m[1], Number(m[2]));
  assert.equal(counts.size, Object.keys(P.Op).length);
  assert.equal(counts.get('CreateNode'), 10);
  assert.equal(counts.get('ParamEvent'), 7);
  for (const [name, op] of Object.entries(P.Op)) assert.equal(P.ARG_COUNT[op], counts.get(name), name);
});
