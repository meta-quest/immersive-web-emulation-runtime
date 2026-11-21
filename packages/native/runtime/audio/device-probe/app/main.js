// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Audio device probe (HL-4 "audio smoke"): runs on a headset inside the runtime with the web glue and the
// audio prelude, logs one line per check ("AUDIO-PROBE PASS|FAIL ...") and a final
// "AUDIO-PROBE DONE <passed>/<total> <json>" line. Results stay in globalThis.__audioProbe.
import { FIXTURES } from './fixtures.js';
import { LIFECYCLE_MODE, LONG_RUN_SECONDS, ROUTE_TEST_SECONDS } from './config.js';

const results = [];
const out = (s) => console.log(`AUDIO-PROBE ${s}`);
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  out(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ' (' + detail + ')' : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
}
function bytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
const natives = globalThis.__iwn && globalThis.__iwn.audio;
// No DOM stand-in in this probe APK: a minimal document so the core's lifecycle events
// (visibilitychange) reach the audio layer's AUD-2 listener, as they will with the DOM prelude.
if (typeof document === 'undefined') {
  const doc = new EventTarget();
  const core = globalThis.__iwn && globalThis.__iwn.core;
  Object.defineProperty(doc, 'visibilityState', {
    get: () => (core && core.lifecycleState ? core.lifecycleState().visibilityState : 'visible'),
  });
  globalThis.document = doc;
}

// --route-test <seconds>: AUD-12 only. Plays a tone and logs currentTime, xruns and latency every
// 250 ms while a harness disconnects the stream (e.g. restarts audioserver); then checks that time
// kept advancing at the context rate after the disconnect.
if (ROUTE_TEST_SECONDS > 0) {
  const rc = new AudioContext();
  await waitFor(() => rc.state === 'running', 3000);
  const osc = rc.createOscillator();
  const g = new GainNode(rc, { gain: 0.02 });
  osc.connect(g).connect(rc.destination);
  osc.start();
  const w0 = performance.now();
  const samples = [];
  while (performance.now() - w0 < ROUTE_TEST_SECONDS * 1000) {
    const st = natives.stats();
    const s = { wall: (performance.now() - w0) / 1000, ct: rc.currentTime, base: rc.baseLatency, out: rc.outputLatency, xruns: st.xruns };
    samples.push(s);
    out(`ROUTE wall=${s.wall.toFixed(2)} ct=${s.ct.toFixed(3)} base=${(s.base * 1000).toFixed(1)}ms out=${(s.out * 1000).toFixed(1)}ms state=${rc.state} sr=${rc.sampleRate}`);
    await sleep(250);
  }
  // The last 5 s must advance at ~1.0 s per second (the stream was reopened at 48 kHz).
  const tail = samples.filter((s) => s.wall >= ROUTE_TEST_SECONDS - 5);
  const rate = (tail.at(-1).ct - tail[0].ct) / (tail.at(-1).wall - tail[0].wall);
  check('route change / disconnect: audio resumes at the context rate (AUD-12)', Math.abs(rate - 1) < 0.03 && rc.state === 'running',
    `currentTime rate over the last 5 s ${rate.toFixed(3)}, state ${rc.state}`);
  await rc.close();
  out(`DONE ${results.filter((r) => r.ok).length}/${results.length}`);
  await new Promise(() => {});
}

// --lifecycle relaunch|reloadbusy: PROC-7 / PROC-8 checks driven by a harness that counts the
// "AUDIO-PROBE LIFECYCLE" lines in logcat.
//   relaunch: one decode + one-shot + resume per launch, then __iwn.app.close(); the harness
//     relaunches the activity (same cached process) and expects the next launch to pass too.
//   reloadbusy: the same checks, then from a timer task a decode, a short one-shot, 15 ms of busy
//     JS and __iwn.app.reload() in the same task (completions race the reload); every page must pass.
if (LIFECYCLE_MODE) {
  const t0 = performance.now();
  const timeout = (p, ms) => Promise.race([p.then(() => 'ok', (e) => `error:${e && e.name}`), sleep(ms).then(() => 'TIMEOUT')]);
  const wav = FIXTURES['wav-48000-stereo-f32.wav'];
  const lc = new AudioContext();
  const resumed = await timeout(lc.resume(), 3000);
  const decoded = await timeout(lc.decodeAudioData(bytes(wav)), 3000);
  const shot = lc.createBufferSource();
  shot.buffer = lc.createBuffer(1, 64, lc.sampleRate);
  shot.connect(lc.destination);
  const ended = timeout(new Promise((r) => (shot.onended = r)), 3000);
  shot.start();
  const endedR = await ended;
  out(`LIFECYCLE ${LIFECYCLE_MODE} decode=${decoded} ended=${endedR} resume=${resumed} ms=${(performance.now() - t0).toFixed(0)}`);
  if (LIFECYCLE_MODE === 'relaunch') {
    setTimeout(() => globalThis.__iwn.app.close(), 200);
  } else {
    setTimeout(() => {
      lc.decodeAudioData(bytes(wav)).catch(() => {});
      const s = lc.createBufferSource();
      s.buffer = lc.createBuffer(1, 64, lc.sampleRate);
      s.connect(lc.destination);
      s.start();
      const end = performance.now() + 15;
      while (performance.now() < end) {
        // busy: the decode and the one-shot complete while this task runs
      }
      globalThis.__iwn.app.reload();
    }, 50);
  }
  await new Promise(() => {});
}

try {
  check('Web Audio globals installed', typeof AudioContext === 'function' && typeof OfflineAudioContext === 'function' && typeof webkitAudioContext === 'function');

  // --- AUD-1: context runs without a gesture; currentTime follows rendered audio --------------------------------------
  const ctx = new AudioContext();
  const states = [];
  ctx.onstatechange = () => states.push(ctx.state);
  await waitFor(() => ctx.state === 'running', 3000);
  check('context running without a gesture (AUD-1)', ctx.state === 'running', `${ctx.state}, ${ctx.sampleRate} Hz`);
  check('device sample rate 48 kHz', ctx.sampleRate === 48000, ctx.sampleRate);
  const lat = (ctx.baseLatency + ctx.outputLatency) * 1000;
  check('latency baseLatency + outputLatency <= 40 ms (AUD-13)', lat > 0 && lat <= 40, `${(ctx.baseLatency * 1000).toFixed(1)} + ${(ctx.outputLatency * 1000).toFixed(1)} ms`);
  const t0 = ctx.currentTime;
  const w0 = performance.now();
  await sleep(2000);
  const adv = ctx.currentTime - t0;
  const wall = (performance.now() - w0) / 1000;
  check('currentTime advances ~1.0 per second (AUD-1)', Math.abs(adv / wall - 1) < 0.02, `${adv.toFixed(3)} s in ${wall.toFixed(3)} s`);
  const ts = ctx.getOutputTimestamp();
  check('getOutputTimestamp', ts.contextTime > 0 && ts.contextTime <= ctx.currentTime + 1e-6 && Math.abs(ts.performanceTime - performance.now()) < 200,
    `${ts.contextTime.toFixed(3)} @ ${ts.performanceTime.toFixed(1)} (now ${performance.now().toFixed(1)})`);

  // --- AUD-8: decode every fixture (MP3/Vorbis/WAV ours; AAC, FLAC, Opus through MediaCodec) ---------------------------
  for (const [name, b64] of Object.entries(FIXTURES)) {
    const expectOk = !name.startsWith('html-') && !name.startsWith('garbage');
    try {
      const t = performance.now();
      const buf = await ctx.decodeAudioData(bytes(b64));
      let peak = 0;
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      const dur = name.startsWith('wav') ? 0.25 : 1;
      // ffmpeg's AAC encoder overshoots at the start (reference decode peaks at 0.756 too).
      check(`decode ${name} (AUD-8)`, expectOk && buf.sampleRate === 48000 && Math.abs(buf.duration - dur) < 0.03 && peak > 0.4 && peak < 0.8,
        `${buf.numberOfChannels} ch, ${buf.duration.toFixed(3)} s, peak ${peak.toFixed(3)}, ${(performance.now() - t).toFixed(1)} ms`);
    } catch (e) {
      check(`decode ${name} (AUD-8)`, !expectOk && e.name === 'EncodingError', `${e.name}: ${e.message}`);
    }
  }

  // --- AUD-3 / AUD-5: offline render matches the formulas ----------------------------------------------------------------
  {
    const off = new OfflineAudioContext(1, 4800, 48000);
    const osc = new OscillatorNode(off, { frequency: 1000 });
    const g = new GainNode(off, { gain: 0 });
    g.gain.linearRampToValueAtTime(1, 0.1);
    osc.connect(g).connect(off.destination);
    osc.start();
    const t = performance.now();
    const r = await off.startRendering();
    const d = r.getChannelData(0);
    let err = 0;
    for (let n = 0; n < 4800; n++) err = Math.max(err, Math.abs(d[n] - Math.sin((2 * Math.PI * 1000 * n) / 48000) * (n / 4800)));
    check('offline render matches formula (AUD-3, AUD-5)', err < 1e-4, `max err ${err.toExponential(2)}, ${(performance.now() - t).toFixed(1)} ms`);
  }

  // --- AUD-6: ended fires once; a source plays audibly through a moving panner ------------------------------------------
  {
    const b = ctx.createBuffer(1, 2400, 48000);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    let ended = 0;
    s.onended = () => ended++;
    s.start();
    await waitFor(() => ended > 0, 2000);
    await sleep(100);
    check('onended fires once (AUD-6)', ended === 1, ended);
  }

  // --- AUD-10 / AUD-11 / PERF-AUDIO-1: load with GC pressure, xruns, render load, main-thread cost ----------------------
  {
    const before = natives.stats();
    const tone = ctx.createBuffer(1, 48000, 48000);
    const td = tone.getChannelData(0);
    for (let i = 0; i < td.length; i++) td[i] = 0.02 * Math.sin((2 * Math.PI * 330 * i) / 48000);
    const voices = [];
    for (let i = 0; i < 24; i++) {
      const s = ctx.createBufferSource();
      s.buffer = tone;
      s.loop = true;
      const p = new PannerNode(ctx, { panningModel: i % 2 ? 'HRTF' : 'equalpower', positionX: Math.cos(i), positionZ: Math.sin(i) });
      s.connect(p).connect(ctx.destination);
      s.start();
      voices.push({ s, p });
    }
    let writes = 0;
    let writeMs = 0;
    const end = performance.now() + 10000;
    let junk = [];
    while (performance.now() < end) {
      // Allocation churn forces GCs on the main thread while audio renders.
      for (let k = 0; k < 2000; k++) junk.push({ a: new Float64Array(16), k });
      if (junk.length > 200000) junk = [];
      const t = performance.now();
      for (const v of voices) v.p.positionX.value = Math.cos(t / 1000 + writes);
      writeMs += performance.now() - t;
      writes += voices.length;
      await sleep(5);
    }
    // Drop the churn heap (up to 200k live objects): it is this check's load, not audio's, and
    // would otherwise make every GC in the AUD-11 timing below expensive.
    junk = null;
    const after = natives.stats();
    check('no xruns under GC pressure, 10 s, 24 voices (AUD-10 smoke)', after.xruns === before.xruns, `${after.xruns - before.xruns} xruns`);
    check('render callback load <= 25 % (PERF-AUDIO-1)', after.renderLoad <= 0.25, `${(after.renderLoad * 100).toFixed(1)} %`);
    check('param write < 5 us (AUD-11)', (writeMs * 1000) / writes < 5, `${((writeMs * 1000) / writes).toFixed(2)} us over ${writes} writes`);
    for (const v of voices) v.s.stop();
    const runs = [];
    await sleep(500);
    // Each rep runs inside a simulated 72 Hz app frame: ~4 ms of other main-thread work, then the
    // 100 voices (AUD-11: "in one frame"). An idle 50 ms gap before each rep (the "idle" figure)
    // lets the CPU governor drop the clock first, which an XR app's frame loop never does.
    const idleRuns = [];
    for (let rep = 0; rep < 21; rep++) {
      await sleep(50);
      const t = performance.now();
      for (let i = 0; i < 100; i++) {
        const s = ctx.createBufferSource();
        s.buffer = tone;
        s.connect(voices[0].p);
        s.start();
        s.stop(ctx.currentTime + 0.01);
      }
      await Promise.resolve();
      idleRuns.push(performance.now() - t);
    }
    let sink = 0;
    for (let rep = 0; rep < 21; rep++) {
      await sleep(10);
      const busyEnd = performance.now() + 4;
      while (performance.now() < busyEnd) sink += Math.sqrt(sink + 1);
      const t = performance.now();
      for (let i = 0; i < 100; i++) {
        const s = ctx.createBufferSource();
        s.buffer = tone;
        s.connect(voices[0].p);
        s.start();
        s.stop(ctx.currentTime + 0.01);
      }
      const js = performance.now() - t;
      await Promise.resolve();  // the batch is submitted (and prepared natively) from a microtask
      runs.push([js, performance.now() - t]);
    }
    const best = runs.reduce((a, r) => (r[1] < a[1] ? r : a));
    const median = runs.map((r) => r[1]).sort((a, b) => a - b)[10];
    const medJs = runs.map((r) => r[0]).sort((a, b) => a - b)[10];
    const medSub = runs.map((r) => r[1] - r[0]).sort((a, b) => a - b)[10];
    const medIdle = idleRuns.sort((a, b) => a - b)[10];
    check('100 one-shot voices in one app frame < 1 ms main thread incl. submit (AUD-11)', median < 1,
      `median ${median.toFixed(3)} ms (JS ${medJs.toFixed(3)}, submit ${medSub.toFixed(3)}); after an idle gap ${medIdle.toFixed(3)} ms; sink ${sink > 0 ? 1 : 0}; best ${best[0].toFixed(3)} JS + ${(best[1] - best[0]).toFixed(3)} submit; first ${runs[0][1].toFixed(2)}`);
  }

  // --- PERF-AUDIO-1 with three.js-style automation: every listener and panner param ramped each 72 Hz frame ----------
  const threeFrame = (c, voices, f) => {
    const t = c.currentTime;
    const end = t + 1 / 72;
    const l = c.listener;
    l.positionX.linearRampToValueAtTime(0.1 * Math.sin(f * 0.01), end);
    l.positionY.linearRampToValueAtTime(1.6, end);
    l.positionZ.linearRampToValueAtTime(0.1 * Math.cos(f * 0.01), end);
    l.forwardX.linearRampToValueAtTime(Math.sin(f * 0.005), end);
    l.forwardY.linearRampToValueAtTime(0, end);
    l.forwardZ.linearRampToValueAtTime(-Math.cos(f * 0.005), end);
    l.upX.linearRampToValueAtTime(0, end);
    l.upY.linearRampToValueAtTime(1, end);
    l.upZ.linearRampToValueAtTime(0, end);
    for (let i = 0; i < voices.length; i++) {
      const p = voices[i].p;
      p.positionX.linearRampToValueAtTime(2 * Math.cos(i + f * 0.02), end);
      p.positionY.linearRampToValueAtTime(1.5, end);
      p.positionZ.linearRampToValueAtTime(2 * Math.sin(i + f * 0.02), end);
      p.orientationX.linearRampToValueAtTime(1, end);
      p.orientationY.linearRampToValueAtTime(0, end);
      p.orientationZ.linearRampToValueAtTime(0, end);
    }
  };
  const makeVoices = (c, model, n) => {
    const tone = c.createBuffer(1, 48000, 48000);
    const td = tone.getChannelData(0);
    for (let i = 0; i < td.length; i++) td[i] = 0.01 * Math.sin((2 * Math.PI * 330 * i) / 48000);
    const voices = [];
    for (let i = 0; i < n; i++) {
      const s = c.createBufferSource();
      s.buffer = tone;
      s.loop = true;
      const p = new PannerNode(c, { panningModel: typeof model === 'string' ? model : model(i) });
      s.connect(p).connect(c.destination);
      s.start();
      voices.push({ s, p });
    }
    return voices;
  };
  const ramped = async (c, voices, ms, gcChurn) => {
    let f = 0;
    const end = performance.now() + ms;
    let junk = [];
    while (performance.now() < end) {
      threeFrame(c, voices, f++);
      if (gcChurn) {
        for (let k = 0; k < 2000; k++) junk.push({ a: new Float64Array(16), k });
        if (junk.length > 200000) junk = [];
      }
      await sleep(14);
    }
    return f;
  };
  for (const model of ['equalpower', 'HRTF']) {
    const before = natives.stats();
    const voices = makeVoices(ctx, model, 24);
    await ramped(ctx, voices, 3000, false);  // settle the smoothed load
    let peak = 0;
    const end = performance.now() + 8000;
    let f = 100000;
    while (performance.now() < end) {
      threeFrame(ctx, voices, f++);
      const load = natives.stats().renderLoad;
      peak = Math.max(peak, load);
      if (f % 36 === 0) out(`LOAD ${model} t=${(8 - (end - performance.now()) / 1000).toFixed(1)}s ${(load * 100).toFixed(1)} %`);
      await sleep(14);
    }
    const after = natives.stats();
    for (const v of voices) v.s.stop();
    check(`render load <= 25 % with three.js-style ramps, 24 ${model} voices (PERF-AUDIO-1)`, after.renderLoad <= 0.25 && after.xruns === before.xruns,
      `${(after.renderLoad * 100).toFixed(1)} % (peak smoothed ${(peak * 100).toFixed(1)} %), ${after.xruns - before.xruns} xruns`);
    check(`no render-thread allocation, ${model} ramps (AUD-10)`, (after.rtAllocations ?? 0) === (before.rtAllocations ?? 0),
      `${(after.rtAllocations ?? 0) - (before.rtAllocations ?? 0)} growths`);
    await sleep(300);
  }

  // --- a suspended context fed per-frame ramps stays bounded (timeline cap) -----------------------------------------------
  {
    // Stats report the highest load over contexts: hold the main context so this one is measured.
    await ctx.suspend();
    const sctx = new AudioContext();
    await waitFor(() => sctx.state === 'running', 3000);
    const voices = makeVoices(sctx, 'HRTF', 4);
    await sctx.suspend();
    const merged0 = natives.stats().paramEventsMerged ?? 0;
    await ramped(sctx, voices, 5000, false);
    const early = natives.stats().renderLoad;
    await ramped(sctx, voices, 25000, false);
    const late = natives.stats().renderLoad;
    const merged = (natives.stats().paramEventsMerged ?? 0) - merged0;
    check('suspended context with per-frame ramps: load stays flat, timelines capped', late < 0.02 && late < early + 0.01 && merged > 0,
      `load ${(early * 100).toFixed(2)} % at 5 s, ${(late * 100).toFixed(2)} % at 30 s; ${merged} events merged`);
    await sctx.close();
    await ctx.resume();
  }

  // --- AUD-2 host pause: state requests are answered while output is paused, currentTime holds -----------------------------
  {
    const pctx = new AudioContext();
    await waitFor(() => pctx.state === 'running', 3000);
    natives.setOutputPaused(4, true);
    await sleep(100);
    const c0 = pctx.currentTime;
    for (let f = 0; f < 300; f++) threeFrame(pctx, [], f);
    await sleep(500);
    const held = pctx.currentTime - c0;
    const closed = await Promise.race([pctx.close().then(() => true), sleep(2000).then(() => false)]);
    natives.setOutputPaused(4, false);
    check('paused output: currentTime holds, close() resolves (AUD-2)', held < 0.005 && closed && pctx.state === 'closed',
      `advanced ${held.toFixed(4)} s while paused, close ${closed ? 'resolved' : 'timed out'}`);
  }

  // --- optional long run (AUD-10): 24 voices, half HRTF, three.js ramps, GC churn ------------------------------------------
  if (LONG_RUN_SECONDS > 0) {
    const before = natives.stats();
    const voices = makeVoices(ctx, (i) => (i % 2 ? 'HRTF' : 'equalpower'), 24);
    const t0 = performance.now();
    let frames = 0;
    for (let m = 0; m < LONG_RUN_SECONDS / 60; m++) {
      frames += await ramped(ctx, voices, 60000, true);
      const st = natives.stats();
      out(`LONG minute=${m + 1} xruns=${st.xruns - before.xruns} load=${(st.renderLoad * 100).toFixed(1)}% rtAllocations=${(st.rtAllocations ?? 0) - (before.rtAllocations ?? 0)}`);
    }
    const after = natives.stats();
    for (const v of voices) v.s.stop();
    check(`no xruns over ${LONG_RUN_SECONDS} s with three.js ramps and GC churn (AUD-10)`, after.xruns === before.xruns,
      `${after.xruns - before.xruns} xruns, ${frames} frames, ${((performance.now() - t0) / 1000).toFixed(0)} s, load ${(after.renderLoad * 100).toFixed(1)} %`);
  }

  // --- suspend / resume / close ----------------------------------------------------------------------------------------
  await ctx.suspend();
  const ts0 = ctx.currentTime;
  await sleep(300);
  check('suspend stops currentTime', ctx.state === 'suspended' && ctx.currentTime - ts0 < 0.01, `${(ctx.currentTime - ts0).toFixed(4)}`);
  await ctx.resume();
  await sleep(300);
  check('resume continues', ctx.state === 'running' && ctx.currentTime - ts0 > 0.2);
  await ctx.close();
  // (The suspended-context check above suspends and resumes this context once more.)
  check('close', ctx.state === 'closed' && states.join(',') === 'running,suspended,running,suspended,running,closed', states.join(','));
  const st = natives.stats();
  // Every context of this probe is closed or finished rendering: their native side is released at
  // once, without waiting for GC.
  check('stats: closed and finished contexts released', st.realtimeContexts === 0 && st.offlineContexts === 0 && st.liveNodes === 0,
    JSON.stringify(st));
} catch (e) {
  check('probe threw', false, `${e && e.name}: ${e && e.message}\n${e && e.stack}`);
}

// AUD-2 observation window: a heartbeat of (wall, currentTime, state, visibility) every 500 ms for
// 20 s, so a harness can pause/hide the app meanwhile and read whether time stopped and resumed.
{
  const hb = new AudioContext();
  const osc = hb.createOscillator();
  const g = new GainNode(hb, { gain: 0.02 });
  osc.connect(g).connect(hb.destination);
  osc.start();
  let changes = 0;
  hb.onstatechange = () => changes++;
  await sleep(300);
  const w0 = performance.now();
  for (let i = 0; i < 60; i++) {
    const vis = typeof document !== 'undefined' && document ? document.visibilityState : 'n/a';
    out(`HB wall=${((performance.now() - w0) / 1000).toFixed(2)} ct=${hb.currentTime.toFixed(3)} state=${hb.state} vis=${vis} statechanges=${changes} paused=${natives.stats().pausedReasons}`);
    await sleep(500);
  }
  await hb.close();
}

// Repeat the results at the end (the logcat ring may have dropped the early lines).
for (const r of results) out(`SUMMARY ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail !== '' ? ' (' + r.detail + ')' : ''}`);
const passed = results.filter((r) => r.ok).length;
globalThis.__audioProbe = { passed, total: results.length, results };
out(`DONE ${passed}/${results.length}`);
