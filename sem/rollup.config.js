import { VERSION } from './lib/version.js';
import commonjs from '@rollup/plugin-commonjs';
import dynamicImportVars from '@rollup/plugin-dynamic-import-vars';
import json from '@rollup/plugin-json';
import peerDepsExternal from 'rollup-plugin-peer-deps-external';
import replace from '@rollup/plugin-replace';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

const globals = {
	iwer: 'IWER',
};

const basePlugins = [peerDepsExternal(), resolve(), commonjs(), json()];

const esPlugins = [
	...basePlugins,
	replace({
		__IS_UMD__: 'false', // Set to false for ES builds
		preventAssignment: true,
	}),
	dynamicImportVars(),
];

const umdPlugins = [
	...basePlugins,
	replace({
		__IS_UMD__: 'true', // Set to true for UMD builds
		preventAssignment: true,
	}),
];

export default [
	// UMD builds
	{
		input: 'lib/index.js',
		external: ['iwer'],
		plugins: umdPlugins,
		output: [
			{
				file: 'build/iwer-sem.js',
				format: 'umd',
				name: 'IWER_SEM',
				globals,
			},
			{
				file: 'build/iwer-sem.min.js',
				format: 'umd',
				name: 'IWER_SEM',
				globals,
				plugins: [terser()],
			},
		],
	},
	// ES module builds
	{
		input: 'lib/index.js',
		external: ['iwer'],
		plugins: esPlugins,
		output: [
			{
				dir: 'build/es',
				format: 'es',
				entryFileNames: '[name].js',
				chunkFileNames: '[name]-[hash].js',
				globals,
			},
			{
				dir: 'build/es-min',
				format: 'es',
				entryFileNames: '[name].min.js',
				chunkFileNames: '[name]-[hash].min.js',
				plugins: [terser()],
				globals,
			},
		],
	},
];
