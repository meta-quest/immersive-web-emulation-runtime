#!/usr/bin/env node
// M1 exit check from the developer machine, after `adb forward tcp:<cdp> localabstract:<pkg>_devtools_<cdp>` and
// `adb forward tcp:<dbg> localabstract:<pkg>_devtools_<dbg>` to a running hello-js APK:
//   node m1-check.mjs --cdp 9501 --debug 9601 [--host 127.0.0.1] [--json out.json]
// Debug endpoint (DBG-1, DBG-EVAL, DBG-STATS, DBG-6) with a first-frame-only raw client (the contract our perf tools
// rely on), CDP discovery and a DevTools-style session over Node's global WebSocket (CDP-2..5, CDP-9, CDP-10,
// GAP-5), a shouting raw handshake (CDP-3), a heap snapshot (CDP-4), and pause/resume (CDP-7).
// Revision 2 adds: console source links skip the ignore-listed bootstrap (CON-3), source maps through
// Network.loadNetworkResource/IO.read (CDP-5), crypto.random (NET-STORE-4), the WebSocket Origin policy, no
// starvation of debug requests by expensive timers (LOOP-2, DBG-7), and the debug endpoint and CDP surviving a
// reload that races with inbound requests (PROC-8, DBG-1). The last two run at the end.
// Revision 3 adds: "pause on uncaught exceptions" stops in timer, rAF and queueMicrotask callbacks but not for caught
// errors, each uncaught error is reported once (CDP-5, LOOP-4); error events carry filename/line for rAF, microtask
// and reportError errors (LOOP-4); module map keys keep URL fragments (MOD-3/MOD-4); Runtime.terminateExecution
// stops a runaway evaluate; closing a session while paused resumes the app (connectShared teardown).
// Revision 5 adds: concurrent import() of one URL shares one off-thread read and a shared dependency is read once
// (PROC-2); __iwn.core.invokeCallback pauses on uncaught exceptions and runs no checkpoint mid-script (CDP-5, JS-5).
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const HOST = args.host || '127.0.0.1';
const CDP = Number(args.cdp || 9501);
const DBG = Number(args.debug || 9601);
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ' — ' + String(detail).slice(0, 200) : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- raw WebSocket client (masked frames out; reads whole frames in) -----------------------------------------------
function rawConnect(port, path, headers) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, HOST);
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const frames = [];
    const waiters = [];
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
          sock.destroy();
          return;
        }
        upgraded = true;
        resolve(api);
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) break;
        const frame = { fin: !!(buf[0] & 0x80), opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len) };
        buf = buf.subarray(off + len);
        if (waiters.length) waiters.shift()(frame);
        else frames.push(frame);
      }
    });
    const lines = [`GET ${path} HTTP/1.1`, ...headers(key), '', ''];
    sock.write(lines.join('\r\n'));
    const api = {
      send(text, opcode = 1) {
        const payload = Buffer.from(text);
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
        else if (payload.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
        sock.write(Buffer.concat([header, mask, masked]));
      },
      next(timeout = 5000) {
        if (frames.length) return Promise.resolve(frames.shift());
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout waiting for a frame')), timeout);
          waiters.push((f) => {
            clearTimeout(t);
            res(f);
          });
        });
      },
      close() {
        sock.destroy();
      },
    };
  });
}

const lowerHeaders = (port) => (key) => [`host: ${HOST}:${port}`, 'connection: Upgrade', 'upgrade: websocket',
  `sec-websocket-key: ${key}`, 'sec-websocket-version: 13'];

// The perf tool's contract: one request per connection, no id, first frame is the whole reply.
async function hostRpc(method, params = {}, timeout = 10000) {
  const ws = await rawConnect(DBG, '/host', lowerHeaders(DBG));
  ws.send(JSON.stringify({ method, params }));
  const f = await ws.next(timeout);
  ws.close();
  if (!f.fin || f.opcode !== 1) throw new Error('reply was not a single text frame');
  return JSON.parse(f.payload.toString());
}

async function httpGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, HOST);
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host || HOST + ':' + port}\r\n\r\n`);
  });
}

async function main() {
  // ---------------- debug endpoint ----------------
  const one = await hostRpc('eval', { expression: '1+1' });
  check('debug eval 1+1 -> {result: 2} (DBG-1, DBG-EVAL)', one.result === 2, JSON.stringify(one));
  const t0 = Date.now();
  const slow = await hostRpc('eval', { expression: 'new Promise(r => setTimeout(() => r(42), 500))' });
  const dt = Date.now() - t0;
  check('eval awaits a promise while the loop keeps running (DBG-EVAL, LOOP-5)', slow.result === 42 && dt >= 450 && dt < 3000, `${JSON.stringify(slow)} in ${dt} ms`);
  const thrown = await hostRpc('eval', { expression: 'throw new Error("x-marks")' });
  check('eval throw -> {error} with the message', typeof thrown.error === 'string' && thrown.error.includes('x-marks'), thrown.error);
  const undef = await hostRpc('eval', { expression: 'undefined' });
  check('eval undefined -> result null (documented)', 'result' in undef && undef.result === null, JSON.stringify(undef));
  const fn = await hostRpc('eval', { expression: '(function named() {})' });
  check('non-serialisable -> String(value)', typeof fn.result === 'string' && fn.result.includes('named'), JSON.stringify(fn));
  const hello = await hostRpc('eval', { expression: 'globalThis.__hello' });
  check('hello-js bundle: all in-app checks pass (M1)', hello.result && hello.result.passed === hello.result.total && hello.result.total > 20,
    hello.result ? `${hello.result.passed}/${hello.result.total} ${JSON.stringify(hello.result.failed)}` : JSON.stringify(hello));
  const unknown = await hostRpc('nope');
  check('unknown method -> error reply (DBG-1)', typeof unknown.error === 'string', unknown.error);
  const stats = await hostRpc('stats');
  check('stats has versions, boot marks, loop, heap, gc (DBG-STATS)', stats.v8Version && stats.boot && stats.boot.entryEvaluated > 0 && stats.heap && stats.gc && stats.loop,
    `v8 ${stats.v8Version} boot.entryEvaluated ${stats.boot && stats.boot.entryEvaluated} fps ${stats.fps}`);
  const info = await hostRpc('info');
  const infoFields = ['deviceModel', 'osBuild', 'runtimeVersion', 'buildId', 'v8Version', 'glRenderer', 'openxrRuntime', 'packageId', 'versionName'];
  check('info has every field, non-empty (DBG-6)', infoFields.every((k) => info[k] !== undefined && info[k] !== ''), infoFields.map((k) => `${k}=${info[k]}`).join(' '));
  // Pipelined with ids on one connection.
  const pipe = await rawConnect(DBG, '/host', lowerHeaders(DBG));
  pipe.send(JSON.stringify({ id: 1, method: 'eval', params: { expression: 'new Promise(r => setTimeout(() => r("slow"), 300))' } }));
  pipe.send(JSON.stringify({ id: 2, method: 'eval', params: { expression: '"fast"' } }));
  const r1 = JSON.parse((await pipe.next()).payload);
  const r2 = JSON.parse((await pipe.next()).payload);
  pipe.close();
  check('pipelined requests get id-matched replies (DBG-1)', r1.id === 2 && r1.result === 'fast' && r2.id === 1 && r2.result === 'slow', JSON.stringify([r1, r2]));

  // ---------------- CDP discovery ----------------
  const version = await httpGet(CDP, '/json/version');
  const vjson = JSON.parse(version.slice(version.indexOf('\r\n\r\n') + 4));
  check('/json/version reports V8 and protocol 1.3 (CDP-2)', vjson['V8-Version'].startsWith('15.5') && vjson['Protocol-Version'] === '1.3', vjson['V8-Version']);
  const list = await httpGet(CDP, '/json/list');
  const targets = JSON.parse(list.slice(list.indexOf('\r\n\r\n') + 4));
  check('/json/list: page target first with ws URL (CDP-2)', targets[0].type === 'page' && targets[0].webSocketDebuggerUrl.startsWith('ws://'), targets[0].webSocketDebuggerUrl);
  const evil = await httpGet(CDP, '/json', 'evil.example');
  check('Host: evil.example -> 403 (CDP-10)', /^HTTP\/1\.1 403/.test(evil), evil.split('\r\n')[0]);
  const proto = await httpGet(CDP, '/json/protocol');
  check('/json/protocol may 404 (CDP-2)', /^HTTP\/1\.1 404/.test(proto));

  // ---------------- CDP session over Node's global WebSocket (lowercase headers: GAP-5) ----------------
  const wsUrl = targets[0].webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${HOST}:${CDP}`);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('WebSocket error ' + (e.message || '')));
  });
  check("Node 24's global WebSocket connects (CDP-3, GAP-5)", true);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
      for (const w of [...eventWaiters]) if (w.pred(msg)) {
        eventWaiters.splice(eventWaiters.indexOf(w), 1);
        w.res(msg);
      }
    }
  };
  const send = (method, params = {}, timeout = 20000) =>
    new Promise((res, rej) => {
      const id = nextId++;
      const t = setTimeout(() => rej(new Error('timeout: ' + method)), timeout);
      pending.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const waitEvent = (pred, timeout = 10000) => {
    const found = events.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for event')), timeout);
      eventWaiters.push({ pred, res: (m) => (clearTimeout(t), res(m)) });
    });
  };

  await send('Runtime.enable');
  const ctxEv = await waitEvent((m) => m.method === 'Runtime.executionContextCreated');
  check('Runtime.enable -> executionContextCreated with frameId main (CDP-5)', ctxEv.params.context.auxData && ctxEv.params.context.auxData.frameId === 'main', JSON.stringify(ctxEv.params.context));
  const ev = await send('Runtime.evaluate', { expression: '6*7', returnByValue: true });
  check('Runtime.evaluate 6*7 = 42 (CDP-5)', ev.result && ev.result.result.value === 42, JSON.stringify(ev.result));
  const evp = await send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(() => r("later"), 200))', awaitPromise: true, returnByValue: true });
  check('Runtime.evaluate awaitPromise (CDP-5)', evp.result && evp.result.result.value === 'later');
  await send('Runtime.evaluate', { expression: 'console.log("from-cdp", {k: 1})' });
  const cons = await waitEvent((m) => m.method === 'Runtime.consoleAPICalled' && m.params.args[0] && m.params.args[0].value === 'from-cdp');
  check('console.* -> Runtime.consoleAPICalled with remote objects (CON-3)', cons.params.type === 'log' && cons.params.args[1].type === 'object', JSON.stringify(cons.params.args[1]).slice(0, 120));
  const page = await send('Page.getResourceTree');
  check('Page.getResourceTree: one frame with the app URL (CDP-9)', page.result && page.result.frameTree.frame.url === 'https://app.local/', JSON.stringify(page.result && page.result.frameTree.frame.url));
  const pe = await send('Page.enable');
  const ne = await send('Network.enable');
  const em = await send('Emulation.setDeviceMetricsOverride', { width: 1, height: 1 });
  check('Page.enable / Network.enable / Emulation.* accepted (CDP-9)', pe.result && ne.result && em.result);
  const bad = await send('Bogus.method');
  check("unknown method -> CDP error naming it (CDP-9)", bad.error && bad.error.code === -32601 && bad.error.message.includes('Bogus.method'), JSON.stringify(bad.error));
  await send('Debugger.enable');
  const parsed = await waitEvent((m) => m.method === 'Debugger.scriptParsed' && m.params.url === 'https://app.local/main.js');
  check('Debugger.scriptParsed carries app URLs (CDP-5, MOD-3)', !!parsed, parsed.params.url);

  // CON-3: the bootstrap carries an inline source map that ignore-lists it, so DevTools links console messages to
  // the first app frame.
  const boot = await waitEvent((m) => m.method === 'Debugger.scriptParsed' && m.params.url === 'iwn-runtime:///core/bootstrap.js');
  let ignoreList = null;
  try {
    const mapUrl = boot.params.sourceMapURL;
    const map = JSON.parse(Buffer.from(mapUrl.slice(mapUrl.indexOf('base64,') + 7), 'base64').toString());
    ignoreList = map.ignoreList;
  } catch {}
  check('bootstrap.js is ignore-listed by its inline source map (CON-3)', JSON.stringify(ignoreList) === '[0]', boot.params.sourceMapURL.slice(0, 60));
  await send('Runtime.evaluate', { expression: 'import("/lib/math.js").then(() => setTimeout(function appTimer() { console.warn("probe-from-timer"); }, 10))' });
  const warn = await waitEvent((m) => m.method === 'Runtime.consoleAPICalled' && m.params.args[0] && m.params.args[0].value === 'probe-from-timer');
  const frames = warn.params.stackTrace.callFrames;
  const firstApp = frames.find((f) => !f.url.startsWith('iwn-runtime:///core/bootstrap.js'));
  check('console stack: first non-ignore-listed frame is the page code (CON-3)', firstApp && firstApp.functionName === 'appTimer',
    frames.map((f) => `${f.functionName || '(anon)'} ${f.url}:${f.lineNumber + 1}`).join(' | '));

  // CDP-5: source maps (and any dist file) reach DevTools through the target.
  const res = await send('Network.loadNetworkResource', { frameId: 'main', url: 'https://app.local/main.js', options: { disableCache: false, includeCredentials: false } });
  let body = '';
  if (res.result && res.result.resource.success) {
    for (let i = 0; i < 64; i++) {
      const chunk = await send('IO.read', { handle: res.result.resource.stream, size: 4096 });
      body += chunk.result.base64Encoded ? Buffer.from(chunk.result.data, 'base64').toString() : chunk.result.data;
      if (chunk.result.eof) break;
    }
    await send('IO.close', { handle: res.result.resource.stream });
  }
  const missing = await send('Network.loadNetworkResource', { frameId: 'main', url: 'https://app.local/nope.js.map', options: {} });
  check('Network.loadNetworkResource + IO.read serve dist files; missing -> success false (CDP-5)',
    body.includes('import') && missing.result && missing.result.resource.success === false && missing.result.resource.httpStatusCode === 404,
    `${body.length} bytes; missing: ${JSON.stringify(missing.result && missing.result.resource)}`);
  await send('Profiler.enable');
  await send('Profiler.start');
  await sleep(1000);
  const prof = await send('Profiler.stop');
  check('Profiler sampling profile (CDP-5)', prof.result && prof.result.profile.nodes.length > 1, `${prof.result && prof.result.profile.nodes.length} nodes`);

  // Pause: the heartbeat interval runs JS every second; Debugger.pause stops at the next statement (CDP-7).
  await send('Debugger.pause');
  const paused = await waitEvent((m) => m.method === 'Debugger.paused', 5000).catch(() => null);
  check('Debugger.pause -> Debugger.paused (CDP-7)', !!paused, paused && paused.params.reason);
  if (paused) {
    const onFrame = await send('Debugger.evaluateOnCallFrame', { callFrameId: paused.params.callFrames[0].callFrameId, expression: '1+2', returnByValue: true });
    check('evaluate on the paused call frame', onFrame.result && onFrame.result.result.value === 3);
    await sleep(2000);
    await send('Debugger.resume');
    await waitEvent((m) => m.method === 'Debugger.resumed');
    const after = await hostRpc('eval', { expression: 'globalThis.__heartbeat' });
    check('resume continues the app; debug endpoint answers (CDP-7)', typeof after.result === 'number', JSON.stringify(after));
  }

  // Heap snapshot: tens of MB in many chunks; every message one frame (CDP-4).
  let chunks = 0;
  let bytes = 0;
  const onChunk = (m) => {
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk') {
      chunks++;
      bytes += m.params.chunk.length;
    }
  };
  const prevHandler = ws.onmessage;
  ws.onmessage = (m) => {
    onChunk(JSON.parse(m.data));
    prevHandler(m);
  };
  const snap = await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 120000);
  check('HeapProfiler.takeHeapSnapshot completes (CDP-4)', !snap.error && chunks > 0, `${chunks} chunks, ${(bytes / 1048576).toFixed(1)} MB`);

  // r3 CDP-5 / LOOP-4: DevTools' default "Pause on uncaught exceptions" stops in page callbacks.
  const uncaughtBefore = (await hostRpc('stats')).errors.uncaught;
  const pauseCases = [
    ['timer', 'timerThrow', 'setTimeout(function timerThrow() { throw new Error("r3-timer"); }, 10); 1'],
    ['rAF', 'rafThrow', 'requestAnimationFrame(function rafThrow() { throw new Error("r3-raf"); }); 1'],
    ['queueMicrotask', 'qmThrow', 'setTimeout(() => queueMicrotask(function qmThrow() { throw new Error("r3-qm"); }), 10); 1'],
    // r5: the glue's listener loop can call listeners through __iwn.core.invokeCallback instead of a JS try/catch.
    ['invokeCallback', 'cbThrow', 'setTimeout(() => __iwn.core.invokeCallback(function cbThrow() { throw new Error("r5-cb"); }, null), 10); 1'],
  ];
  const pauseResults = [];
  await send('Debugger.setPauseOnExceptions', { state: 'uncaught' });
  for (const [name, fnName, expr] of pauseCases) {
    const since = events.length;
    await send('Runtime.evaluate', { expression: expr });
    const p = await waitEvent((m, i) => m.method === 'Debugger.paused' && events.indexOf(m) >= since, 3000).catch(() => null);
    const top = p && p.params.callFrames[0];
    pauseResults.push(`${name}:${p ? p.params.reason + '@' + (top && top.functionName) : 'no-pause'}`);
    if (p) {
      await send('Debugger.resume');
      await sleep(200);
    }
    pauseResults.ok = (pauseResults.ok ?? true) && !!p && p.params.reason === 'exception' && top && top.functionName === fnName;
  }
  // A caught error inside a timer must not pause in "uncaught" mode.
  const sinceCaught = events.length;
  await send('Runtime.evaluate', { expression: 'setTimeout(function caughtInTimer() { try { throw new Error("r3-caught"); } catch {} }, 10); 1' });
  const caughtPause = await waitEvent((m) => m.method === 'Debugger.paused' && events.indexOf(m) >= sinceCaught, 1500).catch(() => null);
  if (caughtPause) await send('Debugger.resume');
  await send('Debugger.setPauseOnExceptions', { state: 'none' });
  await sleep(300);
  const uncaughtAfter = (await hostRpc('stats')).errors.uncaught;
  check('pause on uncaught exceptions stops in timer, rAF, queueMicrotask and invokeCallback callbacks (CDP-5)', pauseResults.ok, pauseResults.join(' '));
  check('a caught error in a timer does not pause; each uncaught error is reported once (CDP-5, LOOP-4)',
    !caughtPause && uncaughtAfter - uncaughtBefore === pauseCases.length, `caughtPause=${!!caughtPause} uncaught +${uncaughtAfter - uncaughtBefore}`);

  // r3 LOOP-4: error events carry the location for rAF, queueMicrotask and reportError errors.
  // hello-js has no web glue (no EventTarget), so the runtime calls window.onerror(message, filename, lineno, colno, error).
  await hostRpc('eval', { expression: `globalThis.__r3errs = []; globalThis.__r3prev = globalThis.onerror;
    globalThis.onerror = (m, f, l, c) => { if (/r3-loc/.test(m)) { __r3errs.push([m, f, l, c]); return true; } return __r3prev ? __r3prev(m, f, l, c) : false; };
    requestAnimationFrame(function rafLoc() { throw new Error('r3-loc-raf'); });
    queueMicrotask(function qmLoc() { throw new Error('r3-loc-qm'); });
    reportError(new Error('r3-loc-report'));
    'armed'` });
  await sleep(500);
  const locs = (await hostRpc('eval', { expression: '(globalThis.onerror = __r3prev, __r3errs)' })).result || [];
  check('error events from rAF, queueMicrotask and reportError have filename/line/column (LOOP-4)',
    locs.length === 3 && locs.every(([, f, l, c]) => f === 'iwn-debug:///eval' && l > 0 && c > 0), JSON.stringify(locs));

  // r3 MOD-3/MOD-4: fragments are part of the module map key; import.meta.url keeps them.
  const frag = await hostRpc('eval', { expression: 'Promise.all([import("/lib/lazy.js#a"), import("/lib/lazy.js#b"), import("/lib/lazy.js#a")]).then(([a, b, a2]) => [a === b, a === a2, a.url, b.url])' });
  check('module map keeps URL fragments: x.js#a and x.js#b are two records (MOD-3, MOD-4)',
    frag.result && frag.result[0] === false && frag.result[1] === true && frag.result[2].endsWith('lazy.js#a') && frag.result[3].endsWith('lazy.js#b'), JSON.stringify(frag));

  // r5 PROC-2: concurrent import() of one URL shares one off-thread read (HTML module map "fetching"); a second
  // target that shares a dependency does not read it again; the dependency is evaluated once.
  const rs0 = (await hostRpc('stats')).scripts;
  const dedup = await hostRpc('eval', { expression: `Promise.all([...Array.from({ length: 50 }, () => import('/lib/on-demand.js')),
    import('/lib/on-demand-2.js')]).then((ns) => [ns.slice(0, 50).every((n) => n === ns[0]), ns[0].size, ns[50].size2, globalThis.__sharedDepEvaluations])` }, 10000);
  const rs1 = (await hostRpc('stats')).scripts;
  const reads = rs1.importReads - rs0.importReads;
  const joined = rs1.importReadsJoined - rs0.importReadsJoined;
  check('50 concurrent imports of one URL share one read; a shared dependency is read and evaluated once (PROC-2, MOD-4)',
    dedup.result && dedup.result[0] === true && dedup.result[1] === 65536 && dedup.result[2] === 65536 && dedup.result[3] === 1 &&
      reads === 2 && joined === 49 && rs1.importReadsSync === rs0.importReadsSync,
    `${JSON.stringify(dedup.result || dedup.error)} reads=${reads} joined=${joined} sync=${rs1.importReadsSync - rs0.importReadsSync}`);

  // r5: Runtime::call_function / no JS-callable checkpoint: __iwn.core.runMicrotasks is gone, invokeCallback returns
  // the callback's value and does not run microtasks with JS on the stack.
  const inv = await hostRpc('eval', { expression: `(() => { let ran = false; Promise.resolve().then(() => { ran = true; });
    const v = __iwn.core.invokeCallback(function (a, b) { return this.k + a + b; }, { k: 1 }, 2, 3);
    return [typeof __iwn.core.runMicrotasks, v, ran]; })()` });
  check('invokeCallback returns the value and runs no checkpoint mid-script; no runMicrotasks native (JS-5, LOOP-1)',
    inv.result && inv.result[0] === 'undefined' && inv.result[1] === 6 && inv.result[2] === false, JSON.stringify(inv.result || inv.error));

  // r3: Runtime.terminateExecution stops a runaway evaluate (dispatched from an interrupt).
  const tRun = Date.now();
  const runaway = send('Runtime.evaluate', { expression: '(() => { const t = Date.now(); while (Date.now() - t < 6000); return "finished"; })()', returnByValue: true }, 15000);
  await sleep(400);
  const term = await send('Runtime.terminateExecution', {}, 10000).catch((e) => ({ error: e.message }));
  const runRes = await runaway.catch((e) => ({ error: e.message }));
  const runMs = Date.now() - tRun;
  const aliveAfterTerm = await hostRpc('eval', { expression: '"alive"' }).catch((e) => ({ error: e.message }));
  check('Runtime.terminateExecution stops a runaway evaluate; the app keeps running',
    runMs < 3000 && !(runRes.result && runRes.result.result && runRes.result.result.value === 'finished') && aliveAfterTerm.result === 'alive',
    `${runMs} ms term=${JSON.stringify(term.result || term.error)} eval=${JSON.stringify(runRes.result || runRes.error).slice(0, 120)}`);

  // r3: a second session closes while it has the page paused: the app resumes, the parked session is freed later.
  let closePaused = 'no-pause';
  await send('Debugger.disable');  // only the second session debugs; this one stays attached
  try {
    const ws3 = new WebSocket(wsUrl);
    await new Promise((res, rej) => ((ws3.onopen = res), (ws3.onerror = () => rej(new Error('ws3 error')))));
    let pausedSeen = false;
    ws3.onmessage = (m) => {
      if (JSON.parse(m.data).method === 'Debugger.paused') pausedSeen = true;
    };
    ws3.send(JSON.stringify({ id: 1, method: 'Debugger.enable' }));
    await sleep(300);
    ws3.send(JSON.stringify({ id: 2, method: 'Debugger.pause' }));
    for (let i = 0; i < 30 && !pausedSeen; i++) await sleep(100);
    if (pausedSeen) closePaused = 'paused';
    ws3.close();
    await sleep(800);
  } catch (e) {
    closePaused = e.message;
  }
  const afterClose = await hostRpc('eval', { expression: 'globalThis.__heartbeat' }, 5000).catch((e) => ({ error: e.message }));
  const ping = await send('Runtime.evaluate', { expression: '"still"', returnByValue: true }, 5000).catch((e) => ({ error: e.message }));
  check('closing a session while it holds the page paused resumes the app (CDP-7, session teardown)',
    closePaused === 'paused' && typeof afterClose.result === 'number' && ping.result && ping.result.result.value === 'still',
    `${closePaused}; eval=${JSON.stringify(afterClose)}`);
  ws.close();

  // Raw handshake with SHOUTING header names and a multi-token Connection header (CDP-3).
  try {
    const shout = await rawConnect(CDP, new URL(wsUrl).pathname, (key) => [`HOST: ${HOST}:${CDP}`, 'CONNECTION: keep-alive, Upgrade',
      'UPGRADE: WebSocket', `SEC-WEBSOCKET-KEY: ${key}`, 'SEC-WEBSOCKET-VERSION: 13']);
    shout.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '"shout"', returnByValue: true } }));
    let reply;
    for (let i = 0; i < 20; i++) {
      const f = await shout.next();
      const m = JSON.parse(f.payload);
      if (m.id === 1) {
        reply = m;
        break;
      }
    }
    shout.close();
    check('raw client with shouting headers gets 101 and answers (CDP-3)', reply && reply.result.result.value === 'shout');
  } catch (e) {
    check('raw client with shouting headers gets 101 and answers (CDP-3)', false, e.message);
  }

  // NET-STORE-4: the glue's CSPRNG hook.
  const rnd = await hostRpc('eval', { expression: '(() => { const a = new Uint8Array(64), b = new Uint8Array(64); __iwn.crypto.random(a); __iwn.crypto.random(b); return a.some((x) => x) && a.join() !== b.join() ? a.length : 0; })()' });
  check('__iwn.crypto.random fills views from the CSPRNG (NET-STORE-4)', rnd.result === 64, JSON.stringify(rnd));

  // WebSocket Origin policy: web pages refused, DevTools frontend accepted.
  const withOrigin = (origin) => (key) => [...lowerHeaders(DBG)(key), `origin: ${origin}`];
  const evilWs = await rawConnect(DBG, '/host', withOrigin('https://evil.example')).then((c) => (c.close(), 'accepted'), (e) => e.message);
  const devtoolsWs = await rawConnect(DBG, '/host', withOrigin('devtools://devtools')).then((c) => (c.close(), 'accepted'), (e) => e.message);
  check('Origin: https://evil.example -> 403; devtools://devtools -> 101', /403/.test(evilWs) && devtoolsWs === 'accepted', `${evilWs}; ${devtoolsWs}`);

  // LOOP-2 / DBG-7: a 60 ms setInterval(0) plus a 6 ms rAF loop must not starve debug requests.
  await hostRpc('eval', { expression: `
    globalThis.__hogStop = false;
    globalThis.__hog = setInterval(() => { const t = performance.now(); while (performance.now() - t < 60); }, 0);
    (function f() { if (__hogStop) return; const t = performance.now(); while (performance.now() - t < 6); requestAnimationFrame(f); })();
    "started"` });
  const starveTimes = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await hostRpc('eval', { expression: '"answered"' }, 8000).catch((e) => ({ error: e.message }));
    starveTimes.push(r.result === 'answered' ? Date.now() - t0 : -1);
  }
  await hostRpc('eval', { expression: 'clearInterval(__hog); __hogStop = true; "stopped"' }, 8000).catch(() => null);
  check('expensive timers do not starve debug requests (LOOP-2, DBG-7)', starveTimes.every((t) => t >= 0 && t < 2000), `${starveTimes.join(', ')} ms`);

  // PROC-8 / DBG-1: a reload while a request is in flight (pagehide takes 1.5 s), then requests and CDP afterwards.
  const genBefore = (await hostRpc('stats')).contextGeneration;
  await hostRpc('eval', { expression: 'globalThis.onpagehide = () => { const t = Date.now(); while (Date.now() - t < 1500); }; "armed"' });
  await hostRpc('eval', { expression: '__iwn.app.reload(); "reloading"' });
  await sleep(300);
  const during = await hostRpc('eval', { expression: '"during"' }, 8000).catch((e) => ({ error: e.message }));
  await sleep(1500);
  const afterReload = [];
  for (let i = 0; i < 3; i++) afterReload.push(await hostRpc('eval', { expression: '"ok"' }, 5000).catch((e) => ({ error: e.message })));
  const genAfter = (await hostRpc('stats')).contextGeneration;
  let cdpAfter = null;
  try {
    const ws2 = new WebSocket(wsUrl);
    await new Promise((res, rej) => ((ws2.onopen = res), (ws2.onerror = () => rej(new Error('ws error')))));
    cdpAfter = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 5000);
      ws2.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id === 1) (clearTimeout(t), res(msg));
      };
      ws2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }));
    });
    ws2.close();
  } catch (e) {
    cdpAfter = { error: e.message };
  }
  check('reload racing a request: debug endpoint and CDP keep answering (PROC-8, DBG-1)',
    during.result === 'during' && afterReload.every((r) => r.result === 'ok') && genAfter === genBefore + 1 &&
      cdpAfter && cdpAfter.result && cdpAfter.result.result.value === 2,
    `during=${JSON.stringify(during)} after=${JSON.stringify(afterReload)} gen ${genBefore}->${genAfter} cdp=${JSON.stringify(cdpAfter && (cdpAfter.result || cdpAfter.error))}`);
  let helloAgain = {};
  for (let i = 0; i < 20 && !helloAgain.result; i++) {
    helloAgain = await hostRpc('eval', { expression: 'globalThis.__hello' }).catch(() => ({}));
    if (!helloAgain.result) await sleep(250);
  }
  check('hello-js passes again in the reloaded page', helloAgain.result && helloAgain.result.passed === helloAgain.result.total,
    helloAgain.result ? `${helloAgain.result.passed}/${helloAgain.result.total}` : JSON.stringify(helloAgain));

  const passed = results.filter((r) => r.ok).length;
  console.log(`M1-CHECK ${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length}`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ passed, total: results.length, results, stats, info }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('m1-check failed:', e);
  process.exit(1);
});
