// Classic worker: importScripts from same-origin, data:, a blob: URL made here, failures (WRK-4, REG-12).
importScripts('../lib/classic-lib.js', 'data:text/javascript,self.order.push("data")');
const u = URL.createObjectURL(new Blob(['self.order.push("blob")'], { type: 'text/javascript' }));
importScripts(u);
const errs = [];
try { importScripts('missing.js'); } catch (e) { errs.push(e.name); }
try { importScripts('http://[bad'); } catch (e) { errs.push(e.name); }
const dyn = import('../lib/a.js').then((m) => m.a, (e) => 'import failed: ' + e);
dyn.then((a) => postMessage({ order: self.order, errs, dynamicFromClassic: a }));
