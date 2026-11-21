// The binding table: every documented special case of the generated WebGL 2 binding lives here
// (spec GL-PERF-1: "no hand-written per-entry boilerplate beyond the documented special cases").
//
// Two layers are generated from the GLES headers + WebGL IDL and this table:
//
//  1. natives (C++, runtime/gl/generated/): one V8 function per entry, a fast-API C function (CFunction) plus
//     a slow FunctionCallback. Generic entries are raw GLES calls whose C signature is read from the NDK
//     headers; pointer parameters become (view, byteOffset, byteLength) triples (typed arrays by pointer,
//     bounds-checked against the view), `const void*` offsets into bound buffers become doubles, glGen*/glDelete*
//     become single-name forms, `const GLchar*` becomes a string (slow path only). Composite entries are
//     hand-written C++ (runtime/gl/src/composites.*) with generated V8 wrappers.
//
//  2. WebGL methods (TypeScript, web/webgl/gen/methods.gen.ts): for IDL operations classified `direct`, a method
//     that does WebIDL argument conversion, object -> GL name with the ownership / deletion checks of WebGL,
//     then calls the native. Every other IDL operation is classified `custom` (hand-written in web/webgl/, for
//     state caching, error synthesis, reflection records, typed-array rules, zero-init, ...) or `js` (answered
//     entirely in JS: object model, extension registry, attributes). The generator fails if any IDL operation
//     of the WebGL 2 / WebGL 1 contexts or of a supported extension is neither direct nor implemented by a
//     hand-written `name(this: ...)` method in web/webgl/*.ts (generate.mjs checkCoverage). Honest scope: the
//     natives are all generated; most WebGL methods are hand-written (grouped by CUSTOM_REASONS), because nearly
//     every WebGL entry point carries state caching, validation or object rules that GLES does not have.

/** GLES functions exposed as generic natives. Name of the native = GL name without `gl`, first letter lowered. */
export const GL_NATIVES = [
  // state
  'glActiveTexture', 'glBlendColor', 'glBlendEquation', 'glBlendEquationSeparate', 'glBlendFunc',
  'glBlendFuncSeparate', 'glClearColor', 'glClearDepthf', 'glClearStencil', 'glColorMask', 'glCullFace',
  'glDepthFunc', 'glDepthMask', 'glDepthRangef', 'glDisable', 'glEnable', 'glFrontFace', 'glHint', 'glLineWidth',
  'glPixelStorei', 'glPolygonOffset', 'glSampleCoverage', 'glScissor', 'glStencilFunc', 'glStencilFuncSeparate',
  'glStencilMask', 'glStencilMaskSeparate', 'glStencilOp', 'glStencilOpSeparate', 'glViewport',
  // objects
  'glBindBuffer', 'glBindFramebuffer', 'glBindRenderbuffer', 'glBindTexture', 'glBindVertexArray', 'glBindSampler',
  'glBindTransformFeedback', 'glBindBufferBase', 'glBindBufferRange',
  'glGenBuffers', 'glGenFramebuffers', 'glGenRenderbuffers', 'glGenTextures', 'glGenVertexArrays', 'glGenSamplers',
  'glGenTransformFeedbacks', 'glGenQueries',
  'glDeleteBuffers', 'glDeleteFramebuffers', 'glDeleteRenderbuffers', 'glDeleteTextures', 'glDeleteVertexArrays',
  'glDeleteSamplers', 'glDeleteTransformFeedbacks', 'glDeleteQueries',
  'glCreateShader', 'glCreateProgram', 'glDeleteShader', 'glDeleteProgram',
  // buffers
  'glBufferData', 'glBufferSubData', 'glCopyBufferSubData',
  // framebuffers / renderbuffers
  'glFramebufferRenderbuffer', 'glFramebufferTexture2D', 'glFramebufferTextureLayer', 'glCheckFramebufferStatus',
  'glBlitFramebuffer', 'glInvalidateFramebuffer', 'glInvalidateSubFramebuffer', 'glReadBuffer', 'glDrawBuffers',
  'glRenderbufferStorage', 'glRenderbufferStorageMultisample', 'glClear', 'glClearBufferiv', 'glClearBufferuiv',
  'glClearBufferfv', 'glClearBufferfi', 'glReadPixels',
  // textures / samplers
  'glTexImage2D', 'glTexSubImage2D', 'glTexImage3D', 'glTexSubImage3D', 'glTexStorage2D', 'glTexStorage3D',
  'glCompressedTexImage2D', 'glCompressedTexSubImage2D', 'glCompressedTexImage3D', 'glCompressedTexSubImage3D',
  'glCopyTexImage2D', 'glCopyTexSubImage2D', 'glCopyTexSubImage3D', 'glGenerateMipmap', 'glTexParameterf',
  'glTexParameteri', 'glSamplerParameteri', 'glSamplerParameterf',
  // shaders / programs
  'glAttachShader', 'glDetachShader', 'glCompileShader', 'glLinkProgram', 'glUseProgram', 'glValidateProgram',
  'glBindAttribLocation', 'glGetFragDataLocation', 'glUniformBlockBinding',
  // uniforms
  'glUniform1f', 'glUniform2f', 'glUniform3f', 'glUniform4f', 'glUniform1i', 'glUniform2i', 'glUniform3i',
  'glUniform4i', 'glUniform1ui', 'glUniform2ui', 'glUniform3ui', 'glUniform4ui', 'glUniform1fv', 'glUniform2fv',
  'glUniform3fv', 'glUniform4fv', 'glUniform1iv', 'glUniform2iv', 'glUniform3iv', 'glUniform4iv', 'glUniform1uiv',
  'glUniform2uiv', 'glUniform3uiv', 'glUniform4uiv', 'glUniformMatrix2fv', 'glUniformMatrix3fv',
  'glUniformMatrix4fv', 'glUniformMatrix2x3fv', 'glUniformMatrix3x2fv', 'glUniformMatrix2x4fv',
  'glUniformMatrix4x2fv', 'glUniformMatrix3x4fv', 'glUniformMatrix4x3fv',
  // vertex attributes
  'glVertexAttrib1f', 'glVertexAttrib2f', 'glVertexAttrib3f', 'glVertexAttrib4f', 'glVertexAttrib1fv',
  'glVertexAttrib2fv', 'glVertexAttrib3fv', 'glVertexAttrib4fv', 'glVertexAttribI4i', 'glVertexAttribI4ui',
  'glVertexAttribI4iv', 'glVertexAttribI4uiv', 'glVertexAttribPointer', 'glVertexAttribIPointer',
  'glVertexAttribDivisor', 'glEnableVertexAttribArray', 'glDisableVertexAttribArray',
  // drawing
  'glDrawArrays', 'glDrawElements', 'glDrawArraysInstanced', 'glDrawElementsInstanced', 'glDrawRangeElements',
  'glFinish', 'glFlush',
  // queries / transform feedback
  'glBeginQuery', 'glEndQuery', 'glGetQueryObjectuiv', 'glBeginTransformFeedback', 'glEndTransformFeedback',
  'glPauseTransformFeedback', 'glResumeTransformFeedback',
  // state queries that write into a typed array (getParameter & co. fall back to these when JS has no answer)
  'glGetError', 'glGetIntegerv', 'glGetFloatv', 'glGetBooleanv', 'glGetInteger64v', 'glGetIntegeri_v', 'glGetBooleani_v',
  'glGetInteger64i_v', 'glGetBufferParameteriv', 'glGetFramebufferAttachmentParameteriv',
  'glGetRenderbufferParameteriv', 'glGetTexParameteriv', 'glGetTexParameterfv', 'glGetSamplerParameteriv',
  'glGetSamplerParameterfv', 'glGetProgramiv', 'glGetShaderiv', 'glGetVertexAttribiv', 'glGetVertexAttribfv',
  'glGetVertexAttribIiv', 'glGetVertexAttribIuiv', 'glGetUniformfv', 'glGetUniformiv', 'glGetUniformuiv',
  'glGetInternalformativ', 'glGetShaderPrecisionFormat', 'glGetQueryiv', 'glIsEnabled',
  // extension entry points (loaded through eglGetProcAddress; null when the driver lacks them)
  'glFramebufferTextureMultiviewOVR', 'glFramebufferTextureMultisampleMultiviewOVR',
  'glFramebufferTexture2DMultisampleEXT', 'glRenderbufferStorageMultisampleEXT', 'glMaxShaderCompilerThreadsKHR',
  'glQueryCounterEXT', 'glGetQueryObjectui64vEXT', 'glClipControlEXT', 'glPolygonOffsetClampEXT',
  'glPolygonModeNV', 'glEnableiOES', 'glDisableiOES', 'glBlendEquationiOES', 'glBlendEquationSeparateiOES',
  'glBlendFunciOES', 'glBlendFuncSeparateiOES', 'glColorMaskiOES', 'glGetGraphicsResetStatusEXT',
];

/**
 * Per-GL-function pointer-parameter overrides. Default classification:
 *   `const void*` named `indices` or `pointer`  -> 'offset'  (byte offset into the bound buffer, a double)
 *   any other `const T*`                        -> 'in'      (typed array by pointer: view, byteOffset, byteLength)
 *   `T*` (non-const)                            -> 'out'
 *   `const GLchar*`                             -> 'string'  (slow path only)
 * `pbo` lists functions that also get an `<name>Offset` native where the data pointer is a buffer offset
 * (PIXEL_UNPACK_BUFFER / PIXEL_PACK_BUFFER).
 * `need` gives a C++ expression of the minimum byteLength for an 'in'/'out' view, in terms of the GL parameters;
 * the native silently skips the call if the view is smaller (JS has already recorded the WebGL error).
 */
/** C++ statements run after a generic native's GL call (arguments in scope by their GL names). */
export const GL_POST = {
  glPixelStorei: 'TrackPixelStore(pname, param);',
};

export const GL_POINTERS = {
  pbo: [
    'glTexImage2D', 'glTexSubImage2D', 'glTexImage3D', 'glTexSubImage3D', 'glCompressedTexImage2D',
    'glCompressedTexSubImage2D', 'glCompressedTexImage3D', 'glCompressedTexSubImage3D', 'glReadPixels',
  ],
  need: {
    glUniform1fv: { value: 'count * 4' }, glUniform2fv: { value: 'count * 8' }, glUniform3fv: { value: 'count * 12' },
    glUniform4fv: { value: 'count * 16' }, glUniform1iv: { value: 'count * 4' }, glUniform2iv: { value: 'count * 8' },
    glUniform3iv: { value: 'count * 12' }, glUniform4iv: { value: 'count * 16' }, glUniform1uiv: { value: 'count * 4' },
    glUniform2uiv: { value: 'count * 8' }, glUniform3uiv: { value: 'count * 12' }, glUniform4uiv: { value: 'count * 16' },
    glUniformMatrix2fv: { value: 'count * 16' }, glUniformMatrix3fv: { value: 'count * 36' },
    glUniformMatrix4fv: { value: 'count * 64' }, glUniformMatrix2x3fv: { value: 'count * 24' },
    glUniformMatrix3x2fv: { value: 'count * 24' }, glUniformMatrix2x4fv: { value: 'count * 32' },
    glUniformMatrix4x2fv: { value: 'count * 32' }, glUniformMatrix3x4fv: { value: 'count * 48' },
    glUniformMatrix4x3fv: { value: 'count * 48' },
    glVertexAttrib1fv: { v: '4' }, glVertexAttrib2fv: { v: '8' }, glVertexAttrib3fv: { v: '12' },
    glVertexAttrib4fv: { v: '16' }, glVertexAttribI4iv: { v: '16' }, glVertexAttribI4uiv: { v: '16' },
    glClearBufferiv: { value: '(buffer == 0x1800 ? 16 : 4)' }, glClearBufferuiv: { value: '16' },
    glClearBufferfv: { value: '(buffer == 0x1800 ? 16 : 4)' },
    glDrawBuffers: { bufs: 'n * 4' }, glInvalidateFramebuffer: { attachments: 'numAttachments * 4' },
    glInvalidateSubFramebuffer: { attachments: 'numAttachments * 4' },
    glBufferData: { data: 'size' }, glBufferSubData: { data: 'size' },
    // pixel transfers: the bytes GL touches under the current pack/unpack state (native shadow, composites.cc);
    // '?' = a null view (no data: GL allocates only) skips the check
    glReadPixels: { pixels: '?PackImageBytes(width, height, format, type)' },
    glTexImage2D: { pixels: '?UnpackImageBytes(width, height, 1, format, type)' },
    glTexSubImage2D: { pixels: '?UnpackImageBytes(width, height, 1, format, type)' },
    glTexImage3D: { pixels: '?UnpackImageBytes(width, height, depth, format, type)' },
    glTexSubImage3D: { pixels: '?UnpackImageBytes(width, height, depth, format, type)' },
    glCompressedTexImage2D: { data: 'imageSize' }, glCompressedTexSubImage2D: { data: 'imageSize' },
    glCompressedTexImage3D: { data: 'imageSize' }, glCompressedTexSubImage3D: { data: 'imageSize' },
    glGetIntegerv: { data: '4' }, glGetFloatv: { data: '4' }, glGetBooleanv: { data: '1' }, glGetInteger64v: { data: '8' },
    glGetIntegeri_v: { data: '4' }, glGetInteger64i_v: { data: '8' }, glGetBooleani_v: { data: '4' }, glGetBufferParameteriv: { params: '4' },
    glGetFramebufferAttachmentParameteriv: { params: '4' }, glGetRenderbufferParameteriv: { params: '4' },
    glGetTexParameteriv: { params: '4' }, glGetTexParameterfv: { params: '4' }, glGetSamplerParameteriv: { params: '4' },
    glGetSamplerParameterfv: { params: '4' }, glGetProgramiv: { params: '4' }, glGetShaderiv: { params: '4' },
    glGetVertexAttribiv: { params: '4' }, glGetVertexAttribfv: { params: '4' }, glGetVertexAttribIiv: { params: '4' },
    glGetVertexAttribIuiv: { params: '4' }, glGetUniformfv: { params: '4' }, glGetUniformiv: { params: '4' },
    glGetUniformuiv: { params: '4' }, glGetInternalformativ: { params: 'bufSize * 4' },
    glGetShaderPrecisionFormat: { range: '8', precision: '4' }, glGetQueryiv: { params: '4' },
    glGetQueryObjectuiv: { params: '4' }, glGetQueryObjectui64vEXT: { params: '8' },
  },
};

/**
 * Composite natives: hand-written C++ in runtime/gl/src/composites.cc (V8-free core) and
 * runtime/gl/src/gl_v8_composites.cc (the few that build JS values). The generator emits their V8
 * wrappers and TS declarations. Arg kinds: u32 i32 f32 f64 bool in out string strings any.
 * `ret: 'any'` / string args = slow path only (they allocate JS values).
 */
export const COMPOSITES = [
  // contexts (EGL). attribs: Int32Array of [key, value, ...] (see src/egl_context.h)
  { name: 'contextCreate', args: [['attribs', 'in']], ret: 'u32', doc: 'create an ES 3.2 context sharing the root share group; 0 on failure' },
  { name: 'contextMakeCurrent', args: [['id', 'u32']], ret: 'bool' },
  { name: 'contextDestroy', args: [['id', 'u32']], ret: 'void' },
  { name: 'contextResetStatus', args: [['id', 'u32']], ret: 'u32', doc: 'GL_NO_ERROR or a reset status (robust contexts)' },
  { name: 'contextInfo', args: [['id', 'u32']], ret: 'any', doc: '{ version, renderer, vendor, glsl, extensions[], robust, limits }' },
  // shaders / programs (GL-18..GL-21)
  { name: 'shaderSource', args: [['shader', 'u32'], ['source', 'string']], ret: 'void' },
  { name: 'shaderInfo', args: [['shader', 'u32']], ret: 'any', doc: '[compileStatus, infoLog] (blocks only on this shader)' },
  { name: 'programInfo', args: [['program', 'u32']], ret: 'any', doc: 'link status, info log and the full reflection record in one call' },
  { name: 'shaderCompletion', args: [['shader', 'u32']], ret: 'bool', doc: 'COMPLETION_STATUS_KHR; true without the driver extension' },
  { name: 'programCompletion', args: [['program', 'u32']], ret: 'bool' },
  { name: 'programValidate', args: [['program', 'u32']], ret: 'any', doc: '[validateStatus, infoLog]' },
  { name: 'transformFeedbackVaryings', args: [['program', 'u32'], ['varyings', 'strings'], ['bufferMode', 'u32']], ret: 'void' },
  // zero-initialisation (GL-3)
  { name: 'bufferDataZero', args: [['target', 'u32'], ['size', 'f64'], ['usage', 'u32']], ret: 'void' },
  { name: 'clearTextureImage', args: [['target', 'u32'], ['texture', 'u32'], ['level', 'i32'], ['layers', 'i32'], ['internalformat', 'u32'], ['width', 'i32'], ['height', 'i32'], ['depth', 'i32']], ret: 'bool', doc: 'zero a texture level through a scratch framebuffer; false if not renderable (caller uploads zeros)' },
  { name: 'clearRenderbuffer', args: [['renderbuffer', 'u32'], ['internalformat', 'u32']], ret: 'void' },
  // WebGL 2 getBufferSubData (GLES has no glGetBufferSubData: map for reading, copy, unmap)
  { name: 'getBufferSubData', args: [['target', 'u32'], ['offset', 'f64'], ['dst', 'out']], ret: 'bool' },
  // multi-draw (GL-25): one transition per call; drawIdLocation >= 0 sets webgl_DrawID per sub-draw
  { name: 'multiDrawArrays', args: [['mode', 'u32'], ['firsts', 'in'], ['counts', 'in'], ['instanceCounts', 'in'], ['drawcount', 'i32'], ['drawIdLocation', 'i32']], ret: 'void' },
  { name: 'multiDrawElements', args: [['mode', 'u32'], ['counts', 'in'], ['type', 'u32'], ['offsets', 'in'], ['instanceCounts', 'in'], ['drawcount', 'i32'], ['drawIdLocation', 'i32']], ret: 'void' },
  // sync objects: GLsync pointers live in a native table, JS sees ids
  { name: 'fenceSync', args: [['condition', 'u32'], ['flags', 'u32']], ret: 'u32' },
  { name: 'deleteSync', args: [['id', 'u32']], ret: 'void' },
  { name: 'clientWaitSync', args: [['id', 'u32'], ['flags', 'u32'], ['timeout', 'f64']], ret: 'u32' },
  { name: 'waitSync', args: [['id', 'u32'], ['flags', 'u32'], ['timeout', 'f64']], ret: 'void' },
  { name: 'getSynciv', args: [['id', 'u32'], ['pname', 'u32']], ret: 'i32' },
  // strings
  { name: 'getString', args: [['name', 'u32']], ret: 'any' },
  // decoded images (runtime/image handles, INTEROP.md §3): RGBA8 upload straight from the native pixel store,
  // or a copy into a JS buffer for other formats. alphaMode: -1 keep, 0 straight, 1 premultiplied.
  { name: 'imageUpload', args: [['handle', 'any'], ['target', 'u32'], ['level', 'i32'], ['internalformat', 'i32'], ['xoffset', 'i32'], ['yoffset', 'i32'], ['zoffset', 'i32'], ['mode', 'i32'], ['flipY', 'bool'], ['alphaMode', 'i32']], ret: 'bool', doc: 'mode 0 texImage2D, 1 texSubImage2D, 2 texSubImage3D (one layer); false if the handle is not an image or is closed' },
  { name: 'imageRead', args: [['handle', 'any'], ['dst', 'out'], ['flipY', 'bool'], ['alphaMode', 'i32']], ret: 'bool', doc: 'tight RGBA8 copy (width*height*4 bytes) of an image handle' },
  // TexImageSource pixels (GL-17, C2D-3): RGBA8 region copy with flip and alpha conversion, off the JS loop
  { name: 'convertRgba8', args: [['src', 'in'], ['srcWidth', 'i32'], ['x', 'i32'], ['y', 'i32'], ['width', 'i32'], ['height', 'i32'], ['dst', 'out'], ['flipY', 'bool'], ['alphaOp', 'i32']], ret: 'bool', doc: 'alphaOp: 0 none, 1 premultiply, 2 un-premultiply; false if the region or views are out of range' },
  // stats + call recorder hooks (GL-PERF-2 checks, GL-21 counting)
  { name: 'stats', args: [['out', 'out']], ret: 'void', doc: 'Float64Array: [glCalls, glGetErrorCalls, syncQueries, ...] counted natively' },
  { name: 'resetStats', args: [], ret: 'void' },
];

/**
 * IDL operation classification. Keys are operation names on WebGLRenderingContextBase /
 * WebGL2RenderingContextBase / extension interfaces (`Ext.op` for extensions).
 *  direct: generated JS method -> generic native of the same name (or `gl`), objects -> names.
 *  custom: hand-written in web/webgl (reason given).
 *  js:     answered without natives.
 */
export const DIRECT = {
  finish: {}, flush: {},
  // extensions (method on the extension object; `this` is the extension, its context is `this._gl`)
  // EXTClipControl.clipControlEXT, EXTPolygonOffsetClamp.polygonOffsetClampEXT, WebGLPolygonMode.polygonModeWEBGL:
  // custom (state cache + getParameter answers, extensions.ts).
};

export const CUSTOM_REASONS = {
  state: 'state cache (GL-PERF-2): dropped when unchanged, answers getParameter without a driver round trip',
  objects: 'object model (GL-5): wrapper identity, ownership, deletion, isX semantics',
  buffers: 'buffer type rules (WebGL 2.0 §5.1) and typed-array arguments (GL-7), zero-init (GL-3)',
  textures: 'typed-array / pixel-store rules (GL-7, GL-16), TexImageSource uploads (GL-17), zero-init (GL-3)',
  programs: 'shader rewrite (GL-18), parallel compile (GL-20), reflection record (GL-21)',
  uniforms: 'location objects (GL-8), uniform value cache (GL-PERF-2), list conversion without allocation (GL-PERF-3)',
  draws: 'draw-time validation (GL-9: multiview views, feedback loops, client arrays), multi-draw (GL-25)',
  framebuffers: 'attachment tracking (GL-5, GL-24), default framebuffer emulation, drawBuffers rules',
  queries: 'GL-15 availability rule, GL-26 timer queries, sync ids',
  getters: 'WebGL return types (GL-13) answered from JS state where possible',
  context: 'context attributes, loss (GL-4), extensions (GL-23), errors (GL-9, GL-10)',
};

/** Which IDL interfaces form each context / extension object, and the GL capability each extension needs (GL-23). */
export const EXTENSIONS = {
  // name: [IDL interface, availability expression over the driver extension set `has(...)` / `es32`]
  EXT_color_buffer_float: ['EXTColorBufferFloat', 'true'],
  EXT_color_buffer_half_float: ['EXTColorBufferHalfFloat', 'true'],
  EXT_float_blend: ['EXTFloatBlend', "has('GL_EXT_float_blend')"],
  OES_texture_float_linear: ['OESTextureFloatLinear', "has('GL_OES_texture_float_linear')"],
  EXT_texture_filter_anisotropic: ['EXTTextureFilterAnisotropic', "has('GL_EXT_texture_filter_anisotropic')"],
  EXT_texture_norm16: ['EXTTextureNorm16', "has('GL_EXT_texture_norm16')"],
  EXT_clip_control: ['EXTClipControl', "has('GL_EXT_clip_control')"],
  WEBGL_clip_cull_distance: ['WebGLClipCullDistance', "has('GL_EXT_clip_cull_distance')"],
  KHR_parallel_shader_compile: ['KHRParallelShaderCompile', "has('GL_KHR_parallel_shader_compile')"],
  EXT_disjoint_timer_query_webgl2: ['EXTDisjointTimerQueryWebGL2', "has('GL_EXT_disjoint_timer_query')"],
  WEBGL_compressed_texture_astc: ['WebGLCompressedTextureASTC', "has('GL_KHR_texture_compression_astc_ldr')"],
  WEBGL_compressed_texture_etc: ['WebGLCompressedTextureETC', 'true'],
  WEBGL_compressed_texture_etc1: ['WebGLCompressedTextureETC1', "has('GL_OES_compressed_ETC1_RGB8_texture')"],
  WEBGL_compressed_texture_s3tc: ['WebGLCompressedTextureS3TC', "has('GL_EXT_texture_compression_s3tc') || (has('GL_EXT_texture_compression_dxt1') && has('GL_ANGLE_texture_compression_dxt3') && has('GL_ANGLE_texture_compression_dxt5'))"],
  WEBGL_compressed_texture_s3tc_srgb: ['WebGLCompressedTextureS3TCsRGB', "has('GL_EXT_texture_compression_s3tc_srgb')"],
  WEBGL_compressed_texture_pvrtc: ['WebGLCompressedTexturePVRTC', "has('GL_IMG_texture_compression_pvrtc')"],
  EXT_texture_compression_bptc: ['EXTTextureCompressionBPTC', "has('GL_EXT_texture_compression_bptc')"],
  EXT_texture_compression_rgtc: ['EXTTextureCompressionRGTC', "has('GL_EXT_texture_compression_rgtc')"],
  WEBGL_lose_context: ['WebGLLoseContext', 'true'],
  WEBGL_debug_renderer_info: ['WebGLDebugRendererInfo', 'true'],
  WEBGL_debug_shaders: ['WebGLDebugShaders', 'true'],
  WEBGL_multi_draw: ['WebGLMultiDraw', 'true'],
  WEBGL_render_shared_exponent: ['WebGLRenderSharedExponent', "has('GL_QCOM_render_shared_exponent')"],
  WEBGL_multisampled_render_to_texture: [null, "has('GL_EXT_multisampled_render_to_texture')"],
  OVR_multiview2: ['OVRMultiview2', "has('GL_OVR_multiview2')"],
  OCULUS_multiview: [null, "has('GL_OVR_multiview2') && has('GL_OVR_multiview_multisampled_render_to_texture')"],
  OES_draw_buffers_indexed: ['OESDrawBuffersIndexed', "es32 || has('GL_OES_draw_buffers_indexed')"],
  EXT_texture_mirror_clamp_to_edge: ['EXTTextureMirrorClampToEdge', "has('GL_EXT_texture_mirror_clamp_to_edge')"],
  WEBGL_provoking_vertex: ['WebGLProvokingVertex', "has('GL_ANGLE_provoking_vertex') || has('GL_EXT_provoking_vertex')"],
  EXT_polygon_offset_clamp: ['EXTPolygonOffsetClamp', "has('GL_EXT_polygon_offset_clamp')"],
  WEBGL_polygon_mode: ['WebGLPolygonMode', "has('GL_NV_polygon_mode') || has('GL_ANGLE_polygon_mode')"],
};

/** WebGL 1 surface extensions (GL-23 last sentence), mapped onto ES 3 core. */
export const EXTENSIONS_WEBGL1 = {
  OES_texture_float: ['OESTextureFloat', 'true'],
  OES_texture_half_float: ['OESTextureHalfFloat', 'true'],
  OES_texture_half_float_linear: ['OESTextureHalfFloatLinear', 'true'],
  OES_texture_float_linear: ['OESTextureFloatLinear', "has('GL_OES_texture_float_linear')"],
  OES_standard_derivatives: ['OESStandardDerivatives', 'true'],
  ANGLE_instanced_arrays: ['ANGLEInstancedArrays', 'true'],
  OES_vertex_array_object: ['OESVertexArrayObject', 'true'],
  WEBGL_depth_texture: ['WebGLDepthTexture', 'true'],
  OES_element_index_uint: ['OESElementIndexUint', 'true'],
  EXT_sRGB: ['EXTsRGB', 'true'],
  EXT_shader_texture_lod: ['EXTShaderTextureLOD', 'true'],
  EXT_frag_depth: ['EXTFragDepth', 'true'],
  WEBGL_draw_buffers: ['WebGLDrawBuffers', 'true'],
  EXT_blend_minmax: ['EXTBlendMinMax', 'true'],
  WEBGL_color_buffer_float: ['WebGLColorBufferFloat', 'true'],
  EXT_color_buffer_half_float: ['EXTColorBufferHalfFloat', 'true'],
  EXT_texture_filter_anisotropic: ['EXTTextureFilterAnisotropic', "has('GL_EXT_texture_filter_anisotropic')"],
  EXT_float_blend: ['EXTFloatBlend', "has('GL_EXT_float_blend')"],
  EXT_disjoint_timer_query: ['EXTDisjointTimerQuery', "has('GL_EXT_disjoint_timer_query')"],
  WEBGL_compressed_texture_astc: ['WebGLCompressedTextureASTC', "has('GL_KHR_texture_compression_astc_ldr')"],
  WEBGL_compressed_texture_etc: ['WebGLCompressedTextureETC', 'true'],
  WEBGL_compressed_texture_etc1: ['WebGLCompressedTextureETC1', "has('GL_OES_compressed_ETC1_RGB8_texture')"],
  WEBGL_lose_context: ['WebGLLoseContext', 'true'],
  WEBGL_debug_renderer_info: ['WebGLDebugRendererInfo', 'true'],
  WEBGL_debug_shaders: ['WebGLDebugShaders', 'true'],
  WEBGL_multi_draw: ['WebGLMultiDraw', 'true'],
  KHR_parallel_shader_compile: ['KHRParallelShaderCompile', "has('GL_KHR_parallel_shader_compile')"],
};

/**
 * Extension interfaces the Chromium IDL lacks (written here from the extension specifications).
 * OCULUS_multiview: Oculus Browser's extension (MSAA multiview), GL-24.
 * WEBGL_multisampled_render_to_texture: GL-23 lists it; the Khronos draft is not in Chromium's IDL.
 */
export const EXTRA_IDL = `
[LegacyNoInterfaceObject]
interface OCULUSMultiview {
    const GLenum FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR = 0x9630;
    const GLenum FRAMEBUFFER_ATTACHMENT_TEXTURE_BASE_VIEW_INDEX_OVR = 0x9632;
    const GLenum MAX_VIEWS_OVR = 0x9631;
    const GLenum FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR = 0x9633;
    void framebufferTextureMultiviewOVR(GLenum target, GLenum attachment, WebGLTexture? texture, GLint level,
                                        GLint baseViewIndex, GLsizei numViews);
    void framebufferTextureMultisampleMultiviewOVR(GLenum target, GLenum attachment, WebGLTexture? texture,
                                                   GLint level, GLsizei samples, GLint baseViewIndex,
                                                   GLsizei numViews);
};
[LegacyNoInterfaceObject]
interface WebGLMultisampledRenderToTexture {
    const GLenum RENDERBUFFER_SAMPLES_EXT = 0x8CAB;
    const GLenum FRAMEBUFFER_INCOMPLETE_MULTISAMPLE_EXT = 0x8D56;
    const GLenum MAX_SAMPLES_EXT = 0x8D57;
    const GLenum FRAMEBUFFER_ATTACHMENT_TEXTURE_SAMPLES_EXT = 0x8D6C;
    void renderbufferStorageMultisampleEXT(GLenum target, GLsizei samples, GLenum internalformat,
                                           GLsizei width, GLsizei height);
    void framebufferTexture2DMultisampleEXT(GLenum target, GLenum attachment, GLenum textarget,
                                            WebGLTexture? texture, GLint level, GLsizei samples);
};
`;

EXTENSIONS.OCULUS_multiview[0] = 'OCULUSMultiview';
EXTENSIONS.WEBGL_multisampled_render_to_texture[0] = 'WebGLMultisampledRenderToTexture';
