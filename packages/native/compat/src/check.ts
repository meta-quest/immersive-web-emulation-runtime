/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The build:metavr compat checker: turns a static scan of the built bundle
 * (and, optionally, a headless trace) into findings with a severity, and says
 * what to do when the app needs something the native runtime does not provide
 * (this alpha has no other route: feature-detect the API or remove it).
 */

import { normaliseKey, scopedKey } from './matrix.ts';
import {
  allowEntryFor,
  AREAS,
  EMBEDDER_HOOKED,
  NAVIGATION_NOTE,
  parseKey,
  policyFor,
  resolve,
  rootOf,
  ruleFor,
  type Area,
  type MeasuredSurface,
  type Status,
} from './providers.ts';
import { NO_XR_ENTRY, type AppSignal } from './project.ts';
import type { ScanResult } from './scan.ts';
import { originAllowed as urlAllowed, type TraceResult } from './trace-run.ts';

export type Severity = 'error' | 'warn' | 'info';

export interface CompatFinding {
  key: string;
  status: Status;
  severity: Severity;
  /**
   * 'trace' (the app called it in the headless run), 'app' (the app's own source or iwsdk.config.json
   * declares it), 'static' (only the bundle mentions it, maybe in library code), 'both' (traced and named statically).
   */
  source: 'trace' | 'static' | 'both' | 'app';
  area: Area;
  spec: string[];
  message: string;
  evidence: string[];
}

export interface CompatReport {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: CompatFinding[];
  /** APIs the app uses that the runtime provides (counts by status). */
  supported: Partial<Record<Status, number>>;
  origins: Array<{
    origin: string;
    allowed: boolean;
    likelyRuntime: boolean;
    count: number;
    example: string;
  }>;
  injectedEmulator: string[];
  trace?: {
    reachedXR: boolean;
    enteredVia: string;
    xrFrames: number;
    pageErrors: string[];
    blockedRequests: string[];
    hung?: string;
    navigations?: number;
  };
  surface: string;
  /** Set when the app needs APIs this runtime version lacks: what to do about them (there is no fallback route). */
  advice?: string;
  /**
   * Removed roots (`Navigator.gpu`, `AudioWorklet`) the app touched while the trimmed run had a TypeError-like page
   * error and no control run settled it yet: the CLI re-runs the trace with each left in place (TraceResult.controls)
   * and evaluates again, so only errors that the removal causes count as an unguarded use.
   */
  controlCandidates?: string[];
}

export interface CompatOptions {
  scan?: ScanResult;
  trace?: TraceResult;
  /** What the app's own source and iwsdk.config.json declare (project.ts). */
  app?: AppSignal[];
  surface: MeasuredSurface;
  /** Where the surface came from ('live', 'snapshot …'). */
  surfaceOrigin?: string;
  /** The app's native.network.allow origins. */
  allow?: string[];
  /** Static 'call' hits of unsupported APIs fail too (default: they warn; only traced use fails). */
  strict?: boolean;
  /**
   * Static signals/origins every IWSDK build carries in dormant library code
   * (data/static-baseline.json). A static-only hit of one of these is info when the bundle mentions it no
   * more often than the baseline builds did (`counts`), and neither the app's own source/config nor the
   * trace shows it.
   */
  baseline?: {
    keys: ReadonlySet<string>;
    origins: ReadonlySet<string>;
    counts?: ReadonlyMap<string, number>;
    iwsdk?: string;
  };
  /** The app's @iwsdk/core version (compared with the baseline's: baselineDrift). */
  iwsdkVersion?: string;
  /**
   * The packer features the app declares (cli.ts declaredFeatures): `passthrough` turns immersive-ar on (XR-AR-1),
   * `camera` getUserMedia (XR-CAM-1).
   */
  declared?: ReadonlySet<string>;
}

/** `1.2.0`, `v1.2.0-rc.1` -> [1, 2, 0]; undefined for anything else (a tag, a path, a placeholder). */
function versionParts(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * The "static baseline version" finding when the app's @iwsdk/core differs from the IWSDK the dormant-library
 * baseline (data/static-baseline.json) was made from. Only an older minor or another major warns: library code
 * that changed between the two can then be reported as the app's own use, or hidden, and the app can update IWSDK.
 * A newer minor, another patch or a prerelease of the same minor is informational, so `--strict` does not fail on
 * an IWSDK release that came out after this @iwer/native. Every message says what the user can do.
 */
export function baselineDrift(
  baseline: string,
  app: string,
): { severity: Severity; message: string } {
  const intro = `the dormant-library baseline was made from IWSDK ${baseline}; this app uses @iwsdk/core ${app}`;
  const trace =
    '`npx iwer-native compat --trace` shows which of these APIs the app really calls';
  const changed =
    "findings about IWSDK library code that changed in between can be reported as the app's own use, or hidden";
  const update = `Update @iwsdk/core and @iwsdk/vite-plugin-dev to ${baseline} or later; until then, ${trace}`;
  const b = versionParts(baseline);
  const a = versionParts(app);
  if (!a || !b)
    return {
      severity: 'info',
      message: `${intro}, which this check cannot compare with it. If a static-only finding looks like IWSDK's own library code, ${trace}`,
    };
  if (a[0] < b[0])
    return {
      severity: 'warn',
      message: `${intro}, an older major version: ${changed}. ${update}`,
    };
  if (a[0] > b[0])
    return {
      severity: 'warn',
      message: `${intro}, a newer major version: ${changed}. A later @iwer/native release can carry a baseline for IWSDK ${a[0]}; until then, ${trace}`,
    };
  if (a[1] < b[1])
    return {
      severity: 'warn',
      message: `${intro}, an older minor version: ${changed}. ${update}`,
    };
  if (a[1] > b[1])
    return {
      severity: 'info',
      message: `${intro}, a newer minor version: library code IWSDK added since is reported as the app's own use when the bundle mentions it; ${trace}`,
    };
  return {
    severity: 'info',
    message: `${intro} (same minor version): library code that changed in between can be reported as the app's own use; ${trace}`,
  };
}

/** IWSDK's default decoder origin (three's Draco decoder and Basis transcoder at `https://unpkg.com/three@0.<r>.0/...`). */
const DECODER_ORIGIN = 'https://unpkg.com';

export const UNSUPPORTED_ADVICE = [
  'This app needs web APIs or XR features that this @iwer/native alpha does not support yet. There is no fallback route:',
  '  - feature-detect the API and take a path without it (absent APIs are undefined on the headset, so',
  "    `if ('X' in window)` / `if (navigator.x)` guards work; out-of-scope stubs throw NotSupportedError), or",
  '  - remove the use, then rebuild and run the check again.',
  'The support matrix in the @iwer/native README lists what this version provides.',
].join('\n');

const STATUS_MESSAGE: Record<Status, string> = {
  unsupported: 'not provided by @iwer/native',
  gap: 'specified but not implemented in this runtime version yet',
  later: 'planned for a later release',
  config: 'needs app configuration',
  partial: 'only partly provided',
  'in-source': 'in the runtime source but not in a built layer',
  inert: 'accepted but inert on the headset',
  'absent-ok':
    'absent on the headset; the app only probes it, so its fallback path runs',
  iwer: 'provided by IWER host mode',
  provided: 'provided',
  v8: 'provided by V8',
};

function severityFor(
  status: Status,
  u: { traced: boolean; app: boolean; strength: 'call' | 'probe' },
  strict: boolean,
  stub: boolean,
): Severity {
  const call = u.strength === 'call' || u.app;
  switch (status) {
    case 'unsupported':
      if (u.traced && u.strength === 'call') return 'error';
      if (u.traced) return 'info';
      return call ? (strict ? 'error' : 'warn') : 'info';
    case 'gap':
    case 'later':
      return u.traced || call ? 'warn' : 'info';
    case 'config':
      return 'warn';
    case 'partial':
      // a stub the app really calls warns; an instance field or a related-interface match is informational
      return stub && (u.traced || u.app) ? 'warn' : 'info';
    case 'inert':
      // the app's own code creating a <video>/<audio>: it will never play on the headset
      return u.app ? 'warn' : 'info';
    default:
      return 'info';
  }
}

/** TypeError-like messages of a use of something undefined. */
const UNDEFINED_USE =
  /Cannot read properties of undefined|is undefined|undefined is not an object|is not a function|is not a constructor/;

/** `TypeError: navigator.share is not a function`, `TypeError: window.WebSocket is not a constructor`: the expression. */
const NOT_CALLABLE =
  /^(?:Uncaught )?TypeError: (?:(?:window|self|globalThis)\??\.)?((?:navigator\??\.)?[A-Za-z_$][\w$]*) is not a (?:function|constructor)\b/;

/** A page error's identity across runs: first line plus top app frame, without the per-run server origin. */
export function errorSignature(e: string): string {
  const strip = (x: string) =>
    x.replace(/\b[a-z-]+:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/g, '');
  const lines = e.split('\n');
  const frame = lines.slice(1).find((l) => /^\s*at /.test(l)) ?? '';
  return `${strip(lines[0] ?? '')} @ ${strip(frame.trim())}`;
}

/** An origin (`https://host[:port]`, `wss://host`) against native.network.allow (exact, or `https://*.host`). */
function originAllowed(origin: string, allow: string[]): boolean {
  return urlAllowed(origin, allow);
}

export function evaluateCompat(opts: CompatOptions): CompatReport {
  const allow = opts.allow ?? [];
  const strict = opts.strict ?? false;
  const ctx = { declared: opts.declared };
  type Use = {
    traced: boolean;
    app: boolean;
    inDist: boolean;
    distCount: number;
    strength: 'call' | 'probe';
    evidence: string[];
    guarded?: string;
  };
  const byKey = new Map<string, Use>();
  const add = (
    key: string,
    source: 'trace' | 'static' | 'app',
    strength: 'call' | 'probe',
    ev: string,
    count = 0,
    guarded?: string,
  ) => {
    const k = normaliseKey(key);
    let cur = byKey.get(k);
    if (!cur) {
      cur = {
        traced: false,
        app: false,
        inDist: false,
        distCount: 0,
        strength,
        evidence: [],
      };
      byKey.set(k, cur);
    }
    if (guarded && !cur.guarded) cur.guarded = guarded;
    if (source === 'trace') {
      // a traced call outranks a traced probe of the same key
      if (!cur.traced) cur.strength = strength;
      else if (strength === 'call') cur.strength = 'call';
      cur.traced = true;
    } else {
      if (source === 'app') cur.app = true;
      else {
        cur.inDist = true;
        cur.distCount += count;
      }
      if (!cur.traced && strength === 'call') cur.strength = 'call';
    }
    if (cur.evidence.length < 4) cur.evidence.push(ev);
  };
  const label = (u: Use): CompatFinding['source'] =>
    u.traced
      ? u.inDist || u.app
        ? 'both'
        : 'trace'
      : u.app
        ? 'app'
        : 'static';
  if (opts.trace) {
    const dumps = [opts.trace.main, ...opts.trace.workers];
    for (const d of dumps) {
      if (!d) continue;
      for (const [k, r] of Object.entries(d.apis)) {
        if (r.app <= 0) continue;
        const p = parseKey(k);
        const strength =
          p.kind === 'probe' || p.kind === 'global' || p.kind === 'get'
            ? 'probe'
            : 'call';
        add(
          scopedKey(k, d.role),
          'trace',
          strength,
          `trace: ${r.calls} call(s)${r.site ? ` at ${r.site}` : ''}${d.role === 'worker' ? ' (worker)' : ''}`,
        );
      }
    }
  }
  for (const a of opts.app ?? [])
    add(a.key, 'app', 'call', `app ${a.origin}: ${a.evidence}`, 0, a.guarded);
  // what the headset trim removed in the trace, and what the app probed of it (miss:Navigator.gpu, ...)
  const removed = new Set<string>();
  const probedByApp = new Set<string>();
  /** Navigator.gpu -> the app sites where the miss probe fired (`/assets/main.js:11:30`). */
  const missSites = new Map<string, string[]>();
  const traceRan = !!opts.trace?.main && !opts.trace.hung;
  if (opts.trace) {
    for (const d of [opts.trace.main, ...opts.trace.workers]) {
      if (!d) continue;
      for (const r of d.removed ?? []) removed.add(r);
      for (const [k, r] of Object.entries(d.apis)) {
        if (r.app <= 0) continue;
        const m =
          /^miss:(?:(?:Navigator|WorkerNavigator)\.)?([\w$]+)(?: \(in, (?:Navigator|WorkerNavigator) chain\))?$/.exec(
            k,
          );
        if (m && (k.includes('Navigator') || k.includes('(in,'))) {
          probedByApp.add(`Navigator.${m[1]}`);
          if (r.site)
            missSites.set(`Navigator.${m[1]}`, [
              ...(missSites.get(`Navigator.${m[1]}`) ?? []),
              r.site,
            ]);
        }
      }
    }
    for (const r of opts.trace.removed ?? []) removed.add(r);
  }
  const rootName = (key: string) => {
    const root = rootOf(key);
    return root
      ? root.nav
        ? `Navigator.${root.nav}`
        : root.global!
      : undefined;
  };
  const erroredOn = (name: string) =>
    (opts.trace?.pageErrors ?? []).find((e) =>
      new RegExp(
        `\\b${name.replace(/^Navigator\./, '').replace(/\$/g, '\\$')}\\b`,
      ).test(e.split('\n')[0] ?? ''),
    );
  for (const h of opts.scan?.hits ?? [])
    add(
      h.key,
      'static',
      h.strength,
      `static: ${h.count}× in ${h.files
        .map((f) => f.file)
        .slice(0, 2)
        .join(', ')}: …${h.files[0]?.excerpt ?? ''}…`,
      h.count,
    );
  // The miss probe fires on every read of a removed navigator member, guarded (`if (navigator.gpu)`) or not
  // (`navigator.gpu.requestAdapter()`). An unguarded read throws on the next member ("Cannot read properties of
  // undefined (reading 'requestAdapter')"), whose message does not name the root, so a miss counts as a feature
  // check only when no page error reads a member of that root or has its top frame at a miss site.
  const topFrame = (e: string) => {
    const m =
      /\n\s*at (?:[^\n(]*\()?(?:[a-z-]+:\/\/[^/\s)]+)?(\/[^\s):]*):(\d+):(\d+)\)?/.exec(
        e,
      );
    return m
      ? { file: m[1]!, line: Number(m[2]), col: Number(m[3]) }
      : undefined;
  };
  const membersOf = (root: string) => {
    const leaf = root.replace(/^Navigator\./, '');
    const out = new Set<string>();
    for (const k of byKey.keys()) {
      if (rootName(k) !== root) continue;
      const p = parseKey(k);
      if (p.member && p.member !== leaf && p.kind !== 'probe')
        out.add(p.member);
    }
    return out;
  };
  const controlFor = (root: string) =>
    opts.trace?.controls?.find((c) => c.kept === root && !c.hung);
  const unguardedHit = (root: string): string | undefined => {
    const ctl = controlFor(root);
    if (ctl) {
      // the control run left the root in place: an undefined-use error it did not have is caused by removing it
      const left = new Map<string, number>();
      for (const e of ctl.pageErrors)
        left.set(errorSignature(e), (left.get(errorSignature(e)) ?? 0) + 1);
      return (opts.trace?.pageErrors ?? []).find((e) => {
        const sig = errorSignature(e);
        const n = left.get(sig) ?? 0;
        if (n > 0) {
          left.set(sig, n - 1);
          return false;
        }
        return UNDEFINED_USE.test(e.split('\n')[0] ?? '');
      });
    }
    const members = membersOf(root);
    if (!root.startsWith('Navigator.')) {
      // a removed interface reached through an instance member (ctx.audioWorklet.addModule): no miss probe there,
      // so only an error that reads one of the members the app uses counts
      if (!members.size) return undefined;
      return (opts.trace?.pageErrors ?? []).find((e) => {
        const first = e.split('\n')[0] ?? '';
        const reading =
          /Cannot read properties of undefined \(reading '([\w$]+)'\)/.exec(
            first,
          )?.[1];
        return !!reading && members.has(reading);
      });
    }
    if (!probedByApp.has(root)) return undefined;
    const sites = (missSites.get(root) ?? [])
      .map((s) => /^(.*):(\d+):(\d+)$/.exec(s))
      .filter((m): m is RegExpExecArray => !!m);
    return (opts.trace?.pageErrors ?? []).find((e) => {
      const first = e.split('\n')[0] ?? '';
      if (
        !/Cannot read properties of undefined|is undefined|undefined is not an object/.test(
          first,
        )
      )
        return false;
      const reading = /reading '([\w$]+)'/.exec(first)?.[1];
      if (reading && members.has(reading)) return true;
      // other engines name the undefined expression ("navigator.gpu is undefined")
      if (first.includes(`${root.replace(/^Navigator\./, '')} is undefined`))
        return true;
      const f = topFrame(e);
      // same file and line as a miss site, a little to the right of it (the next member access)
      return (
        !!f &&
        sites.some(
          (m) =>
            (f.file === m[1] ||
              f.file.endsWith(m[1]!) ||
              m[1]!.endsWith(f.file)) &&
            f.line === Number(m[2]) &&
            f.col >= Number(m[3]) &&
            f.col - Number(m[3]) <= 160,
        )
      );
    });
  };
  const hits = new Map<string, string>();
  const candidates = new Set<string>(probedByApp);
  for (const k of byKey.keys()) {
    const r = rootName(k);
    if (r) candidates.add(r);
  }
  const controlCandidates: string[] = [];
  const undefinedUse = (opts.trace?.pageErrors ?? []).some((e) =>
    UNDEFINED_USE.test(e.split('\n')[0] ?? ''),
  );
  if (opts.trace && traceRan)
    for (const root of candidates) {
      // a removed global the app reaches only through an instance member (ctx.audioWorklet -> AudioWorklet)
      const viaMember =
        !root.includes('.') &&
        [...removed].some(
          (r) =>
            r.includes('.') &&
            !/^(Navigator|WorkerNavigator)\./.test(r) &&
            r.slice(r.indexOf('.') + 1).toLowerCase() === root.toLowerCase(),
        );
      if (!removed.has(root) && !viaMember) continue;
      // a removed global used bare throws ReferenceError (reported exactly below); only member reads need a control
      if (
        undefinedUse &&
        (root.includes('.') || viaMember) &&
        !controlFor(root)
      )
        controlCandidates.push(root);
      const e = unguardedHit(root);
      if (e) hits.set(root, e);
    }

  // an absent-by-design root the trim had nothing to remove (navigator.share: headless Chromium on Linux never had
  // it) or that the app reaches as `window.X` (`new window.WebSocket()`, no ReferenceError): the TypeError names it
  /** Roots whose hit is a TypeError naming the root itself (`navigator.share is not a function`). */
  const named = new Set<string>();
  if (opts.trace && traceRan)
    for (const e of opts.trace.pageErrors) {
      const m = NOT_CALLABLE.exec(e.split('\n')[0] ?? '');
      if (!m) continue;
      const expr = m[1]!.replace(/\?\./g, '.');
      const root = expr.startsWith('navigator.')
        ? `Navigator.${expr.slice('navigator.'.length)}`
        : expr;
      if (hits.has(root) || policyFor(ruleFor(root), ctx) !== 'absent')
        continue;
      const r = resolve(parseKey(root), opts.surface, ctx);
      if (r.status === 'unsupported' || r.status === 'absent-ok') {
        hits.set(root, e);
        named.add(root);
      }
    }

  /** A feature check of the root in the app's own source (project.ts guardFor), if any. */
  const guardOfRoot = (root: string) =>
    [...byKey].find(([k, u]) => u.guarded && rootName(k) === root)?.[1].guarded;
  const findings: CompatFinding[] = [];
  const supported: Partial<Record<Status, number>> = {};
  // WebAssembly.instantiateStreaming/compileStreaming: absent on the headset until the runtime installs V8's
  // streaming hook (NET-10). When every file of the bundle that calls it also checks for it (Emscripten's and
  // IWSDK's `typeof WebAssembly.instantiateStreaming == "function"`), the WebAssembly.instantiate fallback runs: the
  // static check and the trace (where headless Chromium has it, so the guarded call goes through) report it the
  // same way, as info.
  const wasmStreaming = opts.scan?.hits.find(
    (h) => h.key === 'WebAssembly.instantiateStreaming()',
  );
  const wasmStreamingGuarded = wasmStreaming?.strength === 'probe';
  for (const [key, u] of byKey) {
    const p = parseKey(key);
    const r = resolve(p, opts.surface, ctx);
    if (
      wasmStreamingGuarded &&
      !u.app &&
      r.status === 'gap' &&
      EMBEDDER_HOOKED.test(p.base)
    ) {
      findings.push({
        key,
        status: r.status,
        severity: 'info',
        source: label(u),
        area: r.area,
        spec: r.spec,
        message: `not provided by @iwer/native yet (the runtime does not install V8's wasm streaming hook); the bundle feature-detects it, so it falls back to WebAssembly.instantiate, which works on the headset`,
        evidence: u.evidence,
      });
      continue;
    }
    if (r.status === 'config' && p.arg) {
      const origin = p.arg.split(' ')[1] ?? '';
      if (originAllowed(origin, allow)) {
        supported.provided = (supported.provided ?? 0) + 1;
        continue;
      }
    }
    if (['provided', 'iwer', 'v8'].includes(r.status)) {
      supported[r.status] = (supported[r.status] ?? 0) + 1;
      continue;
    }
    const base = opts.baseline;
    const dormant =
      !u.traced &&
      !u.app &&
      !!base?.keys.has(key) &&
      (base.counts?.get(key) === undefined ||
        u.distCount <= base.counts.get(key)!);
    let severity: Severity = dormant
      ? 'info'
      : severityFor(r.status, u, strict, !!r.stub);
    // an immersive-ar string in the bundle only (no request traced or in the app's own code or config): a mention,
    // not a request, so the passthrough declaration it would need is informational
    if (
      r.status === 'config' &&
      /\("immersive-ar"\)$/.test(key) &&
      !u.traced &&
      !u.app &&
      u.strength === 'probe'
    )
      severity = 'info';
    // an absent-by-design API the app names but did not call in the trace: was it feature-detected?
    let guardNote = '';
    const hitRoot = rootName(key);
    if (
      hitRoot &&
      hits.has(hitRoot) &&
      (r.status === 'unsupported' || r.status === 'absent-ok')
    ) {
      // reported once, as an error, by the "<root> (used without a feature check)" finding below
      severity = 'info';
      const without = `the headless run (with ${shownRoot(hitRoot)} ${removed.has(hitRoot) ? 'removed' : 'absent'}, as on the headset)`;
      guardNote = guardOfRoot(hitRoot)
        ? `; the app checks for it somewhere, but ${without} threw: see "${fallbackKey(hitRoot)}"`
        : `; ${without} threw on an unguarded use: see "${unguardedKey(hitRoot)}"`;
    } else if (r.status === 'unsupported' && r.stub && severity !== 'info') {
      // a stub is present on the headset: feature checks see it, so a guard does not route around it
      guardNote =
        '; a feature check does not help here (the stub is present on the headset), so do not call it';
    } else if (
      r.status === 'unsupported' &&
      !(u.traced && u.strength === 'call') &&
      severity !== 'info'
    ) {
      const root = rootName(key);
      const removedInTrace = !!root && removed.has(root);
      // with a control run for the root, "not hit" is exact; without one, no page error names the root
      const notHit =
        traceRan &&
        removedInTrace &&
        (controlFor(root!) ? !hits.has(root!) : !erroredOn(root!));
      const guard =
        u.guarded ??
        (root && probedByApp.has(root)
          ? `the headless run saw the app probe ${root.replace(/^Navigator\./, 'navigator.')}`
          : undefined);
      if (guard && (notHit || !opts.trace)) {
        severity = 'info';
        guardNote = `; feature-detected (${guard}), so on the headset the app's fallback runs${notHit ? ', as it did in the headless run with it removed' : ''}`;
      } else if (notHit) {
        guardNote = `; the headless run (with ${root} removed, as on the headset) did not reach it, but no feature check was found: make sure the app tests for it before use`;
      }
    }
    findings.push({
      key,
      status: r.status,
      severity,
      source: label(u),
      area: r.area,
      spec: r.spec,
      message: key.startsWith(NO_XR_ENTRY)
        ? `no immersive session on the headset: ${r.note}`
        : `${hitRoot && hits.has(hitRoot) && r.status === 'absent-ok' ? 'absent on the headset' : STATUS_MESSAGE[r.status]}${r.note ? ` (${r.note})` : ''}${dormant ? '; library code every IWSDK build carries, static mention only' : ''}${guardNote}`,
      evidence: u.evidence,
    });
  }
  for (const [root, e] of hits) {
    const p = parseKey(root);
    const r = resolve(p, opts.surface, ctx);
    const nav = shownRoot(root);
    const test = root.includes('.')
      ? `if (${nav})`
      : `typeof ${root} !== 'undefined'`;
    // the app's own source checks for the root somewhere. Which code threw is not known here (a use outside that
    // check, or the branch the app takes without the API), so the message names both; the evidence has the frame
    const guard = guardOfRoot(root);
    findings.push({
      key: guard ? fallbackKey(root) : unguardedKey(root),
      status: 'unsupported',
      severity: 'error',
      source: 'trace',
      area: r.area,
      spec: r.spec,
      message:
        guard && named.has(root)
          ? `not provided by @iwer/native${r.note ? ` (${r.note})` : ''}; the app checks for it (${guard}), but a use of ${nav} outside that check threw in the headless run (${nav} absent, as on the headset; the evidence shows where): put every use behind the check`
          : guard
            ? `not provided by @iwer/native${r.note ? ` (${r.note})` : ''}; the app checks for it (${guard}), but in the headless run with ${nav} removed, as on the headset, it threw (an error the run with it left in place did not have; the evidence shows where). Either a use of ${nav} outside that check or the branch the app takes without it threw: put every use behind the check and fix that branch`
            : `not provided by @iwer/native${r.note ? ` (${r.note})` : ''}; ${removed.has(root) ? `the headless run removed ${nav}, as the headset lacks it` : `the headset lacks ${nav} (so did the headless browser)`}, and the app used it without a check, so it threw. Test for it first (\`${test}\`) or drop it`,
      evidence: [
        e.slice(0, 400),
        ...(missSites.get(root) ?? [])
          .slice(0, 2)
          .map((s) => `trace: app read ${nav} at ${s}`),
      ],
    });
  }
  if (
    opts.baseline?.iwsdk &&
    opts.iwsdkVersion &&
    opts.baseline.iwsdk !== opts.iwsdkVersion
  ) {
    const drift = baselineDrift(opts.baseline.iwsdk, opts.iwsdkVersion);
    findings.push({
      key: 'static baseline version',
      status: 'gap',
      severity: drift.severity,
      source: 'static',
      area: 'none',
      spec: [],
      message: drift.message,
      evidence: [
        `baseline: IWSDK ${opts.baseline.iwsdk}; app: @iwsdk/core ${opts.iwsdkVersion}`,
      ],
    });
  }
  // the app feature-detects WebSocket (its `new WebSocket` finding went to info as feature-detected): the URL it
  // names is then only reached where WebSocket exists, so the "feature-detect it" origin advice is moot
  const wsGuarded =
    findings.some(
      (f) =>
        /^new WebSocket\b/.test(f.key) &&
        f.severity === 'info' &&
        f.message.includes('feature-detected'),
    ) &&
    !findings.some(
      (f) =>
        /^new WebSocket\b|^WebSocket\b/.test(f.key) && f.severity !== 'info',
    );
  const origins = (opts.scan?.origins ?? []).map((o) => ({
    origin: o.origin,
    allowed: originAllowed(o.origin, allow),
    likelyRuntime: o.likelyRuntime,
    count: o.count,
    example: o.example,
  }));
  const compressed = opts.scan?.compressedAssets;
  for (const o of origins) {
    if (o.allowed) continue;
    if (
      o.origin === DECODER_ORIGIN &&
      compressed &&
      (compressed.ktx2.length || compressed.draco.length)
    ) {
      // the bundle carries IWSDK's default decoder URL and dist/ has assets that need it: on the headset the
      // decoder fetch is blocked (NET-5) and those assets fail to load
      const what = [
        compressed.ktx2.length
          ? `${compressed.ktx2.length} KTX2/Basis asset(s)`
          : '',
        compressed.draco.length
          ? `${compressed.draco.length} Draco mesh(es)`
          : '',
      ]
        .filter(Boolean)
        .join(' and ');
      findings.push({
        key: `network ${o.origin}`,
        status: 'config',
        severity: 'warn',
        source: 'static',
        area: 'net',
        spec: ['NET-5'],
        message: `dist/ has ${what}; IWSDK loads their decoder from ${o.origin} by default (dracoDecoderPath / ktx2TranscoderPath), which is not in native.network.allow, so they fail to load on the headset. Add ${o.origin} to native.network.allow, or bundle the decoders and point those paths at them`,
        evidence: [
          o.example,
          ...[...compressed.ktx2, ...compressed.draco].slice(0, 3),
        ],
      });
      continue;
    }
    if (opts.baseline?.origins.has(o.origin)) {
      // every IWSDK build names it in library code; reported (hidden unless --verbose) rather than dropped
      findings.push({
        key: `network ${o.origin}`,
        status: 'config',
        severity: 'info',
        source: 'static',
        area: 'net',
        spec: ['NET-5'],
        message: `named in library code every IWSDK build carries; if the app makes it fetch from ${o.origin}, add it to native.network.allow`,
        evidence: [o.example],
      });
      continue;
    }
    findings.push({
      key: `network ${o.origin}`,
      status: 'config',
      severity:
        o.likelyRuntime && !(wsGuarded && /^wss?:/.test(o.origin))
          ? 'warn'
          : 'info',
      source: 'static',
      area: 'net',
      spec: ['NET-5'],
      message: o.likelyRuntime
        ? /^wss?:/.test(o.origin)
          ? wsGuarded
            ? `the bundle names a WebSocket URL (${o.origin}); WebSocket is absent in this alpha and the app feature-detects it, so it takes its path without it on the headset`
            : `the bundle names a WebSocket URL (${o.origin}); WebSocket is not supported in this alpha (absent on the headset), so feature-detect it (\`typeof WebSocket !== 'undefined'\`) or drop it`
          : `the bundle loads from ${o.origin}, which is not in native.network.allow: requests to it fail on the headset. Add it, or bundle the files.`
        : `the bundle names ${o.origin} (not a known asset URL; maybe a link or a namespace); if the app fetches from it, add it to native.network.allow`,
      evidence: [o.example],
    });
  }
  for (const blocked of opts.trace?.blockedRequests ?? []) {
    const origin = blocked.split(' ')[0]!;
    if (originAllowed(origin, allow)) continue;
    const known = findings.find((f) => f.key === `network ${origin}`);
    if (known) {
      known.severity = 'warn';
      known.source = 'both';
      continue;
    }
    findings.push({
      key: `network ${origin}`,
      status: 'config',
      severity: 'warn',
      source: 'trace',
      area: 'net',
      spec: ['NET-5'],
      message: /^wss?:/.test(origin)
        ? `the app opened a WebSocket to ${blocked} during the headless run; WebSocket is not supported in this alpha (absent on the headset)`
        : `the app requested ${blocked} during the headless run; native.network.allow does not cover it (add ${allowEntryFor(origin)})`,
      evidence: [blocked],
    });
  }
  for (const inj of opts.scan?.injectedEmulator ?? []) {
    findings.push({
      key: 'injected WebXR emulator',
      status: 'unsupported',
      severity: 'error',
      source: 'static',
      area: 'iwer',
      spec: ['PKG-6', 'GAP-7'],
      message:
        'a WebXR emulator is bundled into the build; it would take over navigator.xr on the headset. Build with `npm run build:metavr` (vite build --mode metavr, which leaves the emulator out whatever dev.emulator.injectOnBuild says), or set dev.emulator.injectOnBuild to false in iwsdk.config.json, then rebuild.',
      evidence: [inj],
    });
  }
  for (const d of opts.scan?.devServerUrls ?? [])
    findings.push({
      key: `dev-server URL in ${d.file}`,
      status: 'config',
      severity: 'warn',
      source: 'static',
      area: 'net',
      spec: ['XR-LIFE-7'],
      message: `the build names ${d.url}${d.count > 1 ? ` (+${d.count - 1} more)` : ''}, a Vite dev-server /@fs/ path: there is no dev server in the APK, so the request 404s and an app that needs the file never offers XR. The asset base points at the dev server's /@fs/ path (a file outside the project root resolved during dev); build with a relative base (Vite \`base: './'\`) and import the asset or copy it into public/, then rebuild`,
      evidence: [`${d.file}: ${d.url}`],
    });
  for (const u of opts.scan?.unreadable ?? [])
    findings.push({
      key: `unreadable file ${u}`,
      status: 'gap',
      severity: 'warn',
      source: 'static',
      area: 'none',
      spec: [],
      message:
        'could not be read (a dangling link?); it was not scanned, and pack will fail on it',
      evidence: [u],
    });
  for (const u of opts.trace?.unreadableAssets ?? [])
    if (
      !findings.some(
        (f) =>
          f.key === `unreadable file ${u.split(':')[0]!.replace(/^\//, '')}`,
      )
    )
      findings.push({
        key: `unreadable file ${u.split(':')[0]!.replace(/^\//, '')}`,
        status: 'gap',
        severity: 'warn',
        source: 'trace',
        area: 'none',
        spec: [],
        message:
          'the app requested it in the headless run but it could not be read; pack will fail on it',
        evidence: [u],
      });
  if (opts.trace) {
    // an absent-by-design global the trim removed and the app used without a check: it threw, as it would on the headset
    for (const e of opts.trace.pageErrors) {
      const m = /ReferenceError: ([\w$]+) is not defined/.exec(e);
      if (
        !m ||
        !removed.has(m[1]!) ||
        findings.some((f) => f.key.startsWith(`${m[1]} `))
      )
        continue;
      const rule = ruleFor(m[1]!);
      findings.push({
        key: `${m[1]} (used without a feature check)`,
        status: 'unsupported',
        severity: 'error',
        source: 'trace',
        area: rule?.area ?? 'none',
        spec: rule?.spec ?? [],
        message: `not provided by @iwer/native${rule?.note ? ` (${rule.note})` : ''}; the headless run removed it, as the headset lacks it, and the app threw ReferenceError. Test for it first (\`typeof ${m[1]} !== 'undefined'\`) or drop it`,
        evidence: [e.slice(0, 400)],
      });
    }
    const removedMembers = [...removed].filter((r) =>
      /^(Navigator|Crypto)\./.test(r),
    );
    for (const e of opts.trace.pageErrors.slice(0, 5)) {
      const first = e.split('\n')[0]!.slice(0, 200);
      // reading a member of something the trim removed (crypto.subtle.digest, navigator.gpu.requestAdapter)
      const hint =
        /Cannot read properties of undefined|is undefined|undefined is not an object/.test(
          first,
        ) && removedMembers.length
          ? ` (the headless run removed what the headset lacks, including ${removedMembers
              .sort()
              .slice(0, 20)
              .map((r) =>
                r
                  .replace(/^Navigator\./, 'navigator.')
                  .replace(/^Crypto\./, 'crypto.'),
              )
              .join(
                ', ',
              )}; an unguarded use of one throws like this on the headset too)`
          : '';
      findings.push({
        key: 'uncaught error (headless run)',
        status: 'gap',
        severity: 'warn',
        source: 'trace',
        area: 'none',
        spec: ['PROC-9'],
        message: `${first}${hint}`,
        evidence: [e.slice(0, 400)],
      });
    }
    for (const e of opts.trace.sessionEnds ?? [])
      findings.push({
        key: 'session ended during the scripted input (headless run)',
        status: 'gap',
        severity: 'info',
        source: 'trace',
        area: 'none',
        spec: [],
        message: `${e}; the run re-entered XR where it could, so later input steps may be missing from the trace`,
        evidence: [e],
      });
    const navs = opts.trace.navigations ?? [];
    if (navs.length) {
      const cross = navs.filter((n) => !n.sameOrigin);
      const lost = !opts.trace.main;
      findings.push({
        key: 'page navigation (headless run)',
        status: cross.length ? 'later' : 'gap',
        severity: 'warn',
        source: 'trace',
        area: 'glue',
        spec: cross.length ? ['DOM-5', 'DOM-3'] : ['DOM-5', 'PROC-8'],
        message: `${cross.length ? `the app navigated the page to ${cross[0]!.url}${cross.length > 1 ? ` (+${cross.length - 1} more)` : ''} (location.href/assign/replace, a link or an OAuth redirect); ${NAVIGATION_NOTE}.` : `the app reloaded or navigated within its own origin (${navs[0]!.url}); on the headset same-document assign/replace reload the app (PROC-8).`}${lost ? " The trace is incomplete: the page the tracer ran in was gone when the run ended, so none of the app's API use was recorded; remove or gate the navigation and run the check again" : navs.length > cross.length ? ' The trace is incomplete: API use recorded before the reload is missing from this report' : ' The run cancelled the navigation, as the headset does, and went on tracing'}`,
        evidence: navs
          .slice(0, 4)
          .map(
            (n) =>
              `navigation: ${n.url}${n.sameOrigin ? ' (same origin)' : ''}`,
          ),
      });
    }
    if (opts.trace.hung)
      findings.push({
        key: 'main thread stopped answering (headless run)',
        status: 'gap',
        // before XR, the run never got there: fails like "no XR session" (XR-LIFE-7)
        severity: opts.trace.reachedXR ? 'warn' : 'error',
        source: 'trace',
        area: 'none',
        spec: ['PROC-9'],
        message: `${opts.trace.hung}; the run was cut short, so later API use is missing from the trace. On the headset a main thread that never yields freezes the app the same way`,
        evidence: [opts.trace.hung],
      });
    if (!opts.trace.reachedXR && !opts.trace.hung) {
      const blocked = opts.trace.blockedRequests.filter(
        (b) => !originAllowed(b.split(' ')[0]!, allow),
      );
      const appKeys = new Set<string>();
      for (const d of [opts.trace.main, ...opts.trace.workers])
        for (const [k, r] of Object.entries(d?.apis ?? {}))
          if (r.app > 0) appKeys.add(k);
      const askedAR = [...appKeys].some((k) =>
        /XRSystem\.(requestSession|offerSession)\("immersive-ar"\)/.test(k),
      );
      const touchedXR = [...appKeys].some((k) =>
        /^(Navigator\.xr|XRSystem\.|miss:Navigator\.xr|miss:xr \(in)/.test(k),
      );
      const secs = Math.round((opts.trace.bootTimeoutMs ?? 25_000) / 1000);
      let why: string;
      let spec = ['XR-LIFE-7'];
      const noEntry = (opts.app ?? []).find((a) =>
        a.key.startsWith(NO_XR_ENTRY),
      );
      if (noEntry) {
        why = `as the app's own ${noEntry.origin === 'config' ? 'config' : 'code'} says (${noEntry.evidence}), it does not offer a session; see the "${noEntry.key}" finding`;
        spec = ['XR-LIFE-7'];
      } else if (askedAR && !opts.trace.emulateAR) {
        why =
          'the app asked for an immersive-ar session, which the headset offers only to apps that declare passthrough (the headless device is set up the same way), so it got none';
        spec = ['XR-AR-1'];
      } else if (blocked.length) {
        why = `the run blocked ${blocked.length} cross-origin request(s) (${blocked.slice(0, 2).join(', ')}); if the app needs them to boot it fails the same way on the headset. Add the origin to native.network.allow (the trace then lets it through), or pass --mirror <url-prefix>=<dir> to serve a local copy`;
      } else if (!touchedXR && opts.trace.pageErrors.length) {
        why = `the app threw before it got to XR (first uncaught error: ${opts.trace.pageErrors[0]!.split('\n')[0]!.slice(0, 160)}); see the uncaught-error finding`;
        spec = ['PROC-9'];
      } else if (!touchedXR || opts.trace.stillLoading) {
        why = `the app was most likely still loading when the ${secs} s boot timeout ran out (${!touchedXR ? 'it had not touched navigator.xr yet' : opts.trace.stillLoading}; headless Chromium renders with SwiftShader, so heavy apps load slowly): re-run with a longer --boot-ms (e.g. --boot-ms 90000) before reading this as an app problem`;
        spec = [];
      } else {
        why = `the app touched navigator.xr and had gone quiet, but no "Enter XR" button was found either; on the headset it would sit in the idle presentation (if the app is just slow to load, re-run with a longer --boot-ms)`;
      }
      // the runtime only shows WebXR content (XR-LIFE-7): a run that never got to XR fails the check
      findings.push({
        key: 'no XR session (headless run)',
        status: 'gap',
        severity: 'error',
        source: 'trace',
        area: 'none',
        spec,
        message: `no immersive session was offered or requested within the ${secs} s boot timeout: ${why}. The XR-phase API use was not checked`,
        evidence: [`entered via: ${opts.trace.enteredVia}`],
      });
    }
  }
  const order: Severity[] = ['error', 'warn', 'info'];
  findings.sort(
    (a, b) =>
      order.indexOf(a.severity) - order.indexOf(b.severity) ||
      a.key.localeCompare(b.key),
  );
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;
  const needsAdvice = findings.some(
    (f) =>
      // a missing API the app calls (the emulator is a build setting; unreadable files are not about APIs)
      (f.severity === 'error' &&
        f.status === 'unsupported' &&
        f.key !== 'injected WebXR emulator') ||
      // the app itself (source, config or trace) needs what the runtime lacks today: AR, required scene features,
      // media and camera
      (f.severity !== 'info' &&
        f.source !== 'static' &&
        (f.status === 'unsupported' ||
          (f.status === 'later' && /immersive-ar|\(required\)/.test(f.key)))) ||
      // a desktop-first app (XR-LIFE-7): it never enters XR on the headset
      f.key.startsWith(NO_XR_ENTRY),
  );
  return {
    ok: errors === 0,
    errors,
    warnings,
    findings,
    supported,
    origins,
    injectedEmulator: opts.scan?.injectedEmulator ?? [],
    trace: opts.trace
      ? {
          reachedXR: opts.trace.reachedXR,
          enteredVia: opts.trace.enteredVia,
          xrFrames: opts.trace.xrFrames,
          pageErrors: opts.trace.pageErrors,
          blockedRequests: opts.trace.blockedRequests,
          hung: opts.trace.hung,
          ...(opts.trace.navigations?.length
            ? { navigations: opts.trace.navigations.length }
            : {}),
        }
      : undefined,
    surface: opts.surfaceOrigin ?? 'unknown',
    advice: needsAdvice ? UNSUPPORTED_ADVICE : undefined,
    ...(controlCandidates.length ? { controlCandidates } : {}),
  };
}

/** A removed root as app code names it (navigator.gpu, crypto.subtle, AudioWorklet). */
function shownRoot(root: string): string {
  return root
    .replace(/^Navigator\./, 'navigator.')
    .replace(/^Crypto\./, 'crypto.');
}

function unguardedKey(root: string): string {
  return `${shownRoot(root)} (used without a feature check)`;
}

function fallbackKey(root: string): string {
  return `${shownRoot(root)} (threw with it removed, although the app checks for it)`;
}

const MARK: Record<Severity, string> = {
  error: '[fail]',
  warn: '[warn]',
  info: '[info]',
};

export function formatCompatReport(
  r: CompatReport,
  opts: { verbose?: boolean } = {},
): string {
  const out: string[] = [];
  const sup = Object.entries(r.supported)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  out.push(
    `compat: ${r.errors} error(s), ${r.warnings} warning(s); supported APIs used: ${sup || 'none seen'} (surface: ${r.surface})`,
  );
  if (r.trace)
    out.push(
      `headless run: ${r.trace.reachedXR ? `entered XR via ${r.trace.enteredVia}, ${r.trace.xrFrames} XR frames` : 'did not reach XR'}${r.trace.navigations ? '; the app navigated the page (see "page navigation")' : ''}`,
    );
  // not-yet-implemented APIs are grouped per owning area unless --verbose
  const grouped = new Map<Area, CompatFinding[]>();
  for (const f of r.findings) {
    if (f.severity === 'info' && !opts.verbose) continue;
    if (
      !opts.verbose &&
      f.severity === 'warn' &&
      f.status === 'gap' &&
      f.area !== 'none' &&
      !f.key.includes('(headless run)')
    ) {
      const l = grouped.get(f.area) ?? [];
      l.push(f);
      grouped.set(f.area, l);
      continue;
    }
    out.push(
      `${MARK[f.severity]} ${f.key}: ${f.message} [${f.source}; ${AREAS[f.area]}${opts.verbose && f.spec.length ? `; ${f.spec.join(' ')}` : ''}]`,
    );
    if (opts.verbose || f.severity === 'error')
      for (const e of f.evidence) out.push(`         ${e.slice(0, 220)}`);
  }
  for (const [area, list] of grouped) {
    const keys = list.map((f) => f.key);
    const shown = keys.slice(0, 8).join(', ');
    out.push(
      `${MARK.warn} ${list.length} API(s) not implemented yet in ${AREAS[area]}: ${shown}${keys.length > 8 ? `, +${keys.length - 8} more` : ''}`,
    );
  }
  const infos = r.findings.filter((f) => f.severity === 'info').length;
  if (infos && !opts.verbose)
    out.push(
      `(${infos} informational finding(s) hidden; --verbose shows them)`,
    );
  if (r.advice) out.push('', r.advice);
  return `${out.join('\n')}\n`;
}
