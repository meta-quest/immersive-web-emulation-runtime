// Receives a MessagePort and serves a tiny RPC over it (comlink-style, WRK-6).
onmessage = (e) => {
  const port = e.ports[0];
  port.onmessage = (m) => {
    const { id, a, b } = m.data;
    port.postMessage({ id, sum: a + b });
  };
  postMessage('ready');
};
