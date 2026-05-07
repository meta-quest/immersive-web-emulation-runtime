<p align="center">
    <img height="60px" width="60px" src="https://meta-quest.github.io/immersive-web-emulation-runtime/iwer-text.svg" />
    <h1 align="center">@iwer/devui</h1>
</p>

<p align="center">
    <a href="https://www.npmjs.com/package/@iwer/devui"><img src="https://badgen.net/npm/v/@iwer/devui/?icon=npm&color=orange" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/@iwer/devui"><img src="https://badgen.net/npm/dt/@iwer/devui" alt="npm download" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://badgen.net/badge/icon/typescript/?icon=typescript&label=lang" alt="language" /></a>
    <a href="https://raw.githubusercontent.com/meta-quest/immersive-web-emulation-runtime/main/LICENSE"><img src="https://badgen.net/github/license/meta-quest/immersive-web-emulation-runtime/" alt="license" /></a>
</p>

`@iwer/devui` is a developer user interface designed to integrate with the Immersive Web Emulation Runtime (IWER). It provides full control of an emulated WebXR device via an intuitive overlay UI on top of your development environment. This tool is ideal for developers building and testing WebXR applications, offering advanced features for comprehensive device emulation directly within your project's source code.

## Key Features

- **Comprehensive Transform Controls:** Modify the position and orientation of the emulated headset and controllers with precision.
- **Full Gamepad Controls Support:** Exposes complete control over the emulated XR controllers, perfectly recreating the behavior and input of physical controllers for thorough testing.
- **Experimental Play Mode:** Allows developers to efficiently test their immersive experiences using traditional FPS-like mouse and keyboard controls. This mode locks the pointer to the canvas and offers fully mappable keyboard shortcuts to emulate controller actions, streamlining the testing process without the need for physical devices.

## Current Status

`@iwer/devui` is currently in `0.x` status and is under active development. This is an early build, meaning that while it already excels in many areas and offers better usability than the current IWE, it is not yet complete. Key features and functionalities are being actively developed, and significant changes may occur before the official v1.0 release.

### Areas Under Development

- **Emulated Hand Tracking Support:** Enable hand tracking emulation to test applications that rely on this feature.
- **AR Module Support:** Work is ongoing to integrate augmented reality features such as hit-testing, meshing, and plane detection.

## Relationship with IWE

`@iwer/devui` is a package that developers can add directly to their projects, providing a powerful WebXR emulation tool within the source code. In contrast, [**IWE (Immersive Web Emulator)**](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik) is an extension that injects similar emulation capabilities without requiring access to the project’s source code.

In the long term, starting with the IWE 2.0 release, the `@iwer/devui` experience will be integrated into IWE, enhancing its functionality. However, `@iwer/devui` will continue to be available as a standalone package, allowing developers to choose the integration method that best suits their workflow.

## Installation

To install `@iwer/devui`, use the following npm command:

```bash
npm install @iwer/devui
```

## Usage

`@iwer/devui` depends on an active `IWER` runtime within your experience. To get started, you first need to initialize the `IWER` runtime. If you haven't already, check out the [IWER Getting Started Guide](https://meta-quest.github.io/immersive-web-emulation-runtime/getting-started.html). Here is a quick example:

```javascript
import { XRDevice, metaQuest3 } from 'iwer';

// Initialize the XR device with a preset configuration (e.g., Meta Quest 3)
const xrDevice = new XRDevice(metaQuest3);

// Install the IWER runtime to enable WebXR emulation
xrDevice.installRuntime();
```

You can choose to emulate other preset devices or use a custom device configuration with `iwer`. `@iwer/devui` will automatically read the configuration from `iwer` and generate the appropriate control UI based on the selected device.

To integrate `@iwer/devui` into your project, add the following code:

```javascript
import { DevUI } from '@iwer/devui';

// Initialize the DevUI with the configured XR device
const devui = new DevUI(xrDevice);
```

This setup will allow you to use `@iwer/devui`'s comprehensive emulation controls directly within your WebXR project.

## License

`@iwer/devui` is licensed under the MIT License. For more details, see the [LICENSE](https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/LICENSE) file in this repository.

## Contributing

Your contributions are welcome! Please feel free to submit issues and pull requests. Before contributing, make sure to review our [Contributing Guidelines](https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/CODE_OF_CONDUCT.md).
