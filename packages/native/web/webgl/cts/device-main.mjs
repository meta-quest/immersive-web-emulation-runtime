// On-device side of the GL-CTS-1 runner: the app's main module (bundled by cts/device-build.mjs into a runtime
// app whose preludes are web/glue and the shipped dist/webgl.min.js). It runs one Khronos WebGL conformance page
// in this page context through page.mjs: __ctsSetup(payload), the page's scripts (run by the host), then
// __ctsFinish() resolves with a JSON summary. The host driver (cts/device-run.mjs) reloads the page (CDP
// Page.reload: a fresh V8 context) before every test, so pages never share globals, and sends each page's HTML
// and the files it loads in the payload.
import { runPage } from './page.mjs';

const g = globalThis;
// The page replaces the timer globals with tracking wrappers: keep the runtime's own.
const rt = {
  setTimeout: g.setTimeout,
  clearTimeout: g.clearTimeout,
  setInterval: g.setInterval,
  clearInterval: g.clearInterval,
};
const timers = {
  setTimeout: (f, t, ...a) => rt.setTimeout(f, t, ...a),
  clearTimeout: (h) => rt.clearTimeout(h),
  setInterval: (f, t, ...a) => rt.setInterval(f, t, ...a),
  clearInterval: (h) => rt.clearInterval(h),
};
const perf = g.performance;
const now = () => perf.now();
const globalEval = eval; // indirect eval: global scope, sloppy mode, like a classic <script>

let page = null;
let t0 = 0;
/**
 * Phase 1: set the page up (DOM, globals, harness hooks) and return its markup scripts as JSON
 * [{ filename, code }]. The host runs them as classic scripts over CDP (Runtime.compileScript + runScript), so
 * top-level declarations land in the global scope exactly as with <script> (an eval here would scope "use strict"
 * code's declarations to the eval).
 */
g.__ctsSetup = (payload) => {
  const files = payload.files ?? {};
  t0 = now();
  page = runPage({
    win: g,
    testRel: payload.testRel,
    html: payload.html,
    webglVersion: payload.webglVersion,
    timeout: payload.timeout ?? 30000,
    // src scripts of the markup are run by the host: report them present (any text) so they are not "missing"
    readText: (rel) =>
      Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : (payload.srcScripts ?? []).includes(rel) ? '' : null,
    // timer strings and dynamically inserted <script> elements only (markup scripts go through the host)
    evalScript: (code, filename) => globalEval(`${code}\n//# sourceURL=${filename}`),
    timers,
    now,
    globals: {},
    installBinding: () => {
      if (!g.__iwnWebGL || typeof g.__iwnWebGL.createContext !== 'function') {
        throw new Error('the WebGL prelude (dist/webgl.min.js) is not installed in this app');
      }
    },
    webglOptions: {},
    logError: () => {},
    maxFailures: payload.maxFailures ?? 20,
    deferScripts: true,
  });
  // inline scripts carry their code; src scripts only their file name (the host has the files)
  return JSON.stringify(page.scripts.map((s) => ({ filename: s.filename, code: s.inline ? s.code : undefined })));
};
/** A markup script threw (or failed to compile): record it like the host harness does. */
g.__ctsScriptError = (index, description) => {
  const d = String(description);
  const m = /^(\w*Error|\w+): ([^\n]*)/.exec(d);
  page.scriptError(page.scripts[index], { name: m ? m[1] : 'Error', message: m ? m[2] : d, stack: d });
};
/** Phase 2: load events, then wait for the page to finish; resolves with the JSON summary. */
g.__ctsFinish = () =>
  page.finish().then((r) =>
    JSON.stringify({
      pass: r.pass,
      fail: r.fail,
      skipped: r.skipped,
      finished: r.finished,
      timedOut: r.timedOut,
      failures: r.failures,
      errors: r.errors.slice(0, 20).map((e) => String(e).slice(0, 300)),
      missing: [...new Set(r.missing)],
      ms: Math.round(now() - t0),
    }),
  );
g.__ctsReady = true;
console.log('GLCTS ready');
