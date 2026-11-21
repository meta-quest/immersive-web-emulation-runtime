/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host-side servers for the device test (reach them from the headset with `adb reverse`):
//   :18080 http echo, :18443 https with a fresh self-signed certificate (must be rejected), :18081 ws echo.
// Usage: node host-servers.mjs <ws-module-dir>   (a node_modules dir containing `ws`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(join(process.argv[2] ?? process.cwd(), 'x.js'));
const { WebSocketServer } = require('ws');

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'text/plain');
    res.end(`${req.method} ${req.url} x-dev=${req.headers['x-dev']} body=${Buffer.concat(chunks)}`);
  });
}).listen(18080, '127.0.0.1');

const dir = mkdtempSync(join(tmpdir(), 'iwn-selfsigned-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
createHttps({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => res.end('should never be reached')).listen(18443, '127.0.0.1');

const wss = new WebSocketServer({ host: '127.0.0.1', port: 18081 });
wss.on('connection', (s) => s.on('message', (d, bin) => s.send(d, { binary: bin })));
console.log('host servers ready: http 18080, https(self-signed) 18443, ws 18081');
