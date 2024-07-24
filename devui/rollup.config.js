import commonjs from '@rollup/plugin-commonjs';
import peerDepsExternal from 'rollup-plugin-peer-deps-external';
import replace from '@rollup/plugin-replace';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

const globals = {
	iwer: 'IWER', // Change this to the global variable name for the iwer module
};

export default {
	input: 'lib/index.js',
	external: ['iwer'],
	plugins: [
		peerDepsExternal(),
		resolve(),
		commonjs(),
		replace({
			'process.env.NODE_ENV': JSON.stringify('production'),
			preventAssignment: true,
		}),
	],
	output: [
		// UMD build
		{
			file: 'build/iwer-devui.js',
			format: 'umd',
			name: 'IWER_DevUI',
			globals,
		},
		// Minified UMD build
		{
			file: 'build/iwer-devui.min.js',
			format: 'umd',
			name: 'IWER_DevUI',
			globals,
			plugins: [terser()],
		},
		// ES module build
		{
			file: 'build/iwer-devui.module.js',
			format: 'es',
			globals,
		},
		// Minified ES module build
		{
			file: 'build/iwer-devui.module.min.js',
			format: 'es',
			globals,
			plugins: [terser()],
		},
	],
};
