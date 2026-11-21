// Host runner: node --expose-gc bench/gl-bench.mjs  (needs the host addon, see test/real-gl.ts)
import { realInstall } from '../test/real-gl.ts';
import { runGlBench, formatBench } from './gl-bench.ts';
const inst = realInstall();
if (!inst) {
  console.error('host GL addon not built');
  process.exit(2);
}
console.log(formatBench(runGlBench(inst), 'host-mesa'));
