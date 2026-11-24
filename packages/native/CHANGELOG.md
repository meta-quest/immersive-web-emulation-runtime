# @iwer/native

## 2.9.0

### Minor Changes

- New package `@iwer/native`: runs an unmodified WebXR app (IWSDK, three.js) natively on Meta Quest and other Android OpenXR headsets, with no browser. It ships a prebuilt runtime template APK (V8, WebGL 2 over OpenGL ES, OpenXR through IWER host mode, Canvas 2D, Web Audio, workers, fetch and storage), the `iwer-native` CLI (`doctor`, `validate`, `pack`, `install`, `run`) that packs and signs an app's web build into an APK, and a compat checker that lists the web APIs an app uses that the runtime does not have yet. Not every web API is supported; the README's support matrix lists what is.
