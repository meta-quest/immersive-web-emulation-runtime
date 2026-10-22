/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import type {
  FingerPoseBlend,
  HandAnchor,
  XRHandFinger,
  XRHandInput,
} from '../device/XRHandInput.js';
import {
  BodyFrame,
  Easing,
  PathEasing,
  bodyFrameFromHead,
  ease,
} from './hand-motion.js';
import type { Channel, ChannelEngine, ChannelRun } from './channels.js';
import {
  MICROGESTURES,
  MICROGESTURE_POSE,
  MICROGESTURE_READY_S,
  MicrogesturePlayer,
  isMicrogesture,
  microgestureSeconds,
  readyForMicrogesture,
} from './microgesture.js';
import type { Microgesture } from './microgesture.js';
import { edgeEventTypes } from '../gamepad/button-edges.js';
import type { GamepadButton } from '../gamepad/Gamepad.js';
import { XRHandJoint } from '../input/XRHand.js';
import { P_GAMEPAD, P_JOINT_SPACE, P_SPACE } from '../private.js';
import type {
  GetHandStateResult,
  RunSequenceParams,
  SequencePlan,
  SequenceResult,
  SequenceStep,
  SequenceTarget,
  TargetIntent,
  TargetResolver,
  TimedInput,
} from './types.js';

type HandDeviceId = RunSequenceParams['device'];

/** What the sequence runner needs from remote control (all GlobalSpace). */
export interface SequenceHost {
  /** The hand, whether or not the app sees it (validation at dispatch). */
  hand(deviceId: HandDeviceId): XRHandInput;
  /** The hand; throws unless the app sees it (when the sequence starts). */
  liveHand(deviceId: HandDeviceId): XRHandInput;
  /** The other hand, when it is connected. */
  otherHand(deviceId: HandDeviceId): XRHandInput | undefined;
  headPose(): { position: vec3; rotation: quat };
  setHeadPose(position: vec3, rotation: quat): void;
  originToGlobal(position: vec3): vec3;
  globalToOrigin(position: vec3): vec3;
  originDirectionToGlobal(direction: vec3): vec3;
  globalDirectionToOrigin(direction: vec3): vec3;
  /** A direction input (vector or name) as a GlobalSpace unit vector. */
  directionToGlobal(
    value: unknown,
    what: string,
    from?: vec3,
    body?: BodyFrame,
  ): vec3;
  anchorPosition(
    hand: XRHandInput,
    anchor: HandAnchor,
    graspPinch?: number,
  ): vec3;
  requireAnchor(anchor: unknown): HandAnchor;
  resolveOrientation(
    hand: XRHandInput,
    orientation: unknown,
    target: vec3 | null,
    body?: BodyFrame,
  ): {
    wristRotation?: quat;
    rayRotation?: { x: number; y: number; z: number; w: number };
  };
  parsePose(
    hand: XRHandInput,
    poseId: string,
    fingers: SequenceStep['fingers'],
  ): {
    poseId: string;
    fingers: Partial<Record<XRHandFinger, FingerPoseBlend>>;
  };
  /** Writes the pinch for the next frame. */
  setPinch(deviceId: HandDeviceId, value: number): void;
  /** The pinch last written: the one waiting for the next frame, else the current one. */
  latestPinch(deviceId: HandDeviceId): number;
  /** The hand's select button (its pinch). */
  pinchButton(deviceId: HandDeviceId): GamepadButton;
  /** One of the hand's microgesture buttons. */
  gestureButton(deviceId: HandDeviceId, gesture: Microgesture): GamepadButton;
  channels: ChannelEngine;
  resolver(): TargetResolver | null;
  handState(deviceId: HandDeviceId): GetHandStateResult;
  /**
   * The body's facing and standing head position, kept between sequences so
   * a head turned or leaned by one sequence doesn't turn or lower the body
   * for the next; null until a sequence has run.
   */
  bodyState(): { forward: vec3; standing: vec3 } | null;
  setBodyState(state: { forward: vec3; standing: vec3 }): void;
}

// =============================================================================
// Constants
// =============================================================================

/** Comfortable / maximum reach from the shoulder per anchor, metres. */
const REACH: Record<string, [number, number]> = {
  'index-tip': [0.62, 0.72],
  grasp: [0.58, 0.66],
  wrist: [0.48, 0.55],
};
const DEFAULT_REACH: [number, number] = [0.58, 0.68];
/** The body walks only for targets this far beyond comfortable reach. */
const WALK_MARGIN_M = 0.06;
const LEAN_BELOW_Y = 1.1;
const PINCH_CLOSE_S = 0.28;
const PINCH_HOLD_S = 0.06;
/** Pinch that opens the thumb and index to about a 5 cm grip aperture. */
const PRESHAPE_PINCH = 0.5;
/** Share of a gaze shift the head makes (the eyes do the rest). */
const GAZE_HEAD_SHARE = 0.7;
const HEAD_LEAD_S = 0.22;
const PRESS_DEFAULTS = { depth: 0.008, hold: 0.03, retract: 0.06 };
const MAX_PRESS_DEPTH = 0.015;
/** A touch is down while the fingertip is this close to the surface. */
const TOUCH_M = 0.02;
/** Longest a press may keep the fingertip in touch, in sequence seconds. */
const MAX_CONTACT_S = 0.35;
/** Idle sway: a held hand, the head and a resting hand are never still. */
const HAND_SWAY_M = 0.006;
const HEAD_SWAY_RAD = (1.2 * Math.PI) / 180;
const HEAD_SWAY_M = 0.003;
const IDLE_HAND_SWAY_M = 0.006;
/** The other hand counts as in the way this close to a target. */
const OTHER_HAND_M = 0.1;
/** A sequence plus everything queued ahead of it must fit this, in seconds. */
export const SEQUENCE_BUDGET_S = 25;

const STEP_KEYS = [
  'label',
  'duration',
  'position',
  'target',
  'offset',
  'approach',
  'depart',
  'press',
  'anchor',
  'orientation',
  'poseId',
  'fingers',
  'pinch',
  'body',
  'microgesture',
];
const SEQUENCE_KEYS = ['device', 'steps', 'idleHand', 'body', 'gaze', 'dryRun'];
const UP = vec3.fromValues(0, 1, 0);

// =============================================================================
// Geometry helpers
// =============================================================================

const isNum = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n);

const vecOf = (value: unknown, what: string): vec3 => {
  if (Array.isArray(value) && value.length === 3 && value.every(isNum)) {
    return vec3.fromValues(value[0], value[1], value[2]);
  }
  const v = value as { x?: unknown; y?: unknown; z?: unknown } | null;
  if (v && isNum(v.x) && isNum(v.y) && isNum(v.z)) {
    return vec3.fromValues(v.x, v.y, v.z);
  }
  throw new Error(
    `${what} must be {x, y, z} or [x, y, z] with finite numbers (got ${JSON.stringify(value)}).`,
  );
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const strictKeys = (value: unknown, allowed: string[], what: string) => {
  if (!isObject(value)) {
    throw new Error(`${what} must be an object.`);
  }
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new Error(
      `${what} has unknown key${extra.length > 1 ? 's' : ''} ${extra
        .map((k) => `'${k}'`)
        .join(', ')}. Allowed: ${allowed.join(', ')}.`,
    );
  }
};

/**
 * One smooth arc from `start` to `end`: a cubic Bézier that leaves along
 * `startTangent` (a lift-off) and arrives along `endTangent` (the approach,
 * pointing away from the end), sampled by arc length. With one easing over
 * its length the hand lifts, travels and comes in as a single motion, with no
 * corners and no stops.
 */
class ArcPath {
  private samples: vec3[] = [];
  private lengths: number[] = [];
  readonly length: number;

  constructor(
    start: vec3,
    end: vec3,
    startTangent?: { direction: vec3; distance: number },
    endTangent?: { direction: vec3; distance: number },
  ) {
    const chord = vec3.distance(start, end);
    const handle = (t?: { direction: vec3; distance: number }) =>
      t
        ? Math.min(
            Math.max(t.distance * 1.25, chord * 0.25),
            chord * 0.6 + t.distance,
          )
        : 0;
    const p1 = startTangent
      ? vec3.scaleAndAdd(
          vec3.create(),
          start,
          startTangent.direction,
          handle(startTangent),
        )
      : vec3.lerp(vec3.create(), start, end, 1 / 3);
    const p2 = endTangent
      ? vec3.scaleAndAdd(
          vec3.create(),
          end,
          endTangent.direction,
          handle(endTangent),
        )
      : vec3.lerp(vec3.create(), start, end, 2 / 3);
    const n = chord < 1e-5 && !startTangent && !endTangent ? 1 : 96;
    let total = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const p = vec3.create();
      vec3.scale(p, start, u * u * u);
      vec3.scaleAndAdd(p, p, p1, 3 * u * u * t);
      vec3.scaleAndAdd(p, p, p2, 3 * u * t * t);
      vec3.scaleAndAdd(p, p, end, t * t * t);
      if (i > 0) total += vec3.distance(this.samples[i - 1], p);
      this.samples.push(p);
      this.lengths.push(total);
    }
    this.length = total;
  }

  /** The point at fraction `s` (0 to 1) of the path's length. */
  at(out: vec3, s: number): vec3 {
    if (this.length === 0) {
      return vec3.copy(out, this.samples[0]);
    }
    const d = Math.min(1, Math.max(0, s)) * this.length;
    let lo = 0;
    let hi = this.lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.lengths[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = this.lengths[hi] - this.lengths[lo];
    const f = span > 0 ? (d - this.lengths[lo]) / span : 0;
    return vec3.lerp(out, this.samples[lo], this.samples[hi], f);
  }
}

/**
 * Reach time for a path: long enough that the hand peaks below about
 * 0.9 m/s, plus time for large wrist turns and pose changes.
 */
const autoMoveSeconds = (
  pathLength: number,
  turnDeg: number,
  poseChange: boolean,
) =>
  Math.min(
    1.8,
    Math.max(
      0.45 + 1.1 * pathLength,
      2.1 * pathLength,
      turnDeg > 1 ? 0.3 + turnDeg / 220 : 0,
      poseChange ? 0.4 : 0,
    ),
  );

/** Seconds to walk `distance` metres and turn `turn` radians on the spot. */
const walkSeconds = (distance: number, turn: number) =>
  Math.max(
    distance > 0.01 ? 0.5 + 0.9 * distance : 0,
    Math.abs(turn) > 0.01 ? 0.3 + Math.abs(turn) / Math.PI : 0,
  );

const angleBetween = (a: quat, b: quat) =>
  (2 * Math.acos(Math.min(1, Math.abs(quat.dot(a, b)))) * 180) / Math.PI;

/** Head rotation (yaw, then pitch; no roll) looking from `from` to `to`. */
const lookRotation = (from: vec3, to: vec3, out: quat): quat => {
  const d = vec3.sub(vec3.create(), to, from);
  if (vec3.length(d) < 1e-6) return out;
  vec3.normalize(d, d);
  const yaw = Math.atan2(-d[0], -d[2]);
  const pitch = Math.max(
    (-60 * Math.PI) / 180,
    Math.min((20 * Math.PI) / 180, Math.asin(Math.max(-1, Math.min(1, d[1])))),
  );
  const qy = quat.setAxisAngle(quat.create(), [0, 1, 0], yaw);
  const qx = quat.setAxisAngle(quat.create(), [1, 0, 0], pitch);
  return quat.normalize(out, quat.multiply(out, qy, qx));
};

const yawRotation = (angle: number, out = quat.create()) =>
  quat.setAxisAngle(out, UP, angle);

// =============================================================================
// Planning
// =============================================================================

interface TimedValue<T> {
  value: T;
  start: number; // seconds from segment start
  end: number;
  easing: Easing;
}

/**
 * A walk (and turn) of the body: the head and the resting hand move rigidly
 * with it, and so does the acting hand when the step doesn't place it. A
 * step that places the hand walks while the arm reaches.
 */
interface BodyMove {
  /** Horizontal translation, GlobalSpace. */
  shift: vec3;
  /** Yaw turn in radians, about `pivot`. */
  turn: number;
  pivot: vec3;
  /** Seconds from the segment start, and how long it takes. */
  start: number;
  seconds: number;
  /** The acting hand goes along (pins and wrist rotation included). */
  carriesHand: boolean;
}

/** One primitive motion: a step, or part of an expanded `press`. */
interface Segment {
  step: number;
  label: string;
  kind: SequencePlan['segments'][number]['kind'];
  /** For press segments: the surface point and normal (contact timing). */
  press?: { point: vec3; normal: vec3 };
  /** For microgesture segments: the gesture, from `start` seconds. */
  micro?: { player: MicrogesturePlayer; start: number };
  /** Computes the path and channel targets when the segment starts. */
  prepare: (ctx: RunContext) => void;
  duration: number; // seconds, filled by prepare (estimate before)
  stallAfter: boolean;
  /** The next step moves the hand (a let-go leaves the lift-off to it). */
  nextPlaces?: boolean;
  /** For holds on a surface: the hand sways along it, never into it. */
  restNormal?: vec3;
  // filled by prepare:
  walk?: BodyMove;
  /** Lean change (head lower and forward), made with the reach. */
  lean?: vec3;
  path?: ArcPath;
  pathEasing?: PathEasing;
  pathStart?: number; // seconds when the path starts (after any walk and head lead)
  pathEnd?: number; // seconds when the path arrives
  /** For holds: where the head looks ahead to (the next step's target). */
  lookAhead?: (ctx: RunContext) => vec3 | null;
  wristFrom?: quat;
  wristTo?: quat;
  pose?: TimedValue<{
    poseId: string;
    fingers: Partial<Record<XRHandFinger, FingerPoseBlend>>;
  }>;
  pinch?: TimedValue<number> & {
    from: number;
    preshape?: { value: number; start: number; end: number };
  };
  headFrom?: { position: vec3; rotation: quat };
  headTo?: { position: vec3; rotation: quat };
  headStart?: number;
  headEnd?: number;
  target?: vec3; // final anchor target, GlobalSpace
}

interface RunContext {
  host: SequenceHost;
  params: RunSequenceParams;
  /**
   * When planning at dispatch (dry run, time budget): the pose and pinch the
   * hand will have when the next segment starts. Null while running.
   */
  planned: { poseId: string; blended: boolean; pinch: number } | null;
  hand: XRHandInput;
  anchor: HandAnchor;
  body: BodyFrame;
  warnings: string[];
  /** The head's pose without sway, GlobalSpace (the runner keeps it current). */
  head: { position: vec3; rotation: quat };
  /** Whether the other hand is lowered to rest. */
  restsOtherHand: boolean;
  /** Normal of the previous placement (GlobalSpace), for `depart`. */
  lastNormal: vec3 | null;
  /** A lift-off the next placing step makes unless it sets `depart`. */
  autoDepart: {
    normal: vec3;
    distance: number;
    fromPress?: boolean;
    fromRelease?: boolean;
  } | null;
  /** What the hand holds: its name and how far its base is below the grasp point. */
  held: { name: string; graspToBottom: number } | null;
  /** The pinch the grasp point is taken at: the last closing pinch's value. */
  graspPinch: number;
  /** The direction the hand came down onto a surface from, while it rests there. */
  restNormal: vec3 | null;
  /** The body's walk (horizontal, GlobalSpace) and lean (down and forward). */
  walk: vec3;
  lean: vec3;
  /** Head position when the sequence started, before any walk or lean. */
  standingHead: vec3;
  /** Wall-clock contact windows of presses (touch within 2 cm). */
  contacts: { label: string; startPerf?: number; endPerf?: number }[];
}

const where = (index: number, step: unknown) =>
  `Step ${index}${isObject(step) && typeof step.label === 'string' ? ` ('${step.label}')` : ''}`;

const timedOf = <T>(
  value: TimedInput<T> | undefined,
  duration: number,
  fallbackEasing: Easing,
): TimedValue<T> | undefined => {
  if (value === undefined) return undefined;
  if (isObject(value) && 'value' in value) {
    const v = value as {
      value: T;
      start?: number;
      end?: number;
      easing?: Easing;
    };
    const start = Math.min(1, Math.max(0, v.start ?? 0));
    const end = Math.min(1, Math.max(start, v.end ?? 1));
    return {
      value: v.value,
      start: start * duration,
      end: end * duration,
      easing: v.easing ?? fallbackEasing,
    };
  }
  return { value: value as T, start: 0, end: duration, easing: fallbackEasing };
};

const pinchValueOf = (pinch: SequenceStep['pinch']) =>
  typeof pinch === 'number' ? pinch : (pinch?.value ?? 0);

const stepClosesPinch = (step: SequenceStep) =>
  step.pinch !== undefined && pinchValueOf(step.pinch) >= 0.9;

// Opening below the release level (0.7) lets go of what is held.
const stepOpensPinch = (step: SequenceStep) =>
  step.pinch !== undefined && pinchValueOf(step.pinch) < 0.7;

const stepPlaces = (step: SequenceStep) =>
  step.position !== undefined ||
  step.target !== undefined ||
  step.offset !== undefined;

/**
 * Validates a sequence and expands it into segments. Geometry that depends on
 * where things are at run time is computed by each segment's `prepare`.
 */
export const planSequence = (
  host: SequenceHost,
  params: RunSequenceParams,
): Segment[] => {
  strictKeys(params, SEQUENCE_KEYS, 'run_sequence');
  if (params.device !== 'hand-left' && params.device !== 'hand-right') {
    throw new Error(
      `run_sequence drives one hand: device must be 'hand-left' or 'hand-right' (got '${String(params.device)}').`,
    );
  }
  if (!Array.isArray(params.steps) || params.steps.length === 0) {
    throw new Error('run_sequence needs a non-empty steps array.');
  }
  for (const [key, allowed] of [
    ['idleHand', ['keep', 'rest']],
    ['body', ['auto', 'fixed']],
    ['gaze', ['follow', 'fixed']],
  ] as const) {
    const value = params[key];
    if (
      value !== undefined &&
      !(allowed as readonly unknown[]).includes(value)
    ) {
      throw new Error(`${key} must be one of ${allowed.join(', ')}.`);
    }
  }
  if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') {
    throw new Error('dryRun must be true or false.');
  }
  const segments: Segment[] = [];
  let anchorSeen = false;
  params.steps.forEach((original, index) => {
    const at = where(index, original);
    strictKeys(original, STEP_KEYS, at);
    let step = original;
    try {
      validateStep(host, params, step);
    } catch (error) {
      throw new Error(`${at}: ${(error as Error).message}`);
    }
    // Implied defaults: a press is made with the index fingertip of a
    // pointing hand; a pinch that closes on a target is made at the grasp
    // point. Other steps carry the previous anchor over.
    if (step.press) {
      if (step.anchor !== undefined && step.anchor !== 'index-tip') {
        throw new Error(`${at}: press is made with anchor 'index-tip'.`);
      }
      step = {
        ...step,
        anchor: 'index-tip',
        poseId: step.poseId ?? { value: 'point', start: 0, end: 0.5 },
        // A pointing hand tucks its thumb against the curled fingers.
        fingers:
          step.fingers ??
          (step.poseId === undefined
            ? { thumb: { poseId: 'fist', weight: 0.6 } }
            : undefined),
      };
    } else if (
      stepClosesPinch(step) &&
      step.anchor === undefined &&
      (step.target !== undefined || step.position !== undefined)
    ) {
      step = { ...step, anchor: 'grasp' };
    }
    const places = stepPlaces(step);
    if (step.anchor !== undefined) {
      host.requireAnchor(step.anchor);
      anchorSeen = true;
    }
    if (places && !anchorSeen) {
      throw new Error(
        `${at} places the hand but no anchor has been named yet. Add "anchor" (e.g. "index-tip" to touch, "grasp" to pinch, "wrist" for gestures).`,
      );
    }
    const label = step.label ?? `step ${index}`;
    const following = params.steps[index + 1];
    const nextPlaces = following !== undefined && stepPlaces(following);
    if (step.microgesture !== undefined) {
      segments.push(microgestureSegment(index, label, step.microgesture));
    } else if (step.press) {
      segments.push(...pressSegments(index, label, step, nextPlaces));
    } else {
      const next = params.steps.slice(index + 1).find(stepPlaces);
      const segment = stepSegment(index, label, step, places, next);
      segment.nextPlaces = nextPlaces;
      segments.push(segment);
    }
  });
  return segments;
};

const validatePosition = (value: unknown, what: string) => {
  if (Array.isArray(value)) {
    vecOf(value, what);
    return;
  }
  if (isObject(value) && 'relativeTo' in value) {
    strictKeys(value, ['relativeTo', 'x', 'y', 'z'], what);
    if (value.relativeTo !== 'head' && value.relativeTo !== 'body') {
      throw new Error(`${what}.relativeTo must be 'head' or 'body'.`);
    }
  } else {
    strictKeys(value, ['x', 'y', 'z', 'normal'], what);
  }
  vecOf(value, what);
};

const validateTarget = (host: SequenceHost, value: unknown, what: string) => {
  if (isObject(value)) {
    strictKeys(value, ['name', 'face'], what);
    if (typeof value.name !== 'string') {
      throw new Error(`${what}.name must be a string.`);
    }
    if (
      value.face !== undefined &&
      !['front', 'back', 'top', 'bottom', 'left', 'right'].includes(
        value.face as string,
      )
    ) {
      throw new Error(
        `${what}.face must be front, back, top, bottom, left or right.`,
      );
    }
  } else if (typeof value !== 'string') {
    throw new Error(`${what} must be a name or { name, face }.`);
  }
  if (!host.resolver()) {
    throw new Error(
      'targets need a target resolver; the page registers one with remote.setTargetResolver(). Use position instead.',
    );
  }
};

const validateTimedKeys = (value: unknown, what: string) => {
  if (isObject(value)) {
    strictKeys(value, ['value', 'start', 'end', 'easing'], what);
    for (const key of ['start', 'end'] as const) {
      const f = value[key];
      if (f !== undefined && !(isNum(f) && f >= 0 && f <= 1)) {
        throw new Error(`${what}.${key} must be a fraction of the step, 0–1.`);
      }
    }
    if (
      value.easing !== undefined &&
      value.easing !== 'linear' &&
      value.easing !== 'minimum-jerk'
    ) {
      throw new Error(`${what}.easing must be linear or minimum-jerk.`);
    }
  }
};

const validateStep = (
  host: SequenceHost,
  params: RunSequenceParams,
  step: SequenceStep,
) => {
  const hand = host.hand(params.device);
  if (step.microgesture !== undefined) {
    if (!isMicrogesture(step.microgesture)) {
      throw new Error(
        `microgesture must be one of ${MICROGESTURES.join(', ')}.`,
      );
    }
    const others = Object.keys(step).filter(
      (key) => key !== 'label' && key !== 'microgesture',
    );
    if (others.length > 0) {
      throw new Error(
        `a microgesture step takes only a label (got ${others.join(', ')}); move or pose the hand in a step before it.`,
      );
    }
    if (!hand.poseIds.includes(MICROGESTURE_POSE)) {
      throw new Error(
        `the hand has no '${MICROGESTURE_POSE}' pose to make microgestures from.`,
      );
    }
  }
  if (
    step.duration !== undefined &&
    step.duration !== 'auto' &&
    !(isNum(step.duration) && step.duration >= 0)
  ) {
    throw new Error(`duration must be seconds ≥ 0 or 'auto'.`);
  }
  if (step.label !== undefined && typeof step.label !== 'string') {
    throw new Error('label must be a string.');
  }
  if (step.position !== undefined && step.target !== undefined) {
    throw new Error('give either position or target, not both.');
  }
  if (step.position !== undefined) {
    validatePosition(step.position, 'position');
    const normal = (step.position as { normal?: unknown }).normal;
    if (normal !== undefined) {
      host.directionToGlobal(normal, 'position.normal');
    }
  }
  if (step.target !== undefined) {
    validateTarget(host, step.target, 'target');
  }
  if (step.offset !== undefined) {
    if (isObject(step.offset) && 'normal' in step.offset) {
      strictKeys(step.offset, ['normal'], 'offset');
      if (!isNum(step.offset.normal)) {
        throw new Error('offset.normal must be a number of metres.');
      }
    } else {
      strictKeys(step.offset, ['x', 'y', 'z'], 'offset');
      vecOf(step.offset, 'offset');
    }
  }
  for (const key of ['approach', 'depart'] as const) {
    const v = step[key];
    if (v !== undefined) {
      strictKeys(v, ['distance', 'normal'], key);
      if (!isNum(v.distance) || v.distance < 0) {
        throw new Error(`${key}.distance must be metres ≥ 0.`);
      }
      if (v.normal !== undefined) {
        host.directionToGlobal(v.normal, `${key}.normal`);
      }
    }
  }
  if (step.press !== undefined) {
    strictKeys(step.press, ['depth', 'hold', 'retract'], 'press');
    const {
      depth = PRESS_DEFAULTS.depth,
      hold = PRESS_DEFAULTS.hold,
      retract = PRESS_DEFAULTS.retract,
    } = step.press;
    if (!isNum(depth) || depth < 0 || depth > MAX_PRESS_DEPTH) {
      throw new Error(
        `press.depth must be 0–${MAX_PRESS_DEPTH} m (a finger press travels 5–15 mm; deeper passes through thin panels).`,
      );
    }
    if (!isNum(hold) || hold < 0 || hold > 0.2) {
      throw new Error('press.hold must be 0–0.2 s.');
    }
    if (!isNum(retract) || retract < 0.05) {
      throw new Error(
        'press.retract must be at least 0.05 m (a touch lets go beyond 2 cm).',
      );
    }
    if (step.target === undefined && step.position === undefined) {
      throw new Error('press needs a target or position to press.');
    }
    if (step.pinch !== undefined) {
      throw new Error('press and pinch can not share a step.');
    }
  }
  if (step.poseId !== undefined) {
    validateTimedKeys(step.poseId, 'poseId');
    const poseId = isObject(step.poseId)
      ? (step.poseId as { value: unknown }).value
      : step.poseId;
    if (poseId === 'pinch') {
      throw new Error(
        `poseId 'pinch' only shapes the hand and never selects; use "pinch": 1 to pinch.`,
      );
    }
    host.parsePose(hand, poseId as string, step.fingers);
  } else if (step.fingers !== undefined) {
    throw new Error('fingers needs a poseId in the same step.');
  }
  if (step.pinch !== undefined) {
    const p: unknown = step.pinch;
    if (isObject(p) && 'at' in p) {
      strictKeys(p, ['value', 'at'], 'pinch');
      if (p.at !== 'arrival') {
        throw new Error(`pinch.at must be 'arrival'.`);
      }
      if (!stepPlaces(step)) {
        throw new Error(`pinch.at 'arrival' needs a placement to arrive at.`);
      }
    } else {
      validateTimedKeys(p, 'pinch');
    }
    const value = isObject(p) ? p.value : p;
    if (!isNum(value) || value < 0 || value > 1) {
      throw new Error('pinch must be 0–1 (1 = fingertips together).');
    }
  }
  if (step.body !== undefined) {
    strictKeys(step.body, ['position', 'stepTo', 'facing'], 'body');
    if (step.body.position !== undefined && step.body.stepTo !== undefined) {
      throw new Error('body takes position or stepTo, not both.');
    }
    if (step.body.position !== undefined) {
      validatePosition(step.body.position, 'body.position');
    }
    if (step.body.stepTo !== undefined) {
      validateTarget(host, step.body.stepTo, 'body.stepTo');
    }
    if (step.body.facing !== undefined) {
      const facing = host.directionToGlobal(step.body.facing, 'body.facing');
      if (Math.hypot(facing[0], facing[2]) < 1e-3) {
        throw new Error('body.facing must not point straight up or down.');
      }
    }
  }
  if (step.orientation !== undefined && step.orientation !== 'auto') {
    host.resolveOrientation(hand, step.orientation, vec3.create());
  }
};

/** The closest names to `name`, for an unknown-target error. */
const closestNames = (known: string[], name: string) =>
  known
    .map((k) => ({ k, d: editDistance(k.toLowerCase(), name.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.k);

const editDistance = (a: string, b: string): number => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
};

/** Resolves a target name to its surface point and normal (GlobalSpace). */
const resolveTarget = (
  ctx: RunContext,
  target: SequenceTarget,
  anchor: HandAnchor,
  intent: TargetIntent,
) => {
  const { host } = ctx;
  const resolver = host.resolver();
  const name = typeof target === 'string' ? target : target.name;
  if (!resolver) {
    throw new Error(
      `target '${name}' needs a target resolver (remote.setTargetResolver()).`,
    );
  }
  const from = host.globalToOrigin(shoulderOf(ctx));
  const resolved = resolver.resolve(target, {
    device: ctx.params.device,
    anchor,
    intent,
    from: { x: from[0], y: from[1], z: from[2] },
  });
  if (!resolved) {
    const known = closestNames(
      resolver.list?.().map((t) => t.name) ?? [],
      name,
    );
    throw new Error(
      `Unknown target '${name}'.${known.length ? ` Known targets: ${known.slice(0, 8).join(', ')}.` : ''}`,
    );
  }
  const point = host.originToGlobal(
    vecOf(resolved.position, 'resolved position'),
  );
  const normal = resolved.normal
    ? vec3.normalize(
        vec3.create(),
        host.originDirectionToGlobal(vecOf(resolved.normal, 'resolved normal')),
      )
    : null;
  let graspToBottom: number | undefined;
  if (intent === 'grasp' && resolved.box) {
    // How far the object's base is below the point it is held by.
    const min = host.originToGlobal(vecOf(resolved.box.min, 'box.min'));
    graspToBottom = Math.max(0, point[1] - min[1]);
  }
  return { point, normal, name, graspToBottom };
};

/**
 * A step position in GlobalSpace. `relativeTo: 'head'` is the standing head
 * (walks included, leans not) and `'body'` the floor under it, turned by the
 * body's yaw: no head pitch or roll, so a gesture lands where it is meant to.
 */
const positionOf = (ctx: RunContext, value: unknown): vec3 => {
  const v = vecOf(value, 'position');
  if (isObject(value) && value.relativeTo) {
    const b = ctx.body;
    const head = vec3.add(vec3.create(), ctx.standingHead, ctx.walk);
    if (value.relativeTo === 'body') head[1] = 0;
    const point = vec3.scaleAndAdd(vec3.create(), head, b.right, v[0]);
    point[1] += v[1];
    return vec3.scaleAndAdd(point, point, b.forward, -v[2]);
  }
  return ctx.host.originToGlobal(v);
};

/** The anchor target (GlobalSpace) and normal for a step's placement. */
const resolvePlacement = (
  ctx: RunContext,
  step: SequenceStep,
  anchor: HandAnchor,
  intent: TargetIntent,
): {
  point: vec3;
  normal: vec3 | null;
  name?: string;
  graspToBottom?: number;
} | null => {
  const { host } = ctx;
  let point: vec3 | null = null;
  let normal: vec3 | null = null;
  let name: string | undefined;
  let graspToBottom: number | undefined;
  const placing = intent === 'place' && ctx.held !== null;
  if (step.target !== undefined) {
    ({ point, normal, name, graspToBottom } = resolveTarget(
      ctx,
      step.target,
      anchor,
      intent,
    ));
  } else if (step.position !== undefined) {
    point = positionOf(ctx, step.position);
    const n = (step.position as { normal?: unknown }).normal;
    if (n !== undefined) {
      normal = host.directionToGlobal(
        n,
        'position.normal',
        point,
        bodyNow(ctx),
      );
    }
  }
  if (placing && point) {
    // Setting a held object down: its base goes on the surface, `offset.normal`
    // above it (0.5 mm by default).
    const n = normal ?? UP;
    const clearance =
      step.offset && 'normal' in step.offset ? step.offset.normal : 0.0005;
    point = vec3.scaleAndAdd(
      vec3.create(),
      point,
      n,
      clearance + ctx.held!.graspToBottom,
    );
    return { point, normal, name };
  }
  if (step.offset !== undefined) {
    const base = point ?? currentTarget(ctx, anchor);
    if ('normal' in step.offset) {
      point = vec3.scaleAndAdd(
        vec3.create(),
        base,
        normal ?? UP,
        step.offset.normal,
      );
    } else {
      point = vec3.add(
        vec3.create(),
        base,
        host.originDirectionToGlobal(vecOf(step.offset, 'offset')),
      );
    }
  }
  return point ? { point, normal, name, graspToBottom } : null;
};

/** The acting shoulder for a body walk and lean (GlobalSpace). */
const shoulderAt = (ctx: RunContext, walk: vec3, lean: vec3): vec3 => {
  const b = ctx.body;
  const out = vec3.add(vec3.create(), ctx.standingHead, walk);
  vec3.add(out, out, lean);
  vec3.scaleAndAdd(
    out,
    out,
    b.right,
    ctx.params.device === 'hand-left' ? -0.18 : 0.18,
  );
  out[1] -= 0.25;
  vec3.scaleAndAdd(out, out, b.forward, -0.05);
  return out;
};

const shoulderOf = (ctx: RunContext): vec3 =>
  shoulderAt(ctx, ctx.walk, ctx.lean);

/** The body frame as it is now: the head walked and leaned, the body's facing. */
const bodyNow = (ctx: RunContext): BodyFrame => {
  const head = vec3.add(vec3.create(), ctx.standingHead, ctx.walk);
  return {
    head: vec3.add(head, head, ctx.lean),
    forward: vec3.clone(ctx.body.forward),
    right: vec3.clone(ctx.body.right),
  };
};

const reachFor = (anchor: HandAnchor): [number, number] =>
  REACH[anchor as string] ?? DEFAULT_REACH;

/** The walk that brings `point` to comfortable reach of the shoulder. */
const walkToward = (
  ctx: RunContext,
  point: vec3,
  anchor: HandAnchor,
  lean: vec3,
  margin: number,
): vec3 => {
  const walk = vec3.clone(ctx.walk);
  const [comfortable] = reachFor(anchor);
  const shoulder = shoulderAt(ctx, walk, lean);
  if (vec3.distance(shoulder, point) > comfortable + margin) {
    const horizontal = vec3.fromValues(
      point[0] - shoulder[0],
      0,
      point[2] - shoulder[2],
    );
    const h = vec3.length(horizontal);
    if (h > 1e-6) {
      const dy = point[1] - shoulder[1];
      const neededH = Math.sqrt(
        Math.max(0, comfortable * comfortable - dy * dy),
      );
      vec3.scaleAndAdd(
        walk,
        walk,
        vec3.normalize(horizontal, horizontal),
        Math.max(0, h - neededH),
      );
    }
  }
  return walk;
};

/**
 * The walk a step asks for explicitly: to `body.position` (its height is
 * ignored), or to comfortable reach of `body.stepTo`. Null without one.
 */
const explicitWalk = (
  ctx: RunContext,
  step: SequenceStep,
  anchor: HandAnchor,
): vec3 | null => {
  const explicit = step.body;
  if (explicit?.position !== undefined) {
    const p = positionOf(ctx, explicit.position);
    return vec3.fromValues(
      p[0] - ctx.standingHead[0],
      0,
      p[2] - ctx.standingHead[2],
    );
  }
  if (explicit?.stepTo !== undefined) {
    const { point } = resolveTarget(ctx, explicit.stepTo, anchor, 'touch');
    return walkToward(ctx, point, anchor, ctx.lean, 0);
  }
  return null;
};

/**
 * Where the body should be for a placement with `body: 'auto'`: it leans
 * (head lower and forward, up to 10 cm) for targets below 1.1 m and
 * straightens for higher ones, and walks only when the target is beyond
 * comfortable reach + 6 cm (and the step didn't move the body itself),
 * stopping at comfortable reach.
 */
const autoBody = (
  ctx: RunContext,
  point: vec3 | null,
  anchor: HandAnchor,
  walked: boolean,
): { walk: vec3; lean: vec3 } => {
  if (!point || ctx.params.body === 'fixed') {
    return { walk: vec3.clone(ctx.walk), lean: vec3.clone(ctx.lean) };
  }
  // Lean only toward low targets out in front (not, say, the user's own hip).
  const lean = vec3.create();
  const standingShoulder = shoulderAt(ctx, ctx.walk, lean);
  const ahead =
    (point[0] - standingShoulder[0]) * ctx.body.forward[0] +
    (point[2] - standingShoulder[2]) * ctx.body.forward[2];
  if (point[1] < LEAN_BELOW_Y && ahead > 0.25) {
    const amount = Math.min(0.1, (LEAN_BELOW_Y - point[1]) * 0.4);
    lean[1] = -amount;
    vec3.scaleAndAdd(lean, lean, ctx.body.forward, amount * 0.6);
  }
  const walk = walked
    ? vec3.clone(ctx.walk)
    : walkToward(ctx, point, anchor, lean, WALK_MARGIN_M);
  return { walk, lean };
};

/** Where `p` is moved to by a walk (or `f` of it). */
const carry = (move: BodyMove, p: vec3, f: number, out = vec3.create()) => {
  vec3.sub(out, p, move.pivot);
  vec3.transformQuat(out, out, yawRotation(move.turn * f));
  vec3.add(out, out, move.pivot);
  return vec3.scaleAndAdd(out, out, move.shift, f);
};

/** The walk that undoes `move` from where it ends. */
const reverseOf = (move: BodyMove): BodyMove => ({
  ...move,
  shift: vec3.negate(vec3.create(), move.shift),
  turn: -move.turn,
  pivot: vec3.add(vec3.create(), move.pivot, move.shift),
});

/** A rotation turned by a walk (or `f` of it). */
const carryRotation = (
  move: BodyMove,
  q: quat,
  f: number,
  out = quat.create(),
) => quat.multiply(out, yawRotation(move.turn * f), q);

/**
 * Points of the hand as it is now (wrist, knuckles, fingertips, and where a
 * straightened middle fingertip would be), relative to `anchor`, in the
 * wrist frame. Moved along a path with the wrist's rotation, they show where
 * the whole hand goes, not just the anchor.
 */
const handProbe = (ctx: RunContext, anchor: HandAnchor): vec3[] => {
  const { hand } = ctx;
  const joints = hand.inputSource.hand!;
  const toWrist = mat4.create();
  mat4.invert(toWrist, joints.get(XRHandJoint.Wrist)![P_SPACE].offsetMatrix);
  const anchorLocal = vec3.transformMat4(
    vec3.create(),
    hand.anchorOffset(anchor, vec3.create(), ctx.graspPinch),
    toWrist,
  );
  const points = [
    XRHandJoint.Wrist,
    XRHandJoint.ThumbTip,
    XRHandJoint.IndexFingerTip,
    XRHandJoint.MiddleFingerTip,
    XRHandJoint.RingFingerTip,
    XRHandJoint.PinkyFingerTip,
    XRHandJoint.IndexFingerPhalanxProximal,
    XRHandJoint.PinkyFingerPhalanxProximal,
  ].map((joint) =>
    vec3.transformMat4(
      vec3.create(),
      mat4.getTranslation(
        vec3.create(),
        joints.get(joint)![P_SPACE].offsetMatrix,
      ),
      toWrist,
    ),
  );
  // The hand may open on the way: allow for a straight middle finger.
  points.push(vec3.fromValues(0, 0, -0.17));
  return points.map((point) => vec3.sub(point, point, anchorLocal));
};

// Joint centres sit this far inside the skin, plus a little air.
const HAND_SKIN_M = 0.012;

/**
 * Listed boxes the hand passes through on `path` (other than the step's own
 * target), with how far below each box's top the hand dips. A box the move
 * starts or ends on can be approached from above (setting a hand down on a
 * table is not hitting it) but not through its sides.
 */
const obstaclesOnPath = (
  ctx: RunContext,
  path: ArcPath,
  ignore: string | undefined,
  probe: vec3[],
  wristFrom: quat,
  wristTo: quat,
): { name: string; top: number; depth: number }[] => {
  const list = ctx.host.resolver()?.list?.() ?? [];
  const hits: { name: string; top: number; depth: number }[] = [];
  const anchor = vec3.create();
  const point = vec3.create();
  const rotation = quat.create();
  for (const box of list) {
    if (!box.size || box.name === ignore || box.name === ctx.held?.name) {
      continue;
    }
    const center = ctx.host.originToGlobal(
      vecOf(box.position, 'list position'),
    );
    const half = vecOf(box.size, 'list size');
    vec3.scale(half, half, 0.5);
    const top = center[1] + half[1];
    const near = (q: vec3, margin: number) =>
      Math.abs(q[0] - center[0]) < half[0] + margin &&
      Math.abs(q[1] - center[1]) < half[1] + margin &&
      Math.abs(q[2] - center[2]) < half[2] + margin;
    const restsOn =
      near(path.at(anchor, 0), 0.06) || near(path.at(anchor, 1), 0.06);
    let depth = 0;
    // The ends are where the hand already is and where it is meant to be.
    for (let i = 2; i <= 18; i++) {
      const f = i / 20;
      path.at(anchor, f);
      quat.slerp(rotation, wristFrom, wristTo, f);
      for (const offset of probe) {
        vec3.transformQuat(point, offset, rotation);
        vec3.add(point, point, anchor);
        const m = HAND_SKIN_M;
        if (
          Math.abs(point[0] - center[0]) < half[0] + m &&
          Math.abs(point[2] - center[2]) < half[2] + m &&
          point[1] > center[1] - half[1] - m &&
          point[1] < top + (restsOn ? 0 : m)
        ) {
          depth = Math.max(depth, top + m - point[1]);
        }
      }
    }
    if (depth > 0) hits.push({ name: box.name, top, depth });
  }
  return hits;
};

const stepSegment = (
  index: number,
  label: string,
  step: SequenceStep,
  places: boolean,
  next: SequenceStep | undefined,
): Segment => {
  const segment: Segment = {
    step: index,
    label,
    kind: places ? 'move' : 'hold',
    duration: isNum(step.duration) ? step.duration : places ? 0.8 : 0.3,
    stallAfter: true,
    prepare: (ctx) => prepareMove(ctx, segment, step, places),
  };
  if (!places && next) {
    // A hold looks ahead to where the hand goes next.
    segment.lookAhead = (ctx) => {
      try {
        const anchor = next.press
          ? 'index-tip'
          : ((next.anchor as HandAnchor) ?? ctx.anchor);
        return (
          resolvePlacement(ctx, next, anchor, next.press ? 'press' : 'touch')
            ?.point ?? null
        );
      } catch {
        return null;
      }
    };
  }
  return segment;
};

/**
 * A microgesture where the hand is: the hand takes the microgesture pose
 * first (letting a light pinch go) unless it is ready, then the thumb moves
 * and the gesture's button pulses. The hand holds still meanwhile.
 */
const microgestureSegment = (
  index: number,
  label: string,
  gesture: Microgesture,
): Segment => {
  const segment: Segment = {
    step: index,
    label,
    kind: 'microgesture',
    duration: MICROGESTURE_READY_S + microgestureSeconds(gesture),
    stallAfter: true,
    prepare: (ctx) => {
      const { hand, host, planned } = ctx;
      const pinching =
        'the hand is pinching (select is pressed); open the pinch (pinch: 0) in a step before the microgesture.';
      if (planned) {
        if (planned.pinch >= 0.9) {
          ctx.warnings.push(
            `${where(segment.step, ctx.params.steps[segment.step])}: ${pinching}`,
          );
        }
      } else if (hand.inputSource.gamepad!.buttons[0]!.pressed) {
        // Checked when the step starts: a step before it may let go.
        throw new Error(pinching);
      }
      prepareMove(ctx, segment, { duration: 0 }, false);
      const pinch = planned?.pinch ?? host.latestPinch(ctx.params.device);
      const ready = planned
        ? planned.poseId === MICROGESTURE_POSE &&
          !planned.blended &&
          pinch === 0
        : readyForMicrogesture(hand, pinch);
      const lead = ready ? 0 : MICROGESTURE_READY_S;
      if (lead > 0) {
        segment.pose = {
          value: host.parsePose(hand, MICROGESTURE_POSE, undefined),
          start: 0,
          end: lead,
          easing: 'minimum-jerk',
        };
        if (pinch > 0) {
          segment.pinch = {
            value: 0,
            start: 0,
            end: lead,
            easing: 'minimum-jerk',
            from: pinch,
          };
        }
      }
      const player = new MicrogesturePlayer(hand, gesture);
      segment.micro = { player, start: lead };
      segment.duration = lead + player.duration;
    },
  };
  return segment;
};

/**
 * Seconds the eased path spends within `TOUCH_M` of the surface (measured
 * along `normal` from `point`), from its end backwards (`fromEnd`) or from its
 * start forwards.
 */
const touchSeconds = (
  path: ArcPath,
  easing: PathEasing,
  seconds: number,
  point: vec3,
  normal: vec3,
  fromEnd: boolean,
) => {
  const p = vec3.create();
  const n = 200;
  for (let i = 0; i <= n; i++) {
    const t = fromEnd ? 1 - i / n : i / n;
    path.at(p, ease(easing, t));
    vec3.sub(p, p, point);
    if (vec3.dot(p, normal) > TOUCH_M) {
      return (i / n) * seconds;
    }
  }
  return seconds;
};

const pressSegments = (
  index: number,
  label: string,
  step: SequenceStep,
  followedByPlacement: boolean,
): Segment[] => {
  const press = { ...PRESS_DEFAULTS, ...step.press };
  // Shared between the sub-steps: the surface point and normal of the press,
  // and how long the reach keeps the fingertip in touch.
  const shared: { point?: vec3; normal?: vec3; contact?: number } = {};
  // Reach and press are one arc that comes straight in along the normal and
  // slows into the surface, then a short hold at depth. The pull-back is the
  // next step's lift-off when one follows (no stop in between), else its own
  // straight move.
  const reach: Segment = {
    step: index,
    label,
    kind: 'press',
    duration: 0.8,
    stallAfter: false,
    prepare: (ctx) => {
      ctx.anchor = 'index-tip';
      const placement = resolvePlacement(ctx, step, 'index-tip', 'press');
      if (!placement) throw new Error('press needs a target or position.');
      if (!placement.normal) {
        throw new Error(
          'press needs the surface normal: use a target (the resolver gives it) or position with a normal.',
        );
      }
      vec3.add(
        placement.point,
        placement.point,
        aimJitter(index, 0.002, placement.normal),
      );
      shared.point = placement.point;
      shared.normal = placement.normal;
      // The fingertip pad, not the tip joint, presses: the joint stops its
      // radius short of the pressed depth.
      const tipRadius =
        ctx.hand.inputSource.hand!.get(XRHandJoint.IndexFingerTip)![
          P_JOINT_SPACE
        ].radius || 0.007;
      const depth = vec3.scaleAndAdd(
        vec3.create(),
        placement.point,
        placement.normal,
        tipRadius - press.depth,
      );
      prepareMove(
        ctx,
        reach,
        {
          ...step,
          target: undefined,
          position: undefined,
          offset: undefined,
          press: undefined,
          orientation:
            step.orientation ?? pressDirections(ctx, depth, placement.normal),
        },
        true,
        {
          point: depth,
          normal: placement.normal,
          approachDistance: press.retract + press.depth,
          name:
            typeof step.target === 'string' ? step.target : step.target?.name,
          intent: 'press',
        },
      );
      reach.press = { point: placement.point, normal: placement.normal };
      // Keep the whole touch, reach in to pull out, within the contact limit
      // (no stall is made inside it): a slow settle into the surface gives
      // way to a minimum-jerk one, then to a quicker reach.
      const budget =
        MAX_CONTACT_S -
        press.hold -
        (followedByPlacement ? DEPART_EXIT_S : RETRACT_EXIT_S);
      const moveS = reach.pathEnd! - reach.pathStart!;
      const tail = (easing: PathEasing, seconds: number) =>
        touchSeconds(
          reach.path!,
          easing,
          seconds,
          placement.point,
          placement.normal!,
          true,
        );
      if (tail('reach', moveS) > budget) {
        reach.pathEasing = 'minimum-jerk';
        const slow = tail('minimum-jerk', moveS);
        if (slow > budget) {
          const quicker = moveS * Math.max(0.5, budget / slow);
          reach.pathEnd = reach.pathStart! + quicker;
          if (reach.pose) {
            reach.pose.end = Math.min(
              reach.pose.end,
              reach.pathStart! + quicker * 0.6,
            );
            reach.pose.start = Math.min(reach.pose.start, reach.pose.end);
          }
          reach.duration = Math.max(
            reach.pathEnd,
            reach.walk ? reach.walk.start + reach.walk.seconds : 0,
          );
        }
      }
      shared.contact = tail(
        reach.pathEasing!,
        reach.pathEnd! - reach.pathStart!,
      );
    },
  };
  const hold: Segment = {
    step: index,
    label,
    kind: 'press-hold',
    duration: press.hold,
    stallAfter: !followedByPlacement,
    prepare: (ctx) => {
      hold.press = { point: shared.point!, normal: shared.normal! };
      // Whatever the reach left of the contact limit.
      const exit = followedByPlacement ? DEPART_EXIT_S : RETRACT_EXIT_S;
      hold.duration = Math.max(
        0,
        Math.min(press.hold, MAX_CONTACT_S - shared.contact! - exit),
      );
      holdStill(ctx, hold);
      if (followedByPlacement) {
        ctx.autoDepart = {
          normal: vec3.clone(shared.normal!),
          distance: press.retract + press.depth + 0.04,
          fromPress: true,
        };
        ctx.lastNormal = vec3.clone(shared.normal!);
      }
    },
  };
  if (followedByPlacement) {
    return [reach, hold];
  }
  const retract: Segment = {
    step: index,
    label,
    kind: 'retract',
    duration: RETRACT_S,
    stallAfter: true,
    prepare: (ctx) => {
      const end = vec3.scaleAndAdd(
        vec3.create(),
        shared.point!,
        shared.normal!,
        press.retract,
      );
      straightMove(ctx, retract, end, RETRACT_S);
      retract.press = { point: shared.point!, normal: shared.normal! };
      ctx.autoDepart = { normal: vec3.clone(shared.normal!), distance: 0.04 };
      ctx.lastNormal = vec3.clone(shared.normal!);
    },
  };
  return [reach, hold, retract];
};

/**
 * The pull-back after a press and roughly when it leaves touch range, and
 * when the next step's lift-off does instead.
 */
const RETRACT_S = 0.25;
const RETRACT_EXIT_S = 0.1;
const DEPART_EXIT_S = 0.12;

/**
 * A small, repeatable aiming offset across the surface (people never hit
 * dead centre): up to `radius` metres, seeded by the step index.
 */
const aimJitter = (step: number, radius: number, normal: vec3): vec3 => {
  const a = Math.sin(step * 12.9898 + 78.233) * 43758.5453;
  const b = Math.sin(step * 39.3468 + 11.135) * 24634.6345;
  const u = a - Math.floor(a);
  const v = b - Math.floor(b);
  const helper =
    Math.abs(normal[1]) < 0.9
      ? vec3.fromValues(0, 1, 0)
      : vec3.fromValues(1, 0, 0);
  const t1 = vec3.normalize(
    vec3.create(),
    vec3.cross(vec3.create(), normal, helper),
  );
  const t2 = vec3.cross(vec3.create(), normal, t1);
  const angle = u * 2 * Math.PI;
  const r = radius * Math.sqrt(v);
  const out = vec3.scale(vec3.create(), t1, Math.cos(angle) * r);
  return vec3.scaleAndAdd(out, out, t2, Math.sin(angle) * r);
};

/**
 * A pressing hand: the finger angled 35–40° into the surface (between the
 * forearm's line and straight in), palm toward the surface, as XR-origin
 * directions.
 */
const pressDirections = (ctx: RunContext, target: vec3, normal: vec3) => {
  const elbow = shoulderOf(ctx);
  elbow[1] -= 0.25;
  vec3.scaleAndAdd(elbow, elbow, ctx.body.forward, 0.12);
  const along = vec3.normalize(
    vec3.create(),
    vec3.sub(vec3.create(), target, elbow),
  );
  const fingers = vec3.normalize(
    vec3.create(),
    vec3.scaleAndAdd(vec3.create(), along, normal, -0.45),
  );
  const palm = vec3.negate(vec3.create(), normal);
  const toOrigin = (v: vec3): [number, number, number] => {
    const o = ctx.host.globalDirectionToOrigin(v);
    return [o[0], o[1], o[2]];
  };
  return { fingers: toOrigin(fingers), palm: toOrigin(palm) };
};

/**
 * Where `anchor` is now: the pin's target when the hand is pinned by that
 * anchor, else the anchor's current position (so changing anchors between
 * steps never makes the hand jump).
 */
const currentTarget = (ctx: RunContext, anchor: HandAnchor): vec3 => {
  const pin = ctx.hand.pin;
  return pin &&
    pin.anchor === anchor &&
    (anchor !== 'grasp' || (pin.graspPinch ?? 1) === ctx.graspPinch)
    ? vec3.clone(pin.target)
    : ctx.host.anchorPosition(ctx.hand, anchor, ctx.graspPinch);
};

/** Keeps the hand where it is (with its wrist rotation) for a segment. */
const holdStill = (ctx: RunContext, segment: Segment) => {
  const here = currentTarget(ctx, ctx.anchor);
  segment.path = new ArcPath(here, here);
  segment.pathStart = 0;
  segment.pathEnd = segment.duration;
  segment.target = here;
  segment.wristFrom = ctx.hand.wristRotation();
  segment.wristTo = ctx.hand.pin?.wristRotation
    ? quat.clone(ctx.hand.pin.wristRotation)
    : segment.wristFrom;
};

/** A straight move of the pinned anchor to `end`. */
const straightMove = (
  ctx: RunContext,
  segment: Segment,
  end: vec3,
  seconds: number,
) => {
  const start = currentTarget(ctx, ctx.anchor);
  segment.path = new ArcPath(start, end);
  segment.pathEasing = 'minimum-jerk';
  segment.duration = seconds;
  segment.pathStart = 0;
  segment.pathEnd = seconds;
  segment.target = end;
  segment.wristFrom = ctx.hand.wristRotation();
  segment.wristTo = ctx.hand.pin?.wristRotation
    ? quat.clone(ctx.hand.pin.wristRotation)
    : segment.wristFrom;
};

/** Finger curl for a precision pinch: the free fingers fold in, more toward the little finger. */
const PINCH_CURL: Partial<Record<XRHandFinger, number>> = {
  middle: 0.35,
  ring: 0.45,
  pinky: 0.55,
};

const pinchCurlFingers = (): SequenceStep['fingers'] => {
  const out: Record<string, { poseId: string; weight: number }> = {};
  for (const [finger, weight] of Object.entries(PINCH_CURL)) {
    out[finger] = { poseId: 'fist', weight: weight! };
  }
  return out;
};

/** Warns when the other hand, left where it is, is close to a target. */
const checkOtherHand = (ctx: RunContext, segment: Segment, point: vec3) => {
  if (ctx.restsOtherHand) return;
  const other = ctx.host.otherHand(ctx.params.device);
  if (!other) return;
  const near = (['wrist', 'grasp', 'index-tip', 'thumb-tip'] as const).some(
    (anchor) =>
      vec3.distance(ctx.host.anchorPosition(other, anchor), point) <
      OTHER_HAND_M,
  );
  if (near) {
    ctx.warnings.push(
      `${where(segment.step, ctx.params.steps[segment.step])}: the other hand is within 10 cm of where this hand goes and may touch it first; rest it (idleHand: 'rest') or move it away.`,
    );
  }
};

const prepareMove = (
  ctx: RunContext,
  segment: Segment,
  step: SequenceStep,
  places: boolean,
  override?: {
    point: vec3;
    normal: vec3 | null;
    approachDistance?: number;
    name?: string;
    intent: TargetIntent;
  },
) => {
  const { host, hand } = ctx;
  if (step.anchor !== undefined) ctx.anchor = host.requireAnchor(step.anchor);
  const anchor = ctx.anchor;
  const closes = stepClosesPinch(step);
  if (closes) {
    // The grasp point is where the tips end up at this pinch, so the object
    // sits between them.
    ctx.graspPinch = pinchValueOf(step.pinch);
  }
  // The pinch last written (a value waiting for the next frame included).
  const pinchNow = host.latestPinch(ctx.params.device);
  const pinchedNow = pinchNow >= 0.5;
  const releases = stepOpensPinch(step) && pinchedNow;
  const start = currentTarget(ctx, anchor);
  let end = start;
  let normal: vec3 | null = null;
  let targetName: string | undefined = override?.name;
  let startTangent: { direction: vec3; distance: number } | undefined;
  let endTangent: { direction: vec3; distance: number } | undefined;
  let leavingPress = false;
  // Body: an explicit turn and walk come first, so the placement is
  // resolved from where the body ends up; then the lean (and, beyond reach,
  // a walk) for the placement.
  const pivot = vec3.add(vec3.create(), ctx.standingHead, ctx.walk);
  const walkFrom = vec3.clone(ctx.walk);
  const leanFrom = vec3.clone(ctx.lean);
  let turn = 0;
  if (step.body?.facing !== undefined) {
    const facing = host.directionToGlobal(
      step.body.facing,
      'body.facing',
      undefined,
      bodyNow(ctx),
    );
    turn =
      Math.atan2(-facing[0], -facing[2]) -
      Math.atan2(-ctx.body.forward[0], -ctx.body.forward[2]);
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    const q = yawRotation(turn);
    vec3.transformQuat(ctx.body.forward, ctx.body.forward, q);
    vec3.transformQuat(ctx.body.right, ctx.body.right, q);
  }
  const walked = explicitWalk(ctx, step, anchor);
  if (walked) ctx.walk = walked;
  let placement: ReturnType<typeof resolvePlacement> = null;
  if (places) {
    const intent: TargetIntent =
      override?.intent ??
      (closes ? 'grasp' : ctx.held && pinchedNow ? 'place' : 'touch');
    placement = override ?? resolvePlacement(ctx, step, anchor, intent);
  }
  const body = autoBody(ctx, placement?.point ?? null, anchor, !!walked);
  ctx.walk = body.walk;
  ctx.lean = body.lean;
  const walkShift = vec3.sub(vec3.create(), ctx.walk, walkFrom);
  const leanShift = vec3.sub(vec3.create(), ctx.lean, leanFrom);
  const walkS = walkSeconds(vec3.length(walkShift), turn);
  if (walkS > 0) {
    segment.walk = {
      shift: walkShift,
      turn,
      pivot,
      start: 0,
      seconds: walkS,
      carriesHand: !places,
    };
  }
  // A step that doesn't place the hand walks first, carrying it.
  const walkFirst = segment.walk?.carriesHand ? walkS : 0;
  if (vec3.length(leanShift) > 1e-4) segment.lean = leanShift;
  // Where the hand is once the body has carried it.
  const carried = segment.walk?.carriesHand
    ? carry(segment.walk, start, 1)
    : start;
  end = carried;
  if (placement) {
    end = placement.point;
    normal = placement.normal;
    targetName = placement.name ?? targetName;
    if (closes && !override) {
      vec3.add(end, end, aimJitter(segment.step, 0.0015, normal ?? UP));
    }
    if (closes && targetName) {
      ctx.held = {
        name: targetName,
        graspToBottom: placement.graspToBottom ?? 0,
      };
    }
    // Lift-off: the step's own `depart`, else the automatic one after a
    // press or a release. While holding something, lift straight up.
    const depart =
      step.depart !== undefined
        ? {
            distance: step.depart.distance,
            direction:
              step.depart.normal !== undefined
                ? host.directionToGlobal(
                    step.depart.normal,
                    'depart.normal',
                    start,
                    bodyNow(ctx),
                  )
                : pinchedNow || !ctx.lastNormal
                  ? vec3.clone(UP)
                  : ctx.lastNormal,
          }
        : ctx.autoDepart
          ? {
              distance: ctx.autoDepart.distance,
              direction: ctx.autoDepart.normal,
            }
          : undefined;
    leavingPress =
      step.depart === undefined &&
      (ctx.autoDepart?.fromPress === true ||
        ctx.autoDepart?.fromRelease === true);
    ctx.autoDepart = null;
    if (depart && depart.distance > 0) startTangent = depart;
    const approachDistance =
      step.approach?.distance ?? override?.approachDistance ?? 0;
    if (approachDistance > 0) {
      endTangent = {
        distance: approachDistance,
        direction:
          step.approach?.normal !== undefined
            ? host.directionToGlobal(
                step.approach.normal,
                'approach.normal',
                end,
                bodyNow(ctx),
              )
            : pinchedNow
              ? vec3.clone(UP)
              : (normal ??
                vec3.normalize(
                  vec3.create(),
                  vec3.sub(vec3.create(), shoulderOf(ctx), end),
                )),
      };
    }
    ctx.lastNormal = normal;
    const [, max] = reachFor(anchor);
    const reachDistance = vec3.distance(shoulderOf(ctx), end);
    if (reachDistance > max + 1e-3) {
      const message = `${where(segment.step, ctx.params.steps[segment.step])}: the ${anchor} target is ${reachDistance.toFixed(2)} m from the shoulder (max ${max} m).`;
      if (ctx.params.body === 'fixed') {
        throw new Error(
          `${message} Use body: 'auto', or move the body with body.stepTo.`,
        );
      }
      ctx.warnings.push(message);
    }
    checkOtherHand(ctx, segment, end);
  } else if (releases) {
    // Letting go: the fingers open first and the hand lifts away once the
    // pinch has let go of the object, so the object never hops. When the
    // hand moves on next, that move lifts off, in one motion.
    if (!segment.nextPlaces) {
      end = vec3.scaleAndAdd(vec3.create(), carried, UP, 0.035);
    }
    ctx.autoDepart = {
      normal: vec3.clone(UP),
      distance: 0.03,
      fromRelease: true,
    };
  }
  let path = new ArcPath(carried, end, startTangent, endTangent);
  // Orientation: explicit; else a natural reach for a new placement with the
  // pinch open; else, while holding, turn with the carry about the vertical
  // only (the held object stays upright); else hold.
  const wristNow = hand.wristRotation();
  const pinnedWrist = hand.pin?.wristRotation
    ? quat.clone(hand.pin.wristRotation)
    : null;
  const wristFrom = segment.walk?.carriesHand
    ? carryRotation(segment.walk, wristNow, 1)
    : wristNow;
  let wristTo: quat | undefined;
  const orientation =
    step.orientation ?? (places && !pinchedNow ? 'auto' : undefined);
  if (orientation !== undefined) {
    const resolved = host.resolveOrientation(
      hand,
      orientation,
      end,
      bodyNow(ctx),
    );
    if (resolved.wristRotation) wristTo = resolved.wristRotation;
    else if (resolved.rayRotation) {
      const r = resolved.rayRotation;
      const wristLocal = quat.multiply(
        quat.create(),
        quat.invert(quat.create(), hand.quaternion.quat),
        wristNow,
      );
      wristTo = quat.multiply(
        quat.create(),
        quat.fromValues(r.x, r.y, r.z, r.w),
        wristLocal,
      );
    }
  } else if (places && pinchedNow) {
    const shoulder = shoulderOf(ctx);
    const yawOf = (p: vec3) =>
      Math.atan2(-(p[0] - shoulder[0]), -(p[2] - shoulder[2]));
    const turnWith = (yawOf(end) - yawOf(carried)) * 0.6;
    wristTo = quat.multiply(
      quat.create(),
      yawRotation(turnWith),
      pinnedWrist ?? wristFrom,
    );
  }
  segment.wristFrom = wristFrom;
  segment.wristTo =
    wristTo ??
    (pinnedWrist
      ? segment.walk?.carriesHand
        ? carryRotation(segment.walk, pinnedWrist, 1)
        : pinnedWrist
      : wristFrom);
  if (places) {
    // Clearance for the whole hand: arc over whatever it would pass through,
    // higher until it clears (or warn).
    const radius =
      anchor === 'index-tip'
        ? 0.02
        : anchor === 'grasp'
          ? 0.04
          : anchor === 'wrist'
            ? 0.11
            : 0.06;
    const probe = handProbe(ctx, anchor);
    const check = () =>
      obstaclesOnPath(
        ctx,
        path,
        targetName,
        probe,
        segment.wristFrom!,
        segment.wristTo!,
      );
    let hits = check();
    let extra = 0;
    for (let attempt = 0; attempt < 4 && hits.length > 0; attempt++) {
      // Lift the curve's handles above the tallest obstacle hit (not the
      // start or end height, which would arc a move that only grazes
      // something up over it), more each time the hand still dips into it.
      const top = Math.max(...hits.map((hit) => hit.top));
      extra += Math.max(...hits.map((hit) => hit.depth)) + 0.02;
      const clear = top + radius + extra;
      const lift = (
        from: vec3,
        tangent?: { direction: vec3; distance: number },
      ) => {
        const need = Math.max(0, clear - from[1]);
        // Already above the obstacles: leave this end of the arc alone.
        if (need <= 0) return tangent;
        if (!tangent) return { direction: UP, distance: need };
        const blended = vec3.normalize(
          vec3.create(),
          vec3.scaleAndAdd(vec3.create(), tangent.direction, UP, 1),
        );
        return {
          direction: blended,
          distance: Math.max(tangent.distance, need),
        };
      };
      path = new ArcPath(
        carried,
        end,
        lift(carried, startTangent),
        lift(end, endTangent),
      );
      hits = check();
    }
    if (hits.length > 0) {
      ctx.warnings.push(
        `${where(segment.step, ctx.params.steps[segment.step])}: the hand passes through ${hits.map((hit) => hit.name).join(', ')}; add depart/approach distance or a step around it.`,
      );
    }
  }
  segment.path = path;
  segment.target = vec3.clone(end);
  if (places) {
    ctx.restNormal = endTangent ? vec3.clone(endTangent.direction) : null;
  } else if (ctx.restNormal) {
    segment.restNormal = ctx.restNormal;
  }
  // Pose: explicit; else a pinch closing on a target curls the free fingers.
  let poseChange = false;
  if (step.poseId !== undefined) {
    const raw = isObject(step.poseId)
      ? (step.poseId as { value: string; start?: number; end?: number })
      : { value: step.poseId as string };
    const fingers = step.fingers ?? (closes ? pinchCurlFingers() : undefined);
    const parsed = host.parsePose(hand, raw.value, fingers);
    poseChange =
      parsed.poseId !== hand.poseId ||
      JSON.stringify(parsed.fingers) !== JSON.stringify(hand.fingerPoses);
    if (poseChange) {
      segment.pose = {
        ...timedOf(raw as TimedInput<string>, 1, 'minimum-jerk')!,
        value: parsed,
      };
    }
  } else if (closes) {
    const parsed = host.parsePose(hand, hand.poseId, pinchCurlFingers());
    if (JSON.stringify(parsed.fingers) !== JSON.stringify(hand.fingerPoses)) {
      poseChange = true;
      segment.pose = {
        value: parsed,
        start: 0.1,
        end: 0.7,
        easing: 'minimum-jerk',
      };
    }
  }
  // Gaze: the head turns toward where the hand is going, part of the way
  // (the eyes do the rest), and leads the hand when the turn is large.
  const head = {
    position: vec3.clone(ctx.head.position),
    rotation: quat.clone(ctx.head.rotation),
  };
  const headPosTo = segment.walk
    ? carry(segment.walk, head.position, 1)
    : vec3.clone(head.position);
  vec3.add(headPosTo, headPosTo, leanShift);
  const headRotationWalked = segment.walk
    ? carryRotation(segment.walk, head.rotation, 1)
    : head.rotation;
  segment.headFrom = head;
  segment.headTo = { position: headPosTo, rotation: headRotationWalked };
  segment.headStart = walkFirst;
  let lead = 0;
  const below = (p: vec3) => {
    const d = vec3.sub(vec3.create(), p, headPosTo);
    return Math.asin(
      Math.max(-1, Math.min(1, d[1] / Math.max(1e-6, vec3.length(d)))),
    );
  };
  const lookAtTarget = places ? end : carried;
  // People don't watch their hand drop to their side.
  const worthLooking = below(lookAtTarget) > (-65 * Math.PI) / 180;
  if (ctx.params.gaze !== 'fixed' && places && !worthLooking) {
    // The hand drops to the user's side: look back at the scene ahead
    // (30° down along the body's facing).
    const neutral = vec3.scaleAndAdd(
      vec3.create(),
      headPosTo,
      ctx.body.forward,
      1,
    );
    neutral[1] -= Math.tan((30 * Math.PI) / 180);
    segment.headTo.rotation = lookRotation(headPosTo, neutral, quat.create());
    segment.headEnd = 0.5;
  } else if (
    ctx.params.gaze !== 'fixed' &&
    (places || (releases && !segment.nextPlaces)) &&
    worthLooking
  ) {
    const full = lookRotation(headPosTo, lookAtTarget, quat.create());
    const toRotation = quat.slerp(
      quat.create(),
      headRotationWalked,
      full,
      GAZE_HEAD_SHARE,
    );
    const headTurn = angleBetween(headRotationWalked, toRotation);
    // The head leads a reach, but a finger on a button lifts off at once.
    lead =
      places && headTurn > 8 && !leavingPress && !pinchedNow ? HEAD_LEAD_S : 0;
    segment.headTo.rotation = toRotation;
    // A 20° turn takes a person about 0.45 s.
    segment.headEnd = Math.min(0.55, Math.max(0.3, 0.25 + headTurn / 100));
  }
  // Duration of the reach (fractions and `at: 'arrival'` refer to it).
  const rotation = angleBetween(segment.wristFrom, segment.wristTo);
  const moveSeconds =
    step.duration === undefined || step.duration === 'auto'
      ? places || poseChange || rotation > 1 || releases
        ? autoMoveSeconds(path.length, rotation, poseChange)
        : 0.3
      : step.duration;
  const reachStart = walkFirst + lead;
  segment.pathEasing = places ? 'reach' : 'minimum-jerk';
  segment.pathStart = reachStart;
  segment.pathEnd = reachStart + moveSeconds;
  if (releases && !segment.nextPlaces) {
    // Lift only once the opening fingers have passed the release level.
    segment.pathStart = reachStart + moveSeconds * 0.6;
    segment.pathEnd = reachStart + moveSeconds + 0.15;
  }
  if (segment.headEnd === undefined) segment.headEnd = lead + moveSeconds;
  let total = reachStart + moveSeconds;
  if (segment.walk && !segment.walk.carriesHand) {
    // The body steps while the arm reaches, for as long as either takes.
    segment.walk.start = reachStart;
    segment.walk.seconds = Math.max(walkS, moveSeconds);
    total = reachStart + segment.walk.seconds;
  }
  // Pinch.
  if (step.pinch !== undefined) {
    const p = step.pinch;
    const from = pinchNow;
    if (isObject(p) && 'at' in p) {
      // Pre-shape: open to a ~5 cm grip aperture by 70% of the reach, then
      // close gently as the hand settles, ending at arrival.
      const close = Math.min(PINCH_CLOSE_S, Math.max(0.15, moveSeconds * 0.45));
      // Time the close so the pinch reaches the press level (where the app
      // sees the grab) as the hand arrives, not while it is still settling:
      // a minimum-jerk close from the pre-shape crosses 0.9 at 70% of the way.
      const arrival = reachStart + moveSeconds;
      const closeStart = Math.max(reachStart, arrival - close * 0.7);
      segment.pinch = {
        value: p.value,
        start: closeStart,
        end: closeStart + close,
        easing: 'minimum-jerk',
        from,
        // A hand already open wider than the grip skips the pre-shape (it
        // would let go of whatever it holds).
        preshape:
          from < PRESHAPE_PINCH
            ? {
                value: PRESHAPE_PINCH,
                start: reachStart + moveSeconds * 0.25,
                end: Math.max(reachStart + moveSeconds * 0.25, closeStart),
              }
            : undefined,
      };
      total = segment.pinch.end + PINCH_HOLD_S;
    } else {
      const t = timedOf(p as TimedInput<number>, moveSeconds, 'minimum-jerk')!;
      if (moveSeconds === 0) {
        t.end = 0.15;
        total = Math.max(total, reachStart + 0.15);
      }
      segment.pinch = {
        ...t,
        start: t.start + reachStart,
        end: t.end + reachStart,
        from,
      };
    }
    if (releases) {
      ctx.held = null;
    }
  }
  if (segment.pose) {
    segment.pose.start = reachStart + segment.pose.start * moveSeconds;
    segment.pose.end = reachStart + segment.pose.end * moveSeconds;
    if (segment.kind === 'press') {
      // The finger is straight before it touches anything.
      segment.pose.end = Math.min(
        segment.pose.end,
        reachStart + moveSeconds * 0.6,
      );
      segment.pose.start = Math.min(segment.pose.start, segment.pose.end);
    }
    if (
      segment.pose.end - segment.pose.start < 0.2 &&
      segment.kind !== 'press' &&
      step.duration !== 0
    ) {
      segment.pose.end = Math.max(segment.pose.end, segment.pose.start + 0.2);
      total = Math.max(total, segment.pose.end);
    }
  }
  segment.duration = Math.max(total, segment.pathEnd);
  if (
    !places &&
    !releases &&
    !segment.walk &&
    segment.lookAhead &&
    ctx.params.gaze !== 'fixed'
  ) {
    const ahead = segment.lookAhead(ctx);
    // A hold keeps looking at what the hand shows unless the next target is
    // worth a glance (not the user's own side).
    if (ahead && below(ahead) > (-65 * Math.PI) / 180) {
      const full = lookRotation(head.position, ahead, quat.create());
      segment.headTo.rotation = quat.slerp(
        quat.create(),
        head.rotation,
        full,
        GAZE_HEAD_SHARE,
      );
      segment.headEnd = Math.min(Math.max(0.3, total * 0.7), 0.5);
    }
  }
};

const createContext = (
  host: SequenceHost,
  params: RunSequenceParams,
  warnings: string[],
  dry: boolean,
): RunContext => {
  const hand = dry ? host.hand(params.device) : host.liveHand(params.device);
  const head = host.headPose();
  const body = bodyFrameFromHead(head.position, head.rotation);
  let standingHead = vec3.clone(head.position);
  let lean = vec3.create();
  const stored = host.bodyState();
  // A body kept from the last sequence, unless the head has since been put
  // somewhere else (a lean left over is under 15 cm).
  if (stored && vec3.distance(stored.standing, head.position) < 0.15) {
    vec3.copy(body.forward, stored.forward);
    vec3.cross(body.right, body.forward, UP);
    vec3.normalize(body.right, body.right);
    standingHead = vec3.clone(stored.standing);
    lean = vec3.sub(vec3.create(), head.position, standingHead);
  }
  const other = host.otherHand(params.device);
  // Rest the other hand unless told to keep it, or it is pinching.
  const restsOtherHand =
    other !== undefined &&
    (params.idleHand === 'rest' ||
      (params.idleHand === undefined && other.pinchValue < 0.5));
  return {
    host,
    params,
    planned: dry
      ? {
          poseId: hand.poseId,
          blended:
            Object.keys(hand.fingerPoses).length > 0 ||
            hand.poseTransitionProgress !== null,
          pinch: host.latestPinch(params.device),
        }
      : null,
    hand,
    anchor: hand.pin?.anchor ?? 'target-ray',
    body,
    warnings,
    head: {
      position: vec3.clone(head.position),
      rotation: quat.clone(head.rotation),
    },
    restsOtherHand,
    lastNormal: null,
    autoDepart: null,
    held: null,
    graspPinch: 1,
    restNormal: null,
    walk: vec3.create(),
    lean,
    standingHead,
    contacts: [],
  };
};

/** Where the head base ends up after a segment. */
const headAfter = (segment: Segment, head: RunContext['head']) => {
  if (segment.headTo) {
    vec3.copy(head.position, segment.headTo.position);
    quat.copy(head.rotation, segment.headTo.rotation);
  }
};

// =============================================================================
// Running
// =============================================================================

const scratch = vec3.create();
const scratchQuat = quat.create();
const swayScratch = vec3.create();

/**
 * A slow, deterministic sway (three incommensurate sines per axis), so the
 * same sequence always moves the same way.
 */
const sway = (t: number, seed: number, amplitude: number, out: vec3) => {
  for (let i = 0; i < 3; i++) {
    const k = seed * 3 + i;
    out[i] =
      (amplitude *
        (Math.sin(2 * Math.PI * 0.23 * t + k * 1.7) +
          0.6 * Math.sin(2 * Math.PI * 0.37 * t + k * 2.3) +
          0.3 * Math.sin(2 * Math.PI * 0.61 * t + k * 0.9))) /
      1.9;
  }
  return out;
};

/** The other hand lowered to the side over the first step. */
interface IdleHand {
  hand: XRHandInput;
  device: HandDeviceId;
  from: vec3;
  fromWrist: quat;
  to: vec3;
  toWrist: quat;
  seconds: number;
}

/**
 * Runs planned segments on sequence time. Each segment is one run of the
 * channel engine (head, pose, pinch, hand and resting hand); its end state is
 * shown for one frame before the next begins (except inside a press, where
 * the contact time matters), and the frame's leftover time carries over.
 */
export class SequenceRunner {
  private readonly ctx: RunContext;
  private index = -1;
  private run: ChannelRun | null = null;
  private clock = 0; // sequence seconds
  private segmentStart = 0; // sequence seconds when the segment began
  private carryS = 0; // seconds left over from a frame that ended a segment
  private stall = false;
  private ending = false;
  private finished: SequenceResult | null = null;
  private readonly events: SequenceResult['events'] = [];
  private readonly steps: (SequenceResult['steps'][number] & {
    index: number;
  })[] = [];
  private seenPressed: boolean;
  private seenCancels: number;
  private seenGestures: boolean[];
  private openPress: { point: vec3; normal: vec3 } | null = null;
  private idle: IdleHand | null = null;
  // The latest microgesture, until its button is up.
  private micro: MicrogesturePlayer | null = null;

  constructor(
    private readonly host: SequenceHost,
    private readonly params: RunSequenceParams,
    private readonly segments: Segment[],
    private readonly deadlinePerf: number,
  ) {
    this.ctx = createContext(host, params, [], false);
    const button = host.pinchButton(params.device)[P_GAMEPAD];
    this.seenPressed = button.lastFramePressed;
    this.seenCancels = button.cancelGeneration;
    this.seenGestures = MICROGESTURES.map(
      (gesture) =>
        host.gestureButton(params.device, gesture)[P_GAMEPAD].lastFramePressed,
    );
  }

  get done(): boolean {
    return this.finished !== null;
  }

  /** Called on the first frame: lowers the other hand and starts step 0. */
  start() {
    const other = this.host.otherHand(this.params.device);
    if (this.ctx.restsOtherHand && other) {
      const b = this.ctx.body;
      const side = this.params.device === 'hand-right' ? -1 : 1;
      // Hanging by the hip, palm toward the thigh, fingers loosely curled.
      const target = vec3.clone(this.ctx.standingHead);
      vec3.scaleAndAdd(target, target, b.right, 0.24 * side);
      target[1] -= 0.8;
      vec3.scaleAndAdd(target, target, b.forward, 0.03);
      const fingers = vec3.fromValues(0, -1, 0);
      vec3.scaleAndAdd(fingers, fingers, b.forward, 0.2);
      const palm = vec3.scale(vec3.create(), b.right, -side);
      const toOrigin = (v: vec3): [number, number, number] => {
        const o = this.host.globalDirectionToOrigin(v);
        return [o[0], o[1], o[2]];
      };
      const resolved = this.host.resolveOrientation(
        other,
        { fingers: toOrigin(fingers), palm: toOrigin(palm) },
        target,
        bodyNow(this.ctx),
      );
      const curl = this.host.parsePose(other, 'default', {
        thumb: { poseId: 'flat', weight: 0.6 },
        index: { poseId: 'fist', weight: 0.42 },
        middle: { poseId: 'fist', weight: 0.45 },
        ring: { poseId: 'fist', weight: 0.48 },
        pinky: { poseId: 'fist', weight: 0.5 },
      });
      other.beginPoseTransition(curl.poseId, curl.fingers);
      this.idle = {
        hand: other,
        device:
          this.params.device === 'hand-right' ? 'hand-left' : 'hand-right',
        from: this.host.anchorPosition(other, 'wrist'),
        fromWrist: other.wristRotation(),
        to: target,
        toWrist: resolved.wristRotation ?? other.wristRotation(),
        seconds: 0.8,
      };
    }
    this.advanceSegment();
    if (this.idle && !this.finished) {
      // Over the first step.
      this.idle.seconds = Math.min(
        1.5,
        Math.max(0.6, this.segments[0].duration),
      );
    }
  }

  /** Advances by `deltaMs`; returns leftover ms when finished, else -1. */
  tick(deltaMs: number): number {
    if (this.finished) return deltaMs;
    // What the app saw last frame.
    this.observeEdges();
    if (this.micro?.releasePending) {
      // A microgesture that registered on its step's last frame has been
      // seen; its button comes up now.
      this.micro.finish();
    }
    let remaining = deltaMs / 1000 + this.carryS;
    this.carryS = 0;
    if (this.ending) {
      // The last step's end state has been shown, and its edges seen.
      this.finish(true);
      return remaining * 1000;
    }
    if (performance.now() > this.deadlinePerf) {
      this.finish(false, 'deadline');
      return 0;
    }
    if (this.stall) {
      // The previous segment's end state has been shown for a frame.
      this.stall = false;
      this.advanceSegment();
      if (this.finished) return 0;
    }
    for (;;) {
      const segment = this.segments[this.index];
      const run = this.run!;
      let leftover: number;
      try {
        leftover = run.advance(remaining * 1000);
      } catch (error) {
        run.stop();
        this.finish(false, (error as Error).message, segment.step);
        return 0;
      }
      if (run.interrupted) {
        // Remote control let go of the hands mid-step.
        this.finish(false, 'released', segment.step);
        return 0;
      }
      const used = leftover < 0 ? remaining : remaining - leftover / 1000;
      this.clock += used;
      remaining -= used;
      this.measureContact(segment);
      if (leftover < 0) {
        return -1;
      }
      this.closeStep(segment);
      if (this.index === this.segments.length - 1) {
        // Show the end for a frame so the app sees its last edge first.
        this.ending = true;
        this.carryS = remaining;
        return -1;
      }
      if (segment.stallAfter) {
        this.stall = true;
        this.carryS = remaining;
        return -1;
      }
      this.advanceSegment();
      if (this.finished) return 0;
    }
  }

  /** Records the select edges and microgestures the app saw on the last frame. */
  private observeEdges() {
    const state = this.host.pinchButton(this.params.device)[P_GAMEPAD];
    const pressed = state.lastFramePressed;
    if (pressed !== this.seenPressed) {
      const edge = pressed
        ? 'press'
        : state.cancelGeneration !== this.seenCancels
          ? 'cancel'
          : 'release';
      for (const type of edgeEventTypes(edge, 'select')) {
        this.events.push({ t: +this.clock.toFixed(3), type });
      }
    }
    this.seenPressed = pressed;
    this.seenCancels = state.cancelGeneration;
    MICROGESTURES.forEach((gesture, i) => {
      const down = this.host.gestureButton(this.params.device, gesture)[
        P_GAMEPAD
      ].lastFramePressed;
      if (down && !this.seenGestures[i]) {
        this.events.push({ t: +this.clock.toFixed(3), type: gesture });
      }
      this.seenGestures[i] = down;
    });
  }

  private advanceSegment() {
    this.index++;
    const segment = this.segments[this.index];
    try {
      segment.prepare(this.ctx);
    } catch (error) {
      this.finish(false, (error as Error).message, segment.step);
      return;
    }
    if (this.idle && segment.walk) {
      // The resting hand goes along with the body, wherever it is on its way.
      const move = segment.walk;
      const { idle } = this;
      for (const point of [idle.from, idle.to]) {
        carry(move, vec3.clone(point), 1, point);
      }
      for (const rotation of [idle.fromWrist, idle.toWrist]) {
        carryRotation(move, quat.clone(rotation), 1, rotation);
      }
    }
    this.segmentStart = this.clock;
    if (segment.micro) this.micro = segment.micro.player;
    this.run = this.host.channels.run(this.channelsFor(segment));
    const last = this.steps[this.steps.length - 1];
    if (!last || last.index !== segment.step) {
      const now = performance.now();
      this.steps.push({
        index: segment.step,
        label: segment.label,
        start: this.clock,
        end: this.clock,
        startPerf: now,
        endPerf: now,
      });
    }
  }

  private closeStep(segment: Segment) {
    const last = this.steps[this.steps.length - 1];
    if (last && last.index === segment.step) {
      last.end = this.clock;
      last.endPerf = performance.now();
    }
  }

  /** The channels a segment runs, in the order they apply each frame. */
  private channelsFor(segment: Segment): Channel[] {
    const durationMs = segment.duration * 1000;
    const at = (progress: number) => progress * segment.duration;
    const device = this.params.device;
    const { hand } = this.ctx;
    const channels: Channel[] = [
      {
        device: 'headset',
        kind: 'transform',
        durationMs,
        easing: 'linear',
        apply: (progress) => this.applyHead(segment, at(progress)),
      },
    ];
    if (segment.pose) {
      const { start, end, easing, value } = segment.pose;
      channels.push({
        device,
        kind: 'pose',
        delayMs: start * 1000,
        durationMs: (end - start) * 1000,
        easing,
        begin: () => {
          hand.beginPoseTransition(value.poseId, value.fingers);
        },
        apply: (progress) => {
          // A pose set in the meantime ended the fade.
          if (hand.poseTransitionProgress !== null) {
            hand.poseTransitionProgress = progress;
          }
        },
      });
    }
    if (segment.pinch) {
      const { start, end, preshape } = segment.pinch;
      const from = Math.min(start, preshape?.start ?? start);
      channels.push({
        device,
        kind: 'pinch',
        delayMs: from * 1000,
        durationMs: (end - from) * 1000,
        easing: 'linear',
        apply: (progress) =>
          this.applyPinch(segment, from + progress * (end - from)),
      });
    }
    channels.push({
      device,
      kind: 'transform',
      durationMs,
      easing: 'linear',
      apply: (progress) => this.applyPlacement(segment, at(progress)),
    });
    if (segment.micro) {
      const { player, start } = segment.micro;
      channels.push(player.channel(device, start * 1000));
    }
    if (this.idle) {
      channels.push({
        device: this.idle.device,
        kind: 'transform',
        durationMs,
        easing: 'linear',
        apply: (progress) => this.applyIdleHand(segment, at(progress)),
      });
    }
    return channels;
  }

  /** How far a segment's walk has gone at `t` (0 to 1). */
  private walkProgress(segment: Segment, t: number) {
    const move = segment.walk;
    return move ? ease('minimum-jerk', (t - move.start) / move.seconds) : 1;
  }

  /** How far a segment's path has gone at `t` (0 to 1, eased). */
  private pathProgress(segment: Segment, t: number, easing: PathEasing) {
    const start = segment.pathStart ?? 0;
    const end = segment.pathEnd ?? segment.duration;
    if (end <= start) return t >= start ? 1 : 0;
    return t <= start
      ? 0
      : ease(easing, Math.min(1, (t - start) / (end - start)));
  }

  /**
   * The head: carried by the walk, then turned toward the work (from
   * `headStart` over `headEnd` seconds) and leaned with the reach, plus a
   * slight, slow sway.
   */
  private applyHead(segment: Segment, t: number) {
    const base = this.ctx.head;
    if (segment.headFrom && segment.headTo) {
      const fw = this.walkProgress(segment, t);
      const fl = this.pathProgress(segment, t, 'minimum-jerk');
      const headEnd = segment.headEnd ?? 0;
      const fg = ease(
        'minimum-jerk',
        headEnd > 0 ? (t - (segment.headStart ?? 0)) / headEnd : 1,
      );
      const { position, rotation } = segment.headFrom;
      if (segment.walk) {
        carry(segment.walk, position, fw, base.position);
        carryRotation(segment.walk, rotation, fw, base.rotation);
      } else {
        vec3.copy(base.position, position);
        quat.copy(base.rotation, rotation);
      }
      if (segment.lean) {
        vec3.scaleAndAdd(base.position, base.position, segment.lean, fl);
      }
      quat.slerp(base.rotation, base.rotation, segment.headTo.rotation, fg);
    }
    sway(this.segmentStart + t, 2, HEAD_SWAY_RAD, swayScratch);
    const rotation = quat.clone(base.rotation);
    const yaw = quat.setAxisAngle(quat.create(), UP, swayScratch[0]);
    const pitch = quat.setAxisAngle(quat.create(), [1, 0, 0], swayScratch[1]);
    quat.multiply(rotation, yaw, rotation);
    quat.multiply(rotation, rotation, pitch);
    // The head drifts a few millimetres too (posture and breathing).
    sway(this.segmentStart + t, 4, HEAD_SWAY_M, swayScratch);
    const position = vec3.add(vec3.create(), base.position, swayScratch);
    this.host.setHeadPose(position, rotation);
  }

  /** Pinch: an optional pre-shape (open to a grip aperture), then the pinch itself. */
  private applyPinch(segment: Segment, t: number) {
    const { start, end, easing, value, from, preshape } = segment.pinch!;
    const window = (a: number, b: number) =>
      b <= a
        ? t >= a
          ? 1
          : 0
        : t <= a
          ? 0
          : ease(easing, Math.min(1, (t - a) / (b - a)));
    let pinch: number;
    if (preshape && t < start) {
      pinch =
        from + (preshape.value - from) * window(preshape.start, preshape.end);
    } else {
      const base = preshape ? preshape.value : from;
      pinch = base + (value - base) * window(start, end);
    }
    this.host.setPinch(this.params.device, Math.min(1, Math.max(0, pinch)));
  }

  /** The hand along the path (carried by any walk first), the wrist turning alongside. */
  private applyPlacement(segment: Segment, t: number) {
    const { hand } = this.ctx;
    if (!segment.path) return;
    const f = this.pathProgress(
      segment,
      t,
      segment.pathEasing ?? 'minimum-jerk',
    );
    segment.path.at(scratch, f);
    let wrist =
      segment.wristFrom && segment.wristTo
        ? quat.slerp(scratchQuat, segment.wristFrom, segment.wristTo, f)
        : undefined;
    const move = segment.walk;
    if (move?.carriesHand && t < move.start + move.seconds) {
      // Carried by the walk: undo the part of it still to come.
      const fw = this.walkProgress(segment, t);
      const back = reverseOf(move);
      carry(back, scratch, 1 - fw, scratch);
      if (wrist) wrist = carryRotation(back, wrist, 1 - fw, scratchQuat);
    }
    if (
      (segment.kind === 'hold' || segment.kind === 'microgesture') &&
      !segment.pinch &&
      hand.pinchValue < 0.5
    ) {
      // A held hand is never perfectly still (but steady while holding
      // something or pinching).
      sway(this.segmentStart + t, 1, HAND_SWAY_M, swayScratch);
      if (segment.restNormal) {
        vec3.scaleAndAdd(
          swayScratch,
          swayScratch,
          segment.restNormal,
          -vec3.dot(swayScratch, segment.restNormal),
        );
      }
      // Fade the sway in so a hold never starts with a jump.
      vec3.scaleAndAdd(scratch, scratch, swayScratch, Math.min(1, t / 0.5));
    }
    hand.setPin({
      anchor: this.ctx.anchor,
      target: scratch,
      wristRotation: wrist,
      graspPinch: this.ctx.graspPinch,
    });
  }

  /**
   * The resting hand: lowered to the hip over the first step (its pose fading
   * to a loose curl), carried by walks, swaying slightly once it is there.
   */
  private applyIdleHand(segment: Segment, t: number) {
    const idle = this.idle!;
    const f = ease('minimum-jerk', (this.segmentStart + t) / idle.seconds);
    const target = vec3.lerp(vec3.create(), idle.from, idle.to, f);
    const wrist = quat.slerp(quat.create(), idle.fromWrist, idle.toWrist, f);
    const move = segment.walk;
    if (move && t < move.start + move.seconds) {
      // On its way with the body: the part of the walk still to come.
      const back = reverseOf(move);
      const fw = this.walkProgress(segment, t);
      carry(back, target, 1 - fw, target);
      carryRotation(back, wrist, 1 - fw, wrist);
    }
    if (idle.hand.poseTransitionProgress !== null) {
      idle.hand.poseTransitionProgress = f;
    }
    sway(this.segmentStart + t, 3, IDLE_HAND_SWAY_M, swayScratch);
    vec3.scaleAndAdd(target, target, swayScratch, f);
    idle.hand.setPin({ anchor: 'wrist', target, wristRotation: wrist });
  }

  /**
   * Wall-clock contact: the fingertip within 2 cm of the pressed surface,
   * followed into the next step when the pull-back is its lift-off.
   */
  private measureContact(segment: Segment) {
    const press = segment.press ?? this.openPress;
    if (!press) return;
    const tip = this.host.anchorPosition(this.ctx.hand, 'index-tip');
    const offset = vec3.sub(vec3.create(), tip, press.point);
    const d = vec3.dot(offset, press.normal);
    // Only counts over the pressed face (within 4 cm of its centre).
    vec3.scaleAndAdd(offset, offset, press.normal, -d);
    const over = vec3.length(offset) <= 0.04;
    const contacts = this.ctx.contacts;
    let current = contacts[contacts.length - 1];
    if (d <= TOUCH_M && over) {
      if (!current || current.endPerf !== undefined) {
        current = { label: segment.label, startPerf: performance.now() };
        contacts.push(current);
        this.openPress = press;
      }
    } else if (
      current &&
      current.endPerf === undefined &&
      current.startPerf !== undefined
    ) {
      current.endPerf = performance.now();
      this.openPress = null;
      const ms = current.endPerf - current.startPerf;
      if (ms > 800) {
        this.ctx.warnings.push(
          `${segment.label}: the press touched for ${ms.toFixed(0)} ms of real time; frames are slow enough that an 800 ms click window may be missed.`,
        );
      }
    }
  }

  private finish(completed: boolean, reason?: string, failedStep?: number) {
    if (this.finished) return;
    if (!completed) {
      // Stop where it is: channels let go, fades snap to their pose, a
      // microgesture's thumb returns and its button comes up; pins and the
      // pinch stay.
      this.run?.stop();
      this.micro?.cancel();
      for (const hand of [this.ctx.hand, this.idle?.hand]) {
        if (hand && hand.poseTransitionProgress !== null) {
          hand.poseTransitionProgress = null;
        }
      }
    } else if (this.idle && this.clock < this.idle.seconds) {
      // A sequence shorter than the rest: the resting hand gets there now.
      this.idle.hand.poseTransitionProgress = null;
      this.idle.hand.setPin({
        anchor: 'wrist',
        target: this.idle.to,
        wristRotation: this.idle.toWrist,
      });
    }
    if (completed) {
      this.host.setBodyState({
        forward: vec3.clone(this.ctx.body.forward),
        standing: vec3.add(vec3.create(), this.ctx.standingHead, this.ctx.walk),
      });
      if (this.ctx.hand.pinchValue < 0.5) {
        // Apps that detect pinches from joints (three.js: tips within 1.5 cm)
        // would see a hand left like this as pinching.
        const gap = vec3.distance(
          this.host.anchorPosition(this.ctx.hand, 'thumb-tip'),
          this.host.anchorPosition(this.ctx.hand, 'index-tip'),
        );
        if (gap < 0.02) {
          this.ctx.warnings.push(
            `The hand ends with its thumb and index tips ${(gap * 100).toFixed(1)} cm apart and the pinch open; apps that detect pinches from joints will see a pinch. Leave the thumb further from the index tip.`,
          );
        }
      }
    }
    const last = this.steps[this.steps.length - 1];
    if (last && !completed) {
      last.end = this.clock;
      last.endPerf = performance.now();
    }
    this.finished = {
      completed,
      cancelled: false,
      ...(reason ? { reason } : {}),
      ...(failedStep !== undefined ? { failedStep } : {}),
      steps: this.steps.map((s) => ({
        label: s.label,
        start: +s.start.toFixed(3),
        end: +s.end.toFixed(3),
        startPerf: +s.startPerf.toFixed(1),
        endPerf: +s.endPerf.toFixed(1),
      })),
      events: this.events,
      presses: this.ctx.contacts.map((c) => ({
        label: c.label,
        contactMs:
          c.startPerf !== undefined && c.endPerf !== undefined
            ? +(c.endPerf - c.startPerf).toFixed(1)
            : null,
      })),
      warnings: this.ctx.warnings,
      pinchValue: this.host.latestPinch(this.params.device),
    };
  }

  /**
   * Stops now (cancel, release, watchdog, session end): the current channels
   * stop where they are; the pinch is left as it is.
   */
  abort(reason: string): SequenceResult {
    this.run?.stop();
    if (!this.finished) {
      this.finish(false, reason);
      this.finished!.cancelled = true;
    }
    return this.result();
  }

  result(): SequenceResult {
    const result = this.finished!;
    try {
      result.final = this.host.handState(this.params.device);
    } catch {
      // The hand may be gone (session ended).
    }
    return result;
  }

  /**
   * The planned segments with estimated durations (dry run and time budget),
   * from the current state. Prepares every segment against a scratch copy of
   * the hand's pin, then puts the hand and head back.
   */
  static describe(
    host: SequenceHost,
    params: RunSequenceParams,
    segments: Segment[],
    warnings: string[],
  ): SequencePlan {
    const ctx = createContext(host, params, warnings, true);
    const hand = ctx.hand;
    const savedPin = hand.pin;
    const savedPosition = vec3.clone(hand.position.vec3);
    const savedRotation = quat.clone(hand.quaternion.quat);
    const head = host.headPose();
    const out: SequencePlan['segments'] = [];
    let total = 0;
    const toOrigin = (p: vec3) => {
      const o = host.globalToOrigin(p);
      return { x: +o[0].toFixed(4), y: +o[1].toFixed(4), z: +o[2].toFixed(4) };
    };
    try {
      for (const segment of segments) {
        try {
          segment.prepare(ctx);
        } catch (error) {
          const message = (error as Error).message;
          throw new Error(
            message.startsWith('Step ')
              ? message
              : `${where(segment.step, params.steps[segment.step])}: ${message}`,
          );
        }
        total += segment.duration;
        const planned = ctx.planned!;
        if (segment.pose) {
          planned.poseId = segment.pose.value.poseId;
          planned.blended = Object.keys(segment.pose.value.fingers).length > 0;
        }
        if (segment.pinch) planned.pinch = segment.pinch.value;
        if (segment.target) {
          hand.setPin({
            anchor: ctx.anchor,
            target: segment.target,
            wristRotation: segment.wristTo,
            graspPinch: ctx.graspPinch,
          });
        }
        headAfter(segment, ctx.head);
        out.push({
          step: segment.step,
          label: segment.label,
          kind: segment.kind,
          duration: +segment.duration.toFixed(3),
          ...(segment.target ? { target: toOrigin(segment.target) } : {}),
          ...(segment.walk && vec3.length(segment.walk.shift) > 0.01
            ? { walk: +vec3.length(segment.walk.shift).toFixed(3) }
            : {}),
        });
      }
    } finally {
      hand.position.set(savedPosition[0], savedPosition[1], savedPosition[2]);
      hand.quaternion.set(
        savedRotation[0],
        savedRotation[1],
        savedRotation[2],
        savedRotation[3],
      );
      hand.setPin(savedPin);
      hand.updateTargetRaySpace();
      host.setHeadPose(head.position, head.rotation);
    }
    return {
      device: params.device,
      segments: out,
      duration: +total.toFixed(3),
      warnings,
    };
  }
}

/** @internal */
export const _testing = { ArcPath, autoMoveSeconds, lookRotation };
