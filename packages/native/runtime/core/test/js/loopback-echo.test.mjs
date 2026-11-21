// Host test of the real inspector/debug server code (LoopbackServer) against Node clients: Node 24's global
// WebSocket (lowercase handshake headers, GAP-5 / CDP-3), first-frame-only debug clients (DBG-1), multi-MB single
// frames (CDP-4) and the Host check (CDP-10). Needs the host build:
//   cmake -S runtime -B <build> -G Ninja && ninja -C <build> iwn_loopback_echo
//   IWN_HOST_BUILD=<build> node --test runtime/core/test/js/loopback-echo.test.mjs
// Skips when the binary is missing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';

// Default: build/host under the package (packages/native), as in runtime/README's host build.
const build = process.env.IWN_HOST_BUILD || path.join(path.dirname(new URL(import.meta.url).pathname), '../../../../build/host');
const bin = path.join(build, 'core/iwn_loopback_echo');
const skip = !fs.existsSync(bin) && `missing ${bin}`;

let proc;
let port;
before(async () => {
  if (skip) return;
  proc = spawn(bin, ['0'], { stdio: ['pipe', 'pipe', 'inherit'] });
  port = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /PORT (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    proc.on('exit', (c) => reject(new Error('echo server exited ' + c)));
  });
});
after(() => {
  if (proc) proc.stdin.end();
});

function wsOpen(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
  });
}
function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.onmessage = (m) => resolve(m.data);
  });
}

test('discovery over HTTP and the Host check (CDP-2, CDP-10)', { skip }, async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.equal(list[0].type, 'page');
  const raw = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /json HTTP/1.1\r\nHost: evil.example\r\n\r\n'));
    let d = '';
    s.on('data', (c) => (d += c));
    s.on('end', () => resolve(d));
  });
  assert.match(raw, /^HTTP\/1\.1 403/);
});

test("Node's global WebSocket connects and round-trips (CDP-3, GAP-5)", { skip }, async () => {
  const ws = await wsOpen(`ws://127.0.0.1:${port}/devtools/page/1`);
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate' }));
  const msg = JSON.parse(await reply);
  assert.equal(msg.id, 7);
  assert.match(msg.result.echo, /Runtime\.evaluate/);
  ws.close();
});

test('debug endpoint: one request per connection, first frame is the whole reply (DBG-1)', { skip }, async () => {
  const ws = await wsOpen(`ws://127.0.0.1:${port}/host`);
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ method: 'eval', params: { expression: '1+1' } }));
  assert.deepEqual(JSON.parse(await reply), { result: 2 });
  ws.close();
});

test('a 3 MB reply arrives as one unfragmented text frame (CDP-4)', { skip }, async () => {
  const frames = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    s.on('error', reject);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const e = buf.indexOf('\r\n\r\n');
        if (e < 0) return;
        upgraded = true;
        buf = buf.subarray(e + 4);
        const payload = Buffer.from(JSON.stringify({ id: 1, method: 'big' }));
        const mask = Buffer.from([1, 2, 3, 4]);
        s.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((b, i) => b ^ mask[i & 3])]));
      }
      if (buf.length >= 10) {
        const len = Number(buf.readBigUInt64BE(2));
        if (buf.length >= 10 + len) {
          resolve({ b0: buf[0], len });
          s.destroy();
        }
      }
    });
    s.write(`GET /host HTTP/1.1\r\nHOST: 127.0.0.1\r\nCONNECTION: keep-alive, Upgrade\r\nUPGRADE: WebSocket\r\nSEC-WEBSOCKET-KEY: dGhlIHNhbXBsZSBub25jZQ==\r\nSEC-WEBSOCKET-VERSION: 13\r\n\r\n`);
  });
  assert.equal(frames.b0, 0x81); // FIN + text
  assert.ok(frames.len > 3 * 1024 * 1024);
});

test('WebSocket upgrades from web-page origins are refused; DevTools and tools are accepted', { skip }, async () => {
  const upgrade = (origin) =>
    new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () =>
        s.write(
          'GET /host HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
            (origin ? `Origin: ${origin}\r\n` : '') + '\r\n',
        ),
      );
      let d = '';
      s.on('data', (c) => {
        d += c;
        if (d.includes('\r\n\r\n')) {
          s.destroy();
          resolve(d.split('\r\n')[0]);
        }
      });
      s.on('end', () => resolve(d.split('\r\n')[0]));
    });
  assert.match(await upgrade('https://evil.example'), / 403 /);
  assert.match(await upgrade('http://127.0.0.1:8080'), / 403 /);
  assert.match(await upgrade('devtools://devtools'), / 101 /);
  assert.match(await upgrade(null), / 101 /);
});
