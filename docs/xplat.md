---
outline: deep
title: Cross-Platform Controls with IWER
---

# Bringing Project Flowerbed to PC: Cross-Platform Controls with IWER

## Motivation

The web’s inherent cross-platform nature offers unique opportunities for developers. However, adapting WebXR experiences, which are rich in nuanced interactions, to non-VR platforms like PCs and mobile devices presents distinct challenges. Typically, developers might resort to creating multiple input mechanisms for different platforms, leading to complex and hard-to-maintain code. The Immersive Web Emulation Runtime (IWER) offers a streamlined solution by serving as an input remapping layer, simplifying the adaptation process. This article details my journey in implementing intuitive cross-platform controls for [Project Flowerbed](https://flowerbed.metademolab.com/), a WebXR showcase with intricate interactions, using IWER.

## Locomotion

![locomotion](/iwer-locomotion.gif)

One of the first challenges I faced was enabling players to move around in the gorgeous environment of Project Flowerbed. On PC, first-person movements are typically controlled using the WASD keys for movement and the mouse for camera direction. Project Flowerbed, originally designed for VR, utilizes sliding locomotion where movement is controlled by a joystick and the camera by the player’s head movement. To adapt this, I mapped the WASD keys to control the emulated joystick via IWER and the mouse movement to control the emulated headset's rotation. This setup allows PC players to navigate Project Flowerbed as smoothly as they would in any first-person PC game.

## Simple One-Handed Interactions

![open-menu](/iwer-open-menu.gif)

Most interactions in Project Flowerbed, as with many XR applications, involve simple one-handed interactions that consist of two basic steps: point and click. This includes indirect interactions such as raycasting or direct interactions like grabbing virtual objects. These interactions are straightforward to adapt to PC controls as well.

### Pointing:

In VR, pointing is usually done with controllers. In Project Flowerbed, this translates to PC by coupling the mouse with the camera movement. By constructing a player rig that includes controllers and a headset, with controllers parented under the headset, pointing on a PC becomes intuitive. As the player rotates the headset view with the mouse, the controllers follow, allowing for accurate pointing.

### Clicking:

I use "clicking" to refer broadly to actions like pressing, holding, and grabbing. On PC, these can be mapped to keyboard and mouse buttons in a way that is ergonomic and logical. For instance, in Project Flowerbed, I mapped the F key to trigger the main action wheel (originally the A button in VR), and the left mouse button to mimic shooting a seed, corresponding to the right trigger in VR.

### One-Handed Gestures:

![photo-drop](/iwer-photo-drop.gif)

Addressing straightforward point-and-click interactions laid a solid foundation for handling more complex one-handed gestures. For example, the drag-and-drop action to save or delete a photo in Project Flowerbed breaks down into a sequence of point-and-click actions. By leveraging IWER, implementing these gestures on PC became straightforward.

## Complex Gesture-Based Interactions

![seed-selection](/iwer-seed-selection.gif)

More intricate interactions that involve relative motion between two hands, like selecting a seedbag with one hand from a seedbox attached to the other, required a creative approach. On PC, since both hands are typically attached to the camera rig, achieving this relative motion means temporarily decoupling one hand. In planting mode, holding the right mouse button decouples the left hand (seedbox), allowing the player to select a seedbag with the other hand. Releasing the right mouse button then snaps the left hand back under the camera rig.

For scenarios requiring complex gestures or patterns to trigger specific actions in XR, consider using the Action Recorder to pre-record these sequences. These can then be played back on PC by mapping them to keyboard or mouse events. For more details on how to use the Action Recorder, check out [this guide](/action).
