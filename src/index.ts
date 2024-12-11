/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// model
export { XRDevice, XRDeviceConfig } from './device/XRDevice.js';
export {
	metaQuest2,
	metaQuest3,
	metaQuestPro,
	oculusQuest1,
} from './device/configs/headset/meta.js';

// Initialization
export { XRSystem } from './initialization/XRSystem.js';

// Session
export { XRRenderState } from './session/XRRenderState.js';
export { XRSession } from './session/XRSession.js';

// Frame Loop
export { XRFrame } from './frameloop/XRFrame.js';

// Spaces
export { XRSpace } from './spaces/XRSpace.js';
export { XRReferenceSpace } from './spaces/XRReferenceSpace.js';
export { XRJointSpace } from './spaces/XRJointSpace.js';

// Views
export { XRView } from './views/XRView.js';
export { XRViewport } from './views/XRViewport.js';

// Primitives
export { XRRigidTransform } from './primitives/XRRigidTransform.js';

// Pose
export { XRPose } from './pose/XRPose.js';
export { XRViewerPose } from './pose/XRViewerPose.js';
export { XRJointPose } from './pose/XRJointPose.js';

// Input
export { XRInputSource, XRInputSourceArray } from './input/XRInputSource.js';
export { XRHand } from './input/XRHand.js';

// Layers
export { XRWebGLLayer, XRLayer } from './layers/XRWebGLLayer.js';

// Planes
export { XRPlane } from './planes/XRPlane.js';

// Meshes
export { XRMesh } from './meshes/XRMesh.js';

// Anchors
export { XRAnchor } from './anchors/XRAnchor.js';

// Events
export { XRSessionEvent } from './events/XRSessionEvent.js';
export { XRInputSourceEvent } from './events/XRInputSourceEvent.js';
export { XRInputSourcesChangeEvent } from './events/XRInputSourcesChangeEvent.js';
export { XRReferenceSpaceEvent } from './events/XRReferenceSpaceEvent.js';

// Action Recording/Playback
export { ActionRecorder } from './action/ActionRecorder.js';
