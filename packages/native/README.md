# @iwer/native (alpha)

> **Alpha: 0.1.0-alpha.0.** Not every web API is supported yet. The user documentation, the support matrix and the
> CLI reference come with the release build of this package.

@iwer/native turns an unmodified WebXR bundle (IWSDK, three.js) into a native Android app for Meta Quest and other
Android OpenXR headsets: V8, WebGL 2 over OpenGL ES, OpenXR with
[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) host mode, and the web APIs those bundles use,
with no browser in the process.

This package currently holds the `native` section of `iwsdk.config.json`: its types, JSON schema, loader, resolver
and validator (`src/config/`). The behaviour spec the runtime is built against is in `../../docs/spec/`.

```bash
npm ci
npm run verify       # typecheck + node:test suite + build
```

MIT (see [LICENSE](LICENSE)).
