/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// V8-independent core of the GL module: reflection records, shader status, zero-initialisation,
// multi-draw, sync ids, context registry glue. Host-testable against Mesa or a recording GlApi.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "../generated/gl_api.gen.h"
#include "../generated/gl_composites.gen.h"
#include "stats.h"

namespace iwn::gl {

// Destroys every WebGL context (and its scratch objects); the root context stays. Used when a new page context
// registers the module (location.reload, PROC-8): the previous page's contexts are unreachable from then on.
// Returns how many were destroyed.
size_t DestroyAllWebGLContexts();

// GL enums used by the composites that gl32.h may lack on some hosts (extension values).
inline constexpr GLenum kCompletionStatusKHR = 0x91B1;

struct ActiveVariable {
  std::string name;  // as GL reports it ("arr[0]" for arrays)
  uint32_t type = 0;
  int32_t size = 0;
  int32_t location = -1;                  // attributes; uniforms: element 0 (-1 for block members)
  std::vector<int32_t> elementLocations;  // uniforms with size > 1: location of each element
  int32_t blockIndex = -1, offset = -1, arrayStride = -1, matrixStride = -1, isRowMajor = 0;
};

struct UniformBlockRecord {
  std::string name;
  int32_t binding = 0;
  int32_t dataSize = 0;
  std::vector<uint32_t> activeUniformIndices;
  bool referencedByVertexShader = false;
  bool referencedByFragmentShader = false;
};

// Everything WebGL can ask about a linked program, fetched once (GL-21).
struct ProgramRecord {
  bool linked = false;
  std::string infoLog;
  std::vector<ActiveVariable> attributes;
  std::vector<ActiveVariable> uniforms;
  std::vector<UniformBlockRecord> blocks;
  std::vector<ActiveVariable> transformFeedbackVaryings;
  int32_t transformFeedbackBufferMode = 0;
  // Fragment shader outputs (GLES 3.1 program interface PROGRAM_OUTPUT): name, type, location, size = array size.
  // Empty when the driver lacks glGetProgramResourceiv (GLES 3.0).
  std::vector<ActiveVariable> fragmentOutputs;
  bool fragmentOutputsKnown = false;
};

ProgramRecord CollectProgramRecord(GLuint program);

struct ShaderStatus {
  bool compiled = false;
  std::string infoLog;
};
ShaderStatus CollectShaderStatus(GLuint shader);

// Driver extension availability (from the current context's GL_EXTENSIONS); cached per context id.
bool HasGlExtension(const char* name);
std::vector<std::string> GlExtensions();

// Internal format classification used by zero-initialisation.
enum class ClearKind { kFloat, kInt, kUint, kDepth, kStencil, kDepthStencil, kNone };
ClearKind ClassifyInternalFormat(GLenum internalformat);

// Pixel-store shadow per WebGL context (defense in depth for the pixel-transfer natives): the generated
// glPixelStorei native records every value the binding sets, and readPixels / tex(Sub)Image* check that the
// view holds at least the bytes GL will touch (GLES 3.2 §8.4.3, §16.1), whatever byteLength JS passed.
void TrackPixelStore(GLenum pname, GLint param);
void ResetPixelStore(uint32_t context);
// Bytes GL reads for an unpack of (width, height, depth) pixels of (format, type); 0 for empty or unknown.
int64_t UnpackImageBytes(int64_t width, int64_t height, int64_t depth, GLenum format, GLenum type);
// Bytes GL writes for glReadPixels of (width, height) pixels of (format, type).
int64_t PackImageBytes(int64_t width, int64_t height, GLenum format, GLenum type);
// Bytes per pixel of (format, type); 0 if unknown.
int64_t PixelBytes(GLenum format, GLenum type);
// Pure form for tests: rows of `width` pixels, `rowLength` (0 = width), alignment, skips, image height.
int64_t ImageBytes(int64_t width, int64_t height, int64_t depth, int64_t bpp, int64_t alignment, int64_t rowLength,
                   int64_t imageHeight, int64_t skipPixels, int64_t skipRows, int64_t skipImages);

// Copy a width x height region at (x, y) of a srcWidth-wide RGBA8 image (rows top-down) into tight dst,
// optionally flipped, with alphaOp 0 none, 1 premultiply, 2 un-premultiply. False if out of range.
bool ConvertRgba8(const uint8_t* src, size_t src_bytes, int32_t srcWidth, int32_t x, int32_t y, int32_t width,
                  int32_t height, uint8_t* dst, size_t dst_bytes, bool flipY, int32_t alphaOp);

// Sync ids (GLsync pointers stay native).
uint32_t SyncInsert(GLsync sync);
GLsync SyncLookup(uint32_t id);
void SyncErase(uint32_t id);

}  // namespace iwn::gl
