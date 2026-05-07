interface XRInputSourcesChangeEventInit extends EventInit {
  session: XRSession;
  added?: readonly XRInputSource[];
  removed?: readonly XRInputSource[];
}

declare class XRInputSourcesChangeEvent extends XRSessionEvent {
  readonly added: readonly XRInputSource[];
  readonly removed: readonly XRInputSource[];
  constructor(
    type: 'inputsourceschange',
    eventInitDict: XRInputSourcesChangeEventInit,
  );
}

interface XRFrame {
  fillJointRadii(spaces: readonly XRJointSpace[], radii: Float32Array): boolean;
  fillPoses(
    spaces: readonly XRSpace[],
    baseSpace: XRSpace,
    transforms: Float32Array,
  ): boolean;
}

interface XRWebGLLayer {
  readonly context: WebGLRenderingContext | WebGL2RenderingContext;
}
