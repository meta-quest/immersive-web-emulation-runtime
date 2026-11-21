// SharedArrayBuffer + Atomics across threads: wait in the worker, notify from the page and back.
onmessage = (e) => {
  const i32 = new Int32Array(e.data);
  postMessage('waiting');
  const r = Atomics.wait(i32, 0, 0, 5000);  // blocks this worker until the page stores + notifies
  Atomics.store(i32, 1, 42);
  Atomics.notify(i32, 1);
  postMessage({ waitResult: r, seen: Atomics.load(i32, 0), coi: self.crossOriginIsolated });
};
