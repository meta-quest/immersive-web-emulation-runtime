/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * What the runtime provides today, measured rather than declared: each built
 * JS layer of the package (the core bootstrap, then every `web/<area>/dist/
 * <area>.js`) is evaluated in order in a fresh V8 context that starts with
 * only the ECMAScript built-ins (like the runtime's isolate), with permissive
 * fake natives. The globals and members each layer adds are its inventory.
 * Areas without a built bundle yet are scanned as source text (weaker: a name
 * that appears in the source is "mentioned", not verified).
 *
 * The V8 baseline itself (what a bare context has: ECMAScript, Intl,
 * WebAssembly) is recorded as the 'v8' layer.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export interface LayerInventory {
  /** Layer id: 'v8', 'runtime/core', 'web/<area>'. */
  layer: string;
  /** 'eval' (measured), 'source' (names mentioned in source), 'error'. */
  how: 'eval' | 'source' | 'error';
  file?: string;
  error?: string;
  /** Global names this layer added. */
  globals: string[];
  /** `Iface.member` / `global.member` names this layer added (own + prototype chain). */
  members: string[];
  /** For 'source' layers: identifier-like tokens in the source. */
  tokens?: string[];
  /** Member names the layer's code assigns as instance fields (`this.<name> =`). */
  fields?: string[];
  /** `Iface.member` this layer installs as a stub (its code warns "not implemented" or throws NotSupportedError). */
  stubs?: string[];
}

export interface Inventory {
  generatedAt: string;
  packageRoot: string;
  layers: LayerInventory[];
}

/**
 * Native functions behind an opt-in the packed runtime config never enables (alpha scope): the experimental
 * WebSocket transport (`experimentalWebSocket`, off by default in runtime/net). Absent from the stand-in, so a
 * layer that installs an API only over them (web/net's WebSocket) leaves it out, as on the headset.
 */
const OPT_IN_NATIVES: Record<string, ReadonlySet<string>> = { net: new Set(['wsConnect', 'wsSend', 'wsClose']) };

/** A permissive stand-in for `globalThis.__iwn`: every property exists (except OPT_IN_NATIVES), every call returns another stand-in. */
export function permissiveNatives(versions: { value: number | null } = { value: null }): unknown {
  const make = (module?: string, depth = 0): unknown => {
    const fn = function () {};
    return new Proxy(fn, {
      get(_t, k) {
        if (k === 'then') return undefined;
        if (depth === 1 && module && typeof k === 'string' && OPT_IN_NATIVES[module]?.has(k)) return undefined;
        // a bundle that checks a native protocol version gets the one it asked for on retry
        if (versions.value !== null && typeof k === 'string' && /protocol|version$/i.test(k)) return versions.value;
        if (k === Symbol.toPrimitive) return () => 0;
        if (k === Symbol.iterator) return function* () {};
        if (k === 'length') return 0;
        if (k === 'config') return {};
        return make(depth === 0 && typeof k === 'string' ? k : undefined, depth + 1);
      },
      apply() {
        return make();
      },
      construct() {
        return make() as object;
      },
      has(_t, k) {
        return !(depth === 1 && module && typeof k === 'string' && OPT_IN_NATIVES[module]?.has(k));
      },
    });
  };
  return make();
}

function membersOf(name: string, v: unknown, out: Set<string>, stop: Set<unknown>, impl: Map<string, unknown>) {
  const seen = new Set<object>();
  const walk = (o: object | null, prefix: string, depth: number) => {
    while (o && !stop.has(o) && depth < 6) {
      if (seen.has(o)) return;
      seen.add(o);
      for (const k of Reflect.ownKeys(o)) {
        if (typeof k !== 'string' || k === 'constructor' || k === 'prototype') continue;
        const key = `${prefix}.${k}`;
        out.add(key);
        if (!impl.has(key)) {
          const d = Object.getOwnPropertyDescriptor(o, k);
          impl.set(key, d ? ('value' in d ? (typeof d.value === 'function' ? d.value : undefined) : (d.get ?? d.set)) : undefined);
          if (d?.set) impl.set(`${key}=`, d.set);
        }
      }
      o = Object.getPrototypeOf(o);
      depth++;
    }
  };
  if (typeof v === 'function') {
    const proto = (v as { prototype?: object }).prototype;
    if (proto && typeof proto === 'object') walk(proto, name, 0);
    for (const k of Reflect.ownKeys(v))
      if (typeof k === 'string' && !['length', 'name', 'prototype', 'caller', 'arguments'].includes(k)) {
        out.add(`${name}.${k}`);
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (d && typeof d.value === 'function') impl.set(`${name}.${k}`, d.value);
      }
  } else if (v && typeof v === 'object') {
    walk(v as object, name, 0);
  }
}

function snapshot(g: Record<string, unknown>) {
  // the context's own Object.prototype / Function.prototype end the walk (not this realm's)
  const stop = new Set<unknown>([
    Object.getPrototypeOf(g.Object as object) === null ? undefined : (g.Object as { prototype: object }).prototype,
    (g.Function as { prototype: object }).prototype,
    Object.prototype,
    Function.prototype,
  ]);
  const globals = new Set<string>();
  const members = new Set<string>();
  /** member -> its function (method, getter or setter), to see replacements and stubs */
  const impl = new Map<string, unknown>();
  for (const k of Reflect.ownKeys(g)) {
    if (typeof k !== 'string') continue;
    globals.add(k);
    let v: unknown;
    try {
      v = g[k];
    } catch {
      continue;
    }
    // the global's own aliases (globalThis, window, self, and glue's frames/parent/top) would repeat every global
    if (k === 'globalThis' || k === 'window' || k === 'self' || v === g) continue;
    membersOf(k, v, members, stop, impl);
  }
  return { globals, members, impl };
}

type Snap = ReturnType<typeof snapshot>;

/** Members a layer added, plus members whose implementation it replaced (e.g. the console delegate over V8's console). */
function layerMembers(now: Snap, prev: Snap): string[] {
  const out = new Set(diff(now.members, prev.members));
  for (const [k, f] of now.impl) if (f && !k.endsWith('=') && prev.impl.has(k) && prev.impl.get(k) !== f) out.add(k);
  return [...out].sort();
}

const STUB_RE = /not implemented|NotSupportedError/;

/**
 * A stub fails unconditionally (the first statement of its body throws, rejects or warns with the marker:
 * `createWaveShaper() { throw domError("NotSupportedError", ...) }`), or admits it in a warning (`ctx.filter = 'blur(2px)'`
 * warns "not implemented yet" and draws unfiltered). A real implementation with a spec-mandated
 * error path (`AbortSignal.timeout` without timers, `ConvolverNode.buffer=` with the wrong channel count,
 * `setValueCurveAtTime` overlapping another event) checks something first, so it is not a stub.
 */
export function isStubSource(src: string): boolean {
  if (!STUB_RE.test(src)) return false;
  if (/\b[\w$.]*warn\w*\s*\([^;]*not implemented/i.test(src)) return true;
  const close = src.indexOf(')');
  const open = src.indexOf('{', close < 0 ? 0 : close);
  if (open < 0) return false;
  let body = src.slice(open + 1).replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  // the first statement: up to the first top-level ';' (or the end of the body)
  let depth = 0;
  let end = body.length;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    } else if (c === ';' && depth === 0) {
      end = i;
      break;
    }
  }
  body = body.slice(0, end);
  return /^(throw\b|return\s+Promise\.reject\b|console\.(warn|error)\s*\(|[\w$.]*(warn|notImplemented|unsupported|reject)\w*\s*\()/i.test(body) && STUB_RE.test(body);
}

/** A class whose constructor throws NotSupportedError first thing (web/audio's `unsupportedNode("WaveShaperNode")`). */
export function isStubClassSource(src: string): boolean {
  return /^class\b/.test(src) && /\bconstructor\s*\([^)]*\)\s*\{\s*throw\b[^;]*NotSupportedError/.test(src);
}

function stubsOf(members: string[], now: Snap, globals: string[] = [], g?: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const name of globals) {
    let v: unknown;
    try {
      v = g?.[name];
    } catch {
      continue;
    }
    if (typeof v !== 'function') continue;
    try {
      if (isStubClassSource(Function.prototype.toString.call(v))) out.push(name);
    } catch {
      /* a non-inspectable function: not a stub */
    }
  }
  for (const m of members) {
    for (const f of [now.impl.get(m), now.impl.get(`${m}=`)]) {
      if (typeof f !== 'function') continue;
      let src = '';
      try {
        src = Function.prototype.toString.call(f);
      } catch {
        continue;
      }
      if (isStubSource(src)) {
        out.push(m);
        break;
      }
    }
  }
  return out;
}

function fieldsOf(code: string): string[] {
  return [...new Set([...code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]!))].sort();
}

/** web/<area> names in the order release/template-assets.json evaluates their preludes ([] without it). */
export function shippedAreaOrder(packageRoot: string): string[] {
  try {
    const t = JSON.parse(readFileSync(path.join(packageRoot, 'release', 'template-assets.json'), 'utf8')) as { preludes?: unknown };
    const out: string[] = [];
    for (const p of Array.isArray(t.preludes) ? t.preludes : []) {
      const m = typeof p === 'string' ? /^web\/([\w-]+)\//.exec(p) : null;
      if (m && !out.includes(m[1]!)) out.push(m[1]!);
    }
    return out;
  } catch {
    return [];
  }
}

/** Discover the package's built JS layers in load order. */
export function discoverLayers(packageRoot: string): Array<{ layer: string; file?: string; srcDir?: string }> {
  const out: Array<{ layer: string; file?: string; srcDir?: string }> = [];
  const core = path.join(packageRoot, 'runtime', 'core', 'js', 'bootstrap.js');
  if (existsSync(core)) out.push({ layer: 'runtime/core', file: core });
  const webRoot = path.join(packageRoot, 'web');
  if (!existsSync(webRoot)) return out;
  // the shipped evaluation order (release/template-assets.json preludes) when present: layers patch each other
  // at install time (canvas2d adds getContext to an HTMLCanvasElement.prototype that exists then), so the
  // inventory must see them in the headset's order. Areas it does not list: glue first, then alphabetical, last
  const order = shippedAreaOrder(packageRoot);
  const rank = (a: string) => {
    const i = order.indexOf(a);
    return i >= 0 ? i : a === 'glue' ? -1 : order.length;
  };
  const areas = readdirSync(webRoot)
    .filter((a) => statSync(path.join(webRoot, a)).isDirectory())
    .sort((a, b) => rank(a) - rank(b) || (a === 'glue' ? -1 : b === 'glue' ? 1 : a.localeCompare(b)));
  for (const a of areas) {
    const dist = path.join(webRoot, a, 'dist');
    // the area's own bundle (<area>.js) is what the packer ships; other bundles in dist/ are opt-in preludes the
    // packer does not add (web/storage's idb.js: IndexedDB + Cache API, out of the alpha scope), so they do not count
    const all = existsSync(dist) ? readdirSync(dist).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js')).sort() : [];
    const bundles = all.includes(`${a}.js`) ? [`${a}.js`] : all;
    if (bundles.length) for (const b of bundles) out.push({ layer: `web/${a}`, file: path.join(dist, b) });
    else {
      const src = existsSync(path.join(webRoot, a, 'src')) ? path.join(webRoot, a, 'src') : path.join(webRoot, a);
      out.push({ layer: `web/${a}`, srcDir: src });
    }
  }
  return out;
}

function sourceTokens(dir: string): string[] {
  const tokens = new Set<string>();
  const visit = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (f === 'node_modules' || f === 'test' || f === 'dist') continue;
        visit(p);
      } else if (/\.(ts|js|mjs)$/.test(f) && !/\.test\./.test(f)) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/[A-Za-z_$][\w$]{2,}/g)) tokens.add(m[0]);
      }
    }
  };
  visit(dir);
  return [...tokens].sort();
}

/**
 * Members Node's V8 has only because Node installs an embedder hook (the wasm streaming callback); a bare V8
 * embedding has them only if the runtime installs the hook too (NET-10), so they are not V8 built-ins here.
 */
const NODE_EMBEDDER_HOOKED = /^WebAssembly\.(compileStreaming|instantiateStreaming)$/;

export function buildInventory(packageRoot: string): Inventory {
  const ctx = vm.createContext({});
  const g = vm.runInContext('globalThis', ctx) as Record<string, unknown>;
  const versions = { value: null as number | null };
  const natives = permissiveNatives(versions);
  Object.defineProperty(g, '__iwn', { value: natives, configurable: true, writable: true });
  let prev = snapshot(g);
  const layers: LayerInventory[] = [
    { layer: 'v8', how: 'eval', globals: [...prev.globals].filter((n) => n !== '__iwn').sort(), members: [...prev.members].filter((m) => !NODE_EMBEDDER_HOOKED.test(m)).sort() },
  ];
  for (const l of discoverLayers(packageRoot)) {
    if (l.srcDir) {
      layers.push({ layer: l.layer, how: 'source', file: path.relative(packageRoot, l.srcDir), globals: [], members: [], tokens: sourceTokens(l.srcDir) });
      continue;
    }
    const file = l.file!;
    const rel = path.relative(packageRoot, file);
    const code = readFileSync(file, 'utf8');
    const run = () => {
      const result = vm.runInContext(code, ctx, { filename: file, timeout: 5000 });
      if (typeof result === 'function' && l.layer === 'runtime/core') (result as (n: unknown, g: unknown) => void)(natives, g);
    };
    try {
      try {
        run();
      } catch (first) {
        const m = /protocol\b.*\bJS (\d+)/i.exec(String(first));
        if (!m) throw first;
        versions.value = Number(m[1]);
        try {
          run();
        } finally {
          versions.value = null;
        }
      }
    } catch (error) {
      const now = snapshot(g);
      // the bundle refused to start with fake natives: fall back to its source text
      const area = path.join(packageRoot, l.layer);
      const src = existsSync(path.join(area, 'src')) ? path.join(area, 'src') : area;
      layers.push({ layer: l.layer, how: 'error', file: rel, error: String(error).slice(0, 300), globals: diff(now.globals, prev.globals), members: layerMembers(now, prev), tokens: existsSync(src) ? sourceTokens(src) : [], fields: fieldsOf(code) });
      prev = now;
      continue;
    }
    const now = snapshot(g);
    const extNames = [...new Set(code.match(/\b(?:EXT|OES|WEBGL|KHR|OVR|ANGLE|OCULUS|WEBKIT|EXT_disjoint)_[A-Za-z0-9_]+\b/g) ?? [])].sort();
    const members = layerMembers(now, prev);
    const globals = diff(now.globals, prev.globals);
    layers.push({ layer: l.layer, how: 'eval', file: rel, globals, members, tokens: extNames, fields: fieldsOf(code), stubs: stubsOf(members, now, globals, g) });
    prev = now;
  }
  return { generatedAt: new Date().toISOString(), packageRoot, layers };
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}
