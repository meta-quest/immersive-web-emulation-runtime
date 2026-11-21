/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Aggregate per-sample traces into the ranked compat matrix:
 * API -> samples using it -> provided by (V8 / runtime layer / IWER / gap / unsupported).
 */

import {
  AREAS,
  parseKey,
  resolve,
  STATUS_ORDER,
  type Area,
  type MeasuredSurface,
  type ParsedKey,
  type Resolution,
  type Status,
} from './providers.ts';
import type { AppSignal } from './project.ts';
import type { TraceDump } from './tracer.ts';
import type { TraceResult } from './trace-run.ts';

/**
 * Where a use was seen: the main thread or a worker in the trace; the app's iwsdk.config.json or source
 * (static, app-owned); or 'device': a call the app makes on the headset's code path that headless Chromium
 * never takes (three.js's projection-layer path, IWSDK's layer system).
 */
export type UseWhere = 'main' | 'worker' | 'config' | 'source' | 'device';

export interface SampleUse {
  sample: string;
  where: Set<UseWhere>;
  calls: number;
  /** Estimated app calls per XR frame (0 when not used in XR). */
  perFrame: number;
  site?: string;
  phase?: string;
}

export interface MatrixRow {
  key: string;
  parsed: ParsedKey;
  uses: SampleUse[];
  resolution: Resolution;
}

export interface SampleInfo {
  sample: string;
  reachedXR: boolean;
  enteredVia: string;
  xrFrames: number;
  pageErrors: number;
  consoleErrors: number;
  blockedRequests: string[];
  mirroredRequests: string[];
  missingAssets: string[];
  apis: number;
  workers: number;
}

export interface Matrix {
  rows: MatrixRow[];
  samples: SampleInfo[];
}

/** App-attributed keys of one trace dump. */
function appKeys(d: TraceDump | null | undefined): Array<[string, TraceDump['apis'][string]]> {
  if (!d) return [];
  return Object.entries(d.apis).filter(([, r]) => r.app > 0);
}

/**
 * The headset path of an XR app that headless Chromium does not exercise: there IWER emulation leaves
 * `renderState.layers` undefined and three.js uses XRWebGLLayer; on the headset IWER host mode has layers,
 * so three.js creates a projection layer through XRWebGLBinding and asks for per-view sub-images.
 */
export const DEVICE_PATH_KEYS = ['new XRWebGLBinding', 'XRWebGLBinding.createProjectionLayer()', 'XRWebGLBinding.getViewSubImage()', 'XRSession.updateRenderState({layers})'];

export interface MatrixInputs {
  /** Per sample: what its iwsdk.config.json and own source declare (project.ts). */
  app?: Record<string, AppSignal[]>;
  /** Add the device-path rows for samples that reached XR (default true when `app` is given). */
  devicePath?: boolean;
}

export function buildMatrix(traces: Array<TraceResult & { sample?: string }>, surface: MeasuredSurface, inputs: MatrixInputs = {}): Matrix {
  const rows = new Map<string, MatrixRow>();
  const samples: SampleInfo[] = [];
  const rowFor = (key: string) => {
    let row = rows.get(key);
    if (!row) {
      const parsed = parseKey(key);
      row = { key, parsed, uses: [], resolution: resolve(parsed, surface) };
      rows.set(key, row);
    }
    return row;
  };
  for (const t of traces) {
    const sample = t.sample ?? t.dist;
    const frames = Math.max(1, t.xrFrames || t.main?.xrFrames || 0);
    const dumps: Array<[TraceDump | null, 'main' | 'worker']> = [[t.main, 'main'], ...t.workers.map((w) => [w, 'worker'] as [TraceDump, 'worker'])];
    let count = 0;
    for (const [d, where] of dumps) {
      for (const [k, r] of appKeys(d)) {
        const key = normaliseKey(scopedKey(k, where));
        const row = rowFor(key);
        let use = row.uses.find((u) => u.sample === sample);
        if (!use) {
          use = { sample, where: new Set(), calls: 0, perFrame: 0, site: r.site, phase: r.phase };
          row.uses.push(use);
          count++;
        }
        use.where.add(where);
        use.calls += r.calls;
        const sampled = r.app + r.tool + r.none;
        const appShare = sampled ? r.app / sampled : 1;
        if (t.reachedXR && r.xrCalls) use.perFrame += (r.xrCalls * appShare) / frames;
      }
    }
    // static, app-owned uses the trace did not show (or showed under the other session call)
    const extra: Array<[string, UseWhere, string]> = (inputs.app?.[sample] ?? []).map((a) => [normaliseKey(a.key), a.origin, a.evidence]);
    if (inputs.devicePath ?? !!inputs.app) {
      if (t.reachedXR) for (const k of DEVICE_PATH_KEYS) extra.push([k, 'device', 'headset projection-layer path (three.js with IWER host mode)']);
    }
    for (const [key, where, evidence] of extra) {
      const twin = key.replace(/^XRSystem\.(offerSession|requestSession)/, (_m, f: string) => `XRSystem.${f === 'offerSession' ? 'requestSession' : 'offerSession'}`);
      const seen = (k: string) => rows.get(k)?.uses.some((u) => u.sample === sample && (u.where.has('main') || u.where.has('worker')));
      if (seen(key) || seen(twin)) continue;
      const row = rowFor(key);
      let use = row.uses.find((u) => u.sample === sample);
      if (!use) {
        use = { sample, where: new Set(), calls: 0, perFrame: 0, site: evidence.slice(0, 120), phase: where === 'device' ? 'xr' : undefined };
        row.uses.push(use);
        count++;
      }
      use.where.add(where);
    }
    samples.push({
      sample,
      reachedXR: t.reachedXR,
      enteredVia: t.enteredVia,
      xrFrames: t.xrFrames,
      pageErrors: t.pageErrors.length,
      consoleErrors: t.consoleErrors.length,
      blockedRequests: t.blockedRequests,
      mirroredRequests: t.mirroredRequests ?? [],
      missingAssets: t.missingAssets,
      apis: count,
      workers: t.workers.length,
    });
  }
  const order = (s: Status) => STATUS_ORDER.indexOf(s);
  const sorted = [...rows.values()].sort(
    (a, b) => b.uses.length - a.uses.length || order(a.resolution.status) - order(b.resolution.status) || a.key.localeCompare(b.key),
  );
  return { rows: sorted, samples: samples.sort((a, b) => a.sample.localeCompare(b.sample)) };
}

/**
 * A trace key in its scope: on the page, the tracer records `window.postMessage(...)`/`window.close()` (members of
 * the [Global] object itself) as bare `postMessage()`/`close()`, the same keys as a worker's own. The page's are
 * DOM-3's, not web/workers', so they keep a Window. prefix (which normaliseKey leaves on them).
 */
export function scopedKey(k: string, role?: string): string {
  return role === 'main' && /^(postMessage|close)\(/.test(k) ? `Window.${k}` : k;
}

/** Fold worker/global prefixes so the same API from main and workers is one row. */
export function normaliseKey(k: string): string {
  return k
    .replace(/^Window\.(?!(postMessage|close)\()/, '')
    .replace(/^(WorkerGlobalScope|DedicatedWorkerGlobalScope)\./, '')
    .replace(/^WorkerNavigator\./, 'Navigator.')
    .replace(/^WorkerLocation\./, 'Location.');
}

function samplesCell(uses: SampleUse[], total: number, max = 6): string {
  if (total > 1 && uses.length === total) return `all ${total}`;
  const names = uses.map((u) => u.sample).sort();
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

function perFrameCell(uses: SampleUse[]): string {
  const m = Math.max(...uses.map((u) => u.perFrame));
  if (!m) return '';
  return m >= 10 ? m.toFixed(0) : m >= 1 ? m.toFixed(1) : m.toFixed(2);
}

function whereCell(uses: SampleUse[]): string {
  const w = new Set<string>();
  for (const u of uses) for (const x of u.where) w.add(x);
  const parts: string[] = [];
  if (w.has('worker')) parts.push(w.has('main') ? 'main+worker' : 'worker');
  for (const s of ['config', 'source', 'device']) if (w.has(s)) parts.push(s);
  return parts.join(', ');
}

function providedCell(r: Resolution): string {
  if (r.status === 'v8') return 'V8';
  if (r.status === 'iwer') return 'IWER host';
  if (r.layer) return r.layer;
  return AREAS[r.area];
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export interface MarkdownOptions {
  title?: string;
  preamble?: string;
  /** Rows per area table before the rest is summarised (default: all). */
  maxRowsPerArea?: number;
}

/** The ranked matrix as Markdown. */
export function matrixMarkdown(m: Matrix, opts: MarkdownOptions = {}): string {
  const out: string[] = [];
  out.push(`# ${opts.title ?? 'Web API compat matrix'}`);
  out.push('');
  if (opts.preamble) out.push(opts.preamble, '');

  // status summary
  const byStatus = new Map<Status, MatrixRow[]>();
  for (const r of m.rows) {
    const l = byStatus.get(r.resolution.status) ?? [];
    l.push(r);
    byStatus.set(r.resolution.status, l);
  }
  out.push('## Summary', '');
  out.push('| status | meaning | APIs |', '|---|---|---|');
  const meaning: Record<Status, string> = {
    unsupported: 'absent by design (or not in the spec) and the app calls it: the app breaks on the headset unless it feature-detects or drops it',
    gap: 'in the spec, nothing in the package provides it yet: work for the owning stream',
    later: 'specified for later (AR/scene, depth, quad/cylinder layers, gaze)',
    config: 'works once the app config allows it (network allowlist)',
    partial: 'found on a related interface only; check it',
    'in-source': 'named in a module whose bundle is not built yet',
    inert: 'accepted, never fires on device (no 2D panel, no keyboard)',
    'absent-ok': 'absent on device, but the app only probes it (feature detection takes its fallback)',
    iwer: 'IWER host mode implements it',
    provided: 'a built runtime layer provides it (measured)',
    v8: 'V8 itself',
  };
  for (const s of STATUS_ORDER) out.push(`| ${s} | ${meaning[s]} | ${byStatus.get(s)?.length ?? 0} |`);
  out.push('');

  // samples
  out.push('## Samples traced', '');
  out.push('| sample | XR | entered via | XR frames | app APIs | workers | page errors | cross-origin: blocked / served from a local mirror (both need the allowlist on device) |', '|---|---|---|---|---|---|---|---|');
  for (const s of m.samples) {
    const net = [...s.blockedRequests.map((b) => `blocked ${b}`), ...s.mirroredRequests.map((b) => `mirror ${b}`)];
    out.push(`| ${s.sample} | ${s.reachedXR ? 'yes' : '**no**'} | ${esc(s.enteredVia)} | ${s.xrFrames} | ${s.apis} | ${s.workers} | ${s.pageErrors} | ${esc(net.join(', '))} |`);
  }
  out.push('');

  // action list
  const action = m.rows.filter((r) => ['unsupported', 'gap', 'later', 'config', 'partial'].includes(r.resolution.status));
  out.push('## Gaps, ranked (unsupported, gap, later, config, partial)', '');
  out.push('| API | # samples | samples | per XR frame | status | owner | spec | note |', '|---|---|---|---|---|---|---|---|');
  for (const r of action)
    out.push(`| \`${esc(r.key)}\` | ${r.uses.length} | ${esc(samplesCell(r.uses, m.samples.length))} | ${perFrameCell(r.uses)} | **${r.resolution.status}** | ${esc(AREAS[r.resolution.area])} | ${r.resolution.spec.join(' ')} | ${esc(r.resolution.note ?? '')} |`);
  out.push('');

  // per area
  out.push('## Full matrix by area', '');
  out.push('Ranked by the number of samples that use each API. "per XR frame" is the busiest sample\'s estimated app calls per XR frame (headless SwiftShader, so frames are few; read it as relative). "thread" says where a use was seen when it is not only the main thread: a worker; `config`/`source`: the sample\'s iwsdk.config.json or its own code declares it but the trace did not show it; `device`: the headset\'s code path, which headless Chromium never takes (projection layers, IWSDK\'s quad/cylinder layers).', '');
  const areas = new Map<Area, MatrixRow[]>();
  for (const r of m.rows) {
    const l = areas.get(r.resolution.area) ?? [];
    l.push(r);
    areas.set(r.resolution.area, l);
  }
  const areaOrder = Object.keys(AREAS) as Area[];
  for (const a of areaOrder) {
    const rows = areas.get(a);
    if (!rows?.length) continue;
    out.push(`### ${AREAS[a]} (${rows.length})`, '');
    out.push('| API | # | samples | per XR frame | thread | status | provided by |', '|---|---|---|---|---|---|---|');
    const max = opts.maxRowsPerArea ?? rows.length;
    for (const r of rows.slice(0, max))
      out.push(`| \`${esc(r.key)}\` | ${r.uses.length} | ${esc(samplesCell(r.uses, m.samples.length, 4))} | ${perFrameCell(r.uses)} | ${whereCell(r.uses)} | ${r.resolution.status} | ${esc(providedCell(r.resolution))} |`);
    if (rows.length > max) out.push(`| … ${rows.length - max} more in matrix.json | | | | | | |`);
    out.push('');
  }
  return out.join('\n');
}

/** JSON form (sets flattened). */
export function matrixJson(m: Matrix): unknown {
  return {
    samples: m.samples,
    rows: m.rows.map((r) => ({
      key: r.key,
      base: r.parsed.base,
      kind: r.parsed.kind,
      status: r.resolution.status,
      area: r.resolution.area,
      providedBy: providedCell(r.resolution),
      spec: r.resolution.spec,
      note: r.resolution.note,
      samples: r.uses.map((u) => ({ sample: u.sample, where: [...u.where], calls: u.calls, perFrame: Number(u.perFrame.toFixed(3)), site: u.site, phase: u.phase })),
    })),
  };
}
