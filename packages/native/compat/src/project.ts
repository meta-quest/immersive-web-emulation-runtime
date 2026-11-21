/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * What the app itself declares and calls, as opposed to the library code every
 * IWSDK bundle carries. Two sources, both outside dist/ and both owned by the app:
 *
 * - `iwsdk.config.json` `world.xr`: the session mode (`"ar"` means an
 *   `immersive-ar` offer/request) and the features, with `{ "required": true }`
 *   marking required ones (the IWSDK project schema v1);
 * - the app's own source (`src/`, the scripts at the project root, the entry
 *   scripts `index.html` references, and its inline scripts; never
 *   `node_modules`), comments stripped, matched with the static-scan catalogue
 *   plus IWSDK uses that lead to device-only calls (`XRQuadLayer` and
 *   `XRCylinderLayer` make IWSDK's XRLayerSystem call
 *   `XRWebGLBinding.createQuadLayer` / `createCylinderLayer`) and IWSDK's XR
 *   options given in code (`World.create(el, { xr: { sessionMode, features } })`,
 *   `launchXR(world, options)`), which override or replace the config file.
 *
 * A signal whose API the source also feature-detects (`typeof VideoDecoder`,
 * `if (navigator.gpu)`, `navigator.mediaDevices?.getUserMedia`) carries the
 * guard as evidence: on the headset the guard sees `undefined` and the app's
 * fallback runs.
 *
 * A static hit in the bundle that the app's own source or config confirms is
 * not dormant library code, whatever the baseline says.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { rootOf } from './providers.ts';
import { SIGNALS, type ScanSignal } from './scan.ts';

export interface AppSignal {
  /** Key in tracer vocabulary. */
  key: string;
  /** 'config' (iwsdk.config.json) or 'source' (the app's own code). */
  origin: 'config' | 'source';
  evidence: string;
  /** The app's source feature-detects the API's global / navigator member here (`file:line: excerpt`). */
  guarded?: string;
}

/** IWSDK project feature name -> WebXR feature descriptor. */
const IWSDK_FEATURES: Record<string, string> = {
  handTracking: 'hand-tracking',
  hitTest: 'hit-test',
  anchors: 'anchors',
  planeDetection: 'plane-detection',
  meshDetection: 'mesh-detection',
  depthSensing: 'depth-sensing',
  layers: 'layers',
  gazeTracking: 'gaze-tracking',
  // IWSDK's deprecated alias, requested under the W3C descriptor name
  eyeTracking: 'eye-tracking',
  unbounded: 'unbounded',
  boundedFloor: 'bounded-floor',
  domOverlay: 'dom-overlay',
  lightEstimation: 'light-estimation',
  cameraAccess: 'camera-access',
};

/** IWSDK-level uses in app source that end in device-only web API calls. */
export const APP_SOURCE_SIGNALS: ScanSignal[] = [
  { key: 'XRWebGLBinding.createQuadLayer()', re: /\bXRQuadLayer\b/, strength: 'call' },
  { key: 'XRWebGLBinding.createCylinderLayer()', re: /\bXRCylinderLayer\b/, strength: 'call' },
  { key: 'HTMLMediaElement.srcObject=', re: /\.srcObject\s*=/, strength: 'call' },
  // IWSDK's camera feature: a CameraSource component makes CameraSystem call navigator.mediaDevices.getUserMedia
  // (and enumerateDevices) and play the stream through a <video>; CameraUtils wraps the same calls
  { key: 'MediaDevices.getUserMedia()', re: /\b(CameraSource|CameraUtils)\b/, strength: 'call' },
];

/**
 * Key of the XR-LIFE-7 signal: the app's config says it never offers an immersive session (`xr: false`, or
 * `offer: "none"`, where entering XR waits for a DOM button that cannot be pressed on the headset).
 */
export const NO_XR_ENTRY = 'no XR entry';

/**
 * In app source, an XR feature string counts only inside a `requiredFeatures`/`optionalFeatures` list, not
 * anywhere a word like 'anchors' appears in UI text (IWSDK apps declare features in iwsdk.config.json).
 */
function featureSourceSignals(): ScanSignal[] {
  const out: ScanSignal[] = [];
  for (const sig of SIGNALS) {
    const m = /^XR feature (\S+) \(optional\)$/.exec(sig.key);
    if (!m) continue;
    const f = m[1]!;
    out.push({ key: sig.key, strength: sig.strength, re: new RegExp(`\\boptionalFeatures\\s*:\\s*\\[[^\\]]*["'\`]${f}["'\`]`) });
    // a required feature makes requestSession reject on the headset while the feature is 'later'
    out.push({ key: `XR feature ${f} (required)`, strength: sig.strength, re: new RegExp(`\\brequiredFeatures\\s*:\\s*\\[[^\\]]*["'\`]${f}["'\`]`) });
  }
  return out;
}

/**
 * Session modes in context: asking `isSessionSupported("immersive-ar")` is a probe (false on the headset, the app's
 * VR path runs); any other `'immersive-ar'` (a request, an offer, a mode variable) or IWSDK's
 * `SessionMode.ImmersiveAR` is a request.
 */
const SESSION_MODE_SIGNALS: ScanSignal[] = [
  { key: 'XRSystem.requestSession("immersive-ar")', re: /(?<!isSessionSupported\s*\(\s*)["'`]immersive-ar["'`]|(?<!isSessionSupported\s*\(\s*)\bSessionMode\.ImmersiveAR\b/, strength: 'call' },
  { key: 'XRSystem.isSessionSupported("immersive-ar")', re: /\bisSessionSupported\s*\(\s*(?:["'`]immersive-ar["'`]|SessionMode\.ImmersiveAR\b)/, strength: 'probe' },
];

/** The catalogue used on app source: the bundle catalogue with feature strings and session modes in context, plus IWSDK uses. */
export function appSourceCatalogue(): ScanSignal[] {
  return [...SIGNALS.filter((sig) => !/^XR feature /.test(sig.key) && !/immersive-ar/.test(sig.key)), ...featureSourceSignals(), ...SESSION_MODE_SIGNALS, ...APP_SOURCE_SIGNALS];
}

/** Text of the balanced `{...}` block that starts at `open` (an index of `{`), or '' when unbalanced. */
function braceBlock(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return '';
}

/** Top-level `key: value` pairs of an object literal block (`value` is the raw text up to the next top-level comma). */
function topLevelPairs(block: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const inner = block.slice(1, -1);
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  for (const part of parts) {
    const m = /^\s*["']?([A-Za-z_$][\w$]*)["']?\s*:\s*([\s\S]*?)\s*$/.exec(part);
    if (m) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/** The text with the contents of string and template literals blanked (same length; quotes and `${...}` kept). */
export function maskStrings(src: string): string {
  // one linear pass (no backtracking regex): a quote inside a template literal is template text, an unterminated
  // string or template is left as it is
  const out = src.split('');
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (j < n && src[j] === c) blank(i + 1, j);
      i = j < n && src[j] === c ? j + 1 : i + 1;
    } else if (c === '`') {
      // text parts are blanked; `${...}` (to its matching brace) is kept
      let j = i + 1;
      let textFrom = j;
      const parts: Array<[number, number]> = [];
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '`') {
          parts.push([textFrom, j]);
          closed = true;
          break;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          parts.push([textFrom, j]);
          let depth = 0;
          let k = j + 1;
          for (; k < n; k++) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}' && --depth === 0) break;
          }
          j = k + 1;
          textFrom = j;
        } else j++;
      }
      if (closed) for (const [a, b] of parts) blank(a, b);
      i = closed ? j + 1 : i + 1;
    } else i++;
  }
  return out.join('');
}

/** IWSDK world features (World.create options.features) that end in an absent API. */
const WORLD_FEATURE_KEYS: Record<string, string> = { camera: 'MediaDevices.getUserMedia()' };

/**
 * IWSDK options given in code (`World.create(el, { xr: {...}, features: {...} })`, `launchXR(world, {...})`):
 * the session mode, XR features (required or optional), `xr: false` / `offer: 'none'` (XR-LIFE-7) and world
 * features such as `camera`. Only in files that call into IWSDK's world setup.
 */
export function codeOptionSignals(text: string, rel: string): AppSignal[] {
  if (!/\b(World\.create|initializeWorld|launchXR)\s*\(/.test(text)) return [];
  const out: AppSignal[] = [];
  // a match must be code, not UI text that quotes the option ('XR is off (xr: false)')
  const masked = maskStrings(text);
  const inCode = (i: number) => masked[i] === text[i];
  const at = (i: number, len = 60) => `${rel}:${text.slice(0, i).split('\n').length}: ${text.slice(i, i + len).replace(/\s+/g, ' ').trim()}`;
  // one branch of a ternary (`pureBrowser ? { ...opts, xr: false } : opts`) is a mode the app can be in, not what it is
  const conditional = (i: number) => /\?[^;?]{0,80}$/.test(text.slice(Math.max(0, i - 80), i));
  for (const [re, key] of [[/\bxr\s*:\s*false\b/g, `${NO_XR_ENTRY} (xr: false)`], [/\boffer\s*:\s*["'`]none["'`]/g, `${NO_XR_ENTRY} (offer: none)`]] as Array<[RegExp, string]>) {
    for (const m of text.matchAll(re)) {
      if (!inCode(m.index!) || conditional(m.index!)) continue;
      out.push({ key, origin: 'source', evidence: at(m.index!) });
      break;
    }
  }
  for (const f of text.matchAll(/\bfeatures\s*:\s*\{/g)) {
    if (!inCode(f.index!)) continue;
    const open = f.index! + f[0].length - 1;
    const block = braceBlock(text, open);
    if (!block) continue;
    for (const [name, value] of topLevelPairs(block)) {
      if (/^(false|undefined|null)$/.test(value)) continue;
      const feature = IWSDK_FEATURES[name];
      if (feature) {
        const required = /\brequired\s*:\s*true\b/.test(value);
        out.push({ key: `XR feature ${feature} (${required ? 'required' : 'optional'})`, origin: 'source', evidence: at(f.index!, 120) });
      } else if (WORLD_FEATURE_KEYS[name]) {
        out.push({ key: WORLD_FEATURE_KEYS[name]!, origin: 'source', evidence: `${at(f.index!, 120)} (IWSDK's ${name} feature)` });
      }
    }
  }
  return out;
}

/**
 * `<video>`/`<audio>` playback in app source (DOM-6): an element is made, then that element is played or given a
 * source. Only receivers that hold the element count (a variable or field assigned from `createElement('audio')`
 * / `new Audio(`, or one whose name says it is media), so an element made just for `canPlayType`, a three.js
 * `AnimationAction.play()` or an `img.src =` in the same file are not playback.
 */
function mediaPlaybackSignals(text: string, rel: string): AppSignal[] {
  // `new Audio(listener)` with three.js's Audio imported (or any local class/binding named Audio) is Web Audio
  if (bindsLocally('Audio', text)) text = text.replace(/\bnew(\s+)Audio(\s*)\(/g, 'new$1Au_io$2(');
  const made = /\bcreateElement\(\s*["'`](video|audio)["'`]\s*\)|\bnew\s+Audio\s*\(|<(video|audio)\b/.exec(text);
  if (!made) return [];
  const holders = new Set<string>();
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:document\.createElement\(\s*["'`](?:video|audio)["'`]\s*\)|new\s+Audio\s*\()/g)) holders.add(m[1]!);
  const MEDIA_NAME = /^(?:.*(?:video|audio|sound|music|media|bgm|sfx)\w*|vid|aud)$/i;
  const holds = (receiver: string) => {
    const last = receiver.split('.').pop()!.replace(/\?$/, '');
    return holders.has(last) || MEDIA_NAME.test(last);
  };
  const out: AppSignal[] = [];
  const line = (i: number) => text.slice(0, i).split('\n').length;
  const near = (i: number, after: number) => text.slice(Math.max(0, i - 30), i + after).replace(/\s+/g, ' ').trim();
  const why = ` (after ${made[0]} at line ${line(made.index)})`;
  let play: RegExpExecArray | null = /\bnew\s+Audio\s*\([^)]*\)\s*\.play\s*\(/.exec(text);
  if (!play) for (const m of text.matchAll(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\??\.play\s*\(\s*\)/g)) if (holds(m[1]!)) { play = m; break; }
  if (play) out.push({ key: 'HTMLMediaElement.play()', origin: 'source', evidence: `${rel}:${line(play.index)}: ${near(play.index, 20)}${why}` });
  let src: RegExpExecArray | null = /\bnew\s+Audio\s*\(\s*[^)\s]/.exec(text);
  if (!src) for (const m of text.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(?:src|srcObject)\s*=(?!=)/g)) if (holds(m[1]!)) { src = m; break; }
  if (src) out.push({ key: 'HTMLMediaElement.src=', origin: 'source', evidence: `${rel}:${line(src.index)}: ${near(src.index, 40)}${why}` });
  return out;
}

/**
 * Does the text bind `name` itself (an import, `import { X as name }`, a class/function/const/let/var), so that
 * `new name(` is not the global (three.js's `Audio` is Web Audio, not an `<audio>` element)?
 */
export function bindsLocally(name: string, text: string): boolean {
  const n = name.replace(/\$/g, '\\$');
  if (new RegExp(`\\b(?:class|function\\*?|const|let|var)\\s+${n}\\b|\\bimport\\s+${n}\\s*(?:,|from\\b)`).test(text)) return true;
  for (const m of text.matchAll(/\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\b/g)) {
    for (const spec of m[1]!.split(',')) {
      const parts = spec.trim().split(/\s+as\s+/);
      if ((parts[1] ?? parts[0])?.trim() === name) return true;
    }
  }
  return false;
}

/** Removed interfaces an app reaches through an instance member, and that member (ctx.audioWorklet). */
const INSTANCE_MEMBER: Record<string, string> = { AudioWorklet: 'audioWorklet' };

/** A feature check of an API's global or navigator member (see rootOf), if the text has one. */
export function guardFor(key: string, text: string): RegExpExecArray | null {
  const root = rootOf(key);
  if (!root) return null;
  if (root.global && INSTANCE_MEMBER[root.global]) {
    // `if (ctx.audioWorklet)`, `'audioWorklet' in ctx`, `ctx.audioWorklet?.`, `typeof ctx.audioWorklet`
    const m = INSTANCE_MEMBER[root.global];
    const viaMember = new RegExp(`\\bif\\s*\\(\\s*!?\\s*[\\w$.]+\\.${m}\\s*(?:\\)|&&|\\|\\|)|["'\`]${m}["'\`]\\s+in\\b|\\.${m}\\s*\\?\\.|\\?\\.${m}\\b|\\btypeof\\s+[\\w$.]+\\.${m}\\b|\\.${m}\\s*(?:===|!==|==|!=)\\s*(?:undefined|null)\\b|&&\\s*[\\w$.]+\\.${m}\\s*[)?]`).exec(text);
    if (viaMember) return viaMember;
  }
  // crypto.subtle hangs off the crypto global: `if (crypto.subtle)`, `'subtle' in crypto`, `crypto?.subtle?.x()`
  if (root.global === 'Crypto.subtle') return memberGuard('(?:(?:window|globalThis|self)\\??\\.)?crypto', 'subtle', text);
  if (root.global) {
    const g = root.global.replace(/\$/g, '\\$');
    // `window.X` counts only as a value (`if (window.X)`, `window.X?.open()`), not when it is called or a member of it
    // is used (`window.indexedDB.open()` throws on the headset like the bare form)
    return new RegExp(`\\btypeof\\s+(?:(?:window|globalThis|self)\\.)?${g}\\b|["'\`]${g}["'\`]\\s+in\\b|\\b(?:window|globalThis|self)\\??\\.${g}\\b(?!\\s*(?:\\(|\\.|\\[))|\\b${g}\\s*(?:===|!==|==|!=)\\s*(?:undefined|null)\\b`).exec(text);
  }
  return memberGuard('navigator', root.nav!, text);
}

/** A feature check of member `n` of the object `obj` (a regex source) such as navigator.gpu or crypto.subtle. */
function memberGuard(obj: string, n: string, text: string): RegExpExecArray | null {
  return new RegExp(`["'\`]${n}["'\`]\\s+in\\s+${obj}\\b|\\b${obj}\\??\\.${n}\\s*\\?\\.|\\b${obj}\\?\\.${n}\\b|\\bif\\s*\\(\\s*!?\\s*${obj}\\.${n}\\s*(?:\\)|&&|\\|\\|)|\\b${obj}\\.${n}\\s*(?:===|!==|==|!=)\\s*(?:undefined|null)\\b|\\btypeof\\s+${obj}\\.${n}\\b|&&\\s*${obj}\\.${n}\\s*[)?]`).exec(text);
}

/** Read `world.xr` (and `world.features.camera`) from iwsdk.config.json. */
export function configSignals(projectRoot: string): AppSignal[] {
  const file = path.join(projectRoot, 'iwsdk.config.json');
  if (!existsSync(file)) return [];
  let cfg: { world?: { xr?: unknown; features?: Record<string, unknown> } };
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const out: AppSignal[] = [];
  // world.features.camera: IWSDK's CameraSystem (getUserMedia + enumerateDevices + a <video>); XR-SEC-1
  const cam = cfg.world?.features?.camera;
  if (cam !== undefined && cam !== false && cam !== null)
    out.push({ key: 'MediaDevices.getUserMedia()', origin: 'config', evidence: `iwsdk.config.json world.features.camera = ${JSON.stringify(cam)} (IWSDK's camera feature calls navigator.mediaDevices.getUserMedia)` });
  const xr = cfg.world?.xr as { mode?: unknown; offer?: unknown; features?: Record<string, unknown> } | false | undefined;
  if (xr === false) {
    out.push({ key: `${NO_XR_ENTRY} (xr: false)`, origin: 'config', evidence: 'iwsdk.config.json world.xr = false' });
    return out;
  }
  if (!xr || typeof xr !== 'object') return out;
  if (xr.offer === 'none') out.push({ key: `${NO_XR_ENTRY} (offer: none)`, origin: 'config', evidence: 'iwsdk.config.json world.xr.offer = "none"' });
  const mode = xr.mode === 'ar' ? 'immersive-ar' : xr.mode === 'vr' || xr.mode === undefined ? 'immersive-vr' : String(xr.mode);
  const how = xr.offer === 'none' ? 'requestSession' : 'offerSession';
  out.push({ key: `XRSystem.${how}("${mode}")`, origin: 'config', evidence: `iwsdk.config.json world.xr.mode = ${JSON.stringify(xr.mode ?? 'vr')}` });
  for (const [name, v] of Object.entries(xr.features ?? {})) {
    if (v === false || v === undefined || v === null) continue;
    const feature = IWSDK_FEATURES[name] ?? name;
    const required = typeof v === 'object' && (v as { required?: unknown }).required === true;
    out.push({ key: `XR feature ${feature} (${required ? 'required' : 'optional'})`, origin: 'config', evidence: `iwsdk.config.json world.xr.features.${name} = ${JSON.stringify(v)}` });
  }
  return out;
}

/**
 * Strip comments (block and line) with a small tokenizer that skips string literals, template literals (and
 * their `${...}` code) and regular-expression literals, so `'./icons/*.svg'` or a URL's `//` is not taken for a
 * comment. Newlines inside block comments are kept, so line numbers stay right.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  // template nesting: each entry is the brace depth at which a `${` was opened
  const tpl: number[] = [];
  let depth = 0;
  let prevSig = ''; // last significant (non-space) character emitted, to tell regex from division
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]|^$/;
  const keywordBefore = /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)\s*$/;
  const readString = (q: string) => {
    const start = i;
    i++;
    while (i < n && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
    i++;
    out += src.slice(start, i);
  };
  const readTemplate = () => {
    // at a backtick or at the `}` that closes a `${`; read up to the next backtick or `${`
    const start = i;
    i++;
    while (i < n) {
      if (src[i] === '\\') i += 2;
      else if (src[i] === '`') {
        i++;
        out += src.slice(start, i);
        return;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        out += src.slice(start, i);
        tpl.push(depth);
        depth++;
        return;
      } else i++;
    }
    out += src.slice(start, i);
  };
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? n : end + 2);
      out += body.replace(/[^\n]/g, '').length ? body.replace(/[^\n]/g, '') : ' ';
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      readString(c);
      prevSig = c;
      continue;
    }
    if (c === '`') {
      readTemplate();
      prevSig = '`';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (tpl.length && tpl[tpl.length - 1] === depth - 1) {
        depth--;
        tpl.pop();
        readTemplate();
        prevSig = '`';
        continue;
      }
      depth--;
    }
    if (c === '/' && (regexAllowedAfter.test(prevSig) || keywordBefore.test(out.slice(-12)))) {
      // a regular-expression literal: copy through the closing slash (classes may contain '/')
      const start = i;
      i++;
      let cls = false;
      while (i < n && src[i] !== '\n') {
        const ch = src[i]!;
        if (ch === '\\') i += 2;
        else {
          if (ch === '[') cls = true;
          else if (ch === ']') cls = false;
          else if (ch === '/' && !cls) break;
          i++;
        }
      }
      i++;
      out += src.slice(start, i);
      prevSig = '/x';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

const SCRIPT = /\.(m?[jt]sx?|html)$/i;
const NOT_APP = /\.(test|spec|config)\.|\.d\.ts$/;

function appSourceFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const root = path.resolve(projectRoot);
  const skip = new Set(['node_modules', 'dist', 'dist-metavr', 'build', 'public', '.git', 'test', 'tests', '__tests__', 'coverage']);
  const visit = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const f of names) {
      if (f.startsWith('.') || skip.has(f)) continue;
      const p = path.join(d, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 8) visit(p, depth + 1);
      } else if (SCRIPT.test(f) && !NOT_APP.test(f) && st.size < 2 * 1024 * 1024) out.push(p);
    }
  };
  const src = path.join(root, 'src');
  if (existsSync(src)) visit(src, 0);
  // scripts at the project root (Vite's vanilla layout: main.js next to index.html); config files excluded
  let top: string[] = [];
  try {
    top = readdirSync(root);
  } catch {
    top = [];
  }
  for (const f of top) {
    if (f.startsWith('.') || !/\.m?[jt]sx?$/i.test(f) || NOT_APP.test(f) || /^(vite|vitest|eslint|prettier|babel|webpack|rollup|playwright|jest|postcss|tailwind)\b/.test(f)) continue;
    const p = path.join(root, f);
    try {
      if (statSync(p).isFile() && statSync(p).size < 2 * 1024 * 1024) out.push(p);
    } catch {
      /* skip */
    }
  }
  const index = path.join(root, 'index.html');
  if (existsSync(index)) {
    out.push(index);
    // the entry scripts index.html references (and the directories they live in)
    let html = '';
    try {
      html = readFileSync(index, 'utf8');
    } catch {
      html = '';
    }
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const ref = m[1]!.split(/[?#]/)[0]!;
      if (/^([a-z]+:)?\/\//i.test(ref)) continue;
      const file = path.resolve(root, ref.replace(/^\//, ''));
      if (!file.startsWith(root + path.sep) || /[\\/]node_modules[\\/]/.test(file) || !existsSync(file)) continue;
      const dir = path.dirname(file);
      if (dir !== root && !dir.startsWith(src + path.sep) && dir !== src) visit(dir, 0);
      else out.push(file);
    }
  }
  return [...new Set(out)].sort();
}

/** Signals from the app's own source. */
export function sourceSignals(projectRoot: string, signals: ScanSignal[] = appSourceCatalogue()): AppSignal[] {
  const out = new Map<string, AppSignal>();
  const texts: Array<{ rel: string; text: string }> = [];
  const put = (a: AppSignal) => {
    if (!out.has(a.key)) out.set(a.key, a);
  };
  for (const file of appSourceFiles(projectRoot)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // inline scripts only (an <video> tag in the markup still counts as a media element)
    const html = file.endsWith('.html');
    const markup = html ? text : '';
    if (html) text = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n;\n');
    text = stripComments(text);
    const rel = path.relative(projectRoot, file);
    texts.push({ rel, text });
    for (const sig of signals) {
      if (out.has(sig.key)) continue;
      const m = sig.re.exec(text);
      if (!m) continue;
      // `new Audio(` of a locally bound Audio (three.js) is not the <audio> element
      if (sig.key === 'new Audio' && bindsLocally('Audio', text)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      put({ key: sig.key, origin: 'source', evidence: `${rel}:${line}: ${text.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\s+/g, ' ').trim()}` });
    }
    for (const a of codeOptionSignals(text, rel)) put(a);
    for (const a of mediaPlaybackSignals(html && /<(video|audio)\b/i.test(markup) ? `${text}\n<video>` : text, rel)) put(a);
  }
  // feature checks anywhere in the app's source
  for (const a of out.values()) {
    for (const { rel, text } of texts) {
      const g = guardFor(a.key, text);
      if (!g) continue;
      a.guarded = `${rel}:${text.slice(0, g.index).split('\n').length}: ${text.slice(Math.max(0, g.index - 10), g.index + 50).replace(/\s+/g, ' ').trim()}`;
      break;
    }
  }
  return [...out.values()];
}

/** Config + source signals of an IWSDK project directory. */
export function projectSignals(projectRoot: string): AppSignal[] {
  return [...configSignals(projectRoot), ...sourceSignals(projectRoot)];
}
