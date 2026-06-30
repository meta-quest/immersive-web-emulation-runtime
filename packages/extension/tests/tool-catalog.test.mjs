/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TOOLS } from '../../extension-bridge/lib/contract.js';
import {
  ALLOWED_METHODS,
  BROWSER_HOST_METHODS,
} from '../lib/agent/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const generated = JSON.parse(
  readFileSync(
    path.join(here, '..', 'src', 'agent', 'tool-catalog.generated.json'),
    'utf8',
  ),
);

test('panel MCP catalog is generated from @iwer/extension-bridge contract', () => {
  assert.deepEqual(
    generated.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      readOnly: tool.readOnly,
    })),
    TOOLS.map((tool) => ({
      name: tool.mcpName,
      title: tool.title,
      description: tool.description,
      readOnly: tool.readOnlyHint,
    })),
  );
  assert.equal(generated.tools.length, 20);
  // Per-client install targets were dropped — the panel shows a single config
  // snippet the user pastes themselves, so the catalog carries no `targets`.
  assert.equal(generated.targets, undefined);
});

test('extension protocol allows every non-browser-host MCP method', () => {
  for (const tool of TOOLS) {
    const set = tool.browserTool ? BROWSER_HOST_METHODS : ALLOWED_METHODS;
    assert.equal(set.has(tool.wsMethod), true, tool.wsMethod);
  }
});
