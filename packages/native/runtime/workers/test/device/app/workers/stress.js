// Bounces 64 KB buffers back (transfer both ways) until terminated (WRK-8 stress).
onmessage = (e) => {
  const buf = e.data;
  if (buf instanceof ArrayBuffer) {
    new Uint8Array(buf)[0]++;
    postMessage(buf, [buf]);
  }
};
