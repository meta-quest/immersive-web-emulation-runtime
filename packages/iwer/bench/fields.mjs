/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// How should IWER store per-object state? Compares, on the running V8:
//
//   bag      this[SYM].x : a symbol-keyed state object (IWER's P_* pattern)
//   private  this.#x     : ES2022 private fields
//   plain    this._x     : ordinary properties (what TS `private` emits)
//   weakmap  STATE.get(this).x
//
// each read through a getter at a monomorphic site (one class) and at a
// polymorphic site (5 subclasses, like XRSpace / XRReferenceSpace /
// XRJointSpace / GlobalSpace / XRBoundedReferenceSpace), plus construction
// cost and bytes per instance.
//
//   node --expose-gc bench/fields.mjs            (default tiers)
//   node --expose-gc --max-opt=2 bench/fields.mjs (Maglev only)

import { getHeapStatistics } from 'node:v8';

const SYM = Symbol('state');
const STATE = new WeakMap();

class Bag {
  constructor(v) {
    this[SYM] = { x: v, y: v + 1, m: null };
  }
  get x() {
    return this[SYM].x;
  }
  set x(v) {
    this[SYM].x = v;
  }
}
class Priv {
  #x;
  #y;
  #m = null;
  constructor(v) {
    this.#x = v;
    this.#y = v + 1;
  }
  get x() {
    return this.#x;
  }
  set x(v) {
    this.#x = v;
  }
  get y() {
    return this.#y + (this.#m === null ? 0 : 1);
  }
}
class Plain {
  constructor(v) {
    this._x = v;
    this._y = v + 1;
    this._m = null;
  }
  get x() {
    return this._x;
  }
  set x(v) {
    this._x = v;
  }
}
class Weak {
  constructor(v) {
    STATE.set(this, { x: v, y: v + 1, m: null });
  }
  get x() {
    return STATE.get(this).x;
  }
  set x(v) {
    STATE.get(this).x = v;
  }
}

/** Five subclasses of `Base`, mirroring IWER's space hierarchy. */
function family(Base) {
  class A extends Base {}
  class B extends Base {
    constructor(v) {
      super(v);
      this.extraB = 1;
    }
  }
  class C extends B {}
  class D extends Base {
    constructor(v) {
      super(v);
      this.extraD = 2;
    }
  }
  return [Base, A, B, C, D];
}

const N = 1 << 12;
const KINDS = { bag: Bag, private: Priv, plain: Plain, weakmap: Weak };

function makeObjects(classes) {
  const out = [];
  for (let i = 0; i < N; i++) out.push(new classes[i % classes.length](i));
  return out;
}

// One reader per kind and shape so every site keeps its own feedback.
function makeReader() {
  return new Function(
    'objs',
    `let s = 0; for (let i = 0; i < objs.length; i++) { const o = objs[i]; o.x = o.x + 1; s += o.x; } return s;`,
  );
}

// Internal access without a getter, as IWER modules read each other's
// state: o[SYM].x for the bag, o._x for plain (#x cannot be reached from
// outside its class, so it has no such row).
const DIRECT = {
  bag: (sym) =>
    new Function(
      'sym',
      `return function (objs) { let s = 0; for (let i = 0; i < objs.length; i++) { const st = objs[i][sym]; st.x = st.x + 1; s += st.x; } return s; };`,
    )(sym),
  plain: () =>
    new Function(
      'objs',
      `let s = 0; for (let i = 0; i < objs.length; i++) { const o = objs[i]; o._x = o._x + 1; s += o._x; } return s;`,
    ),
};

function time(fn, arg, reps) {
  for (let i = 0; i < 200; i++) fn(arg); // warm up through all tiers
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn(arg);
  return ((performance.now() - t0) * 1e6) / (reps * arg.length);
}

function bytesPerInstance(Cls) {
  globalThis.gc?.();
  const before = getHeapStatistics().used_heap_size;
  const keep = [];
  for (let i = 0; i < 100000; i++) keep.push(new Cls(i));
  const after = getHeapStatistics().used_heap_size;
  return (after - before) / keep.length - 8; // minus the array slot (approx.)
}

function constructNs(Cls) {
  const make = new Function(
    'C',
    'n',
    'let last; for (let i = 0; i < n; i++) last = new C(i); return last;',
  );
  make(Cls, 1e5);
  const t0 = performance.now();
  make(Cls, 1e6);
  return ((performance.now() - t0) * 1e6) / 1e6;
}

const rows = [];
for (const [name, Cls] of Object.entries(KINDS)) {
  const mono = makeObjects([Cls]);
  const poly = makeObjects(family(Cls));
  const poly4 = makeObjects(family(Cls).slice(0, 4));
  const direct = DIRECT[name];
  rows.push({
    kind: name,
    monoNsPerReadWrite: +time(makeReader(), mono, 2000).toFixed(2),
    poly4NsPerReadWrite: +time(makeReader(), poly4, 2000).toFixed(2),
    poly5NsPerReadWrite: +time(makeReader(), poly, 2000).toFixed(2),
    directMonoNs: direct ? +time(direct(SYM), mono, 2000).toFixed(2) : null,
    directPoly4Ns: direct ? +time(direct(SYM), poly4, 2000).toFixed(2) : null,
    directPoly5Ns: direct ? +time(direct(SYM), poly, 2000).toFixed(2) : null,
    constructNs: +constructNs(Cls).toFixed(1),
    bytesPerInstance: Math.round(bytesPerInstance(Cls)),
  });
}
console.log(
  JSON.stringify({
    v8: process.versions.v8,
    flags: process.execArgv.join(' '),
    rows,
  }),
);
