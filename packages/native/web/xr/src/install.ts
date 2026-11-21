/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Installs WebXR for the page: IWER host mode (the only WebXR implementation in the runtime) on navigator.xr,
// driven by the native XR module (docs/spec/08, 09, 10).
//
// Order of work per OpenXR frame (XR-LOOP-1): the XR thread fills the frame record and hands the frame to the JS
// thread; here the record becomes IWER's XRHostFrame (no copy), the input states are filled, the session's opaque
// texture is pointed at the frame's image, IWER runs the session's callbacks and then window rAF, and the frame
// ends with depth invalidation and a GL fence the XR thread waits on before it releases the image.

import {
  XRDevice,
  XRSystem,
  metaQuestTouchPlus,
  metaQuestTouchPro,
  oculusTouchV2,
  oculusTouchV3,
} from 'iwer/host';
import type { XRControllerConfig, XRDeviceConfig, XRHostInput } from 'iwer/host';

import { NativeHostBackend } from './backend.ts';
import { installGeometry } from './geometry.ts';
import { GraphicsBridge } from './graphics.ts';
import { LAYOUT_VERSION } from './layout.gen.ts';
import { FRAME_TICK, FRAME_XR } from './natives.ts';
import type { GLContext, WebGLHooks, XrInfo, XrNativeEvent, XrNatives } from './natives.ts';
import { FrameRecordView } from './record.ts';

type Global = Record<string, unknown> & typeof globalThis;
type Ctor = new (...args: never[]) => object;

/** What the runtime exposes for tools and tests (globalThis.__iwnXR, non-enumerable). */
export interface NativeXR {
  /** XR-LIFE-2 explicit-grant mode: grants the held offerSession(); a no-op without one. */
  grantSession(): void;
  readonly device: XRDevice;
  readonly record: FrameRecordView;
  capabilities(): XrInfo;
  stats(): { frames: number; ticks: number; events: number; lastSerial: number; invalidations: number; parks: number };
  /** The WebGL context the session renders with (diagnostics). */
  gl(): GLContext | null;
}

// XR-LIFE-1's M3 set. 'bounded-floor' is withdrawn when the headset has no boundary (XR-SPACE-1); 'hand-tracking'
// is added when the system tracks hands. Later milestones (not granted, so required requests reject with
// NotSupportedError and optional ones are dropped): plane-detection, mesh-detection, anchors, hit-test,
// depth-sensing; immersive-ar is opt-in (xr.immersiveAr).
const BASE_FEATURES = [
  'viewer',
  'local',
  'local-floor',
  'bounded-floor',
  'layers',
  'low-fixed-foveation-level',
  'medium-fixed-foveation-level',
  'high-fixed-foveation-level',
];

/**
 * Touch Plus with the profile list Quest Browser reports for it (IN-2): measured with Meta's virtual Touch Plus
 * controllers in Quest Browser 156 on a Quest 3S and a Quest 3 (2026-10-21). IWER's metaQuestTouchPlus lacks the
 * 'oculus-touch-v2' fallback.
 */
const touchPlus: XRControllerConfig = {
  ...metaQuestTouchPlus,
  fallbackProfileIds: ['oculus-touch-v3', 'oculus-touch-v2', 'oculus-touch', 'generic-trigger-squeeze-thumbstick'],
};

/** The controller profiles of the headset's own controllers (IN-2). */
function controllerFor(model: string | undefined): XRControllerConfig {
  const m = (model ?? '').toLowerCase();
  if (m.includes('pro')) return metaQuestTouchPro;
  if (m.includes('quest 3') || m.includes('quest3')) {
    return touchPlus;
  }
  if (m.includes('quest 2') || m.includes('quest2')) return oculusTouchV3;
  if (m === 'quest' || m.includes('quest 1')) return oculusTouchV2;
  return touchPlus;
}

/**
 * IN-9: `navigator.getGamepads()` lists no gamepads: XR controllers are reached through
 * `XRInputSource.gamepad`, as in browsers, and the runtime has no other gamepad source. The glue leaves the
 * member to the input owner (web/glue navigator.ts).
 */
function installGetGamepads(g: Global): void {
  const nav = g.navigator as object | undefined;
  if (!nav || typeof (nav as { getGamepads?: unknown }).getGamepads === 'function') return;
  const proto = Object.getPrototypeOf(nav) as object | null;
  const target = proto && proto !== Object.prototype ? proto : nav;
  Object.defineProperty(target, 'getGamepads', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function getGamepads(): (object | null)[] {
      return [];
    },
  });
}

export function installNativeXR(g: Global, natives: XrNatives, hooks: WebGLHooks | null): NativeXR | null {
  installGeometry(g);
  installGetGamepads(g);
  const record = new FrameRecordView(natives.record());
  const versionsMatch = natives.layoutVersion === LAYOUT_VERSION && record.version === LAYOUT_VERSION;
  if (!versionsMatch) {
    // XRF-4: never run a session against a record laid out differently.
    console.error(
      `@iwer/native: frame record layout mismatch (native v${natives.layoutVersion}, record v${record.version}, ` +
        `adapter v${LAYOUT_VERSION}); immersive sessions are disabled`,
    );
  }

  const report = (error: unknown) => {
    const r = g.reportError as ((e: unknown) => void) | undefined;
    if (typeof r === 'function') r(error);
    else console.error(error);
  };
  const schedule = (cb: () => void) => {
    setTimeout(cb, 0);
  };
  const gfx = new GraphicsBridge(natives, hooks);
  const backend = new NativeHostBackend(natives, gfx, hooks, report, schedule);

  // The device starts with a provisional configuration so navigator.xr exists before any page script (DBG-STAGE);
  // the capabilities fill it in on first use (they need OpenXR to be initialised, which runs in parallel with boot).
  const config: XRDeviceConfig = {
    name: 'Meta Quest (iwer-native)',
    controllerConfig: touchPlus,
    supportedSessionModes: versionsMatch ? ['inline', 'immersive-vr'] : ['inline'],
    supportedFeatures: BASE_FEATURES.slice(),
    supportedFrameRates: [72, 80, 90, 120],
    isSystemKeyboardSupported: false,
    internalNominalFrameRate: 72,
    environmentBlendModes: { 'immersive-vr': 'opaque', 'immersive-ar': 'alpha-blend' },
    interactionMode: 'world-space',
    userAgent: String((g.navigator as { userAgent?: string } | undefined)?.userAgent ?? ''),
  };
  const device = new XRDevice(config, { host: backend });
  device.installRuntime({ globalObject: g });

  let input: XRHostInput = device.enableHostInput({ leftMenuButton: true, onHaptic: haptic });
  function haptic(hand: 'left' | 'right', intensity: number, durationMs: number, frequencyHz: number) {
    natives.haptic(hand === 'left' ? 0 : 1, intensity, durationMs, frequencyHz);
    // IN-7: pulse() resolves true once the pulse has played.
    return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), Math.max(0, durationMs)));
  }

  let caps: XrInfo | null = null;
  function capabilities(): XrInfo {
    if (caps) return caps;
    caps = natives.info();
    const modes = config.supportedSessionModes;
    modes.length = 0;
    modes.push('inline');
    if (caps.available && versionsMatch) {
      modes.push('immersive-vr');
      // XR-INIT-3, XR-AR-1: passthrough available and the app opted in (xr.immersiveAr; a later milestone).
      if (caps.immersiveAr === true) modes.push('immersive-ar');
    }
    const features = config.supportedFeatures;
    if (caps.handTracking && !features.includes('hand-tracking')) features.push('hand-tracking');
    const bounded = features.indexOf('bounded-floor');
    if (caps.hasStage !== true && bounded >= 0) features.splice(bounded, 1);
    if (caps.refreshRates && caps.refreshRates.length > 0) {
      config.supportedFrameRates.length = 0;
      for (const r of caps.refreshRates) config.supportedFrameRates.push(r);
    }
    backend.autoGrantOfferedSession = caps.explicitGrant !== true;
    const controller = controllerFor(caps.model);
    if (controller !== touchPlus && !device.activeSession) {
      device.disableHostInput();
      input = device.enableHostInput({ leftMenuButton: true, onHaptic: haptic, controllerConfig: controller });
    }
    return caps;
  }

  // Session bookkeeping for the native side (XR-LIFE-5/7, hand tracking, passthrough) and the boot marks.
  const sessions = new WeakSet<object>();
  let lastVisibility: { visible: boolean; focused: boolean } | null = null;
  function onSession(session: object, mode: string): void {
    if (sessions.has(session)) return;
    sessions.add(session);
    const features = ((session as { enabledFeatures?: string[] }).enabledFeatures ?? []) as string[];
    natives.sessionStarted(
      mode === 'immersive-ar',
      features.includes('hand-tracking'),
      features.includes('plane-detection'),
      features.includes('mesh-detection'),
    );
    if (lastVisibility) device.dispatchHostEvent({ type: 'visibilitychange', ...lastVisibility });
    (session as EventTarget).addEventListener?.('end', () => gfx.onSessionEnd(), { once: true });
  }
  // XR-LIFE-7: a pending offerSession()/requestSession() counts as offered. When the last pending one is rejected
  // (a required feature this runtime does not grant, immersive-ar without the opt-in, ...) and no session exists,
  // the runtime hears it, so the never-offered error line and exit still apply instead of black forever.
  let pendingRequests = 0;
  function trackRequest(p: Promise<object>): void {
    pendingRequests++;
    natives.offered();
    p.then(
      () => {
        pendingRequests--;
      },
      () => {
        pendingRequests--;
        if (pendingRequests === 0 && !device.activeSession) natives.offerRejected?.();
      },
    );
  }
  const proto = XRSystem.prototype as unknown as Record<string, unknown>;
  const requestSession = proto.requestSession as (this: XRSystem, mode: string, init?: object) => Promise<object>;
  const offerSession = proto.offerSession as (this: XRSystem, mode: string, init?: object) => Promise<object>;
  const isSessionSupported = proto.isSessionSupported as (this: XRSystem, mode: string) => Promise<boolean>;
  Object.defineProperty(proto, 'isSessionSupported', {
    configurable: true,
    writable: true,
    value: function isSessionSupportedNative(this: XRSystem, mode: string) {
      capabilities();
      return isSessionSupported.call(this, mode);
    },
  });
  Object.defineProperty(proto, 'requestSession', {
    configurable: true,
    writable: true,
    value: function requestSessionNative(this: XRSystem, mode: string, init?: object) {
      capabilities();
      const p = requestSession.call(this, mode, init);
      trackRequest(p);
      p.then((s) => onSession(s, String(mode)), () => {});
      return p;
    },
  });
  Object.defineProperty(proto, 'offerSession', {
    configurable: true,
    writable: true,
    value: function offerSessionNative(this: XRSystem, mode: string, init?: object) {
      capabilities();
      const p = offerSession.call(this, mode, init);
      trackRequest(p);
      return p;
    },
  });

  // The page's GL context reaches the backend through the layer classes (XR-SC-2/3).
  const wrapLayerClass = (name: string) => {
    const Base = g[name] as Ctor | undefined;
    if (typeof Base !== 'function') return;
    const Wrapped = {
      [name]: class extends (Base as new (session: object, context: GLContext, init?: object) => object) {
        constructor(session: object, context: GLContext, init?: object) {
          if (context && typeof context === 'object') gfx.noteContext(context);
          super(session, context, init);
        }
      },
    }[name];
    Object.defineProperty(g, name, { value: Wrapped, writable: true, configurable: true, enumerable: false });
  };
  wrapLayerClass('XRWebGLBinding');
  wrapLayerClass('XRWebGLLayer');

  // Anchors are a later milestone (XR-LIFE-1). IWER's own anchors would be poses fixed in the base space, not what
  // the WebXR Anchors module promises, so without the 'anchors' feature (never granted in this release) the calls
  // reject with NotSupportedError, as that module specifies for a session without the feature.
  const gateAnchors = (ctorName: string, method: string, sessionOf: (self: object) => object | undefined) => {
    const proto = (g[ctorName] as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    const original = proto?.[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (!proto || typeof original !== 'function') return;
    Object.defineProperty(proto, method, {
      configurable: true,
      writable: true,
      value: {
        [method](this: object, ...a: unknown[]) {
          const features = (sessionOf(this) as { enabledFeatures?: string[] } | undefined)?.enabledFeatures ?? [];
          if (!features.includes('anchors')) {
            return Promise.reject(
              new DOMException(`${ctorName}.${method}: WebXR anchors are not supported by @iwer/native yet`, 'NotSupportedError'),
            );
          }
          return original.apply(this, a);
        },
      }[method],
    });
  };
  gateAnchors('XRFrame', 'createAnchor', (f) => (f as { session?: object }).session);
  gateAnchors('XRSession', 'restorePersistentAnchor', (s) => s);
  gateAnchors('XRSession', 'deletePersistentAnchor', (s) => s);

  // window `load`: the entry module has been evaluated (XR-LIFE-7's clock starts).
  const addEventListener = g.addEventListener as ((t: string, l: () => void, o?: object) => void) | undefined;
  if (typeof addEventListener === 'function') {
    addEventListener.call(g, 'load', () => natives.entryEvaluated(), { once: true });
  }

  // --- frames -------------------------------------------------------------------------------------------------
  let frames = 0;
  let ticks = 0;
  let events = 0;
  function dispatch(list: XrNativeEvent[]): void {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      events++;
      if (e.type === 'visibilitychange') {
        lastVisibility = { visible: e.visible, focused: e.focused };
        device.dispatchHostEvent({ type: 'visibilitychange', visible: e.visible, focused: e.focused });
      } else if (e.type === 'frameratechange') {
        device.dispatchHostEvent({ type: 'frameratechange', rate: e.rate });
      } else if (e.type === 'referencespacereset') {
        device.dispatchHostEvent({ type: 'referencespacereset' });
      } else if (e.type === 'end') {
        device.dispatchHostEvent({ type: 'end' });
        gfx.onSessionEnd();
      }
    }
  }
  function windowFrame(): void {
    natives.runWindowFrame();
    hooks?.afterAnimationFrame();
  }
  function onFrame(kind: number, list?: XrNativeEvent[]): void {
    if (list) dispatch(list);
    if (kind === FRAME_XR) {
      frames++;
      const frame = record.refresh();
      record.copyInput(input.left, input.right);
      gfx.beginFrame(frame.colorTexture);
      if (device.activeSession) {
        device.runHostFrame(frame);  // session callbacks, then window rAF (backend.runWindowFrame)
      } else {
        windowFrame();  // the session ended in JS before the native side heard of it
      }
      gfx.endFrame(frame.colorTexture !== 0);
    } else if (kind === FRAME_TICK) {
      ticks++;
      windowFrame();
    }
  }
  if (versionsMatch) natives.setFrameHandler(onFrame);

  const api: NativeXR = {
    grantSession() {
      capabilities();
      device.grantOfferedSession();
    },
    device,
    record,
    capabilities,
    stats: () => ({
      frames,
      ticks,
      events,
      lastSerial: record.frame.frameSerial,
      invalidations: gfx.invalidations,
      parks: gfx.parks,
    }),
    gl: () => gfx.gl,
  };
  Object.defineProperty(g, '__iwnXR', { value: api, configurable: true, enumerable: false, writable: false });
  return api;
}
