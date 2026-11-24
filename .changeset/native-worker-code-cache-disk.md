---
'@iwer/native': patch
---

Worker code cache persists across launches: worker preludes and worker scripts are now consumed from
`<cacheDir>/iwn-worker-code-cache/` on warm launches (before, every launch compiled them again; stats showed only
misses). `workerStats.codeCache` adds `diskHits` and `diskWrites`. The boot log now names the shader cache that
applies on Android (the platform's per-app EGL cache; `EGL_ANDROID_blob_cache` is reserved by Android's EGL loader)
instead of reporting `EGL_ANDROID_blob_cache=0`.
