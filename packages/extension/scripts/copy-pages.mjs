/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Copies the extension HTML pages (offscreen, popup) into build/ after rollup,
 * so the manifest can reference build/*.html alongside the bundled scripts.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src', 'agent');
const outDir = join(root, 'build');

mkdirSync(outDir, { recursive: true });
let count = 0;
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.html')) {
    copyFileSync(join(srcDir, file), join(outDir, file));
    count += 1;
  }
}
console.log(`[copy-pages] copied ${count} html page(s) to build/`);
