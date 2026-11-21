/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Static scan of a built bundle (Vite `dist/`): which web APIs the code may
 * touch. It reads every .js/.mjs (and inline <script> in .html) as text and
 * matches a catalogue of signals: interface names, distinctive members and
 * argument strings (context types, XR session modes and features), plus the
 * cross-origin URLs the code names (network allowlist candidates).
 *
 * A static hit means "the bundle mentions it": dead code and feature detection
 * look the same as real use. The trace (trace-run.ts) confirms what runs.
 */

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { detectInjection } from '../../packager/src/dist.ts';
import { CROSS_ORIGIN_NAVIGATION } from './providers.ts';

export interface ScanSignal {
  /** Key in tracer vocabulary (resolved with providers.ts). */
  key: string;
  re: RegExp;
  /** 'call': constructing/calling it; 'probe': a mention that is usually feature detection. */
  strength: 'call' | 'probe';
}

export interface ScanHit {
  key: string;
  strength: 'call' | 'probe';
  count: number;
  files: Array<{ file: string; count: number; excerpt: string }>;
}

export interface ScanResult {
  dist: string;
  files: number;
  bytes: number;
  hits: ScanHit[];
  /**
   * Cross-origin origins named in the code (with a sample path and file). `likelyRuntime`: a known asset CDN,
   * or a URL that names a loadable file (.glb, .png, .wasm, .json, ...).
   */
  origins: Array<{
    origin: string;
    count: number;
    example: string;
    file: string;
    likelyRuntime: boolean;
  }>;
  /** IWER emulator (or another WebXR polyfill) bundled into the build (PKG-6). */
  injectedEmulator: string[];
  /** Files that could not be read (dangling links, permissions). */
  unreadable: string[];
  /**
   * Assets in dist/ that need a decoder IWSDK fetches at runtime (from unpkg.com by default): KTX2/Basis textures
   * (`.ktx2`, or glTF with KHR_texture_basisu) and Draco meshes (glTF with KHR_draco_mesh_compression).
   */
  compressedAssets?: { ktx2: string[]; draco: string[] };
  /** The bundle carries IWSDK (its scene-runtime markers survive minification). */
  iwsdk?: boolean;
}

/** Strings IWSDK's runtime keeps through minification (scene metadata keys, the level file name). */
export const IWSDK_MARKER =
  /\biwsdk(?:Scene[A-Z]\w*|DisposeAsset)\b|\biwsdk\.scene\.json\b/;

const S = (
  key: string,
  re: RegExp,
  strength: 'call' | 'probe' = 'call',
): ScanSignal => ({ key, re, strength });

/** BaseAudioContext factories outside the alpha's basic Web Audio set. */
const LATER_AUDIO_FACTORIES = [
  'Oscillator',
  'BiquadFilter',
  'Convolver',
  'Analyser',
  'DynamicsCompressor',
  'StereoPanner',
  'Delay',
  'WaveShaper',
  'IIRFilter',
  'ConstantSource',
  'ChannelMerger',
  'ChannelSplitter',
  'PeriodicWave',
];
/** Node constructors outside the alpha's basic Web Audio set (`new <Name>Node(ctx)`). */
const LATER_AUDIO_NODES = [
  'Oscillator',
  'BiquadFilter',
  'Convolver',
  'Analyser',
  'DynamicsCompressor',
  'StereoPanner',
  'Delay',
  'WaveShaper',
  'IIRFilter',
  'ConstantSource',
  'ChannelMerger',
  'ChannelSplitter',
];

/** A call of getUserMedia: the packer derives the camera feature from it for non-IWSDK bundles (pack.ts). */
export const CAMERA_SIGNAL: ScanSignal = S(
  'MediaDevices.getUserMedia()',
  /\bgetUserMedia\s*\(/,
);

/** The catalogue. Keys use the tracer's vocabulary so providers.ts resolves them. */
export const SIGNALS: ScanSignal[] = [
  // absent by design
  S('Navigator.gpu', /\bnavigator\.gpu\b/, 'probe'),
  S('Navigator.gpu.requestAdapter()', /\bnavigator\.gpu\.requestAdapter\s*\(/),
  S(
    'HTMLCanvasElement.getContext("webgpu")',
    /getContext\(\s*["'`]webgpu["'`]/,
  ),
  S(
    'HTMLCanvasElement.getContext("bitmaprenderer")',
    /getContext\(\s*["'`]bitmaprenderer["'`]/,
  ),
  S('VideoFrame', /\btypeof\s+VideoFrame\b|\bVideoFrame\b(?!\s*\()/, 'probe'),
  S('new VideoFrame', /\bnew\s+VideoFrame\s*\(/),
  S('new VideoDecoder', /\bnew\s+VideoDecoder\s*\(/),
  S('new ImageDecoder', /\bnew\s+ImageDecoder\s*\(/),
  S(
    'HTMLVideoElement.requestVideoFrameCallback()',
    /\.requestVideoFrameCallback\s*\(/,
  ),
  S(
    'Document.createElement("video")',
    /createElement\(\s*["'`]video["'`]\s*\)/,
  ),
  S(
    'Document.createElement("audio")',
    /createElement\(\s*["'`]audio["'`]\s*\)/,
  ),
  S('new Audio', /\bnew\s+Audio\s*\(/),
  S(
    'BaseAudioContext.createMediaElementSource()',
    /\.createMediaElementSource\s*\(/,
  ),
  S(
    'BaseAudioContext.createMediaStreamSource()',
    /\.createMediaStreamSource\s*\(/,
  ),
  CAMERA_SIGNAL,
  S('Navigator.mediaDevices', /\bnavigator\.mediaDevices\b/, 'probe'),
  S('new MediaRecorder', /\bnew\s+MediaRecorder\s*\(/),
  S('new RTCPeerConnection', /\bnew\s+RTCPeerConnection\s*\(/),
  S('ServiceWorkerContainer.register()', /\bserviceWorker\.register\s*\(/),
  S('new SharedWorker', /\bnew\s+SharedWorker\s*\(/),
  S('new BroadcastChannel', /\bnew\s+BroadcastChannel\s*\(/),
  S('new Notification', /\bnew\s+Notification\s*\(/),
  S('new EventSource', /\bnew\s+EventSource\s*\(/),
  S('new WebTransport', /\bnew\s+WebTransport\s*\(/),
  S('Navigator.clipboard', /\bnavigator\.clipboard\b/),
  S('Navigator.share()', /\bnavigator\.share\s*\(/),
  S('Navigator.wakeLock', /\bnavigator\.wakeLock\b/),
  S('Navigator.geolocation', /\bnavigator\.geolocation\b/),
  S('Navigator.requestMIDIAccess()', /\bnavigator\.requestMIDIAccess\s*\(/),
  S('Navigator.bluetooth', /\bnavigator\.bluetooth\b/),
  S('Navigator.usb', /\bnavigator\.usb\b/),
  S('Navigator.hid', /\bnavigator\.hid\b/),
  S('speechSynthesis', /\bspeechSynthesis\b/),
  S('indexedDB.open()', /\bindexedDB\.open\s*\(/),
  S('caches.open()', /\bcaches\.open\s*\(/),
  // crypto.subtle: absent unless config subtle is 'digest' (NET-STORE-4)
  S('Crypto.subtle', /\bcrypto\.subtle\b/, 'probe'),
  ...[
    'digest',
    'encrypt',
    'decrypt',
    'sign',
    'verify',
    'importKey',
    'exportKey',
    'generateKey',
    'deriveKey',
    'deriveBits',
    'wrapKey',
    'unwrapKey',
  ].map((m) =>
    S(`SubtleCrypto.${m}()`, new RegExp(`\\bcrypto\\.subtle\\.${m}\\s*\\(`)),
  ),
  // WebXR beyond host mode today
  S(
    'XRSystem.requestSession("immersive-ar")',
    /["'`]immersive-ar["'`]/,
    'probe',
  ),
  S(
    'XR feature plane-detection (optional)',
    /["'`]plane-detection["'`]/,
    'probe',
  ),
  S(
    'XR feature mesh-detection (optional)',
    /["'`]mesh-detection["'`]/,
    'probe',
  ),
  S('XR feature hit-test (optional)', /["'`]hit-test["'`]/, 'probe'),
  S('XR feature anchors (optional)', /["'`]anchors["'`]/, 'probe'),
  S('XR feature depth-sensing (optional)', /["'`]depth-sensing["'`]/, 'probe'),
  S('XR feature dom-overlay (optional)', /["'`]dom-overlay["'`]/, 'probe'),
  S('XR feature camera-access (optional)', /["'`]camera-access["'`]/, 'probe'),
  S(
    'XR feature light-estimation (optional)',
    /["'`]light-estimation["'`]/,
    'probe',
  ),
  S('XRWebGLBinding.createQuadLayer()', /\.createQuadLayer\s*\(/),
  S('XRWebGLBinding.createCylinderLayer()', /\.createCylinderLayer\s*\(/),
  S('XRWebGLBinding.createEquirectLayer()', /\.createEquirectLayer\s*\(/),
  S('XRMediaBinding', /\bXRMediaBinding\b/, 'probe'),
  // provided surface (for the full picture; the checker reports these as info)
  S(
    'HTMLCanvasElement.getContext("webgl2")',
    /getContext\(\s*["'`]webgl2["'`]/,
  ),
  S('HTMLCanvasElement.getContext("2d")', /getContext\(\s*["'`]2d["'`]/),
  S('new OffscreenCanvas', /\bnew\s+OffscreenCanvas\s*\(/),
  S('new Worker', /\bnew\s+Worker\s*\(/),
  S('new AudioContext', /\bnew\s+(?:window\.)?(?:webkit)?AudioContext\s*\(/),
  S('BaseAudioContext.decodeAudioData()', /\.decodeAudioData\s*\(/),
  S('createImageBitmap()', /\bcreateImageBitmap\s*\(/),
  S('fetch()', /\bfetch\s*\(/),
  S('new XMLHttpRequest', /\bnew\s+XMLHttpRequest\s*\(/),
  S('new WebSocket', /\bnew\s+(?:(?:window|globalThis|self)\.)?WebSocket\s*\(/),
  S('localStorage', /\blocalStorage\b/),
  S('new Intl.Segmenter', /\bIntl\.Segmenter\b/),
  S(
    'WebAssembly.instantiateStreaming()',
    /\bWebAssembly\.(?:instantiate|compile)Streaming\s*\(/,
  ),
  S('XRSystem.requestSession()', /\.requestSession\s*\(/),
  S('XRSystem.offerSession()', /\.offerSession\s*\(/),
  S('new DOMParser', /\bnew\s+DOMParser\s*\(/),
  S('new MutationObserver', /\bnew\s+MutationObserver\s*\(/),
  S('new ResizeObserver', /\bnew\s+ResizeObserver\s*\(/),
  S('new IntersectionObserver', /\bnew\s+IntersectionObserver\s*\(/),
  S('Element.requestPointerLock()', /\.requestPointerLock\s*\(/),
  S('Element.requestFullscreen()', /\.requestFullscreen\s*\(/),
  S('new FontFace', /\bnew\s+FontFace\s*\(/),
  // AUD-6 (later): audio worklets and script processors
  S('AudioWorklet.addModule()', /\baudioWorklet\.addModule\s*\(/),
  S('new AudioWorkletNode', /\bnew\s+AudioWorkletNode\s*\(/),
  S('BaseAudioContext.createScriptProcessor()', /\.createScriptProcessor\s*\(/),
  S('Navigator.getGamepads()', /\bnavigator\.getGamepads\s*\(/),
  // alpha scope (2026-10-20): Web Audio beyond the basic set (providers.ts ALPHA_LATER)
  ...LATER_AUDIO_FACTORIES.map((m) =>
    S(`BaseAudioContext.create${m}()`, new RegExp(`\\.create${m}\\s*\\(`)),
  ),
  S(
    'new OfflineAudioContext',
    /\bnew\s+(?:(?:window|globalThis|self)\.)?(?:webkit)?OfflineAudioContext\s*\(/,
  ),
  ...LATER_AUDIO_NODES.map((m) =>
    S(
      `new ${m}Node`,
      new RegExp(`\\bnew\\s+(?:(?:window|globalThis|self)\\.)?${m}Node\\s*\\(`),
    ),
  ),
  // alpha scope: popups, external links and OAuth redirects. window.open() returns null on the headset (DOM-3);
  // a navigation to a literal cross-origin URL is logged and ignored there (DOM-5). Same-document assign/replace
  // reload the app, so only literal http(s) URLs count
  S('open()', /\bwindow\.open\s*\(/),
  S(
    CROSS_ORIGIN_NAVIGATION,
    /\blocation(?:\.href\s*=(?!=)|\.assign\s*\(|\.replace\s*\(|\s*=(?!=))\s*["'`]https?:\/\//,
  ),
];

/** URL hosts that are inert strings in common libraries (namespaces, docs, licences). */
const INERT_HOSTS =
  /(^|\.)(w3\.org|github\.com|githubusercontent\.com|mozilla\.org|khronos\.org|schema\.org|json-schema\.org|threejs\.org|npmjs\.(com|org)|opensource\.org|apache\.org|reactjs\.org|react\.dev|example\.(com|org)|tc39\.es|whatwg\.org|ecma-international\.org|webkit\.org|chromium\.org|webxr\.dev|immersiveweb\.dev|fb\.me|stackoverflow\.com|wikipedia\.org|unicode\.org|iwsdk\.dev|meta\.com|facebook\.com|developer\.oculus\.com|babylonjs\.com|ietf\.org|purl\.org|xmlns\.com|adobe\.com|ns\.adobe\.com)$/;
/** Hosts that are known runtime asset CDNs for IWSDK apps. */
const RUNTIME_HOSTS =
  /(^|\.)(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|gstatic\.com)$/;
/** A URL path that names a file an app loads at runtime. */
const ASSET_PATH =
  /\.(glb|gltf|bin|png|jpe?g|webp|ktx2|basis|hdr|exr|env|wasm|json|js|mjs|mp3|ogg|wav|m4a|ttf|otf|woff2?|fnt|csv|txt)(\?|#|$)/i;

function listFiles(dir: string, unreadable: string[] = []): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        unreadable.push(path.relative(dir, p));
        continue;
      }
      if (st.isDirectory()) visit(p);
      else if (/\.(m?js|html)$/i.test(f)) out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}

/** dist/ assets that need IWSDK's runtime-fetched decoders (see ScanResult.compressedAssets). */
export function findCompressedAssets(dir: string): {
  ktx2: string[];
  draco: string[];
} {
  const ktx2: string[] = [];
  const draco: string[] = [];
  const visit = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const f of names) {
      const p = path.join(d, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(p);
        continue;
      }
      const rel = path.relative(dir, p);
      if (/\.ktx2$/i.test(f)) ktx2.push(rel);
      else if (/\.(glb|gltf)$/i.test(f)) {
        // the extension names sit in the glTF JSON (the first chunk of a .glb)
        let head = '';
        try {
          const fd = openSync(p, 'r');
          const buf = Buffer.alloc(Math.min(st.size, 4 * 1024 * 1024));
          readSync(fd, buf, 0, buf.length, 0);
          closeSync(fd);
          head = buf.toString('latin1');
        } catch {
          continue;
        }
        if (head.includes('KHR_draco_mesh_compression')) draco.push(rel);
        if (head.includes('KHR_texture_basisu')) ktx2.push(rel);
      }
    }
  };
  visit(dir);
  return { ktx2: ktx2.sort(), draco: draco.sort() };
}

function excerpt(text: string, index: number): string {
  return text.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, ' ');
}

/** Scan a dist directory. */
export function scanDist(
  distDir: string,
  signals: ScanSignal[] = SIGNALS,
): ScanResult {
  const unreadable: string[] = [];
  const files = listFiles(distDir, unreadable);
  const hits = new Map<string, ScanHit>();
  const origins = new Map<
    string,
    {
      origin: string;
      count: number;
      example: string;
      file: string;
      likelyRuntime: boolean;
    }
  >();
  const injected = new Set<string>();
  let bytes = 0;
  let iwsdk = false;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      unreadable.push(path.relative(distDir, file));
      continue;
    }
    bytes += text.length;
    if (!iwsdk && IWSDK_MARKER.test(text)) iwsdk = true;
    const rel = path.relative(distDir, file);
    if (file.endsWith('.html')) {
      text = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((m) => m[1])
        .join('\n;\n');
    }
    for (const sig of signals) {
      const re = new RegExp(
        sig.re.source,
        sig.re.flags.includes('g') ? sig.re.flags : `${sig.re.flags}g`,
      );
      let count = 0;
      let first = -1;
      for (const m of text.matchAll(re)) {
        if (first < 0) first = m.index ?? 0;
        count++;
      }
      if (!count) continue;
      const h = hits.get(sig.key) ?? {
        key: sig.key,
        strength: sig.strength,
        count: 0,
        files: [],
      };
      h.count += count;
      h.files.push({ file: rel, count, excerpt: excerpt(text, first) });
      hits.set(sig.key, h);
    }
    for (const m of text.matchAll(
      /\b(https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})(:\d+)?(\/[^\s"'`<>)\\]*)?/gi,
    )) {
      const scheme = m[1]!.toLowerCase();
      const host = m[2]!.toLowerCase();
      if (INERT_HOSTS.test(host) || host === 'localhost') continue;
      const origin = `${scheme}://${host}${m[3] ?? ''}`;
      // a WebSocket URL is only ever named to be connected to
      const asset = ASSET_PATH.test(m[4] ?? '') || scheme.startsWith('ws');
      const o = origins.get(origin) ?? {
        origin,
        count: 0,
        example: m[0].slice(0, 120),
        file: rel,
        likelyRuntime: RUNTIME_HOSTS.test(host) || asset,
      };
      if (asset && !o.likelyRuntime) {
        o.likelyRuntime = true;
        o.example = m[0].slice(0, 120);
      }
      o.count++;
      origins.set(origin, o);
    }
    // IWER bundled in: minifiers rename classes (XRDevice) but keep method names, device-config object names
    // and config keys, so look for installRuntime( next to a device config
    if (
      /\binstallRuntime\s*\(/.test(text) &&
      /\bmetaQuest3\b|\bmetaQuestPro\b|\boculusQuest1\b|\bmetaQuest2\b/.test(
        text,
      ) &&
      /\buserAgentException\b|\bXRDevice\b|\bforceInstall\b/.test(text)
    )
      injected.add(`${rel}: IWER emulator (installRuntime + a device config)`);
    if (/WebXRPolyfill|webxr-polyfill/.test(text))
      injected.add(`${rel}: webxr-polyfill`);
  }
  // the packager's own detector (IWSDK's injectOnBuild markers), so the compat gate and pack agree
  try {
    const distFiles = files.map((f) => ({
      rel: path.relative(distDir, f).split(path.sep).join('/'),
      abs: f,
      size: statSync(f).size,
    }));
    let index = '';
    try {
      index = readFileSync(path.join(distDir, 'index.html'), 'utf8');
    } catch {
      /* no index */
    }
    for (const f of detectInjection(distDir, distFiles, index)) {
      if (![...injected].some((i) => i.startsWith(`${f.file}:`)))
        injected.add(`${f.file}: ${f.what}`);
    }
  } catch {
    /* the heuristic above still ran */
  }
  return {
    dist: distDir,
    files: files.length,
    bytes,
    hits: [...hits.values()].sort((a, b) => a.key.localeCompare(b.key)),
    origins: [...origins.values()].sort(
      (a, b) =>
        Number(b.likelyRuntime) - Number(a.likelyRuntime) || b.count - a.count,
    ),
    injectedEmulator: [...injected],
    unreadable,
    compressedAssets: findCompressedAssets(distDir),
    iwsdk,
  };
}
