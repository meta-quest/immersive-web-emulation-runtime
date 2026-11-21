# web/audio

The Web Audio API for `@iwer/native` (spec AUD-1..13). This directory is the JS half: `AudioContext`,
`OfflineAudioContext`, `AudioBuffer`, `AudioParam` and the nodes, written in TypeScript over the native audio module
(`globalThis.__iwn.audio`, from [`runtime/audio`](../../runtime/audio/README.md), which describes the design and the
decisions).

```
npm install
npm run build          # dist/audio.js + dist/audio.min.js (the prelude; runs after the web glue)
npm run build:addon    # host Node addon of the real engine (cmake + ninja), used by the native tests
npm test               # fake-natives API tests, protocol sync, engine tests, three.js compatibility
```

- `src/install.ts`: `installWebAudio(globalThis, natives)` / `createWebAudio(natives)`. Alpha surface by default:
  only the basic set (AudioContext lifecycle, AudioBufferSourceNode, GainNode, PannerNode + AudioListener,
  AudioBuffer, decodeAudioData). Every other node and its `create*()` factory throws `NotSupportedError` naming the
  interface, and `OfflineAudioContext` is absent, unless `{ experimental: true }` is passed. The prelude passes it
  when the runtime config has `"glue": {"audio": {"experimental": true}}`.
- `src/natives.ts`: the JS-visible contract of the native module.
- `src/protocol.ts`: mirror of `runtime/audio/src/protocol.h` (`test/protocol.test.ts` keeps them equal).
- `test/three-compat.test.ts` runs three.js `AudioListener`/`PositionalAudio`/`Audio` (what IWSDK's AudioSystem uses)
  unmodified on this implementation. It needs `IWN_THREE_MODULE`, which points at a `three.module.js`
  (super-three 0.181.0, as IWSDK pins). The test is skipped otherwise.
- `test/param-lifetime-and-close.test.ts`: regressions (AudioParam keeps its node, slot generations in
  connection keys, nothing queued after `close()`, value read-back while suspended, curve overlap rules,
  no JS allocation per automation call, decode-failure log line).
