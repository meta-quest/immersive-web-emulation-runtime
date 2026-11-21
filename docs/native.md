# @iwer/native

`@iwer/native` runs an unmodified WebXR app (IWSDK, three.js) natively on Meta Quest and other Android OpenXR
headsets, with no browser. Its runtime drives the app's WebXR session through IWER's host mode, with V8, WebGL 2
over OpenGL ES, Canvas 2D, Web Audio, workers, fetch and storage underneath, and the `iwer-native` CLI packs and
signs your web build into an APK.

::: warning Alpha
Not every web API is supported yet. Run `npx -p @iwer/native iwer-native compat` on your build before you rely on
it, and check the [support matrix](https://github.com/meta-quest/immersive-web-emulation-runtime/tree/main/packages/native#support-matrix).
:::

```bash
npm install --save-dev @iwer/native
npx iwer-native doctor      # checks Node, adb, the headset and your signing setup
npx iwer-native pack        # web build -> signed APK
npx iwer-native install && npx iwer-native run
```

The [package README](https://github.com/meta-quest/immersive-web-emulation-runtime/tree/main/packages/native#readme)
covers configuration (the `native` section of `iwsdk.config.json`), signing, the compat checker, debugging and the
full support matrix.
