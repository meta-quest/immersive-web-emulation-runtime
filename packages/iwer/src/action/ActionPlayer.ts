/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Axis,
  Button,
  Gamepad,
  GamepadButton,
  GamepadMappingType,
} from '../gamepad/Gamepad.js';
import {
  P_ACTION_PLAYER,
  P_GAMEPAD,
  P_JOINT_SPACE,
  P_SPACE,
} from '../private.js';
import { XRHand, XRHandJoint } from '../input/XRHand.js';
import {
  XRHandedness,
  XRInputSource,
  XRTargetRayMode,
} from '../input/XRInputSource.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { InputSchema } from './ActionRecorder.js';
import { XREye } from '../views/XRView.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { XRInputSourceEvent } from '../events/XRInputSourceEvent.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import type { XRSession } from '../session/XRSession.js';
import { XRSpace } from '../spaces/XRSpace.js';

export interface CompressedRecording {
  schema: {
    0: number;
    1: InputSchema;
  }[];
  frames: any[];
}

type ProcessedInputData = {
  targetRayTransform: number[];
  gripTransform?: number[];
  handTransforms?: any[];
  buttons?: { 0: 0 | 1; 1: 0 | 1; 2: number }[];
  axes?: number[];
};

/**
 * Context the player needs to dispatch XRInputSourceEvents
 * (selectstart/select/selectend and the squeeze variants) on edges detected
 * during playback. It mirrors XRTrackedInput.onFrameStart's dispatch, which
 * targets the session and stamps each event with the current XRFrame. The
 * player only emits events when this context has been attached (via the
 * constructor option or setEventContext); otherwise edge detection is skipped
 * and playback behaves exactly as before.
 */
export interface ActionPlayerEventContext {
  session: XRSession;
  /** Returns the XRFrame to stamp on dispatched events, or null to skip. */
  getFrame: () => XRFrame | null | undefined;
}

export interface ActionPlayerOptions {
  /**
   * When true, playback restarts from the beginning instead of stopping once
   * the final frame is reached. Defaults to false.
   */
  loop?: boolean;
  /**
   * Multiplier applied to the per-frame wall-clock delta in playFrame(). 1 is
   * realtime (default); 2 plays back twice as fast, 0.5 half speed.
   */
  playbackRate?: number;
  /** Optional event context enabling select/squeeze dispatch during playback. */
  eventContext?: ActionPlayerEventContext;
}

export class ActionPlayer {
  [P_ACTION_PLAYER]: {
    refSpace: XRReferenceSpace;
    inputSources: Map<number, { active: boolean; source: XRInputSource }>;
    inputSchemas: Map<number, InputSchema>;
    frames: any[];
    recordedFramePointer: number;
    startingTimeStamp: DOMHighResTimeStamp;
    endingTimeStamp: DOMHighResTimeStamp;
    playbackTime: DOMHighResTimeStamp;
    actualTimeStamp?: DOMHighResTimeStamp;
    playing: boolean;
    viewerSpace: XRReferenceSpace;
    viewSpaces: { [key in XREye]: XRSpace };
    vec3: vec3;
    quat: quat;
    f1p: vec3;
    f1q: quat;
    f2p: vec3;
    f2q: quat;
    lastFrameInputs: Map<number, ProcessedInputData>;
    nextFrameInputs: Map<number, ProcessedInputData>;
    loop: boolean;
    playbackRate: number;
    eventContext?: ActionPlayerEventContext;
    // Index of the recorded frame whose button states were last used as the
    // baseline for select/squeeze edge detection. -1 means none yet (so the
    // first applied frame establishes the baseline without firing edges).
    lastEventFramePointer: number;
  };

  constructor(
    refSpace: XRReferenceSpace,
    recording: {
      schema: {
        0: number;
        1: InputSchema;
      }[];
      frames: any[];
    },
    ipd: number,
    options: ActionPlayerOptions = {},
  ) {
    const { schema, frames } = recording;
    if (!frames || !schema || frames.length === 0) {
      throw new DOMException('wrong recording format', 'NotSupportedError');
    }
    const viewerSpace = new XRReferenceSpace(
      XRReferenceSpaceType.Viewer,
      refSpace,
    );
    const viewSpaces: { [key in XREye]: XRSpace } = {
      [XREye.Left]: new XRSpace(viewerSpace),
      [XREye.Right]: new XRSpace(viewerSpace),
      [XREye.None]: new XRSpace(viewerSpace),
    };
    this[P_ACTION_PLAYER] = {
      refSpace,
      inputSources: new Map(),
      inputSchemas: new Map(),
      frames,
      recordedFramePointer: 0,
      startingTimeStamp: frames[0][0] as number,
      endingTimeStamp: frames[frames.length - 1][0] as number,
      playbackTime: frames[0][0] as number,
      playing: false,
      viewerSpace,
      viewSpaces,
      vec3: vec3.create(),
      quat: quat.create(),
      f1p: vec3.create(),
      f1q: quat.create(),
      f2p: vec3.create(),
      f2q: quat.create(),
      lastFrameInputs: new Map(),
      nextFrameInputs: new Map(),
      loop: options.loop ?? false,
      playbackRate:
        options.playbackRate != null && options.playbackRate > 0
          ? options.playbackRate
          : 1,
      eventContext: options.eventContext,
      lastEventFramePointer: -1,
    };

    mat4.fromTranslation(
      this[P_ACTION_PLAYER].viewSpaces[XREye.Left][P_SPACE].offsetMatrix,
      vec3.fromValues(-ipd / 2, 0, 0),
    );
    mat4.fromTranslation(
      this[P_ACTION_PLAYER].viewSpaces[XREye.Right][P_SPACE].offsetMatrix,
      vec3.fromValues(ipd / 2, 0, 0),
    );

    schema.forEach((schemaEntry) => {
      const index = schemaEntry[0];
      const schema = schemaEntry[1];
      let gamepad;
      if (schema.hasGamepad) {
        const buttons: Button[] = [];
        for (let i = 0; i < schema.numButtons!; i++) {
          buttons.push({ id: i.toString(), type: 'manual' });
        }
        const axes: Axis[] = [];
        for (let i = 0; i < schema.numAxes!; i++) {
          axes.push({ id: i.toString(), type: 'manual' });
        }
        gamepad = new Gamepad({
          mapping: schema.mapping as GamepadMappingType,
          buttons,
          axes,
        });
      }

      const targetRaySpace = new XRSpace(refSpace);

      let hand: XRHand | undefined = undefined;
      if (schema.hasHand) {
        hand = new XRHand();
        Object.values(XRHandJoint).forEach((jointName) => {
          hand!.set(jointName, new XRJointSpace(jointName, targetRaySpace));
        });
      }

      const inputSource = new XRInputSource(
        schema.handedness as XRHandedness,
        schema.targetRayMode as XRTargetRayMode,
        schema.profiles,
        targetRaySpace,
        gamepad,
        schema.hasGrip ? new XRSpace(refSpace) : undefined,
        schema.hasHand ? hand : undefined,
      );

      this[P_ACTION_PLAYER].inputSources.set(index, {
        active: false,
        source: inputSource,
      });
      this[P_ACTION_PLAYER].inputSchemas.set(index, schema);
    });

    // Validate up front that every recorded frame's gamepad data matches the
    // expected button/axis counts, so a malformed recording fails loudly here
    // instead of crashing deep inside playback.
    frames.forEach((frame: any[], frameIndex: number) => {
      for (let i = 8; i < frame.length; i++) {
        const inputDataRaw = frame[i] as any[];
        const index = inputDataRaw[0] as number;
        const schema = this[P_ACTION_PLAYER].inputSchemas.get(index);
        if (!schema) {
          throw new DOMException(
            `recording frame ${frameIndex} references unknown input source ${index}`,
            'NotSupportedError',
          );
        }
        if (schema.hasGamepad) {
          let dataCounter = 8;
          if (schema.hasGrip) dataCounter++;
          if (schema.hasHand) dataCounter++;
          const gamepadData = inputDataRaw[dataCounter] as any[];
          const expectedLength = schema.numButtons! + schema.numAxes!;
          if (
            !Array.isArray(gamepadData) ||
            gamepadData.length !== expectedLength
          ) {
            const actualLength = Array.isArray(gamepadData)
              ? gamepadData.length
              : 'no';
            throw new DOMException(
              `recording frame ${frameIndex} input source ${index} has ` +
                `${actualLength} gamepad entries, expected ${expectedLength} ` +
                `(${schema.numButtons} buttons + ${schema.numAxes} axes)`,
              'NotSupportedError',
            );
          }
        }
      }
    });
  }

  play() {
    this[P_ACTION_PLAYER].recordedFramePointer = 0;
    this[P_ACTION_PLAYER].playbackTime =
      this[P_ACTION_PLAYER].startingTimeStamp;
    this[P_ACTION_PLAYER].playing = true;
    this[P_ACTION_PLAYER].actualTimeStamp = performance.now();
    // Reset edge-detection baseline so the first frame doesn't spuriously fire.
    this[P_ACTION_PLAYER].lastEventFramePointer = -1;
  }

  stop() {
    this[P_ACTION_PLAYER].playing = false;
  }

  get playing() {
    return this[P_ACTION_PLAYER].playing;
  }

  get viewerSpace() {
    return this[P_ACTION_PLAYER].viewerSpace;
  }

  get viewSpaces() {
    return this[P_ACTION_PLAYER].viewSpaces;
  }

  get inputSources() {
    return Array.from(this[P_ACTION_PLAYER].inputSources.values())
      .filter((wrapper) => wrapper.active)
      .map((wrapper) => wrapper.source);
  }

  get loop(): boolean {
    return this[P_ACTION_PLAYER].loop;
  }

  set loop(value: boolean) {
    this[P_ACTION_PLAYER].loop = value;
  }

  get playbackRate(): number {
    return this[P_ACTION_PLAYER].playbackRate;
  }

  set playbackRate(value: number) {
    // Ignore non-positive rates so the wall-clock advance never stalls/reverses.
    if (value > 0) {
      this[P_ACTION_PLAYER].playbackRate = value;
    }
  }

  /**
   * Attach (or clear) the event context used to dispatch select/squeeze events
   * during playback. Passing undefined disables event dispatch.
   */
  setEventContext(context?: ActionPlayerEventContext) {
    this[P_ACTION_PLAYER].eventContext = context;
  }

  /**
   * Total length of the recording in milliseconds (last frame timestamp minus
   * first). 0 for a single-frame recording.
   */
  get duration(): number {
    return (
      this[P_ACTION_PLAYER].endingTimeStamp -
      this[P_ACTION_PLAYER].startingTimeStamp
    );
  }

  /**
   * Current playback position in milliseconds, relative to the start of the
   * recording (0 at the first frame).
   */
  get currentTime(): number {
    return (
      this[P_ACTION_PLAYER].playbackTime -
      this[P_ACTION_PLAYER].startingTimeStamp
    );
  }

  /**
   * Jump playback to an absolute position, expressed in milliseconds relative to
   * the start of the recording. The time is clamped to [0, duration]. The frame
   * pointer is resolved with a binary search over the frames (sorted ascending
   * by timestamp at frame[0]), so backward seeks work correctly. Does not render
   * a frame on its own; the next playFrame()/stepFrames() call samples the new
   * position. The wall-clock anchor is reset so a subsequent playFrame() doesn't
   * fast-forward across the jump.
   */
  seek(timeMs: number) {
    const state = this[P_ACTION_PLAYER];
    const clamped = Math.max(0, Math.min(timeMs, this.duration));
    const absolute = state.startingTimeStamp + clamped;
    state.playbackTime = absolute;
    state.recordedFramePointer = this.findFramePointer(absolute);
    // A seek is a discontinuity: reset the edge baseline so the jump itself
    // doesn't manufacture select/squeeze edges.
    state.lastEventFramePointer = -1;
    // Re-anchor wall-clock playback so the next delta starts from this instant.
    state.actualTimeStamp = performance.now();
  }

  /**
   * Binary search for the index of the last frame whose timestamp is <= the
   * given absolute time. Returns 0 when the time precedes the first frame.
   */
  private findFramePointer(absoluteTime: number): number {
    const frames = this[P_ACTION_PLAYER].frames;
    let lo = 0;
    let hi = frames.length - 1;
    let result = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((frames[mid][0] as number) <= absoluteTime) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  /**
   * Advance playback by exactly n recorded frames (default 1), deterministically
   * and independent of wall-clock time, for headless/agent driving. Each step
   * samples the recording at a frame boundary (alpha == 0, no interpolation) and
   * dispatches any select/squeeze edges between consecutive frames. When loop is
   * enabled, stepping past the final frame wraps to the start; otherwise it
   * clamps to the final frame and stops playback. Sets playing to true on entry
   * so the surrounding pose getters report this player's spaces.
   */
  stepFrames(n = 1) {
    const state = this[P_ACTION_PLAYER];
    const frames = state.frames;
    state.playing = true;
    for (let step = 0; step < n; step++) {
      if (state.recordedFramePointer + 1 >= frames.length) {
        if (state.loop) {
          state.recordedFramePointer = 0;
          state.playbackTime = state.startingTimeStamp;
          // The wrap is a discontinuity; don't fire edges across it.
          state.lastEventFramePointer = -1;
        } else {
          state.playbackTime = state.endingTimeStamp;
          this.applyFrameAtPointer(0);
          this.stop();
          return;
        }
      } else {
        state.recordedFramePointer++;
        state.playbackTime = frames[state.recordedFramePointer][0] as number;
      }
      this.applyFrameAtPointer(0);
    }
    // Keep the wall-clock anchor fresh so a later switch back to play() doesn't
    // jump.
    state.actualTimeStamp = performance.now();
  }

  playFrame() {
    const now = performance.now();
    const delta =
      (now - this[P_ACTION_PLAYER].actualTimeStamp!) *
      this[P_ACTION_PLAYER].playbackRate;
    this[P_ACTION_PLAYER].actualTimeStamp = now;
    this[P_ACTION_PLAYER].playbackTime! += delta;
    const frames = this[P_ACTION_PLAYER].frames;
    if (
      this[P_ACTION_PLAYER].playbackTime! >
      this[P_ACTION_PLAYER].endingTimeStamp
    ) {
      if (this[P_ACTION_PLAYER].loop) {
        // Wrap back to the start, preserving any overshoot past the end so the
        // loop stays smooth, then resolve the pointer for the wrapped time.
        const overshoot =
          this[P_ACTION_PLAYER].playbackTime! -
          this[P_ACTION_PLAYER].endingTimeStamp;
        const wrapped =
          this.duration > 0
            ? this[P_ACTION_PLAYER].startingTimeStamp +
              (overshoot % this.duration)
            : this[P_ACTION_PLAYER].startingTimeStamp;
        this[P_ACTION_PLAYER].playbackTime = wrapped;
        this[P_ACTION_PLAYER].recordedFramePointer =
          this.findFramePointer(wrapped);
        // The wrap is a discontinuity; don't manufacture edges across it.
        this[P_ACTION_PLAYER].lastEventFramePointer = -1;
      } else {
        // Clamp to the recording's end so the final frame's pose is rendered
        // once (and single-frame recordings render at all) before stopping.
        this[P_ACTION_PLAYER].playbackTime =
          this[P_ACTION_PLAYER].endingTimeStamp;
        this.stop();
      }
    }
    // Guard the advance so we never read past the last frame.
    while (
      this[P_ACTION_PLAYER].recordedFramePointer + 1 < frames.length &&
      (frames[this[P_ACTION_PLAYER].recordedFramePointer + 1][0] as number) <
        this[P_ACTION_PLAYER].playbackTime
    ) {
      this[P_ACTION_PLAYER].recordedFramePointer++;
    }
    const hasNextFrame =
      this[P_ACTION_PLAYER].recordedFramePointer + 1 < frames.length;
    const lastFrameData = frames[this[P_ACTION_PLAYER].recordedFramePointer];
    const nextFrameData = hasNextFrame
      ? frames[this[P_ACTION_PLAYER].recordedFramePointer + 1]
      : lastFrameData;
    const alpha = hasNextFrame
      ? ((this[P_ACTION_PLAYER].playbackTime - lastFrameData[0]) as number) /
        (((nextFrameData[0] as number) - lastFrameData[0]) as number)
      : 0;
    this.applyFrameAtPointer(alpha);
  }

  /**
   * Sample the recording at the current frame pointer, applying poses, hands,
   * gamepad state, and active flags, and dispatch any select/squeeze edges
   * crossed since the previous applied frame. `alpha` is the interpolation
   * factor toward the next frame (0 snaps exactly to the pointer's frame, as the
   * deterministic stepFrames path uses). When there is no next frame the pointer
   * frame is used for both ends.
   */
  private applyFrameAtPointer(alpha: number) {
    const frames = this[P_ACTION_PLAYER].frames;
    // When there is no next frame (single-frame recording or pointer at the
    // end), snap to the last frame's pose instead of dereferencing frames[ptr+1].
    const hasNextFrame =
      this[P_ACTION_PLAYER].recordedFramePointer + 1 < frames.length;
    const lastFrameData = frames[this[P_ACTION_PLAYER].recordedFramePointer];
    const nextFrameData = hasNextFrame
      ? frames[this[P_ACTION_PLAYER].recordedFramePointer + 1]
      : lastFrameData;

    this.updateXRSpaceFromMergedFrames(
      this[P_ACTION_PLAYER].viewerSpace,
      lastFrameData.slice(1, 8),
      nextFrameData.slice(1, 8),
      alpha,
    );

    const lastFrameInputs = this[P_ACTION_PLAYER].lastFrameInputs;
    lastFrameInputs.clear();
    for (let i = 8; i < lastFrameData.length; i++) {
      const { index, inputData } = this.processRawInputData(
        lastFrameData[i] as any[],
      );
      lastFrameInputs.set(index, inputData);
    }

    const nextFrameInputs = this[P_ACTION_PLAYER].nextFrameInputs;
    nextFrameInputs.clear();
    for (let i = 8; i < nextFrameData.length; i++) {
      const { index, inputData } = this.processRawInputData(
        nextFrameData[i] as any[],
      );
      nextFrameInputs.set(index, inputData);
    }

    this[P_ACTION_PLAYER].inputSources.forEach((sourceWrapper) => {
      sourceWrapper.active = false;
    });

    nextFrameInputs.forEach((inputData, index) => {
      this[P_ACTION_PLAYER].inputSources.get(index)!.active = true;
      const inputSource = this[P_ACTION_PLAYER].inputSources.get(index)!.source;
      const schema = this[P_ACTION_PLAYER].inputSchemas.get(index)!;
      this.updateInputSource(
        inputSource,
        schema,
        lastFrameInputs.has(index) ? lastFrameInputs.get(index)! : inputData,
        inputData,
        alpha,
      );
    });

    this.dispatchSelectSqueezeEdges();
  }

  /**
   * Detect rising/falling edges of select/squeeze-triggering buttons between the
   * previously applied frame and the one at the current pointer, then dispatch
   * the corresponding XRInputSourceEvents on the session — mirroring
   * XRTrackedInput.onFrameStart's edge logic (lastValue 0 -> >0 fires
   * <trigger>+<trigger>start; >0 -> 0 fires <trigger>end). All frame boundaries
   * skipped since the last applied frame are scanned so no edge is missed when
   * the pointer advances by more than one frame. No-ops unless an event context
   * is attached and yields a frame. The recording format does not persist
   * per-button eventTrigger, so the xr-standard convention is used: button 0 ->
   * 'select', button 1 -> 'squeeze'.
   */
  private dispatchSelectSqueezeEdges() {
    const state = this[P_ACTION_PLAYER];
    const context = state.eventContext;
    const pointer = state.recordedFramePointer;
    // Without a context we still maintain the baseline so a later attach starts
    // clean, but emit nothing.
    if (!context) {
      state.lastEventFramePointer = pointer;
      return;
    }
    const baseline = state.lastEventFramePointer;
    if (baseline < 0 || baseline === pointer) {
      // First applied frame (or no advance): establish the baseline silently.
      state.lastEventFramePointer = pointer;
      return;
    }
    const frame = context.getFrame();
    if (!frame) {
      state.lastEventFramePointer = pointer;
      return;
    }
    const frames = state.frames;
    const step = pointer > baseline ? 1 : -1;
    // Walk every adjacent frame pair from the baseline to the current pointer so
    // multi-frame jumps still fire each edge in order.
    for (let from = baseline; from !== pointer; from += step) {
      const a = step > 0 ? from : from - 1;
      const b = a + 1;
      this.dispatchEdgesBetweenFrames(frames[a], frames[b], context, frame);
    }
    state.lastEventFramePointer = pointer;
  }

  /**
   * Compare the recorded button values of two adjacent frames and dispatch the
   * select/squeeze edges between them on the given session/frame.
   */
  private dispatchEdgesBetweenFrames(
    fromFrame: any[],
    toFrame: any[],
    context: ActionPlayerEventContext,
    frame: XRFrame,
  ) {
    // Build a quick lookup of the "from" frame's processed inputs by index.
    const fromInputs = new Map<number, ProcessedInputData>();
    for (let i = 8; i < fromFrame.length; i++) {
      const { index, inputData } = this.processRawInputData(
        fromFrame[i] as any[],
      );
      fromInputs.set(index, inputData);
    }
    for (let i = 8; i < toFrame.length; i++) {
      const { index, inputData } = this.processRawInputData(
        toFrame[i] as any[],
      );
      const schema = this[P_ACTION_PLAYER].inputSchemas.get(index);
      if (!schema || !schema.hasGamepad || !inputData.buttons) {
        continue;
      }
      const fromData = fromInputs.get(index);
      // A source that wasn't present last frame has no baseline; skip edges.
      if (!fromData || !fromData.buttons) {
        continue;
      }
      const inputSource = this[P_ACTION_PLAYER].inputSources.get(index)?.source;
      if (!inputSource) {
        continue;
      }
      inputData.buttons.forEach((states, buttonIndex) => {
        const eventTrigger = this.eventTriggerForButton(schema, buttonIndex);
        if (eventTrigger == null) {
          return;
        }
        const lastValue = fromData.buttons![buttonIndex]?.[2] ?? 0;
        const nextValue = states[2];
        if (lastValue === 0 && nextValue > 0) {
          context.session.dispatchEvent(
            new XRInputSourceEvent(eventTrigger, { frame, inputSource }),
          );
          context.session.dispatchEvent(
            new XRInputSourceEvent(eventTrigger + 'start', {
              frame,
              inputSource,
            }),
          );
        } else if (lastValue > 0 && nextValue === 0) {
          context.session.dispatchEvent(
            new XRInputSourceEvent(eventTrigger + 'end', {
              frame,
              inputSource,
            }),
          );
        }
      });
    }
  }

  /**
   * Map a recorded button index to its event trigger using the xr-standard
   * mapping convention (button 0 -> 'select', button 1 -> 'squeeze'), matching
   * how IWER's controller/hand configs assign eventTrigger. Other buttons (and
   * non-xr-standard mappings) have no trigger.
   */
  private eventTriggerForButton(
    schema: InputSchema,
    buttonIndex: number,
  ): 'select' | 'squeeze' | null {
    if (schema.mapping !== GamepadMappingType.XRStandard) {
      return null;
    }
    if (buttonIndex === 0) {
      return 'select';
    }
    if (buttonIndex === 1) {
      return 'squeeze';
    }
    return null;
  }

  updateInputSource(
    inputSource: XRInputSource,
    schema: InputSchema,
    lastInputData: ProcessedInputData,
    nextInputData: ProcessedInputData,
    alpha: number,
  ) {
    this.updateXRSpaceFromMergedFrames(
      inputSource.targetRaySpace,
      lastInputData.targetRayTransform,
      nextInputData.targetRayTransform,
      alpha,
    );

    if (schema.hasGrip) {
      this.updateXRSpaceFromMergedFrames(
        inputSource.gripSpace!,
        lastInputData.gripTransform!,
        nextInputData.gripTransform!,
        alpha,
      );
    }

    if (schema.hasHand) {
      for (let i = 0; i < 25; i++) {
        const lastTransformArray = lastInputData.handTransforms!.slice(
          i * 8,
          i * 8 + 7,
        );
        const nextTransformArray = nextInputData.handTransforms!.slice(
          i * 8,
          i * 8 + 7,
        );
        const lastRadius = lastInputData.handTransforms![i * 8 + 7];
        const nextRadius = nextInputData.handTransforms![i * 8 + 7];
        const jointSpace = inputSource.hand!.get(
          schema.jointSequence![i] as XRHandJoint,
        )!;
        this.updateXRSpaceFromMergedFrames(
          jointSpace,
          lastTransformArray,
          nextTransformArray,
          alpha,
        );
        jointSpace[P_JOINT_SPACE].radius =
          (nextRadius - lastRadius) * alpha + lastRadius;
      }
    }

    if (schema.hasGamepad) {
      const gamepad = inputSource.gamepad!;
      nextInputData.buttons!.forEach((states, index) => {
        const gamepadButton = gamepad.buttons[index]! as GamepadButton;
        gamepadButton[P_GAMEPAD].pressed = states[0] === 1 ? true : false;
        gamepadButton[P_GAMEPAD].touched = states[1] === 1 ? true : false;
        const lastValue = lastInputData.buttons![index][2];
        const nextValue = states[2];
        gamepadButton[P_GAMEPAD].value =
          (nextValue - lastValue) * alpha + lastValue;
      });
      nextInputData.axes!.forEach((nextValue, index) => {
        const lastValue = lastInputData.axes![index];
        gamepad[P_GAMEPAD].axesMap[index.toString()].x =
          (nextValue - lastValue) * alpha + lastValue;
      });
    }
  }

  updateXRSpaceFromMergedFrames(
    space: XRSpace,
    lastTransform: number[],
    nextTransform: number[],
    alpha: number,
  ) {
    const f1p = vec3.set(
      this[P_ACTION_PLAYER].f1p,
      lastTransform[0],
      lastTransform[1],
      lastTransform[2],
    );
    const f1q = quat.set(
      this[P_ACTION_PLAYER].f1q,
      lastTransform[3],
      lastTransform[4],
      lastTransform[5],
      lastTransform[6],
    );
    const f2p = vec3.set(
      this[P_ACTION_PLAYER].f2p,
      nextTransform[0],
      nextTransform[1],
      nextTransform[2],
    );
    const f2q = quat.set(
      this[P_ACTION_PLAYER].f2q,
      nextTransform[3],
      nextTransform[4],
      nextTransform[5],
      nextTransform[6],
    );
    vec3.lerp(this[P_ACTION_PLAYER].vec3, f1p, f2p, alpha);
    quat.slerp(this[P_ACTION_PLAYER].quat, f1q, f2q, alpha);
    mat4.fromRotationTranslation(
      space[P_SPACE].offsetMatrix,
      this[P_ACTION_PLAYER].quat,
      this[P_ACTION_PLAYER].vec3,
    );
  }

  processRawInputData(inputDataRaw: any[]) {
    const index = inputDataRaw[0];
    const schema = this[P_ACTION_PLAYER].inputSchemas.get(index)!;
    const targetRayTransform: number[] = inputDataRaw.slice(1, 8);
    const inputData: ProcessedInputData = { targetRayTransform };
    let dataCounter = 8;
    if (schema.hasGrip) {
      inputData.gripTransform = inputDataRaw[dataCounter++];
    }
    if (schema.hasHand) {
      inputData.handTransforms = inputDataRaw[dataCounter++];
    }
    if (schema.hasGamepad) {
      const gamepadData = inputDataRaw[dataCounter] as any[];
      inputData.buttons = gamepadData.slice(0, schema.numButtons!);
      inputData.axes = gamepadData.slice(schema.numButtons!);
    }
    return { index, inputData };
  }
}

export const mergeTransform = (
  f1: number[],
  f2: number[],
  alpha: number,
  position: vec3,
  quaternion: quat,
) => {
  const f1p = vec3.fromValues(f1[0], f1[1], f1[2]);
  const f1q = quat.fromValues(f1[3], f1[4], f1[5], f1[6]);
  const f2p = vec3.fromValues(f2[0], f2[1], f2[2]);
  const f2q = quat.fromValues(f2[3], f2[4], f2[5], f2[6]);
  vec3.lerp(position, f1p, f2p, alpha);
  quat.slerp(quaternion, f1q, f2q, alpha);
};
