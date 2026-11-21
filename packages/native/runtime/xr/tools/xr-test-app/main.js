/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XR pipeline check for runtime/xr on a headset, with no DOM and no framework: WebXR Layers (XRWebGLBinding
// projection layer, texture-array), MSAA multiview through OCULUS_multiview (one render pass for both eyes), a
// per-eye background colour (GL-24's two-colour check: left eye green, right eye blue), a world-locked cube 1.5 m
// ahead, and the colour texture attached to the framebuffer once at session start (REG-6: the runtime re-points
// it to each frame's swapchain image). State for the debug endpoint: globalThis.__xrtest.
const log = (...a) => console.log('XRTEST', ...a);
const state = (globalThis.__xrtest = {
  windowFrames: 0,
  windowFramesPerSecond: [],
  xrFrames: 0,
  xrFramesPerSecond: [],
  session: null,
  errors: [],
  layer: null,
  attachedOnce: true,
});

// Window rAF before the session (XR-IDLE-2: driven by the OpenXR frame loop at the display rate).
let windowSecond = performance.now();
let windowCount = 0;
function windowTick(t) {
  state.windowFrames++;
  windowCount++;
  if (t - windowSecond >= 1000) {
    state.windowFramesPerSecond.push(windowCount);
    if (state.windowFramesPerSecond.length > 30)
      state.windowFramesPerSecond.shift();
    windowCount = 0;
    windowSecond = t;
  }
  requestAnimationFrame(windowTick);
}
requestAnimationFrame(windowTick);

// In the runtime the WebGL prelude makes the context directly (no DOM); in a browser (A/B runs against Quest
// Browser) a canvas does.
const canvas = globalThis.__iwnWebGL
  ? { width: 300, height: 150 }
  : document.createElement('canvas');
const gl = globalThis.__iwnWebGL
  ? globalThis.__iwnWebGL.createContext(canvas, 'webgl2', {
      xrCompatible: true,
      antialias: true,
    })
  : canvas.getContext('webgl2', { xrCompatible: true, antialias: true });
const mv = gl.getExtension('OCULUS_multiview');
log(
  'context',
  gl.getParameter(gl.VERSION),
  'OCULUS_multiview',
  !!mv,
  'OVR_multiview2',
  !!gl.getExtension('OVR_multiview2'),
);

function program(vsSource, fsSource) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSource);
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSource);
  gl.compileShader(fs);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(
      'link: ' +
        gl.getProgramInfoLog(p) +
        ' vs: ' +
        gl.getShaderInfoLog(vs) +
        ' fs: ' +
        gl.getShaderInfoLog(fs),
    );
  }
  return p;
}

// Full-screen triangle whose colour depends on the view: left (view 0) green, right (view 1) blue.
const bgProgram = program(
  `#version 300 es
#extension GL_OVR_multiview2 : require
layout(num_views = 2) in;
out vec3 vColor;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vColor = gl_ViewID_OVR == 0u ? vec3(0.0, 0.55, 0.0) : vec3(0.0, 0.0, 0.6);
  gl_Position = vec4(p, 0.999, 1.0);
}`,
  `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 color;
void main() { color = vec4(vColor, 1.0); }`,
);

// Fragment-heavy full-screen pass for foveation / MSAA experiments (state.heavy = iterations, 0 = off).
const heavyProgram = program(
  `#version 300 es
#extension GL_OVR_multiview2 : require
layout(num_views = 2) in;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.998, 1.0);
}`,
  `#version 300 es
precision highp float;
uniform int uIterations;
in vec2 vUv;
out vec4 color;
void main() {
  vec2 z = vUv * 3.0 - 1.5;
  float acc = 0.0;
  for (int i = 0; i < 512; i++) {
    if (i >= uIterations) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + vec2(-0.4, 0.6);
    acc += exp(-dot(z, z));
  }
  // fine stripes make foveation visible in a capture
  float stripes = step(0.5, fract(gl_FragCoord.x * 0.25));
  color = vec4(vec3(fract(acc * 0.05) * 0.5 + 0.25 * stripes), 1.0);
}`,
);
const uIterations = gl.getUniformLocation(heavyProgram, 'uIterations');
state.heavy = 0;
state.msaa = 4;
state.reattach = false;

const cubeProgram = program(
  `#version 300 es
#extension GL_OVR_multiview2 : require
layout(num_views = 2) in;
uniform mat4 uProj[2];
uniform mat4 uView[2];
uniform mat4 uModel;
in vec3 aPos;
in vec3 aColor;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uProj[gl_ViewID_OVR] * uView[gl_ViewID_OVR] * uModel * vec4(aPos, 1.0);
}`,
  `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 color;
void main() { color = vec4(vColor, 1.0); }`,
);

// Cube: 6 faces, 2 triangles each, one colour per face.
const faces = [
  [
    [1, -1, -1],
    [1, 1, -1],
    [1, 1, 1],
    [1, -1, 1],
    [1, 0.3, 0.3],
  ],
  [
    [-1, -1, 1],
    [-1, 1, 1],
    [-1, 1, -1],
    [-1, -1, -1],
    [0.3, 1, 0.3],
  ],
  [
    [-1, 1, -1],
    [-1, 1, 1],
    [1, 1, 1],
    [1, 1, -1],
    [0.3, 0.3, 1],
  ],
  [
    [-1, -1, 1],
    [-1, -1, -1],
    [1, -1, -1],
    [1, -1, 1],
    [1, 1, 0.3],
  ],
  [
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
    [1, 0.3, 1],
  ],
  [
    [1, -1, -1],
    [-1, -1, -1],
    [-1, 1, -1],
    [1, 1, -1],
    [0.3, 1, 1],
  ],
];
const verts = [];
for (const [a, b, c, d, col] of faces) {
  for (const v of [a, b, c, a, c, d])
    verts.push(v[0] * 0.15, v[1] * 0.15, v[2] * 0.15, col[0], col[1], col[2]);
}
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(cubeProgram, 'aPos');
const aColor = gl.getAttribLocation(cubeProgram, 'aColor');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
gl.enableVertexAttribArray(aColor);
gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 24, 12);
gl.bindVertexArray(null);
const emptyVao = gl.createVertexArray();
const uProj = gl.getUniformLocation(cubeProgram, 'uProj');
const uView = gl.getUniformLocation(cubeProgram, 'uView');
const uModel = gl.getUniformLocation(cubeProgram, 'uModel');
const proj = new Float32Array(32);
const view = new Float32Array(32);
const model = new Float32Array(16);

let session = null;
let space = null;
let binding = null;
let layer = null;
let fbo = null;
let depth = null;
let xrSecond = 0;
let xrCount = 0;

// XR-LOOP-5: the callback time (the predicted display time) against performance.now() at entry, and the deltas
// between consecutive callback times.
state.timing = {
  aheadMin: Infinity,
  aheadMax: -Infinity,
  deltaMin: Infinity,
  deltaMax: -Infinity,
  samples: 0,
};
let lastT = 0;
function noteTiming(t) {
  const tm = state.timing;
  const ahead = t - performance.now();
  if (ahead < tm.aheadMin) tm.aheadMin = ahead;
  if (ahead > tm.aheadMax) tm.aheadMax = ahead;
  if (lastT > 0) {
    const d = t - lastT;
    if (d < tm.deltaMin) tm.deltaMin = d;
    if (d > tm.deltaMax) tm.deltaMax = d;
  }
  lastT = t;
  tm.samples++;
}

function onFrame(t, frame) {
  session.requestAnimationFrame(onFrame);
  noteTiming(t);
  state.xrFrames++;
  xrCount++;
  if (t - xrSecond >= 1000) {
    state.xrFramesPerSecond.push(xrCount);
    if (state.xrFramesPerSecond.length > 30) state.xrFramesPerSecond.shift();
    xrCount = 0;
    xrSecond = t;
  }
  const pose = frame.getViewerPose(space);
  if (!pose) return;
  if (fbo && state.reattach) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(depth);
    fbo = null;
    state.reattach = false;
  }
  if (!fbo) {
    // REG-6: attach once; the runtime keeps the opaque texture pointed at the current image.
    const sub = binding.getViewSubImage(layer, pose.views[0]);
    fbo = state.fbo = gl.createFramebuffer();
    depth = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, depth);
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.DEPTH_COMPONENT24,
      layer.textureWidth,
      layer.textureHeight,
      2,
    );
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
    if (state.msaa > 0) {
      mv.framebufferTextureMultisampleMultiviewOVR(
        gl.DRAW_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        sub.colorTexture,
        0,
        state.msaa,
        0,
        2,
      );
      mv.framebufferTextureMultisampleMultiviewOVR(
        gl.DRAW_FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        depth,
        0,
        state.msaa,
        0,
        2,
      );
    } else {
      const mv2 = gl.getExtension('OVR_multiview2');
      mv2.framebufferTextureMultiviewOVR(
        gl.DRAW_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        sub.colorTexture,
        0,
        0,
        2,
      );
      mv2.framebufferTextureMultiviewOVR(
        gl.DRAW_FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        depth,
        0,
        0,
        2,
      );
    }
    log(
      'framebuffer',
      gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER).toString(16),
      layer.textureWidth,
      layer.textureHeight,
    );
  }
  for (let i = 0; i < 2; i++) {
    proj.set(pose.views[i].projectionMatrix, i * 16);
    view.set(pose.views[i].transform.inverse.matrix, i * 16);
  }
  // cube 1.5 m ahead of the local-floor origin at 1.4 m, spinning
  const a = t / 1000;
  const c = Math.cos(a),
    s = Math.sin(a);
  model.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 1.4, -1.5, 1]);

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
  gl.viewport(0, 0, layer.textureWidth, layer.textureHeight);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(bgProgram);
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (state.heavy > 0) {
    gl.useProgram(heavyProgram);
    gl.uniform1i(uIterations, state.heavy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.useProgram(cubeProgram);
  gl.uniformMatrix4fv(uProj, false, proj);
  gl.uniformMatrix4fv(uView, false, view);
  gl.uniformMatrix4fv(uModel, false, model);
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 36);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

// XRWebGLLayer path (XR-SC-3: no 'layers' feature): one side-by-side image behind the layer's opaque framebuffer,
// one pass per eye with that eye's viewport. Same colours as the multiview path (left green, right blue).
const bgFlatProgram = program(
  `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.999, 1.0);
}`,
  `#version 300 es
precision mediump float;
uniform vec3 uColor;
out vec4 color;
void main() { color = vec4(uColor, 1.0); }`,
);
const uBgColor = gl.getUniformLocation(bgFlatProgram, 'uColor');
const cubeFlatProgram = program(
  `#version 300 es
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
in vec3 aPos;
in vec3 aColor;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`,
  `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 color;
void main() { color = vec4(vColor, 1.0); }`,
);
const uFlatProj = gl.getUniformLocation(cubeFlatProgram, 'uProj');
const uFlatView = gl.getUniformLocation(cubeFlatProgram, 'uView');
const uFlatModel = gl.getUniformLocation(cubeFlatProgram, 'uModel');
const flatVao = gl.createVertexArray();
gl.bindVertexArray(flatVao);
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
const aFlatPos = gl.getAttribLocation(cubeFlatProgram, 'aPos');
const aFlatColor = gl.getAttribLocation(cubeFlatProgram, 'aColor');
gl.enableVertexAttribArray(aFlatPos);
gl.vertexAttribPointer(aFlatPos, 3, gl.FLOAT, false, 24, 0);
gl.enableVertexAttribArray(aFlatColor);
gl.vertexAttribPointer(aFlatColor, 3, gl.FLOAT, false, 24, 12);
gl.bindVertexArray(null);

function onFlatFrame(t, frame) {
  session.requestAnimationFrame(onFlatFrame);
  state.xrFrames++;
  const pose = frame.getViewerPose(space);
  if (!pose) return;
  const base = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, base.framebuffer);
  gl.enable(gl.DEPTH_TEST);
  const a = t / 1000;
  const c = Math.cos(a),
    s = Math.sin(a);
  model.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 1.4, -1.5, 1]);
  for (let i = 0; i < pose.views.length; i++) {
    const vp = base.getViewport(pose.views[i]);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vp.x, vp.y, vp.width, vp.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(bgFlatProgram);
    gl.uniform3fv(uBgColor, i === 0 ? [0, 0.55, 0] : [0, 0, 0.6]);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(cubeFlatProgram);
    gl.uniformMatrix4fv(uFlatProj, false, pose.views[i].projectionMatrix);
    gl.uniformMatrix4fv(
      uFlatView,
      false,
      pose.views[i].transform.inverse.matrix,
    );
    gl.uniformMatrix4fv(uFlatModel, false, model);
    gl.bindVertexArray(flatVao);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }
  gl.bindVertexArray(null);
}

async function start(s) {
  // A new session (XR-LIFE-5 re-entry) has a new layer and opaque texture: attach again at its first frame.
  if (fbo) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(depth);
    fbo = state.fbo = null;
  }
  session = s;
  state.sessionObject = s;
  state.session = {
    features: s.enabledFeatures,
    rates: [...(s.supportedFrameRates ?? [])],
  };
  log('session', JSON.stringify(state.session));
  s.addEventListener('end', () => log('session end'));
  s.addEventListener('visibilitychange', () =>
    log('visibility', s.visibilityState),
  );
  s.addEventListener('frameratechange', () => log('frame rate', s.frameRate));
  space = await s.requestReferenceSpace('local-floor');
  if (mode === 'webgllayer') {
    const base = new XRWebGLLayer(s, gl);
    state.layer = {
      width: base.framebufferWidth,
      height: base.framebufferHeight,
      layers: 1,
    };
    state.layerObject = base;
    s.updateRenderState({ baseLayer: base });
    s.requestAnimationFrame(onFlatFrame);
    return;
  }
  binding = new XRWebGLBinding(s, gl);
  layer = binding.createProjectionLayer({
    textureType: 'texture-array',
    colorFormat: gl.RGBA8,
  });
  state.layer = {
    width: layer.textureWidth,
    height: layer.textureHeight,
    layers: layer.textureArrayLength,
  };
  state.layerObject = layer;
  s.updateRenderState({ layers: [layer] });
  s.requestAnimationFrame(onFrame);
}

// The device check re-enters with a session of its own (XR-LIFE-5: end, then requestSession) through this.
state.start = start;

// Test variants (mode.json next to index.html, written by the device check): 'webgllayer' (XR-SC-3, no 'layers'
// feature), 'nooffer' (XR-LIFE-7: never offers or requests a session), 'request' (requestSession instead of
// offerSession). Default: offerSession with layers + multiview.
const mode =
  globalThis.__xrtestMode ??
  (await fetch('./mode.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => j.mode ?? 'default')
    .catch(() => 'default'));
state.mode = mode;
// globalThis.__xrtestInit overrides the session init (browser-ab.mjs: no hand tracking, so Quest Browser shows no
// permission prompt).
const init = globalThis.__xrtestInit ?? {
  requiredFeatures: ['local-floor'],
  optionalFeatures:
    mode === 'webgllayer' ? ['hand-tracking'] : ['layers', 'hand-tracking'],
};
state.init = init;
// A slow-booting app (the device check's reload case, PROC-8 / XR-LIFE-5): localStorage 'xrtest.offerDelayMs', set
// before a location.reload(), delays this page's offer once.
const offerDelayMs = Number(
  globalThis.localStorage?.getItem('xrtest.offerDelayMs') ?? 0,
);
if (offerDelayMs > 0) {
  globalThis.localStorage.removeItem('xrtest.offerDelayMs');
  log(`offering after ${offerDelayMs} ms`);
  await new Promise((resolve) => setTimeout(resolve, offerDelayMs));
}
state.offeredAt = performance.now();
if (mode !== 'nooffer') {
  (mode === 'request'
    ? navigator.xr.requestSession('immersive-vr', init)
    : navigator.xr.offerSession('immersive-vr', init)
  )
    .then(start)
    .catch((e) => {
      state.errors.push(String(e));
      log('session failed', e);
    });
}
log(
  `booted (mode ${mode}); ${mode === 'nooffer' ? 'never offering a session' : 'waiting for the session'}`,
);
