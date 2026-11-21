/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Headless trace run: serve a built dist with the tracer and the IWER emulator
 * injected, open it in headless Chromium (Playwright), let the app offer or
 * request an immersive session, grant it, drive a short scripted input
 * sequence (controller pointing, trigger, squeeze, thumbstick, then hands with a
 * pinch), and collect what the app touched on the main thread and in workers.
 *
 * Playwright and IWER are not dependencies of this package: the caller passes
 * them in (`loadPlaywright` resolves them from the project, where IWSDK's own
 * dev tooling already installs both).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInside, startCompatServer, TOOL_PREFIX } from './server.ts';
import { tracerScript, type TraceDump } from './tracer.ts';
import type { HeadsetTrim } from './providers.ts';

/** The longest --boot-ms / --xr-ms accepted (30 min): the hard cap (boot + XR + 90 s) must stay a valid timer delay. */
export const MAX_PHASE_MS = 30 * 60_000;

/** Why a boot/XR time option is not usable, or undefined when it is (a finite number in (0, MAX_PHASE_MS]). */
export function phaseMsProblem(name: string, v: unknown): string | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (typeof v === 'string' && v.trim() === '') return `${name} wants a number of milliseconds (got "")`;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PHASE_MS) return `${name} wants milliseconds in (0, ${MAX_PHASE_MS}] (got "${String(v)}")`;
  return undefined;
}

export interface TraceRunOptions {
  distDir: string;
  /** IWER UMD build (`iwer/build/iwer.js`) source text. */
  iwerSource: string;
  /** A Playwright module (`playwright` or `playwright-core`). */
  playwright: PlaywrightLike;
  /** Time to wait for a session offer/request before clicking buttons (ms). */
  offerTimeoutMs?: number;
  /** Total boot timeout before giving up on XR (ms). */
  bootTimeoutMs?: number;
  /** Time spent in XR with scripted input (ms). */
  xrMs?: number;
  /** One page.evaluate may take this long before the page counts as hung (ms; default 60 s: SwiftShader can keep a heavy app's main thread busy for tens of seconds while it loads). */
  evalTimeoutMs?: number;
  /** Hard cap on the whole run (ms; default boot + XR time + 90 s): the browser is closed and the run returns. */
  hardCapMs?: number;
  /** Extra chromium flags. */
  chromiumArgs?: string[];
  /**
   * Local mirrors for cross-origin assets (e.g. the input-profiles CDN): a request whose URL
   * starts with `prefix` is answered from `dir` + the rest of the path. Others are blocked.
   */
  mirrors?: Array<{ prefix: string; dir: string }>;
  /**
   * Origins requests may go to over the real network (the app's native.network.allow; `https://*.host`
   * wildcards as in the config). Everything else cross-origin is blocked, as on the headset.
   */
  allow?: string[];
  /**
   * Trim the page to the headset's surface before the app runs (providers.ts headsetTrim): absent-by-design
   * globals and navigator members are deleted, unsupported canvas context types return null. Without it the
   * app sees all of Chromium, and its feature detection takes branches the headset never takes.
   */
  trim?: HeadsetTrim;
  /**
   * Let the emulated device offer `immersive-ar` (default false: like the headset today, XR-AR-1 is for later,
   * so isSessionSupported("immersive-ar") is false and AR requests reject). The sweep turns it on to record what
   * AR samples use once in XR.
   */
  emulateAR?: boolean;
  /** Explicit chromium binary (else Playwright's default for its version). */
  executablePath?: string;
  log?: (msg: string) => void;
}

export interface TraceResult {
  dist: string;
  origin: string;
  reachedXR: boolean;
  /** 'offer' (granted an offered session), 'request' (app requested), 'click:<text>' or 'none'. */
  enteredVia: string;
  sessionMode?: string;
  xrFrames: number;
  bootMs: number;
  consoleErrors: string[];
  pageErrors: string[];
  /** Cross-origin requests the run blocked (native default: no network). */
  blockedRequests: string[];
  /** Cross-origin requests answered from a local mirror (they need the allowlist on device). */
  mirroredRequests: string[];
  /** Same-origin 404s. */
  missingAssets: string[];
  /** dist/ files the server could not open during the run (EACCES, deleted): `path: error`. */
  unreadableAssets?: string[];
  /** Cross-origin requests let through because native.network.allow lists their origin. */
  allowedRequests?: string[];
  /** Times the session ended during the scripted input (and whether the run got back into XR). */
  sessionEnds?: string[];
  /**
   * Main-frame navigations the app started after the first load (location.href/assign/replace/reload, a link):
   * a same-origin one replaces the tracer's page, so what it recorded before is lost. Cross-origin ones are
   * cancelled (a 204 answer), as the headset ignores them (DOM-5), and the trace goes on.
   */
  navigations?: Array<{ url: string; sameOrigin: boolean }>;
  /** Set when the page's main thread stopped answering (an evaluate timed out, the load never finished, or the hard cap fired). */
  hung?: string;
  /** The boot timeout the run used (ms). */
  bootTimeoutMs?: number;
  /** Set when a run without XR still looked busy at the boot timeout (recent requests, a slow main thread). */
  stillLoading?: string;
  /** What the headset trim removed from the page (main thread). */
  removed?: string[];
  /** Whether the emulated device offered immersive-ar. */
  emulateAR?: boolean;
  /**
   * Control runs (set by the caller, see check.ts controlCandidates): the same trace with one removed root left in
   * place. A TypeError-like page error the trimmed run had and a control run does not is caused by that removal.
   */
  controls?: TraceControl[];
  main: TraceDump | null;
  workers: TraceDump[];
  webgl: { renderer?: string; ok: boolean };
}

export interface TraceControl {
  /** The root left in place (`Navigator.gpu`, `AudioWorklet`). */
  kept: string;
  pageErrors: string[];
  reachedXR: boolean;
  hung?: string;
}

/** The part of Playwright's API used here. */
export interface PlaywrightLike {
  chromium: {
    launch(opts: Record<string, unknown>): Promise<any>;
  };
}

/** Resolve playwright (or playwright-core) and IWER's UMD build from a project directory. */
export async function loadPlaywright(
  fromDir: string,
): Promise<PlaywrightLike | null> {
  const req = createRequire(path.join(path.resolve(fromDir), 'package.json'));
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const resolved = req.resolve(name);
      const mod = await import(pathToFileURL(resolved).href);
      return (mod.default ?? mod) as PlaywrightLike;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function findIwerBuild(fromDir: string): string | null {
  const req = createRequire(path.join(path.resolve(fromDir), 'package.json'));
  try {
    const pkg = req.resolve('iwer/package.json');
    return path.join(path.dirname(pkg), 'build', 'iwer.js');
  } catch {
    return null;
  }
}

/** `origin /first/two` segments of a request URL, for the blocked/allowed lists. */
function label(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin} ${x.pathname.split('/').slice(0, 3).join('/')}`;
  } catch {
    return u.slice(0, 80);
  }
}

const DEFAULT_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
];

/**
 * The emulator bootstrap: installs IWER (forced over Chromium's own navigator.xr). Without `ar` the device
 * offers inline and immersive-vr only, as the headset does until XR-AR-1.
 */
function emulateScript(ar: boolean): string {
  return `;(function(){
  var I = window.IWER; if (!I) { console.error('[iwn-compat] IWER missing'); return; }
  var config = Object.assign({}, I.metaQuest3);
  ${ar ? '' : "config.supportedSessionModes = (config.supportedSessionModes || ['inline', 'immersive-vr']).filter(function (m) { return m !== 'immersive-ar'; });"}
  var device = new I.XRDevice(config);
  device.installRuntime({ forceInstall: true });
  Object.defineProperty(window, '__iwnCompatDevice', { value: device, enumerable: false });
  var names = Object.getOwnPropertyNames(window).filter(function (n) { return /^XR[A-Z]/.test(n); });
  if (window.__iwnCompat) window.__iwnCompat.wrapLate(names);
})();\n`;
}

/** The page's main thread did not answer in time. */
export class PageHung extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageHung';
  }
}

/** page.evaluate with a timeout: a main thread that never yields would otherwise hang the run forever. */
type Ev = <T>(page: any, fn: (...a: any[]) => T, arg?: unknown) => Promise<Awaited<T>>;

/** An evaluate helper bound to one run's timeout (per run, so concurrent runs with different timeouts do not interfere). */
function makeEv(timeoutMs: number): Ev {
  return <T>(page: any, fn: (...a: any[]) => T, arg?: unknown): Promise<Awaited<T>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PageHung(`the page's main thread did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg), t]).finally(() => clearTimeout(timer)) as Promise<Awaited<T>>;
  };
}

/** A `.catch` handler that falls back to `v` for ordinary evaluate failures but lets PageHung through. */
function unlessHung<V>(v: V): (e: unknown) => V {
  return (e) => {
    if (e instanceof PageHung) throw e;
    return v;
  };
}

export async function runTrace(opts: TraceRunOptions): Promise<TraceResult> {
  const log = opts.log ?? (() => {});
  const workerDumps = new Map<string, TraceDump>();
  // blocked WebSockets are refused by the compat server (see TracerConfig.wsBlock)
  const wsBlock = { url: '__WSORIGIN__' + TOOL_PREFIX + 'ws-blocked?u=', allow: opts.allow ?? [] };
  const toolFiles = {
    'tracer.js': tracerScript({
      role: 'main',
      toolMarker: TOOL_PREFIX,
      selfMarker: `${TOOL_PREFIX}tracer`,
      trim: opts.trim,
      // filled after the server knows its origin (see below)
      workerTracerUrl: '__ORIGIN__' + TOOL_PREFIX + 'tracer-worker.js',
      wsBlock,
    }),
    'tracer-worker.js': tracerScript({
      role: 'worker',
      toolMarker: TOOL_PREFIX,
      selfMarker: `${TOOL_PREFIX}tracer`,
      trim: opts.trim,
      reportUrl: '__ORIGIN__' + TOOL_PREFIX + 'report',
      flushMs: 500,
      // nested workers are traced too
      workerTracerUrl: '__ORIGIN__' + TOOL_PREFIX + 'tracer-worker.js',
      wsBlock,
    }),
    'iwer.js': opts.iwerSource,
    'emulate.js': emulateScript(opts.emulateAR ?? false),
  } as Record<string, string>;
  let phase = 'boot';
  const server = await startCompatServer({
    phase: () => phase,
    distDir: opts.distDir,
    toolFiles,
    injectScripts: ['tracer.js', 'iwer.js', 'emulate.js'],
    workerTracer: 'tracer-worker.js',
    onWebSocketBlocked: (u) => {
      lastActivity = Date.now();
      blocked.add(label(u));
    },
    onReport: (body) => {
      try {
        const d = JSON.parse(body) as TraceDump;
        workerDumps.set(d.id, d);
      } catch {
        /* ignore */
      }
    },
  });
  for (const k of ['tracer.js', 'tracer-worker.js'])
    toolFiles[k] = toolFiles[k]!.split('__WSORIGIN__').join(server.origin.replace(/^http/, 'ws')).split('__ORIGIN__').join(server.origin);

  const result: TraceResult = {
    dist: opts.distDir,
    origin: server.origin,
    reachedXR: false,
    enteredVia: 'none',
    xrFrames: 0,
    bootMs: 0,
    consoleErrors: [],
    pageErrors: [],
    blockedRequests: [],
    mirroredRequests: [],
    missingAssets: [],
    main: null,
    workers: [],
    webgl: { ok: false },
    bootTimeoutMs: opts.bootTimeoutMs ?? 25_000,
    emulateAR: opts.emulateAR ?? false,
  };
  let browser: any;
  const t0 = Date.now();
  const evalTimeoutMs = opts.evalTimeoutMs ?? 60_000;
  const ev = makeEv(evalTimeoutMs);
  for (const [name, v] of [['bootTimeoutMs', opts.bootTimeoutMs], ['xrMs', opts.xrMs], ['offerTimeoutMs', opts.offerTimeoutMs], ['evalTimeoutMs', opts.evalTimeoutMs]] as const) {
    const problem = v === undefined ? undefined : phaseMsProblem(name, v);
    if (problem) {
      await server.close();
      throw new RangeError(problem);
    }
  }
  const cap = opts.hardCapMs ?? (opts.bootTimeoutMs ?? 25_000) + (opts.xrMs ?? 6_000) + 90_000;
  // above 2^31-1 ms Node clamps a timer to 1 ms, which would end the run at once
  if (!(cap > 0 && cap <= 2 ** 31 - 1)) {
    await server.close();
    throw new RangeError(`hard cap of ${cap} ms is not a usable timer delay`);
  }
  /** Set once the run has returned: a body() still going (the cap fired mid-launch) closes what it opens and stops. */
  let finished = false;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<never>((_, reject) => {
    capTimer = setTimeout(() => reject(new PageHung(`the run hit its hard cap of ${cap} ms`)), cap);
  });
  let lastActivity = Date.now();
  const blocked = new Set<string>();
  const mirrored = new Set<string>();
  const allowed = new Set<string>();
  const collect = () => {
    result.blockedRequests = [...blocked].sort();
    result.mirroredRequests = [...mirrored].sort();
    result.allowedRequests = [...allowed].sort();
    result.missingAssets = [...server.missing.keys()].sort();
    result.unreadableAssets = [...server.unreadable].map(([p, e]) => `${p}: ${e}`).sort();
    result.workers = [...workerDumps.values()];
  };
  try {
    await Promise.race([capped, body()]);
  } catch (error) {
    if (!(error instanceof PageHung)) throw error;
    result.hung = error.message;
    result.bootMs ||= Date.now() - t0;
    collect();
    log(`hung: ${error.message}`);
  } finally {
    finished = true;
    clearTimeout(capTimer);
    await browser?.close().catch(() => {});
    await server.close();
  }
  return result;

  async function body(): Promise<void> {
    browser = await opts.playwright.chromium.launch({
      headless: true,
      args: [...DEFAULT_ARGS, ...(opts.chromiumArgs ?? [])],
      ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    });
    if (finished) {
      // the hard cap fired while Chromium was launching: the run already returned, so nobody else closes it
      await browser.close().catch(() => {});
      return;
    }
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
    });
    let mainPage: any;
    let mainLoads = 0;
    await context.route('**/*', async (route: any) => {
      lastActivity = Date.now();
      const u: string = route.request().url();
      let mainNav = false;
      try {
        mainNav = !!mainPage && route.request().isNavigationRequest() && route.request().frame() === mainPage.mainFrame();
      } catch {
        mainNav = false;
      }
      if (mainNav && mainLoads++ > 0) {
        // the app navigates its page away (the first main-frame navigation is the run's own goto)
        const same = u.startsWith(server.origin);
        (result.navigations ??= []).push({ url: same ? u.slice(server.origin.length) || '/' : u.slice(0, 160), sameOrigin: same });
        // a 204 answer cancels the navigation and the page stays, as the headset ignores it (DOM-5); the trace goes on
        if (!same) return route.fulfill({ status: 204, body: '' });
      }
      if (u.startsWith(server.origin) || u.startsWith('data:') || u.startsWith('blob:'))
        return route.continue();
      const m = (opts.mirrors ?? []).find((x) => u.startsWith(x.prefix));
      if (m) {
        const rel = decodeURIComponent(new URL(u).pathname).slice(new URL(m.prefix).pathname.length);
        const file = path.join(m.dir, rel);
        mirrored.add(label(u));
        if (isInside(m.dir, file) && existsSync(file) && statSync(file).isFile())
          return route.fulfill({ status: 200, body: readFileSync(file), headers: { 'access-control-allow-origin': '*', 'content-type': mimeOf(file) } });
        return route.fulfill({ status: 404, body: 'not in mirror', headers: { 'access-control-allow-origin': '*' } });
      }
      if (originAllowed(u, opts.allow ?? [])) {
        allowed.add(label(u));
        return route.continue();
      }
      blocked.add(label(u));
      return route.abort('blockedbyclient');
    });
    // WebSockets do not go through context.route: the tracer redirects blocked ones to the compat server, which
    // refuses them (TracerConfig.wsBlock). Playwright's routeWebSocket is not used: its page-side WebSocket mock
    // runs before the tracer, and its own calls (crypto, URL, EventTarget) would be charged to the app.
    const page = await context.newPage();
    mainPage = page;
    page.on('console', (m: any) => {
      if (m.type() === 'error' && result.consoleErrors.length < 100)
        result.consoleErrors.push(String(m.text()).slice(0, 400));
    });
    page.on('pageerror', (e: any) => {
      if (result.pageErrors.length >= 100) return;
      // a rejected DOMException can arrive with an empty stack: lead with name and message
      const head = e?.message ? `${e?.name || 'Error'}: ${e.message}` : String(e ?? '');
      const stack = typeof e?.stack === 'string' ? e.stack : '';
      const text = stack.includes(head) ? stack : [head, stack].filter(Boolean).join('\n');
      result.pageErrors.push((text || `${e?.name || 'Error'} (no message)`).slice(0, 600));
    });
    try {
      await page.goto(server.origin + '/', { waitUntil: 'load', timeout: evalTimeoutMs });
    } catch (error) {
      // a script that never yields before the load event: the same kind of hang as a stuck evaluate later on
      if ((error as Error)?.name === 'TimeoutError') throw new PageHung(`the page did not finish loading within ${evalTimeoutMs} ms (a script that never yields before the load event?)`);
      throw error;
    }
    log(`loaded ${server.origin}/`);

    const offerTimeout = opts.offerTimeoutMs ?? 8_000;
    const bootTimeout = opts.bootTimeoutMs ?? 25_000;
    let clicked = false;
    let sawOffer = false;
    let lastPollMs = 0;
    while (Date.now() - t0 < bootTimeout && !finished) {
      const p0 = Date.now();
      const s = await ev(page, () => {
        const d = (globalThis as any).__iwnCompatDevice;
        if (!d) return { state: 'no-device' };
        if (d.activeSession) return { state: 'xr', mode: d.activeSession.__mode ?? '' };
        if (d.sessionOffered) {
          d.grantOfferedSession();
          return { state: 'offered' };
        }
        return { state: 'waiting' };
      });
      lastPollMs = Date.now() - p0;
      if (s.state === 'xr') {
        result.reachedXR = true;
        if (result.enteredVia === 'none') result.enteredVia = sawOffer ? 'offer' : 'request';
        break;
      }
      if (s.state === 'offered') sawOffer = true;
      if (!clicked && !sawOffer && Date.now() - t0 > offerTimeout) {
        clicked = true;
        const text = await ev(page, () => {
          const re = /(enter|launch|start|play)\b|\b(vr|xr|ar)\b/i;
          const doc = (globalThis as any).document;
          const els = Array.from(
            doc.querySelectorAll('button, [role="button"], a, .button'),
          ) as any[];
          for (const el of els) {
            const t = (el.innerText || el.textContent || '').trim();
            if (re.test(t)) {
              el.click();
              return t.slice(0, 40);
            }
          }
          return '';
        });
        if (text) result.enteredVia = `click:${text}`;
        log(`no offer after ${offerTimeout} ms; clicked ${text || '(nothing)'}`);
      }
      await page.waitForTimeout(250);
    }
    result.bootMs = Date.now() - t0;
    if (!result.reachedXR) {
      // still loading when the boot window closed? (requests in its last seconds, or a main thread too busy to answer)
      const idleMs = Date.now() - lastActivity;
      result.stillLoading = idleMs < 4_000 || lastPollMs > 1_000 ? `last request ${Math.round(idleMs / 100) / 10} s before the boot timeout, last main-thread poll took ${lastPollMs} ms` : undefined;
    }
    result.webgl = await ev(page, () => {
      try {
        const c = (globalThis as any).document.createElement('canvas');
        const gl = c.getContext('webgl2');
        if (!gl) return { ok: false };
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          ok: true,
          renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
        };
      } catch {
        return { ok: false };
      }
    });
    if (result.reachedXR) {
      log('in XR; driving input');
      phase = 'xr';
      await ev(page, () => (globalThis as any).__iwnCompat?.setPhase('xr'));
      result.sessionEnds = await driveInput(page, opts.xrMs ?? 6_000, log, ev);
      result.sessionMode = await ev(page, () => {
        const s = (globalThis as any).__iwnCompatDevice?.activeSession;
        return s ? String(s.mode ?? s.environmentBlendMode ?? '') : '';
      });
    } else {
      await page.waitForTimeout(2_000);
    }
    await page.waitForTimeout(1_200); // last worker flush
    result.main = await ev(page, () => (globalThis as any).__iwnCompat?.dump() ?? null);
    result.xrFrames = result.main?.xrFrames ?? 0;
    result.removed = result.main?.removed ?? [];
    collect();
    await context.close();
  }
}

/**
 * Is a URL's origin in an allowlist (exact origins, or `https://*.host` wildcards)? ws:// and wss:// URLs are
 * matched as http:// and https:// origins, as the runtime does (runtime/net url.h, web/net allowlist.ts); the
 * config validator accepts only http(s) entries.
 */
export function originAllowed(url: string, allow: string[]): boolean {
  let origin: string;
  try {
    origin = new URL(url.replace(/^ws(s?):\/\//i, 'http$1://')).origin;
  } catch {
    return false;
  }
  return allow.some((a) => {
    if (a === origin) return true;
    const m = /^(https?):\/\/\*\.(.+)$/.exec(a);
    if (!m) return false;
    const u = /^(https?):\/\/([^/:]+)(:\d+)?$/.exec(origin);
    return !!u && u[1] === m[1] && u[2]!.endsWith(`.${m[2]}`);
  });
}

/**
 * Scripted input. The trigger can press the app's own exit control and end the session; then the run
 * notes it and re-enters XR (granting a new offer, or the "Enter XR" button) so the rest of the script
 * (hands, pinch) still runs. Returns what happened, for the trace.
 */
async function driveInput(page: any, ms: number, log: (m: string) => void, ev: Ev): Promise<string[]> {
  const ends: string[] = [];
  const steps: Array<[number, string]> = [
    [0.0, 'aim'],
    [0.15, 'trigger-down'],
    [0.25, 'trigger-up'],
    [0.3, 'squeeze-down'],
    [0.4, 'squeeze-up'],
    [0.45, 'stick'],
    [0.55, 'stick-release'],
    [0.6, 'hands'],
    [0.7, 'pinch-down'],
    [0.8, 'pinch-up'],
    [0.9, 'controllers'],
  ];
  const start = Date.now();
  for (const [at, action] of steps) {
    const wait = start + at * ms - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await ev(page, (a: string) => {
        const d = (globalThis as any).__iwnCompatDevice;
        if (!d) return;
        const r = d.controllers?.right;
        const l = d.controllers?.left;
        try {
          switch (a) {
            case 'aim':
              r?.position.set(0.2, 1.3, -0.4);
              l?.position.set(-0.2, 1.3, -0.4);
              break;
            case 'trigger-down':
              r?.updateButtonValue('trigger', 1);
              break;
            case 'trigger-up':
              r?.updateButtonValue('trigger', 0);
              break;
            case 'squeeze-down':
              r?.updateButtonValue('squeeze', 1);
              break;
            case 'squeeze-up':
              r?.updateButtonValue('squeeze', 0);
              break;
            case 'stick':
              r?.updateAxes('thumbstick', 0.8, -0.8);
              l?.updateAxes('thumbstick', 0, -1);
              break;
            case 'stick-release':
              r?.updateAxes('thumbstick', 0, 0);
              l?.updateAxes('thumbstick', 0, 0);
              break;
            case 'hands':
              d.primaryInputMode = 'hand';
              break;
            case 'pinch-down':
              d.hands?.right?.updatePinchValue(1);
              break;
            case 'pinch-up':
              d.hands?.right?.updatePinchValue(0);
              break;
            case 'controllers':
              d.primaryInputMode = 'controller';
              break;
          }
        } catch (e) {
          console.warn('[iwn-compat] input step ' + a + ' failed: ' + e);
        }
      }, action)
      .catch(unlessHung(undefined));
    await page.waitForTimeout(100);
    const inXR = await ev(page, () => !!(globalThis as any).__iwnCompatDevice?.activeSession).catch(unlessHung(true));
    if (!inXR) {
      const back = await reenter(page, ev);
      const note = `after "${action}" the session ended; ${back ? `re-entered via ${back}` : 'could not re-enter'}`;
      ends.push(note);
      log(note);
    }
  }
  const rest = start + ms - Date.now();
  if (rest > 0) await page.waitForTimeout(rest);
  return ends;
}

async function reenter(page: any, ev: Ev): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const s = await ev(page, () => {
        const d = (globalThis as any).__iwnCompatDevice;
        if (!d) return 'none';
        if (d.activeSession) return 'xr';
        if (d.sessionOffered) {
          d.grantOfferedSession();
          return 'offer';
        }
        return 'waiting';
      })
      .catch(unlessHung('none'));
    if (s === 'xr') return 'offer';
    if (s === 'none') return '';
    if (i === 6) {
      const clicked = await ev(page, () => {
          const re = /(enter|launch|start|play)\b|\b(vr|xr|ar)\b/i;
          const els = Array.from((globalThis as any).document.querySelectorAll('button, [role="button"], a, .button')) as any[];
          for (const el of els) {
            if (re.test((el.innerText || el.textContent || '').trim())) {
              el.click();
              return true;
            }
          }
          return false;
        })
        .catch(unlessHung(false));
      if (clicked) {
        await page.waitForTimeout(500);
        const ok = await ev(page, () => !!(globalThis as any).__iwnCompatDevice?.activeSession).catch(unlessHung(false));
        if (ok) return 'button';
      }
    }
    await page.waitForTimeout(150);
  }
  return '';
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    { '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream' } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}

/** Convenience for scripts: read IWER's build file. */
export function readIwer(file: string): string {
  return readFileSync(file, 'utf8');
}
