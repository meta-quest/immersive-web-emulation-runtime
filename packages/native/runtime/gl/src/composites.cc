// V8-independent composite natives. Sources: OpenGL ES 3.2 spec (program interface queries, §7.3-7.6;
// framebuffer clears §15.2; sync objects §4.1), KHR_parallel_shader_compile, WebGL 2.0 §5 (zero-init,
// multi-draw semantics from WEBGL_multi_draw). Written for this runtime; no third-party code.

#include "composites.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <unordered_map>

#include "egl_context.h"

namespace iwn::gl {

GlStats& Stats() {
  static GlStats stats;
  return stats;
}

namespace {

GlApi& A() { return Api(); }

// --------------------------------------------------------------------------- extensions

std::vector<std::string>& ExtensionCache() {
  static std::vector<std::string> exts;
  return exts;
}

void EnsureExtensions() {
  auto& exts = ExtensionCache();
  if (!exts.empty()) return;
  GLint n = 0;
  A().GetIntegerv(GL_NUM_EXTENSIONS, &n);
  for (GLint i = 0; i < n; ++i) {
    const GLubyte* s = A().GetStringi(GL_EXTENSIONS, GLuint(i));
    if (s) exts.emplace_back(reinterpret_cast<const char*>(s));
  }
  if (exts.empty()) exts.emplace_back("");  // driver reports none: remember that we asked
}

// --------------------------------------------------------------------------- sync ids

std::unordered_map<uint32_t, GLsync>& SyncMap() {
  static std::unordered_map<uint32_t, GLsync> map;
  return map;
}
uint32_t g_next_sync = 1;

// --------------------------------------------------------------------------- scratch framebuffers

std::unordered_map<uint32_t, GLuint>& ScratchFbos() {
  static std::unordered_map<uint32_t, GLuint> map;
  return map;
}

GLuint ScratchFbo() {
  const uint32_t ctx = EglEnvironment::Get().current();
  auto& map = ScratchFbos();
  auto it = map.find(ctx);
  if (it != map.end()) return it->second;
  GLuint fbo = 0;
  A().GenFramebuffers(1, &fbo);
  map[ctx] = fbo;
  return fbo;
}

// Saves and restores the state a clear touches.
struct ClearStateGuard {
  GLint drawFbo = 0;
  GLboolean scissor = GL_FALSE, rasterDiscard = GL_FALSE;
  GLboolean colorMask[4] = {GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE};
  GLboolean depthMask = GL_TRUE;
  GLint stencilMaskFront = -1, stencilMaskBack = -1;
  GLint drawBuffer0 = GL_COLOR_ATTACHMENT0;
  ClearStateGuard() {
    A().GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawFbo);
    scissor = A().IsEnabled(GL_SCISSOR_TEST);
    rasterDiscard = A().IsEnabled(GL_RASTERIZER_DISCARD);
    A().GetBooleanv(GL_COLOR_WRITEMASK, colorMask);
    A().GetBooleanv(GL_DEPTH_WRITEMASK, &depthMask);
    A().GetIntegerv(GL_STENCIL_WRITEMASK, &stencilMaskFront);
    A().GetIntegerv(GL_STENCIL_BACK_WRITEMASK, &stencilMaskBack);
    if (scissor) A().Disable(GL_SCISSOR_TEST);
    if (rasterDiscard) A().Disable(GL_RASTERIZER_DISCARD);
    A().ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    A().DepthMask(GL_TRUE);
    A().StencilMaskSeparate(GL_FRONT_AND_BACK, 0xFFFFFFFFu);
  }
  ~ClearStateGuard() {
    if (scissor) A().Enable(GL_SCISSOR_TEST);
    if (rasterDiscard) A().Enable(GL_RASTERIZER_DISCARD);
    A().ColorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
    A().DepthMask(depthMask);
    A().StencilMaskSeparate(GL_FRONT, GLuint(stencilMaskFront));
    A().StencilMaskSeparate(GL_BACK, GLuint(stencilMaskBack));
    A().BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(drawFbo));
  }
};

// Textures are zero-filled (depth 0); renderbuffers and the drawing buffer start at the default clear values
// (depth 1.0, stencil 0), as WebGL 1.0 §4.1 specifies for buffers.
bool ClearBoundAttachment(ClearKind kind, float depth = 0.0f) {
  const GLfloat zf[4] = {0, 0, 0, 0};
  const GLfloat zd[1] = {depth};
  const GLint zi[4] = {0, 0, 0, 0};
  const GLuint zu[4] = {0, 0, 0, 0};
  switch (kind) {
    case ClearKind::kFloat: {
      const GLenum buf = GL_COLOR_ATTACHMENT0;
      A().DrawBuffers(1, &buf);
      A().ClearBufferfv(GL_COLOR, 0, zf);
      return true;
    }
    case ClearKind::kInt: {
      const GLenum buf = GL_COLOR_ATTACHMENT0;
      A().DrawBuffers(1, &buf);
      A().ClearBufferiv(GL_COLOR, 0, zi);
      return true;
    }
    case ClearKind::kUint: {
      const GLenum buf = GL_COLOR_ATTACHMENT0;
      A().DrawBuffers(1, &buf);
      A().ClearBufferuiv(GL_COLOR, 0, zu);
      return true;
    }
    case ClearKind::kDepth:
      A().ClearBufferfv(GL_DEPTH, 0, zd);
      return true;
    case ClearKind::kStencil:
      A().ClearBufferiv(GL_STENCIL, 0, zi);
      return true;
    case ClearKind::kDepthStencil:
      A().ClearBufferfi(GL_DEPTH_STENCIL, 0, depth, 0);
      return true;
    case ClearKind::kNone:
      return false;
  }
  return false;
}

GLenum AttachmentFor(ClearKind kind) {
  switch (kind) {
    case ClearKind::kDepth:
      return GL_DEPTH_ATTACHMENT;
    case ClearKind::kStencil:
      return GL_STENCIL_ATTACHMENT;
    case ClearKind::kDepthStencil:
      return GL_DEPTH_STENCIL_ATTACHMENT;
    default:
      return GL_COLOR_ATTACHMENT0;
  }
}

std::string ReadInfoLog(GLuint object, bool program) {
  GLint len = 0;
  if (program) A().GetProgramiv(object, GL_INFO_LOG_LENGTH, &len);
  else A().GetShaderiv(object, GL_INFO_LOG_LENGTH, &len);
  if (len <= 1) return std::string();
  std::string log(size_t(len), '\0');
  GLsizei written = 0;
  if (program) A().GetProgramInfoLog(object, len, &written, log.data());
  else A().GetShaderInfoLog(object, len, &written, log.data());
  log.resize(size_t(std::max<GLsizei>(0, written)));
  return log;
}

}  // namespace

// ----------------------------------------------------------------------------------------- helpers

bool HasGlExtension(const char* name) {
  EnsureExtensions();
  for (const auto& e : ExtensionCache()) {
    if (e == name) return true;
  }
  return false;
}

std::vector<std::string> GlExtensions() {
  EnsureExtensions();
  std::vector<std::string> out;
  for (const auto& e : ExtensionCache()) {
    if (!e.empty()) out.push_back(e);
  }
  return out;
}

ClearKind ClassifyInternalFormat(GLenum f) {
  switch (f) {
    // depth / stencil
    case GL_DEPTH_COMPONENT16:
    case GL_DEPTH_COMPONENT24:
    case GL_DEPTH_COMPONENT32F:
    case GL_DEPTH_COMPONENT:
      return ClearKind::kDepth;
    case GL_DEPTH24_STENCIL8:
    case GL_DEPTH32F_STENCIL8:
    case GL_DEPTH_STENCIL:
      return ClearKind::kDepthStencil;
    case GL_STENCIL_INDEX8:
      return ClearKind::kStencil;
    // signed integer
    case GL_R8I: case GL_R16I: case GL_R32I: case GL_RG8I: case GL_RG16I: case GL_RG32I:
    case GL_RGBA8I: case GL_RGBA16I: case GL_RGBA32I:
      return ClearKind::kInt;
    // unsigned integer
    case GL_R8UI: case GL_R16UI: case GL_R32UI: case GL_RG8UI: case GL_RG16UI: case GL_RG32UI:
    case GL_RGBA8UI: case GL_RGBA16UI: case GL_RGBA32UI: case GL_RGB10_A2UI:
      return ClearKind::kUint;
    // color-renderable normalized / float (float ones with EXT_color_buffer_float, core in ES 3.2)
    case GL_R8: case GL_RG8: case GL_RGB8: case GL_RGBA8: case GL_SRGB8_ALPHA8: case GL_RGB565:
    case GL_RGBA4: case GL_RGB5_A1: case GL_RGB10_A2: case GL_R16F: case GL_RG16F: case GL_RGBA16F:
    case GL_R32F: case GL_RG32F: case GL_RGBA32F: case GL_R11F_G11F_B10F:
    case GL_RGBA: case GL_RGB: case GL_LUMINANCE: case GL_LUMINANCE_ALPHA: case GL_ALPHA:
      return ClearKind::kFloat;
    default:
      return ClearKind::kNone;  // RGB9_E5, SNORM, RGB16F/RGB32F, sized RGB integer, compressed, ...
  }
}

uint32_t SyncInsert(GLsync sync) {
  if (!sync) return 0;
  const uint32_t id = g_next_sync++;
  SyncMap()[id] = sync;
  return id;
}
GLsync SyncLookup(uint32_t id) {
  auto it = SyncMap().find(id);
  return it == SyncMap().end() ? nullptr : it->second;
}
void SyncErase(uint32_t id) { SyncMap().erase(id); }

ShaderStatus CollectShaderStatus(GLuint shader) {
  Stats().shaderInfoCalls++;
  Stats().syncQueries++;
  ShaderStatus s;
  GLint ok = 0;
  A().GetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  s.compiled = ok != 0;
  s.infoLog = ReadInfoLog(shader, false);
  return s;
}

ProgramRecord CollectProgramRecord(GLuint program) {
  Stats().programInfoCalls++;
  Stats().syncQueries++;
  ProgramRecord r;
  double& internal = Stats().reflectionGlCalls;
  GLint linked = 0;
  A().GetProgramiv(program, GL_LINK_STATUS, &linked);
  r.linked = linked != 0;
  r.infoLog = ReadInfoLog(program, true);
  internal += 3;
  MaybeFlushShaderCacheAsync();  // the link may have added driver blobs (GL-22)
  if (!r.linked) return r;

  GLint maxLen = 0, count = 0;
  // attributes
  A().GetProgramiv(program, GL_ACTIVE_ATTRIBUTES, &count);
  A().GetProgramiv(program, GL_ACTIVE_ATTRIBUTE_MAX_LENGTH, &maxLen);
  internal += 2;
  std::vector<char> buf(size_t(std::max(maxLen, 256)) + 1);
  for (GLint i = 0; i < count; ++i) {
    ActiveVariable v;
    GLsizei len = 0;
    GLint size = 0;
    GLenum type = 0;
    A().GetActiveAttrib(program, GLuint(i), GLsizei(buf.size()), &len, &size, &type, buf.data());
    v.name.assign(buf.data(), size_t(std::max<GLsizei>(len, 0)));
    v.type = type;
    v.size = size;
    v.location = A().GetAttribLocation(program, v.name.c_str());
    internal += 2;
    r.attributes.push_back(std::move(v));
  }

  // uniforms
  A().GetProgramiv(program, GL_ACTIVE_UNIFORMS, &count);
  A().GetProgramiv(program, GL_ACTIVE_UNIFORM_MAX_LENGTH, &maxLen);
  internal += 2;
  buf.assign(size_t(std::max(maxLen, 256)) + 1, '\0');
  std::vector<GLuint> indices(size_t(std::max(count, 0)));
  for (GLint i = 0; i < count; ++i) {
    ActiveVariable v;
    GLsizei len = 0;
    GLint size = 0;
    GLenum type = 0;
    A().GetActiveUniform(program, GLuint(i), GLsizei(buf.size()), &len, &size, &type, buf.data());
    internal += 1;
    v.name.assign(buf.data(), size_t(std::max<GLsizei>(len, 0)));
    v.type = type;
    v.size = size;
    indices[size_t(i)] = GLuint(i);
    r.uniforms.push_back(std::move(v));
  }
  if (count > 0) {
    std::vector<GLint> vals(static_cast<size_t>(count));
    struct {
      GLenum pname;
      int32_t ActiveVariable::*field;
    } props[] = {{GL_UNIFORM_BLOCK_INDEX, &ActiveVariable::blockIndex},
                 {GL_UNIFORM_OFFSET, &ActiveVariable::offset},
                 {GL_UNIFORM_ARRAY_STRIDE, &ActiveVariable::arrayStride},
                 {GL_UNIFORM_MATRIX_STRIDE, &ActiveVariable::matrixStride},
                 {GL_UNIFORM_IS_ROW_MAJOR, &ActiveVariable::isRowMajor}};
    for (const auto& p : props) {
      A().GetActiveUniformsiv(program, count, indices.data(), p.pname, vals.data());
      internal += 1;
      for (GLint i = 0; i < count; ++i) r.uniforms[size_t(i)].*(p.field) = vals[size_t(i)];
    }
  }
  for (ActiveVariable& v : r.uniforms) {
    if (v.blockIndex >= 0) continue;  // block members have no location
    v.location = A().GetUniformLocation(program, v.name.c_str());
    internal += 1;
    if (v.size > 1) {
      // "name[0]" -> query each element ("name[i]"); GLES does not promise consecutive locations.
      std::string base = v.name;
      if (base.size() > 3 && base.compare(base.size() - 3, 3, "[0]") == 0) base.resize(base.size() - 3);
      v.elementLocations.resize(size_t(v.size));
      v.elementLocations[0] = v.location;
      for (GLint e = 1; e < v.size; ++e) {
        const std::string n = base + "[" + std::to_string(e) + "]";
        v.elementLocations[size_t(e)] = A().GetUniformLocation(program, n.c_str());
        internal += 1;
      }
    }
  }

  // uniform blocks
  A().GetProgramiv(program, GL_ACTIVE_UNIFORM_BLOCKS, &count);
  A().GetProgramiv(program, GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH, &maxLen);
  internal += 2;
  buf.assign(size_t(std::max(maxLen, 256)) + 1, '\0');
  for (GLint b = 0; b < count; ++b) {
    UniformBlockRecord rec;
    GLsizei len = 0;
    A().GetActiveUniformBlockName(program, GLuint(b), GLsizei(buf.size()), &len, buf.data());
    rec.name.assign(buf.data(), size_t(std::max<GLsizei>(len, 0)));
    GLint v = 0;
    A().GetActiveUniformBlockiv(program, GLuint(b), GL_UNIFORM_BLOCK_BINDING, &v);
    rec.binding = v;
    A().GetActiveUniformBlockiv(program, GLuint(b), GL_UNIFORM_BLOCK_DATA_SIZE, &v);
    rec.dataSize = v;
    A().GetActiveUniformBlockiv(program, GLuint(b), GL_UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER, &v);
    rec.referencedByVertexShader = v != 0;
    A().GetActiveUniformBlockiv(program, GLuint(b), GL_UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER, &v);
    rec.referencedByFragmentShader = v != 0;
    GLint n = 0;
    A().GetActiveUniformBlockiv(program, GLuint(b), GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS, &n);
    std::vector<GLint> idx(size_t(std::max(n, 0)));
    if (n > 0) A().GetActiveUniformBlockiv(program, GLuint(b), GL_UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES, idx.data());
    internal += 7;
    for (GLint k : idx) rec.activeUniformIndices.push_back(GLuint(k));
    r.blocks.push_back(std::move(rec));
  }

  // transform feedback varyings
  A().GetProgramiv(program, GL_TRANSFORM_FEEDBACK_BUFFER_MODE, &r.transformFeedbackBufferMode);
  A().GetProgramiv(program, GL_TRANSFORM_FEEDBACK_VARYINGS, &count);
  A().GetProgramiv(program, GL_TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH, &maxLen);
  internal += 3;
  buf.assign(size_t(std::max(maxLen, 256)) + 1, '\0');
  for (GLint i = 0; i < count; ++i) {
    ActiveVariable v;
    GLsizei len = 0;
    GLsizei size = 0;
    GLenum type = 0;
    A().GetTransformFeedbackVarying(program, GLuint(i), GLsizei(buf.size()), &len, &size, &type, buf.data());
    internal += 1;
    v.name.assign(buf.data(), size_t(std::max<GLsizei>(len, 0)));
    v.type = type;
    v.size = size;
    r.transformFeedbackVaryings.push_back(std::move(v));
  }

  // fragment outputs: WebGL 2 draw validation (undefined outputs for active draw buffers, output vs colour
  // buffer base type) without per-draw queries
  if (A().GetProgramInterfaceiv && A().GetProgramResourceName && A().GetProgramResourceiv) {
    count = 0;
    maxLen = 0;
    A().GetProgramInterfaceiv(program, GL_PROGRAM_OUTPUT, GL_ACTIVE_RESOURCES, &count);
    A().GetProgramInterfaceiv(program, GL_PROGRAM_OUTPUT, GL_MAX_NAME_LENGTH, &maxLen);
    internal += 2;
    buf.assign(size_t(std::max(maxLen, 256)) + 1, '\0');
    r.fragmentOutputsKnown = true;
    const GLenum props[] = {GL_TYPE, GL_LOCATION, GL_ARRAY_SIZE};
    for (GLint i = 0; i < count; ++i) {
      ActiveVariable v;
      GLsizei len = 0;
      A().GetProgramResourceName(program, GL_PROGRAM_OUTPUT, GLuint(i), GLsizei(buf.size()), &len, buf.data());
      GLint vals[3] = {0, -1, 1};
      GLsizei got = 0;
      A().GetProgramResourceiv(program, GL_PROGRAM_OUTPUT, GLuint(i), 3, props, 3, &got, vals);
      internal += 2;
      v.name.assign(buf.data(), size_t(std::max<GLsizei>(len, 0)));
      v.type = GLenum(vals[0]);
      v.location = vals[1];
      v.size = vals[2];
      r.fragmentOutputs.push_back(std::move(v));
    }
  }
  return r;
}

// ------------------------------------------------------------------------------------- pixel store

namespace {
struct PixelStoreState {
  GLint packAlignment = 4, packRowLength = 0, packSkipPixels = 0, packSkipRows = 0;
  GLint unpackAlignment = 4, unpackRowLength = 0, unpackImageHeight = 0, unpackSkipPixels = 0, unpackSkipRows = 0,
        unpackSkipImages = 0;
};
std::unordered_map<uint32_t, PixelStoreState>& PixelStores() {
  static auto* m = new std::unordered_map<uint32_t, PixelStoreState>();
  return *m;
}
PixelStoreState& CurrentPixelStore() { return PixelStores()[EglEnvironment::Get().current()]; }
}  // namespace

void TrackPixelStore(GLenum pname, GLint param) {
  PixelStoreState& p = CurrentPixelStore();
  switch (pname) {
    case GL_PACK_ALIGNMENT: p.packAlignment = param; break;
    case GL_PACK_ROW_LENGTH: p.packRowLength = param; break;
    case GL_PACK_SKIP_PIXELS: p.packSkipPixels = param; break;
    case GL_PACK_SKIP_ROWS: p.packSkipRows = param; break;
    case GL_UNPACK_ALIGNMENT: p.unpackAlignment = param; break;
    case GL_UNPACK_ROW_LENGTH: p.unpackRowLength = param; break;
    case GL_UNPACK_IMAGE_HEIGHT: p.unpackImageHeight = param; break;
    case GL_UNPACK_SKIP_PIXELS: p.unpackSkipPixels = param; break;
    case GL_UNPACK_SKIP_ROWS: p.unpackSkipRows = param; break;
    case GL_UNPACK_SKIP_IMAGES: p.unpackSkipImages = param; break;
    default: break;
  }
}

void ResetPixelStore(uint32_t context) { PixelStores()[context] = PixelStoreState{}; }

int64_t PixelBytes(GLenum format, GLenum type) {
  switch (type) {
    case GL_UNSIGNED_SHORT_5_6_5:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
      return 2;
    case GL_UNSIGNED_INT_2_10_10_10_REV:
    case GL_UNSIGNED_INT_10F_11F_11F_REV:
    case GL_UNSIGNED_INT_5_9_9_9_REV:
    case GL_UNSIGNED_INT_24_8:
      return 4;
    case GL_FLOAT_32_UNSIGNED_INT_24_8_REV:
      return 8;
    default:
      break;
  }
  int64_t size = 0;
  switch (type) {
    case GL_UNSIGNED_BYTE: case GL_BYTE: size = 1; break;
    case GL_UNSIGNED_SHORT: case GL_SHORT: case GL_HALF_FLOAT: case 0x8D61 /* HALF_FLOAT_OES */: size = 2; break;
    case GL_UNSIGNED_INT: case GL_INT: case GL_FLOAT: size = 4; break;
    default: return 0;
  }
  int64_t comps = 0;
  switch (format) {
    case GL_RED: case GL_RED_INTEGER: case GL_ALPHA: case GL_LUMINANCE: case GL_DEPTH_COMPONENT: case GL_STENCIL_INDEX8:
      comps = 1; break;
    case GL_RG: case GL_RG_INTEGER: case GL_LUMINANCE_ALPHA: case GL_DEPTH_STENCIL: comps = 2; break;
    case GL_RGB: case GL_RGB_INTEGER: case 0x8C40 /* SRGB_EXT */: comps = 3; break;
    case GL_RGBA: case GL_RGBA_INTEGER: case 0x8C42 /* SRGB_ALPHA_EXT */: comps = 4; break;
    default: return 0;
  }
  return comps * size;
}

int64_t ImageBytes(int64_t width, int64_t height, int64_t depth, int64_t bpp, int64_t alignment, int64_t rowLength,
                   int64_t imageHeight, int64_t skipPixels, int64_t skipRows, int64_t skipImages) {
  if (width <= 0 || height <= 0 || depth <= 0 || bpp <= 0) return 0;
  if (alignment <= 0) alignment = 1;
  const int64_t rowPixels = rowLength > 0 ? rowLength : width;
  const int64_t rowStride = (rowPixels * bpp + alignment - 1) / alignment * alignment;
  const int64_t rows = imageHeight > 0 ? imageHeight : height;
  const int64_t imageStride = rowStride * rows;
  // the last row of the last image is not padded (GLES 3.2 §8.4.3.1)
  return std::max<int64_t>(0, skipImages) * imageStride + std::max<int64_t>(0, skipRows) * rowStride +
         std::max<int64_t>(0, skipPixels) * bpp + (depth - 1) * imageStride + (height - 1) * rowStride + width * bpp;
}

int64_t UnpackImageBytes(int64_t width, int64_t height, int64_t depth, GLenum format, GLenum type) {
  const int64_t bpp = PixelBytes(format, type);
  if (bpp == 0) return 0;  // unknown combination: GL raises the error without reading client memory
  const PixelStoreState& p = CurrentPixelStore();
  return ImageBytes(width, height, depth, bpp, p.unpackAlignment, p.unpackRowLength, depth > 1 ? p.unpackImageHeight : 0,
                    p.unpackSkipPixels, p.unpackSkipRows, depth > 1 ? p.unpackSkipImages : 0);
}

int64_t PackImageBytes(int64_t width, int64_t height, GLenum format, GLenum type) {
  const int64_t bpp = PixelBytes(format, type);
  if (bpp == 0) return 0;
  const PixelStoreState& p = CurrentPixelStore();
  return ImageBytes(width, height, 1, bpp, p.packAlignment, p.packRowLength, 0, p.packSkipPixels, p.packSkipRows, 0);
}

// ------------------------------------------------------------------------------ RGBA8 source copies

namespace {
struct UnpremulTable {
  uint32_t v[256];
  constexpr UnpremulTable() : v() {
    for (uint32_t a = 1; a < 256; ++a) v[a] = (255u * 65536u + a / 2) / a;
  }
  constexpr uint32_t operator[](uint32_t a) const { return v[a]; }
};
constexpr UnpremulTable kUnpremul;
}  // namespace

bool ConvertRgba8(const uint8_t* src, size_t src_bytes, int32_t srcWidth, int32_t x, int32_t y, int32_t width,
                  int32_t height, uint8_t* dst, size_t dst_bytes, bool flipY, int32_t alphaOp) {
  if (width <= 0 || height <= 0) return true;
  if (srcWidth <= 0 || x < 0 || y < 0 || x + width > srcWidth) return false;
  const size_t srcRow = size_t(srcWidth) * 4;
  const size_t row = size_t(width) * 4;
  if (dst_bytes < row * size_t(height)) return false;
  if (src_bytes < (size_t(y) + size_t(height) - 1) * srcRow + size_t(x) * 4 + row) return false;
  for (int32_t r = 0; r < height; ++r) {
    const uint8_t* s = src + (size_t(y) + size_t(flipY ? height - 1 - r : r)) * srcRow + size_t(x) * 4;
    uint8_t* d = dst + size_t(r) * row;
    if (alphaOp == 0) {
      memcpy(d, s, row);
      continue;
    }
    for (int32_t i = 0; i < width; ++i, s += 4, d += 4) {
      const uint32_t a = s[3];
      if (a == 255) {
        memcpy(d, s, 4);
      } else if (alphaOp == 1) {  // premultiply: round(c * a / 255)
        d[0] = uint8_t((s[0] * a + 127) / 255);
        d[1] = uint8_t((s[1] * a + 127) / 255);
        d[2] = uint8_t((s[2] * a + 127) / 255);
        d[3] = uint8_t(a);
      } else if (a == 0) {  // un-premultiply: colour is unrecoverable, keep it
        memcpy(d, s, 4);
      } else {  // un-premultiply: min(255, round(c * 255 / a)), through a 16.16 reciprocal table
        const uint32_t inv = kUnpremul[a];
        d[0] = uint8_t(std::min<uint32_t>(255, (s[0] * inv + 32768) >> 16));
        d[1] = uint8_t(std::min<uint32_t>(255, (s[1] * inv + 32768) >> 16));
        d[2] = uint8_t(std::min<uint32_t>(255, (s[2] * inv + 32768) >> 16));
        d[3] = uint8_t(a);
      }
    }
  }
  return true;
}

// ----------------------------------------------------------------------------------------- composites

namespace composite {

uint32_t contextCreate(const uint8_t* attribs, uint32_t attribs_bytes) {
  WebGLContextOptions options;
  const size_t n = attribs_bytes / sizeof(int32_t);
  for (size_t i = 0; i + 1 < n; i += 2) {
    int32_t key, value;
    memcpy(&key, attribs + i * 4, 4);
    memcpy(&value, attribs + i * 4 + 4, 4);
    if (key == kAttribEnd) break;
    if (key == kAttribRobustAccess) options.robustAccess = value != 0;
  }
  const uint32_t id = EglEnvironment::Get().CreateContext(options);
  if (id) ResetPixelStore(id);
  return id;
}

bool contextMakeCurrent(uint32_t id) { return EglEnvironment::Get().MakeCurrent(id); }

void contextDestroy(uint32_t id) {
  auto& env = EglEnvironment::Get();
  auto it = ScratchFbos().find(id);
  if (it != ScratchFbos().end()) {
    if (env.MakeCurrent(id)) A().DeleteFramebuffers(1, &it->second);
    ScratchFbos().erase(it);
  }
  env.DestroyContext(id);
}

uint32_t contextResetStatus(uint32_t id) { return EglEnvironment::Get().ResetStatus(id); }

void shaderSource(uint32_t shader, const std::string& source) {
  const GLchar* s = source.c_str();
  const GLint len = GLint(source.size());
  A().ShaderSource(shader, 1, &s, &len);
}

bool shaderCompletion(uint32_t shader) {
  if (!HasGlExtension("GL_KHR_parallel_shader_compile")) return true;
  GLint v = GL_TRUE;
  A().GetShaderiv(shader, kCompletionStatusKHR, &v);
  return v != 0;
}

bool programCompletion(uint32_t program) {
  if (!HasGlExtension("GL_KHR_parallel_shader_compile")) return true;
  GLint v = GL_TRUE;
  A().GetProgramiv(program, kCompletionStatusKHR, &v);
  return v != 0;
}

void transformFeedbackVaryings(uint32_t program, const std::vector<std::string>& varyings, uint32_t bufferMode) {
  std::vector<const GLchar*> ptrs;
  ptrs.reserve(varyings.size());
  for (const auto& v : varyings) ptrs.push_back(v.c_str());
  A().TransformFeedbackVaryings(program, GLsizei(ptrs.size()), ptrs.data(), bufferMode);
}

void bufferDataZero(uint32_t target, double size, uint32_t usage) {
  Stats().zeroInits++;
  if (size <= 0) {
    A().BufferData(target, 0, nullptr, usage);
    return;
  }
  const GLsizeiptr total = GLsizeiptr(size);
  constexpr GLsizeiptr kChunk = 1 << 20;
  if (total <= kChunk) {
    void* zeros = calloc(size_t(total), 1);
    A().BufferData(target, total, zeros, usage);
    free(zeros);
    return;
  }
  A().BufferData(target, total, nullptr, usage);
  void* zeros = calloc(size_t(kChunk), 1);
  for (GLsizeiptr off = 0; off < total; off += kChunk) {
    A().BufferSubData(target, off, std::min(kChunk, total - off), zeros);
  }
  free(zeros);
}

bool clearTextureImage(uint32_t target, uint32_t texture, int32_t level, int32_t layers, uint32_t internalformat,
                       int32_t width, int32_t height, int32_t depth) {
  const ClearKind kind = ClassifyInternalFormat(internalformat);
  if (kind == ClearKind::kNone || width <= 0 || height <= 0) return false;
  Stats().zeroInits++;
  ClearStateGuard guard;
  A().BindFramebuffer(GL_DRAW_FRAMEBUFFER, ScratchFbo());
  const GLenum att = AttachmentFor(kind);
  bool ok = true;
  auto clearOne = [&]() {
    if (A().CheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
      ok = false;
      return;
    }
    ClearBoundAttachment(kind);
  };
  if (target == GL_TEXTURE_2D) {
    A().FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, att, GL_TEXTURE_2D, texture, level);
    clearOne();
    A().FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, att, GL_TEXTURE_2D, 0, 0);
  } else if (target == GL_TEXTURE_CUBE_MAP) {
    for (GLenum face = 0; face < 6 && ok; ++face) {
      A().FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, att, GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, level);
      clearOne();
    }
    A().FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, att, GL_TEXTURE_CUBE_MAP_POSITIVE_X, 0, 0);
  } else if (target >= GL_TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z) {
    A().FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, att, target, texture, level);
    clearOne();
    A().FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, att, target, 0, 0);
  } else if (target == GL_TEXTURE_2D_ARRAY || target == GL_TEXTURE_3D) {
    const int32_t n = target == GL_TEXTURE_3D ? depth : layers;
    for (int32_t layer = 0; layer < n && ok; ++layer) {
      A().FramebufferTextureLayer(GL_DRAW_FRAMEBUFFER, att, texture, level, layer);
      clearOne();
    }
    A().FramebufferTextureLayer(GL_DRAW_FRAMEBUFFER, att, 0, 0, 0);
  } else {
    ok = false;
  }
  return ok;
}

void clearRenderbuffer(uint32_t renderbuffer, uint32_t internalformat) {
  const ClearKind kind = ClassifyInternalFormat(internalformat);
  if (kind == ClearKind::kNone) return;
  Stats().zeroInits++;
  ClearStateGuard guard;
  A().BindFramebuffer(GL_DRAW_FRAMEBUFFER, ScratchFbo());
  const GLenum att = AttachmentFor(kind);
  A().FramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, att, GL_RENDERBUFFER, renderbuffer);
  if (A().CheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE) ClearBoundAttachment(kind, 1.0f);
  A().FramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, att, GL_RENDERBUFFER, 0);
}

void multiDrawArrays(uint32_t mode, const uint8_t* firsts, uint32_t firsts_bytes, const uint8_t* counts,
                     uint32_t counts_bytes, const uint8_t* instanceCounts, uint32_t instanceCounts_bytes,
                     int32_t drawcount, int32_t drawIdLocation) {
  if (drawcount <= 0) return;
  const size_t n = size_t(drawcount);
  if (firsts_bytes < n * 4 || counts_bytes < n * 4) return;
  const bool instanced = instanceCounts != nullptr && instanceCounts_bytes >= n * 4;
  for (size_t i = 0; i < n; ++i) {
    int32_t first, count, inst = 1;
    memcpy(&first, firsts + i * 4, 4);
    memcpy(&count, counts + i * 4, 4);
    if (instanced) memcpy(&inst, instanceCounts + i * 4, 4);
    if (count <= 0 || inst <= 0) continue;
    if (drawIdLocation >= 0) A().Uniform1i(drawIdLocation, GLint(i));
    if (instanced) A().DrawArraysInstanced(mode, first, count, inst);
    else A().DrawArrays(mode, first, count);
    Stats().multiDrawSubDraws++;
  }
  // gl_DrawID is 0 for draws that are not multi-draws (ANGLE_multi_draw)
  if (drawIdLocation >= 0) A().Uniform1i(drawIdLocation, 0);
}

void multiDrawElements(uint32_t mode, const uint8_t* counts, uint32_t counts_bytes, uint32_t type,
                       const uint8_t* offsets, uint32_t offsets_bytes, const uint8_t* instanceCounts,
                       uint32_t instanceCounts_bytes, int32_t drawcount, int32_t drawIdLocation) {
  if (drawcount <= 0) return;
  const size_t n = size_t(drawcount);
  if (counts_bytes < n * 4 || offsets_bytes < n * 4) return;
  const bool instanced = instanceCounts != nullptr && instanceCounts_bytes >= n * 4;
  for (size_t i = 0; i < n; ++i) {
    int32_t count, offset, inst = 1;
    memcpy(&count, counts + i * 4, 4);
    memcpy(&offset, offsets + i * 4, 4);
    if (instanced) memcpy(&inst, instanceCounts + i * 4, 4);
    if (count <= 0 || inst <= 0) continue;
    if (drawIdLocation >= 0) A().Uniform1i(drawIdLocation, GLint(i));
    const void* ptr = reinterpret_cast<const void*>(static_cast<uintptr_t>(uint32_t(offset)));
    if (instanced) A().DrawElementsInstanced(mode, count, type, ptr, inst);
    else A().DrawElements(mode, count, type, ptr);
    Stats().multiDrawSubDraws++;
  }
  if (drawIdLocation >= 0) A().Uniform1i(drawIdLocation, 0);
}

bool getBufferSubData(uint32_t target, double offset, uint8_t* dst, uint32_t dst_bytes) {
  Stats().syncQueries++;
  if (dst_bytes == 0) return true;
  const void* p = A().MapBufferRange(target, GLintptr(offset), GLsizeiptr(dst_bytes), GL_MAP_READ_BIT);
  if (!p) return false;
  memcpy(dst, p, dst_bytes);
  A().UnmapBuffer(target);
  return true;
}

uint32_t fenceSync(uint32_t condition, uint32_t flags) { return SyncInsert(A().FenceSync(condition, flags)); }

void deleteSync(uint32_t id) {
  GLsync s = SyncLookup(id);
  if (!s) return;
  A().DeleteSync(s);
  SyncErase(id);
}

uint32_t clientWaitSync(uint32_t id, uint32_t flags, double timeout) {
  GLsync s = SyncLookup(id);
  if (!s) return GL_WAIT_FAILED;
  Stats().syncQueries++;
  return A().ClientWaitSync(s, flags, GLuint64(timeout < 0 ? 0 : timeout));
}

void waitSync(uint32_t id, uint32_t flags, double timeout) {
  GLsync s = SyncLookup(id);
  if (!s) return;
  (void)timeout;  // WebGL: must be TIMEOUT_IGNORED, validated in JS
  A().WaitSync(s, flags, GL_TIMEOUT_IGNORED);
}

int32_t getSynciv(uint32_t id, uint32_t pname) {
  GLsync s = SyncLookup(id);
  if (!s) return 0;
  Stats().syncQueries++;
  GLint v = 0;
  GLsizei len = 0;
  A().GetSynciv(s, pname, 1, &len, &v);
  return v;
}

void stats(uint8_t* out, uint32_t out_bytes) {
  const size_t n = std::min<size_t>(out_bytes / sizeof(double), size_t(kGlStatsFields));
  memcpy(out, &Stats(), n * sizeof(double));
}

void resetStats() { Stats() = GlStats{}; }

bool convertRgba8(const uint8_t* src, uint32_t src_bytes, int32_t srcWidth, int32_t x, int32_t y, int32_t width,
                  int32_t height, uint8_t* dst, uint32_t dst_bytes, bool flipY, int32_t alphaOp) {
  return ConvertRgba8(src, src_bytes, srcWidth, x, y, width, height, dst, dst_bytes, flipY, alphaOp);
}

}  // namespace composite

size_t DestroyAllWebGLContexts() {
  const std::vector<uint32_t> ids = EglEnvironment::Get().ContextIds();
  for (uint32_t id : ids) composite::contextDestroy(id);
  return ids.size();
}

}  // namespace iwn::gl
