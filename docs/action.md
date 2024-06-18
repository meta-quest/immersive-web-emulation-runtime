---
outline: deep
title: IWER in Action
---

# IWER in Action

The following section introduces the Immersive Web Emulation Runtime (IWER) implemented within a three.js-powered WebXR demo. This demo smartly detects whether you are accessing from a browser lacking native WebXR support and automatically installs IWER's WebXR runtime, allowing entry into XR in emulation mode. In this mode, a simple GUI at the top right corner lets you interact with a selection of IWER's features like toggling stereo rendering and managing XRVisibilityState, alongside exploring an **experimental input playback** feature.

## Live WebXR Demo

Below is the live demo which uses three.js. It includes preloaded actions captured on a Meta Quest 3 device. For those with WebXR-ready browsers, it's possible to capture your own actions within this demo environment.

<iframe src="https://felixtrz.github.io/iwer-demo/"
        width="100%"
        height="500"
        frameborder="0"
        allow="xr-spatial-tracking; fullscreen"
        allowfullscreen>
    Your browser does not support iframes.
</iframe>

## Comparative Video

Here's a screen recording from the same session captured for the demo, providing a visual reference of the actions included in the live demo.

<video width="100%" controls>
  <source src="/cap.mp4" type="video/mp4">
  Your browser does not support the video tag.
</video>

## Action Recording & Playback <Badge type="warning" text="beta" />

Recording and replaying user actions in WebXR are some of the most requested features among the WebXR developer community for their potential to simplify debugging and automate testing. The primary use cases include:

- **Debugging**: Capture user actions that lead to issues or crashes in your WebXR apps. Replay these actions in a developer-friendly environment to robustly reproduce and troubleshoot issues.
- **Automated Testing**: Automate end-to-end testing, reducing the reliance on manual QA, which is traditionally labor-intensive for WebXR applications.
- **Motion Capture**: Record brief sequences of user actions to generate motion capture data, enhancing the realism and interactivity of your WebXR content.

### How Does Recording Work?

IWER’s `ActionRecorder` functions independently from its WebXR runtime and is typically utilized in environments where native WebXR support is available. During each animation frame, `ActionRecorder` captures data directly from the `XRSession` and `XRFrame`. This includes recording the transforms of the headset and input sources relative to the root `XRReferenceSpace`. It also captures the component states within the input sources, such as button presses and joystick movements from the associated `Gamepad` objects.

#### Handling Input Source Switching

To handle scenarios where input sources may change during a session, `ActionRecorder` listens for input source events. Upon detecting a new input source, it constructs an input schema that includes details like the profile ID and input type, and then it starts tracking data for that input source.

### How to Record an Input Session?

1. **Initialize the Recorder**:

   ```javascript
   import { ActionRecorder } from 'iwer';

   onSessionStarted(xrSession) {
       const refSpace = await xrSession.requestReferenceSpace('local-floor');
       recorder = new ActionRecorder(xrSession, refSpace);
   }
   ```

2. **Start / Stop the Recording**:

   ```javascript
   let recording = false;

   onButtonPress() {
       recording = !recording;  // Toggle recording state
   }

   onFrame(xrFrame) {
       if (recording) {
           recorder.recordFrame(xrFrame);
       }
   }
   ```

3. **Access the Recorded Data**:
   ```javascript
   recorder.log(); // Outputs the recorded data as a JSON string in the console
   ```

### How does Playback Work?

`ActionPlayer`, unlike `ActionRecorder`, integrates closely with IWER’s WebXR runtime and connects directly to the `XRDevice` class. It uses the root `XRReferenceSpace` from your WebXR app to accurately reconstruct input data for playback.

#### Achieving Playback Accuracy

Due to hardware and framerate variations, achieving perfect playback accuracy can be challenging. For example, discrepancies in frame rates between recording (e.g., 72 fps) and playback (e.g., 60 fps) devices can cause subtle speed variations in the playback of recorded sessions. `ActionPlayer` mitigates this by interpolating between frames based on timestamps to maintain consistent motion during playback.

### How to Play a Captured Session?

1. **Initialize the Player**:

   ```javascript
   let capture = JSON.parse(capturedJSONString);
   let player;

   onSessionStarted(xrSession) {
       player = xrdevice.createActionPlayer(refSpace, capture);
   }
   ```

2. **Control Playback**:
   ```javascript
   player.play(); // Starts playback from the beginning
   player.stop(); // Stops the playback
   ```
