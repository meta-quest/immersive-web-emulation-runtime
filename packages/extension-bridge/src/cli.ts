/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * CLI entry: `iwer-bridge [serve|help]`. The daemon is the only thing it does,
 * so the bare invocation (no command) runs it. All human output goes to stderr
 * so `serve`'s stdout stays a clean MCP stdio channel.
 */

import { serve } from './serve.js';
import { VERSION } from './version.js';

function out(line = ''): void {
  process.stderr.write(`${line}\n`);
}

function printHelp(): void {
  out(
    `iwer-bridge ${VERSION} — drive any WebXR page from your coding agent via the Immersive Web Emulator.`,
  );
  out('');
  out('Usage:');
  out('  iwer-bridge            Start the MCP daemon (spawned by your agent over stdio).');
  out('  iwer-bridge serve      Same as above (explicit).');
  out('  iwer-bridge help       Show this help.');
  out('');
  out('Point your agent at it by adding this to its MCP config:');
  out('  { "mcpServers": { "iwer": { "command": "npx", "args": ["-y", "@iwer/extension-bridge"] } } }');
  out('');
  out('Then open a WebXR page, enable the Immersive Web Emulator on it, and click');
  out('Allow when the agent first acts on the page.');
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case 'serve':
      await serve();
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      out(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

void main();
