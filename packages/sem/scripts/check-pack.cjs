/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Checks that the npm tarball has every file SEM loads at runtime. npm and
// pnpm differ in which ignore files they apply, so this asks npm.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
);
const packed = new Set(pack.files.map((file) => file.path));
const list = (dir, ext) =>
  fs
    .readdirSync(path.join(root, dir))
    .filter((file) => file.endsWith(ext))
    .map((file) => `${dir}/${file}`);
// One module per room source (rooms/src/<id>.ts or .glts; kit.ts is shared),
// so rooms that were never built are reported too.
const rooms = fs
  .readdirSync(path.join(root, 'rooms/src'))
  .filter((file) => /\.(ts|glts)$/.test(file) && file !== 'kit.ts')
  .map((file) => `rooms/${file.replace(/\.(ts|glts)$/, '.js')}`);
const expected = [
  'lib/src/index.js',
  'build/es/index.js',
  'build/iwer-sem.js',
  'rooms/README.md',
  ...list('captures', '.json'),
  ...rooms,
];
const missing = expected.filter((file) => !packed.has(file));
if (missing.length) {
  console.error(`npm pack leaves out:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`npm pack has all ${expected.length} runtime files`);
