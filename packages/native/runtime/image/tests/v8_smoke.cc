// Device smoke test of the image module's V8 binding: a minimal V8 embedding (V8 embedder hello-world pattern) that
// registers iwn_register_image on a "natives" object and runs the given scripts in one context, twice: once with
// completions posted to the platform's foreground task runner and once in polling mode. A tiny setTimeout (run by
// the harness loop) stands in for the runtime's event loop.
//
// Usage on device: iwn_image_v8_smoke <snapshot_blob.bin> <script.js>[,<script2.js>...] [data dir (AVIF/HEIC)]
//   tests/v8_smoke.js                         the natives contract
//   web/glue/dist/glue.js,web/image/dist/image.js,tests/web_e2e.js   web/image end to end over the real module
// After the scripts it checks a page reload (PROC-8): a second context registered in the same isolate must let the
// first one be collected, with its bitmaps.
#include <libplatform/libplatform.h>
#include <v8.h>

#include <stdlib.h>

#include <chrono>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <thread>
#include <vector>

#include "iwn/image/v8_binding.h"
#include "lodepng.h"
#include "test_images.h"

using namespace iwn::image::test;

namespace {

void Print(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::String::Utf8Value s(info.GetIsolate(), info[0]);
  std::printf("%s\n", *s ? *s : "<?>");
  std::fflush(stdout);
}

// Stand-in for the runtime's crypto module (the glue's crypto.randomUUID backs URL.createObjectURL).
void Random(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!info[0]->IsArrayBufferView()) return;
  auto view = info[0].As<v8::ArrayBufferView>();
  arc4random_buf(static_cast<uint8_t*>(view->Buffer()->Data()) + view->ByteOffset(), view->ByteLength());
}

// rss() -> resident set size in MB (/proc/self/statm), for the IMG-7 check.
void Rss(const v8::FunctionCallbackInfo<v8::Value>& info) {
  long pages = 0, resident = 0;
  if (FILE* f = std::fopen("/proc/self/statm", "r")) {
    if (std::fscanf(f, "%ld %ld", &pages, &resident) != 2) resident = 0;
    std::fclose(f);
  }
  info.GetReturnValue().Set(static_cast<double>(resident) * 4096.0 / (1024.0 * 1024.0));
}

v8::Local<v8::ArrayBuffer> ToBuffer(v8::Isolate* iso, const Bytes& b) {
  v8::Local<v8::ArrayBuffer> ab = v8::ArrayBuffer::New(iso, b.size());
  if (!b.empty()) std::memcpy(ab->Data(), b.data(), b.size());
  return ab;
}

const char kTimerPrelude[] = R"JS(
if (typeof globalThis.setTimeout !== 'function') {
  const timers = [];
  globalThis.setTimeout = (fn, ms, ...args) => { timers.push([fn, args]); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.__runTimers = () => { for (const [fn, args] of timers.splice(0)) fn(...args); };
} else {
  globalThis.__runTimers = () => {};
}
)JS";

bool RunOnce(v8::Platform* platform, v8::Isolate* iso, const std::vector<std::string>& sources,
             const std::string& data_dir) {
  v8::HandleScope hs(iso);
  v8::Local<v8::Context> ctx = v8::Context::New(iso);
  v8::Context::Scope cs(ctx);
  v8::Local<v8::Object> global = ctx->Global();
  auto str = [&](const char* s) { return v8::String::NewFromUtf8(iso, s).ToLocalChecked(); };
  global->Set(ctx, str("print"), v8::Function::New(ctx, Print).ToLocalChecked()).Check();
  global->Set(ctx, str("rss"), v8::Function::New(ctx, Rss).ToLocalChecked()).Check();

  v8::Local<v8::Object> natives = v8::Object::New(iso);
  global->Set(ctx, str("__iwn"), natives).Check();
  iwn_register_image(iso, ctx, natives);
  v8::Local<v8::Object> crypto = v8::Object::New(iso);
  crypto->Set(ctx, str("random"), v8::Function::New(ctx, Random).ToLocalChecked()).Check();
  natives->Set(ctx, str("crypto"), crypto).Check();

  v8::Local<v8::Object> data = v8::Object::New(iso);
  const Img corners = Corners4x4();
  Bytes png = EncodePng(corners, 6, 8, false);
  data->Set(ctx, str("png"), ToBuffer(iso, png)).Check();
  data->Set(ctx, str("jpegExif6"), ToBuffer(iso, InsertJpegExif(EncodeJpeg(Pattern(6, 4, false), 100), 6, true))).Check();
  data->Set(ctx, str("webpLossless"), ToBuffer(iso, EncodeWebp(corners, true, 100))).Check();
  data->Set(ctx, str("webpLossy"), ToBuffer(iso, EncodeWebp(Pattern(16, 16, true), false, 80))).Check();
  Img gif{3, 2, {255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0}};
  data->Set(ctx, str("gif"), ToBuffer(iso, EncodeGif(gif))).Check();
  data->Set(ctx, str("corrupt"), ToBuffer(iso, Bytes{'n', 'o', 't', ' ', 'a', 'n', ' ', 'i', 'm', 'a', 'g', 'e'})).Check();
  data->Set(ctx, str("truncatedPng"), ToBuffer(iso, Bytes(png.begin(), png.begin() + png.size() / 2))).Check();
  Bytes huge = EncodePng(Pattern(1, 1, false), 2, 8, false);
  huge[16] = 0; huge[17] = 0; huge[18] = 0x4e; huge[19] = 0x20;  // width 20000
  const unsigned crc = lodepng_crc32(huge.data() + 12, 17);
  for (int i = 0; i < 4; ++i) huge[29 + i] = (crc >> (24 - 8 * i)) & 0xff;
  data->Set(ctx, str("hugePng"), ToBuffer(iso, huge)).Check();
  Bytes extra;
  if (!data_dir.empty() && ReadFile(data_dir + "/sample.avif", &extra)) data->Set(ctx, str("avif"), ToBuffer(iso, extra)).Check();
  if (!data_dir.empty() && ReadFile(data_dir + "/sample2.avif", &extra)) data->Set(ctx, str("avif2"), ToBuffer(iso, extra)).Check();
  if (!data_dir.empty() && ReadFile(data_dir + "/sample3.avif", &extra)) data->Set(ctx, str("avif3"), ToBuffer(iso, extra)).Check();
  if (!data_dir.empty() && ReadFile(data_dir + "/sample.heic", &extra)) data->Set(ctx, str("heic"), ToBuffer(iso, extra)).Check();
  global->Set(ctx, str("testData"), data).Check();

  std::vector<std::string> all = {kTimerPrelude};
  all.insert(all.end(), sources.begin(), sources.end());
  for (const std::string& source : all) {
    v8::TryCatch tc(iso);
    v8::Local<v8::Script> script;
    if (!v8::Script::Compile(ctx, str(source.c_str())).ToLocal(&script) || script->Run(ctx).IsEmpty()) {
      v8::String::Utf8Value e(iso, tc.Exception());
      v8::Local<v8::Value> stack;
      std::string st;
      if (tc.StackTrace(ctx).ToLocal(&stack)) st = *v8::String::Utf8Value(iso, stack);
      std::printf("script error: %s\n%s\n", *e, st.c_str());
      return false;
    }
  }
  v8::Local<v8::Function> run_timers =
      global->Get(ctx, str("__runTimers")).ToLocalChecked().As<v8::Function>();
  v8::Local<v8::Value> image = natives->Get(ctx, str("image")).ToLocalChecked();
  v8::Local<v8::Function> poll =
      image.As<v8::Object>()->Get(ctx, str("poll")).ToLocalChecked().As<v8::Function>();
  const auto start = std::chrono::steady_clock::now();
  for (;;) {
    while (v8::platform::PumpMessageLoop(platform, iso)) {
    }
    (void)poll->Call(ctx, image, 0, nullptr);
    iso->PerformMicrotaskCheckpoint();
    (void)run_timers->Call(ctx, global, 0, nullptr);
    iso->PerformMicrotaskCheckpoint();
    v8::Local<v8::Value> result = global->Get(ctx, str("__result")).ToLocalChecked();
    if (!result->IsUndefined()) {
      v8::String::Utf8Value r(iso, result);
      std::printf("RESULT %s\n", *r);
      return std::string(*r) == "PASS";
    }
    if (std::chrono::steady_clock::now() - start > std::chrono::seconds(60)) {
      std::printf("RESULT FAIL timeout\n");
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

// PROC-8: a page reload creates a new context in the same isolate and registers the module again. The previous
// context (with live image handles and a decode still running) must become collectable, its late completion must be
// dropped, and nothing may be retained by the module (GetBindingStats).
bool RunReloadCheck(v8::Platform* platform, v8::Isolate* iso) {
  auto str = [&](const char* s) { return v8::String::NewFromUtf8(iso, s).ToLocalChecked(); };
  auto run = [&](v8::Local<v8::Context> ctx, const char* src) {
    v8::TryCatch tc(iso);
    v8::Local<v8::Script> script;
    if (!v8::Script::Compile(ctx, str(src)).ToLocal(&script) || script->Run(ctx).IsEmpty()) {
      std::printf("reload check script error: %s\n", *v8::String::Utf8Value(iso, tc.Exception()));
      return false;
    }
    return true;
  };
  auto pump = [&](v8::Local<v8::Context> ctx, const char* until) {
    const auto start = std::chrono::steady_clock::now();
    for (;;) {
      while (v8::platform::PumpMessageLoop(platform, iso)) {
      }
      iso->PerformMicrotaskCheckpoint();
      v8::Local<v8::Value> v;
      if (until && ctx->Global()->Get(ctx, str(until)).ToLocal(&v) && v->IsTrue()) return true;
      if (std::chrono::steady_clock::now() - start > std::chrono::seconds(until ? 30 : 0)) return !until;
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  };
  auto full_gc = [&] {
    for (int i = 0; i < 4; ++i) {
      iso->RequestGarbageCollectionForTesting(v8::Isolate::kFullGarbageCollection);
      while (v8::platform::PumpMessageLoop(platform, iso)) {
      }
    }
  };
  bool ok = true;
  auto check = [&](bool cond, const char* what) {
    std::printf("%s %s\n", cond ? "ok  " : "FAIL", what);
    ok = ok && cond;
  };
  double rss_before = 0, rss_page = 0, rss_after = 0;
  auto rss = [] {
    long pages = 0, resident = 0;
    if (FILE* f = std::fopen("/proc/self/statm", "r")) {
      if (std::fscanf(f, "%ld %ld", &pages, &resident) != 2) resident = 0;
      std::fclose(f);
    }
    return static_cast<double>(resident) * 4096.0 / (1024.0 * 1024.0);
  };
  full_gc();
  rss_before = rss();
  v8::Global<v8::Context> page_a;
  {
    v8::HandleScope hs(iso);
    v8::Local<v8::Context> ctx = v8::Context::New(iso);
    v8::Context::Scope cs(ctx);
    v8::Local<v8::Object> natives = v8::Object::New(iso);
    ctx->Global()->Set(ctx, str("__iwn"), natives).Check();
    iwn_register_image(iso, ctx, natives);
    // Page A: 8 live 4 MB bitmaps, a big array, then a decode still in flight when the page goes away.
    ok = run(ctx, R"JS(
      globalThis.keep = []; globalThis.ready = false; globalThis.big = new Array(1 << 21).fill(1.5);
      const img = __iwn.image;
      const jobs = [];
      for (let i = 0; i < 8; i++) jobs.push(img.fromPixels(new Uint8ClampedArray(1024 * 1024 * 4), 1024, 1024, false, {})
        .then((h) => keep.push(h)));
      Promise.all(jobs).then(() => { ready = true; });
    )JS") && ok;
    // Polling mode needs explicit polls; the platform mode delivers through the pumped task runner.
    for (int i = 0; i < 15000; ++i) {
      v8::Local<v8::Value> v;
      if (ctx->Global()->Get(ctx, str("ready")).ToLocal(&v) && v->IsTrue()) break;
      run(ctx, "__iwn.image.poll()");
      pump(ctx, nullptr);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    v8::Local<v8::Value> ready;
    check(ctx->Global()->Get(ctx, str("ready")).ToLocal(&ready) && ready->IsTrue(), "reload: page A created 8 bitmaps");
    run(ctx, "globalThis.late = __iwn.image.fromPixels(new Uint8ClampedArray(2048 * 2048 * 4), 2048, 2048, false, "
             "{ resizeWidth: 1000, resizeHeight: 1000, quality: 3 })");
    rss_page = rss();
    page_a.Reset(iso, ctx);
    page_a.SetWeak();
  }
  // The reload: a fresh context in the same isolate, natives installed again.
  {
    v8::HandleScope hs(iso);
    v8::Local<v8::Context> ctx = v8::Context::New(iso);
    v8::Context::Scope cs(ctx);
    v8::Local<v8::Object> natives = v8::Object::New(iso);
    ctx->Global()->Set(ctx, str("__iwn"), natives).Check();
    iwn_register_image(iso, ctx, natives);
    iwn::image::BindingStats s = iwn::image::GetBindingStats(iso);
    check(s.retired_states >= 1 && !s.retired_holding_context, "reload: the old registration no longer holds its context");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));  // let page A's late job finish and try to post
    pump(ctx, nullptr);
    full_gc();
    rss_after = rss();
    check(page_a.IsEmpty(), "reload: page A's context was collected");
    s = iwn::image::GetBindingStats(iso);
    check(s.retired_handles == 0 && s.retired_bytes == 0, "reload: page A's bitmaps were finalized");
    check(s.retired_states == 0, "reload: page A's registration was freed once its context and handles were gone");
    std::printf("info reload: rss %.1f MB before, %.1f MB with page A, %.1f MB after reload + GC\n", rss_before,
                rss_page, rss_after);
    check(rss_after - rss_before < 20, "reload: RSS back near the baseline");
    // The new page works.
    ok = run(ctx, "globalThis.done = false; __iwn.image.fromPixels(new Uint8ClampedArray(16), 2, 2, false, {})"
                  ".then((h) => { globalThis.done = h.width === 2; })") && ok;
    for (int i = 0; i < 5000; ++i) {
      v8::Local<v8::Value> v;
      if (ctx->Global()->Get(ctx, str("done")).ToLocal(&v) && v->IsTrue()) break;
      run(ctx, "__iwn.image.poll()");
      pump(ctx, nullptr);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    v8::Local<v8::Value> done;
    check(ctx->Global()->Get(ctx, str("done")).ToLocal(&done) && done->IsTrue(), "reload: the new page decodes");
  }
  return ok;
}

// INTEROP.md section 7: tasks pumped between DisposeIsolate and Isolate::Dispose. Handles are dropped and the heap
// churned so ordinary (non-forced) GCs run their first-pass weak callbacks and post the second passes as tasks;
// DisposeIsolate then runs with some second passes still queued, and the loop is pumped afterwards. Those boxes
// must be left to (and freed by) their second pass, never deleted twice or touched through the freed State.
bool RunDisposeThenPumpCheck(v8::Platform* platform, v8::Isolate::CreateParams& params) {
  v8::Isolate* iso = v8::Isolate::New(params);
  bool ok = true;
  size_t deferred0 = 0, freed0 = 0, deferred1 = 0, freed1 = 0;
  iwn::image::DeferredBoxStatsForTesting(&deferred0, &freed0);
  {
    v8::Isolate::Scope is(iso);
    v8::HandleScope hs(iso);
    v8::Local<v8::Context> ctx = v8::Context::New(iso);
    v8::Context::Scope cs(ctx);
    v8::Local<v8::Object> natives = v8::Object::New(iso);
    ctx->Global()->Set(ctx, v8::String::NewFromUtf8Literal(iso, "__iwn"), natives).Check();
    iwn_register_image(iso, ctx, natives);  // polling mode: the shared config is reset by the caller
    const char* src = R"JS(
      globalThis.made = 0;
      (async () => {
        for (let round = 0; round < 40; round++) {
          const p = [];
          for (let i = 0; i < 50; i++) p.push(__iwn.image.fromPixels(new Uint8ClampedArray(64 * 64 * 4), 64, 64, false, {}));
          for (const h of await Promise.all(p)) made += h.width > 0 ? 1 : 0;
          let junk = []; for (let i = 0; i < 20000; i++) junk.push({ i, s: 'x' + i }); junk = null;  // churn: natural GCs
        }
      })();
    )JS";
    v8::Local<v8::Script> script = v8::Script::Compile(ctx, v8::String::NewFromUtf8(iso, src).ToLocalChecked()).ToLocalChecked();
    (void)script->Run(ctx);
    const auto start = std::chrono::steady_clock::now();
    for (;;) {
      v8::Local<v8::Script> poll =
          v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(iso, "__iwn.image.poll(); made")).ToLocalChecked();
      v8::Local<v8::Value> made = poll->Run(ctx).ToLocalChecked();
      iso->PerformMicrotaskCheckpoint();
      if (made->Uint32Value(ctx).FromMaybe(0) >= 2000) break;
      if (std::chrono::steady_clock::now() - start > std::chrono::seconds(60)) {
        std::printf("FAIL dispose-then-pump: jobs did not finish\n");
        ok = false;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    // Deliberately no pumping here: second passes posted by the GCs above are still queued.
    // Keep a handle alive across DisposeIsolate (its box is deleted there) to call natives on it afterwards.
    (void)v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(iso, R"JS(
      globalThis.kept = null;
      __iwn.image.fromPixels(new Uint8ClampedArray(16), 2, 2, false, {}).then((h) => { kept = h; });
    )JS")).ToLocalChecked()->Run(ctx);
    for (int i = 0; i < 5000; ++i) {
      v8::Local<v8::Value> k;
      if (ctx->Global()->Get(ctx, v8::String::NewFromUtf8Literal(iso, "kept")).ToLocal(&k) && k->IsObject()) break;
      (void)v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(iso, "__iwn.image.poll()")).ToLocalChecked()->Run(ctx);
      iso->PerformMicrotaskCheckpoint();
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    iwn::image::DisposeIsolate(iso);
    // JS that runs after DisposeIsolate (e.g. a FinalizationRegistry callback while the loop is pumped) must find
    // the natives inert: the ones returning values throw a TypeError, close/cancel/poll do nothing.
    {
      const char* after = R"JS(
        (() => {
          const img = __iwn.image;
          let threw = 0;
          for (const f of [() => img.stats(), () => img.readPixels(kept, false), () => img.share(kept),
                           () => img.transform(kept, {}), () => img.decode(new Uint8Array(8), {}),
                           () => img.fromPixels(new Uint8Array(16), 2, 2, false, {}), () => img.exportTransfer(kept),
                           () => img.importTransfer(1), () => img.decodeBase64('AAAA', {})]) {
            try { f(); } catch (e) { if (e instanceof TypeError) threw++; }
          }
          img.close(kept); img.cancel(Promise.resolve()); img.poll();
          return kept !== null && threw === 9;
        })()
      )JS";
      v8::TryCatch tc(iso);
      v8::Local<v8::Value> r;
      const bool inert = v8::Script::Compile(ctx, v8::String::NewFromUtf8(iso, after).ToLocalChecked())
                             .ToLocalChecked()->Run(ctx).ToLocal(&r) && r->IsTrue();
      std::printf("%s dispose-then-pump: natives called after DisposeIsolate are inert (throw or no-op)\n",
                  inert ? "ok  " : "FAIL");
      ok = ok && inert;
    }
    while (v8::platform::PumpMessageLoop(platform, iso)) {
    }
    iso->LowMemoryNotification();
    while (v8::platform::PumpMessageLoop(platform, iso)) {
    }
  }
  iso->Dispose();
  iwn::image::DeferredBoxStatsForTesting(&deferred1, &freed1);
  std::printf("info dispose-then-pump: %zu handles were awaiting their second pass at DisposeIsolate, %zu freed by it\n",
              deferred1 - deferred0, freed1 - freed0);
  std::printf("%s dispose-then-pump: no crash, every deferred handle freed by its second pass\n",
              ok && freed1 - freed0 == deferred1 - deferred0 ? "ok  " : "FAIL");
  return ok && freed1 - freed0 == deferred1 - deferred0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s <snapshot_blob.bin> <v8_smoke.js> [data dir]\n", argv[0]);
    return 2;
  }
  std::vector<std::string> sources;
  std::stringstream list(argv[2]);
  for (std::string path; std::getline(list, path, ',');) {
    std::ifstream js(path);
    if (!js) {
      std::fprintf(stderr, "cannot read %s\n", path.c_str());
      return 2;
    }
    std::stringstream ss;
    ss << js.rdbuf();
    sources.push_back(ss.str());
  }
  const std::string data_dir = argc > 3 ? argv[3] : "";

  v8::V8::SetFlagsFromString("--expose-gc");
  v8::V8::InitializeExternalStartupDataFromFile(argv[1]);
  std::unique_ptr<v8::Platform> platform = v8::platform::NewDefaultPlatform();
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();
  v8::Isolate::CreateParams params;
  params.array_buffer_allocator = v8::ArrayBuffer::Allocator::NewDefaultAllocator();
  v8::Isolate* iso = v8::Isolate::New(params);
  bool ok = true;
  {
    v8::Isolate::Scope is(iso);
    iwn::image::BindingConfig push;
    push.platform = platform.get();
    iwn::image::ConfigureBinding(push);
    std::printf("== platform task runner mode\n");
    ok = RunOnce(platform.get(), iso, sources, data_dir) && ok;
    iwn::image::ConfigureBinding(iwn::image::BindingConfig{});
    std::printf("== polling mode\n");
    ok = RunOnce(platform.get(), iso, sources, data_dir) && ok;
    iwn::image::ConfigureBinding(push);
    std::printf("== reload (platform task runner mode)\n");
    ok = RunReloadCheck(platform.get(), iso) && ok;
    iwn::image::ConfigureBinding(iwn::image::BindingConfig{});
    std::printf("== reload (polling mode)\n");
    ok = RunReloadCheck(platform.get(), iso) && ok;
    iwn::image::DisposeIsolate(iso);
    {
      iwn::image::BindingStats s = iwn::image::GetBindingStats(iso);
      std::printf("%s DisposeIsolate forgets the isolate\n", s.registered ? "FAIL" : "ok  ");
      ok = ok && !s.registered;
    }
  }
  iso->Dispose();
  iwn::image::ConfigureBinding(iwn::image::BindingConfig{});
  std::printf("== dispose, then pump (non-core isolate teardown order)\n");
  ok = RunDisposeThenPumpCheck(platform.get(), params) && ok;
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  delete params.array_buffer_allocator;
  std::printf("%s\n", ok ? "ALL PASS" : "SOME FAILED");
  return ok ? 0 : 1;
}
