---
'@iwer/native': patch
---

Runtime fixes from the native APK device matrix:

- The performance-level manager no longer raises the GPU after a JS-thread stall (a GC pause) or a system stall. It counts missed frames instead of missed display periods, ignores one burst, puts misses the JS thread explains on the CPU, ignores multi-period stalls the JS thread does not explain (`perf.stallsIgnored` in `stats`), and raises the GPU only for steady misses while the JS frames are on time.
- On Home, the pause line no longer promises that the session stays (`xr: paused (session hidden); it resumes if the app returns, unless the system destroys the activity`), and `activity onDestroy` now says that the page is discarded and the next launch starts a fresh page.
- A `native.frameRate` the display does not list is no longer requested. The runtime logs a warning that names the rate, the display's rates and the rate in use.
- A release build launched with extras it ignores (`--query`, `--inspect`, `--inspect-brk`, `--v8-flags`) logs a warning that names them.
- APKs declare `<horizonos:uses-horizonos-sdk horizonos:minSdkVersion="60" horizonos:targetSdkVersion="60"/>`, so Horizon OS no longer logs "manifest does not specify a minimum HzOS SDK version" on every launch. The packer adds this element to templates that lack it.
