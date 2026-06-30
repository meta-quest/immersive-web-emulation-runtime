/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * The static MCP tool catalog (plan §4). Each entry maps an agent-facing MCP
 * tool name onto an IWER `device.remote` method (`wsMethod`), with a Zod input
 * shape and a `readOnlyHint`. This is the single source of truth the daemon
 * uses to (a) register MCP tools and (b) translate tool calls into dispatch
 * envelopes. Descriptions are kept compact on purpose (plan §11.5 #7).
 */

import { z, type ZodRawShape } from 'zod';

/** Bumped when the catalog shape changes; surfaced in the version handshake. */
export const CATALOG_VERSION = 1;

// --- Reusable shapes -------------------------------------------------------

const deviceEnum = z
  .enum([
    'headset',
    'controller-left',
    'controller-right',
    'hand-left',
    'hand-right',
  ])
  .describe(
    'Tracked device id. Aliases like "right"/"left-hand" are also accepted.',
  );

const inputDeviceEnum = z
  .enum(['controller-left', 'controller-right', 'hand-left', 'hand-right'])
  .describe('An input device (controller or hand), not the headset.');

const controllerEnum = z
  .enum(['controller-left', 'controller-right'])
  .describe('A controller (gamepad) device.');

const handEnum = z
  .enum(['hand-left', 'hand-right'])
  .describe('A hand-tracking device.');

const vec3 = z
  .object({ x: z.number(), y: z.number(), z: z.number() })
  .describe('A 3D position in metres, XR-origin relative.');

const quat = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  w: z.number(),
});
const euler = z.object({
  pitch: z.number().optional(),
  yaw: z.number().optional(),
  roll: z.number().optional(),
});
const orientation = z
  .union([quat, euler])
  .describe(
    'Orientation as a quaternion {x,y,z,w} or euler degrees {pitch,yaw,roll}.',
  );

const inputState = z.object({
  connected: z.boolean().optional(),
  position: vec3.optional(),
  orientation: orientation.optional(),
});

const deviceStateSchema = z
  .object({
    headset: z
      .object({
        position: vec3.optional(),
        orientation: orientation.optional(),
      })
      .optional(),
    inputMode: z.enum(['controller', 'hand']).optional(),
    stereoEnabled: z.boolean().optional(),
    fov: z.number().optional(),
    controllers: z
      .object({ left: inputState.optional(), right: inputState.optional() })
      .optional(),
    hands: z
      .object({ left: inputState.optional(), right: inputState.optional() })
      .optional(),
  })
  .partial();

// --- Tool definition -------------------------------------------------------

export interface ToolDef {
  /** Agent-facing MCP tool name (namespaced). */
  mcpName: string;
  /** The method sent over the bridge. For device tools this is an IWER
   * `device.remote` method serviced in the page; for browser tools it is
   * serviced by the extension host (not IWER). */
  wsMethod: string;
  /** Short human title. */
  title: string;
  /** Agent-facing description. */
  description: string;
  /** True only for pure queries (no state mutation). */
  readOnlyHint: boolean;
  /**
   * True for **browser-host** tools serviced by the extension (e.g. tab
   * capture), NOT by IWER `device.remote`. Mirrors IWSDK, where the browser —
   * its managed Playwright instance — owns screenshotting, not the runtime.
   * Browser tools are excluded from the IWER capability intersection.
   */
  browserTool?: boolean;
  /** Zod raw shape passed to McpServer.registerTool. */
  inputShape: ZodRawShape;
}

export const TOOLS: readonly ToolDef[] = [
  // --- Session ---
  {
    mcpName: 'xr_get_session_status',
    wsMethod: 'get_session_status',
    title: 'Get XR session status',
    description:
      'Report XR session + device status: device name, whether a session is offered/active, session mode, enabled features, and visibility. Call this first to orient.',
    readOnlyHint: true,
    inputShape: {},
  },
  {
    mcpName: 'xr_accept_session',
    wsMethod: 'accept_session',
    title: 'Accept XR session',
    description:
      'Accept an offered XR session (equivalent to the user clicking "Enter XR"). Then poll xr_get_session_status until sessionActive is true.',
    readOnlyHint: false,
    inputShape: {},
  },
  {
    mcpName: 'xr_end_session',
    wsMethod: 'end_session',
    title: 'End XR session',
    description: 'End the active XR session.',
    readOnlyHint: false,
    inputShape: {},
  },
  // --- Transform ---
  {
    mcpName: 'xr_get_transform',
    wsMethod: 'get_transform',
    title: 'Get device transform',
    description:
      'Get the position, orientation (quaternion), and euler angles of a tracked device.',
    readOnlyHint: true,
    inputShape: { device: deviceEnum },
  },
  {
    mcpName: 'xr_set_transform',
    wsMethod: 'set_transform',
    title: 'Set device transform',
    description:
      'Set a device position and/or orientation immediately. Requires an active session.',
    readOnlyHint: false,
    inputShape: {
      device: deviceEnum,
      position: vec3.optional(),
      orientation: orientation.optional(),
    },
  },
  {
    mcpName: 'xr_look_at',
    wsMethod: 'look_at',
    title: 'Look at a point',
    description:
      'Orient a device toward an XR-origin-relative world point. Optionally move it to a given distance from the target. Requires an active session.',
    readOnlyHint: false,
    inputShape: {
      device: deviceEnum,
      target: vec3,
      moveToDistance: z.number().optional(),
    },
  },
  {
    mcpName: 'xr_animate_to',
    wsMethod: 'animate_to',
    title: 'Animate device pose',
    description:
      'Smoothly animate a device to a target position and/or orientation over `duration` seconds (default 0.5). Requires an active, rendering session.',
    readOnlyHint: false,
    inputShape: {
      device: deviceEnum,
      position: vec3.optional(),
      orientation: orientation.optional(),
      duration: z.number().positive().optional(),
    },
  },
  // --- Input ---
  {
    mcpName: 'xr_set_input_mode',
    wsMethod: 'set_input_mode',
    title: 'Set input mode',
    description:
      'Switch the primary input between motion controllers and hand tracking.',
    readOnlyHint: false,
    inputShape: { mode: z.enum(['controller', 'hand']) },
  },
  {
    mcpName: 'xr_set_connected',
    wsMethod: 'set_connected',
    title: 'Connect/disconnect input',
    description: 'Connect or disconnect a controller or hand.',
    readOnlyHint: false,
    inputShape: { device: inputDeviceEnum, connected: z.boolean() },
  },
  {
    mcpName: 'xr_get_select_value',
    wsMethod: 'get_select_value',
    title: 'Get select value',
    description:
      'Get the current select value (controller trigger or hand pinch), 0..1.',
    readOnlyHint: true,
    inputShape: { device: inputDeviceEnum },
  },
  {
    mcpName: 'xr_set_select_value',
    wsMethod: 'set_select_value',
    title: 'Set select value',
    description:
      'Set the select value (trigger/pinch), 0..1. Use xr_select for a full press+release.',
    readOnlyHint: false,
    inputShape: { device: inputDeviceEnum, value: z.number().min(0).max(1) },
  },
  {
    mcpName: 'xr_select',
    wsMethod: 'select',
    title: 'Select (press + release)',
    description:
      'Perform a full select gesture (fires selectstart → select → selectend) over `duration` seconds (default 0.15). Requires an active session.',
    readOnlyHint: false,
    inputShape: {
      device: inputDeviceEnum,
      duration: z.number().positive().optional(),
    },
  },
  // --- Gamepad ---
  {
    mcpName: 'xr_get_gamepad_state',
    wsMethod: 'get_gamepad_state',
    title: 'Get gamepad state',
    description:
      'Get all buttons/axes for a controller (index 0=trigger, 1=squeeze, 2=thumbstick, 3=A/X, 4=B/Y, 5=thumbrest; axes 0=stick-x, 1=stick-y).',
    readOnlyHint: true,
    inputShape: { device: controllerEnum },
  },
  {
    mcpName: 'xr_set_gamepad_state',
    wsMethod: 'set_gamepad_state',
    title: 'Set gamepad state',
    description: 'Set controller buttons and/or thumbstick axes by index.',
    readOnlyHint: false,
    inputShape: {
      device: controllerEnum,
      buttons: z
        .array(
          z.object({
            index: z.number().int(),
            value: z.number(),
            touched: z.boolean().optional(),
          }),
        )
        .optional(),
      axes: z
        .array(z.object({ index: z.number().int(), value: z.number() }))
        .optional(),
    },
  },
  // --- State ---
  {
    mcpName: 'xr_get_device_state',
    wsMethod: 'get_device_state',
    title: 'Get device state',
    description:
      'Get a full snapshot: headset pose, input mode, controllers, hands, stereo, FOV.',
    readOnlyHint: true,
    inputShape: {},
  },
  {
    mcpName: 'xr_set_device_state',
    wsMethod: 'set_device_state',
    title: 'Set device state',
    description:
      'Apply a partial device state. Call with no `state` to reset everything to defaults.',
    readOnlyHint: false,
    inputShape: { state: deviceStateSchema.optional() },
  },
  {
    mcpName: 'xr_set_hand_pose',
    wsMethod: 'set_hand_pose',
    title: 'Set hand pose',
    description:
      'Set a named hand pose (e.g. "relaxed", "point", "pinch") on a hand device.',
    readOnlyHint: false,
    inputShape: { device: handEnum, poseId: z.string() },
  },
  // --- World (SEM) ---
  {
    mcpName: 'xr_get_world_state',
    wsMethod: 'get_world_state',
    title: 'Get world state',
    description:
      'Summarize the emulated environment (SEM): plane/mesh counts and the list of tracked objects with semantic labels. Requires the Synthetic Environment Module.',
    readOnlyHint: true,
    inputShape: {},
  },
  {
    mcpName: 'xr_get_objects',
    wsMethod: 'get_objects',
    title: 'Get tracked objects',
    description:
      'List the SEM tracked planes/meshes with their semantic labels (e.g. wall, floor, table).',
    readOnlyHint: true,
    inputShape: {},
  },
  // --- Vision ---
  {
    mcpName: 'browser_screenshot',
    wsMethod: 'screenshot',
    title: 'Screenshot the browser tab',
    description:
      'Capture the visible browser tab — the composited frame the developer sees — as an image. Serviced by the extension (captureVisibleTab), so it works on any page regardless of how the WebXR scene is rendered. Defaults to a downscaled JPEG to stay within model image limits; override maxWidth/format/quality if needed.',
    readOnlyHint: true,
    browserTool: true,
    inputShape: {
      maxWidth: z.number().int().positive().optional(),
      format: z.enum(['png', 'jpeg', 'webp']).optional(),
      quality: z.number().min(0).max(1).optional(),
    },
  },
] as const;

/** Lookup by MCP tool name. */
export const TOOL_BY_MCP_NAME: ReadonlyMap<string, ToolDef> = new Map(
  TOOLS.map((t) => [t.mcpName, t]),
);

/** mcpName → device.remote method. */
export const MCP_TO_METHOD: Readonly<Record<string, string>> =
  Object.fromEntries(TOOLS.map((t) => [t.mcpName, t.wsMethod]));

/** The set of IWER device.remote methods this catalog can drive (excludes
 * browser-host tools, which are serviced by the extension, not IWER). Used for
 * the runtime capability intersection. */
export const KNOWN_METHODS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => !t.browserTool).map((t) => t.wsMethod),
);

/** The screenshot tool that needs image post-processing. */
export const SCREENSHOT_TOOL = 'browser_screenshot';
