<p align="center">
    <img height="60px" width="60px" src="https://meta-quest.github.io/immersive-web-emulation-runtime/iwer-text.svg" />
    <h1 align="center">@iwer/sem</h1>
</p>

<p align="center">
    <a href="https://www.npmjs.com/package/@iwer/sem"><img src="https://badgen.net/npm/v/@iwer/sem/?icon=npm&color=orange" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/@iwer/sem"><img src="https://badgen.net/npm/dt/@iwer/sem" alt="npm download" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://badgen.net/badge/icon/typescript/?icon=typescript&label=lang" alt="language" /></a>
    <a href="https://raw.githubusercontent.com/meta-quest/immersive-web-emulation-runtime/main/LICENSE"><img src="https://badgen.net/github/license/meta-quest/immersive-web-emulation-runtime/" alt="license" /></a>
</p>

`@iwer/sem` (**Synthetic Environment Module**) is an extension for the Immersive Web Emulation Runtime (**IWER**). It enables advanced Mixed Reality features in IWER by emulating real-world environments with high-fidelity, including video passthrough, plane and mesh detection, semantic labels, and hit testing.

## Key Features

- **Video Passthrough Emulation:** Injects a video passthrough layer, rendering the captured scene behind the emulated app canvas.
- **Plane & Mesh Detection:** Provides `XRPlane` and `XRMesh` information via the `plane-detection` and `mesh-detection` APIs in IWER.
- **High Fidelity Scene Mesh:** Supports emulation of high-fidelity scene meshes exposed on Meta Quest 3 and 3S devices.
- **Hit-Test:** Enables `hit-test` APIs through IWER by conducting real-time raycasting spatial queries with the loaded environment.

## Current Status

`@iwer/sem` is currently in `0.x` status and is under active development. This is an early build, changes may occur before the official v1.0 release.

## Installation

To install `@iwer/sem`, use the following npm command:

```bash
npm install @iwer/sem
```

## Usage

`@iwer/sem` requires an active IWER runtime. If you are new to IWER, refer to the [IWER Getting Started Guide](https://meta-quest.github.io/immersive-web-emulation-runtime/getting-started.html). Here is a quick example:

```javascript
import { XRDevice, metaQuest3 } from 'iwer';

// Initialize the XR device with a preset configuration (e.g., Meta Quest 3)
const xrDevice = new XRDevice(metaQuest3);

// Install the IWER runtime to enable WebXR emulation
xrDevice.installRuntime();
```

Integrate `@iwer/sem`:

```javascript
import { SyntheticEnvironmentModule } from '@iwer/sem';

const sem = new SyntheticEnvironmentModule();
xrDevice.installSyntheticEnvironmentModule(sem);
```

Load an environment using a JSON object:

```javascript
sem.loadEnvironment(sceneJSON);
```

Or fetch from an external source:

```javascript
const url = 'path/to/your/scene.json';
fetch(url)
  .then((response) => response.json())
  .then((data) => {
    sem.loadEnvironment(data);
  })
  .catch((error) => {
    console.error('Error loading JSON:', error);
  });
```

## GLTS Environments

Any [GLTS](https://github.com/drawcall-ai/glts) `.glts` file (a procedural three.js scene) can be an environment. Add it under an id; it is listed in the DevUI environment menu next to the built-in captures and loads like them:

```javascript
xrDevice.sem.addEnvironment('my_room', '/my_room.glts');
await xrDevice.sem.loadDefaultEnvironment('my_room');
```

The scene is rendered as passthrough and used for hit-test and depth sensing; its `onFrame` callbacks run every AR frame, so it can be dynamic. Meshes opt into plane and mesh detection with a WebXR semantic label in `userData`:

```ts
floor.userData.xrPlane = 'floor'; // XRPlane, normal = thinnest bounding-box axis
table.userData.xrMesh = 'table'; // XRMesh from the geometry
```

Moving labelled objects moves their plane/mesh. Like a scanned room on Quest, the environment also reports a 'global mesh' XRMesh: the scene's static geometry, merged once when it loads. Tag objects that move, or parts outside the room (such as the view behind a window), with `userData.xrGlobalMesh = false`. Hit tests hit visible geometry only, so invisible proxies (for example a box tagged as a table's volume) are detected but not hit. The scene's `background`, `environment`, `fog` and `scene.rendering` (`shadows`, `toneMapping`, `toneMappingExposure`) apply. The DevUI toggles work as for captures: mesh shows/hides the scene; plane and bounding box show overlays of the reported planes and meshes. GLTS environments need the ES module build. See [`examples/environment`](../../examples/environment).

Installing `@drawcall/glts` needs Node 22.18+ (its Babel 8 dependencies); on older Node versions npm and pnpm only warn, while Yarn 1 fails unless run with `--ignore-engines`. The prebuilt `build/es` bundle can be loaded directly from a CDN with an import map for `iwer`, `three` and `@drawcall/glts`.

## License

`@iwer/sem` is licensed under the MIT License. For more details, see the [LICENSE](https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/LICENSE) file in this repository.

## Contributing

Your contributions are welcome! Please feel free to submit issues and pull requests. Before contributing, make sure to review our [Contributing Guidelines](https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/CODE_OF_CONDUCT.md).
