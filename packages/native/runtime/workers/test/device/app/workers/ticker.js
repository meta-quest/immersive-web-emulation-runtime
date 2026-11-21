// Long-lived: posts a tick every 100 ms (pause/resume check).
let n = 0;
setInterval(() => postMessage(++n), 100);
