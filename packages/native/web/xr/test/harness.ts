/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Test harness: evaluates the shipped prelude (dist/xr.js, built by `npm test`) in a fresh V8 context whose
// globals are what the runtime provides around it (glue: EventTarget, Event, DOMException, performance, navigator,
// timers, reportError; the WebGL prelude's host hooks), with fake XR natives that honour runtime/xr's contract:
// a frame record of RECORD_BYTES the test writes with the generated layout indices, a frame handler the test calls
// as the native FramePump would, and a call log.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { COUNTS, F32, F64, HAND_F32, HAND_U32, HAND_U8, LAYOUT_VERSION, RECORD_BYTES, U32 } from '../src/layout.gen.ts';
import { LAYER_BUFFER_VERSION, LAYER_BUFFER_WORDS, NAMES_AT, NO_LIST, COUNT_AT, VERSION_AT } from '../src/layers.ts';
import type { NativeSwapchain, SceneData, XrInfo, XrNativeEvent } from '../src/natives.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, '../dist/xr.js'), 'utf8');

export type Call = [string, ...unknown[]];

export interface FakeGL {
  calls: Call[];
  ctx: Record<string, unknown>;
}

export interface Harness {
  context: vm.Context;
  g: Record<string, any>;
  calls: Call[];
  glCalls: Call[];
  /** Every retargetTexture that changed a texture's name: the new name, the texture and the framebuffer list. */
  retargets: Array<{ name: number; tex: unknown; fbs: unknown[] }>;
  gl: Record<string, any>;
  reported: unknown[];
  logs: string[];
  record: { u32: Uint32Array; f32: Float32Array; f64: Float64Array; u8: Uint8Array; buffer: ArrayBuffer };
  /** The composition-layer buffer (layers.ts) as the XR thread sees it; names of acquired images go in here. */
  layerWords: { u32: Uint32Array; f32: Float32Array };
  info: XrInfo;
  swapchain: NativeSwapchain | null;
  /**
   * The fake permission state (XR-PERM-1): what checkPermissions reports, and what requestPermissions grants (the
   * "user's answer" for each name; unlisted names are denied). Null: natives without the permission helpers. With
   * `hold` set, native requests wait (the dialog is up) until release() answers them, in the order they were made.
   */
  permissions: {
    held: Record<string, boolean>;
    answer: Record<string, boolean>;
    fail?: boolean;
    hold?: boolean;
    release(): void;
  } | null;
  /** With `scene: true`: what sceneData() answers (when its version differs from the caller's) and the pose table. */
  sceneData: SceneData | null;
  scenePoses: Float32Array;
  /** Runs one XR frame as the native pump does (kind 1), after writing a default frame unless told not to. */
  frame(opts?: Partial<FrameOptions>): void;
  tick(): void;
  events(list: XrNativeEvent[]): void;
  /** Evaluates page code in the context. */
  run<T = unknown>(code: string): T;
  /** Lets timers and microtasks run. */
  settle(ms?: number): Promise<void>;
  handler(): ((kind: number, events?: XrNativeEvent[]) => void) | null;
}

export interface FrameOptions {
  time: number;
  colorTexture: number;
  views: number[];
  localPose: number[];
  baseIsStage: boolean;
  frameRate: number;
  writeFrame: boolean;
  events: XrNativeEvent[];
}

const DEFAULT_FOV = [-0.82, 0.76, 0.85, -0.93];
export const DEFAULT_VIEWS = [
  -0.031, 1.6, 0, 0, 0, 0, 1, ...DEFAULT_FOV,
  0.031, 1.6, 0, 0, 0, 0, 1, ...DEFAULT_FOV,
];

export function writeController(
  rec: Harness['record'],
  hand: 0 | 1,
  opts: { trigger?: number; pressed?: boolean; aim?: number[]; grip?: number[]; mode?: number; profile?: number; stick?: [number, number] },
): void {
  rec.u32[HAND_U32.inputMode[hand]] = opts.mode ?? 1;
  // Native interaction profile (input_map.h): 2 Touch Plus; 5 hand_interaction_ext (a hand used as a pointer).
  rec.u32[HAND_U32.inputProfile[hand]] = opts.profile ?? 2;
  rec.u32[HAND_U32.inputFlags[hand]] = 1 | 2;
  rec.f32.set(opts.aim ?? [hand ? 0.2 : -0.2, 1.3, -0.3, 0, 0, 0, 1], HAND_F32.targetRay[hand]);
  rec.f32.set(opts.grip ?? [hand ? 0.2 : -0.2, 1.25, -0.25, 0, 0, 0, 1], HAND_F32.grip[hand]);
  rec.f32[HAND_F32.buttonValues[hand]] = opts.trigger ?? 0;
  rec.u8[HAND_U8.buttonPressed[hand]] = opts.pressed ? 1 : 0;
  rec.u8[HAND_U8.buttonTouched[hand]] = opts.pressed ? 1 : 0;
  if (opts.stick) {
    rec.f32[HAND_F32.axes[hand] + 2] = opts.stick[0];
    rec.f32[HAND_F32.axes[hand] + 3] = opts.stick[1];
  }
}

export function createHarness(
  opts: {
    info?: Partial<XrInfo>;
    layoutVersion?: number;
    swapchain?: NativeSwapchain | null;
    noWebGL?: boolean;
    /** Natives without the quad and cylinder layer calls (an older runtime). */
    noLayers?: boolean;
    /** The layer buffer's version as the native side writes it. */
    layerBufferVersion?: number;
    /** The user's answer per permission (see Harness.permissions); null: no permission helpers. */
    permissions?: Record<string, boolean> | null;
    /** What declaredPermissions reports (the manifest); absent: natives without it (all count as declared). */
    declared?: string[] | null;
    /** Provide the scene natives (sceneData, scenePoses, sceneStatus) of runtime/xr xr_scene.h. */
    scene?: boolean;
    /** More natives (a feature's own calls), present before the prelude is evaluated. */
    natives?: Record<string, unknown>;
    /** The camera natives (globalThis.__iwn.camera, xr_camera.h) for getUserMedia tests. */
    camera?: object;
  } = {},
): Harness {
  const buffer = new ArrayBuffer(RECORD_BYTES);
  const record = {
    buffer,
    u32: new Uint32Array(buffer),
    f32: new Float32Array(buffer),
    f64: new Float64Array(buffer),
    u8: new Uint8Array(buffer),
  };
  record.u32[U32.layoutVersion] = opts.layoutVersion ?? LAYOUT_VERSION;
  for (const at of [F32.localPose, F32.viewerPose]) record.f32[at + 6] = 1;
  for (const h of [0, 1] as const) {
    record.f32[HAND_F32.targetRay[h] + 6] = 1;
    record.f32[HAND_F32.grip[h] + 6] = 1;
    record.f32[HAND_F32.palm[h] + 6] = 1;
    for (let j = 0; j < 25; j++) record.f32[HAND_F32.joints[h] + j * 8 + 6] = 1;
  }

  const calls: Call[] = [];
  const glCalls: Call[] = [];
  const retargets: Harness['retargets'] = [];
  const reported: unknown[] = [];
  const logs: string[] = [];
  let handler: ((kind: number, events?: XrNativeEvent[]) => void) | null = null;
  const info: XrInfo = {
    available: true,
    model: 'Quest 3S',
    systemName: 'Meta Quest 3S',
    recommendedWidth: 1680,
    recommendedHeight: 1760,
    refreshRates: [72, 90, 120],
    refreshRate: 72,
    hasStage: true,
    stageWidth: 3,
    stageDepth: 2,
    baseIsStage: true,
    handTracking: true,
    passthrough: false,
    foveation: true,
    explicitGrant: false,
    layoutVersion: LAYOUT_VERSION,
    ...opts.info,
  };
  const h = {} as Harness;
  h.swapchain =
    opts.swapchain === undefined
      ? { width: 1680, height: 1760, arraySize: 2, rates: [72, 90, 120], rate: 72, hasStage: true, stageWidth: 3, stageDepth: 2 }
      : opts.swapchain;

  const layerBuffer = new ArrayBuffer(LAYER_BUFFER_WORDS * 4);
  const layerWords = { u32: new Uint32Array(layerBuffer), f32: new Float32Array(layerBuffer) };
  layerWords.u32[VERSION_AT] = opts.layerBufferVersion ?? LAYER_BUFFER_VERSION;
  layerWords.u32[COUNT_AT] = NO_LIST;
  let nextLayerId = 1;
  let nextLayerImage = 900;
  const layerNatives = opts.noLayers
    ? {}
    : {
        layers: () => layerBuffer,
        beginLayerSwapchain: (...args: unknown[]) => {
          calls.push(['beginLayerSwapchain', ...args]);
          if ((args[1] as number) > 4096) return null;  // the system's swapchain limit
          return { id: nextLayerId++, width: args[1], height: args[2], arraySize: args[3] };
        },
        destroyLayerSwapchain: (id: number) => calls.push(['destroyLayerSwapchain', id]),
        acquireLayerImage: (id: number) => {
          calls.push(['acquireLayerImage', id]);
          const name = nextLayerImage++;
          layerWords.u32[NAMES_AT + id - 1] = name;
          return name;
        },
      };

  const heldAnswers: Array<() => void> = [];
  h.permissions =
    opts.permissions === null
      ? null
      : {
          held: {},
          answer: { ...opts.permissions },
          release() {
            for (const answer of heldAnswers.splice(0)) answer();
          },
        };
  const permissionHelpers = h.permissions
    ? {
        requestPermissions: (names: string[]) => {
          calls.push(['requestPermissions', [...names]]);
          const p = h.permissions!;
          if (p.fail) return Promise.reject(new Error('requestPermissions failed'));
          const answer = () => {
            for (const n of names) if (p.answer[n] === true) p.held[n] = true;
            return Object.fromEntries(names.map((n) => [n, p.held[n] === true]));
          };
          if (!p.hold) return Promise.resolve(answer());
          return new Promise((resolve) => heldAnswers.push(() => resolve(answer())));
        },
        checkPermissions: (names: string[]) => {
          calls.push(['checkPermissions', [...names]]);
          return Object.fromEntries(names.map((n) => [n, h.permissions!.held[n] === true]));
        },
        ...(opts.declared !== undefined ? { declaredPermissions: () => opts.declared } : {}),
      }
    : {};

  h.sceneData = null;
  h.scenePoses = new Float32Array(512 * 8);
  const sceneNatives = opts.scene
    ? {
        sceneData: (known: number) => {
          calls.push(['sceneData', known]);
          return h.sceneData && h.sceneData.version !== known ? h.sceneData : null;
        },
        scenePoses: () => h.scenePoses.buffer,
        sceneStatus: () => ({ phase: h.sceneData ? 'ready' : 'querying' }),
      }
    : {};
  const natives = {
    ...layerNatives,
    ...permissionHelpers,
    ...sceneNatives,
    layoutVersion: opts.layoutVersion ?? LAYOUT_VERSION,
    info: () => {
      calls.push(['info']);
      return info;
    },
    record: () => buffer,
    setFrameHandler: (fn: typeof handler) => {
      handler = fn;
    },
    beginSwapchain: (...args: unknown[]) => {
      calls.push(['beginSwapchain', ...args]);
      if (!h.swapchain) return null;
      return { ...h.swapchain, arraySize: args[0] === 1 ? 1 : h.swapchain.arraySize, width: args[0] === 1 ? 3360 : h.swapchain.width };
    },
    endSession: () => calls.push(['endSession']),
    requestFrameRate: (hz: number) => {
      calls.push(['requestFrameRate', hz]);
      return (info.refreshRates ?? []).includes(hz);
    },
    setFoveation: (l: number) => calls.push(['setFoveation', l]),
    setPassthroughVisible: (v: boolean) => calls.push(['setPassthroughVisible', v]),
    haptic: (...a: unknown[]) => calls.push(['haptic', ...a]),
    sessionStarted: (...a: unknown[]) => calls.push(['sessionStarted', ...a]),
    offered: () => calls.push(['offered']),
    offerRejected: () => calls.push(['offerRejected']),
    entryEvaluated: () => calls.push(['entryEvaluated']),
    runWindowFrame: () => calls.push(['runWindowFrame']),
    endFrameGL: () => calls.push(['endFrameGL']),
    ...opts.natives,
  };

  // A recording WebGL context with the internal surface the hooks touch. Like the WebGL binding it keeps the
  // draw-framebuffer binding and each framebuffer's record of attachments (`_attachments`).
  let drawFramebuffer: { _attachments?: Map<number, { object: unknown }> } | null = null;
  const gl: Record<string, any> = {
    _id: 1,
    _makeCurrent() {
      glCalls.push(['_makeCurrent']);
    },
    bindFramebuffer(target: number, fb: unknown) {
      glCalls.push(['bindFramebuffer', target, fb]);
      if (target === 0x8d40 || target === 0x8ca9) drawFramebuffer = fb as typeof drawFramebuffer;
    },
    isFramebuffer(fb: unknown) {
      return !!fb;
    },
    getContextAttributes() {
      return { premultipliedAlpha: true, antialias: true };
    },
    createFramebuffer() {
      return { _attachments: new Map() };
    },
    createRenderbuffer() {
      return {};
    },
    getParameter(pname: number) {
      return pname === 0x8ca6 ? drawFramebuffer : null;  // FRAMEBUFFER_BINDING (= DRAW_FRAMEBUFFER_BINDING)
    },
    framebufferTexture2D(_t: number, att: number, _tt: number, tex: unknown) {
      glCalls.push(['framebufferTexture2D', att, tex]);
      const atts = drawFramebuffer?._attachments;
      if (atts) {
        if (tex) atts.set(att, { object: tex });
        else atts.delete(att);
      }
    },
    framebufferRenderbuffer() {},
    renderbufferStorage() {},
    bindRenderbuffer() {},
    invalidateFramebuffer() {},
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    DRAW_FRAMEBUFFER: 0x8ca9,
    FRAMEBUFFER: 0x8d40,
  };
  const webgl = opts.noWebGL
    ? undefined
    : {
        wrapTexture: (_ctx: unknown, name: number, target: number) => {
          glCalls.push(['wrapTexture', name, target]);
          return { _name: name, _target: target, wrapped: true };
        },
        retargetTexture: (_ctx: unknown, tex: { _name: number }, name: number, fbs: Iterable<unknown>) => {
          if (tex._name === name) return;  // as web/webgl host.ts: nothing to do for an unchanged name
          const list = [...fbs];
          glCalls.push(['retargetTexture', name, list.length]);
          retargets.push({ name, tex, fbs: list });
          tex._name = name;
        },
        invalidateDepthStencil: (_ctx: unknown, fb: unknown) => glCalls.push(['invalidateDepthStencil', fb]),
        clearSessionFramebuffer: (_ctx: unknown, fb: unknown) => glCalls.push(['clearSessionFramebuffer', fb]),
        frameBoundary: () => glCalls.push(['frameBoundary']),
        afterAnimationFrame: () => glCalls.push(['afterAnimationFrame']),
      };

  const loadListeners: Array<() => void> = [];
  const sandbox: Record<string, any> = {
    console: {
      log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
      info: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
      warn: (...a: unknown[]) => logs.push('warn: ' + a.map(String).join(' ')),
      error: (...a: unknown[]) => logs.push('error: ' + a.map(String).join(' ')),
      debug: () => {},
    },
    EventTarget,
    Event,
    DOMException,
    performance,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    navigator: { userAgent: 'iwer-native-test' },
    reportError: (e: unknown) => reported.push(e),
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'load') loadListeners.push(fn);
    },
    __iwn: { xr: natives, ...(opts.camera ? { camera: opts.camera } : {}) },
    __iwnWebGL: webgl,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(bundle, context, { filename: 'xr.js' });

  const writeFrame = (o: Partial<FrameOptions>) => {
    const time = o.time ?? 1000;
    record.f64[F64.predictedDisplayTime] = time;
    record.f64[F64.frameStartTime] = time - 20;
    record.f64[F64.displayPeriod] = 1000 / 72;
    record.u32[U32.flags] = 1 | ((o.baseIsStage ?? true) ? 2 : 0);
    record.u32[U32.viewCount] = 2;
    record.u32[U32.colorTexture] = o.colorTexture ?? 41;
    record.u32[U32.frameSerial] += 1;
    record.f32[F32.frameRate] = o.frameRate ?? 72;
    record.f32.set(o.views ?? DEFAULT_VIEWS, F32.views);
    record.f32.set(o.localPose ?? [0.3, 1.5, -0.2, 0, 0, 0, 1], F32.localPose);
  };

  let time = 1000;
  Object.assign(h, {
    context,
    g: sandbox,
    calls,
    glCalls,
    retargets,
    gl,
    reported,
    logs,
    record,
    layerWords,
    info,
    frame(o: Partial<FrameOptions> = {}) {
      time += 1000 / 72;
      if (o.writeFrame !== false) writeFrame({ time, ...o });
      if (!handler) throw new Error('no frame handler registered');
      handler(1, o.events);
    },
    tick() {
      if (!handler) throw new Error('no frame handler registered');
      handler(2);
    },
    events(list: XrNativeEvent[]) {
      if (!handler) throw new Error('no frame handler registered');
      handler(3, list);
    },
    run(code: string) {
      return vm.runInContext(code, context);
    },
    async settle(ms = 0) {
      await new Promise((r) => setTimeout(r, ms));
      await new Promise((r) => setImmediate(r));
    },
    handler: () => handler,
    load() {
      for (const fn of loadListeners) fn();
    },
  });
  void COUNTS;
  return h;
}
