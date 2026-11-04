---
'iwer': patch
---

Host mode hot path: steady host frames allocate almost nothing (about one heap number per frame without hand tracking, down from 0.7 to 1.9 KB) and run 35 to 55% faster in the bundled benchmark (`pnpm --filter iwer run bench`). Spaces cache their world and inverse matrices per frame, pose objects are reused and rewritten, and input sources, callback lists and plane/mesh sets are updated in place. The emulator path gets slightly faster too; public typings are unchanged.
