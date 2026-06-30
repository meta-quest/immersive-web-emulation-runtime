import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import replace from '@rollup/plugin-replace';
import resolve from '@rollup/plugin-node-resolve';
import strip from '@rollup/plugin-strip';
import terser from '@rollup/plugin-terser';

// Shared plugins for the small chrome-only bundles (content bridge, offscreen,
// popup). No console stripping so debugging the bridge stays possible.
const extPlugins = [resolve(), commonjs(), json()];

export default [
  {
    input: 'lib/index.js',
    plugins: [
      resolve(),
      commonjs(),
      json(),
      replace({
        'process.env.NODE_ENV': JSON.stringify('production'),
        preventAssignment: true,
      }),
      replace({
        __IS_UMD__: 'true', // Set to true for UMD builds
        preventAssignment: true,
      }),
      strip({
        functions: ['console.*'],
      }),
    ],
    output: {
      file: 'build/iwe.min.js',
      format: 'umd',
      name: 'IWE',
      plugins: [terser()],
      footer: 'IWE.injectRuntime();',
    },
  },
  {
    input: 'lib/service-worker.js',
    plugins: [resolve(), commonjs()],
    output: {
      file: 'build/service-worker.min.js',
      format: 'esm',
      plugins: [terser()],
    },
  },
  {
    // ISOLATED-world content script bridging the page shim to the SW.
    input: 'lib/agent/content-bridge.js',
    plugins: extPlugins,
    output: {
      file: 'build/content-bridge.min.js',
      format: 'iife',
      plugins: [terser()],
    },
  },
  {
    // ISOLATED-world content script that seeds prefs before MAIN runtime init.
    input: 'lib/agent/prefs-seeder.js',
    plugins: extPlugins,
    output: {
      file: 'build/prefs-seeder.min.js',
      format: 'iife',
      plugins: [terser()],
    },
  },
  {
    // Offscreen document: durable WebSocket client.
    input: 'lib/agent/offscreen.js',
    plugins: extPlugins,
    output: {
      file: 'build/offscreen.min.js',
      format: 'iife',
      plugins: [terser()],
    },
  },
  {
    // Connect popup UI.
    input: 'lib/agent/popup.js',
    plugins: extPlugins,
    output: {
      file: 'build/popup.min.js',
      format: 'iife',
      plugins: [terser()],
    },
  },
  {
    // DevTools bootstrap for the persistent settings panel.
    input: 'lib/agent/devtools.js',
    plugins: extPlugins,
    output: {
      file: 'build/devtools.min.js',
      format: 'iife',
      plugins: [terser()],
    },
  },
  {
    // Persistent settings + migration + MCP setup panel.
    input: 'lib/agent/panel.js',
    plugins: extPlugins,
    output: {
      file: 'build/panel.min.js',
      format: 'iife',
      plugins: [terser()],
    },
  },
  {
    // One-time welcome / migration page.
    input: 'lib/agent/whats-new.js',
    plugins: extPlugins,
    output: {
      file: 'build/whats-new.min.js',
      format: 'iife',
      plugins: [terser()],
    },
  },
];
