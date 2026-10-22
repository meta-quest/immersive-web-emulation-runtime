/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * JSON Schema (draft 2020-12 subset: type, properties, required,
 * additionalProperties, enum, anyOf, items, prefixItems, minItems, maxItems,
 * minimum, maximum, exclusiveMinimum) for the parameters of every
 * `device.remote` method. Kept free of imports so tool hosts (the extension
 * bridge, IWSDK) can read it without loading IWER: import
 * `iwer/lib/remote/catalog.js`. No `$ref` or `const`; unions use `anyOf`.
 *
 * Objects that reject unknown keys have `additionalProperties: false`; the
 * others (methods older than catalog version 3) accept and ignore them.
 */

type Schema = Record<string, unknown>;

const num: Schema = { type: 'number' };
const str: Schema = { type: 'string' };
const bool: Schema = { type: 'boolean' };
const int: Schema = { type: 'integer' };
const unit: Schema = { type: 'number', minimum: 0, maximum: 1 };
const seconds: Schema = { type: 'number', minimum: 0 };
const positive: Schema = { type: 'number', exclusiveMinimum: 0 };
const oneOf = (...values: string[]): Schema => ({
  type: 'string',
  enum: values,
});
/** An object that rejects unknown keys. */
const obj = (
  properties: Record<string, Schema>,
  required: string[] = [],
): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
/** An object that ignores unknown keys. */
const loose = (
  properties: Record<string, Schema>,
  required: string[] = [],
): Schema => ({ type: 'object', properties, required });

const vec3: Schema = loose({ x: num, y: num, z: num }, ['x', 'y', 'z']);
const strictVec3: Schema = obj({ x: num, y: num, z: num }, ['x', 'y', 'z']);
const tuple3: Schema = {
  type: 'array',
  prefixItems: [num, num, num],
  minItems: 3,
  maxItems: 3,
};
const quat: Schema = obj({ x: num, y: num, z: num, w: num }, [
  'x',
  'y',
  'z',
  'w',
]);
const euler: Schema = obj({ pitch: num, yaw: num, roll: num });
const orientation: Schema = { anyOf: [quat, euler] };
const direction: Schema = {
  anyOf: [
    oneOf(
      'up',
      'down',
      'forward',
      'back',
      'left',
      'right',
      'toward-head',
      'away-from-head',
    ),
    strictVec3,
    tuple3,
  ],
};
const handDirections: Schema = obj(
  { fingers: direction, palm: direction, thumb: direction },
  ['fingers'],
);
const placementOrientation: Schema = {
  anyOf: [oneOf('auto'), handDirections, quat, euler],
};
const easing: Schema = oneOf('linear', 'minimum-jerk');
const anchor: Schema = str;

const poseDevice = oneOf(
  'headset',
  'controller-left',
  'controller-right',
  'hand-left',
  'hand-right',
  'gaze',
);
const connectedDevice = oneOf(
  'controller-left',
  'controller-right',
  'hand-left',
  'hand-right',
  'gaze',
);
const selectDevice = oneOf(
  'controller-left',
  'controller-right',
  'hand-left',
  'hand-right',
);
const controller = oneOf('controller-left', 'controller-right');
const hand = oneOf('hand-left', 'hand-right');
const microgesture = oneOf(
  'swipe-left',
  'swipe-right',
  'swipe-forward',
  'swipe-backward',
  'tap',
);

const fingerPose: Schema = {
  anyOf: [str, obj({ poseId: str, weight: unit }, ['poseId'])],
};
const fingers: Schema = obj({
  thumb: fingerPose,
  index: fingerPose,
  middle: fingerPose,
  ring: fingerPose,
  pinky: fingerPose,
});

const inputState: Schema = obj({
  connected: bool,
  position: vec3,
  orientation,
});
const handState: Schema = obj({
  connected: bool,
  position: vec3,
  orientation,
  poseId: str,
  pinchValue: unit,
});

// run_sequence
const timed = (value: Schema): Schema => ({
  anyOf: [value, obj({ value, start: unit, end: unit, easing }, ['value'])],
});
const target: Schema = {
  anyOf: [
    str,
    obj(
      {
        name: str,
        face: oneOf('front', 'back', 'top', 'bottom', 'left', 'right'),
      },
      ['name'],
    ),
  ],
};
const sequencePosition: Schema = {
  anyOf: [
    tuple3,
    obj({ x: num, y: num, z: num, normal: direction }, ['x', 'y', 'z']),
    obj({ relativeTo: oneOf('head', 'body'), x: num, y: num, z: num }, [
      'relativeTo',
      'x',
      'y',
      'z',
    ]),
  ],
};
const standOff: Schema = obj({ distance: seconds, normal: direction }, [
  'distance',
]);
const sequenceStep: Schema = obj({
  label: str,
  duration: { anyOf: [seconds, oneOf('auto')] },
  target,
  position: sequencePosition,
  offset: { anyOf: [strictVec3, obj({ normal: num }, ['normal'])] },
  approach: standOff,
  depart: standOff,
  press: obj({
    depth: { type: 'number', minimum: 0, maximum: 0.015 },
    hold: { type: 'number', minimum: 0, maximum: 0.2 },
    retract: { type: 'number', minimum: 0.05 },
  }),
  anchor,
  orientation: placementOrientation,
  poseId: timed(str),
  fingers,
  pinch: {
    anyOf: [
      timed(unit),
      obj({ value: unit, at: oneOf('arrival') }, ['value', 'at']),
    ],
  },
  body: obj({ position: sequencePosition, stepTo: target, facing: direction }),
  microgesture,
});

/** Parameter schemas for every remote method, by method name. */
export const REMOTE_METHOD_SCHEMAS: Readonly<Record<string, Schema>> = {
  get_session_status: loose({}),
  accept_session: loose({}),
  end_session: loose({}),
  get_transform: loose({ device: poseDevice }, ['device']),
  set_transform: obj(
    {
      device: poseDevice,
      position: vec3,
      orientation: placementOrientation,
      anchor,
    },
    ['device'],
  ),
  look_at: loose({ device: poseDevice, target: vec3, moveToDistance: num }, [
    'device',
    'target',
  ]),
  animate_to: obj(
    {
      device: poseDevice,
      position: vec3,
      orientation: placementOrientation,
      duration: positive,
      easing,
      anchor,
    },
    ['device'],
  ),
  set_input_mode: loose({ mode: oneOf('controller', 'hand') }, ['mode']),
  set_connected: loose({ device: connectedDevice, connected: bool }, [
    'device',
    'connected',
  ]),
  get_select_value: loose({ device: selectDevice }, ['device']),
  set_select_value: obj(
    { device: selectDevice, value: unit, duration: seconds, easing },
    ['device', 'value'],
  ),
  select: loose({ device: selectDevice, duration: positive }, ['device']),
  get_gamepad_state: loose({ device: controller }, ['device']),
  set_gamepad_state: loose(
    {
      device: controller,
      buttons: {
        type: 'array',
        items: loose({ index: int, value: num, touched: bool }, [
          'index',
          'value',
        ]),
      },
      axes: {
        type: 'array',
        items: loose({ index: int, value: num }, ['index', 'value']),
      },
    },
    ['device'],
  ),
  get_device_state: loose({}),
  set_device_state: obj({
    state: obj({
      headset: obj({ position: vec3, orientation }),
      inputMode: oneOf('controller', 'hand'),
      stereoEnabled: bool,
      fov: num,
      controllers: obj({ left: inputState, right: inputState }),
      hands: obj({ left: handState, right: handState }),
      gaze: obj({ connected: bool, orientation }),
    }),
  }),
  set_hand_pose: obj(
    { device: hand, poseId: str, fingers, duration: seconds, easing },
    ['device', 'poseId'],
  ),
  get_hand_state: obj({ device: hand, joints: oneOf('key', 'all') }, [
    'device',
  ]),
  microgesture: obj({ device: hand, gesture: microgesture }, [
    'device',
    'gesture',
  ]),
  run_sequence: obj(
    {
      device: hand,
      steps: { type: 'array', items: sequenceStep, minItems: 1 },
      idleHand: oneOf('keep', 'rest'),
      body: oneOf('auto', 'fixed'),
      gaze: oneOf('follow', 'fixed'),
      dryRun: bool,
    },
    ['device', 'steps'],
  ),
  cancel_sequence: obj({}),
  list_targets: obj({}),
  get_world_state: loose({}),
  get_objects: loose({}),
};
