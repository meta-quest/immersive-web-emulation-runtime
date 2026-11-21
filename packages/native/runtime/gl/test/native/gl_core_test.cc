// Host tests for the V8-free GL core against a real ES 3.2 driver (Mesa llvmpipe, surfaceless EGL).
// Run: build/gl-host/iwn_gl_tests   (exit code 0 = all passed)

#include <unistd.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <functional>
#include <string>
#include <vector>

#include "blob_cache.h"
#include "composites.h"
#include "egl_context.h"

using namespace iwn::gl;

static int g_failures = 0;
static int g_checks = 0;
#define CHECK(cond)                                                          \
  do {                                                                       \
    ++g_checks;                                                              \
    if (!(cond)) {                                                           \
      ++g_failures;                                                          \
      std::fprintf(stderr, "  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    }                                                                        \
  } while (0)
#define CHECK_EQ(a, b)                                                                                     \
  do {                                                                                                     \
    ++g_checks;                                                                                            \
    auto va = (a);                                                                                         \
    auto vb = (b);                                                                                         \
    if (!(va == vb)) {                                                                                     \
      ++g_failures;                                                                                        \
      std::fprintf(stderr, "  FAIL %s:%d: %s == %s (%lld vs %lld)\n", __FILE__, __LINE__, #a, #b, (long long)va, \
                   (long long)vb);                                                                         \
    }                                                                                                      \
  } while (0)

static GlApi& gl = Api();

static void* GetProc(const char* name, void* user) {
  void* p = user ? dlsym(user, name) : nullptr;
  return p ? p : reinterpret_cast<void*>(eglGetProcAddress(name));
}

static GLuint Compile(GLenum type, const char* src) {
  GLuint s = gl.CreateShader(type);
  composite::shaderSource(s, src);
  gl.CompileShader(s);
  return s;
}

static GLuint Link(const char* vs, const char* fs, const std::function<void(GLuint)>& pre = nullptr) {
  GLuint p = gl.CreateProgram();
  GLuint v = Compile(GL_VERTEX_SHADER, vs), f = Compile(GL_FRAGMENT_SHADER, fs);
  gl.AttachShader(p, v);
  gl.AttachShader(p, f);
  if (pre) pre(p);
  gl.LinkProgram(p);
  gl.DeleteShader(v);
  gl.DeleteShader(f);
  return p;
}

static void TestBlobCache() {
  std::puts("blob cache");
  char dir[] = "/tmp/iwn-gl-blob-XXXXXX";
  CHECK(mkdtemp(dir) != nullptr);
  const std::string path = std::string(dir) + "/c.bin";
  {
    BlobCache c(path, "build-A|1", 64);
    c.Load();
    c.Set("k1", 2, "value-one", 9);
    c.Set("k2", 2, "value-two", 9);
    char buf[32] = {};
    CHECK_EQ(c.Get("k1", 2, buf, sizeof buf), 9u);
    CHECK(memcmp(buf, "value-one", 9) == 0);
    CHECK_EQ(c.Get("k1", 2, buf, 4), 9u);  // too small: size only
    CHECK_EQ(c.Get("zz", 2, buf, sizeof buf), 0u);
    // eviction: 64 bytes max; k1 was used most recently, so k2 goes first
    c.Set("k3", 2, "0123456789012345678901234567890123456789012345", 46);
    CHECK_EQ(c.Get("k2", 2, nullptr, 0), 0u);
    CHECK_EQ(c.Get("k1", 2, nullptr, 0), 9u);
    CHECK(c.bytes() <= 64);
    CHECK(c.Flush());
  }
  {
    BlobCache c(path, "build-A|1", 64);
    c.Load();
    CHECK_EQ(c.Get("k1", 2, nullptr, 0), 9u);
    CHECK_EQ(c.Get("k3", 2, nullptr, 0), 46u);
  }
  {
    BlobCache c(path, "build-B|1", 64);  // driver / version change invalidates everything
    c.Load();
    CHECK_EQ(c.entries(), 0u);
    CHECK_EQ(c.Get("k1", 2, nullptr, 0), 0u);
  }
}

static void TestContexts() {
  std::puts("contexts");
  auto& env = EglEnvironment::Get();
  uint32_t a = env.CreateContext({});
  uint32_t b = env.CreateContext({});
  CHECK(a != 0 && b != 0 && a != b);
  CHECK(env.MakeCurrent(a));
  GLuint ta = 0;
  gl.GenTextures(1, &ta);
  CHECK(env.MakeCurrent(b));
  // share group: names are shared, container objects are not
  CHECK(gl.IsTexture(ta) == GL_FALSE);  // not yet bound: IsTexture false in any context
  GLuint vao = 0;
  gl.GenVertexArrays(1, &vao);
  gl.BindVertexArray(vao);
  CHECK(env.MakeCurrent(a));
  CHECK(gl.IsVertexArray(vao) == GL_FALSE);
  env.DestroyContext(b);
  CHECK(env.Handle(b) == EGL_NO_CONTEXT);
  CHECK(env.MakeCurrent(a));
  gl.DeleteTextures(1, &ta);
}

static void TestProgramRecord() {
  std::puts("program record");
  const char* vs = R"(#version 300 es
in vec3 position;
in vec2 uv;
layout(location = 5) in vec4 color;
uniform mat4 mvp;
uniform vec4 bones[4];
struct Light { vec3 dir; float power; };
uniform Light lights[2];
layout(std140) uniform Frame { mat4 view; vec4 tint; } frame;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = uv;
  vColor = color * frame.tint + bones[3] + vec4(lights[1].dir, lights[0].power);
  gl_Position = mvp * frame.view * vec4(position, 1.0);
})";
  const char* fs = R"(#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D map;
uniform highp usampler2D lut;
out vec4 outColor;
void main() { outColor = texture(map, vUv) * vColor + vec4(texture(lut, vUv)); })";
  GLuint p = Link(vs, fs, [](GLuint prog) {
    const GLchar* v[] = {"vUv"};
    gl.TransformFeedbackVaryings(prog, 1, v, GL_SEPARATE_ATTRIBS);
  });
  const double before = Stats().programInfoCalls;
  ProgramRecord r = CollectProgramRecord(p);
  CHECK_EQ(Stats().programInfoCalls - before, 1.0);
  CHECK(r.linked);
  CHECK_EQ(r.attributes.size(), 3u);
  bool sawColor = false;
  for (auto& a : r.attributes) {
    CHECK_EQ(a.location, gl.GetAttribLocation(p, a.name.c_str()));
    if (a.name == "color") {
      sawColor = true;
      CHECK_EQ(a.location, 5);
      CHECK_EQ(a.type, (uint32_t)GL_FLOAT_VEC4);
    }
  }
  CHECK(sawColor);
  int found = 0;
  for (auto& u : r.uniforms) {
    if (u.name == "bones[0]") {
      ++found;
      CHECK_EQ(u.size, 4);
      CHECK_EQ(u.elementLocations.size(), 4u);
      CHECK_EQ(u.elementLocations[3], gl.GetUniformLocation(p, "bones[3]"));
    } else if (u.name == "lights[1].dir") {
      ++found;
      CHECK_EQ(u.location, gl.GetUniformLocation(p, "lights[1].dir"));
    } else if (u.name == "Frame.tint") {
      ++found;
      CHECK(u.blockIndex >= 0);
      CHECK_EQ(u.offset, 64);
      CHECK_EQ(u.location, -1);
    } else if (u.name == "lut") {
      ++found;
      CHECK_EQ(u.type, (uint32_t)GL_UNSIGNED_INT_SAMPLER_2D);
    }
  }
  CHECK_EQ(found, 4);
  CHECK_EQ(r.blocks.size(), 1u);
  if (!r.blocks.empty()) {
    CHECK(r.blocks[0].name == "Frame");
    CHECK_EQ(r.blocks[0].dataSize, 80);
    CHECK_EQ(r.blocks[0].activeUniformIndices.size(), 2u);
    CHECK(r.blocks[0].referencedByVertexShader);
  }
  CHECK_EQ(r.transformFeedbackVaryings.size(), 1u);
  CHECK_EQ(r.transformFeedbackBufferMode, GL_SEPARATE_ATTRIBS);

  // failing link / compile: logs come back, nothing else is queried
  GLuint bad = Compile(GL_FRAGMENT_SHADER, "#version 300 es\nvoid main() { undefined_fn(); }");
  ShaderStatus st = CollectShaderStatus(bad);
  CHECK(!st.compiled);
  CHECK(!st.infoLog.empty());
  gl.DeleteShader(bad);
  GLuint badp = Link("#version 300 es\nvoid main(){gl_Position=vec4(0);}", "#version 300 es\nvoid main() { x }");
  ProgramRecord br = CollectProgramRecord(badp);
  CHECK(!br.linked);
  CHECK(br.uniforms.empty());
  gl.DeleteProgram(p);
  gl.DeleteProgram(badp);
}

static std::vector<uint8_t> ReadRGBA(GLuint fbo, int w, int h) {
  std::vector<uint8_t> px(size_t(w * h * 4), 0xAB);
  gl.BindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
  gl.ReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
  return px;
}

static void TestZeroInit() {
  std::puts("zero init");
  // texture with garbage, then cleared
  GLuint tex = 0;
  gl.GenTextures(1, &tex);
  gl.BindTexture(GL_TEXTURE_2D, tex);
  gl.TexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, 8, 8);
  std::vector<uint8_t> junk(8 * 8 * 4, 0x5A);
  gl.TexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 8, 8, GL_RGBA, GL_UNSIGNED_BYTE, junk.data());
  gl.Enable(GL_SCISSOR_TEST);
  gl.ColorMask(GL_FALSE, GL_TRUE, GL_TRUE, GL_TRUE);
  CHECK(composite::clearTextureImage(GL_TEXTURE_2D, tex, 0, 1, GL_RGBA8, 8, 8, 1));
  // state restored
  CHECK(gl.IsEnabled(GL_SCISSOR_TEST) == GL_TRUE);
  GLboolean mask[4];
  gl.GetBooleanv(GL_COLOR_WRITEMASK, mask);
  CHECK(mask[0] == GL_FALSE && mask[1] == GL_TRUE);
  gl.Disable(GL_SCISSOR_TEST);
  gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  GLuint fbo = 0;
  gl.GenFramebuffers(1, &fbo);
  gl.BindFramebuffer(GL_FRAMEBUFFER, fbo);
  gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
  auto px = ReadRGBA(fbo, 8, 8);
  bool allZero = true;
  for (uint8_t b : px) allZero &= b == 0;
  CHECK(allZero);
  GLint bound = -1;
  gl.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &bound);
  CHECK_EQ(bound, (GLint)fbo);

  // 2D array: every layer
  GLuint arr = 0;
  gl.GenTextures(1, &arr);
  gl.BindTexture(GL_TEXTURE_2D_ARRAY, arr);
  gl.TexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_RGBA8, 4, 4, 2);
  std::vector<uint8_t> junk2(4 * 4 * 4 * 2, 0x77);
  gl.TexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, 0, 4, 4, 2, GL_RGBA, GL_UNSIGNED_BYTE, junk2.data());
  CHECK(composite::clearTextureImage(GL_TEXTURE_2D_ARRAY, arr, 0, 2, GL_RGBA8, 4, 4, 1));
  gl.FramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, arr, 0, 1);
  px = ReadRGBA(fbo, 4, 4);
  allZero = true;
  for (uint8_t b : px) allZero &= b == 0;
  CHECK(allZero);

  // depth and integer formats are cleared through the right attachment / clear call
  GLuint depth = 0, itex = 0;
  gl.GenTextures(1, &depth);
  gl.BindTexture(GL_TEXTURE_2D, depth);
  gl.TexStorage2D(GL_TEXTURE_2D, 1, GL_DEPTH24_STENCIL8, 4, 4);
  CHECK(composite::clearTextureImage(GL_TEXTURE_2D, depth, 0, 1, GL_DEPTH24_STENCIL8, 4, 4, 1));
  gl.GenTextures(1, &itex);
  gl.BindTexture(GL_TEXTURE_2D, itex);
  gl.TexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA32UI, 4, 4);
  CHECK(composite::clearTextureImage(GL_TEXTURE_2D, itex, 0, 1, GL_RGBA32UI, 4, 4, 1));
  CHECK(!composite::clearTextureImage(GL_TEXTURE_2D, itex, 0, 1, GL_RGB9_E5, 4, 4, 1));  // not renderable
  CHECK_EQ(gl.GetError(), (GLenum)GL_NO_ERROR);

  // buffers
  GLuint buf = 0;
  gl.GenBuffers(1, &buf);
  gl.BindBuffer(GL_COPY_WRITE_BUFFER, buf);
  composite::bufferDataZero(GL_COPY_WRITE_BUFFER, 3 << 20, GL_STATIC_DRAW);  // > 1 chunk
  const uint8_t* m = static_cast<const uint8_t*>(gl.MapBufferRange(GL_COPY_WRITE_BUFFER, 0, 3 << 20, GL_MAP_READ_BIT));
  CHECK(m != nullptr);
  bool zero = m != nullptr;
  for (size_t i = 0; m && i < (3u << 20); i += 4093) zero &= m[i] == 0;
  CHECK(zero);
  gl.UnmapBuffer(GL_COPY_WRITE_BUFFER);
  GLuint names[] = {tex, arr, depth, itex};
  gl.DeleteTextures(4, names);
  gl.DeleteFramebuffers(1, &fbo);
  gl.DeleteBuffers(1, &buf);
  gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
}

static void TestMultiDraw() {
  std::puts("multi draw + webgl_DrawID");
  const char* vs = R"(#version 300 es
uniform int webgl_DrawID;
flat out int vId;
void main() {
  vId = webgl_DrawID;
  float x = -1.0 + float(gl_VertexID % 3 == 1) * 2.0;
  float y = -1.0 + float(gl_VertexID % 3 == 2) * 2.0;
  gl_Position = vec4(x * 4.0, y * 4.0, 0.0, 1.0);  // one big triangle covers the viewport
})";
  const char* fs = R"(#version 300 es
precision highp float;
flat in int vId;
out vec4 c;
void main() { c = vec4(float(vId) / 255.0, 0.0, 0.0, 1.0); })";
  GLuint p = Link(vs, fs);
  gl.UseProgram(p);
  ProgramRecord r = CollectProgramRecord(p);
  GLint loc = -1;
  for (auto& u : r.uniforms) {
    if (u.name == "webgl_DrawID") loc = u.location;
  }
  CHECK(loc >= 0);
  GLuint tex = 0, fbo = 0, vao = 0;
  gl.GenVertexArrays(1, &vao);
  gl.BindVertexArray(vao);
  gl.GenTextures(1, &tex);
  gl.BindTexture(GL_TEXTURE_2D, tex);
  gl.TexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, 4, 4);
  gl.GenFramebuffers(1, &fbo);
  gl.BindFramebuffer(GL_FRAMEBUFFER, fbo);
  gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
  gl.Viewport(0, 0, 4, 4);
  // three sub-draws; the second has count 0 (draws nothing); the last one wins: drawID 2
  int32_t firsts[] = {0, 0, 0}, counts[] = {3, 0, 3};
  const double before = Stats().multiDrawSubDraws;
  composite::multiDrawArrays(GL_TRIANGLES, reinterpret_cast<uint8_t*>(firsts), 12, reinterpret_cast<uint8_t*>(counts), 12,
                             nullptr, 0, 3, loc);
  CHECK_EQ(Stats().multiDrawSubDraws - before, 2.0);
  auto px = ReadRGBA(fbo, 4, 4);
  CHECK_EQ(px[0], 2);
  CHECK_EQ(px[3], 255);
  // instanced form, instance count 0 skips
  int32_t inst[] = {1, 1, 0};
  int32_t counts2[] = {3, 3, 3};
  composite::multiDrawArrays(GL_TRIANGLES, reinterpret_cast<uint8_t*>(firsts), 12, reinterpret_cast<uint8_t*>(counts2), 12,
                             reinterpret_cast<uint8_t*>(inst), 12, 3, loc);
  px = ReadRGBA(fbo, 4, 4);
  CHECK_EQ(px[0], 1);
  CHECK_EQ(gl.GetError(), (GLenum)GL_NO_ERROR);
  gl.DeleteProgram(p);
  gl.DeleteTextures(1, &tex);
  gl.DeleteFramebuffers(1, &fbo);
  gl.DeleteVertexArrays(1, &vao);
  gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
}

static void TestSync() {
  std::puts("sync ids");
  uint32_t id = composite::fenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
  CHECK(id != 0);
  gl.Finish();
  CHECK_EQ(composite::getSynciv(id, GL_SYNC_STATUS), GL_SIGNALED);
  uint32_t r = composite::clientWaitSync(id, 0, 0);
  CHECK(r == GL_ALREADY_SIGNALED || r == GL_CONDITION_SATISFIED);
  composite::deleteSync(id);
  CHECK(SyncLookup(id) == nullptr);
  CHECK_EQ(composite::clientWaitSync(id, 0, 0), (uint32_t)GL_WAIT_FAILED);
}

static void TestParallelCompile() {
  std::puts("completion status");
  GLuint s = Compile(GL_VERTEX_SHADER, "#version 300 es\nvoid main(){gl_Position=vec4(1);}");
  // Either the extension reports completion eventually, or (no extension) completion is always true.
  bool done = false;
  for (int i = 0; i < 1000 && !done; ++i) {
    done = composite::shaderCompletion(s);
    if (!done) usleep(1000);
  }
  CHECK(done);
  gl.DeleteShader(s);
}

static void TestShaderBlobCache() {
  std::puts("EGL blob cache (GL-22)");
  if (!ShaderCache()) {
    std::puts("  (driver has no EGL_ANDROID_blob_cache: skipped)");
    return;
  }
  // Compile something new: the driver should store at least one blob.
  const size_t before = ShaderCache()->entries();
  char fs[256];
  std::snprintf(fs, sizeof fs,
                "#version 300 es\nprecision mediump float;out vec4 c;void main(){c=vec4(%d.0/7.0);}", getpid() % 997);
  GLuint p = Link("#version 300 es\nvoid main(){gl_Position=vec4(0);}", fs);
  CollectProgramRecord(p);
  std::printf("  blob entries %zu -> %zu, misses %llu\n", before, ShaderCache()->entries(),
              (unsigned long long)ShaderCache()->misses());
  // Informational on the host: Mesa llvmpipe does not route its shader cache through the callbacks.
  // On Quest the Adreno driver does (checked on device, GL-22).
  CHECK(FlushShaderCache());
  gl.DeleteProgram(p);
}

// PROC-8 page reload: the next page's module registration frees every WebGL context of the previous page.
static void TestDestroyAllOnReload() {
  std::puts("destroy all contexts (page reload)");
  auto& env = EglEnvironment::Get();
  const uint32_t a = env.CreateContext({});
  const uint32_t b = env.CreateContext({});
  CHECK(env.MakeCurrent(b));
  CHECK(DestroyAllWebGLContexts() >= 2);
  CHECK(env.ContextIds().empty());
  CHECK(env.Handle(a) == EGL_NO_CONTEXT && env.Handle(b) == EGL_NO_CONTEXT);
  CHECK_EQ(env.current(), 0u);
  CHECK(env.MakeRootCurrent());
}

int main() {
  TestBlobCache();
  char dir[] = "/tmp/iwn-gl-shadercache-XXXXXX";
  if (!mkdtemp(dir)) return 2;
  EglInitOptions opts;
  opts.shaderCacheDir = dir;
  opts.shaderCacheKey = "host-test";
  if (!EglEnvironment::Get().Init(opts)) {
    std::fprintf(stderr, "no EGL/GLES 3 driver on this host\n");
    return 2;
  }
  void* lib = dlopen("libGLESv2.so.2", RTLD_NOW);
  const int missing = LoadGlApi(&Api(), GetProc, lib);
  CHECK_EQ(missing, 0);
  std::printf("driver: %s | %s\n", gl.GetString(GL_VERSION), gl.GetString(GL_RENDERER));
  uint32_t ctx = EglEnvironment::Get().CreateContext({});
  CHECK(EglEnvironment::Get().MakeCurrent(ctx));
  TestContexts();
  TestProgramRecord();
  TestZeroInit();
  TestMultiDraw();
  TestSync();
  TestParallelCompile();
  TestShaderBlobCache();
  TestDestroyAllOnReload();
  EglEnvironment::Get().Terminate();
  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures ? 1 : 0;
}
