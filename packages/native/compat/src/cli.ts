/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `iwer-native compat`: the build:metavr compat checker.
 *
 *   iwer-native compat [--project <dir>] [--dist <dir>] [--trace] [--mirror <url-prefix>=<dir>]
 *                      [--boot-ms <ms>] [--strict] [--verbose] [--json]
 *
 * Static scan of the bundle plus the app's own source and iwsdk.config.json
 * always; `--trace` adds a headless run (Playwright + IWER from the project's
 * node_modules, both already installed by IWSDK's dev tooling). The run lets
 * requests to `native.network.allow` origins through and serves `--mirror`
 * prefixes from local directories; other cross-origin requests are blocked, as
 * on the headset. The page is trimmed to the headset's surface first (absent-by-
 * design APIs deleted, no immersive-ar), so feature detection takes the
 * headset's path.
 * The dormant-library baseline applies only to IWSDK apps (the project depends
 * on @iwsdk/core, or the bundle carries IWSDK's markers).
 * When the trimmed run has a TypeError and the app touched a removed root (navigator.gpu, ctx.audioWorklet), up to
 * MAX_CONTROL_RUNS control runs leave one root each in place, so only errors the removal causes count as an
 * unguarded use.
 * Exit 1 when there are errors (unsupported APIs the app calls, an injected
 * emulator); warnings never fail unless `--strict` (which also fails static
 * mentions of unsupported calls).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { evaluateCompat, formatCompatReport, type CompatReport } from './check.ts';
import { projectSignals } from './project.ts';
import { controlTrim, headsetTrim } from './providers.ts';
import { scanDist } from './scan.ts';
import { loadSurface, packageRoot } from './surface.ts';
import { findIwerBuild, loadPlaywright, runTrace, type TraceResult } from './trace-run.ts';

export interface CompatCliOptions {
  projectRoot: string;
  distDir?: string;
  trace?: boolean;
  strict?: boolean;
  verbose?: boolean;
  json?: boolean;
  /** native.network.allow (the CLI passes the resolved config's list). */
  allow?: string[];
  /** `<url-prefix>=<dir>` local mirrors for the trace run. */
  mirrors?: string[];
  /** Trace run: how long to wait for the app to offer or request a session (ms, default 25000). */
  bootMs?: number;
  stdout: (t: string) => void;
  stderr: (t: string) => void;
}

/** Read native.network.allow from iwsdk.config.json without validating the rest. */
export function readAllowlist(projectRoot: string): string[] {
  const file = path.join(projectRoot, 'iwsdk.config.json');
  if (!existsSync(file)) return [];
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as { native?: { network?: { allow?: unknown } } };
    const a = cfg.native?.network?.allow;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function checkProject(opts: Omit<CompatCliOptions, 'stdout' | 'stderr' | 'json' | 'verbose'> & { log?: (m: string) => void }): Promise<CompatReport> {
  const dist = path.resolve(opts.projectRoot, opts.distDir ?? 'dist');
  if (!existsSync(path.join(dist, 'index.html'))) throw new CompatUsageError(`${dist} has no index.html; build first (vite build)`);
  const { surface, origin } = await loadSurface();
  const scan = scanDist(dist);
  const allow = opts.allow ?? readAllowlist(opts.projectRoot);
  let trace: TraceResult | undefined;
  let traceAgain: ((roots: string[]) => Promise<NonNullable<TraceResult['controls']>>) | undefined;
  if (opts.trace) {
    const mirrors = parseMirrors(opts.mirrors ?? []);
    const pw = await loadPlaywright(opts.projectRoot);
    const iwer = findIwerBuild(opts.projectRoot);
    if (!pw || !iwer || !existsSync(iwer))
      throw new CompatUsageError('--trace needs playwright and iwer in the project\'s node_modules (IWSDK projects have both via @iwsdk/cli and @iwsdk/vite-plugin-dev)');
    opts.log?.(`tracing ${dist} headlessly (IWER ${path.relative(opts.projectRoot, iwer)})`);
    const trim = headsetTrim(surface);
    const run = (t: typeof trim) => runTrace({ distDir: dist, iwerSource: readFileSync(iwer, 'utf8'), playwright: pw, log: opts.log, allow, mirrors, trim: t, emulateAR: false, bootTimeoutMs: opts.bootMs });
    trace = await run(trim);
    traceAgain = async (roots: string[]) => {
      // one browser at a time; at most MAX_CONTROL_RUNS extra runs
      const controls = [];
      for (const root of roots.slice(0, MAX_CONTROL_RUNS)) {
        opts.log?.(`control run with ${root.replace(/^Navigator\./, 'navigator.')} left in place (does removing it cause the page error?)`);
        const c = await run(controlTrim(trim, root, trace!.removed ?? []));
        controls.push({ kept: root, pageErrors: c.pageErrors, reachedXR: c.reachedXR, ...(c.hung ? { hung: c.hung } : {}) });
      }
      return controls;
    };
  }
  const iwsdkVersion = iwsdkCoreVersion(opts.projectRoot);
  // the baseline describes library code IWSDK builds carry: for a plain three.js (or other) bundle every hit is the app's
  const iwsdk = !!iwsdkVersion || dependsOnIwsdk(opts.projectRoot) || !!scan.iwsdk;
  const evaluate = () => evaluateCompat({ scan, trace, app: projectSignals(opts.projectRoot), surface, surfaceOrigin: origin, allow, strict: opts.strict, baseline: iwsdk ? loadBaseline() : undefined, iwsdkVersion });
  let report = evaluate();
  if (trace && traceAgain && report.controlCandidates?.length) {
    // a TypeError in the trimmed run and a removed root the app touched: re-run with the root left in place, so
    // only an error the removal causes counts as an unguarded use (not an unrelated bug next to a guarded probe)
    trace.controls = await traceAgain(report.controlCandidates);
    report = evaluate();
  }
  return report;
}

/** Control runs per check (each is a full headless run). */
export const MAX_CONTROL_RUNS = 3;

/** package.json lists @iwsdk/core (dependencies or devDependencies). */
export function dependsOnIwsdk(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((k) => !!pkg[k] && '@iwsdk/core' in pkg[k]!);
  } catch {
    return false;
  }
}

/** The project's installed @iwsdk/core version, if any. */
export function iwsdkCoreVersion(projectRoot: string): string | undefined {
  try {
    const req = createRequire(path.join(path.resolve(projectRoot), 'package.json'));
    const v = (JSON.parse(readFileSync(req.resolve('@iwsdk/core/package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `<url-prefix>=<dir>` -> { prefix, dir }. */
export function parseMirrors(specs: string[]): Array<{ prefix: string; dir: string }> {
  return specs.map((m) => {
    const i = m.lastIndexOf('=');
    if (i <= 0 || !/^https?:\/\//.test(m)) throw new CompatUsageError(`--mirror wants <url-prefix>=<dir> (got "${m}")`);
    const dir = path.resolve(m.slice(i + 1));
    if (!existsSync(dir)) throw new CompatUsageError(`--mirror directory ${dir} does not exist`);
    return { prefix: m.slice(0, i), dir };
  });
}

/** data/static-baseline.json (written by scripts/baseline.mjs), if present. */
export function loadBaseline(root = packageRoot()): { keys: Set<string>; origins: Set<string>; counts: Map<string, number>; iwsdk?: string } | undefined {
  if (!root) return undefined;
  const file = path.join(root, 'compat', 'data', 'static-baseline.json');
  if (!existsSync(file)) return undefined;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { keys?: string[]; origins?: string[]; counts?: Record<string, number>; iwsdk?: string };
    return { keys: new Set(j.keys ?? []), origins: new Set(j.origins ?? []), counts: new Map(Object.entries(j.counts ?? {})), iwsdk: typeof j.iwsdk === 'string' ? j.iwsdk : undefined };
  } catch {
    return undefined;
  }
}

export class CompatUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompatUsageError';
  }
}

/** Run the command; returns the exit code (0 ok, 1 errors or a failed check run, 2 usage). */
export async function runCompatCommand(o: CompatCliOptions): Promise<number> {
  let report: CompatReport;
  try {
    report = await checkProject({ ...o, log: (m) => o.stderr(`${m}\n`) });
  } catch (error) {
    const e = error as Error;
    const usage = e.name === 'CompatUsageError';
    if (o.json) o.stdout(`${JSON.stringify({ ok: false, error: e.message }, null, 2)}\n`);
    else o.stderr(`iwer-native compat: ${usage ? '' : 'the check could not run: '}${e.message}\n`);
    return usage ? 2 : 1;
  }
  if (o.json) o.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else o.stdout(formatCompatReport(report, { verbose: o.verbose }));
  if (!report.ok) return 1;
  if (o.strict && report.warnings > 0) return 1;
  return 0;
}
