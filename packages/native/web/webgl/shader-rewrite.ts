/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// GLSL rewrite (spec GL-18): only what WebGL defines differently from GLES, invisible to getShaderSource.
//  - `#extension GL_ANGLE_multi_draw : require|enable` becomes `#define webgl_ANGLE_multi_draw 1` and other uses
//    of the macro name are renamed (the GLES driver has no such extension); vertex shaders that use gl_DrawID get
//    `uniform int webgl_DrawID;` + `#define gl_DrawID webgl_DrawID` (the multi-draw natives set it per sub-draw).
//  - `GL_ANGLE_clip_cull_distance` -> `GL_EXT_clip_cull_distance` (WEBGL_clip_cull_distance).
//  - `GL_OVR_multiview2` passes through; `layout(num_views = N) in;` is recorded for draw validation (GL-24);
//    num_views = 1 is compiled as a single-view program (see rewriteShader).
//  - WebGL 1 shaders (ESSL 1.00) that enable GL_EXT_shader_texture_lod / GL_EXT_frag_depth / GL_EXT_draw_buffers
//    while the driver has no ESSL 1.00 form of them (Adreno, Mesa) are upgraded to ESSL 3.00, where the three
//    features are core (upgradeEssl100). The other shader of such a program is upgraded at link time, since the
//    driver links only shaders of one version.
// Injected identifiers use the reserved `webgl_` prefix. A `#line` directive keeps driver error line numbers
// pointing at the app's source.

export interface RewriteResult {
  source: string;
  numViews: number;
  usesDrawId: boolean;
  /** ESSL 1.00 source (no #version or #version 100) */
  essl100: boolean;
  /** upgraded to ESSL 3.00 */
  upgraded: boolean;
}

/** How ESSL 1.00 extension use is handled when the driver lacks the extension (WebGL 1 contexts). */
export interface UpgradeOptions {
  /** true when the driver compiles `#extension <name>` in ESSL 1.00 itself */
  driverHas: (glslName: string) => boolean;
  maxDrawBuffers: number;
  /** upgrade even without such an extension (the program's other shader was upgraded) */
  force?: boolean;
}

/** ESSL 1.00 extensions whose features are core in ESSL 3.00. */
const UPGRADE_EXTS = [
  'GL_EXT_shader_texture_lod',
  'GL_EXT_frag_depth',
  'GL_EXT_draw_buffers',
];
const ESSL1_DIRECTIVE = (name: string): RegExp =>
  new RegExp(
    `^[ \\t]*#[ \\t]*extension[ \\t]+${name}[ \\t]*:[ \\t]*(\\w+)[ \\t]*$`,
    'm',
  );
const TEXTURE_FUNCS: Record<string, string> = {
  texture2DProjGradEXT: 'textureProjGrad',
  texture2DProjLodEXT: 'textureProjLod',
  texture2DGradEXT: 'textureGrad',
  texture2DLodEXT: 'textureLod',
  textureCubeGradEXT: 'textureGrad',
  textureCubeLodEXT: 'textureLod',
  texture2DProjLod: 'textureProjLod',
  texture2DLod: 'textureLod',
  textureCubeLod: 'textureLod',
  texture2DProj: 'textureProj',
  texture2D: 'texture',
  textureCube: 'texture',
};
const TEXTURE_FUNC_RE = new RegExp(
  `\\b(${Object.keys(TEXTURE_FUNCS).join('|')})\\b`,
  'g',
);

function isEssl100(code: string): boolean {
  const m = /^[ \t]*#[ \t]*version[ \t]+(\d+)/m.exec(code);
  return !m || m[1] === '100';
}

/**
 * ESSL 1.00 -> ESSL 3.00 for the WebGL 1 extensions above: attribute/varying -> in/out, texture*() -> the 3.00
 * overloads, gl_FragDepthEXT -> gl_FragDepth, gl_FragColor / gl_FragData -> declared outputs (gl_FragColor
 * broadcasts to every draw buffer when GL_EXT_draw_buffers is enabled, as WEBGL_draw_buffers specifies). The
 * extension directives go away and their macros stay defined (renamed: GL_* macro names are reserved).
 * Limitation: app identifiers that are ESSL 3.00 keywords or built-in names (e.g. a variable named `texture`)
 * are not renamed, so such shaders still fail to compile.
 */
export function upgradeEssl100(
  src: string,
  isVertex: boolean,
  maxDrawBuffers: number,
): string {
  const code = stripComments(src);
  let out = src.replace(/^([ \t]*#[ \t]*version[ \t]+100\b[^\n]*)$/m, '');
  const defines: string[] = [];
  let broadcast = false;
  for (const name of [...UPGRADE_EXTS, 'GL_OES_standard_derivatives']) {
    const d = ESSL1_DIRECTIVE(name).exec(code);
    if (d && name === 'GL_EXT_draw_buffers') broadcast = true;
    out = out.replace(new RegExp(ESSL1_DIRECTIVE(name).source, 'gm'), '');
    if (out.includes(name)) {
      const short = `webgl_${name.slice(3)}`;
      out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), short);
      defines.push(`#define ${short} 1`);
    }
  }
  if (isVertex) {
    out = out.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
  } else {
    out = out.replace(/\bvarying\b/g, 'in');
  }
  out = out.replace(TEXTURE_FUNC_RE, (m) => TEXTURE_FUNCS[m]);
  const decls: string[] = [];
  if (!isVertex) {
    out = out.replace(/\bgl_FragDepthEXT\b/g, 'gl_FragDepth');
    const n = broadcast ? Math.max(1, maxDrawBuffers) : 1;
    if (/\bgl_FragData\b/.test(code)) {
      out = out.replace(/\bgl_FragData\b/g, 'webgl_FragData');
      decls.push(`out highp vec4 webgl_FragData[${n}];`);
    } else if (/\bgl_FragColor\b/.test(code)) {
      out = out.replace(/\bgl_FragColor\b/g, 'webgl_FragColor');
      if (broadcast && n > 1) {
        decls.push(
          `out highp vec4 webgl_FragData[${n}];`,
          'highp vec4 webgl_FragColor;',
        );
        out = out.replace(/\bvoid(\s+)main(\s*)\(/g, 'void$1webgl_main$2(');
        const copies = Array.from(
          { length: n },
          (_v, i) => `webgl_FragData[${i}] = webgl_FragColor;`,
        ).join(' ');
        out += `\nvoid main() { webgl_main(); ${copies} }\n`;
      } else {
        decls.push('out highp vec4 webgl_FragColor;');
      }
    }
  }
  const head = [...defines, ...decls].join('\n');
  return injectAfterDirectives(
    '#version 300 es\n' + out,
    head ? head + '\n' : '',
    1,
  );
}

const MULTI_DRAW =
  /^[ \t]*#[ \t]*extension[ \t]+GL_ANGLE_multi_draw[ \t]*:[ \t]*\w+[ \t]*$/m;
const CLIP_CULL = /(#[ \t]*extension[ \t]+)GL_ANGLE_clip_cull_distance\b/g;
const NUM_VIEWS = /layout\s*\(\s*num_views\s*=\s*(\d+)\s*\)\s*in\s*;/;
const DRAW_ID = /\bgl_DrawID\b/;

/** Strip comments for detection only (the source handed to the driver keeps them). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * GLSL extensions the driver may support but WebGL gates behind getExtension (or does not offer). A disabled
 * one behaves as unsupported: `#extension X : require` fails to compile, `enable`/`warn` are dropped, and the
 * `X` macro reads as undefined (renamed, since GL_* macro names cannot be #undef'd).
 */
export type ExtensionGate = (glslName: string) => boolean;

const GATED = [
  'GL_OVR_multiview2',
  'GL_OVR_multiview',
  'GL_EXT_clip_cull_distance',
  'GL_ANGLE_clip_cull_distance',
  'GL_EXT_conservative_depth',
  'GL_NV_shader_noperspective_interpolation',
  'GL_OES_sample_variables',
  'GL_OES_shader_multisample_interpolation',
  'GL_EXT_blend_func_extended',
  'GL_EXT_draw_buffers',
  'GL_EXT_frag_depth',
  'GL_EXT_shader_texture_lod',
  'GL_OES_standard_derivatives',
  'GL_ANGLE_shader_pixel_local_storage',
  'GL_EXT_shader_framebuffer_fetch',
];

function gateExtensions(src: string, enabled: ExtensionGate): string {
  let out = src;
  for (const name of GATED) {
    if (!out.includes(name) || enabled(name)) continue;
    const directive = new RegExp(
      `^([ \\t]*#[ \\t]*extension[ \\t]+${name}[ \\t]*:[ \\t]*)(\\w+)[ \\t]*$`,
      'gm',
    );
    out = out.replace(directive, (_m, _pre, behavior: string) =>
      behavior === 'require'
        ? `#error WebGL extension for ${name} is not enabled`
        : '',
    );
    out = out.replace(
      new RegExp(`\\b${name}\\b`, 'g'),
      `webgl_disabled_${name.slice(3)}`,
    );
  }
  return out;
}

export function rewriteShader(
  src: string,
  isVertex: boolean,
  enabled?: ExtensionGate,
  upgrade?: UpgradeOptions,
): RewriteResult {
  if (enabled) src = gateExtensions(src, enabled);
  let code = stripComments(src);
  const essl100 = isEssl100(code);
  let upgraded = false;
  if (
    essl100 &&
    upgrade &&
    (upgrade.force ||
      UPGRADE_EXTS.some(
        (name) => ESSL1_DIRECTIVE(name).test(code) && !upgrade.driverHas(name),
      ))
  ) {
    src = upgradeEssl100(src, isVertex, upgrade.maxDrawBuffers);
    code = stripComments(src);
    upgraded = true;
  }
  const nv = isVertex ? NUM_VIEWS.exec(code) : null;
  const numViews = nv ? Number(nv[1]) : 0;
  const hasMultiDraw = MULTI_DRAW.test(code);
  const usesDrawId = isVertex && hasMultiDraw && DRAW_ID.test(code);
  let out = src;
  // The directive is removed but the extension still reads as supported to the preprocessor, as with a
  // compiler that has it (three.js tests `defined(GL_ANGLE_multi_draw)` to pick its own fallback). GL_* macro
  // names are reserved, so the name is renamed to webgl_ANGLE_multi_draw everywhere and defined.
  if (hasMultiDraw) {
    out = out
      .replace(MULTI_DRAW, '#define webgl_ANGLE_multi_draw 1')
      .replace(/\bGL_ANGLE_multi_draw\b/g, 'webgl_ANGLE_multi_draw');
  }
  if (out.includes('GL_ANGLE_clip_cull_distance'))
    out = out.replace(CLIP_CULL, '$1GL_EXT_clip_cull_distance');
  if (usesDrawId)
    out = injectAfterDirectives(
      out,
      'uniform int webgl_DrawID;\n#define gl_DrawID webgl_DrawID\n',
    );
  // OVR_multiview2 with num_views = 1: WebGL (ANGLE) lets such a program draw to ordinary single-view
  // framebuffers, GLES drivers reject it there. One view is the non-multiview case, so the layout qualifier is
  // dropped and gl_ViewID_OVR reads as view 0; the recorded numViews still drives draw validation (GL-24).
  if (numViews === 1) out = out.replace(NUM_VIEWS, '');
  if (numViews === 1 && /\bgl_ViewID_OVR\b/.test(code))
    out = injectAfterDirectives(out, '#define gl_ViewID_OVR 0u\n');
  if (essl100 && upgrade && enabled) {
    // WebGL 1: an enabled extension the driver lacks (or translates away) still reads as defined to the
    // preprocessor, as with a compiler that has it (CTS ext-shader-texture-lod `#ifdef GL_EXT_shader_texture_lod`).
    // GL_* macro names are reserved, so outside #extension lines the name is renamed to webgl_* and defined.
    for (const name of UPGRADE_EXTS) {
      if (!code.includes(name) || !enabled(name) || upgrade.driverHas(name))
        continue;
      const re = new RegExp(`\\b${name}\\b`);
      let hit = false;
      const lines = out.split('\n').map((l) => {
        if (/^[ \t]*#[ \t]*extension\b/.test(l) || !re.test(l)) return l;
        hit = true;
        return l.replace(
          new RegExp(`\\b${name}\\b`, 'g'),
          `webgl_${name.slice(3)}`,
        );
      });
      if (hit)
        out = injectAfterDirectives(
          lines.join('\n'),
          `#define webgl_${name.slice(3)} 1\n`,
        );
    }
    // WebGL 1.0: gl_MaxDrawBuffers is 1 unless WEBGL_draw_buffers is enabled (drivers report their own limit)
    if (!enabled('GL_EXT_draw_buffers') && /\bgl_MaxDrawBuffers\b/.test(code))
      out = out.replace(/\bgl_MaxDrawBuffers\b/g, '1');
  }
  return { source: out, numViews, usesDrawId, essl100, upgraded };
}

/** Insert `text` after #version and every #extension directive that precedes the first other token. */
function injectAfterDirectives(
  src: string,
  text: string,
  lineShift = 0,
): string {
  const lines = src.split('\n');
  let insertAt = 0;
  let version300 = false;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let t = raw.trim();
    if (inBlock) {
      const end = t.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      t = t.slice(end + 2).trim();
    }
    if (t.startsWith('/*') && !t.includes('*/')) {
      inBlock = true;
      continue;
    }
    if (t === '' || t.startsWith('//')) continue;
    if (/^#\s*version\b/.test(t)) {
      version300 = /\b300\b/.test(t) || /\b310\b/.test(t) || /\b320\b/.test(t);
      insertAt = i + 1;
      continue;
    }
    if (/^#\s*extension\b/.test(t)) {
      insertAt = i + 1;
      continue;
    }
    if (t.startsWith('#')) continue; // other preprocessor lines may precede extensions
    break;
  }
  // ESSL 3.00: `#line N` makes the next line N. ESSL 1.00 drivers disagree on the semantics; skip it there.
  // lineShift: lines the caller added above the app's first line.
  const lineDirective = version300 ? `#line ${insertAt + 1 - lineShift}\n` : '';
  lines.splice(insertAt, 0, text + lineDirective);
  return lines
    .join('\n')
    .replace(text + lineDirective + '\n', text + lineDirective);
}
