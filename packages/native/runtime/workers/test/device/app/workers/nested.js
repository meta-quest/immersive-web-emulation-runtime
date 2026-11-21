// A worker that starts its own worker (nested workers).
const inner = new Worker('./echo.js', { name: 'inner' });
inner.onmessage = (e) => postMessage('inner echoed ' + e.data);
onmessage = (e) => inner.postMessage(e.data);
