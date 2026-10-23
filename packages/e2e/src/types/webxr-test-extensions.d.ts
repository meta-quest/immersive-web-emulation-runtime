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

// WebXR/WebGPU binding (https://immersive-web.github.io/webxr-webgpu-binding/)
interface XRGPUSubImage extends XRSubImage {
  readonly colorTexture: GPUTexture;
  readonly depthStencilTexture: GPUTexture | null;
  readonly motionVectorTexture: GPUTexture | null;
  getViewDescriptor(): GPUTextureViewDescriptor;
}

declare class XRGPUBinding {
  constructor(session: XRSession, device: GPUDevice);
  readonly nativeProjectionScaleFactor: number;
  readonly usesDepthValues: boolean;
  getPreferredColorFormat(): GPUTextureFormat;
  createProjectionLayer(init: {
    colorFormat: GPUTextureFormat;
    depthStencilFormat?: GPUTextureFormat;
    textureUsage?: number;
    scaleFactor?: number;
  }): XRProjectionLayer;
  createQuadLayer(init: {
    colorFormat: GPUTextureFormat;
    space: XRSpace;
    viewPixelWidth: number;
    viewPixelHeight: number;
    transform?: XRRigidTransform;
    width?: number;
    height?: number;
  }): XRQuadLayer;
  getSubImage(
    layer: XRCompositionLayer,
    frame: XRFrame,
    eye?: XREye,
  ): XRGPUSubImage;
  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRGPUSubImage;
}
