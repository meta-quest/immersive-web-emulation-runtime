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

// Generate the content for registry.ts
const imports = files
	.map((file) => {
		const envId = path.basename(file, '.json');
		return `  ${envId}: () => import('../captures/${file}'),`;
	})
	.join('\n');

const content = `export const Environments: { [envId: string]: () => Promise<any> } = {\n${imports}\n};\n`;

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
