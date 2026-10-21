/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { z } from 'zod';
import { BUILTIN_HAND_POSE_IDS } from 'iwer/lib/device/configs/hand/ids.js';
import {
  HAND_POSE_IDS,
  TOOLS,
  TOOL_BY_MCP_NAME,
  MCP_TO_METHOD,
  KNOWN_METHODS,
  CATALOG_VERSION,
  inputSchemaOf,
} from '../src/contract.js';

describe('tool catalog', () => {
  it('contains the 21 planned tools with unique names + methods', () => {
    expect(TOOLS).toHaveLength(21);
    expect(new Set(TOOLS.map((t) => t.mcpName)).size).toBe(21);
    expect(new Set(TOOLS.map((t) => t.wsMethod)).size).toBe(21);
    expect(CATALOG_VERSION).toBe(3);
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
        'xr_get_hand_state',
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
    expect(schema.safeParse({ device: 'gaze', value: 0.5 }).success).toBe(
      false,
    );
  });

  it('exposes gaze only on pose and connection commands', () => {
    for (const toolName of [
      'xr_get_transform',
      'xr_set_transform',
      'xr_look_at',
      'xr_animate_to',
    ]) {
      const schema = z.object(TOOL_BY_MCP_NAME.get(toolName)!.inputShape);
      const extra =
        toolName === 'xr_look_at' ? { target: { x: 0, y: 0, z: -1 } } : {};
      expect(schema.safeParse({ device: 'gaze', ...extra }).success).toBe(true);
    }

    const connected = z.object(
      TOOL_BY_MCP_NAME.get('xr_set_connected')!.inputShape,
    );
    expect(
      connected.safeParse({ device: 'gaze', connected: false }).success,
    ).toBe(true);

    const nonGazeTools: Record<string, Record<string, unknown>> = {
      xr_get_select_value: {},
      xr_set_select_value: { value: 0.5 },
      xr_select: {},
      xr_get_gamepad_state: {},
      xr_set_gamepad_state: {},
      xr_set_hand_pose: { poseId: 'point' },
    };
    for (const [toolName, extra] of Object.entries(nonGazeTools)) {
      const schema = z.object(TOOL_BY_MCP_NAME.get(toolName)!.inputShape);
      expect(schema.safeParse({ device: 'gaze', ...extra }).success).toBe(
        false,
      );
    }
  });

  it('xr_set_hand_pose lists the runtime poses and accepts finger blends', () => {
    expect([...HAND_POSE_IDS]).toEqual([...BUILTIN_HAND_POSE_IDS]);
    const tool = TOOL_BY_MCP_NAME.get('xr_set_hand_pose')!;
    for (const id of HAND_POSE_IDS) {
      expect(tool.description).toMatch(new RegExp(`(^|[ :])${id} \\([^)]+\\)`));
    }
    expect(tool.description).toContain('Poses only shape the hand');

    const schema = z.object(tool.inputShape);
    expect(
      schema.safeParse({
        device: 'hand-left',
        poseId: 'open',
        fingers: {
          middle: 'fist',
          ring: { poseId: 'fist' },
          pinky: { poseId: 'fist', weight: 0.5 },
        },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        device: 'hand-left',
        poseId: 'open',
        fingers: { elbow: 'fist' },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        device: 'hand-left',
        poseId: 'open',
        fingers: { index: { poseId: 'fist', weight: 2 } },
      }).success,
    ).toBe(false);
  });

  it('accepts gaze state without an independent position', () => {
    const schema = z.object(
      TOOL_BY_MCP_NAME.get('xr_set_device_state')!.inputShape,
    );
    expect(
      schema.safeParse({
        state: {
          gaze: {
            connected: true,
            orientation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        state: { gaze: { position: { x: 0, y: 0, z: 0 } } },
      }).success,
    ).toBe(false);
  });
});

describe('hand motion params', () => {
  const schemaOf = (name: string) => inputSchemaOf(TOOL_BY_MCP_NAME.get(name)!);

  it('keeps anchors, hand directions and easing (nothing stripped)', () => {
    const placed = schemaOf('xr_set_transform').parse({
      device: 'hand-right',
      position: { x: 0, y: 1, z: -0.4 },
      anchor: 'index-tip',
      orientation: { fingers: 'forward', thumb: 'up' },
    });
    expect(placed).toEqual({
      device: 'hand-right',
      position: { x: 0, y: 1, z: -0.4 },
      anchor: 'index-tip',
      orientation: { fingers: 'forward', thumb: 'up' },
    });
    expect(
      schemaOf('xr_animate_to').parse({
        device: 'hand-left',
        position: { x: 0, y: 1, z: -0.4 },
        anchor: 'grasp',
        orientation: { fingers: [0, -1, -1], palm: { x: 0, y: -1, z: 0 } },
        duration: 0.6,
        easing: 'minimum-jerk',
      }),
    ).toMatchObject({
      anchor: 'grasp',
      orientation: { fingers: [0, -1, -1], palm: { x: 0, y: -1, z: 0 } },
      easing: 'minimum-jerk',
    });
    expect(
      schemaOf('xr_animate_to').parse({
        device: 'hand-left',
        position: { x: 0, y: 1, z: -0.4 },
        orientation: 'auto',
      }).orientation,
    ).toBe('auto');
    expect(
      schemaOf('xr_set_select_value').parse({
        device: 'hand-right',
        value: 1,
        duration: 0.2,
        easing: 'linear',
      }),
    ).toMatchObject({ duration: 0.2, easing: 'linear' });
    expect(
      schemaOf('xr_set_hand_pose').parse({
        device: 'hand-right',
        poseId: 'fist',
        duration: 0.3,
        easing: 'minimum-jerk',
      }),
    ).toMatchObject({ duration: 0.3, easing: 'minimum-jerk' });
    expect(
      schemaOf('xr_get_hand_state').parse({
        device: 'hand-right',
        joints: 'all',
      }),
    ).toEqual({ device: 'hand-right', joints: 'all' });
  });

  it('still accepts quaternion and euler orientations', () => {
    expect(
      schemaOf('xr_set_transform').parse({
        device: 'headset',
        orientation: { pitch: -30 },
      }).orientation,
    ).toEqual({ pitch: -30 });
    expect(
      schemaOf('xr_animate_to').parse({
        device: 'controller-left',
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      }).orientation,
    ).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('rejects misspelt keys at the top level and inside new shapes', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      // Would otherwise parse as an empty euler.
      [
        'xr_set_transform',
        { device: 'hand-right', orientation: { finger: 'forward' } },
      ],
      ['xr_set_transform', { device: 'hand-right', ancor: 'index-tip' }],
      [
        'xr_set_transform',
        {
          device: 'hand-right',
          orientation: { fingers: 'forward', palms: 'down' },
        },
      ],
      [
        'xr_set_transform',
        { device: 'headset', orientation: { yaw: 90, roll: 0, spin: 1 } },
      ],
      ['xr_animate_to', { device: 'hand-right', durration: 1 }],
      ['xr_animate_to', { device: 'hand-right', easing: 'reach' }],
      ['xr_set_select_value', { device: 'hand-right', value: 1, time: 0.2 }],
      ['xr_set_hand_pose', { device: 'hand-right', poseId: 'fist', fade: 0.2 }],
      [
        'xr_set_hand_pose',
        {
          device: 'hand-right',
          poseId: 'open',
          fingers: { index: { poseId: 'fist', wieght: 0.5 } },
        },
      ],
      ['xr_get_hand_state', { device: 'hand-right', joint: 'all' }],
      ['xr_set_device_state', { state: { hands: { left: { pinch: 1 } } } }],
      ['xr_set_device_state', { state: { hand: { left: {} } } }],
      ['xr_set_device_state', { sate: {} }],
    ];
    for (const [name, args] of bad) {
      expect([name, schemaOf(name).safeParse(args).success]).toEqual([
        name,
        false,
      ]);
    }
  });

  it('leaves tools this catalog version did not change lenient', () => {
    const tool = TOOL_BY_MCP_NAME.get('xr_look_at')!;
    expect(tool.strictInput).toBeUndefined();
    expect(
      inputSchemaOf(tool).parse({
        device: 'headset',
        target: { x: 0, y: 1, z: -1 },
        extra: true,
      }),
    ).toEqual({ device: 'headset', target: { x: 0, y: 1, z: -1 } });
  });

  it('round-trips a get_device_state snapshot through set_device_state', () => {
    const pose = {
      position: { x: 0, y: 1.3, z: -0.4 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    };
    const snapshot = {
      headset: pose,
      inputMode: 'hand',
      controllers: {
        left: { connected: true, ...pose },
        right: { connected: true, ...pose },
      },
      hands: {
        left: { connected: true, ...pose, poseId: 'default', pinchValue: 0 },
        right: { connected: true, ...pose, poseId: 'point', pinchValue: 0.5 },
      },
      gaze: { connected: false, orientation: pose.orientation },
      stereoEnabled: false,
      fov: 90,
    };
    expect(
      schemaOf('xr_set_device_state').parse({ state: snapshot }).state,
    ).toEqual(snapshot);
  });
});
