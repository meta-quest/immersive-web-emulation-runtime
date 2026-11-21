// Classic worker: echoes messages (structured clone round trip) and reports its global (WRK-2).
const present = ['postMessage', 'onmessage', 'onmessageerror', 'addEventListener', 'close', 'name', 'location', 'navigator',
  'setTimeout', 'setInterval', 'clearTimeout', 'queueMicrotask', 'fetch', 'URL', 'Blob', 'File', 'FileReader',
  'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'crypto', 'console', 'performance', 'WebAssembly', 'structuredClone',
  'AbortController', 'DOMException', 'ImageData', 'createImageBitmap', 'OffscreenCanvas', 'MessageChannel', 'importScripts',
  'Worker', 'self', 'XMLHttpRequest', 'Request', 'Response', 'Headers', 'EventTarget', 'Event', 'MessageEvent', 'reportError'];
const absent = ['document', 'window', 'WebGLRenderingContext', 'AudioContext', 'localStorage', 'HTMLImageElement', 'requestIdleCallback'];
onmessage = (e) => {
  if (e.data === 'report') {
    postMessage({
      missing: present.filter((n) => typeof self[n] === 'undefined'),
      unexpected: absent.filter((n) => typeof self[n] !== 'undefined'),
      name: self.name, href: location.href, locTag: Object.prototype.toString.call(location),
      nav: [typeof navigator.userAgent, navigator.hardwareConcurrency, typeof navigator.language, navigator.onLine],
      coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, wgs: self instanceof WorkerGlobalScope,
      random: crypto.getRandomValues(new Uint8Array(4)).length,
    });
    return;
  }
  if (e.data && e.data.cmd === 'echo-transfer') {
    postMessage(e.data.payload, [e.data.payload]);
    return;
  }
  postMessage(e.data);
};
