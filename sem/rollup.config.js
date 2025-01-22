import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import peerDepsExternal from 'rollup-plugin-peer-deps-external';
import replace from '@rollup/plugin-replace';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

const globals = {
	iwer: 'IWER',
};

export default {
	input: 'lib/index.js',
	external: ['iwer'],
	plugins: [
		peerDepsExternal(),
		resolve(),
		commonjs(),
		json(),
		replace({
			'process.env.NODE_ENV': JSON.stringify('production'),
			preventAssignment: true,
		}),
	],
	output: [
		// UMD build
		{
			file: 'build/iwer-sem.js',
			format: 'umd',
			name: 'IWER_SEM',
			globals,
		},
		// Minified UMD build
		{
			file: 'build/iwer-sem.min.js',
			format: 'umd',
			name: 'IWER_SEM',
			globals,
			plugins: [terser()],
		},
		// ES module build
		{
			file: 'build/iwer-sem.module.js',
			format: 'es',
			globals,
		},
		// Minified ES module build
		{
			file: 'build/iwer-sem.module.min.js',
			format: 'es',
			globals,
			plugins: [terser()],
		},
	],
};
