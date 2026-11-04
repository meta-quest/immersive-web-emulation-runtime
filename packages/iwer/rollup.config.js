import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

export default [
  {
    input: 'lib/index.js',
    plugins: [resolve(), commonjs()],
    output: [
      // UMD build
      {
        file: 'build/iwer.js',
        format: 'umd',
        name: 'IWER',
      },
      // Minified UMD build
      {
        file: 'build/iwer.min.js',
        format: 'umd',
        name: 'IWER',
        plugins: [terser()],
      },
      // ES module build
      {
        file: 'build/iwer.module.js',
        format: 'es',
      },
      // Minified ES module build
      {
        file: 'build/iwer.module.min.js',
        format: 'es',
        plugins: [terser()],
      },
    ],
  },
  {
    // iwer/host: host mode without the emulator-only modules (see src/host.ts)
    input: 'lib/host.js',
    plugins: [resolve(), commonjs()],
    output: [
      {
        file: 'build/iwer-host.module.js',
        format: 'es',
      },
      {
        file: 'build/iwer-host.module.min.js',
        format: 'es',
        plugins: [terser()],
      },
    ],
  },
];
