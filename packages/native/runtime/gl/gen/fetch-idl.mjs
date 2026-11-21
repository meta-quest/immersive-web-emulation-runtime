#!/usr/bin/env node
// Refreshes the vendored WebGL IDL files in gen/idl/ from Chromium's Blink tree (gitiles, base64 TEXT format)
// at a pinned revision, and records the revision in gen/idl/REVISION.
//
// Usage: node fetch-idl.mjs [<chromium commit>]   (default: the commit in gen/idl/REVISION, else refs/heads/main)
// Network: uses curl, so the usual https_proxy environment applies behind a proxy.
// The IDL files are BSD-3-Clause (Chromium); see packages/native/THIRD_PARTY.md.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'idl');
const BASE = 'https://chromium.googlesource.com/chromium/src/+';
const DIR = 'third_party/blink/renderer/modules/webgl';

// Files the generator reads. Object interfaces + both rendering contexts + the extensions in spec GL-23.
export const IDL_FILES = [
  'webgl_rendering_context_base.idl',
  'webgl2_rendering_context_base.idl',
  'webgl_rendering_context.idl',
  'webgl2_rendering_context.idl',
  'webgl_context_attributes.idl',
  'webgl_context_event.idl',
  'webgl_context_event_init.idl',
  'webgl_active_info.idl',
  'webgl_shader_precision_format.idl',
  'webgl_object.idl',
  'webgl_buffer.idl',
  'webgl_framebuffer.idl',
  'webgl_program.idl',
  'webgl_query.idl',
  'webgl_renderbuffer.idl',
  'webgl_sampler.idl',
  'webgl_shader.idl',
  'webgl_sync.idl',
  'webgl_texture.idl',
  'webgl_transform_feedback.idl',
  'webgl_uniform_location.idl',
  'webgl_vertex_array_object.idl',
  'webgl_vertex_array_object_oes.idl',
  'webgl_timer_query_ext.idl',
  // extensions (WebGL 2 surface)
  'ext_color_buffer_float.idl',
  'ext_color_buffer_half_float.idl',
  'ext_float_blend.idl',
  'oes_texture_float_linear.idl',
  'ext_texture_filter_anisotropic.idl',
  'ext_texture_norm_16.idl',
  'ext_clip_control.idl',
  'webgl_clip_cull_distance.idl',
  'khr_parallel_shader_compile.idl',
  'ext_disjoint_timer_query_webgl2.idl',
  'webgl_compressed_texture_astc.idl',
  'webgl_compressed_texture_etc.idl',
  'webgl_compressed_texture_etc1.idl',
  'webgl_compressed_texture_s3tc.idl',
  'webgl_compressed_texture_s3tc_srgb.idl',
  'webgl_compressed_texture_pvrtc.idl',
  'ext_texture_compression_bptc.idl',
  'ext_texture_compression_rgtc.idl',
  'webgl_lose_context.idl',
  'webgl_debug_renderer_info.idl',
  'webgl_debug_shaders.idl',
  'webgl_multi_draw.idl',
  'webgl_render_shared_exponent.idl',
  'ovr_multiview_2.idl',
  'oes_draw_buffers_indexed.idl',
  'ext_texture_mirror_clamp_to_edge.idl',
  'webgl_provoking_vertex.idl',
  'ext_polygon_offset_clamp.idl',
  'webgl_polygon_mode.idl',
  // WebGL 1 surface extensions mapped onto ES 3 core
  'oes_texture_float.idl',
  'oes_texture_half_float.idl',
  'oes_texture_half_float_linear.idl',
  'oes_standard_derivatives.idl',
  'angle_instanced_arrays.idl',
  'oes_vertex_array_object.idl',
  'webgl_depth_texture.idl',
  'oes_element_index_uint.idl',
  'ext_srgb.idl',
  'ext_shader_texture_lod.idl',
  'ext_frag_depth.idl',
  'webgl_draw_buffers.idl',
  'ext_blend_min_max.idl',
  'webgl_color_buffer_float.idl',
  'ext_disjoint_timer_query.idl',
];

function curl(url) {
  return execFileSync('curl', ['-sSf', '--max-time', '60', url], { maxBuffer: 64 << 20 });
}

function main() {
  mkdirSync(outDir, { recursive: true });
  const revFile = join(outDir, 'REVISION');
  let rev = process.argv[2];
  if (!rev && existsSync(revFile)) rev = readFileSync(revFile, 'utf8').match(/^commit (\w+)/m)?.[1];
  if (!rev) {
    const head = curl(`${BASE}/refs/heads/main?format=JSON`).toString('utf8');
    rev = JSON.parse(head.slice(head.indexOf('{'))).commit;
  }
  for (const file of IDL_FILES) {
    const b64 = curl(`${BASE}/${rev}/${DIR}/${file}?format=TEXT`).toString('utf8');
    writeFileSync(join(outDir, file), Buffer.from(b64, 'base64'));
    process.stdout.write(`${file}\n`);
  }
  writeFileSync(
    revFile,
    `commit ${rev}\nsource ${BASE}/${rev}/${DIR}/\nfetched ${new Date().toISOString().slice(0, 10)}\nlicense BSD-3-Clause (Chromium Authors)\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
