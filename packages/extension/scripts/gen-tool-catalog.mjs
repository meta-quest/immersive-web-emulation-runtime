/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'agent', 'tool-catalog.generated.json');
const mcpContract = join(root, '..', 'extension-bridge', 'lib', 'contract.js');
const mcpPackage = join(root, '..', 'extension-bridge', 'package.json');

async function main() {
  try {
    const { TOOLS } = await import(pathToFileURL(mcpContract).href);
    const pkg = JSON.parse(readFileSync(mcpPackage, 'utf8'));
    const generated = {
      mcpVersion: pkg.version,
      tools: TOOLS.map((tool) => ({
        name: tool.mcpName,
        title: tool.title,
        description: tool.description,
        readOnly: tool.readOnlyHint,
      })),
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(generated, null, 2)}\n`);
    console.log(`[gen-tool-catalog] wrote ${generated.tools.length} tools`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (existsSync(out)) {
      // The committed catalog stands in (e.g. @iwer/extension-bridge not built
      // yet). The contract-drift test guards against it going stale.
      console.warn(`[gen-tool-catalog] using committed fallback: ${reason}`);
    } else {
      // No fallback to fall back to — failing here is far clearer than a
      // downstream "cannot find module './tool-catalog.generated.json'" in tsc.
      console.error(
        `[gen-tool-catalog] FAILED and no committed catalog exists. ` +
          `Build @iwer/extension-bridge first (pnpm --filter @iwer/extension-bridge build). Cause: ${reason}`,
      );
      process.exit(1);
    }
  }
}

await main();
