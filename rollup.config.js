import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

export default {
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
};
