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
  negotiateHostDepth,
  metaQuestTouchPlus,
  metaQuestTouchPro,
  oculusTouchV2,
  oculusTouchV3,
} from 'iwer/host';
import type {
  XRControllerConfig,
  XRDeviceConfig,
  XRHostInput,
} from 'iwer/host';

import { NativeHostBackend } from './backend.ts';
import { DEPTH_SUPPORT, DEPTH_VERSION, DepthRecordView } from './depth.ts';
import type { DepthState } from './depth.ts';
import { installGeometry } from './geometry.ts';
import { GraphicsBridge } from './graphics.ts';
import { LayerBuffer } from './layers.ts';
import { LAYOUT_VERSION } from './layout.gen.ts';
import { FRAME_TICK, FRAME_XR } from './natives.ts';
import type {
  GLContext,
  WebGLHooks,
  XrInfo,
  XrNativeEvent,
  XrNatives,
} from './natives.ts';
import { RuntimePermissions, USE_SCENE } from './permissions.ts';
import { FrameRecordView } from './record.ts';
import { NativeScene } from './scene.ts';

type Global = Record<string, unknown> & typeof globalThis;
type Ctor = new (...args: never[]) => object;

/** What the runtime exposes for tools and tests (globalThis.__iwnXR, non-enumerable). */
export interface NativeXR {
  /** XR-LIFE-2 explicit-grant mode: grants the held offerSession(); a no-op without one. */
  grantSession(): void;
  readonly device: XRDevice;
  readonly record: FrameRecordView;
  capabilities(): XrInfo;
  stats(): {
    frames: number;
    ticks: number;
    events: number;
    lastSerial: number;
    invalidations: number;
    parks: number;
    /** XR-LAYER-1: live quad and cylinder layer swapchains, entries of the latest layer list. */
    layerSwapchains: number;
    layerEntries: number;
    clears: number;
  };
  /** The WebGL context the session renders with (diagnostics). */
  gl(): GLContext | null;
  /**
   * XR-PERM-1: asks for Android runtime permissions (the system dialog at most once per permission and process,
   * after any request in flight; one dialog for the ones not asked yet) and resolves each name to whether the app
   * holds it. A permission the manifest does not declare is never asked for (false). For runtime code that needs
   * one outside a session request (getUserMedia: CAMERA and HEADSET_CAMERA).
   */
  requestPermissions(
    names: readonly string[],
  ): Promise<Record<string, boolean>>;
  /** The room (diagnostics): the runtime's scene status and what the adapter lists this frame. */
  scene(): Record<string, unknown>;
  /** Spatial anchor counters of the native side (diagnostics, XR-ANCHOR-1); null without anchor natives. */
  anchorStats(): Record<string, unknown> | null;
  /** XR-DEPTH-2: the latest frame's depth record (null: the runtime writes none). */
  depth(): DepthState | null;
}

// XR-LIFE-1's M3 set. 'bounded-floor' is withdrawn when the headset has no boundary (XR-SPACE-1); 'hand-tracking'
// is added when the system tracks hands; the AR features (NATIVE_FEATURES) when the native side supports them.
// immersive-ar is offered when the app declares passthrough (the packer writes xr.immersiveAr).
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
 * XR-PERM-1: features a session can be granted only when the native side reports support (the capability flag
 * here, from capabilities()); until then required requests reject with NotSupportedError and optional ones are
 * dropped, as for any unsupported feature.
 */
const NATIVE_FEATURES: Readonly<Record<string, keyof XrInfo>> = {
  'plane-detection': 'planeDetection',
  'mesh-detection': 'meshDetection',
  'hit-test': 'hitTest',
  anchors: 'anchors',
  'depth-sensing': 'depthSensing',
};

/** Read from the room (XR-AR-2): granted only when the scene natives are there as well as the native flags. */
const SCENE_FEATURES = ['plane-detection', 'mesh-detection', 'hit-test'];

/** XR-PERM-1: features that need an Android runtime permission (the system dialog) before a session gets them. */
const FEATURE_PERMISSIONS: Readonly<Record<string, string>> = {
  'plane-detection': USE_SCENE,
  'mesh-detection': USE_SCENE,
  'hit-test': USE_SCENE,
  'depth-sensing': USE_SCENE,
};

/**
 * XR-PERM-1: features Quest Browser offers in immersive sessions only (its IsFeatureValidForMode): for any other mode
 * a required one rejects the request with NotSupportedError and an optional one is dropped, before any dialog or
 * native work. Quest Browser's table allows depth-sensing in every mode, but its inline sessions never get it.
 */
const IMMERSIVE_ONLY = new Set([
  'bounded-floor',
  'unbounded',
  'hand-tracking',
  'layers',
  'hit-test',
  'anchors',
  'plane-detection',
  'mesh-detection',
  'depth-sensing',
]);

/** A sequence<DOMString> member of XRSessionInit as an array (absent or not iterable: empty). */
function featureList(value: unknown): string[] {
  if (value == null || typeof value === 'string') return [];
  if (typeof (value as Iterable<unknown>)[Symbol.iterator] !== 'function')
    return [];
  return Array.from(value as Iterable<unknown>, String);
}

/**
 * Touch Plus with the profile list Quest Browser reports for it (IN-2): measured with Meta's virtual Touch Plus
 * controllers in Quest Browser 156 on a Quest 3S and a Quest 3 (2026-10-21). IWER's metaQuestTouchPlus lacks the
 * 'oculus-touch-v2' fallback.
 */
const touchPlus: XRControllerConfig = {
  ...metaQuestTouchPlus,
  fallbackProfileIds: [
    'oculus-touch-v3',
    'oculus-touch-v2',
    'oculus-touch',
    'generic-trigger-squeeze-thumbstick',
  ],
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
  if (
    !nav ||
    typeof (nav as { getGamepads?: unknown }).getGamepads === 'function'
  )
    return;
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

export function installNativeXR(
  g: Global,
  natives: XrNatives,
  hooks: WebGLHooks | null,
): NativeXR | null {
  installGeometry(g);
  installGetGamepads(g);
  const record = new FrameRecordView(natives.record());
  const versionsMatch =
    natives.layoutVersion === LAYOUT_VERSION &&
    record.version === LAYOUT_VERSION;
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
  // XR-LAYER-1: the buffer quad and cylinder layers share with the XR thread (absent or of another layout: no such
  // layers, createQuadLayer / createCylinderLayer throw NotSupportedError)
  let layerBuffer: LayerBuffer | null = null;
  if (typeof natives.layers === 'function') {
    const candidate = new LayerBuffer(natives.layers());
    if (candidate.valid) {
      layerBuffer = candidate;
      gfx.setLayerBuffer(candidate);
    } else {
      console.error(
        '@iwer/native: composition layer buffer of another layout; quad and cylinder layers are off',
      );
    }
  }
  const backend = new NativeHostBackend(
    natives,
    gfx,
    hooks,
    report,
    schedule,
    layerBuffer,
  );
  // the room for planes, meshes and hit test, read once per XR frame (frames: the counter below)
  const scene = new NativeScene(natives, () => frames);
  if (scene.supported) backend.scene = scene;
  // XR-DEPTH-2: the depth record, read only with the layout this adapter knows
  if (
    typeof natives.depthRecord === 'function' &&
    natives.depthRecordVersion === DEPTH_VERSION
  ) {
    backend.depthRecord = new DepthRecordView(natives.depthRecord());
  }

  // The device starts with a provisional configuration so navigator.xr exists before any page script (DBG-STAGE);
  // the capabilities fill it in on first use (they need OpenXR to be initialised, which runs in parallel with boot).
  const config: XRDeviceConfig = {
    name: 'Meta Quest (iwer-native)',
    controllerConfig: touchPlus,
    supportedSessionModes: versionsMatch
      ? ['inline', 'immersive-vr']
      : ['inline'],
    supportedFeatures: BASE_FEATURES.slice(),
    supportedFrameRates: [72, 80, 90, 120],
    isSystemKeyboardSupported: false,
    internalNominalFrameRate: 72,
    environmentBlendModes: {
      'immersive-vr': 'opaque',
      'immersive-ar': 'alpha-blend',
    },
    interactionMode: 'world-space',
    userAgent: String(
      (g.navigator as { userAgent?: string } | undefined)?.userAgent ?? '',
    ),
  };
  const device = new XRDevice(config, { host: backend });
  device.installRuntime({ globalObject: g });

  let input: XRHostInput = device.enableHostInput({
    leftMenuButton: true,
    onHaptic: haptic,
  });
  function haptic(
    hand: 'left' | 'right',
    intensity: number,
    durationMs: number,
    frequencyHz: number,
  ) {
    natives.haptic(hand === 'left' ? 0 : 1, intensity, durationMs, frequencyHz);
    // IN-7: pulse() resolves true once the pulse has played.
    return new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), Math.max(0, durationMs)),
    );
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
    if (caps.handTracking && !features.includes('hand-tracking'))
      features.push('hand-tracking');
    for (const [feature, flag] of Object.entries(NATIVE_FEATURES)) {
      if (SCENE_FEATURES.includes(feature) && !scene.supported) continue; // an older runtime without the scene natives
      if (feature === 'depth-sensing' && !backend.depthRecord) continue; // no depth record this adapter can read
      if (caps[flag] === true && !features.includes(feature))
        features.push(feature);
    }
    const bounded = features.indexOf('bounded-floor');
    if (caps.hasStage !== true && bounded >= 0) features.splice(bounded, 1);
    // XR-DEPTH-2: 'depth-sensing' (gpu-optimized) when the system has environment depth and the record is readable
    if (features.includes('depth-sensing'))
      backend.depthSensing = DEPTH_SUPPORT;
    if (caps.refreshRates && caps.refreshRates.length > 0) {
      config.supportedFrameRates.length = 0;
      for (const r of caps.refreshRates) config.supportedFrameRates.push(r);
    }
    backend.autoGrantOfferedSession = caps.explicitGrant !== true;
    const controller = controllerFor(caps.model);
    if (controller !== touchPlus && !device.activeSession) {
      device.disableHostInput();
      input = device.enableHostInput({
        leftMenuButton: true,
        onHaptic: haptic,
        controllerConfig: controller,
      });
    }
    return caps;
  }

  // Session bookkeeping for the native side (XR-LIFE-5/7, hand tracking, passthrough) and the boot marks.
  const sessions = new WeakSet<object>();
  let lastVisibility: { visible: boolean; focused: boolean } | null = null;
  function onSession(session: object, mode: string): void {
    if (sessions.has(session)) return;
    sessions.add(session);
    const features = ((session as { enabledFeatures?: string[] })
      .enabledFeatures ?? []) as string[];
    natives.sessionStarted(
      mode === 'immersive-ar',
      features.includes('hand-tracking'),
      features.includes('plane-detection'),
      features.includes('mesh-detection'),
    );
    // the room query starts with the session, not with the first hit-test source
    if (SCENE_FEATURES.some((f) => features.includes(f))) scene.start();
    // XR-DEPTH-2: environment depth from now until the session ends (the frame-start clears begin with the first depth
    // handed out: graphics.ts). Hand removal stays off, as in Quest Browser: real hands occlude virtual content
    if (features.includes('depth-sensing') && backend.depthSensing)
      natives.startDepth?.(false);
    if (lastVisibility)
      device.dispatchHostEvent({ type: 'visibilitychange', ...lastVisibility });
    (session as EventTarget).addEventListener?.(
      'end',
      () => gfx.onSessionEnd(),
      { once: true },
    );
  }
  // XR-LIFE-7: a pending offerSession()/requestSession() counts as offered. When the last pending one is rejected
  // (a required feature this runtime does not grant, immersive-ar without the opt-in, ...) and no session exists,
  // the runtime hears it, so the never-offered error line and exit still apply instead of black forever.
  let pendingRequests = 0;
  function trackRequest(
    p: Promise<object>,
    call: string,
    mode: string,
    init: object | undefined,
  ): void {
    pendingRequests++;
    natives.offered();
    p.then(
      () => {
        pendingRequests--;
      },
      (error: unknown) => {
        pendingRequests--;
        // Apps often swallow this rejection (IWSDK keeps offering), so the reason would appear nowhere: log it. An
        // offer the page withdraws (AbortError) is not a failure.
        const e = error as { name?: string; message?: string } | null;
        if (e?.name !== 'AbortError') {
          // IWER's message does not say which required feature is missing: name the ones this headset lacks
          const required = featureList(
            (init as { requiredFeatures?: unknown } | undefined)
              ?.requiredFeatures,
          );
          const supported = config.supportedFeatures as string[];
          const missing =
            e?.name === 'NotSupportedError'
              ? required.filter((f) => !supported.includes(f))
              : [];
          console.warn(
            `@iwer/native: navigator.xr.${call}('${mode}') was rejected: ${e?.name ?? 'Error'}: ${e?.message ?? String(error)}` +
              (missing.length
                ? ` Required but not available on this headset: ${missing.join(', ')}.`
                : ''),
          );
        }
        if (pendingRequests === 0 && !device.activeSession)
          natives.offerRejected?.();
      },
    );
  }
  // XR-PERM-1: features valid only in immersive sessions (IMMERSIVE_ONLY): another mode drops the optional ones and
  // rejects a required one. The init itself when nothing changes.
  function forMode(mode: string, init: object | undefined): object | undefined {
    if (mode === 'immersive-vr' || mode === 'immersive-ar') return init;
    const o = (init ?? {}) as {
      requiredFeatures?: unknown;
      optionalFeatures?: unknown;
    };
    const refused = featureList(o.requiredFeatures).find((f) =>
      IMMERSIVE_ONLY.has(f),
    );
    if (refused) {
      throw new DOMException(
        `The feature '${refused}' is not supported for mode: ${mode}.`,
        'NotSupportedError',
      );
    }
    const optional = featureList(o.optionalFeatures);
    if (!optional.some((f) => IMMERSIVE_ONLY.has(f))) return init;
    return {
      ...o,
      optionalFeatures: optional.filter((f) => !IMMERSIVE_ONLY.has(f)),
    };
  }
  // XR-PERM-1: before a session gets features that need a runtime permission, ask for it (once: the system dialog).
  // Granted: the request goes on unchanged. Denied: a required feature rejects the request with NotSupportedError
  // (as an unsupported one does), an optional one is dropped; so does a permission the manifest does not declare,
  // which is never asked for. No dialog for a request that fails anyway (an unsupported mode or required feature, an
  // active session) or for features the runtime cannot grant.
  const permissions = new RuntimePermissions(natives, report);
  function withPermissions(
    mode: string,
    init: object | undefined,
  ): Promise<object | undefined> | null {
    if (
      device.activeSession ||
      !config.supportedSessionModes.includes(mode as never)
    )
      return null;
    const o = (init ?? {}) as {
      requiredFeatures?: unknown;
      optionalFeatures?: unknown;
    };
    const required = featureList(o.requiredFeatures);
    const optional = featureList(o.optionalFeatures);
    const supported = config.supportedFeatures as string[];
    // depth the runtime cannot serve in the usage or format asked for is not granted anyway (IWER negotiates it)
    const servable = (f: string) =>
      f !== 'depth-sensing' ||
      !backend.depthSensing ||
      negotiateHostDepth(
        (init as { depthSensing?: never } | undefined)?.depthSensing,
        backend.depthSensing,
      ) !== null;
    if (!required.every((f) => supported.includes(f) && servable(f)))
      return null;
    const needed = new Set<string>();
    for (const f of [...required, ...optional]) {
      const permission = FEATURE_PERMISSIONS[f];
      if (permission && supported.includes(f) && servable(f))
        needed.add(permission);
    }
    if (needed.size === 0) return null;
    return permissions.request([...needed]).then((held) => {
      const denied = (f: string) =>
        FEATURE_PERMISSIONS[f] !== undefined &&
        held[FEATURE_PERMISSIONS[f]] !== true;
      const refused = required.find(denied);
      if (refused) {
        const permission = FEATURE_PERMISSIONS[refused];
        const why = permissions.declared(permission)
          ? 'which the user did not grant'
          : "which the app's manifest does not declare (declare the feature in native.features)";
        throw new DOMException(
          `The required feature '${refused}' needs ${permission}, ${why}.`,
          'NotSupportedError',
        );
      }
      const dropped = optional.filter(denied);
      if (dropped.length === 0) return init;
      // one line, so a page that runs without the features shows why
      const missing = [
        ...new Set(dropped.map((f) => FEATURE_PERMISSIONS[f])),
      ].map(
        (p) =>
          `${p}, ${permissions.declared(p) ? 'which the user did not grant' : "which the app's manifest does not declare"}`,
      );
      console.warn(
        `@iwer/native: optional features dropped from the '${mode}' session request: ${dropped.join(', ')} ` +
          `(need ${missing.join(', ')}).`,
      );
      return { ...o, optionalFeatures: optional.filter((f) => !denied(f)) };
    });
  }
  // A required 'depth-sensing' the headset has but cannot serve in the usage or data format the page asks for: IWER's
  // rejection does not say which feature or why, so this one does (NotSupportedError, as IWER's). Checked when the
  // request reaches IWER, after the checks IWER makes first (an active session, the mode).
  function depthRefusal(
    mode: string,
    init: object | undefined,
  ): DOMException | null {
    const support = backend.depthSensing;
    if (
      !support ||
      device.activeSession ||
      !config.supportedSessionModes.includes(mode as never)
    )
      return null;
    const o = (init ?? {}) as {
      requiredFeatures?: unknown;
      depthSensing?: {
        usagePreference?: unknown;
        dataFormatPreference?: unknown;
      };
    };
    if (
      !featureList(o.requiredFeatures).includes('depth-sensing') ||
      !(config.supportedFeatures as string[]).includes('depth-sensing') ||
      negotiateHostDepth(o.depthSensing as never, support) !== null
    )
      return null;
    const usages = featureList(o.depthSensing?.usagePreference);
    const formats = featureList(o.depthSensing?.dataFormatPreference);
    const asked: string[] = [];
    if (
      usages.length &&
      !usages.some((u) => support.usages.includes(u as never))
    )
      asked.push(`usagePreference [${usages.join(', ')}]`);
    if (
      formats.length &&
      !formats.some((f) => support.dataFormats.includes(f as never))
    )
      asked.push(`dataFormatPreference [${formats.join(', ')}]`);
    return new DOMException(
      `The required feature 'depth-sensing' cannot be served with ${asked.length ? asked.join(' and ') : 'the depthSensing preferences given'}: this headset offers ` +
        `usage ${support.usages.join(', ')} and data format${support.dataFormats.length > 1 ? 's' : ''} ${support.dataFormats.join(', ')}.`,
      'NotSupportedError',
    );
  }
  function reach(
    mode: string,
    init: object | undefined,
    call: (init: object | undefined) => Promise<object>,
  ): Promise<object> {
    const refusal = depthRefusal(mode, init);
    return refusal ? Promise.reject(refusal) : call(init);
  }
  // Session requests reach IWER in the order they were made, as in a browser (a later immersive request is refused
  // while an earlier one is pending): a request waiting for the permission dialog holds back those made after it,
  // which ask for their own permissions only once it has reached IWER. Without one waiting, a request goes to IWER
  // at once.
  let waiting: Promise<void> | null = null;
  function inOrder(
    mode: string,
    init: object | undefined,
    call: (init: object | undefined) => Promise<object>,
  ): Promise<object> {
    let valid: object | undefined;
    try {
      valid = forMode(mode, init);
    } catch (error) {
      return Promise.reject(error);
    }
    const before = waiting;
    const asking = before ? null : withPermissions(mode, valid);
    if (!before && !asking) return reach(mode, valid, call);
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    waiting = gate;
    void gate.then(() => {
      if (waiting === gate) waiting = null;
    });
    const ready = before
      ? before.then(() => withPermissions(mode, valid) ?? valid)
      : asking!;
    return ready.then(
      (i) => {
        reached();
        return reach(mode, i, call);
      },
      (error: unknown) => {
        reached();
        throw error;
      },
    );
  }

  const proto = XRSystem.prototype as unknown as Record<string, unknown>;
  const requestSession = proto.requestSession as (
    this: XRSystem,
    mode: string,
    init?: object,
  ) => Promise<object>;
  const offerSession = proto.offerSession as (
    this: XRSystem,
    mode: string,
    init?: object,
  ) => Promise<object>;
  const isSessionSupported = proto.isSessionSupported as (
    this: XRSystem,
    mode: string,
  ) => Promise<boolean>;
  Object.defineProperty(proto, 'isSessionSupported', {
    configurable: true,
    writable: true,
    value: function isSessionSupportedNative(this: XRSystem, mode: string) {
      capabilities();
      return isSessionSupported.call(this, mode);
    },
  });
  // IWER grants an offer (auto-grant, grantSession(), a test driver) through the public requestSession(). That call is
  // the offer's own: the offer has been through the mode, permission and depth checks and is tracked and logged as
  // offerSession() already, so it goes straight to IWER (no second permission pass, no second "was rejected" line).
  let granting = 0;
  const grantOfferedSession = device.grantOfferedSession.bind(device);
  Object.defineProperty(device, 'grantOfferedSession', {
    configurable: true,
    writable: true,
    value: function grantOfferedSessionNative(): void {
      granting++;
      try {
        grantOfferedSession();
      } finally {
        granting--;
      }
    },
  });
  Object.defineProperty(proto, 'requestSession', {
    configurable: true,
    writable: true,
    value: function requestSessionNative(
      this: XRSystem,
      mode: string,
      init?: object,
    ) {
      capabilities();
      if (granting > 0) {
        const granted = requestSession.call(this, mode, init);
        granted.then(
          (s) => onSession(s, String(mode)),
          () => {},
        );
        return granted;
      }
      const p = inOrder(String(mode), init, (i) =>
        requestSession.call(this, mode, i),
      );
      trackRequest(p, 'requestSession', String(mode), init);
      p.then(
        (s) => onSession(s, String(mode)),
        () => {},
      );
      return p;
    },
  });
  Object.defineProperty(proto, 'offerSession', {
    configurable: true,
    writable: true,
    value: function offerSessionNative(
      this: XRSystem,
      mode: string,
      init?: object,
    ) {
      capabilities();
      const p = inOrder(String(mode), init, (i) =>
        offerSession.call(this, mode, i),
      );
      trackRequest(p, 'offerSession', String(mode), init);
      return p;
    },
  });

  // The page's GL context reaches the backend through the layer classes (XR-SC-2/3).
  const wrapLayerClass = (name: string) => {
    const Base = g[name] as Ctor | undefined;
    if (typeof Base !== 'function') return;
    const Wrapped = {
      [name]: class extends (Base as new (
        session: object,
        context: GLContext,
        init?: object,
      ) => object) {
        constructor(session: object, context: GLContext, init?: object) {
          if (context && typeof context === 'object') gfx.noteContext(context);
          super(session, context, init);
        }
      },
    }[name];
    Object.defineProperty(g, name, {
      value: Wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  wrapLayerClass('XRWebGLBinding');
  wrapLayerClass('XRWebGLLayer');

  // Anchors (XR-ANCHOR-1) are IWER host mode's, over the backend's anchor hooks: without the 'anchors' feature (the
  // headset has no spatial anchors, or the page did not ask) IWER rejects the calls with NotSupportedError.

  // window `load`: the entry module has been evaluated (XR-LIFE-7's clock starts).
  const addEventListener = g.addEventListener as
    | ((t: string, l: () => void, o?: object) => void)
    | undefined;
  if (typeof addEventListener === 'function') {
    addEventListener.call(g, 'load', () => natives.entryEvaluated(), {
      once: true,
    });
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
        device.dispatchHostEvent({
          type: 'visibilitychange',
          visible: e.visible,
          focused: e.focused,
        });
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
    backend.anchors.poll(); // anchor requests the XR thread finished (their promises settle in IWER's next frame)
    if (kind === FRAME_XR) {
      frames++;
      const frame = record.refresh();
      record.copyInput(input.left, input.right);
      layerBuffer?.beginFrame();
      gfx.beginFrame(frame.colorTexture);
      if (device.activeSession) {
        device.runHostFrame(frame); // session callbacks, then window rAF (backend.runWindowFrame)
      } else {
        windowFrame(); // the session ended in JS before the native side heard of it
      }
      // a frame that drew only layers is fenced too
      gfx.endFrame(frame.colorTexture !== 0 || gfx.layerCount > 0);
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
      layerSwapchains: gfx.layerCount,
      layerEntries: layerBuffer?.lastCount ?? 0,
      clears: gfx.clears,
    }),
    gl: () => gfx.gl,
    requestPermissions: (names) => permissions.request(names),
    scene: () => ({
      ...(natives.sceneStatus?.() ?? { phase: 'unavailable' }),
      adapter: { ...scene.summary(), listedFrames: scene.listedFrames },
    }),
    anchorStats: () => natives.anchorStats?.() ?? null,
    depth: () => backend.depthRecord?.state() ?? null,
  };
  Object.defineProperty(g, '__iwnXR', {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return api;
}
