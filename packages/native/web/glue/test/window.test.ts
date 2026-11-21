/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// DOM-1 (aliases), DOM-3 (matchMedia, devicePixelRatio, history), DOM-4 (navigator), DOM-5 (location),
// DOM-12 (globals present), JS-6 (Intl from V8), install modes and the glue registry.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { createGlueContext, fakeNatives, glueScript } from './harness.ts';

describe('globals (DOM-1, DOM-12)', () => {
  test('typeof listing for every glue global', async () => {
    const { run } = await createGlueContext();
    const listing = run<Record<string, string>>(`
      const names = ['window', 'self', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'EventTarget', 'Event',
        'CustomEvent', 'ErrorEvent', 'PromiseRejectionEvent', 'MessageEvent', 'ProgressEvent', 'PopStateEvent', 'HashChangeEvent',
        'AbortController', 'AbortSignal', 'DOMException', 'Blob', 'File', 'FileReader', 'crypto', 'Crypto', 'SubtleCrypto', 'performance',
        'Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure', 'queueMicrotask', 'reportError', 'atob', 'btoa',
        'navigator', 'Navigator', 'matchMedia', 'MediaQueryList', 'devicePixelRatio', 'location', 'Location', 'history', 'History',
        'origin', 'isSecureContext', 'crossOriginIsolated', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'onerror',
        'onunhandledrejection', 'Intl',
        // Deliberately absent here (owned by other streams or not offered): fetch, setTimeout, document, indexedDB, caches, Worker.
        'fetch', 'document', 'indexedDB', 'caches', 'Worker'];
      Object.fromEntries(names.map((n) => [n, typeof globalThis[n]]));
    `);
    assert.deepEqual({ ...listing }, {
      window: 'object', self: 'object', URL: 'function', URLSearchParams: 'function', TextEncoder: 'function', TextDecoder: 'function',
      structuredClone: 'function', EventTarget: 'function', Event: 'function', CustomEvent: 'function', ErrorEvent: 'function',
      PromiseRejectionEvent: 'function', MessageEvent: 'function', ProgressEvent: 'function', PopStateEvent: 'function',
      HashChangeEvent: 'function', AbortController: 'function', AbortSignal: 'function', DOMException: 'function', Blob: 'function',
      File: 'function', FileReader: 'function', crypto: 'object', Crypto: 'function', SubtleCrypto: 'undefined', performance: 'object',
      Performance: 'function', PerformanceEntry: 'function', PerformanceMark: 'function', PerformanceMeasure: 'function',
      queueMicrotask: 'function', reportError: 'function', atob: 'function', btoa: 'function', navigator: 'object',
      Navigator: 'function', matchMedia: 'function', MediaQueryList: 'function', devicePixelRatio: 'number', location: 'object',
      Location: 'function', history: 'object', History: 'function', origin: 'string', isSecureContext: 'boolean',
      crossOriginIsolated: 'boolean', addEventListener: 'function', removeEventListener: 'function', dispatchEvent: 'function',
      onerror: 'object', onunhandledrejection: 'object', Intl: 'object',
      fetch: 'undefined', document: 'undefined', indexedDB: 'undefined', caches: 'undefined', Worker: 'undefined',
    });
    assert.deepEqual(
      Array.from(run<unknown[]>(`[window === globalThis, self === globalThis, isSecureContext, crossOriginIsolated, origin, devicePixelRatio]`)),
      [true, true, true, false, 'https://app.local', 1],
    );
  });

  test('WebIDL shape: interface names, toStringTag, illegal constructors, non-enumerable globals', async () => {
    const { run } = await createGlueContext();
    const out = run<unknown[]>(`
      const out = [];
      for (const n of ['Blob', 'File', 'URL', 'TextDecoder', 'EventTarget', 'AbortSignal', 'DOMException', 'Performance', 'Navigator']) {
        out.push(globalThis[n].name === n);
      }
      for (const C of [AbortSignal, Crypto, Performance, Navigator, Location, History, MediaQueryList, PerformanceEntry]) {
        try { new C(); out.push('constructed'); } catch (e) { out.push(e.name); }
      }
      out.push(Object.keys(globalThis).includes('Blob'), Object.getOwnPropertyDescriptor(globalThis, 'Blob').writable);
      out.push(Object.prototype.toString.call(navigator), Object.prototype.toString.call(location), Object.prototype.toString.call(history));
      out;
    `);
    assert.deepEqual(Array.from(out), [
      true, true, true, true, true, true, true, true, true,
      'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError',
      false, true, '[object Navigator]', '[object Location]', '[object History]',
    ]);
  });

  test("mode 'missing' keeps engine globals; mode 'all' replaces them", async () => {
    const script = await glueScript();
    const sentinel = function URL() {};
    const ctx = vm.createContext({ URL: sentinel, __iwn: fakeNatives().natives });
    script.runInContext(ctx);
    assert.equal(vm.runInContext('URL', ctx), sentinel);
    assert.equal(vm.runInContext(`globalThis[Symbol.for('iwn.glue')].installed.includes('URL')`, ctx), false);
    assert.equal(vm.runInContext(`typeof URL.createObjectURL`, ctx), 'function', 'blob URL statics are still added');
  });

  test('Intl from V8 passes the JS-6 check (Segmenter grapheme/word incl. CJK and emoji)', async () => {
    const { run } = await createGlueContext();
    const report = run<{ ok: boolean; problems: string[]; constructors: Record<string, boolean> }>(
      `globalThis[Symbol.for('iwn.glue')].verifyIntl()`,
    );
    assert.deepEqual(Array.from(report.problems), []);
    assert.equal(report.ok, true);
    assert.equal(report.constructors.Segmenter, true);
  });
});

describe('navigator (DOM-4)', () => {
  test('fields from device info; absent members stay absent', async () => {
    const { run } = await createGlueContext({ config: { runtimeVersion: '0.1.0' } });
    const out = run<Record<string, unknown>>(`({
      userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language,
      languages: [...navigator.languages], frozen: Object.isFrozen(navigator.languages), onLine: navigator.onLine,
      hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory, maxTouchPoints: navigator.maxTouchPoints,
      vendor: navigator.vendor, appVersion: navigator.appVersion, cookieEnabled: navigator.cookieEnabled, webdriver: navigator.webdriver,
      vibrate: navigator.vibrate([10]), sendBeacon: navigator.sendBeacon('/x'),
      absent: ['userAgentData', 'mediaDevices', 'gpu', 'serviceWorker', 'clipboard', 'wakeLock', 'share', 'mediaCapabilities', 'xr', 'getGamepads']
        .filter((k) => k in navigator),
      extensible: Object.isExtensible(navigator),
    })`);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) VR Safari/537.36 IWERNative/0.1.0',
      platform: 'Linux armv8l',
      language: 'en-US',
      languages: ['en-US', 'de-DE'],
      frozen: true,
      onLine: true,
      hardwareConcurrency: 4,
      deviceMemory: 8, // 7.5 GiB rounds to the nearest power of two (Device Memory spec, Quest Browser)
      maxTouchPoints: 0,
      vendor: '',
      appVersion: '5.0 (Linux; Android 14; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) VR Safari/537.36 IWERNative/0.1.0',
      cookieEnabled: false,
      webdriver: false,
      vibrate: false,
      sendBeacon: false,
      absent: [],
      extensible: true,
    });
  });

  test('user agent policies, and three.js Safari sniff stays false', async () => {
    const ua = async (userAgent: unknown): Promise<string> =>
      (await createGlueContext({ config: { userAgent, runtimeVersion: '1.2.3' } })).run<string>('navigator.userAgent');
    const honest = await ua('honest');
    const quest = await ua('quest-browser');
    assert.match(honest, /Android 14/);
    assert.match(honest, /IWERNative\/1\.2\.3$/);
    assert.doesNotMatch(honest, /OculusBrowser|Chrome\//);
    assert.match(quest, /OculusBrowser\/[\d.]+ Chrome\/[\d.]+ VR Safari\/537\.36 IWERNative\/1\.2\.3$/);
    assert.equal(await ua({ literal: 'Custom/1' }), 'Custom/1');
    for (const s of [honest, quest]) assert.equal(/^((?!chrome|android).)*safari/i.test(s), false);
  });

  test('permissions.query and storage.estimate', async () => {
    const { run } = await createGlueContext();
    const r = await run<Promise<unknown[]>>(`(async () => {
      const s = await navigator.permissions.query({ name: 'geolocation' });
      const err = await navigator.permissions.query({}).catch((e) => e.name);
      const est = await navigator.storage.estimate();
      return [s.name, s.state, s instanceof EventTarget, err, est.quota > 0, est.usage, 'persist' in navigator.storage];
    })()`);
    assert.deepEqual(Array.from(r), ['geolocation', 'prompt', true, 'TypeError', true, 0, false]);
  });
});

describe('matchMedia (DOM-3)', () => {
  test('evaluates width/height/orientation/preferences against the fixed window', async () => {
    const { run } = await createGlueContext({ config: { viewport: { width: 1280, height: 720 } } });
    const cases: [string, boolean, string?][] = [
      ['(min-width: 1000px)', true],
      ['(max-width: 1000px)', false],
      ['(width: 1280px)', true],
      ['(min-width: 80em)', true],
      ['(max-height: 719px)', false],
      ['(orientation: landscape)', true],
      ['(orientation: portrait)', false],
      ['(prefers-color-scheme: dark)', true],
      ['(prefers-color-scheme: light)', false],
      ['(prefers-reduced-motion: reduce)', false],
      ['(prefers-reduced-motion: no-preference)', true],
      ['(prefers-reduced-motion)', false],
      ['(pointer: fine)', true],
      ['(pointer: coarse)', false],
      ['(hover: hover)', true],
      ['(any-pointer: coarse)', false],
      ['screen and (min-width: 600px)', true],
      ['print', false],
      ['not print', true],
      ['only screen and (max-width: 600px)', false],
      ['(min-width: 600px) and (max-width: 1300px)', true],
      ['(max-width: 600px), (orientation: landscape)', true],
      ['(min-resolution: 2dppx)', false],
      ['(-webkit-min-device-pixel-ratio: 1)', true],
      ['(min-aspect-ratio: 16/9)', true],
      ['(unknown-feature: 1)', false],
      ['all', true],
      ['', true],
      ['garbage(((', false, 'not all'],
      ['(MIN-WIDTH:100PX)', true, '(min-width: 100px)'],
    ];
    for (const [q, want, media] of cases) {
      const r = run<{ matches: boolean; media: string }>(`(() => { const m = matchMedia(${JSON.stringify(q)}); return { matches: m.matches, media: m.media }; })()`);
      assert.equal(r.matches, want, q);
      if (media !== undefined) assert.equal(r.media, media, q);
    }
    const ok = run<boolean>(`
      const m = matchMedia('(prefers-color-scheme: dark)');
      let n = 0; m.addListener(() => n++); m.addEventListener('change', () => n++); m.onchange = () => n++;
      m instanceof EventTarget && n === 0 && typeof MediaQueryList === 'function';
    `);
    assert.equal(ok, true);
  });

  test('uses innerWidth/innerHeight when the DOM glue defines them', async () => {
    const { run } = await createGlueContext({ preset: { innerWidth: 500, innerHeight: 900 } });
    assert.equal(run(`matchMedia('(orientation: portrait)').matches && matchMedia('(max-width: 500px)').matches`), true);
  });
});

describe('location and history (DOM-5, DOM-3)', () => {
  test('location reflects the configured app URL (pack with ?a=1)', async () => {
    const { run } = await createGlueContext({ config: { url: 'https://app.local/?a=1' } });
    const r = run<Record<string, string>>(`({ href: location.href, origin: location.origin, protocol: location.protocol, host: location.host,
      hostname: location.hostname, port: location.port, pathname: location.pathname, search: location.search, hash: location.hash,
      str: String(location), resolved: new URL('x/y.png', location.href).href, json: JSON.stringify({ l: location.search }) })`);
    assert.deepEqual({ ...r }, {
      href: 'https://app.local/?a=1', origin: 'https://app.local', protocol: 'https:', host: 'app.local', hostname: 'app.local',
      port: '', pathname: '/', search: '?a=1', hash: '', str: 'https://app.local/?a=1', resolved: 'https://app.local/x/y.png',
      json: '{"l":"?a=1"}',
    });
  });

  test('hash navigation fires hashchange; cross-origin is ignored; other documents reload', async () => {
    const { natives, calls } = fakeNatives();
    const warnings: string[] = [];
    const { run, g } = await createGlueContext({ natives });
    (g as Record<string, unknown>).console = { warn: (m: string) => warnings.push(m) };
    const log = await run<Promise<string[]>>(`(async () => {
      const log = [];
      addEventListener('hashchange', (e) => log.push('hashchange ' + e.oldURL + ' -> ' + e.newURL + ' ' + e.isTrusted));
      location.hash = 'one';
      log.push(location.href, String(history.length));
      await new Promise((r) => setTimeout(r, 5));
      location.assign('#two');
      location.replace('#three');
      log.push(String(history.length));
      await new Promise((r) => setTimeout(r, 5));
      location.href = 'https://evil.example/';
      log.push(location.href);
      location.assign('/other.html?x=1');
      location.reload();
      return log;
    })()`);
    assert.deepEqual(Array.from(log), [
      'https://app.local/#one', '2',
      'hashchange https://app.local/ -> https://app.local/#one true',
      '3',
      'hashchange https://app.local/#one -> https://app.local/#two true',
      'hashchange https://app.local/#two -> https://app.local/#three true',
      'https://app.local/#three',
    ]);
    // Another document goes to app.navigate(url); location.reload() to app.reload(url) with the current URL.
    assert.deepEqual(calls.navigate, ['https://app.local/other.html?x=1']);
    assert.deepEqual(calls.reload, ['https://app.local/#three']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /evil\.example/);
  });

  test('pushState / replaceState / back / forward / go with popstate', async () => {
    const { run } = await createGlueContext({ config: { url: 'https://app.local/start' } });
    const log = await run<Promise<unknown[]>>(`(async () => {
      const log = [];
      const tick = () => new Promise((r) => setTimeout(r, 5));
      onpopstate = (e) => log.push(['popstate', JSON.stringify(e.state), location.pathname + location.search]);
      const state = { n: 1 };
      history.pushState(state, '', '/a?x=1');
      log.push(location.href, history.length, history.state !== state, history.state.n);
      history.replaceState({ n: 2 }, '');
      history.pushState(null, '', 'b');
      log.push(location.pathname, history.length);
      history.back(); await tick();
      history.back(); await tick();
      history.forward(); await tick();
      history.go(5); await tick();
      try { history.pushState(null, '', 'https://other.example/'); } catch (e) { log.push(e.name); }
      try { history.pushState(() => 1, ''); } catch (e) { log.push(e.name); }
      history.scrollRestoration = 'manual'; history.scrollRestoration = 'bogus';
      log.push(history.scrollRestoration);
      return log;
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(log)), [
      'https://app.local/a?x=1', 2, true, 1,
      '/b', 3,
      ['popstate', '{"n":2}', '/a?x=1'],
      ['popstate', 'null', '/start'],
      ['popstate', '{"n":2}', '/a?x=1'],
      'SecurityError', 'DataCloneError', 'manual',
    ]);
  });
});
