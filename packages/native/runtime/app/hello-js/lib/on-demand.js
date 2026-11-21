// Loaded only by m1-check r5 (concurrent import() of one URL shares one off-thread read, PROC-2).
import { filler } from './shared-dep.js';
export const size = filler;
export const url = import.meta.url;
