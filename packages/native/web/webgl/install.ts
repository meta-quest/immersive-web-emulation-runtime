/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds the public interfaces (spec GL-1): WebGL2RenderingContext / WebGLRenderingContext prototypes hold
// exactly the IDL operations, constants and attributes of their interface (from the generated IDL shape), the
// WebGL object interfaces and WebGLContextEvent go on the global, none are constructible by script. The
// implementation is one set of method modules; internal helpers live on the shared Ctx prototype below.

import {
  Ctx,
  type CanvasLike,
  type ContextAttributes,
  type ContextOptions,
} from './core.ts';
import type { GlNatives } from './gen/natives.gen.ts';
import { IDL } from './gen/idl.gen.ts';
import { directMethods } from './gen/methods.gen.ts';
import { INTERFACE_CLASSES, INTERNAL } from './objects.ts';
import { stateMethods, stateInternals } from './state.ts';
import { bufferMethods } from './buffers.ts';
import { textureMethods } from './textures.ts';
import { framebufferMethods, framebufferInternals } from './framebuffers.ts';
import { programMethods, programInternals } from './programs.ts';
import { uniformMethods } from './uniforms.ts';
import { attribMethods } from './attribs.ts';
import { drawMethods, drawInternals } from './draws.ts';
import { queryMethods } from './queries.ts';
import { getterMethods, attributeAccessors } from './getters.ts';
import { extensionMethods, setImplTable } from './extensions.ts';

/** Every method of the WebGL 2 surface (generated `direct` methods first, hand-written ones override). */
const ALL: Record<string, Function> = Object.assign(
  {},
  directMethods,
  stateMethods,
  bufferMethods,
  textureMethods,
  framebufferMethods,
  programMethods,
  uniformMethods,
  attribMethods,
  drawMethods,
  queryMethods,
  getterMethods,
  extensionMethods,
);

// Internal helpers on the shared prototype (underscore names, reachable from every public prototype).
let internalsInstalled = false;
function installInternals(): void {
  if (internalsInstalled) return;
  internalsInstalled = true;
  const proto = Ctx.prototype as unknown as Record<string, unknown>;
  const hide = (k: string, v: unknown): void => {
    Object.defineProperty(proto, k, {
      value: v,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  for (const src of [
    stateInternals,
    framebufferInternals,
    programInternals,
    drawInternals,
  ]) {
    for (const [k, v] of Object.entries(src)) hide(k, v);
  }
  for (const [k, v] of Object.entries(ALL)) if (k.startsWith('_')) hide(k, v);
  setImplTable(ALL);
}

export interface WebGLInstall {
  WebGL2RenderingContext: Function;
  WebGLRenderingContext: Function;
  /** Create a context for a canvas (what HTMLCanvasElement.getContext('webgl2' | 'webgl') calls). */
  createContext(
    canvas: CanvasLike,
    type: 'webgl2' | 'webgl',
    attrs?: Partial<ContextAttributes>,
  ): Ctx | null;
}

function illegalConstructor(name: string): Function {
  const f = {
    [name]: function () {
      throw new TypeError('Illegal constructor');
    },
  }[name];
  return f;
}

function buildInterface(
  name: 'WebGL2RenderingContext' | 'WebGLRenderingContext',
): Function {
  const shape = IDL[name];
  const ctor = illegalConstructor(name);
  const proto = Object.create(Ctx.prototype) as Record<PropertyKey, unknown>;
  for (const [op, length] of shape.ops) {
    const fn = ALL[op];
    if (!fn)
      throw new Error(`@iwer/native webgl: ${name}.${op} is not implemented`);
    // WebIDL Function.length = the shortest overload's required arguments (identical in WebGL 1 and 2, so the
    // shared function object carries it; no wrapper on the call path).
    if (fn.length !== length)
      Object.defineProperty(fn, 'length', {
        value: length,
        configurable: true,
      });
    if (fn.name !== op)
      Object.defineProperty(fn, 'name', { value: op, configurable: true });
    Object.defineProperty(proto, op, {
      value: fn,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  for (const [c, value] of shape.consts) {
    Object.defineProperty(proto, c, { value, enumerable: true });
    Object.defineProperty(ctor, c, { value, enumerable: true });
  }
  for (const [attr] of shape.attrs) {
    const d = attributeAccessors[attr];
    if (!d)
      throw new Error(
        `@iwer/native webgl: attribute ${name}.${attr} is not implemented`,
      );
    Object.defineProperty(proto, attr, {
      ...d,
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(proto, 'constructor', {
    value: ctor,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(proto, Symbol.toStringTag, {
    value: name,
    configurable: true,
  });
  Object.defineProperty(ctor, 'prototype', { value: proto, writable: false });
  return ctor;
}

const DEFAULT_ATTRS: ContextAttributes = {
  alpha: true,
  depth: true,
  stencil: false,
  antialias: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'default',
  failIfMajorPerformanceCaveat: false,
  desynchronized: false,
  xrCompatible: false,
};

function readAttrs(
  a: Partial<ContextAttributes> | undefined | null,
): ContextAttributes {
  const o = { ...DEFAULT_ATTRS };
  if (a && typeof a === 'object') {
    for (const k of Object.keys(DEFAULT_ATTRS) as Array<
      keyof ContextAttributes
    >) {
      const v = (a as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (k === 'powerPreference') {
        const s = String(v);
        if (s !== 'default' && s !== 'low-power' && s !== 'high-performance') {
          throw new TypeError(`'${s}' is not a valid WebGLPowerPreference`);
        }
        o.powerPreference = s;
      } else {
        (o as unknown as Record<string, boolean>)[k] = !!v;
      }
    }
  }
  return o;
}

/** WebGLContextEvent (extends Event when the runtime provides it). */
function makeContextEventClass(global: Record<string, unknown>): Function {
  const Base =
    (global.Event as
      | (new (type: string, init?: object) => object)
      | undefined) ??
    class {
      type: string;
      defaultPrevented = false;
      cancelable: boolean;
      constructor(type: string, init?: { cancelable?: boolean }) {
        this.type = type;
        this.cancelable = !!init?.cancelable;
      }
      preventDefault(): void {
        if (this.cancelable) this.defaultPrevented = true;
      }
    };
  class WebGLContextEvent extends (Base as new (
    type: string,
    init?: object,
  ) => object) {
    readonly statusMessage: string;
    constructor(
      type: string,
      init?: {
        statusMessage?: string;
        bubbles?: boolean;
        cancelable?: boolean;
      },
    ) {
      super(String(type), init);
      this.statusMessage =
        init?.statusMessage !== undefined ? String(init.statusMessage) : '';
    }
  }
  return WebGLContextEvent;
}

/**
 * Install the WebGL interfaces on `global` and return the context factory. `natives` is
 * globalThis.__iwn.gl on device, the host test addon or a fake in Node.
 */
export function installWebGL(
  global: Record<string, unknown>,
  natives: GlNatives,
  options: ContextOptions = {},
): WebGLInstall {
  installInternals();
  const W2 = buildInterface('WebGL2RenderingContext');
  const W1 = buildInterface('WebGLRenderingContext');
  for (const [name, cls] of Object.entries(INTERFACE_CLASSES)) {
    Object.defineProperty(global, name, {
      value: cls,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  Object.defineProperty(global, 'WebGL2RenderingContext', {
    value: W2,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(global, 'WebGLRenderingContext', {
    value: W1,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(global, 'WebGLContextEvent', {
    value: makeContextEventClass(global),
    writable: true,
    configurable: true,
  });
  const createContext = (
    canvas: CanvasLike,
    type: 'webgl2' | 'webgl',
    attrs?: Partial<ContextAttributes>,
  ): Ctx | null => {
    const v2 = type === 'webgl2';
    const ctx = Object.create((v2 ? W2 : W1).prototype) as Ctx;
    if (!ctx._init(natives, v2, canvas, readAttrs(attrs), options)) return null;
    Object.defineProperty(canvas, '__iwnWebGLContext', {
      value: ctx,
      configurable: true,
    });
    return ctx;
  };
  return {
    WebGL2RenderingContext: W2,
    WebGLRenderingContext: W1,
    createContext,
  };
}

export { INTERNAL };
