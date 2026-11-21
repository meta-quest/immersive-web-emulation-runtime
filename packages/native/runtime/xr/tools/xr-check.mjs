#!/usr/bin/env node
// Talks to a running app's debug endpoint (docs/spec/14: ws://127.0.0.1:<port>/host, one request per connection,
// the first WebSocket frame is the whole reply) for the XR module's device checks. Uses Node 24's global WebSocket.
//
//   node xr-check.mjs [--port 9509] eval '<expression>'
//   node xr-check.mjs [--port 9509] stats [section]          (section: e.g. xr)
//   node xr-check.mjs [--port 9509] info
//   node xr-check.mjs [--port 9509] shot <out.png> [left|right|both] [scale]
//   node xr-check.mjs [--port 9509] watch <seconds>           (fps/frames from stats once per second)
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let port = 9509;
if (args[0] === '--port') {
  port = Number(args[1]);
  args.splice(0, 2);
}

export function request(method, params = {}, { timeoutMs = 60000, url = `ws://127.0.0.1:${port}/host` } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${method}: no reply within ${timeoutMs} ms`));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ method, params }));
    ws.onmessage = (e) => {
      clearTimeout(timer);
      ws.close();
      try {
        resolve(JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`${method}: ${e.message ?? 'WebSocket error'}`));
    };
  });
}

async function main() {
  const [cmd, ...rest] = args;
  if (cmd === 'eval') {
    const r = await request('eval', { expression: rest[0], awaitPromise: true, timeoutMs: 30000 });
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'stats') {
    const r = await request('stats');
    console.log(JSON.stringify(rest[0] ? r[rest[0]] : r, null, 2));
  } else if (cmd === 'info') {
    console.log(JSON.stringify(await request('info'), null, 2));
  } else if (cmd === 'shot') {
    const t0 = Date.now();
    const r = await request('shot', { eye: rest[1] ?? 'both', scale: Number(rest[2] ?? 1) });
    if (r.error) throw new Error(r.error);
    writeFileSync(rest[0], Buffer.from(r.png, 'base64'));
    console.log(`${rest[0]}: ${r.width}x${r.height}, frame ${r.frame}, ${Date.now() - t0} ms`);
  } else if (cmd === 'watch') {
    const n = Number(rest[0] ?? 10);
    for (let i = 0; i < n; i++) {
      const s = await request('stats');
      const x = s.xr ?? {};
      console.log(
        `fps=${s.fps?.toFixed?.(1)} xr: state=${x.state} vis=${x.visibility} frames=${JSON.stringify(x.frames)} ` +
          `timing=${JSON.stringify(x.timing)} perf=${JSON.stringify(x.perf)}`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    console.error('usage: xr-check.mjs [--port N] eval <expr> | stats [section] | info | shot <out.png> [eye] [scale] | watch <s>');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
