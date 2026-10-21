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
export const CATALOG_VERSION = 4;

// --- Reusable shapes -------------------------------------------------------

const poseDeviceEnum = z
  .enum([
    'headset',
    'controller-left',
    'controller-right',
    'hand-left',
    'hand-right',
    'gaze',
  ])
  .describe(
    'Tracked device id. Aliases like "right"/"left-hand" are also accepted.',
  );

const connectedInputDeviceEnum = z
  .enum([
    'controller-left',
    'controller-right',
    'hand-left',
    'hand-right',
    'gaze',
  ])
  .describe('A connectable input device (controller, hand, or gaze).');

const selectableDeviceEnum = z
  .enum(['controller-left', 'controller-right', 'hand-left', 'hand-right'])
  .describe('A controller or hand that can produce select state.');

const controllerEnum = z
  .enum(['controller-left', 'controller-right'])
  .describe('A controller (gamepad) device.');

const handEnum = z
  .enum(['hand-left', 'hand-right'])
  .describe('A hand-tracking device.');

// Keep in sync with iwer's BUILTIN_HAND_POSE_IDS (checked by contract tests).
export const HAND_POSE_IDS = [
  'default',
  'pinch',
  'point',
  'open',
  'flat',
  'fist',
  'thumbs-up',
  'finger-gun',
  'peace',
  'three',
  'four',
  'ok',
  'rock',
  'call',
  'pinch-middle',
  'pinch-ring',
  'pinch-pinky',
  'tripod',
  'key-pinch',
  'grip',
  'claw',
  'hook',
  'cup',
] as const;

// One short gloss per built-in pose, for xr_set_hand_pose.
const HAND_POSE_GLOSS: Record<(typeof HAND_POSE_IDS)[number], string> = {
  default: 'relaxed',
  pinch: 'thumb and index touching',
  point: 'index extended',
  open: 'high five',
  flat: 'fingers together, blade',
  fist: 'closed fist',
  'thumbs-up': 'fist with thumb up',
  'finger-gun': 'index and thumb out',
  peace: 'V sign',
  three: 'index, middle, ring up',
  four: 'four fingers up, thumb folded',
  ok: 'thumb-index circle',
  rock: 'index and pinky out',
  call: 'thumb and pinky out',
  'pinch-middle': 'thumb to middle tip',
  'pinch-ring': 'thumb to ring tip',
  'pinch-pinky': 'thumb to pinky tip',
  tripod: 'thumb, index, middle tips together',
  'key-pinch': 'thumb against side of index',
  grip: 'wrapped around a handle',
  claw: 'holding a ball',
  hook: 'carrying a bag handle',
  cup: 'scooping water',
};

const HAND_POSE_GLOSSES = HAND_POSE_IDS.map(
  (id) => `${id} (${HAND_POSE_GLOSS[id]})`,
).join(', ');

const fingerPose = z
  .union([
    z.string(),
    z
      .object({
        poseId: z.string(),
        weight: z.number().min(0).max(1).optional(),
      })
      .strict(),
  ])
  .describe(
    'A pose id, or {poseId, weight} where weight 0-1 blends from the base pose toward it.',
  );

const fingerPoses = z
  .object({
    thumb: fingerPose.optional(),
    index: fingerPose.optional(),
    middle: fingerPose.optional(),
    ring: fingerPose.optional(),
    pinky: fingerPose.optional(),
  })
  .strict()
  .describe('Fingers to take from other poses, on top of poseId.');

const vec3 = z
  .object({ x: z.number(), y: z.number(), z: z.number() })
  .describe('A 3D position in metres, XR-origin relative.');

const quat = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    w: z.number(),
  })
  .strict();
const euler = z
  .object({
    pitch: z.number().optional(),
    yaw: z.number().optional(),
    roll: z.number().optional(),
  })
  .strict();
const orientation = z
  .union([quat, euler])
  .describe(
    'Orientation as a quaternion {x,y,z,w} or euler degrees {pitch,yaw,roll}.',
  );

const direction = z
  .union([
    z.enum([
      'up',
      'down',
      'forward',
      'back',
      'left',
      'right',
      'toward-head',
      'away-from-head',
    ]),
    vec3.strict(),
    z.tuple([z.number(), z.number(), z.number()]),
  ])
  .describe(
    'A direction: a name (up, down, forward, back, left, right, toward-head, away-from-head; forward/left/right follow where the headset faces) or an XR-origin vector (approximate is fine).',
  );

// Hand directions come before quaternion/euler and every orientation object
// is strict, so a misspelt hand direction is an error, not an empty euler.
const handDirections = z
  .object({
    fingers: direction,
    palm: direction.optional(),
    thumb: direction.optional(),
  })
  .strict()
  .describe(
    'Hand orientation by direction: where the fingers point plus where the palm faces OR where the thumb side points. A thumbs up is {fingers:"forward", thumb:"up"}.',
  );

const placementOrientation = z
  .union([z.literal('auto'), handDirections, quat, euler])
  .describe(
    'For hands: {fingers, palm|thumb} directions, or "auto" (a natural reach from the shoulder toward the position). A quaternion {x,y,z,w} or euler degrees {pitch,yaw,roll} sets the device (for hands, the target ray) as before.',
  );

const handAnchor = z
  .string()
  .describe(
    'Hands: the point of the hand `position` places and keeps there while the hand changes shape: index-tip (press), grasp (where thumb and index tips meet in a full pinch), wrist (gestures), grip, thumb-tip, target-ray (default), or a WebXR joint name.',
  );

const easing = z
  .enum(['linear', 'minimum-jerk'])
  .describe('Time curve; minimum-jerk starts and stops like a human reach.');

const inputState = z
  .object({
    connected: z.boolean().optional(),
    position: vec3.optional(),
    orientation: orientation.optional(),
  })
  .strict();

const handState = inputState.extend({
  poseId: z.string().optional(),
  pinchValue: z.number().min(0).max(1).optional(),
});

const deviceStateSchema = z
  .object({
    headset: z
      .object({
        position: vec3.optional(),
        orientation: orientation.optional(),
      })
      .strict()
      .optional(),
    inputMode: z.enum(['controller', 'hand']).optional(),
    stereoEnabled: z.boolean().optional(),
    fov: z.number().optional(),
    controllers: z
      .object({ left: inputState.optional(), right: inputState.optional() })
      .strict()
      .optional(),
    hands: z
      .object({ left: handState.optional(), right: handState.optional() })
      .strict()
      .optional(),
    gaze: z
      .object({
        connected: z.boolean().optional(),
        orientation: orientation.optional(),
      })
      .strict()
      .optional(),
  })
  .partial()
  .strict();

// --- run_sequence ------------------------------------------------------------

const fraction = z.number().min(0).max(1);
const timedWindow = {
  start: fraction.optional(),
  end: fraction.optional(),
  easing: easing.optional(),
};

const sequenceTarget = z
  .union([
    z.string(),
    z
      .object({
        name: z.string(),
        face: z
          .enum(['front', 'back', 'top', 'bottom', 'left', 'right'])
          .optional(),
      })
      .strict(),
  ])
  .describe(
    'A target name from xr_list_targets, or {name, face}; resolved again when the step starts.',
  );

const sequencePosition = z
  .union([
    z.tuple([z.number(), z.number(), z.number()]),
    z
      .object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        normal: direction.optional(),
      })
      .strict(),
    z
      .object({
        relativeTo: z.enum(['head', 'body']),
        x: z.number(),
        y: z.number(),
        z: z.number(),
      })
      .strict(),
  ])
  .describe(
    'XR-origin metres (optionally with the surface normal), or {relativeTo:"head"|"body", x right, y up, z back} turning with the body, never with head pitch; "body" measures y from the floor.',
  );

const standOff = z
  .object({ distance: z.number().min(0), normal: direction.optional() })
  .strict();

const sequenceStep = z
  .object({
    label: z.string().optional(),
    duration: z
      .union([z.number().min(0), z.literal('auto')])
      .optional()
      .describe(
        'Seconds for the reach, or "auto" (the default for moves): scaled to distance, turn and pose change.',
      ),
    target: sequenceTarget.optional(),
    position: sequencePosition.optional(),
    offset: z
      .union([vec3.strict(), z.object({ normal: z.number() }).strict()])
      .optional()
      .describe(
        'Added to the target or position; {normal:d} moves d metres along the surface normal. Setting a held object down: its clearance above the surface.',
      ),
    approach: standOff
      .optional()
      .describe(
        'Come straight in along the surface normal (straight down while holding) for the last `distance` metres.',
      ),
    depart: standOff
      .optional()
      .describe(
        'Lift straight off first, along the last surface normal (straight up while holding).',
      ),
    press: z
      .object({
        depth: z.number().min(0).max(0.015).optional(),
        hold: z.number().min(0).max(0.2).optional(),
        retract: z.number().min(0.05).optional(),
      })
      .strict()
      .optional()
      .describe(
        'Press the target with the index fingertip: reach, go `depth` m (default 0.008) past the surface, hold `hold` s, pull back `retract` m. Implies anchor index-tip and pose point. Use this for buttons, not a pinch.',
      ),
    anchor: handAnchor.optional(),
    orientation: placementOrientation.optional(),
    poseId: z
      .union([
        z.string(),
        z.object({ value: z.string(), ...timedWindow }).strict(),
      ])
      .optional()
      .describe(
        'Pose to fade to during the step; {value, start, end} as fractions of the reach. Never "pinch": poses do not select.',
      ),
    fingers: fingerPoses.optional(),
    pinch: z
      .union([
        fraction,
        z.object({ value: fraction, ...timedWindow }).strict(),
        z.object({ value: fraction, at: z.literal('arrival') }).strict(),
      ])
      .optional()
      .describe(
        'Pinch 0..1 (selects at 0.9, lets go at 0.7). {value:1, at:"arrival"} opens to a grip and closes as the hand arrives; on a target it implies anchor grasp.',
      ),
    body: z
      .object({
        position: sequencePosition.optional(),
        stepTo: sequenceTarget.optional(),
        facing: direction.optional(),
      })
      .strict()
      .optional()
      .describe(
        'Move the body first: to position, or a step closer to stepTo; facing turns it. The hand goes along.',
      ),
  })
  .strict();

const RUN_SEQUENCE_DESCRIPTION =
  "Run a whole hand interaction in one call with natural motion: one smooth arc per move, the head turning to each target first, the body leaning or stepping closer when needed, the other hand resting by the hip. Steps run in order and each step's properties animate together. Positions are XR-origin metres; -Z is forward, +Y up. Resolves when done with the select events the app saw, step times, press contact times, warnings and the final hand state. " +
  'Rules: press buttons with `press`, not a pinch. To pick something up, target it with `pinch:{value:1,at:"arrival"}` (the grasp point, between thumb and index, goes on the target). While holding, targeting a surface sets the object down on it; let go with pinch 0. The anchor carries over to later steps. A thumbs up is poseId "thumbs-up" with orientation {fingers:"forward",thumb:"up"} at a head-relative position. Get names from xr_list_targets and check a plan with dryRun:true first. ' +
  'Example: {"device":"hand-right","steps":[{"label":"reach","target":"button","press":{}},{"label":"grab","target":"piece","approach":{"distance":0.06},"pinch":{"value":1,"at":"arrival"}},{"label":"carry","target":"tray","depart":{"distance":0.08},"approach":{"distance":0.06}},{"label":"release","pinch":0,"duration":0.15},{"label":"thumbs up","position":{"relativeTo":"head","x":0.12,"y":-0.35,"z":-0.35},"anchor":"wrist","orientation":{"fingers":"forward","thumb":"up"},"poseId":"thumbs-up"},{"label":"hold","duration":1}]}';

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
  /**
   * Reject unknown top-level params instead of silently dropping them (see
   * inputSchemaOf). Set on tools added or changed since catalog version 3.
   */
  strictInput?: boolean;
}

/** The Zod object a tool's arguments are validated against. */
export function inputSchemaOf(tool: ToolDef) {
  const schema = z.object(tool.inputShape);
  return tool.strictInput ? schema.strict() : schema;
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
      'Get the position, orientation (quaternion), and euler angles of a tracked device. Gaze reports the headset-derived origin and its world orientation.',
    readOnlyHint: true,
    inputShape: { device: poseDeviceEnum },
  },
  {
    mcpName: 'xr_set_transform',
    wsMethod: 'set_transform',
    title: 'Set device transform',
    description:
      'Set a device position and/or orientation immediately (XR-origin). Gaze accepts orientation only; move its origin with the headset. Hands: `anchor` puts that point of the hand at `position` and keeps it there while the hand changes shape (e.g. anchor "index-tip" on a button, "grasp" on an object before pinching); orientation may be hand directions or "auto". Requires an active session.',
    readOnlyHint: false,
    strictInput: true,
    inputShape: {
      device: poseDeviceEnum,
      position: vec3.optional(),
      orientation: placementOrientation.optional(),
      anchor: handAnchor.optional(),
    },
  },
  {
    mcpName: 'xr_look_at',
    wsMethod: 'look_at',
    title: 'Look at a point',
    description:
      'Orient a device toward an XR-origin-relative world point. Optionally move it to a given distance from the target; gaze does not support moving its origin. Requires an active session.',
    readOnlyHint: false,
    inputShape: {
      device: poseDeviceEnum,
      target: vec3,
      moveToDistance: z.number().optional(),
    },
  },
  {
    mcpName: 'xr_animate_to',
    wsMethod: 'animate_to',
    title: 'Animate device pose',
    description:
      'Animate a device to a target position and/or orientation (XR-origin) over `duration` seconds (default 0.5), from where it is when the animation starts. Gaze accepts orientation only. Hands take `anchor` and hand directions as in xr_set_transform. easing "minimum-jerk" moves like a person (default "linear"). For multi-step hand interactions (press, grab, carry, gestures) prefer xr_run_sequence. Requires an active, rendering session.',
    readOnlyHint: false,
    strictInput: true,
    inputShape: {
      device: poseDeviceEnum,
      position: vec3.optional(),
      orientation: placementOrientation.optional(),
      duration: z.number().positive().optional(),
      easing: easing.optional(),
      anchor: handAnchor.optional(),
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
    description: 'Connect or disconnect a controller, hand, or gaze source.',
    readOnlyHint: false,
    inputShape: { device: connectedInputDeviceEnum, connected: z.boolean() },
  },
  {
    mcpName: 'xr_get_select_value',
    wsMethod: 'get_select_value',
    title: 'Get select value',
    description:
      'Get the current select value (controller trigger or hand pinch), 0..1.',
    readOnlyHint: true,
    inputShape: { device: selectableDeviceEnum },
  },
  {
    mcpName: 'xr_set_select_value',
    wsMethod: 'set_select_value',
    title: 'Set select value',
    description:
      'Set the select value (trigger/pinch), 0..1, optionally ramping from the current value over `duration` seconds (easing default minimum-jerk). A hand pinch selects at 0.9 and lets go at 0.7; a trigger selects above 0. Use xr_select for a full press+release.',
    readOnlyHint: false,
    strictInput: true,
    inputShape: {
      device: selectableDeviceEnum,
      value: z.number().min(0).max(1),
      duration: z.number().min(0).optional(),
      easing: easing.optional(),
    },
  },
  {
    mcpName: 'xr_select',
    wsMethod: 'select',
    title: 'Select (press + release)',
    description:
      'Perform a full select gesture: selectstart on press, then select and selectend on release, holding `duration` seconds (default 0.15). A hand closes its pinch over 0.1 s before the hold and opens it over 0.1 s after. Requires an active session.',
    readOnlyHint: false,
    inputShape: {
      device: selectableDeviceEnum,
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
      'Get a full snapshot: headset pose, input mode, controllers, hands (with poseId and pinchValue), gaze, stereo, and FOV. Positions are XR-origin relative.',
    readOnlyHint: true,
    inputShape: {},
  },
  {
    mcpName: 'xr_set_device_state',
    wsMethod: 'set_device_state',
    title: 'Set device state',
    description:
      'Apply a partial device state (positions XR-origin; hands also take poseId and pinchValue). Call with no `state` to reset everything to defaults.',
    readOnlyHint: false,
    strictInput: true,
    inputShape: { state: deviceStateSchema.optional() },
  },
  {
    mcpName: 'xr_set_hand_pose',
    wsMethod: 'set_hand_pose',
    title: 'Set hand pose',
    description:
      `Set a named hand pose on a hand device. Poses only shape the hand; to pinch (select), use the pinch value (xr_set_select_value). Poses: ${HAND_POSE_GLOSSES}. ` +
      'Optionally take individual fingers from other poses, e.g. poseId "open" with fingers {"middle":"fist","ring":"fist","pinky":"fist"}, or blend partway with {"poseId":"fist","weight":0.5}. Setting a pose clears earlier finger overrides. `duration` fades from the hand as shown (easing default minimum-jerk); a hand placed by an anchor keeps the anchor in place.',
    readOnlyHint: false,
    strictInput: true,
    inputShape: {
      device: handEnum,
      poseId: z.string(),
      fingers: fingerPoses.optional(),
      duration: z.number().min(0).optional(),
      easing: easing.optional(),
    },
  },
  {
    mcpName: 'xr_get_hand_state',
    wsMethod: 'get_hand_state',
    title: 'Get hand state',
    description:
      'Read a hand: pose, finger blends, a pose fade in progress, pinch value, whether select is pressed, its anchor pin, and XR-origin positions of the wrist, grip, grasp point, index tip and thumb tip, plus its finger/palm/thumb directions (joints:"all" adds every joint).',
    readOnlyHint: true,
    strictInput: true,
    inputShape: {
      device: handEnum,
      joints: z.enum(['key', 'all']).optional(),
    },
  },
  {
    mcpName: 'xr_run_sequence',
    wsMethod: 'run_sequence',
    title: 'Run a hand sequence',
    description: RUN_SEQUENCE_DESCRIPTION,
    readOnlyHint: false,
    strictInput: true,
    inputShape: {
      device: handEnum,
      steps: z.array(sequenceStep).min(1),
      idleHand: z
        .enum(['keep', 'rest'])
        .optional()
        .describe(
          'The other hand: rest it by the hip (the default unless it is pinching) or keep it where it is.',
        ),
      body: z
        .enum(['auto', 'fixed'])
        .optional()
        .describe(
          'auto (default): lean for low targets and step closer to ones out of reach. fixed: out of reach is an error.',
        ),
      gaze: z
        .enum(['follow', 'fixed'])
        .optional()
        .describe(
          'follow (default): the head turns to each target before the hand gets there.',
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          'Validate and return the planned steps, walks, durations and warnings without moving anything.',
        ),
    },
  },
  {
    mcpName: 'xr_cancel_sequence',
    wsMethod: 'cancel_sequence',
    title: 'Cancel a hand sequence',
    description:
      'Stop the running xr_run_sequence where it is; that call returns with cancelled: true and the steps done. The pinch is left as it is (no select events).',
    readOnlyHint: false,
    strictInput: true,
    inputShape: {},
  },
  {
    mcpName: 'xr_list_targets',
    wsMethod: 'list_targets',
    title: 'List sequence targets',
    description:
      "List the named targets xr_run_sequence steps can use, from the page's target resolver: name, box centre and size (XR-origin). resolver:false means the page has none; use positions.",
    readOnlyHint: true,
    strictInput: true,
    inputShape: {},
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
