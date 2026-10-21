/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice } from '../../src/device/XRDevice.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { P_DEVICE, P_SESSION } from '../../src/private.js';
import { XRSession } from '../../src/session/XRSession.js';

// The real polyfill permanently patches XRSession.prototype: isolate this file.
const g = globalThis as Record<string, unknown>;
const C = {
  VERTEX_ARRAY_BINDING: 0x85b5,
  ARRAY_BUFFER: 0x8892,
  ARRAY_BUFFER_BINDING: 0x8894,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  VIEWPORT: 0x0ba2,
  FRAMEBUFFER: 0x8d40,
  FRAMEBUFFER_BINDING: 0x8ca6,
  DRAW_FRAMEBUFFER: 0x8ca9,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  READ_FRAMEBUFFER: 0x8ca8,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  ACTIVE_TEXTURE: 0x84e0,
  TEXTURE0: 0x84c0,
  TEXTURE_2D: 0x0de1,
  TEXTURE_BINDING_2D: 0x8069,
  TEXTURE_2D_ARRAY: 0x8c1a,
  TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_BINDING_CUBE_MAP: 0x8514,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  CURRENT_PROGRAM: 0x8b8d,
  BLEND: 0x0be2,
  DEPTH_TEST: 0x0b71,
  CULL_FACE: 0x0b44,
  BLEND_SRC_RGB: 0x80c9,
  BLEND_DST_RGB: 0x80c8,
  BLEND_SRC_ALPHA: 0x80cb,
  BLEND_DST_ALPHA: 0x80ca,
  COLOR_CLEAR_VALUE: 0x0c22,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  MAX_TEXTURE_SIZE: 0x0d33,
};
const scalarStates = [
  'VERTEX_ARRAY_BINDING',
  'ELEMENT_ARRAY_BUFFER_BINDING',
  'ARRAY_BUFFER_BINDING',
  'VIEWPORT',
  'FRAMEBUFFER_BINDING',
  'ACTIVE_TEXTURE',
  'UNPACK_FLIP_Y_WEBGL',
  'CURRENT_PROGRAM',
  'BLEND',
  'DEPTH_TEST',
  'CULL_FACE',
  'BLEND_SRC_RGB',
  'BLEND_DST_RGB',
  'BLEND_SRC_ALPHA',
  'BLEND_DST_ALPHA',
  'COLOR_CLEAR_VALUE',
] as const;
const textureTargets = [
  [C.TEXTURE_2D, C.TEXTURE_BINDING_2D, '2D'],
  [C.TEXTURE_CUBE_MAP, C.TEXTURE_BINDING_CUBE_MAP, 'CUBE'],
  [C.TEXTURE_2D_ARRAY, C.TEXTURE_BINDING_2D_ARRAY, '2D_ARRAY'],
] as const;

function createGL(webgl2: boolean) {
  const values = new Map<number, unknown>();
  const textures = new Map<string, unknown>();
  const elements = new Map<unknown, unknown>();
  const touched = jest.fn();
  const record =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      touched();
      return fn(...args);
    };
  const parameter = (name: number): unknown => {
    if (name === C.MAX_TEXTURE_SIZE) return 4096;
    if (name === C.ELEMENT_ARRAY_BUFFER_BINDING)
      return elements.get(values.get(C.VERTEX_ARRAY_BINDING));
    if (textureTargets.some(([, binding]) => name === binding))
      return textures.get(`${values.get(C.ACTIVE_TEXTURE)}:${name}`) ?? null;
    return values.get(name);
  };
  const bindVAO = record((vao: unknown) =>
    values.set(C.VERTEX_ARRAY_BINDING, vao),
  );
  const blendFuncSeparate = record(
    (sr: number, dr: number, sa: number, da: number) => {
      [sr, dr, sa, da].forEach((value, index) =>
        values.set(
          [
            C.BLEND_SRC_RGB,
            C.BLEND_DST_RGB,
            C.BLEND_SRC_ALPHA,
            C.BLEND_DST_ALPHA,
          ][index],
          value,
        ),
      );
    },
  );
  const context = Object.assign(
    new (webgl2 ? WebGL2RenderingContext : WebGLRenderingContext)(),
    C,
    {
      drawingBufferWidth: 800,
      drawingBufferHeight: 600,
      isContextLost: () => false,
      createFramebuffer: record(() => ({})),
      getParameter: record(parameter),
      getExtension: record((name: string) =>
        name === 'OES_vertex_array_object'
          ? {
              VERTEX_ARRAY_BINDING_OES: C.VERTEX_ARRAY_BINDING,
              bindVertexArrayOES: bindVAO,
            }
          : null,
      ),
      bindFramebuffer: record((target: number, framebuffer: unknown) => {
        if (target !== C.READ_FRAMEBUFFER)
          values.set(C.FRAMEBUFFER_BINDING, framebuffer);
        if (webgl2 && target !== C.DRAW_FRAMEBUFFER)
          values.set(C.READ_FRAMEBUFFER_BINDING, framebuffer);
      }),
      bindBuffer: record((target: number, buffer: unknown) => {
        if (target === C.ARRAY_BUFFER)
          values.set(C.ARRAY_BUFFER_BINDING, buffer);
        else elements.set(values.get(C.VERTEX_ARRAY_BINDING), buffer);
      }),
      viewport: record((...viewport: number[]) =>
        values.set(C.VIEWPORT, new Int32Array(viewport)),
      ),
      activeTexture: record((unit: number) =>
        values.set(C.ACTIVE_TEXTURE, unit),
      ),
      bindTexture: record((target: number, texture: unknown) => {
        const binding = textureTargets.find(
          ([candidate]) => candidate === target,
        )![1];
        textures.set(`${values.get(C.ACTIVE_TEXTURE)}:${binding}`, texture);
      }),
      pixelStorei: record((name: number, value: unknown) =>
        values.set(name, value),
      ),
      useProgram: record((program: unknown) =>
        values.set(C.CURRENT_PROGRAM, program),
      ),
      isEnabled: record((cap: number) => values.get(cap)),
      enable: record((cap: number) => values.set(cap, true)),
      disable: record((cap: number) => values.set(cap, false)),
      clearColor: record((...color: number[]) =>
        values.set(C.COLOR_CLEAR_VALUE, new Float32Array(color)),
      ),
      clear: record(() => {}),
      blendFunc: record((src: number, dst: number) =>
        blendFuncSeparate(src, dst, src, dst),
      ),
      blendFuncSeparate,
    },
    webgl2 ? { bindVertexArray: bindVAO } : {},
  );
  const targets = textureTargets.slice(0, webgl2 ? 3 : 2);
  function seed(stage: number, unit = C.TEXTURE0 + stage) {
    for (const name of scalarStates) values.set(C[name], { stage, name });
    values.set(C.READ_FRAMEBUFFER_BINDING, { stage, name: 'read' });
    elements.set(values.get(C.VERTEX_ARRAY_BINDING), {
      stage,
      name: 'element',
    });
    values.set(
      C.VIEWPORT,
      new Int32Array([stage, stage + 1, 320 + stage, 240 + stage]),
    );
    values.set(
      C.COLOR_CLEAR_VALUE,
      new Float32Array([stage / 4, 0.25, 0.5, 1]),
    );
    values.set(C.ACTIVE_TEXTURE, unit);
    values.set(C.UNPACK_FLIP_Y_WEBGL, stage % 2 === 0);
    values.set(C.BLEND, stage % 2 !== 0);
    values.set(C.DEPTH_TEST, stage % 2 === 0);
    values.set(C.CULL_FACE, stage % 2 === 0);
    [
      C.BLEND_SRC_RGB,
      C.BLEND_DST_RGB,
      C.BLEND_SRC_ALPHA,
      C.BLEND_DST_ALPHA,
    ].forEach((name, index) => values.set(name, 0x0300 + stage + index));
    for (const textureUnit of new Set([C.TEXTURE0, unit]))
      for (const [, binding] of targets)
        textures.set(`${textureUnit}:${binding}`, {
          stage,
          textureUnit,
          binding,
        });
  }
  function inspect(name: string, unit = values.get(C.ACTIVE_TEXTURE)): unknown {
    const [target, location] = name.split('@');
    if (location) {
      const binding = targets.find(([, , label]) => label === target)![1];
      return textures.get(
        `${location === 'TEXTURE0' ? C.TEXTURE0 : unit}:${binding}`,
      );
    }
    return parameter(C[name as keyof typeof C]);
  }
  return { context, touched, seed, inspect };
}

interface ProjectionFixture {
  _colorTextures: WebGLTexture[];
}
type LayerSession = XRSession & {
  isPolyfillActive: boolean;
  initializedViews: boolean;
  layers: ProjectionFixture[];
  renderers: WeakMap<ProjectionFixture, { render(): void }>;
  updateRenderState(state: { layers: ProjectionFixture[] }): void;
};

const device = new XRDevice(metaQuest3);
let scheduled: Parameters<XRSession['requestAnimationFrame']>[0];

beforeAll(() => {
  g.WebGLRenderingContext = class WebGLRenderingContext {};
  g.WebGL2RenderingContext = class WebGL2RenderingContext {};
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest
    .spyOn(XRSession.prototype, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      scheduled = callback;
      return 1;
    });
  device.installRuntime({ forceInstall: true, polyfillLayers: true });
});

afterAll(() => {
  device.uninstallRuntime();
  jest.restoreAllMocks();
});

describe.each([true, false])('layers GL state (WebGL2=%s)', (webgl2) => {
  let session: LayerSession;
  let gl: ReturnType<typeof createGL>;
  let renderer: jest.Mock<void, []>;
  let frame: XRFrame;
  const stateNames = [
    ...scalarStates.map((name) =>
      webgl2 && name === 'FRAMEBUFFER_BINDING'
        ? 'DRAW_FRAMEBUFFER_BINDING'
        : name,
    ),
    ...(webgl2 ? ['READ_FRAMEBUFFER_BINDING'] : []),
    ...textureTargets
      .slice(0, webgl2 ? 3 : 2)
      .flatMap(([, , name]) => [`${name}@TEXTURE0`, `${name}@active`]),
  ];

  beforeEach(async () => {
    jest.useFakeTimers();
    session = (await device[P_DEVICE].xrSystem!.requestSession(
      'immersive-vr',
    )) as LayerSession;
    gl = createGL(webgl2);
    const Binding = g.XRWebGLBinding as new (
      session: XRSession,
      context: typeof gl.context,
    ) => { createProjectionLayer(): ProjectionFixture };
    const layer = new Binding(session, gl.context).createProjectionLayer();
    // Empty internal views leave allocation empty; clearing/composition stay real.
    layer._colorTextures = [];
    renderer = jest.fn(() => {
      gl.seed(3, C.TEXTURE0 + 2);
      gl.context.activeTexture(C.TEXTURE0 + 3);
    });
    session.layers = [layer];
    session.renderers = new WeakMap([[layer, { render: renderer }]]);
    session.isPolyfillActive = true;
    session.initializedViews = true;
    frame = new XRFrame(session, 1, true, true, 0);
    session[P_SESSION].activeFrame = frame;
    gl.seed(1);
    gl.touched.mockClear();
  });

  afterEach(async () => {
    await session.end();
    jest.useRealTimers();
  });

  test.each(stateNames)(
    'restores %s before the application callback',
    (name) => {
      const expected = gl.inspect(name);
      const callback = jest.fn(() =>
        expect(gl.inspect(name, C.TEXTURE0 + 1)).toEqual(expected),
      );
      session.requestAnimationFrame(callback);
      scheduled(123, frame);
      expect(callback).toHaveBeenCalledWith(123, frame);
      expect(renderer).toHaveBeenCalledTimes(1);
    },
  );

  describe.each(['success', 'compositor throws', 'application throws'])(
    '%s',
    (outcome) => {
      test.each(stateNames)('preserves application changes to %s', (name) => {
        const error = new Error(outcome);
        let expected: unknown;
        if (outcome === 'compositor throws') {
          const render = renderer.getMockImplementation()!;
          renderer.mockImplementation(() => {
            render();
            throw error;
          });
        }
        session.requestAnimationFrame(() => {
          gl.seed(2);
          expected = gl.inspect(name);
          if (outcome === 'application throws') throw error;
        });
        if (outcome === 'success') scheduled(123, frame);
        else expect(() => scheduled(123, frame)).toThrow(error);
        expect(gl.inspect(name, C.TEXTURE0 + 2)).toEqual(expected);
        expect(renderer).toHaveBeenCalledTimes(
          outcome === 'application throws' ? 0 : 1,
        );
      });
    },
  );

  test.each(textureTargets.slice(0, webgl2 ? 3 : 2))(
    'preserves texture target %s when the active unit is TEXTURE0',
    (_target, _binding, name) => {
      let expected: unknown;
      session.requestAnimationFrame(() => {
        gl.seed(2, C.TEXTURE0);
        expected = gl.inspect(`${name}@TEXTURE0`);
      });
      scheduled(123, frame);
      expect(gl.inspect('ACTIVE_TEXTURE')).toBe(C.TEXTURE0);
      expect(gl.inspect(`${name}@TEXTURE0`)).toEqual(expected);
    },
  );

  test('preserves application changes when layers activate during the callback', () => {
    const layer = session.layers[0];
    session.layers = [];
    session.isPolyfillActive = false;
    let expected = new Map<string, unknown>();
    const snapshot = () =>
      new Map(
        stateNames.map((name) => [name, gl.inspect(name, C.TEXTURE0 + 2)]),
      );
    session.requestAnimationFrame(() => {
      expect(gl.touched).not.toHaveBeenCalled();
      session.updateRenderState({ layers: [layer] });
      gl.seed(2);
      expected = snapshot();
    });
    scheduled(123, frame);
    expect(session.isPolyfillActive).toBe(true);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(expected);
  });

  test('does not touch GL when the layers polyfill is inactive', () => {
    session.isPolyfillActive = false;
    const callback = jest.fn();
    session.requestAnimationFrame(callback);
    scheduled(123, frame);
    expect(callback).toHaveBeenCalledWith(123, frame);
    expect(gl.touched).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
  });
});
