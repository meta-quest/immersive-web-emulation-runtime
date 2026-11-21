// Writes web/glue's bundle (built in memory from web/glue/build.mjs's own options) to the given path, without
// touching web/glue/dist (another stream's output). Used by tools/device-test.sh for the end-to-end run.
//   node tools/bundle-glue.mjs <out.js>
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const glueDir = join(dirname(fileURLToPath(import.meta.url)), '../../../web/glue');
const { build } = createRequire(join(glueDir, 'package.json'))('esbuild');
const { buildOptions } = await import(join(glueDir, 'build.mjs'));
const result = await build({ ...buildOptions, minify: true, write: false, outfile: 'glue.min.js' });
writeFileSync(process.argv[2], result.outputFiles[0].text);
