/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The README's support matrix, generated from the compat checker's API inventory
 *.
 *
 *   node release/support-matrix.ts            print the Markdown
 *   node release/support-matrix.ts --write    replace the block between the support-matrix markers in README.md
 *   node release/support-matrix.ts --check    exit 1 if README.md's block is stale
 *
 * Each row is an API family with representative keys in the compat checker's key syntax. A row's status is
 * computed by resolving every key against the measured surface the installed CLI uses
 * (compat/data/surface-snapshot.json: what each runtime layer and IWER host mode provide, see compat/README.md)
 * with the compat rule table (compat/src/providers.ts), then applying the alpha scope (decided
 * 2026-10-20): rows with `alphaLater` are reported as "not yet" whatever the layers contain, because the
 * alpha does not ship them. Rows with `deviceUntested` would be "supported" but have not been exercised on a
 * headset yet (RELEASE.md section 9 gate): they read "implemented, not yet device-tested" until a device run
 * covers them and the field is removed.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKey, resolve, type Status } from '../compat/src/providers.ts';
import { fromSnapshot, type SurfaceSnapshot } from '../compat/src/surface.ts';

export type Support =
  | 'supported'
  | 'implemented, not yet device-tested'
  | 'not yet'
  | 'out of scope';

export interface Row {
  group: string;
  api: string;
  keys: string[];
  /** Alpha scope: not shipped in this release, whatever the inventory says. */
  alphaLater?: string;
  /** Implemented and in the surface, but no device run has exercised it yet: what is missing (shown as a note). */
  deviceUntested?: string;
  /** Packer features the row's APIs need (`passthrough`, `camera`): its keys resolve as for an app that declares them. */
  declares?: string[];
  /** `api` of rows this one depends on: unless they are all "supported", this row is "not yet" too. */
  requires?: string[];
  note?: string;
}

export const ROWS: Row[] = [
  // --- JavaScript engine and event loop
  {
    group: 'Engine',
    api: 'ECMAScript 2024+, WebAssembly (SIMD, threads)',
    keys: ['WebAssembly', 'WebAssembly.instantiate'],
    note: 'V8 15.5 with JIT',
  },
  {
    group: 'Engine',
    api: 'Intl (incl. Intl.Segmenter)',
    keys: ['Intl.Segmenter', 'Intl'],
  },
  {
    group: 'Engine',
    api: 'Timers, microtasks, requestAnimationFrame, structuredClone, reportError',
    keys: [
      'setTimeout',
      'setInterval',
      'queueMicrotask',
      'requestAnimationFrame',
      'structuredClone',
      'reportError',
    ],
  },
  {
    group: 'Engine',
    api: 'console, performance.now()',
    keys: ['console.log', 'performance'],
  },
  // --- WebXR
  {
    group: 'WebXR',
    api: 'navigator.xr, immersive-vr sessions, reference spaces, XRWebGLLayer',
    keys: [
      'Navigator.xr',
      'XRSystem.requestSession',
      'XRSystem.isSessionSupported',
      'XRSession',
      'XRReferenceSpace',
      'XRWebGLLayer',
      'XR feature local-floor',
    ],
    note: 'IWER host mode over OpenXR',
    requires: ['WebGL 2 and WebGL 1 (over OpenGL ES 3.2)'],
  },
  // Controllers: device-tested on 2026-10-21 with Meta's virtual Touch Plus controllers on a Quest 3 and a Quest 3S,
  // side by side with Quest Browser 156. Hands: device-tested on 2026-10-21 with Horizon OS's virtual hands on a
  // Quest 3 and a Quest 3S (joints, pinch, switching to controllers and back), microgestures with real hands.
  {
    group: 'WebXR',
    api: 'Controllers (XRInputSource, gamepad buttons and axes, haptics)',
    keys: ['XRInputSource', 'Gamepad'],
    requires: [
      'navigator.xr, immersive-vr sessions, reference spaces, XRWebGLLayer',
    ],
    note: "tested on Quest 3 and Quest 3S with simulated Touch Plus controllers, side by side with Quest Browser 156: same profiles, buttons, axes, press thresholds and events. Differences from Quest Browser: the left menu button is buttons[7] (Quest Browser: buttons[12], after extra buttons 7-11 this runtime does not expose), and the grip pose is tilted about 15° from Quest Browser's",
  },
  {
    group: 'WebXR',
    api: 'Hand tracking (XRHand, hand-tracking feature)',
    keys: ['XRHand', 'XR feature hand-tracking'],
    requires: [
      'navigator.xr, immersive-vr sessions, reference spaces, XRWebGLLayer',
    ],
    note: 'tested on Quest 3 and Quest 3S with simulated hands (25 joints, pinch select, switching to controllers and back) and with real hands (microgestures on hand buttons 5-9, as in Quest Browser); the system menu gesture is not yet device-tested',
  },
  {
    group: 'WebXR',
    api: 'Projection layers (XRWebGLBinding.createProjectionLayer)',
    keys: ['XRWebGLBinding', 'XRProjectionLayer', 'XR feature layers'],
    requires: ['WebGL 2 and WebGL 1 (over OpenGL ES 3.2)'],
  },
  // Quad / cylinder layers: device-tested on 2026-10-25 on a Quest 3 (proto-layers, IWSDK 1.0.0 and 1.1.0).
  {
    group: 'WebXR',
    api: 'Quad / cylinder layers (createQuadLayer, createCylinderLayer, getSubImage)',
    keys: [
      'XRQuadLayer',
      'XRCylinderLayer',
      'XRWebGLBinding.createQuadLayer',
      'XRWebGLBinding.createCylinderLayer',
      'XRWebGLBinding.getSubImage',
    ],
    requires: ['Projection layers (XRWebGLBinding.createProjectionLayer)'],
    note: 'mono and stereo layouts, texture and texture-array; the redraw event never fires (the runtime keeps layer content)',
  },
  {
    group: 'WebXR',
    api: 'Equirect / cube layers, XRMediaBinding',
    keys: ['XREquirectLayer', 'XRCubeLayer', 'XRMediaBinding'],
  },
  // immersive-ar: device-tested on 2026-10-25 on a Quest 3 (the D122713586 AR samples, passthrough under the projection layer).
  {
    group: 'WebXR',
    api: 'immersive-ar (passthrough)',
    keys: [
      'XRSystem.requestSession("immersive-ar")',
      'XRSystem.offerSession("immersive-ar")',
      'XRSystem.isSessionSupported("immersive-ar")',
    ],
    declares: ['passthrough'],
    requires: [
      'navigator.xr, immersive-vr sessions, reference spaces, XRWebGLLayer',
    ],
    note: 'for apps that declare passthrough (IWSDK\'s world.xr.mode "ar" does); environmentBlendMode alpha-blend',
  },
  // Planes, meshes, hit test: device-tested on 2026-10-25 on a Quest 3 without a room from Space Setup (empty lists) and
  // with a synthetic room fed at the natives boundary (proto-roomscan, proto-placement, proto-showcase-ar). The native
  // query path is host-tested against a fake runtime only, until a person runs Space Setup on a test unit.
  {
    group: 'WebXR',
    api: 'Plane / mesh detection, hit test (incl. transient input)',
    keys: [
      'XR feature plane-detection',
      'XR feature mesh-detection',
      'XR feature hit-test',
      'XRPlane',
      'XRMesh',
      'XRFrame.detectedPlanes',
      'XRSession.requestHitTestSource',
      'XRRay',
    ],
    requires: ['immersive-ar (passthrough)'],
    deviceUntested:
      'on a Quest 3 only without a room and with a synthetic room fed to the runtime; not yet against a real room from Space Setup',
    note: 'from the room of Space Setup (none: empty lists, no hits, where Quest Browser hits a floor plane); com.oculus.permission.USE_SCENE is asked for on first use',
  },
  {
    group: 'WebXR',
    api: 'Anchors, persistent anchors (requestPersistentHandle, restorePersistentAnchor)',
    keys: [
      'XR feature anchors',
      'XRAnchor',
      'XRFrame.createAnchor',
      'XRSession.restorePersistentAnchor',
    ],
    requires: ['immersive-ar (passthrough)'],
    deviceUntested:
      'on a Quest 3 the anchor calls reach the system, but the test headsets used had no 6DoF tracking, so no anchor was created, tracked or restored',
    note: 'com.oculus.permission.USE_ANCHOR_API (install time)',
  },
  // Depth: device-tested on 2026-10-25 on a Quest 3 (proto-occlusion, proto-showcase-ar).
  {
    group: 'WebXR',
    api: 'Depth sensing, gpu-optimized (XRWebGLBinding.getDepthInformation)',
    keys: [
      'XR feature depth-sensing',
      'XRWebGLBinding.getDepthInformation',
      'XRWebGLDepthInformation',
    ],
    requires: ['immersive-ar (passthrough)'],
    note: 'texture-array, one layer per eye; com.oculus.permission.USE_SCENE is asked for on first use; depthDataFormat reads float32 where Quest Browser says unsigned-short (same texture)',
  },
  {
    group: 'WebXR',
    api: 'Depth sensing, cpu-optimized (XRFrame.getDepthInformation)',
    keys: ['XRFrame.getDepthInformation', 'XRCPUDepthInformation'],
  },
  {
    group: 'WebXR',
    api: 'Eye / gaze tracking',
    keys: ['XR feature eye-tracking'],
  },
  // --- graphics
  {
    group: 'Graphics',
    api: 'WebGL 2 and WebGL 1 (over OpenGL ES 3.2)',
    keys: [
      'WebGL2RenderingContext',
      'WebGLRenderingContext',
      'HTMLCanvasElement.getContext("webgl2")',
      'HTMLCanvasElement.getContext("webgl")',
    ],
  },
  {
    group: 'Graphics',
    api: 'WebGL extensions incl. OVR_multiview2, EXT_color_buffer_float, compressed textures',
    keys: [
      'WebGL.getExtension("OVR_multiview2")',
      'WebGL.getExtension("EXT_color_buffer_float")',
    ],
    requires: ['WebGL 2 and WebGL 1 (over OpenGL ES 3.2)'],
  },
  {
    group: 'Graphics',
    api: 'Canvas 2D incl. text (fillText, measureText), Path2D, OffscreenCanvas, FontFace',
    keys: [
      'HTMLCanvasElement.getContext("2d")',
      'CanvasRenderingContext2D',
      'CanvasRenderingContext2D.fillText',
      'Path2D',
      'OffscreenCanvas',
      'FontFace',
    ],
  },
  {
    group: 'Graphics',
    api: 'Images: Image / HTMLImageElement, createImageBitmap, ImageData (PNG, JPEG, WebP, GIF)',
    keys: [
      'Image',
      'HTMLImageElement',
      'createImageBitmap',
      'ImageBitmap',
      'ImageData',
    ],
  },
  {
    group: 'Graphics',
    api: 'WebGPU',
    keys: ['GPU', 'HTMLCanvasElement.getContext("webgpu")'],
  },
  {
    group: 'Graphics',
    api: 'WebCodecs (VideoFrame, VideoDecoder, ...)',
    keys: ['VideoFrame', 'VideoDecoder'],
  },
  // --- network and storage
  {
    group: 'Network and storage',
    api: 'fetch, Request / Response / Headers, XMLHttpRequest (APK assets + allowlisted HTTPS)',
    keys: ['fetch', 'Request', 'Response', 'Headers', 'XMLHttpRequest'],
    note: 'cross-origin hosts need native.network.allow',
  },
  {
    group: 'Network and storage',
    api: 'Streams (ReadableStream, ...)',
    keys: ['ReadableStream', 'TransformStream'],
  },
  {
    group: 'Network and storage',
    api: 'localStorage, sessionStorage',
    keys: ['localStorage', 'sessionStorage'],
  },
  {
    group: 'Network and storage',
    api: 'URL, TextEncoder/Decoder, Blob, File, FileReader, AbortController, atob/btoa, crypto.getRandomValues',
    keys: [
      'URL',
      'URLSearchParams',
      'TextEncoder',
      'TextDecoder',
      'Blob',
      'FileReader',
      'AbortController',
      'atob',
      'crypto',
    ],
  },
  {
    group: 'Network and storage',
    api: 'WebSocket',
    keys: ['WebSocket'],
    alphaLater:
      'out of the alpha scope (absent: typeof WebSocket === "undefined")',
  },
  {
    group: 'Network and storage',
    api: 'IndexedDB',
    keys: ['indexedDB'],
    alphaLater: 'out of the alpha scope (absent)',
  },
  {
    group: 'Network and storage',
    api: 'Cache API (caches)',
    keys: ['caches'],
    alphaLater: 'out of the alpha scope (absent)',
  },
  {
    group: 'Network and storage',
    api: 'crypto.subtle',
    keys: ['crypto.subtle'],
    note: 'absent by default; a digest-only SubtleCrypto is opt-in',
  },
  {
    group: 'Network and storage',
    api: 'Service workers, EventSource, WebTransport',
    keys: ['Navigator.serviceWorker', 'EventSource', 'WebTransport'],
  },
  // --- workers
  {
    group: 'Workers',
    api: 'Worker (module and classic), MessageChannel, SharedArrayBuffer + Atomics (WASM threads)',
    keys: ['Worker', 'MessageChannel', 'MessagePort'],
    note: 'KTX2, Draco, physics workers',
  },
  { group: 'Workers', api: 'SharedWorker', keys: ['SharedWorker'] },
  // --- audio
  {
    group: 'Audio',
    api: 'AudioContext lifecycle, AudioBufferSourceNode, GainNode, PannerNode + AudioListener, decodeAudioData (MP3, Ogg Vorbis, WAV, AAC)',
    keys: [
      'AudioContext',
      'AudioBufferSourceNode',
      'GainNode',
      'PannerNode',
      'AudioListener',
      'AudioBuffer',
      'BaseAudioContext.decodeAudioData()',
    ],
  },
  {
    group: 'Audio',
    api: 'Other Web Audio nodes (Oscillator, BiquadFilter, Convolver, Analyser, DynamicsCompressor, StereoPanner, Delay, WaveShaper, OfflineAudioContext)',
    keys: [
      'OscillatorNode',
      'BiquadFilterNode',
      'ConvolverNode',
      'AnalyserNode',
    ],
    alphaLater: 'beyond the basic Web Audio set the alpha validates',
  },
  {
    group: 'Audio',
    api: 'AudioWorklet, ScriptProcessorNode',
    keys: ['AudioWorklet', 'ScriptProcessorNode'],
  },
  // --- DOM and the page
  {
    group: 'DOM and page',
    api: 'document / element stand-ins (createElement canvas/img/script, querySelector, style accepted), events, location, history, matchMedia',
    keys: [
      'Document',
      'HTMLCanvasElement',
      'HTMLElement',
      'EventTarget',
      'CustomEvent',
      'location',
      'matchMedia',
    ],
    note: 'no layout or CSS rendering',
  },
  {
    group: 'DOM and page',
    api: 'Gamepad API (navigator.getGamepads)',
    keys: ['Navigator.getGamepads'],
    note: 'XR controllers come through XRInputSource.gamepad, not navigator.getGamepads()',
  },
  {
    group: 'DOM and page',
    api: 'DOM layout, CSS rendering, HTML UI / 2D panel, pointer and keyboard events',
    keys: ['on:HTMLCanvasElement.pointerdown', 'on:Window.keydown'],
    note: 'listeners are accepted and never fire',
  },
  {
    group: 'DOM and page',
    api: '`<video>` / `<audio>` playback, MediaSource',
    keys: ['HTMLVideoElement.play', 'MediaSource'],
    alphaLater:
      'media playback is out of the alpha scope (play() of a media file rejects with NotSupportedError; a `<video>` plays a camera stream, see Camera)',
  },
  {
    group: 'DOM and page',
    api: 'System keyboard / text input',
    keys: ['on:Window.keydown'],
    alphaLater: 'out of the alpha scope',
  },
  {
    group: 'DOM and page',
    api: 'window.open, external links, OAuth redirects',
    keys: ['open'],
    alphaLater: 'out of the alpha scope',
  },
  {
    group: 'DOM and page',
    api: 'WebRTC',
    keys: ['RTCPeerConnection'],
    alphaLater: 'out of the alpha scope (absent)',
  },
  // Camera: device-tested on 2026-10-25 on a Quest 3 (proto-camera, IWSDK's CameraSource; permissions granted at
  // install): both passthrough cameras, 1280x1080@30, a <video> VideoTexture. On 2026-10-26 (a probe page, installed
  // without grants): the grant at getUserMedia after an early enumerateDevices, held ImageBitmaps, two requests for one
  // camera, a sleep past a minute with a stream open. The denial path is unit-tested only.
  {
    group: 'DOM and page',
    api: 'Camera: getUserMedia({ video }) over the passthrough cameras, enumerateDevices, MediaStream, `<video>` srcObject',
    keys: [
      'Navigator.mediaDevices',
      'MediaDevices.getUserMedia()',
      'MediaDevices.enumerateDevices()',
      'MediaStream',
      'MediaStreamTrack',
      'HTMLVideoElement.srcObject',
    ],
    declares: ['camera'],
    note: "only for apps that declare the camera (native.features.camera or IWSDK's world.features.camera); CAMERA and HEADSET_CAMERA are asked for on first use",
  },
  {
    group: 'DOM and page',
    api: 'Microphone, screen capture, clipboard, notifications, geolocation, Web Bluetooth/USB/HID/Serial, speech',
    keys: [
      'MediaDevices.getDisplayMedia()',
      'MediaRecorder',
      'Navigator.clipboard',
      'Notification',
      'Navigator.geolocation',
      'Navigator.bluetooth',
    ],
  },
];

const SUPPORTED: ReadonlySet<Status> = new Set([
  'v8',
  'provided',
  'iwer',
  'config',
]);
const LATER: ReadonlySet<Status> = new Set([
  'later',
  'gap',
  'partial',
  'in-source',
]);

export interface RowResult extends Row {
  support: Support;
  statuses: Record<string, Status>;
  layers: string[];
}

export function classify(
  row: Row,
  snapshot: SurfaceSnapshot,
  seen: ReadonlySet<string> = new Set(),
): RowResult {
  const surface = fromSnapshot(snapshot);
  const statuses: Record<string, Status> = {};
  const layers = new Set<string>();
  const ctx = { declared: new Set(row.declares ?? []) };
  for (const k of row.keys) {
    const r = resolve(parseKey(k), surface, ctx);
    statuses[k] = r.status;
    if (r.layer) layers.add(r.layer);
  }
  const all = Object.values(statuses);
  let support: Support;
  if (row.alphaLater) support = 'not yet';
  else if (all.every((s) => SUPPORTED.has(s))) support = 'supported';
  else if (all.some((s) => LATER.has(s))) support = 'not yet';
  else if (
    all.some((s) => SUPPORTED.has(s)) &&
    !all.some((s) => s === 'unsupported' || s === 'absent-ok' || s === 'inert')
  )
    support = 'supported';
  else support = 'out of scope';
  let note = row.note;
  if (support === 'supported' && row.deviceUntested)
    support = 'implemented, not yet device-tested';
  if (support === 'supported' && row.requires?.length) {
    const blocked = row.requires.filter((api) => {
      const dep = ROWS.find((x) => x.api === api);
      if (!dep)
        throw new Error(
          `support matrix: "${row.api}" requires unknown row "${api}"`,
        );
      if (seen.has(api))
        throw new Error(`support matrix: dependency cycle at "${api}"`);
      return (
        classify(dep, snapshot, new Set([...seen, row.api])).support !==
        'supported'
      );
    });
    if (blocked.length) {
      support = 'not yet';
      note = [`waits for: ${blocked.join('; ')}`, row.note]
        .filter(Boolean)
        .join('; ');
    }
  }
  return { ...row, note, support, statuses, layers: [...layers].sort() };
}

const MARK: Record<Support, string> = {
  supported: 'supported',
  'implemented, not yet device-tested': 'implemented, not yet device-tested',
  'not yet': 'not yet',
  'out of scope': 'out of scope',
};

export function matrixMarkdown(snapshot: SurfaceSnapshot): string {
  const rows = ROWS.map((r) => classify(r, snapshot));
  const lines = [
    `Generated by \`node release/support-matrix.ts --write\` from the compat checker's API inventory (surface snapshot ${snapshot.generatedAt.slice(0, 10)}, \`compat/data/surface-snapshot.json\`) and the alpha scope. **supported**: implemented in this release and present in the measured API surface (the surface is measured headlessly; each release's device sweep covers the supported rows). **implemented, not yet device-tested**: in this release and in the measured surface, tested on the host, but not yet exercised on a headset. **not yet**: planned after the alpha (absent or throws \`NotSupportedError\` today). **out of scope**: absent by design; feature detection sees \`undefined\`. \`npx iwer-native compat\` lists what your own app uses.`,
    '',
    '| area | API | status | notes |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    const notes = [
      r.alphaLater,
      r.support === 'implemented, not yet device-tested'
        ? r.deviceUntested
        : undefined,
      r.note,
    ]
      .filter(Boolean)
      .join('; ');
    lines.push(
      `| ${r.group} | ${r.api.replace(/\|/g, '\\|')} | ${MARK[r.support]} | ${notes.replace(/\|/g, '\\|')} |`,
    );
  }
  return lines.join('\n');
}

export const BEGIN = '<!-- support-matrix:begin -->';
export const END = '<!-- support-matrix:end -->';

export function replaceBlock(readme: string, block: string): string {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a)
    throw new Error(`README.md has no ${BEGIN} ... ${END} block`);
  return `${readme.slice(0, a + BEGIN.length)}\n${block}\n${readme.slice(b)}`;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Real paths, not the URL string: argv[1] keeps symlinks and spaces as typed (see release/lib.mjs isMain).
const isMain =
  !!process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(process.argv[1]);
if (isMain) {
  const snapFile = path.join(root, 'compat', 'data', 'surface-snapshot.json');
  if (!existsSync(snapFile))
    throw new Error(
      `${snapFile} missing: run node compat/scripts/snapshot.mjs`,
    );
  const snapshot = JSON.parse(
    readFileSync(snapFile, 'utf8'),
  ) as SurfaceSnapshot;
  const block = matrixMarkdown(snapshot);
  const readmeFile = path.join(root, 'README.md');
  if (process.argv.includes('--write') || process.argv.includes('--check')) {
    const readme = readFileSync(readmeFile, 'utf8');
    const next = replaceBlock(readme, block);
    if (process.argv.includes('--check')) {
      if (next !== readme) {
        process.stderr.write(
          'support-matrix: README.md is stale; run node release/support-matrix.ts --write\n',
        );
        process.exitCode = 1;
      } else process.stdout.write('support-matrix: README.md is up to date\n');
    } else {
      writeFileSync(readmeFile, next);
      process.stdout.write('support-matrix: README.md updated\n');
    }
  } else process.stdout.write(`${block}\n`);
}
