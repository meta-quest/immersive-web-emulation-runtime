// Module worker: static + dynamic import, import.meta (WRK-3).
import { a } from '../lib/a.js';
const b = await import('../lib/b.js');
postMessage({ meta: import.meta.url, a, b: b.default, bMeta: b.metaUrl, resolved: import.meta.resolve('./x.js'),
  typeofImportScripts: (() => { try { importScripts('x.js'); return 'no throw'; } catch (e) { return e.name; } })() });
