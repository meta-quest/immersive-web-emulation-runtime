/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { z } from 'zod';
import {
  TOOLS,
  TOOL_BY_MCP_NAME,
  MCP_TO_METHOD,
  KNOWN_METHODS,
} from '../src/contract.js';

describe('tool catalog', () => {
  it('contains the 20 planned tools with unique names + methods', () => {
    expect(TOOLS).toHaveLength(20);
    expect(new Set(TOOLS.map((t) => t.mcpName)).size).toBe(20);
    expect(new Set(TOOLS.map((t) => t.wsMethod)).size).toBe(20);
  });

  it('maps every mcpName to a wsMethod; device tools are in KNOWN_METHODS, browser tools are not', () => {
    for (const t of TOOLS) {
      expect(MCP_TO_METHOD[t.mcpName]).toBe(t.wsMethod);
      expect(KNOWN_METHODS.has(t.wsMethod)).toBe(!t.browserTool);
    }
  });

  it('browser_screenshot is the only browser-host tool (serviced by the extension, not IWER)', () => {
    expect(TOOLS.filter((t) => t.browserTool).map((t) => t.mcpName)).toEqual([
      'browser_screenshot',
    ]);
  });

  it('marks only pure queries as readOnly', () => {
    const readOnly = TOOLS.filter((t) => t.readOnlyHint)
      .map((t) => t.mcpName)
      .sort();
    expect(readOnly).toEqual(
      [
        'browser_screenshot',
        'xr_get_device_state',
        'xr_get_gamepad_state',
        'xr_get_objects',
        'xr_get_select_value',
        'xr_get_session_status',
        'xr_get_transform',
        'xr_get_world_state',
      ].sort(),
    );
  });

  it('every tool has a usable Zod input shape', () => {
    for (const t of TOOLS) {
      const schema = z.object(t.inputShape);
      // Empty object validates against every no-arg tool.
      const result = schema.safeParse({});
      // Tools requiring params will fail {} — that's fine; we just assert the
      // shape constructs and `.safeParse` runs without throwing.
      expect(typeof result.success).toBe('boolean');
    }
  });

  it('xr_set_transform accepts valid and rejects invalid input', () => {
    const tool = TOOL_BY_MCP_NAME.get('xr_set_transform')!;
    const schema = z.object(tool.inputShape);
    expect(
      schema.safeParse({ device: 'headset', position: { x: 0, y: 1.6, z: -1 } })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ device: 'headset', orientation: { yaw: 90 } }).success,
    ).toBe(true);
    expect(schema.safeParse({ device: 'not-a-device' }).success).toBe(false);
    expect(
      schema.safeParse({
        device: 'headset',
        position: { x: 'nope', y: 0, z: 0 },
      }).success,
    ).toBe(false);
  });

  it('xr_set_select_value clamps to 0..1 via schema bounds', () => {
    const tool = TOOL_BY_MCP_NAME.get('xr_set_select_value')!;
    const schema = z.object(tool.inputShape);
    expect(
      schema.safeParse({ device: 'controller-right', value: 0.5 }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ device: 'controller-right', value: 2 }).success,
    ).toBe(false);
    expect(schema.safeParse({ device: 'headset', value: 0.5 }).success).toBe(
      false,
    ); // headset not an input device
  });
});
