/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const fs = require('fs');
const path = require('path');

const jsonDirectory = path.join(__dirname, '../captures');
const outputFilePath = path.join(__dirname, '../src', 'registry.ts');

// Read all JSON files in the directory
const files = fs
  .readdirSync(jsonDirectory)
  .filter((file) => file.endsWith('.json'));

// Generate the content for registry.ts. Paths are relative to the published
// lib/src/registry.js (and build/*/index.js), both two levels below the
// package root, so they reach the single captures/ folder that ships.
const imports = files
  .map((file) => {
    const envId = path.basename(file, '.json');
    return `  ${envId}: () => import('../../captures/${file}'),`;
  })
  .join('\n');
const ids = files
  .map((file) => `  '${path.basename(file, '.json')}',`)
  .join('\n');
// Built-in GLTS rooms: the rooms/<id>.js modules that rooms/build.mjs (run
// first) builds from rooms/src.
const rooms = fs
  .readdirSync(path.join(__dirname, '../rooms'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => path.basename(file, '.js'))
  .sort();
const roomImports = rooms
  .map(
    (id) =>
      `  // @ts-expect-error resolved relative to lib/src/registry.js at runtime\n  ${id}: () => import('../../rooms/${id}.js'),`,
  )
  .join('\n');
const roomIds = rooms.map((id) => `  '${id}',`).join('\n');

const content = `// Bundlers resolve these lazy imports (lib/); the prebuilt bundles fetch the
// files by URL instead of embedding a copy (see loaders.bundle.ts).
export const Environments: { [envId: string]: () => Promise<any> } = {\n${imports}\n};\n\n// Listed separately so the UMD build can name captures without bundling them.\nexport const captureIds = [\n${ids}\n];\n\nexport const Rooms: { [roomId: string]: () => Promise<{ default: string }> } = {\n${roomImports}\n};\n\nexport const roomIds = [\n${roomIds}\n];\n`;

// Write the content to registry.ts
fs.writeFileSync(outputFilePath, content, 'utf8');

console.log('registry.ts has been generated successfully.');
// Generate version.ts
const packageJson = require('../package.json');
const versionOutputFilePath = path.join(__dirname, '../src', 'version.ts');
const versionContent = `export const VERSION = ${JSON.stringify(
  packageJson.version,
)};\n`;
// Write the content to version.ts
fs.writeFileSync(versionOutputFilePath, versionContent, 'utf8');
console.log('version.ts has been generated successfully.');
