/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Who provides a web API in `@iwer/native`, and what the spec says about it.
 *
 * Two inputs decide a row: the rule table below (the area that owns the API,
 * the spec requirement IDs, and the spec's policy: provide / later / absent /
 * inert / declared), and a measured inventory (inventory.ts: what the built layers
 * install today; iwer-inventory: what IWER host mode implements). The result
 * is a status per API key from the tracer (tracer.ts) or the static scan.
 */

import type { Inventory } from './inventory.ts';

/** Areas of the runtime (the user-visible label of the layer that provides an API). */
export const AREAS = {
  v8: 'V8 built-in',
  core: 'runtime/core',
  glue: 'web/glue',
  webgl: 'web/webgl + runtime/gl',
  canvas2d: 'web/canvas2d + runtime/canvas2d',
  image: 'web/image + runtime/image',
  net: 'web/net + runtime/net',
  storage: 'web/storage + runtime/storage',
  audio: 'web/audio + runtime/audio',
  workers: 'web/workers + runtime/workers',
  xr: 'web/xr + runtime/xr',
  dom: 'DOM stand-ins (no module yet)',
  input: 'input (IWER host input)',
  iwer: 'IWER host mode',
  none: 'nobody (absent by design, or not in the spec)',
} as const;
export type Area = keyof typeof AREAS;

/** What the spec wants for an API. */
export type Policy =
  /** MUST/SHOULD: the runtime provides it. */
  | 'provide'
  /** Specified for after the first release (MAY/later). */
  | 'later'
  /** Deliberately absent (feature detection must see `undefined`). */
  | 'absent'
  /** Accepted but never fires/does nothing (no 2D panel, no keyboard). */
  | 'inert'
  /** Provided for an app that declares the rule's `feature` (getUserMedia: camera, XR-CAM-1), else absent. */
  | 'declared';

export type Status =
  /** In V8's own context (ECMAScript, Intl, WebAssembly). */
  | 'v8'
  /** Measured in a built runtime layer today. */
  | 'provided'
  /** Found on a related interface or only partly (e.g. on one element type). */
  | 'partial'
  /** Named in a module's source, which has no built bundle yet. */
  | 'in-source'
  /** Implemented by IWER host mode. */
  | 'iwer'
  /** Needs a config entry (network allowlist) to work. */
  | 'config'
  /** Accepted but inert on device (events that never fire). */
  | 'inert'
  /** Absent by design and only probed: feature detection takes the fallback. */
  | 'absent-ok'
  /** In the spec, not provided yet: a gap for the owning stream. */
  | 'gap'
  /** Specified for later (AR, depth, quad/cylinder layers pending). */
  | 'later'
  /** Absent by design but the app calls it, or not in the spec: unsupported. */
  | 'unsupported';

export const STATUS_ORDER: Status[] = ['unsupported', 'gap', 'later', 'config', 'partial', 'in-source', 'inert', 'absent-ok', 'iwer', 'provided', 'v8'];

/** Statuses that block a native build (checker: error) or deserve attention (warn). */
export const BLOCKING: ReadonlySet<Status> = new Set(['unsupported']);
export const WARNING: ReadonlySet<Status> = new Set(['gap', 'later', 'config', 'partial', 'in-source']);

export interface Rule {
  re: RegExp;
  area: Area;
  spec: string[];
  policy: Policy;
  note?: string;
  /** policy 'declared': the packer feature (native.features) that turns the API on. */
  feature?: string;
  /** policy 'absent': a layer defines the member for another use, and this use fails (NotSupportedError). */
  throws?: boolean;
}

/** What the app declares, as the packer resolves it (native.features, or derived from the config and the dist). */
export interface ResolveContext {
  declared?: ReadonlySet<string>;
}

/** A rule's policy for this app: a 'declared' API is absent for an app that does not declare its feature. */
export function policyFor(rule: Rule | undefined, ctx: ResolveContext = {}): Policy | undefined {
  if (rule?.policy !== 'declared') return rule?.policy;
  return rule.feature && ctx.declared?.has(rule.feature) ? 'provide' : 'absent';
}

const CAMERA_DECLARE = 'declare the camera (native.features.camera, or IWSDK\'s world.features.camera; a bundle that is not IWSDK and calls getUserMedia gets it from pack)';

const PASSTHROUGH_DECLARE = 'declare passthrough (native.features.passthrough, or IWSDK\'s world.xr.mode "ar", from which pack derives it)';

/**
 * Rules match the normalised base of a key (see parseKey): `Iface.member`,
 * a global name, `on:<Iface>.<type>`, `ext:<name>`, `feature:<name>`,
 * `probe:<name>`. First match wins.
 */
const SUBTLE_NOTE = 'crypto.subtle is absent in this alpha (NET-STORE-4): feature-detect it, or bundle a JS implementation of the digest you need';

export const RULES: Rule[] = [
  // --- deliberately absent or out of scope (DOM-4, DOM-6, DOM-10, XR-SEC-1, the developer page) ---
  { re: /^(Navigator\.gpu|GPU\w*|navigator\.gpu|getContext:webgpu)\b/, area: 'none', spec: ['DOM-4'], policy: 'absent', note: 'no WebGPU' },
  { re: /^(VideoFrame|VideoDecoder|VideoEncoder|AudioDecoder|AudioEncoder|ImageDecoder|EncodedVideoChunk|EncodedAudioChunk|VideoColorSpace)\b/, area: 'none', spec: ['DOM-11'], policy: 'absent', note: 'no WebCodecs (three probes VideoFrame)' },
  // XR-CAM-1, DOM-4, DOM-6: getUserMedia({ video }) over the passthrough cameras and a <video> that plays the stream,
  // installed by web/xr and web/dom only for an app that declares the camera (else absent, XR-SEC-1)
  { re: /^(MediaDevices\.getDisplayMedia)\b/, area: 'none', spec: ['DOM-4'], policy: 'absent', note: 'no screen capture' },
  { re: /^(Navigator\.mediaDevices|MediaDevices|MediaStream|MediaStreamTrack|MediaDeviceInfo|InputDeviceInfo|getUserMedia)\b/, area: 'xr', spec: ['XR-CAM-1', 'DOM-4', 'XR-SEC-1'], policy: 'declared', feature: 'camera', note: 'video from the passthrough cameras (no microphone); CAMERA and HEADSET_CAMERA are asked for on first use' },
  { re: /^(HTMLVideoElement|HTMLMediaElement)\.(srcObject|play|pause|requestVideoFrameCallback|cancelVideoFrameCallback)$|^requestVideoFrameCallback$/, area: 'dom', spec: ['DOM-6', 'XR-CAM-1'], policy: 'declared', feature: 'camera', note: 'a <video> plays a camera MediaStream (srcObject) only; other media does not play (play() rejects with NotSupportedError)' },
  // DOM-6: <video>/<audio> elements are inert stand-ins (canPlayType('') , play() rejects); playback itself is absent
  { re: /^(HTMLVideoElement|HTMLAudioElement|HTMLMediaElement)\.(play|load|src|srcObject|requestVideoFrameCallback|captureStream|mozCaptureStream|fastSeek|setMediaKeys|setSinkId|addTextTrack)$|^(MediaSource|ManagedMediaSource|SourceBuffer\w*|requestVideoFrameCallback|TextTrack\w*|VideoPlaybackQuality)\b/, area: 'dom', spec: ['DOM-6'], policy: 'absent', throws: true, note: 'no <video>/<audio> playback of media files: play() rejects with NotSupportedError (a <video> plays only a camera stream, XR-CAM-1)' },
  { re: /^(HTMLVideoElement|HTMLAudioElement|HTMLMediaElement|Audio)\b/, area: 'dom', spec: ['DOM-6'], policy: 'inert', note: 'inert <video>/<audio> stand-in: canPlayType() returns \'\', nothing ever plays' },
  { re: /^(MediaStream\w*|MediaRecorder|getUserMedia|RTC\w*|ImageCapture|MediaElementAudioSourceNode|MediaStreamAudio\w*|BaseAudioContext\.createMediaElementSource|BaseAudioContext\.createMediaStream\w*|AudioContext\.createMediaElementSource|AudioContext\.createMediaStream\w*)\b/, area: 'none', spec: ['DOM-4', 'XR-SEC-1'], policy: 'absent', note: 'no microphone, recording or WebRTC (camera video: getUserMedia for an app that declares the camera)' },
  { re: /^(caches|CacheStorage|Cache)\b/, area: 'storage', spec: ['NET-STORE-3'], policy: 'absent', note: 'the Cache API is absent in this alpha' },
  { re: /^(Navigator\.serviceWorker|ServiceWorker\w*|Notification|PushManager|Navigator\.clipboard|Clipboard\w*|Navigator\.wakeLock|WakeLock\w*|Navigator\.share|Navigator\.canShare|Navigator\.mediaCapabilities|Navigator\.bluetooth|Navigator\.usb|Navigator\.hid|Navigator\.serial|Navigator\.requestMIDIAccess|Navigator\.credentials|Navigator\.geolocation|Geolocation\w*|PaymentRequest|SpeechSynthesis\w*|speechSynthesis|SpeechRecognition|webkitSpeechRecognition|EventSource|WebTransport|SharedWorker|Navigator\.userAgentData|NavigatorUAData)\b/, area: 'none', spec: ['DOM-4', 'DOM-10', 'NET-STORE-3'], policy: 'absent' },
  // WRK-6: BroadcastChannel is optional; absent unless a built layer (web/workers) defines it (then the surface wins)
  { re: /^BroadcastChannel\b/, area: 'workers', spec: ['WRK-6'], policy: 'absent', note: 'optional in WRK-6; absent unless web/workers provides it' },
  // NET-STORE-4: crypto.subtle is off by default; glue ships a digest-only SubtleCrypto as an opt-in prelude
  { re: /^(Crypto\.subtle|crypto\.subtle|SubtleCrypto|CryptoKey)\b/, area: 'glue', spec: ['NET-STORE-4'], policy: 'absent', note: SUBTLE_NOTE },
  { re: /^(indexedDB|IDB\w*)\b/, area: 'storage', spec: ['NET-STORE-3'], policy: 'absent', note: 'IndexedDB is absent in this alpha; use localStorage' },
  // alpha scope (2026-10-20): WebSocket is out of scope; web/net installs it only over an opted-in native transport the
  // packed runtime config never enables, so on the headset `typeof WebSocket === 'undefined'`
  { re: /^(WebSocket|CloseEvent)\b/, area: 'net', spec: [], policy: 'absent', note: 'WebSocket is not supported in this alpha (absent: `typeof WebSocket === "undefined"`)' },
  { re: /^(Navigator\.vibrate|Navigator\.sendBeacon|Navigator\.permissions|Permissions|PermissionStatus|Navigator\.storage|StorageManager)\b/, area: 'glue', spec: ['DOM-4'], policy: 'provide' },
  // --- WebXR: IWER host mode ---
  { re: /^feature:(local|local-floor|viewer|bounded-floor|unbounded|hand-tracking|layers)$/, area: 'iwer', spec: ['XR-LIFE-1', 'XR-SPACE-1', 'IN-5', 'XR-SC-1'], policy: 'provide' },
  // XR-AR-2: planes, meshes and hit test from the headset's scene model (Space Setup), after the USE_SCENE prompt
  { re: /^feature:(plane-detection|mesh-detection|hit-test)$/, area: 'iwer', spec: ['XR-AR-2', 'XR-PERM-1'], policy: 'provide' },
  // XR-ANCHOR-1: anchors (and persistent ones) over the headset's spatial anchors
  { re: /^feature:anchors$/, area: 'iwer', spec: ['XR-ANCHOR-1'], policy: 'provide' },
  // XR-DEPTH-2: gpu-optimized depth over the headset's environment depth, after the USE_SCENE prompt
  { re: /^feature:depth-sensing$/, area: 'iwer', spec: ['XR-DEPTH-2', 'XR-PERM-1'], policy: 'provide', note: 'gpu-optimized depth (the headset offers no cpu-optimized depth)' },
  { re: /^feature:(light-estimation|camera-access|dom-overlay|secondary-views)$/, area: 'iwer', spec: ['XR-AR-1', 'XR-SEC-1'], policy: 'later' },
  { re: /^feature:(eye-tracking|gaze-tracking)$/, area: 'iwer', spec: ['XRF-P-4'], policy: 'later', note: 'no gaze source while host input is on (open IWER decision)' },
  { re: /^feature:/, area: 'iwer', spec: ['XR-LIFE-1'], policy: 'later' },
  { re: /^XRSystem\.(requestSession|offerSession|isSessionSupported)/, area: 'iwer', spec: ['XR-INIT-3', 'XR-LIFE-1', 'XR-LIFE-2'], policy: 'provide' },
  // XR-LAYER-1: quad and cylinder layers in IWER host mode, one OpenXR swapchain and composition layer each
  { re: /^(XRCompositionLayer|XRQuadLayer|XRCylinderLayer|XRWebGLBinding\.(create(Quad|Cylinder)Layer|getSubImage)|XRWebGLSubImage)\b/, area: 'iwer', spec: ['XR-LAYER-1'], policy: 'provide' },
  { re: /^(XREquirectLayer|XRCubeLayer|XRWebGLBinding\.create(Equirect|Cube)Layer|XRMediaBinding)\b/, area: 'iwer', spec: ['XR-LAYER-1'], policy: 'later', note: 'equirect and cube layers and XRMediaBinding are not in IWER host mode (quad and cylinder layers are)' },
  { re: /^(XRAnchor\w*|XRHitTestResult\.createAnchor|XRFrame\.(trackedAnchors|createAnchor)|XRSession\.(persistentAnchors|restorePersistentAnchor|deletePersistentAnchor))\b/, area: 'iwer', spec: ['XR-ANCHOR-1'], policy: 'provide' },
  { re: /^(XRPlane\w*|XRMesh\w*|XRHitTest\w*|XRTransientInput\w*|XRRay|XRFrame\.(detectedPlanes|detectedMeshes|getHitTestResults\w*)|XRSession\.requestHitTestSource\w*)\b/, area: 'iwer', spec: ['XR-AR-2'], policy: 'provide' },
  { re: /^(XRWebGLDepthInformation|XRDepthInformation|XRWebGLBinding\.getDepthInformation)\b/, area: 'iwer', spec: ['XR-DEPTH-2'], policy: 'provide' },
  { re: /^(XRCPUDepthInformation|XRFrame\.getDepthInformation)\b/, area: 'iwer', spec: ['XR-DEPTH-2'], policy: 'later', note: 'cpu-optimized depth: later (the headset offers gpu-optimized depth, XRWebGLBinding.getDepthInformation)' },
  { re: /^(XRSession\.initiateRoomCapture|XRLight\w*|XRCamera|XRDOMOverlayState)\b/, area: 'iwer', spec: ['XR-AR-1'], policy: 'later', note: 'light estimation, raw camera access, DOM overlay and room capture: later' },
  { re: /^(XR\w*(\.\w+)?|Navigator\.xr|on:XR\w*\.\w+)$/, area: 'iwer', spec: ['XRF-*', 'XR-*'], policy: 'provide' },
  { re: /^Navigator\.getGamepads$/, area: 'input', spec: ['IN-9'], policy: 'provide', note: 'returns an empty list (XR gamepads come through XRInputSource)' },
  { re: /^Gamepad\w*/, area: 'input', spec: ['IN-1', 'IN-2'], policy: 'provide', note: 'XR gamepads come from IWER host mode (XRInputSource.gamepad)' },
  // --- event loop and console (runtime/core) ---
  { re: /^console\./, area: 'core', spec: ['CON-1'], policy: 'provide' },
  { re: /^(setTimeout|setInterval|clearTimeout|clearInterval|queueMicrotask|requestAnimationFrame|cancelAnimationFrame|requestIdleCallback|cancelIdleCallback|structuredClone|reportError)$/, area: 'core', spec: ['TMR-1', 'TMR-3', 'TMR-5', 'DOM-12'], policy: 'provide' },
  { re: /^(performance|Performance\w*)\b/, area: 'glue', spec: ['TMR-4'], policy: 'provide' },
  // --- WebGL ---
  { re: /^(WebGL2?RenderingContext|WebGL\w+|ext:\w+|on:HTMLCanvasElement\.webglcontext\w+|getContext:(webgl|webgl2|experimental-webgl))\b/, area: 'webgl', spec: ['GL-*', 'C2D-2'], policy: 'provide' },
  { re: /^getContext:2d$/, area: 'canvas2d', spec: ['C2D-1'], policy: 'provide' },
  { re: /^getContext:/, area: 'none', spec: ['C2D-1'], policy: 'absent', note: 'only "2d", "webgl" and "webgl2" contexts' },
  // --- Canvas 2D ---
  { re: /^(CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|OffscreenCanvas|Path2D|CanvasGradient|CanvasPattern|TextMetrics|ImageData|FontFace|FontFaceSet|fonts|Document\.fonts)\b/, area: 'canvas2d', spec: ['C2D-*', 'IMG-5'], policy: 'provide' },
  { re: /^HTMLCanvasElement\b/, area: 'canvas2d', spec: ['C2D-1', 'DOM-8'], policy: 'provide' },
  // --- images ---
  { re: /^(Image|HTMLImageElement|ImageBitmap|createImageBitmap|on:HTMLImageElement\.\w+)\b/, area: 'image', spec: ['IMG-*'], policy: 'provide' },
  // --- network ---
  { re: /^(fetch|Request|Response|Headers|XMLHttpRequest\w*|ReadableStream\w*|WritableStream\w*|TransformStream\w*|ByteLengthQueuingStrategy|CountQueuingStrategy|FormData)\b/, area: 'net', spec: ['NET-9', 'NET-11', 'NET-5'], policy: 'provide' },
  // --- storage ---
  { re: /^(localStorage|sessionStorage|Storage|StorageEvent)\b/, area: 'storage', spec: ['NET-STORE-1'], policy: 'provide' },
  // --- audio ---
  // AUD-6: AudioWorklet is absent (documented); ScriptProcessorNode (deprecated in Web Audio) is in neither the MUST nor the SHOULD list
  { re: /^(AudioWorklet\w*|BaseAudioContext\.audioWorklet|AudioContext\.audioWorklet)\b/, area: 'audio', spec: ['AUD-6'], policy: 'absent', note: 'AudioWorklet is absent by design' },
  { re: /^(ScriptProcessorNode|AudioProcessingEvent|BaseAudioContext\.createScriptProcessor|AudioContext\.createScriptProcessor)\b/, area: 'audio', spec: ['AUD-6'], policy: 'absent', note: 'ScriptProcessorNode (deprecated in Web Audio) is not in AUD-6\'s node lists' },
  { re: /^(AudioContext|BaseAudioContext|OfflineAudioContext|AudioNode|AudioParam|AudioParamMap|GainNode|PannerNode|AudioListener|AudioBuffer|AudioBufferSourceNode|OscillatorNode|BiquadFilterNode|ConvolverNode|DelayNode|DynamicsCompressorNode|StereoPannerNode|AnalyserNode|ChannelMergerNode|ChannelSplitterNode|ConstantSourceNode|WaveShaperNode|IIRFilterNode|AudioScheduledSourceNode|AudioDestinationNode|PeriodicWave|OfflineAudioCompletionEvent|AudioProcessingEvent|webkitAudioContext|decodeAudioData)\b/, area: 'audio', spec: ['AUD-*'], policy: 'provide' },
  // the page global's own postMessage (DOM-3: to self) and close(): a main-thread call keeps its Window. prefix
  // (matrix.ts scopedKey), so it never resolves to the worker scope's members web/workers defines
  { re: /^Window\.(postMessage|close)$/, area: 'glue', spec: ['DOM-3'], policy: 'provide', note: 'the page global\'s postMessage/close (not the worker scope\'s, which web/workers provides): no layer installs it on the main thread, so the call throws on the headset' },
  // --- workers ---
  { re: /^(Worker|MessageChannel|MessagePort|importScripts|postMessage|onmessage|onmessageerror|close|WorkerLocation|WorkerNavigator|WorkerGlobalScope|DedicatedWorkerGlobalScope|on:Worker\.\w+|on:MessagePort\.\w+)\b/, area: 'workers', spec: ['WRK-*'], policy: 'provide' },
  // --- the non-DOM web platform glue ---
  { re: /^(URL|URLSearchParams|Blob|File|FileReader|TextEncoder|TextDecoder|TextEncoderStream|TextDecoderStream|atob|btoa|AbortController|AbortSignal|DOMException|Event|CustomEvent|EventTarget|MessageEvent|ProgressEvent|ErrorEvent|PromiseRejectionEvent|PopStateEvent|HashChangeEvent|crypto|Crypto|SubtleCrypto|CryptoKey|navigator|Navigator|location|Location|history|History|matchMedia|MediaQueryList\w*|devicePixelRatio|origin|isSecureContext|crossOriginIsolated|name|self|window)\b/, area: 'glue', spec: ['DOM-1', 'DOM-2', 'DOM-3', 'DOM-4', 'DOM-5', 'NET-13', 'NET-14', 'NET-16', 'NET-STORE-4'], policy: 'provide' },
  { re: /^(innerWidth|innerHeight|outerWidth|outerHeight|screen|Screen\w*|visualViewport|VisualViewport|scrollX|scrollY|pageXOffset|pageYOffset|scrollTo|scroll|getComputedStyle|focus|blur|alert|confirm|prompt|open|addEventListener|removeEventListener|dispatchEvent|getSelection|frameElement|top|parent|opener|closed|length|status|screenX|screenY|screenLeft|screenTop)$/, area: 'glue', spec: ['DOM-3'], policy: 'provide' },
  { re: /^on\w+$/, area: 'glue', spec: ['DOM-2'], policy: 'provide' },
  // --- input-ish DOM events: accepted, never fire (no 2D panel, IN-8 withdrawn; no hardware keyboard events) ---
  { re: /^on:\w+\.(pointer\w+|mouse\w+|click|dblclick|contextmenu|wheel|touch\w+|key\w+|gotpointercapture|lostpointercapture|drag\w*|drop|focus|blur|focusin|focusout|input|change|paste|copy|cut|resize|scroll|orientationchange|deviceorientation|devicemotion|beforeunload|unload|pagehide|pageshow)$/, area: 'dom', spec: ['DOM-2', 'DOM-3', 'IN-8'], policy: 'inert', note: 'listeners accepted; no 2D panel or keyboard, so these never fire' },
  { re: /^on:(HTML\w*|Document|HTMLDocument|SVG\w*|Element|Node|Text)\.[\w-]+$/, area: 'dom', spec: ['DOM-2', 'DOM-6'], policy: 'provide' },
  { re: /^on:\w+\.[\w-]+$/, area: 'glue', spec: ['DOM-2'], policy: 'provide' },
  // --- DOM stand-ins (DOM-6..10) ---
  { re: /^(Document|HTMLDocument|document|Node|Element|HTMLElement|HTML\w*Element|SVG\w*|NodeList|HTMLCollection|DOMTokenList|DOMStringMap|NamedNodeMap|Attr|CSSStyleDeclaration|CSS|CSSStyleSheet|StyleSheet\w*|DOMParser|XMLSerializer|MutationObserver|MutationRecord|ResizeObserver\w*|IntersectionObserver\w*|DOMRect\w*|DOMMatrix\w*|DOMPoint\w*|DOMQuad|Text|Comment|DocumentFragment|CharacterData|ShadowRoot|Range|Selection|TreeWalker|NodeFilter|customElements|CustomElementRegistry|UIEvent|MouseEvent|PointerEvent|WheelEvent|KeyboardEvent|FocusEvent|InputEvent|TouchEvent|Touch|TouchList|DragEvent|CompositionEvent|getComputedStyle)\b/, area: 'dom', spec: ['DOM-2', 'DOM-6', 'DOM-7', 'DOM-8', 'DOM-9', 'DOM-10'], policy: 'provide' },
  // --- ECMAScript-adjacent ---
  { re: /^(Intl|WebAssembly)\.(compileStreaming|instantiateStreaming)\b/, area: 'net', spec: ['NET-10'], policy: 'provide', note: 'needs the embedder streaming hook' },
  { re: /^Intl\.Segmenter\b/, area: 'v8', spec: ['JS-6'], policy: 'provide', note: 'V8 with Intl; a no-Intl V8 needs the GAP-12 fallback' },
  { re: /^(Intl|WebAssembly)\b/, area: 'v8', spec: ['JS-1'], policy: 'provide' },
];

export interface ParsedKey {
  key: string;
  /** Normalised base used for rules and grouping. */
  base: string;
  kind: 'global' | 'new' | 'call' | 'get' | 'set' | 'method' | 'event' | 'probe' | 'feature' | 'extension' | 'detail';
  iface?: string;
  member?: string;
  arg?: string;
}

const GLOBAL_SCOPES = /^(Window|WorkerGlobalScope|DedicatedWorkerGlobalScope|SharedWorkerGlobalScope)\./;

/** Parse a tracer key (see tracer.ts) into a normalised form. */
export function parseKey(raw: string): ParsedKey {
  let key = raw.replace(GLOBAL_SCOPES, '');
  if (key.startsWith('miss:')) {
    const m = /^miss:(?:(\w+)\.)?([\w$-]+)/.exec(key);
    const iface = m?.[1];
    const member = m?.[2] ?? key.slice(5);
    return { key: raw, base: `probe:${iface ? `${iface}.` : ''}${member}`, kind: 'probe', iface, member };
  }
  if (key.startsWith('on:')) {
    const m = /^on:(\w+)\.(.+)$/.exec(key);
    return { key: raw, base: `on:${m?.[1] ?? '?'}.${m?.[2] ?? '?'}`, kind: 'event', iface: m?.[1], member: m?.[2] };
  }
  let m = /^XR feature (\S+)/.exec(key);
  if (m) return { key: raw, base: `feature:${m[1]}`, kind: 'feature', arg: m[1] };
  m = /^WebGL\.getExtension\("([^"]*)"\)/.exec(key);
  if (m) return { key: raw, base: `ext:${m[1]}`, kind: 'extension', arg: m[1] };
  m = /^(HTMLCanvasElement|OffscreenCanvas)\.getContext\("([^"]*)"\)/.exec(key);
  if (m) return { key: raw, base: `getContext:${m[2]}`, kind: 'detail', iface: m[1], member: 'getContext', arg: m[2] };
  m = /^new (\S+?)(\((.*)\))?$/.exec(key);
  if (m) return { key: raw, base: m[1]!, kind: m[2] ? 'detail' : 'new', iface: m[1], arg: m[3] };
  m = /^ext:([\w]+)\.(\w+)/.exec(key);
  if (m) return { key: raw, base: `ext:${m[1]}`, kind: 'method', iface: `ext:${m[1]}`, member: m[2] };
  // Iface.member(...) / Iface.member= / Iface.member / Iface.member("arg")
  m = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\.([\w$]+)(\(\)|=|\((.*)\)|=\((.*)\)|="(.*)")?( -> null)?$/.exec(key);
  if (m && /^[A-Z]|^(console|Intl|WebAssembly|CSS|navigator|document|indexedDB|caches)$/.test(m[1]!.split('.')[0]!)) {
    const suffix = m[3] ?? '';
    const kind = suffix === '()' ? 'method' : suffix === '=' ? 'set' : suffix === '' ? 'get' : 'detail';
    return { key: raw, base: `${m[1]}.${m[2]}`, kind, iface: m[1], member: m[2], arg: unquote(m[4] ?? m[5] ?? m[6]) };
  }
  m = /^([a-zA-Z_$][\w$]*)(\(\)|=|\((.*)\))?$/.exec(key);
  if (m) {
    const s = m[2] ?? '';
    const kind = s === '()' ? 'call' : s === '=' ? 'set' : s === '' ? 'global' : 'detail';
    return { key: raw, base: m[1]!, kind, arg: m[3] };
  }
  m = /^(\w+)\((.*)\)$/.exec(key);
  if (m) return { key: raw, base: m[1]!, kind: 'detail', arg: m[2] };
  return { key: raw, base: key, kind: 'global' };
}

function unquote(s: string | undefined): string | undefined {
  return s === undefined ? s : s.replace(/^"(.*)"$/, '$1');
}

export function ruleFor(base: string): Rule | undefined {
  return RULES.find((r) => r.re.test(base));
}

/** The measured side: inventory (runtime layers) + IWER host-mode members. */
export interface MeasuredSurface {
  v8Globals: Set<string>;
  v8Members: Set<string>;
  /** global -> layer */
  globals: Map<string, string>;
  /** Iface.member -> layer */
  members: Map<string, string>;
  /** member name -> [Iface.member, layer][] (for partial matches) */
  byMember: Map<string, Array<[string, string]>>;
  /** source-only layers: token -> layer */
  tokens: Map<string, string>;
  /** extension-like names found in built layers' code: name -> layer */
  extNames: Map<string, string>;
  /** IWER host mode: class names and Class.member names */
  iwer: Set<string>;
  /** `<layer>:<member>` for member names a built layer assigns as instance fields (`this.<name> =`). */
  fields: Set<string>;
  /** `Iface.member` that a built layer installs as a stub (warns "not implemented" / throws NotSupportedError). */
  stubs: Set<string>;
}

export function measuredSurface(inv: Inventory, iwer: Iterable<string>): MeasuredSurface {
  const s: MeasuredSurface = {
    v8Globals: new Set(),
    v8Members: new Set(),
    globals: new Map(),
    members: new Map(),
    byMember: new Map(),
    tokens: new Map(),
    extNames: new Map(),
    iwer: new Set(iwer),
    fields: new Set(),
    stubs: new Set(),
  };
  for (const l of inv.layers) {
    if (l.layer === 'v8') {
      for (const g of l.globals) s.v8Globals.add(g);
      for (const m of l.members) s.v8Members.add(m);
      continue;
    }
    for (const g of l.globals) if (!s.globals.has(g)) s.globals.set(g, l.layer);
    for (const m of l.members) {
      if (!s.members.has(m)) s.members.set(m, l.layer);
      const name = m.slice(m.lastIndexOf('.') + 1);
      const list = s.byMember.get(name) ?? [];
      list.push([m, l.layer]);
      s.byMember.set(name, list);
    }
    const into = l.how === 'eval' ? s.extNames : s.tokens;
    for (const t of l.tokens ?? []) if (!into.has(t)) into.set(t, l.layer);
    for (const f of l.fields ?? []) s.fields.add(`${l.layer}:${f}`);
    for (const st of l.stubs ?? []) s.stubs.add(st);
  }
  return s;
}

export interface Resolution {
  status: Status;
  area: Area;
  /** Layer that provides it (measured), e.g. 'web/glue'. */
  layer?: string;
  spec: string[];
  note?: string;
  /** The member exists but is a stub (warns or throws). */
  stub?: boolean;
}

const WINDOW_ACCESSOR_IFACES = new Set(['Window', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope']);

/** Key of a navigation to a literal cross-origin URL (`location.href = 'https://…'`): DOM-5, out of the alpha scope. */
export const CROSS_ORIGIN_NAVIGATION = 'location navigation (cross-origin)';

/** What external links and OAuth redirects do on the headset (the alpha scope, DOM-3/DOM-5). */
export const NAVIGATION_NOTE = 'external links and OAuth redirects are out of the alpha scope: on the headset a cross-origin navigation is logged and ignored (DOM-5) and window.open() returns null (DOM-3), so the app stays where it is';

/** IMG-1's decoder set (file extensions and image/* subtypes); other image formats fail to decode on the headset. */
const IMG_DECODED = new Set(['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'webp', 'gif']);
/** Image formats a browser decodes that IMG-1 does not (the extension or image/* subtype). */
const IMG_NOT_DECODED = new Set(['avif', 'svg', 'svg+xml', 'heic', 'heif', 'jxl', 'bmp', 'x-ms-bmp', 'ico', 'x-icon', 'vnd.microsoft.icon', 'tif', 'tiff', 'apng']);

/** The image format a traced image load names (`HTMLImageElement.src=(same-origin .avif)`, `createImageBitmap(Blob image/avif)`), if any. */
function imageFormatOf(p: ParsedKey): string | undefined {
  if (!p.arg) return undefined;
  if (p.base === 'HTMLImageElement.src') {
    const data = /^data:image\/([\w.+-]+)/.exec(p.arg);
    if (data) return data[1]!.toLowerCase();
    return /^same-origin \.([a-z0-9]+)$/.exec(p.arg)?.[1];
  }
  if (p.base === 'createImageBitmap') return /\bimage\/([\w.+-]+)/.exec(p.arg)?.[1]?.toLowerCase();
  return undefined;
}

/**
 * Resolve the status of a key. `appCalls` tells whether the app called/constructed
 * it (vs only reading/probing), which decides absent-ok vs unsupported.
 */
export function resolve(p: ParsedKey, surface: MeasuredSurface, ctx: ResolveContext = {}): Resolution {
  const r = resolveMeasured(p, surface, ctx);
  // the 0.1.0-alpha scope: present in a layer but not shipped as supported in the alpha,
  // so the checker warns as the README's support matrix (release/support-matrix.ts alphaLater rows) says "not yet".
  // A layer's NotSupportedError stub of such an API (web/audio's beyond-basic nodes without glue.audio.experimental)
  // is that alpha gate itself, and so is its absence (OfflineAudioContext is not installed then): both read "later"
  // too, not "partial (stub)" (an info finding that hid the call) or "gap".
  if ((r.status === 'provided' || r.status === 'partial' || r.status === 'gap') && p.kind !== 'event') {
    const later = ALPHA_LATER.find((a) => a.re.test(p.base));
    if (later) {
      const res: Resolution = { status: 'later', area: r.area, layer: r.layer, spec: r.spec, note: `${later.note}${r.note ? `; ${r.note}` : ''}` };
      if (r.stub) res.stub = true;
      return res;
    }
  }
  return r;
}

/** In a built layer, but outside the alpha's validated scope (README support matrix: "not yet"). */
const ALPHA_LATER: Array<{ re: RegExp; note: string }> = [
  {
    re: /^((Base|Offline)?AudioContext\.create(Oscillator|BiquadFilter|Convolver|Analyser|DynamicsCompressor|StereoPanner|Delay|WaveShaper|IIRFilter|ConstantSource|ChannelMerger|ChannelSplitter|PeriodicWave)|(Oscillator|BiquadFilter|Convolver|Analyser|DynamicsCompressor|StereoPanner|Delay|WaveShaper|IIRFilter|ConstantSource|ChannelMerger|ChannelSplitter)Node|PeriodicWave|OfflineAudioContext|OfflineAudioCompletionEvent)\b/,
    note: 'Web Audio beyond the basic set the alpha validates (AudioContext lifecycle, AudioBufferSource, Gain, Panner/Listener, decodeAudioData): web/audio has it, but it is not supported in this alpha yet',
  },
  {
    re: /^open$/,
    note: 'window.open, external links and OAuth redirects are out of the alpha scope: on the headset open() logs and returns null (DOM-3), so a login popup never opens; a cross-origin navigation is logged and ignored (DOM-5)',
  },
];

function resolveMeasured(p: ParsedKey, surface: MeasuredSurface, ctx: ResolveContext): Resolution {
  // a miss probe (`probe:Navigator.gpu`) of an absent-by-design API resolves by that API's rule
  // (`miss:serviceWorker (in, Navigator chain)` is an `in` test on navigator: Navigator.serviceWorker)
  const bareRule = p.kind === 'probe' ? ruleFor(/\(in, (Navigator|WorkerNavigator) chain\)/.test(p.key) && !p.iface ? `Navigator.${p.member}` : p.base.replace(/^probe:/, '')) : undefined;
  const bare = bareRule && forApp(bareRule, ctx);
  // parseKey folds the Window. prefix into the bare global; the page's own postMessage/close keep it in the key
  const page = /^Window\.(postMessage|close)\(/.exec(p.key);
  const found = (page ? ruleFor(`Window.${page[1]}`) : undefined) ?? ruleFor(p.base);
  const rule = (found && forApp(found, ctx)) ?? (bare?.policy === 'absent' ? bare : undefined);
  const area: Area = rule?.area ?? 'none';
  const spec = rule?.spec ?? [];
  const note = rule?.note;
  const probeOnly = p.kind === 'probe' || p.kind === 'global' || p.kind === 'get';
  // a declared feature's API (getUserMedia for the camera): its layer installs it only when the app declares the
  // feature, which the measured surface (made without a declaration) cannot see
  if (found?.policy === 'declared' && rule?.policy === 'provide')
    return { status: 'provided', area, layer: AREAS[area], spec, note: `the app declares the ${found.feature} feature${note ? `; ${note}` : ''}` };

  // XR-LIFE-7: the app's config never offers an immersive session (project.ts NO_XR_ENTRY)
  if (p.key.startsWith('no XR entry')) {
    return {
      status: 'later',
      area: 'core',
      spec: ['XR-LIFE-7', 'XR-IDLE-1'],
      note: `${/xr: false/.test(p.key) ? 'the app is desktop-only (world.xr = false)' : 'the app never offers a session (world.xr.offer = "none"): entering XR waits for a DOM button'}, and the headset has no 2D page to show or press. It shows black, logs the XR-LIFE-7 error at 10 s and exits to home at 30 s (draft; decision pending, spec open question 11). Offer a session (xr.offer "always" or "once")`,
    };
  }
  // details with their own semantics
  if (p.kind === 'detail' && /^fetch$|^XMLHttpRequest\.open$|^(?!HTML(Media|Video|Audio)Element\.).*\.src$/.test(p.base) && p.arg?.startsWith('cross-origin')) {
    const origin = p.arg.split(' ')[1] ?? '';
    const entry = allowEntryFor(origin);
    return { status: 'config', area: 'net', spec: ['NET-5'], note: `cross-origin: add ${entry} to native.network.allow (else blocked)${entry !== origin ? `; the runtime matches ${origin.split(':')[0]}:// URLs against the ${entry.split(':')[0]}:// origin` : ''}` };
  }
  // XR-AR-1: pack turns immersive-ar on (xr.immersiveAr, passthrough under the projection layer) for an app that
  // declares passthrough; for any other app the headset offers immersive-vr only
  const ar = !!ctx.declared?.has('passthrough');
  if (p.base === 'XRSystem.isSessionSupported' && p.arg === 'immersive-ar') {
    // asking is not needing: without passthrough it resolves false on the headset and the app's VR path runs
    if (ar) return { status: 'iwer', area: 'iwer', spec: ['XR-AR-1'], note: 'resolves true: the app declares passthrough, so pack turns immersive-ar on' };
    return { status: 'absent-ok', area: 'iwer', spec: ['XR-AR-1'], note: `isSessionSupported("immersive-ar") resolves false on the headset unless the app declares passthrough, so the app takes its non-AR path; to offer AR, ${PASSTHROUGH_DECLARE}` };
  }
  if (/^XRSystem\.(offerSession|requestSession)$/.test(p.base) && p.arg === 'immersive-ar') {
    if (ar) return { status: 'iwer', area: 'iwer', spec: ['XR-AR-1'], note: 'the app declares passthrough, so pack turns immersive-ar on (passthrough under the projection layer)' };
    return { status: 'config', area: 'iwer', spec: ['XR-AR-1'], note: `immersive-ar needs passthrough declared: ${PASSTHROUGH_DECLARE}; without it the request rejects with NotSupportedError` };
  }
  if (p.kind === 'feature' && /\(required\)/.test(p.key) && rule?.policy === 'later') {
    return { status: 'later', area: 'iwer', spec: rule.spec, note: `required feature: requestSession/offerSession reject on the headset until it lands${rule.note ? `; ${rule.note}` : ''}` };
  }
  if (/^Document\.createElement(NS)?$/.test(p.base) && p.arg && /^(video|audio)$/.test(p.arg)) {
    // DOM-6 wants the element (feature probes such as canPlayType work); playing it is what is absent
    return { status: 'inert', area: 'dom', spec: ['DOM-6'], note: `<${p.arg}> is an inert stand-in on the headset: canPlayType() returns '', play() rejects, nothing plays` };
  }
  if (p.base.startsWith('getContext:') && rule?.policy === 'absent' && p.key.endsWith('-> null')) {
    // the trace (trimmed to the headset's surface) handed the app null, as the headset does, and the app carried on
    return { status: 'absent-ok', area: rule.area, spec: rule.spec, note: `getContext("${p.arg ?? ''}") returned null in the headless run, as on the headset; the app went on without it${rule.note ? `; ${rule.note}` : ''}` };
  }
  if (p.base.startsWith('getContext:') && rule?.policy === 'absent') {
    // a context type the runtime never offers (webgpu, bitmaprenderer): getContext returns null whatever layer
    // defines the element, so asking for it is the unsupported part (not the missing element)
    return { status: probeOnly ? 'absent-ok' : 'unsupported', area: rule.area, spec: rule.spec, note: `getContext("${p.arg ?? ''}") returns null on the headset${rule.note ? `; ${rule.note}` : ''}` };
  }
  if ((p.iface ?? p.base) === 'HTMLCanvasElement' && !surface.globals.has('HTMLCanvasElement') && rule?.policy !== 'absent' && rule?.policy !== 'inert' && !surface.members.has(`HTMLCanvasElement.${p.member ?? ''}`)) {
    // the contexts exist (OffscreenCanvas), the element that hands them out does not: one owner (DOM stand-ins)
    // for every HTMLCanvasElement row, so the matrix does not split the element across streams
    const what = p.member === 'getContext' ? `canvas.getContext(${p.arg ? `"${p.arg}"` : ''}) has no element to run on${surface.members.has('OffscreenCanvas.getContext') ? '; OffscreenCanvas.getContext exists' : ''}` : p.member ? `canvas.${p.member} has no element` : 'the interface object is missing';
    return { status: probeOnly && p.kind === 'probe' ? 'absent-ok' : 'gap', area: 'dom', spec: ['DOM-8', ...(rule?.spec ?? []).filter((x) => x !== 'DOM-8')], note: `no layer defines HTMLCanvasElement, so ${what}` };
  }
  if (p.key === CROSS_ORIGIN_NAVIGATION) return { status: 'later', area: 'glue', spec: ['DOM-5', 'DOM-3'], note: NAVIGATION_NOTE };
  const img = imageFormatOf(p);
  if (img && IMG_NOT_DECODED.has(img) && !IMG_DECODED.has(img)) {
    return { status: 'unsupported', area: 'image', spec: ['IMG-1'], note: `${img.replace(/\+xml$/, '')} is not in IMG-1's decoder set (PNG, JPEG, WebP, GIF), so the image fails to load on the headset: convert it` };
  }
  if (p.base === 'decodeAudioData' && p.arg) {
    const ok = ['mp3', 'ogg', 'wav'].includes(p.arg);
    return { status: ok ? statusOfArea('audio', surface, 'AudioContext') : 'gap', area: 'audio', spec: ['AUD-8'], note: ok ? undefined : `format ${p.arg}: not in AUD-8's decoder set` };
  }
  if (p.kind === 'extension') {
    const name = p.arg ?? '';
    const spec = DEVICE_EXTENSIONS[name] ?? ['GL-23'];
    const built = surface.extNames.get(name);
    const t = surface.tokens.get(name);
    if (p.key.endsWith('-> null')) {
      // headless Chromium (SwiftShader) returned null, so the app's extension path never ran in the trace;
      // on the headset the runtime offers the extensions it names, and the app takes that path instead
      if (built) return { status: 'provided', area: 'webgl', layer: built, spec, note: 'null in headless Chromium, so the app\'s path for it was not traced; the WebGL layer names it, so the headset offers it when the driver has it (device path untested here)' };
      if (t) return { status: 'in-source', area: 'webgl', layer: t, spec, note: 'null in headless Chromium; named in the WebGL source only' };
      if (DEVICE_EXTENSIONS[name]) return { status: 'gap', area: 'webgl', spec, note: `null in headless Chromium; ${spec.join('/')} require it on the headset and no layer names it` };
      return { status: 'absent-ok', area: 'webgl', spec, note: 'not offered by headless Chromium or the runtime; the app copes with null' };
    }
    if (built) return { status: 'provided', area: 'webgl', layer: built, spec, note: 'named by the built layer; whether the device driver exposes it is decided at runtime' };
    return t ? { status: 'in-source', area: 'webgl', layer: t, spec } : { status: 'gap', area: 'webgl', spec, note: `extension ${name} not named in the WebGL layer` };
  }

  if (p.base.startsWith('ext:') && p.kind === 'method') {
    const name = p.base.slice(4);
    const built = surface.extNames.get(name);
    if (built) return { status: 'partial', area: 'webgl', layer: built, spec: ['GL-23'], note: `extension ${name} is named by the built layer; its method ${p.member} was not checked` };
    return { status: 'gap', area: 'webgl', spec: ['GL-23'], note: `extension ${name} not named in the WebGL layer` };
  }
  if (!rule) {
    return { status: probeOnly ? 'absent-ok' : 'unsupported', area: 'none', spec: [], note: 'not in the spec' };
  }
  if (rule.policy === 'absent') {
    // provided anyway? (e.g. indexedDB in web/storage)
    const m = lookup(p, surface);
    if (m && !m.partial && isStub(p, surface)) {
      // absent by design and a layer installs a throwing stub (createScriptProcessor, the DOM-6 play()): a feature
      // check sees it present, and calling it throws NotSupportedError on the headset
      return { status: probeOnly ? 'partial' : 'unsupported', area, layer: m.layer, spec, stub: true, note: `${note ? `${note}; ` : ''}${m.layer} installs it as a stub that throws NotSupportedError (or warns "not implemented"), so a feature check sees it present and calling it fails` };
    }
    // web/dom's <video> plays camera streams only: its play() exists, and fails for any other media
    if (m && rule.throws) return { status: probeOnly ? 'partial' : 'unsupported', area, layer: m.layer, spec, note: `${note ? `${note}; ` : ''}${m.layer} defines it, but here it fails (NotSupportedError)` };
    if (m) return { status: 'provided', area, layer: m.layer, spec, note: note ? `${note}; provided by ${m.layer}` : undefined };
    return { status: probeOnly ? 'absent-ok' : 'unsupported', area, spec, note };
  }
  if (rule.policy === 'inert') return { status: 'inert', area, spec, note };
  if (area === 'iwer') {
    if (p.kind === 'feature') return { status: rule.policy === 'later' ? 'later' : 'iwer', area, spec, note };
    if (p.kind === 'event') return { status: 'iwer', area, spec, note };
    const iface = p.iface ?? p.base;
    const member = p.member;
    const has = member ? surface.iwer.has(`${iface}.${member}`) : surface.iwer.has(iface);
    // AR/depth/layer members IWER's classes define are still 'later' on the headset: nothing feeds them yet
    if (rule.policy === 'later') return { status: 'later', area, spec, note: has ? `${note ? `${note}; ` : ''}IWER host mode defines it, but the headset does not back it yet` : note };
    if (has) return { status: 'iwer', area, spec, note };
    return { status: probeOnly ? 'absent-ok' : 'gap', area, spec, note: `not in IWER host mode${note ? `; ${note}` : ''}` };
  }
  if (area === 'input' && /^Gamepad/.test(p.base)) {
    const has = p.member ? surface.iwer.has(`${p.iface ?? p.base}.${p.member}`) : surface.iwer.has(p.base);
    if (has) return { status: 'iwer', area, spec, note };
  }
  if (area === 'v8') {
    const name = p.member ? `${p.iface}.${p.member}` : p.base;
    if (surface.v8Globals.has(p.base) || surface.v8Members.has(name) || surface.v8Globals.has(p.iface?.split('.')[0] ?? '')) return { status: 'v8', area, spec, note };
  }
  const m = lookup(p, surface);
  if (m && m.layer === 'v8' && EMBEDDER_HOOKED.test(p.base)) {
    // measured in Node, which installs the wasm streaming callback; a bare V8 embedding has these only when the
    // runtime calls Isolate::SetWasmStreamingCallback (NET-10)
    return { status: 'gap', area, spec, note: `in Node's V8 only because Node installs the streaming hook; runtime/core must install it${note ? `; ${note}` : ''}` };
  }
  if (m && m.layer === 'v8' && area === 'core') {
    // V8's own console object exists in every context but goes nowhere without the embedder's delegate (CON-1)
    return { status: 'gap', area, spec, note: 'only V8\'s inert built-in exists; runtime/core must install the console delegate' };
  }
  if (m) {
    const stub = !m.partial && isStub(p, surface);
    if (stub) return { status: 'partial', area, layer: m.layer, spec, stub: true, note: `a stub in ${m.layer}: it warns "not implemented" or throws NotSupportedError${note ? `; ${note}` : ''}` };
    return { status: m.partial ? 'partial' : 'provided', area, layer: m.layer, spec, note: m.partial ? `${m.as}${note ? `; ${note}` : ''}` : note };
  }
  const t = surface.tokens.get(p.member ?? p.base) && surface.tokens.get(p.iface ?? p.base);
  if (t) return { status: 'in-source', area, layer: t, spec, note };
  if (rule.policy === 'later') return { status: 'later', area, spec, note };
  const owner = p.iface && p.member ? surface.globals.get(p.iface) ?? surface.globals.get(INSTANCE_OF[p.iface] ?? '') : undefined;
  if (owner) return { status: 'gap', area, spec, note: `${p.iface} exists (${owner}) but has no ${p.member}: missing${note ? `; ${note}` : ''}` };
  return { status: 'gap', area, spec, note };
}

/** The rule as it applies to this app: a 'declared' rule is 'provide' or (with the way to declare it) 'absent'. */
function forApp(rule: Rule, ctx: ResolveContext): Rule {
  if (rule.policy !== 'declared') return rule;
  const policy = policyFor(rule, ctx)!;
  if (policy === 'provide') return { ...rule, policy };
  const how = rule.feature === 'camera' ? CAMERA_DECLARE : `declare the ${rule.feature} feature`;
  return { ...rule, policy, throws: true, note: `${rule.note ? `${rule.note}; ` : ''}absent unless the app declares the ${rule.feature}: ${how}` };
}

/** A member a built layer installs as a stub (recorded under the interface or one of its audio-context aliases). */
function isStub(p: ParsedKey, s: MeasuredSurface): boolean {
  // an interface object whose constructor throws NotSupportedError (`new DynamicsCompressorNode()`)
  if (!p.member) return s.stubs.has(p.iface ?? p.base);
  if (!p.iface) return false;
  if (s.stubs.has(`${p.iface}.${p.member}`)) return true;
  return /^(BaseAudioContext|AudioContext)$/.test(p.iface) && (s.stubs.has(`BaseAudioContext.${p.member}`) || s.stubs.has(`AudioContext.${p.member}`));
}

/**
 * The native.network.allow entry that covers an origin: the runtime (runtime/net url.h, web/net allowlist.ts)
 * matches ws:// and wss:// URLs against the http:// and https:// origin, and the config validator only accepts
 * http(s) entries.
 */
export function allowEntryFor(origin: string): string {
  return origin.replace(/^ws(s?):\/\//, 'http$1://');
}

/** V8 members that exist only when the embedder installs a hook (Node does; a bare embedding does not). */
export const EMBEDDER_HOOKED = /^WebAssembly\.(compileStreaming|instantiateStreaming)$/;

/** Extensions the device path needs that headless Chromium does not offer (GL-20, the MSAA-multiview check). */
const DEVICE_EXTENSIONS: Record<string, string[]> = {
  OCULUS_multiview: ['GL-23', 'MSAA multiview'],
  OVR_multiview2: ['GL-23', 'MSAA multiview'],
  KHR_parallel_shader_compile: ['GL-20'],
  WEBGL_multisampled_render_to_texture: ['GL-23', 'MSAA multiview'],
  EXT_multisampled_render_to_texture: ['GL-23', 'MSAA multiview'],
};

function statusOfArea(_area: Area, s: MeasuredSurface, probe: string): Status {
  if (s.globals.has(probe)) return 'provided';
  if (s.tokens.has(probe)) return 'in-source';
  return 'gap';
}

function lookup(p: ParsedKey, s: MeasuredSurface): { layer: string; partial: boolean; as?: string } | null {
  const ifaceRaw = p.iface;
  const iface = ifaceRaw && WINDOW_ACCESSOR_IFACES.has(ifaceRaw) ? undefined : ifaceRaw;
  if (p.kind === 'event') {
    // listening works where the target type exists
    const t = p.iface ?? '';
    let l = s.globals.get(t) ?? (t === 'HTMLDocument' ? s.globals.get('document') : undefined);
    // the global object itself (Window / WorkerGlobalScope): listening needs the global addEventListener
    if (!l && WINDOW_ACCESSOR_IFACES.has(t)) l = s.globals.get('addEventListener');
    // a JS subclass of EventTarget (the tracer records those as EventTarget): needs EventTarget
    if (!l && t === 'EventTarget') l = s.globals.get('EventTarget');
    return l ? { layer: l, partial: false } : null;
  }
  if (!iface || !p.member) {
    const name = p.member ?? p.base;
    const l = s.globals.get(name) ?? s.globals.get(p.base);
    if (l) return { layer: l, partial: false };
    if (s.v8Globals.has(name)) return { layer: 'v8', partial: false };
    // worker-scope globals (postMessage, close, importScripts): tracer keys drop the scope prefix, and web/workers
    // defines them on DedicatedWorkerGlobalScope/WorkerGlobalScope.prototype rather than as plain globals. A
    // main-thread key (`Window.postMessage()`) never resolves there: the page global has no such member
    if (/^Window\./.test(p.key)) return null;
    const w = s.members.get(`DedicatedWorkerGlobalScope.${name}`) ?? s.members.get(`WorkerGlobalScope.${name}`);
    if (w) return { layer: w, partial: false };
    return null;
  }
  const exact = s.members.get(`${iface}.${p.member}`);
  if (exact) return { layer: exact, partial: false };
  if (s.v8Members.has(`${iface}.${p.member}`)) return { layer: 'v8', partial: false };
  // instance globals: navigator/document/performance/crypto/location members recorded under the global name.
  // The inventory walked the instance itself (own fields and its prototype chain), so absent there is missing.
  const instance = INSTANCE_OF[iface];
  if (instance) {
    const l = s.members.get(`${instance}.${p.member}`);
    if (l) return { layer: l, partial: false };
    if (s.globals.has(instance)) return null;
  }
  // the interface exists but the member is not on its prototype: an instance field when a layer assigns
  // `this.<member> =` (WebGLActiveInfo.name, AudioListener.positionX), else missing
  const owner = s.globals.get(iface);
  if (owner) {
    // the layer that defines the interface assigns it: an instance field
    if (s.fields.has(`${owner}:${p.member}`)) return { layer: owner, partial: true, as: `an instance field of ${iface} (assigned in ${owner}; not on the prototype, so prototype feature tests miss it)` };
    return null;
  }
  // a base interface (Element, Node, HTMLElement) whose member a concrete element type has
  // (Element.removeAttribute ~ HTMLImageElement.removeAttribute): partial evidence only. A different
  // concrete interface (HTMLCanvasElement vs OffscreenCanvas) is not evidence.
  if (ifaceCore(iface) !== '') return null;
  const others = (s.byMember.get(p.member) ?? []).filter(([n]) => related(iface, n.slice(0, n.lastIndexOf('.'))));
  // an event handler attribute Chromium defines on HTMLElement (`img.onload = fn` on `new Image()` records
  // HTMLElement.onload=): a concrete element type's handler is evidence, however generic the name
  if (/^on[a-z]+$/.test(p.member) && /^(HTMLElement|Element)$/.test(iface)) {
    const el = others.find(([n]) => /^HTML\w+Element\./.test(n));
    if (el) return { layer: el[1], partial: true, as: `found as ${el[0]} (an element type's handler; Chromium defines it on HTMLElement)` };
  }
  if (others.length && !GENERIC_MEMBERS.has(p.member)) {
    const pick = others[0]!;
    return { layer: pick[1], partial: true, as: `found only as ${pick[0]} (on a concrete element type)` };
  }
  return null;
}

/** Core of an interface name: HTMLCanvasElement -> Canvas, BaseAudioContext -> AudioContext, Element -> ''. */
function ifaceCore(n: string): string {
  return n.replace(/^(HTML|SVG|Base|Offscreen|webkit|WebKit)/, '').replace(/(Element|ReadOnly|RenderingContext2D)$/, '');
}

function related(want: string, have: string): boolean {
  if (want === have) return true;
  const a = ifaceCore(want);
  const b = ifaceCore(have);
  if (!a) return /Element$/.test(have); // Element/Node/HTMLElement members found on one element type
  return a === b || (b.length > 3 && (a.includes(b) || b.includes(a)));
}

/** Interface -> the global instance whose members the inventory records. */
const INSTANCE_OF: Record<string, string> = {
  Navigator: 'navigator',
  WorkerNavigator: 'navigator',
  Document: 'document',
  HTMLDocument: 'document',
  Performance: 'performance',
  Crypto: 'crypto',
  Location: 'location',
  WorkerLocation: 'location',
  History: 'history',
  Storage: 'localStorage',
  Screen: 'screen',
};

/** Member names too common to count a match on another interface as evidence. */
const GENERIC_MEMBERS = new Set(['get', 'set', 'has', 'delete', 'add', 'clear', 'length', 'size', 'name', 'type', 'value', 'data', 'width', 'height', 'x', 'y', 'z', 'w', 'id', 'style', 'src', 'url', 'href', 'toString', 'item', 'keys', 'values', 'entries', 'forEach', 'close', 'start', 'stop', 'connect', 'disconnect', 'state', 'onload', 'onerror', 'result', 'parentNode', 'children', 'appendChild', 'removeChild', 'getAttribute', 'setAttribute', 'hasAttribute', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'nodeName', 'nodeType', 'childNodes', 'baseURI', 'complete']);

/** IWER host-mode member names from its self-contained host build. */
export async function iwerHostSurface(hostModuleFile: string): Promise<Set<string>> {
  const { pathToFileURL } = await import('node:url');
  const mod = (await import(pathToFileURL(hostModuleFile).href)) as Record<string, unknown>;
  const out = new Set<string>();
  const add = (name: string, cls: unknown) => {
    if (typeof cls !== 'function' || !/^XR/.test(name)) return;
    out.add(name);
    let p = (cls as { prototype?: object }).prototype ?? null;
    while (p && p !== Object.prototype) {
      for (const k of Reflect.ownKeys(p)) if (typeof k === 'string' && k !== 'constructor') out.add(`${name}.${k}`);
      p = Object.getPrototypeOf(p);
      if (p && (p as { constructor?: { name?: string } }).constructor?.name === 'EventTarget') {
        for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) out.add(`${name}.${k}`);
        break;
      }
    }
  };
  for (const [k, v] of Object.entries(mod)) add(k, v);
  // the Gamepad classes are not exported; reach them through a host controller's input source
  try {
    const M = mod as Record<string, any>;
    const c = new M.XRHostController({ handedness: 'right' }, new M.GlobalSpace(), ['generic'], { mapping: 'xr-standard', buttons: [{ id: 'trigger', type: 'analog' }], axes: [{ id: 'thumbstick', type: 'x' }] }, 1, () => {});
    const gp = c.inputSource?.gamepad;
    for (const [name, o] of [['Gamepad', gp], ['GamepadButton', gp?.buttons?.[0]], ['GamepadHapticActuator', gp?.hapticActuators?.[0]]] as Array<[string, any]>) {
      if (!o) continue;
      out.add(name);
      for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(o))) if (k !== 'constructor') out.add(`${name}.${k}`);
    }
  } catch {
    /* an IWER build without XRHostController: Gamepad rows resolve against the runtime layers only */
  }
  // host mode installs XRHostWebGLBinding as the XRWebGLBinding global
  if (mod.XRHostWebGLBinding) add('XRWebGLBinding', mod.XRHostWebGLBinding);
  if (mod.XRSystem) out.add('Navigator.xr');
  return out;
}

/**
 * What the headless trace removes from Chromium before the app runs, so the page has the headset's surface
 * where it matters for feature detection: globals and `navigator` / `crypto` members that the rule table marks
 * absent by design (WebGPU, WebCodecs, media streams, BroadcastChannel, SharedWorker, clipboard, ...), unless a
 * runtime layer provides them anyway (web/storage's `caches` and `indexedDB`). `getContext` types other than
 * these return null. A guarded branch (`if (navigator.gpu)`, `typeof VideoDecoder`) then takes the headset path
 * in the trace, and an unguarded use throws there as it would on the device.
 */
export interface HeadsetTrim {
  /** Regex sources (rule bases with policy 'absent'), tested against `Name` and `Navigator.member` / `Crypto.member`. */
  absent: string[];
  /** Bases a runtime layer (or V8) provides: never removed. */
  keep: string[];
  /** Canvas context types the runtime offers. */
  contexts: string[];
  /**
   * Absent-by-design members a runtime layer installs as a throwing stub (`BaseAudioContext.createScriptProcessor`):
   * the trace replaces Chromium's working method with one that throws NotSupportedError, as on the headset.
   */
  stubs?: string[];
}

export function headsetTrim(surface: MeasuredSurface, ctx: ResolveContext = {}): HeadsetTrim {
  const keep = new Set<string>([...surface.globals.keys(), ...surface.v8Globals]);
  const stubs = new Set<string>();
  // a declared feature's API stays (Chromium's getUserMedia stands in for web/xr's), an undeclared one goes
  const absentRules = RULES.filter((r) => policyFor(r, ctx) === 'absent' && !/^\^getContext:/.test(r.re.source));
  for (const m of surface.members.keys()) {
    const k = /^(navigator|Navigator|WorkerNavigator)\.(.+)$/.exec(m);
    const c = /^(crypto|Crypto)\.(.+)$/.exec(m);
    const a = /^(BaseAudioContext|AudioContext)\.(.+)$/.exec(m);
    const base = k ? `Navigator.${k[2]}` : c ? `Crypto.${c[2]}` : a ? `BaseAudioContext.${a[2]}` : undefined;
    if (!base) continue;
    // a stub is not the API: an absent-by-design member a layer only stubs is replaced by a throwing stub in
    // the trace (stubs), never kept as Chromium's working method
    if (surface.stubs.has(m)) {
      if (absentRules.some((r) => r.re.test(base))) stubs.add(base);
      continue;
    }
    keep.add(base);
  }
  for (const s of stubs) keep.delete(s);
  return { absent: absentRules.map((r) => r.re.source), keep: [...keep].sort(), contexts: ['2d', 'webgl', 'webgl2', 'experimental-webgl'], stubs: [...stubs].sort() };
}

/**
 * The trim for a control run that leaves one removed root in place (`Navigator.gpu`, or a global such as
 * `AudioWorklet` together with the instance member that reaches it, `BaseAudioContext.audioWorklet`). A page error
 * that the trimmed run had and the control run does not is caused by removing that root.
 */
export function controlTrim(trim: HeadsetTrim, root: string, removed: Iterable<string>): HeadsetTrim {
  const extra = [root];
  if (!root.includes('.')) for (const r of removed) if (r.slice(r.indexOf('.') + 1).toLowerCase() === root.toLowerCase()) extra.push(r);
  return { ...trim, keep: [...new Set([...trim.keep, ...extra])].sort(), stubs: (trim.stubs ?? []).filter((s) => !extra.includes(s)) };
}

/** Interfaces reached only through a navigator member: the member is what feature detection looks at. */
const NAV_ROOT: Record<string, string> = {
  MediaDevices: 'mediaDevices',
  GPU: 'gpu',
  GPUAdapter: 'gpu',
  GPUDevice: 'gpu',
  Clipboard: 'clipboard',
  ServiceWorkerContainer: 'serviceWorker',
  Geolocation: 'geolocation',
  WakeLock: 'wakeLock',
  Bluetooth: 'bluetooth',
  USB: 'usb',
  HID: 'hid',
};

/**
 * The global or navigator member an API key hangs off (`new VideoDecoder` -> VideoDecoder,
 * `MediaDevices.getUserMedia()` -> navigator.mediaDevices, `Navigator.gpu.requestAdapter()` -> navigator.gpu):
 * what the trace removes and what an app's feature check tests.
 */
export function rootOf(key: string): { global?: string; nav?: string } | undefined {
  const p = parseKey(key);
  if (p.kind === 'feature' || p.kind === 'event' || p.kind === 'extension' || key.startsWith('no XR entry')) return undefined;
  const first = (p.iface ?? p.base).replace(/^probe:/, '').split('.');
  if (first[0] === 'Navigator' || first[0] === 'navigator') {
    const m = first[1] ?? p.member;
    return m ? { nav: m } : undefined;
  }
  const head = first[0]!;
  if (NAV_ROOT[head]) return { nav: NAV_ROOT[head] };
  // crypto.subtle (absent by default, NET-STORE-4) is what the trim removes and what an app tests, not crypto
  if (((head === 'Crypto' || head === 'crypto') && (first[1] ?? p.member) === 'subtle') || head === 'SubtleCrypto' || head === 'CryptoKey') return { global: 'Crypto.subtle' };
  if (/^getContext:/.test(head) || !/^[A-Za-z_$][\w$]*$/.test(head)) return undefined;
  return { global: head };
}
