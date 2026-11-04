---
'iwer': minor
---

New `iwer/host` entry point for native hosts: the WebXR implementation and the host contract without the modules only an emulator in a browser needs (RemoteControlInterface, ActionRecorder / ActionPlayer, the native WebXR override and the WebXR Layers polyfill). Its `XRDevice` is the shared device model (`XRDeviceBase`): `device.remote` is null, `createActionPlayer` throws `NotSupportedError` and `installRuntime({ polyfillLayers: true })` only warns. Import it as `iwer/host` from bundlers and TypeScript; under Node's ESM loader import `iwer/lib/host.js`. Prebuilt bundles: `build/iwer-host.module.js` and `.min.js`. The main `iwer` entry is unchanged.
