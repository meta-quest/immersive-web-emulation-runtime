/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { z } from 'zod';
import { BUILTIN_HAND_POSE_IDS } from 'iwer/lib/device/configs/hand/ids.js';
import { REMOTE_METHOD_SCHEMAS } from 'iwer/lib/remote/catalog.js';
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
  it('contains the 24 planned tools with unique names + methods', () => {
    expect(TOOLS).toHaveLength(24);
    expect(new Set(TOOLS.map((t) => t.mcpName)).size).toBe(24);
    expect(new Set(TOOLS.map((t) => t.wsMethod)).size).toBe(24);
    expect(CATALOG_VERSION).toBe(4);
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
        'xr_list_targets',
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

describe('run_sequence params', () => {
  const schemaOf = (name: string) => inputSchemaOf(TOOL_BY_MCP_NAME.get(name)!);
  const run = schemaOf('xr_run_sequence');

  it("accepts the description's own example, nothing stripped", () => {
    const tool = TOOL_BY_MCP_NAME.get('xr_run_sequence')!;
    const example = JSON.parse(tool.description.split('Example: ')[1]);
    expect(run.parse(example)).toEqual(example);
  });

  it('keeps every step property', () => {
    const params = {
      device: 'hand-left',
      idleHand: 'keep',
      body: 'fixed',
      gaze: 'follow',
      dryRun: true,
      steps: [
        {
          label: 'all',
          duration: 'auto',
          target: { name: 'panel', face: 'front' },
          offset: { normal: 0.01 },
          approach: { distance: 0.05, normal: 'toward-head' },
          depart: { distance: 0.04, normal: [0, 1, 0] },
          press: { depth: 0.01, hold: 0.05, retract: 0.06 },
          anchor: 'index-tip',
          orientation: { fingers: 'forward', palm: 'down' },
          poseId: { value: 'point', start: 0, end: 0.5, easing: 'linear' },
          fingers: { thumb: { poseId: 'fist', weight: 0.6 } },
          body: { stepTo: 'panel', facing: 'left' },
        },
        {
          position: { x: 0, y: 1, z: -0.4, normal: { x: 0, y: 0, z: 1 } },
          pinch: { value: 1, start: 0.5, end: 1, easing: 'minimum-jerk' },
        },
        { position: [0, 1, -0.4], offset: { x: 0, y: 0.05, z: 0 } },
        {
          position: { relativeTo: 'body', x: 0, y: 1.2, z: -0.3 },
          body: { position: { relativeTo: 'head', x: 0, y: 0, z: -0.5 } },
          pinch: 0,
        },
      ],
    };
    expect(run.parse(params)).toEqual(params);
  });

  it('rejects misspelt keys at every level', () => {
    const step = (extra: Record<string, unknown>) => ({
      device: 'hand-right',
      steps: [{ target: 'button', ...extra }],
    });
    const bad: Record<string, unknown>[] = [
      { device: 'hand-right', steps: [{ duration: 1 }], with: {} },
      step({ pose: 'point' }),
      step({ press: { deep: 0.01 } }),
      step({ pinch: { value: 1, att: 'arrival' } }),
      step({ approach: { dist: 0.05 } }),
      step({ body: { walkTo: 'tray' } }),
      step({ poseId: { value: 'point', begin: 0 } }),
      { device: 'hand-right', steps: [{ target: { nam: 'button' } }] },
      {
        device: 'hand-right',
        steps: [{ position: { relativeTo: 'head', x: 0, y: 0, z: 0, w: 1 } }],
      },
      step({ offset: { x: 0, y: 0, z: 0, w: 1 } }),
      step({ fingers: { index: { poseId: 'fist', wieght: 1 } } }),
      step({ orientation: { fingers: 'forward', thum: 'up' } }),
    ];
    for (const args of bad) {
      expect([args, run.safeParse(args).success]).toEqual([args, false]);
    }
  });

  it('rejects out-of-range values', () => {
    const bad = [
      { device: 'hand-right', steps: [] },
      { device: 'controller-right', steps: [{ duration: 1 }] },
      { device: 'hand-right', steps: [{ duration: -1 }] },
      { device: 'hand-right', steps: [{ pinch: 2 }] },
      { device: 'hand-right', steps: [{ press: { depth: 0.03 } }] },
      { device: 'hand-right', steps: [{ press: { retract: 0.01 } }] },
      { device: 'hand-right', steps: [{ pinch: { value: 1, at: 'start' } }] },
      { device: 'hand-right', steps: [{ duration: 1 }], idleHand: 'drop' },
    ];
    for (const args of bad) {
      expect([args, run.safeParse(args).success]).toEqual([args, false]);
    }
  });

  it('cancel_sequence and list_targets take nothing', () => {
    for (const name of ['xr_cancel_sequence', 'xr_list_targets']) {
      expect(schemaOf(name).safeParse({}).success).toBe(true);
      expect(schemaOf(name).safeParse({ force: true }).success).toBe(false);
    }
  });
});

// A validator for the JSON Schema subset IWER's catalog uses.
type JsonSchema = Record<string, unknown>;
const SUBSET = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'anyOf',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
]);
const keywordsOutsideSubset = (schema: unknown, at = '$'): string[] => {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as JsonSchema;
  const out = Object.keys(s)
    .filter((k) => !SUBSET.has(k))
    .map((k) => `${at}.${k}`);
  const children: [string, unknown][] = [];
  for (const [name, child] of Object.entries(
    (s.properties as Record<string, unknown>) ?? {},
  )) {
    children.push([`${at}.properties.${name}`, child]);
  }
  ((s.anyOf as unknown[]) ?? []).forEach((c, i) =>
    children.push([`${at}.anyOf[${i}]`, c]),
  );
  ((s.prefixItems as unknown[]) ?? []).forEach((c, i) =>
    children.push([`${at}.prefixItems[${i}]`, c]),
  );
  if (s.items) children.push([`${at}.items`, s.items]);
  for (const [path, child] of children) {
    out.push(...keywordsOutsideSubset(child, path));
  }
  return out;
};
const validate = (schema: JsonSchema, value: unknown): boolean => {
  if (schema.anyOf) {
    return (schema.anyOf as JsonSchema[]).some((s) => validate(s, value));
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  switch (schema.type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (schema.type === 'integer' && !Number.isInteger(value)) return false;
      if (schema.minimum !== undefined && value < (schema.minimum as number))
        return false;
      if (schema.maximum !== undefined && value > (schema.maximum as number))
        return false;
      if (
        schema.exclusiveMinimum !== undefined &&
        value <= (schema.exclusiveMinimum as number)
      )
        return false;
      return true;
    }
    case 'array': {
      if (!Array.isArray(value)) return false;
      if (
        schema.minItems !== undefined &&
        value.length < (schema.minItems as number)
      )
        return false;
      if (
        schema.maxItems !== undefined &&
        value.length > (schema.maxItems as number)
      )
        return false;
      const prefix = (schema.prefixItems as JsonSchema[]) ?? [];
      return value.every((item, i) =>
        i < prefix.length
          ? validate(prefix[i], item)
          : !schema.items || validate(schema.items as JsonSchema, item),
      );
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
      const record = value as Record<string, unknown>;
      const properties =
        (schema.properties as Record<string, JsonSchema>) ?? {};
      for (const key of (schema.required as string[]) ?? []) {
        if (!(key in record)) return false;
      }
      return Object.entries(record).every(([key, item]) =>
        key in properties
          ? validate(properties[key], item)
          : schema.additionalProperties !== false,
      );
    }
    default:
      return true;
  }
};

describe('IWER method catalog (iwer/lib/remote/catalog.js)', () => {
  const deviceTools = TOOLS.filter((t) => !t.browserTool);
  const catalogOf = (name: string) => {
    const tool = TOOL_BY_MCP_NAME.get(name)!;
    return REMOTE_METHOD_SCHEMAS[tool.wsMethod] as JsonSchema;
  };

  it('has a schema for every device tool, and nothing the bridge does not know', () => {
    expect(Object.keys(REMOTE_METHOD_SCHEMAS).sort()).toEqual(
      [...KNOWN_METHODS].sort(),
    );
  });

  it('uses only the documented JSON Schema subset (no $ref, no const)', () => {
    for (const [method, schema] of Object.entries(REMOTE_METHOD_SCHEMAS)) {
      expect([method, keywordsOutsideSubset(schema)]).toEqual([method, []]);
    }
  });

  it('matches each tool: the same parameters, the same required ones, the same strictness', () => {
    for (const tool of deviceTools) {
      const schema = REMOTE_METHOD_SCHEMAS[tool.wsMethod] as JsonSchema;
      const shape = tool.inputShape as Record<string, z.ZodTypeAny>;
      expect([
        tool.mcpName,
        Object.keys(schema.properties as object).sort(),
      ]).toEqual([tool.mcpName, Object.keys(shape).sort()]);
      expect([tool.mcpName, [...(schema.required as string[])].sort()]).toEqual(
        [
          tool.mcpName,
          Object.keys(shape)
            .filter((key) => !shape[key].isOptional())
            .sort(),
        ],
      );
      expect([tool.mcpName, schema.additionalProperties === false]).toEqual([
        tool.mcpName,
        tool.strictInput === true,
      ]);
    }
  });

  // [tool, arguments, valid]: the Zod shape and the catalog must agree.
  const fixtures: [string, Record<string, unknown>, boolean][] = [
    [
      'xr_run_sequence',
      { device: 'hand-right', steps: [{ duration: 1 }] },
      true,
    ],
    [
      'xr_run_sequence',
      {
        device: 'hand-right',
        steps: [
          { label: 'press', target: 'button', press: {} },
          {
            target: { name: 'piece', face: 'top' },
            approach: { distance: 0.06 },
            pinch: { value: 1, at: 'arrival' },
            poseId: { value: 'default', end: 0.6 },
          },
          {
            position: { x: 0.2, y: 1, z: -0.4, normal: 'up' },
            offset: { normal: 0.01 },
            depart: { distance: 0.08 },
          },
          { pinch: { value: 0, start: 0.2 }, duration: 0.15 },
          {
            position: { relativeTo: 'head', x: 0.1, y: -0.3, z: -0.4 },
            anchor: 'wrist',
            orientation: { fingers: 'forward', thumb: 'up' },
            poseId: 'thumbs-up',
            body: { facing: [0, 0, -1] },
          },
        ],
        idleHand: 'rest',
        gaze: 'fixed',
        dryRun: false,
      },
      true,
    ],
    ['xr_run_sequence', { device: 'hand-right', steps: [] }, false],
    [
      'xr_run_sequence',
      { device: 'hand-right', steps: [{ pose: 'x' }] },
      false,
    ],
    [
      'xr_run_sequence',
      { device: 'hand-right', steps: [{ press: { deep: 0.01 } }] },
      false,
    ],
    [
      'xr_run_sequence',
      {
        device: 'hand-right',
        steps: [{ pinch: { value: 1, att: 'arrival' } }],
      },
      false,
    ],
    [
      'xr_run_sequence',
      { device: 'hand-right', steps: [{ body: { stepTo: { nam: 'tray' } } }] },
      false,
    ],
    [
      'xr_run_sequence',
      { device: 'hand-right', steps: [{ offset: { x: 0, y: 0, z: 0, w: 0 } }] },
      false,
    ],
    [
      'xr_run_sequence',
      { device: 'hand-right', steps: [{ position: [0, 1] }] },
      false,
    ],
    [
      'xr_run_sequence',
      { device: 'hand-right', steps: [{ duration: 'soon' }] },
      false,
    ],
    ['xr_run_sequence', { device: 'hand-right', steps: [{}], id: 'a' }, false],
    ...(
      [
        { press: { depth: 0.02 } },
        { press: { hold: 0.3 } },
        { pinch: { value: 1.2, at: 'arrival' } },
        { approach: { distance: -0.01 } },
        { position: { relativeTo: 'hip', x: 0, y: 0, z: 0 } },
        { body: { facing: 'sideways' } },
        { poseId: { value: 'fist', start: 1.5 } },
        { orientation: { fingers: 'forward' }, anchor: 7 },
      ] as Record<string, unknown>[]
    ).map((step): [string, Record<string, unknown>, boolean] => [
      'xr_run_sequence',
      { device: 'hand-right', steps: [step] },
      false,
    ]),
    ['xr_cancel_sequence', {}, true],
    ['xr_cancel_sequence', { now: true }, false],
    ['xr_list_targets', {}, true],
    ['xr_list_targets', { filter: 'x' }, false],
    [
      'xr_set_transform',
      { device: 'hand-right', orientation: { finger: 'forward' } },
      false,
    ],
    [
      'xr_set_transform',
      {
        device: 'hand-right',
        position: { x: 0, y: 1, z: -0.4 },
        anchor: 'grasp',
        orientation: 'auto',
      },
      true,
    ],
    ['xr_animate_to', { device: 'headset', duration: 0 }, false],
    ['xr_animate_to', { device: 'hand-right', easing: 'reach' }, false],
    [
      'xr_set_device_state',
      { state: { hands: { left: { poseId: 'fist', pinchValue: 0.5 } } } },
      true,
    ],
    [
      'xr_set_device_state',
      { state: { hands: { left: { pinch: 1 } } } },
      false,
    ],
    [
      'xr_set_hand_pose',
      {
        device: 'hand-right',
        poseId: 'open',
        fingers: { index: { poseId: 'fist', wieght: 0.5 } },
      },
      false,
    ],
    ['xr_get_hand_state', { device: 'hand-left', joints: 'some' }, false],
    // Tools older than catalog version 3 still ignore unknown keys.
    [
      'xr_look_at',
      { device: 'headset', target: { x: 0, y: 1, z: -1 }, extra: 1 },
      true,
    ],
    ['xr_select', { device: 'hand-right', duration: 0 }, false],
    [
      'xr_set_gamepad_state',
      {
        device: 'controller-left',
        buttons: [{ index: 1, value: 1, extra: 1 }],
      },
      true,
    ],
    [
      'xr_set_gamepad_state',
      { device: 'controller-left', buttons: [{ index: 1.5, value: 1 }] },
      false,
    ],
  ];

  it.each(fixtures)('%s %j is valid: %s, by both', (name, args, valid) => {
    const tool = TOOL_BY_MCP_NAME.get(name)!;
    expect(inputSchemaOf(tool).safeParse(args).success).toBe(valid);
    expect(validate(catalogOf(name), args)).toBe(valid);
  });
});
