---
outline: deep
title: Getting Started
---

# Getting Started

This guide introduces the Immersive Web Emulation Runtime (IWER), detailing how to integrate it into your WebXR projects efficiently.

## Adding IWER to Your Project

### Install IWER via NPM

To incorporate IWER into your project, start by installing it through npm with the following command:

```bash
npm install iwer
```

### Import IWER from a CDN

Alternatively, you can import IWER directly into your project from a CDN using either the UMD build or an import map.

#### Using the UMD Build

Include the UMD build script in the `<head>` of your HTML file, ensuring to replace `<version>` with the specific version number you wish to use:

```html
<head>
  <script src="https://unpkg.com/iwer@<version>/build/iwer.min.js"></script>
</head>
```

#### Using an Import Map

Alternatively, you can use an import map. Add the following script tag to your HTML, ensuring to replace `<version>` with the specific version number you wish to use:

```html
<script type="importmap">
  {
    "imports": {
      "iwer": "https://unpkg.com/iwer@<version>/build/iwer.module.js"
    }
  }
</script>
```

#### Try It Live on Glitch!

- **Three.js**: [https://glitch.com/edit/#!/iwer-three-example](https://glitch.com/edit/#!/iwer-three-example)
- **Babylon.js**: [https://glitch.com/edit/#!/iwer-babylon-example](https://glitch.com/edit/#!/iwer-babylon-example)
- **A-Frame**: [https://glitch.com/edit/#!/iwer-aframe-example](https://glitch.com/edit/#!/iwer-aframe-example)

## Creating an XRDevice and Installing the Runtime

To get started with IWER in your WebXR project, you'll first need to create an XRDevice and install the runtime:

```javascript
import { XRDevice, metaQuest3 } from 'iwer';

const xrDevice = new XRDevice(metaQuest3);
xrDevice.installRuntime();
```

Ensure this initialization occurs before any rendering or WebXR logic within your application. Some frameworks and libraries may check for WebXR support immediately upon loading; installing the IWER runtime beforehand ensures that these checks correctly recognize the emulated WebXR support provided by IWER.

> [!IMPORTANT]
> At this point, your WebXR application will be equipped to recognize and utilize WebXR support through the emulated XRDevice, allowing users to enter XR experiences in emulation mode.

> [!NOTE]
> If you're integrating IWER into a production build, it's crucial to first check for native WebXR support. In environments where native WebXR is available, you may prefer not to inject IWER's runtime to avoid overriding the native implementation. This is particularly relevant for platforms like the Meta Quest Browser, which already supports WebXR natively.

## WebGPU Applications

IWER emulates the [WebXR/WebGPU binding](https://immersive-web.github.io/webxr-webgpu-binding/), so WebGPU apps such as three.js `WebGPURenderer` can enter XR in browsers that support WebGPU but don't provide `XRGPUBinding`. Immersive sessions can request the `'webgpu'` feature when the browser can provide a WebGPU adapter. The app renders into a projection layer, and IWER draws the layer to a canvas over the page, with the two views side by side when stereo rendering is on:

```javascript
const session = await navigator.xr.requestSession('immersive-vr', {
  requiredFeatures: ['webgpu'],
});
const binding = new XRGPUBinding(session, gpuDevice);
const layer = binding.createProjectionLayer({
  colorFormat: binding.getPreferredColorFormat(),
});
session.updateRenderState({ layers: [layer] });
```

With the `'layers'` feature, WebGPU sessions can also show quad, cylinder, equirect and cube layers, up to `session.maxRenderLayers` (16) at once. IWER draws them in `renderState.layers` order, each blended over the ones before it:

```javascript
const session = await navigator.xr.requestSession('immersive-vr', {
  requiredFeatures: ['webgpu', 'layers'],
});
const quad = binding.createQuadLayer({
  colorFormat: binding.getPreferredColorFormat(),
  space: await session.requestReferenceSpace('local'),
  viewPixelWidth: 512,
  viewPixelHeight: 512,
  transform: new XRRigidTransform({ x: 0, y: 0, z: -2, w: 1 }),
});
session.updateRenderState({ layers: [projectionLayer, quad] });
// In each frame, binding.getSubImage(quad, frame) gives the texture to draw.
```

As the binding describes, the textures a layer gives out in a frame start cleared and are destroyed when the frame ends. IWER keeps showing the last frame each layer was drawn in, so a layer created with `isStatic: true` only needs drawing while `needsRedraw` is `true`.

With `'layers'`, `XRMediaBinding` also creates quad, cylinder and equirect layers that show a video. IWER copies the video's current frame each time it draws, on a `GPUDevice` of its own, so these layers work without an `XRGPUBinding`. As with any WebGPU upload, the video must be same-origin or served with CORS. IWER defines `XRMediaBinding` only while such a session runs, so a WebXR Layers polyfill that an app loads for WebGL sessions still installs.

```javascript
const media = new XRMediaBinding(session);
const screen = media.createQuadLayer(video, {
  space: await session.requestReferenceSpace('local'),
  transform: new XRRigidTransform({ x: 0, y: 0, z: -2, w: 1 }),
  width: 1.6, // The height follows the video's aspect ratio.
});
session.updateRenderState({ layers: [projectionLayer, screen] });
```

IWER's WebGPU types are the standard ones on TypeScript 6. On TypeScript 5, add `@webgpu/types` to get them; without it, WebGPU values are typed loosely.

A projection layer's `fixedFoveation` (0 to 1, default 0) lowers the resolution away from the centre of each view when IWER draws it, like fixed foveated rendering on a headset.

With the `'space-warp'` feature, a projection layer created with a depth format other than `'stencil8'` also gives out a `motionVectorTexture` (`rgba16float`), and its depth/stencil texture uses the motion vectors' lower resolution, about a quarter of the view's in each direction. As on a Quest, the app then runs at half the frame rate: after each frame that draws the layer's motion vectors and depth, IWER synthesizes the next one by moving every pixel along its motion vector and reprojecting it with depth to the latest head pose. Motion vectors are the pixel's NDC position in the current frame minus its position in the previous frame, camera motion included, so missing or wrong motion vectors show up as stutter or wobble, as they would on a headset. Frames that don't draw both run at the full rate, as the spec requires.

```javascript
const session = await navigator.xr.requestSession('immersive-vr', {
  requiredFeatures: ['webgpu', 'space-warp'],
});
const layer = binding.createProjectionLayer({
  colorFormat: binding.getPreferredColorFormat(),
  depthStencilFormat: 'depth24plus',
});
// In each frame, render color into subImage.colorTexture, then depth and
// motion vectors over the whole of subImage.depthStencilTexture and
// subImage.motionVectorTexture.
```

With `installRuntime({ polyfillLayers: true })`, the WebXR Layers polyfill keeps handling WebGL sessions, and WebGPU sessions bypass it.

As the binding requires, WebGPU sessions can't use `XRWebGLLayer` or `XRWebGLBinding`. For depth sensing, use `XRFrame.getDepthInformation()` for CPU-optimized depth or `XRGPUBinding.getDepthInformation()` for GPU-optimized depth, a texture of linear depth with one array layer per view: `r32float` meters, or `r16uint` millimeters for `'unsigned-short'`. The session uses the first usage and data format in `depthSensing` that it supports.

## Understanding IWER's Global Reference Space

IWER creates a simple but effective space to simulate how you move and interact in XR. Think of it as the stage where all your virtual actions happen. This stage, or "global reference space," is like the room you're in, with the starting point right under where the headset would be on the ground.

When setting up, IWER places the headset 1.6 meters off the ground, which is like standing up. Your virtual hands start slightly in front and to the side, just like they might in real life.

When you ask for different types of XRReferenceSpaces from your XR session, IWER makes sure these fit neatly into this global space. Consequently, the positions and orientations provided by `XRFrame.getViewerPose`, relative to any `XRReferenceSpace`, are derived from the emulated headset's transformation within this global context.

## Emulated Headset

Manipulating the emulated headset in IWER is straightforward, allowing for easy integration with popular WebXR frameworks.

### Transform Control

To move or rotate the headset:

```javascript
// Set the xrDevice's position
xrDevice.position.set(0, 1.8, 0);

// To adjust a specific component
xrDevice.position.y = 1.8;

// To copy from a Three.js or Babylon.js Vector3
xrDevice.position.copy(vec3);
```

Setting the orientation is just as simple:

```javascript
xrDevice.quaternion.set(0, 0, 0, 1);
xrDevice.quaternion.copy(quat);
```

### Stereo Rendering

By default, IWER's stereo rendering is off to simplify development and previewing. You can toggle it as needed:

```javascript
xrDevice.stereoEnabled = true; // Enable
xrDevice.stereoEnabled = false; // Disable
```

With stereo rendering off, IWER displays the view from the left eye. You can also adjust the interpupillary distance (IPD) in real-time:

```javascript
xrDevice.ipd = 0.063; // Set IPD in meters
```

### FOV on Y-Axis

Unlike traditional XR development where the field of view (FOV) is typically fixed by hardware, IWER grants the ability to adjust the FOV on the Y-axis for debugging convenience or specific rendering needs:

```javascript
xrDevice.fovy = Math.PI / 2; // Set FOV on Y-axis
```

This flexibility ensures that developers can tailor the virtual experience precisely, from basic positioning to fine-tuning visual parameters.

For Meta VR Glasses visibility testing, use the built-in `metaVRGlasses` profile. It
retains the Quest-compatible runtime and input capabilities while masking the
desktop preview to the measured 74° horizontal by 68° vertical view. The
vertical opening is asymmetric: 25° above and 43° below the optical axis.

```javascript
import { XRDevice, metaVRGlasses } from 'iwer';

const xrDevice = new XRDevice(metaVRGlasses);
xrDevice.installRuntime();
```

The existing FOV-Y control still sets IWER's symmetric preview projection. The
Meta VR Glasses profile then crops that projection to its independent left, right, up,
and down bounds, which is what allows it to represent the asymmetric vertical
view. Keep the preview projection wide enough to contain all target bounds. In
DevUI, use the field-of-view mask button beside the headset controls to compare
the masked and unmasked views. The button is disabled for device profiles that
do not provide visibility-mask data. When using the browser extension, the FOV
Mask setting beside FOV-Y saves the same choice as a per-site or all-sites
default.

## Emulated Controllers

### Accessing the Controllers

In IWER, the emulated controllers are readily accessible through the `XRDevice.controllers` property, which is a map of the controller's handedness to the `XRController` objects. This mapping is dynamically generated based on the configuration specified when creating the `XRDevice`. For instance, an `XRDevice` configured with `metaQuest3` settings will contain entries for both "left" and "right" handedness in the controllers map, mirroring the physical setup of the Meta Quest controllers.

```javascript
// Accessing the left controller:
const leftController = xrDevice.controllers['left'];
```

### Transform Control

Manipulating the position and orientation of the emulated controllers mirrors the approach used for controlling the `XRDevice`. This symmetry in API design facilitates a seamless and intuitive experience for developers, enabling precise control over the virtual environment.

```javascript
// Setting the position of the left controller:
xrDevice.controllers['left'].position.set(-0.3, 1.5, -0.3);

// Copying the orientation to the right controller from an external quaternion:
xrDevice.controllers['right'].quaternion.copy(quat);
```

### Gamepad Control

Each emulated controller comes equipped with a virtual gamepad, shaped by the `XRControllerConfig` within the `XRDeviceConfig`. The configuration defines the button and axes mappings for the gamepad, dictating its behavior. Utilizing the `metaQuestTouchPlus` configuration as an example, actions such as pressing buttons or moving thumbsticks can be emulated as follows:

```javascript
// Pressing the X button on the left controller:
xrDevice.controllers['left'].updateButtonValue('x-button', 1);

// Releasing the thumbstick button on the right controller:
xrDevice.controllers['right'].updateButtonValue('thumbstick', 0);

// Emulating partial pressure on the analog trigger of the right controller:
xrDevice.controllers['right'].updateButtonValue('trigger', 0.3); // 30% pressure

// Simulating a 50% squeeze on the left grip:
xrDevice.controllers['left'].updateButtonValue('squeeze', 0.5);

// Emulating touch on the A button of the right controller:
xrDevice.controllers['right'].updateButtonTouch('a-button', true);
```

The gamepad's `axes` provide control over 2D analog inputs, such as thumbsticks or touchpads, offering nuanced manipulation of in-game movements or interactions.

```javascript
// Adjusting the right thumbstick's X-axis:
xrDevice.controllers['right'].updateAxis('thumbstick', 'x-axis', -0.2);

// Simultaneously adjusting both axes of the right thumbstick:
xrDevice.controllers['right'].updateAxes('thumbstick', xVal, yVal);
```

> [!NOTE]
> The clickable functionality of thumbsticks or touchpads is managed separately through the `updateButtonValue` method, allowing for distinct control over clickable actions versus analog movements.

## Emulated Hands

### Accessing the Hands

In IWER, hands are accessed similarly to controllers, with `XRHandInput` objects stored under the `XRDevice.hands` property for both "left" and "right" hands.

```javascript
// Accessing the left hand:
const leftHand = xrDevice.hands['left'];
```

### Transform Control

The transform control for `XRHandInput` mirrors that of the controllers. It's important to note that, for a unified experience with emulated controllers, you're modifying the transform of the `targetRaySpace` for the hands.

```javascript
// Setting the position and orientation of the left hand:
xrDevice.hands['left'].position.set(-0.3, 1.5, 0.2);
xrDevice.hands['right'].quaternion.copy(quat);
```

### Pose Control

Hand poses present a unique challenge for emulation, given the variability in hand shapes and the differences in hand tracking implementations across platforms. IWER ships a library of base hand poses for development. `default`, `pinch` and `point` were captured on a Meta Quest 3; the rest are built on the skeleton of the captured `default` pose:

| Group         | Poses                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| Neutral       | `default`, `open`, `flat`, `fist`                                           |
| Pinches       | `pinch`, `pinch-middle`, `pinch-ring`, `pinch-pinky`, `tripod`, `key-pinch` |
| Pointing      | `point`, `finger-gun`                                                       |
| Gestures      | `thumbs-up`, `peace`, `three`, `four`, `ok`, `rock`, `call`                 |
| Grasps        | `grip`, `claw`, `hook`, `cup`                                               |
| Microgestures | `microgesture` (fingers loosely curled, the thumb by the index)             |

```javascript
// Setting the pose of the left hand:
xrDevice.hands['left'].poseId = 'open';

// Every pose this hand can take:
console.log(xrDevice.hands['left'].poseIds);
```

You can also take individual fingers from other poses. A borrowed finger keeps its source pose's spread as well as its curl, so take straight fingers from `flat` when they should lie together and from `open` when they should fan out. Setting `poseId` clears these finger blends:

```javascript
const hand = xrDevice.hands['right'];
hand.poseId = 'open';
// Curl three fingers to make a finger gun from an open hand:
hand.setFingerPose('middle', 'fist');
hand.setFingerPose('ring', 'fist');
hand.setFingerPose('pinky', 'fist');
// Blend the index halfway toward a fist:
hand.setFingerPose('index', 'fist', 0.5);
hand.clearFingerPoses('index');

// Point from a fist, with the index straight and in line with the hand:
hand.poseId = 'fist';
hand.setFingerPose('index', 'flat');
```

### Pinch Control

The pinch gesture serves as a core interaction mechanism, commonly used for actions like selecting, confirming, or grabbing objects. IWER facilitates the emulation of pinch gestures from any hand pose, allowing for dynamic interaction within the virtual environment:

```javascript
// Gradually applying a pinch gesture to the left hand:
const leftHand = xrDevice.hands['left'];
let pinchVal = leftHand.pinchValue; // Start from the current pinch value.
const pinchGestureJob = setInterval(() => {
  pinchVal += 0.05;
  if (pinchVal > 1) {
    clearInterval(pinchGestureJob);
    return;
  }
  leftHand.updatePinchValue(pinchVal);
}, 25); // Update interval in milliseconds.
```

The pinch closes the thumb and index onto each other, relative to the palm; the wrist, the grip and the other fingers keep the pose. The hand selects when the pinch reaches 0.9 and lets go at 0.7. To script whole interactions (a fingertip on a button, timed pinches, pose fades) through remote control, see [Scripting Hand Interactions](./scripting-hands.md).

### Microgestures

Each hand has a gamepad laid out as Quest Browser reports it: mapping `xr-standard`, the pinch on button 0, the menu gesture on button 4 and Quest's thumb microgestures on buttons 5 to 9 (swipe left, right, forward and backward along the curled index finger, and a thumb tap). Only the pinch fires session events; read the others from `inputSource.gamepad.buttons`. Remote control's `microgesture` command makes one with the thumb motion and a 35 ms press, as on Quest (see [Microgestures](./scripting-hands.md#microgestures)); `updateGestureButton()` writes a button directly:

```javascript
await xrDevice.remote.dispatch('microgesture', {
  device: 'hand-right',
  gesture: 'swipe-left',
});
// The app sees inputSource.gamepad.buttons[5].pressed for 35 ms.
```

## Platform Features

Beyond the fundamental emulation capabilities for XR devices, IWER incorporates several platform features to simulate system actions that occur outside the direct control of WebXR experiences or the browser. These scenarios, often overlooked during development, can lead to unexpected behavior in WebXR applications. Testing with these platform features is crucial for ensuring robust handling of such system-initiated actions within your WebXR projects.

### Primary Input Mode

In the realm of XR, particularly with devices like the Meta Quest headsets, users can dynamically switch between hand tracking and controllers as their primary form of input. This action, within a WebXR context, leads to `XRInputSources` disappearing and reappearing during runtime. IWER enables the emulation of these transitions to assist in testing how your experience adapts to changes in input methods:

```javascript
// Switching primary input from controllers to hands:
xrDevice.primaryInputMode = 'hand';

// And back to controllers:
xrDevice.primaryInputMode = 'controller';
```

### Input Disconnection

Inputs might temporarily disappear and reappear due to various reasons, such as loss of tracking or depleted controller batteries. This can result in scenarios where one, or neither, of the controllers/hands is connected, potentially disrupting the user experience if not properly handled. IWER allows for the simulation of these disconnection events:

```javascript
// Emulating the disconnection of the left controller:
xrDevice.controllers['left'].connected = false;

// Reconnecting the right hand:
xrDevice.hands['right'].connected = true;
```

### Visibility State Change

The `XRSession.visibilityState` is a read-only property influenced by the system's underlying actions, which can affect the visibility state of the XR session. For instance, accessing the system UI in the Meta Quest Browser changes the `XRSession.visibilityState` from "visible" to "visible-blurred". Emulating these changes helps in ensuring that your WebXR experience can gracefully handle interruptions by system UI overlays or notifications:

```javascript
// Simulating a visibility state change to "visible-blurred":
xrDevice.updateVisibilityState('visible-blurred');

// Returning to a fully visible state:
xrDevice.updateVisibilityState('visible');
```

### Recenter

The ability to "recenter" the user's viewpoint, effectively resetting their position within the XRReferenceSpace, is a feature of some XR devices. This action, often triggered by a long press of a system button (e.g., the Meta button on Quest devices), recalibrates the user's position to the center of the reference space. IWER mimics this behavior, offering a method to test how your application responds to such recalibration events:

```javascript
// Emulating a recenter action:
xrDevice.recenter();
```

By incorporating these platform features into your testing process, you can significantly enhance the resilience and user experience of your WebXR projects, ensuring they are prepared for a wide range of real-world user interactions and system behaviors.
