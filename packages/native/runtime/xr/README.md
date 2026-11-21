# runtime/xr: OpenXR session, the XR frame loop and IWER host mode's frame record (M3)

The native side of WebXR. One OpenXR instance and session per runtime, owned by a dedicated XR thread; the page's
WebXR object model is IWER host mode (`iwer/host`, the only WebXR implementation in the runtime), driven through
one shared frame record that native code writes in place and JS reads in place. JS side: `web/xr` (the prelude
that installs IWER on `navigator.xr` and implements its `XRHostBackend`).
Spec: `docs/spec/08-openxr-session-frame.md` (XR-_), `09-iwer-host-frame-record.md` (XRF-_), `10-input.md` (IN-\*),
plus DBG-SHOT, DBG-STATS (xr section), GL-PERF-5, LOG-3, PROC-7, REG-6, REG-18.

Sources: the behaviour spec (`docs/spec/`), IWER's host contract (`packages/iwer/src/host/types.ts`,
`HOST-INPUT.md`), the OpenXR 1.1 specification and the extension specifications named in the code
(XR_KHR_opengl_es_enable, XR_KHR_android_create_instance, XR_KHR_loader_init_android, XR_KHR_convert_timespec_time,
XR_FB_display_refresh_rate, XR_FB_foveation, XR_FB_foveation_configuration, XR_FB_swapchain_update_state,
XR_FB_color_space, XR_EXT_performance_settings, XR_EXT_hand_tracking, XR_FB_hand_tracking_aim,
XR_EXT_hand_interaction, XR_META_hand_tracking_microgestures, XR_META_touch_controller_plus,
XR_FB_touch_controller_pro, XR_FB_passthrough, XR_META_passthrough_preferences, XR_FB_spatial_entity,
XR_FB_spatial_entity_query, XR_FB_spatial_entity_container, XR_FB_scene, XR_META_spatial_entity_mesh,
XR_FB_scene_capture, XR_META_environment_depth), QCOM_texture_foveated, EGL 1.5 and
OpenGL ES 3.2 (shared objects, sync objects), the JNI specification and Android SDK/NDK references, V8 embedder
headers, and our own runtime contracts (core `runtime.h`, `event_loop.h`, gl `iwn/gl.h`). Third-party code: the
Khronos OpenXR loader 1.1.63 with its vendored jnipp and android-jni-wrappers, and jsoncpp (THIRD_PARTY.md,
"runtime/xr + web/xr"); gl-matrix inside IWER (web/xr).

## Layout

| path                                                                                            | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout/frame-record.json`                                                                      | the one definition of the frame record (XRF-4); `gen/generate-layout.mjs` writes `include/iwn/xr/frame_record_layout.gen.h` (C++ byte offsets) and `web/xr/src/layout.gen.ts` (typed-array indices); `--check` fails on a stale file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `include/iwn/xr/*.h`, `src/core/*.cc`                                                           | **iwn_xr_core**, V8-free and OpenXR-call-free: the record writer, input mapping (HOST-INPUT layouts), frame pacing, the performance-level policy, the session-lifetime policy, the `xr` config section and foveation parameters, the PNG writer, the XR/JS thread handoff, the loading screen's policy, placement, layout and spinner image (`loading.h`), the composition-layer buffer and entry geometry (`layers.h`)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/android/xr_system.{h,cc}`                                                                  | the XR thread: instance, session, spaces, swapchain, foveation, passthrough, events, the frame loop, stats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/android/xr_depth.{h,cc}`                                                                   | environment depth for `depth-sensing` (XR_META_environment_depth): provider, depth swapchain, per-frame acquire into the depth record (`include/iwn/xr/depth_record.h`, its own buffer next to the frame record)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/android/xr_input.{h,cc}`                                                                   | OpenXR actions for Touch / Touch Plus / Touch Pro controllers and the hand interaction profile (poses, microgestures), hand tracking + aim, haptics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/android/xr_layers.{h,cc}`                                                                  | quad and cylinder layers (XR-LAYER-1): a swapchain per layer (sRGB, drawn through RGBA8 texture views), its acquired image, release of redrawn images, the frame's `XrCompositionLayerQuad` / `XrCompositionLayerCylinderKHR` structs in `renderState.layers` order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/android/xr_loading.{h,cc}`                                                                 | the loading screen's swapchains (static: the splash card, the spinner, the background colour) and its composition layers; the splash PNG's decode (image module)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/android/xr_scene.{h,cc}`                                                                   | the room from Space Setup for plane detection, mesh detection and hit test (XR-AR-2): scene queries, entity geometry snapshots, per-frame entity poses in a pose table of its own; host-tested against a fake runtime (`test/host/fake_openxr.h`, `iwn_xr_android_tests`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/android/xr_shot.{h,cc}`                                                                    | eye-buffer screenshots for the debug endpoint's `shot` (readback on the XR thread, PNG on an encoder thread)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/android/egl_xr.{h,cc}`                                                                     | the XR thread's EGL context in the WebGL share group, cross-context fences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/android/jni_android.{h,cc}`                                                                | JavaVM and Activity lookup for the loader and `xrCreateInstance` (through `ActivityThread`, non-SDK fields, Application context as the fallback; follow-up: take the NativeActivity's object from the app module instead)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/v8/xr_binding.cc`                                                                          | `iwn_register_xr`: `globalThis.__iwn.xr`, the core FramePump, `shot`, the `xr` stats section, the shutdown hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/android/xr_camera.{h,cc}`, `include/iwn/xr/camera_convert.h`, `src/core/camera_convert.cc` | the passthrough cameras for getUserMedia (XR-CAM-1): Camera2 NDK on the cameras Horizon OS tags as passthrough (left, right), an `AImageReader` of YUV_420_888, each frame converted to RGBA8 on the reader's thread (full-range BT.601, host-tested) into a pool of four AHardwareBuffer pixel stores, rewritten in place once released, the one released longest ago first (recycled stores: whatever keeps a frame gets a copy, runtime/image INTEROP.md); nothing reads the camera list or opens a camera until CAMERA and HEADSET_CAMERA are held (Horizon OS keeps a list read before the grant empty); open/close on a worker thread, opens queued at shutdown refused and one already opening closed after it; a progress line every 300 frames; host-tested against a fake camera service (`test/host/fake_camera.h`, `iwn_xr_camera_tests`) |
| `src/v8/camera_binding.cc`                                                                      | `iwn_register_camera` (registered from this library): `globalThis.__iwn.camera` (`declared` from config `xr.features.camera`, `permitted`, `devices`, `hidden`, `open`, `frame` as an image-module handle, `close`, a coalesced per-frame task), the `camera` stats section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `manifest/vr-manifest.json`                                                                     | manifest entries every XR APK needs (OpenXR permissions and broker queries, VR category, head tracking, focus awareness, hand tracking, passthrough); the packager template (`packager/template/AndroidManifest.xml`) carries them, `tools/build-xr-apk.mjs` adds them to the runtime's test template                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/host/`                                                                                    | host unit tests (`iwn_xr_core_tests`, 89 tests, incl. the frame handoff with real threads, input mapping (hands, controllers, microgestures) and the loading screen's hand-over and placement, the camera's YUV conversion), the src/android tests against fakes (`iwn_xr_android_tests`: scene and anchors on a fake OpenXR runtime; `iwn_xr_camera_tests`: the cameras on a fake camera service whose list is fixed when the camera manager is made, with fake NDK headers in `fake_ndk/`), `iwn_xr_depth_tests` and `iwn_xr_record_dump` (a record written by the native writer, read by web/xr's round-trip test)                                                                                                                                                                                                                                 |
| `tools/`                                                                                        | device-check tooling: `m3-check.mjs` (the M3 device check), `xr-check.mjs` (eval/stats/shot/watch over the debug endpoint), `build-xr-test-apk.mjs` + `xr-test-app/` (the pipeline test app and its variants; the same `main.js` runs in Quest Browser through `browser-ab.mjs` for A/B checks), `build-showcase-apk.mjs` (+ `showcase-dom/dom-shim.js`, TEST-ONLY DOM scaffolding until a DOM module exists), `build-xr-apk.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                     |

## How it works

**Threads (PROC-1, XR-IDLE-1).** `iwn-xr` makes every OpenXR call and owns its own EGL context, created in the GL
module's share group (`iwn::gl::RootContext()`), so the swapchain textures OpenXR creates are names every WebGL
context can use; that context is the one bound to the session (`XrGraphicsBindingOpenGLESAndroidKHR`) and it is
current on the XR thread only. The JS thread (`iwn-js`) runs the page's frame callbacks through the core's
FramePump. The XR thread never waits for JS longer than one display period (`xr.frameDeadlinePeriods`): during a
long task (module evaluation at boot, a debugger pause) it keeps submitting frames, so the system never sees an
unresponsive app, and the last finished image is re-submitted (reprojected by the compositor). After a frame JS
never began, and for a session's first frame (first-sight compiles and uploads), it waits only 0.15 periods, so idle
frames keep their cadence; such a frame is collected whenever JS finishes it.

**The frame handoff (`FrameSlot`, `include/iwn/xr/handoff.h`).** One slot: the XR thread posts a frame, JS begins and
finishes it; exactly one of JS's begin and the XR thread's cancel wins. A frame that JS began and the frame loop has
not collected is the slot's own running/done state, never a separate flag. Commands from the JS thread (session
start and end, swapchain creation, frame rate, foveation, haptics) run on the XR thread between OpenXR calls and
while it waits for a frame; a command that drops the swapchain withdraws a posted frame JS has not begun, and the
waiting frame loop learns that (`conclude()`: done, cancelled, withdrawn, still running), so a page that ends its
session or reloads while a frame is posted gets frames again in its next session (round 1 stalled there for good).

**One frame (XR-LOOP-1).** `xrWaitFrame` -> `xrBeginFrame` -> acquire + wait the swapchain image -> locate the views,
the LOCAL and VIEW spaces and input for the predicted display time, all in one base space (STAGE when the runtime
has it, else LOCAL: XRF-3) -> write the frame record -> hand the frame to the JS thread (FrameSlot) -> JS: the record
becomes IWER's `XRHostFrame` (the same object every frame, its arrays are views onto the record), the input states
are copied in with one `TypedArray.set` per field (XRF-IN-2 fallback; IWER owns its arrays), the session's opaque
texture is pointed at this frame's image, `runHostFrame` runs the session's callbacks then window rAF, depth/stencil
of the framebuffers holding the opaque texture are invalidated (GL-PERF-5), the session's WebGL context is fenced,
the image is parked (below) -> XR thread: `glWaitSync` on that fence in its own context -> release -> `xrEndFrame`
with one projection layer whose views carry the poses and FOVs JS rendered with (XR-SC-4). Views come from
`xrLocateViews` only when OpenXR marks the orientation valid (else the last located views stay; before the first
valid pose no JS frame runs); an invalid position keeps the last position. With `shouldRender` false, or while the
session is not visible, no session callbacks run and window rAF gets a tick instead (XR-LOOP-2, XR-IDLE-2).

**The record (XRF-1..7).** 2368 bytes allocated once, exposed as an `ArrayBuffer` with an external backing store
(sandbox off); layout version first, f64 times, f32 poses/FOVs (a pose 50 m out keeps ~4 um steps), per-hand
input blocks in HOST-INPUT order, reserved fields for depth/motion images, scene changes, gaze and viewport scale.
The JS adapter refuses to run sessions against a record whose version differs (XRF-4). Predicted display time is
OpenXR's converted to the `performance.now()` clock (XR_KHR_convert_timespec_time) and strictly increasing
(XR-LOOP-5); window rAF gets the frame's start time (TMR-5).

**Swapchain and layers (XR-SC-1..4).** The first layer creates the swapchain: `texture-array` -> one 2-layer image
(multiview; MSAA comes from the app's multisampled multiview attachment, GL-24), `texture`/`XRWebGLLayer` -> one
side-by-side image; size = recommended eye size x `scaleFactor` x `xr.eyeBufferScale`, clamped; RGBA8 unless the
page asks for another supported format; 1 mip, sample count 1. `getViewSubImage` hands out one `WebGLTexture` per
session whose GL name follows the acquired image (the WebGL prelude's `retargetTexture` re-points it and
re-attaches it in every framebuffer that holds it), so an app that attaches once renders into the current image
every frame (REG-6). Between frames the image belongs to the compositor, so after the fence it is **parked**: the
opaque texture points at no image and an `XRWebGLLayer` framebuffer's colour is detached, in GL only (the WebGL
binding's record, and with it IWER's, stays), until the next frame begins. Drawing to them from a timer or task then
reaches no image, as WebXR specifies for opaque framebuffers (XR-SC-3).

**Quad and cylinder layers (XR-LAYER-1, `xr_layers.h`).** Each `createQuadLayer` / `createCylinderLayer` gets a
swapchain of its own (`beginLayerSwapchain`), which keeps one image acquired for the page; its GL name reaches the
page through a buffer of its own (`iwn/xr/layers.h`, `__iwn.xr.layers()`, not the frame record), and the layer's
`WebGLTexture` follows it during frames and is parked between them, like the projection layer's. Each frame the
adapter writes `renderState.layers` into that buffer (pose in the base or VIEW space, shape, layout, whether the page
drew the layer); once the frame is fenced the XR thread releases the drawn layers' images and submits the list in
order around the projection layer, one struct per eye for stereo layouts. A layer the page does not draw keeps its
last content. Which images a frame releases and which layers it shows is `layers::collect()` in the host-tested core.
Layers listed before the projection layer make it blend by its alpha (else they would never show); a session with
only quad or cylinder layers ends the loading screen. Horizon OS reads RGBA8 quads as linear (unlike the RGBA8
projection layer), so the swapchains are SRGB8_ALPHA8 and the page draws into RGBA8 texture views of their images;
a mono `texture-array` layer draws into one-layer 2D-array views (OpenXR hands out 2D images for an array size of 1).

**Foveation (XR-FOV-1).** `fixedFoveation` 0..1 maps to none/low/medium/high (round(v x 3)); the Quest Browser
feature strings and `xr.foveation` set the start value, applied before the first frame. The level goes to OpenXR as
an XR_FB_foveation profile on the swapchain, and, because QCOM_texture_foveated state that the OpenXR runtime sets
from the XR thread's context is not in effect for rendering in the page's WebGL context (measured: same GPU time at
none and high), the runtime also sets the feature bits, minimum density and per-eye focal parameters from the
WebGL context at the end of a frame (`js_apply_foveation`, restoring the texture binding, no GL error left
behind). Our parameters: focal point = each eye's projection centre; full density within 0.5 / 0.33 / 0.25 NDC of
it for low / medium / high, minimum density 1/2, 1/4, 1/4. Measured on Quest 3S, a fragment-bound frame:
6.31 ms none, 5.62 low, 4.31 medium, 3.72 high; the showcase's App GPU at one view 8.84 -> 7.05 ms at high. Only a
change of level reaches the XR thread (IWER forwards every `fixedFoveation` assignment; an app that assigns it each
frame costs nothing extra).

**Performance levels (XR-PERF-1/2).** XR_EXT_performance_settings: CPU starts at `sustained-low` (VrApi CPU level 2,
Quest Browser's), GPU at the runtime default (VrApi level 2). Three missed display periods within 1 s raise the
domain that looks limiting (CPU when the JS frame time is above 80 % of the period); 10 s without a miss steps down
one level, never below the start (a GPU raised from the default comes back to `sustained-low`). Misses in the 3 s
after a session starts, its first frame, a resume or a refresh-rate switch are ignored (compiles, uploads, the
compositor resuming or changing rate). A
raise within 30 s of a step down doubles the headroom needed for the next one (up to 5 min), so levels do not
oscillate. Runtime notifications are logged and counted.

**Loading screen (XR-IDLE-1, `loading.h`, `xr_loading.cc`).** Before the app's first projection layer, and whenever the
page has no WebXR content (a reload, between sessions), the idle presentation submits the loading screen instead
of an empty frame: Horizon OS removes its launch transition when the app's session becomes visible, so an empty
frame showed the user black (or the dimmed shell) for the seconds V8, the bundle and the first-sight compiles take.
The packer writes the app's splash image to `assets/vr_splash.png`, which Horizon OS also shows as the system splash
(`com.oculus.ossplash`) while the process starts; the runtime shows the same image as a quad layer at the system
splash's distance and size (6 m, fitted to 80 x 20 degrees, so the system splash turns into the loading screen
without moving), a spinner quad below it turned by its pose each frame (no per-frame GL work), and behind them the
background (`LoadingBackground`). What shows behind a frame without an opaque layer is up to the system (Horizon OS
can show passthrough there: quads alone showed the room to a user who came from a virtual home), so the loading
screen always submits a background of its own: an opaque uniform projection layer (black, or the configured
colour; head-locked in the view space and wider than any field of view, so it covers the view without a head pose),
or for a contextual background a passthrough layer the runtime submits itself (XR_FB_passthrough, reconstruction
purpose; Horizon OS offers the extension only to apps whose manifest declares `com.oculus.feature.PASSTHROUGH`,
which is why the packer makes "contextual" the default for those apps and refuses it for the others) when the
user comes from passthrough: at launch when the system recommends it (`XR_META_passthrough_preferences`'
`DEFAULT_TO_ACTIVE` bit: the user's home is passthrough; asked once, no manifest entry needed), after a reload or a
session end when the session that ended showed passthrough (black after an immersive-vr session, whatever the
home). A passthrough that cannot be started falls back to the opaque layer. The passthrough and its layer are
shared with an immersive-ar session and stopped once nothing shows them (after the hand-over to a VR session). The
packer pairs "contextual" with `com.oculus.ossplash.background` = `passthrough-contextual`, the system splash's own
contextual background; the shell decides that one by whether it shows passthrough at launch, so in rare cases (a
virtual home with passthrough switched on, a launch from another app) the system splash and the loading screen
disagree. Which layers each frame submits is `plan_frame_layers()` (loading.h, host-tested): besides the loading
screen, a session's frames without an app frame (between a resume and the page's next frame, a frame without a
head pose) carry the opaque layer too unless the session shows passthrough, so no frame is left empty
(`frames.covered` in stats, one log line per run). Every image lives in a static,
single-level sRGB swapchain filled once on the XR thread (Horizon OS reads an RGBA8 quad as linear: the splash's
colours came out washed; a mipmapped quad made the compositor compile a shader the first time it met one, ~200 ms
with the card not drawn). Placement (`LoadingPlacement`): with the head within 30 degrees of level, the quads sit on
the horizon straight ahead, upright, where Horizon OS draws its splash; with the head pitched further (lying down,
looking at the floor, a headset lying face up) the system splash is out of view, so they go where the head
looks, centred on the gaze and upright for the viewer. They stay put (world-locked; the position follows the head)
and glide back (shortest rotation, 140 ms time constant) once the gaze is more than 35 degrees from the card in any
direction; head-locked until tracking reports an orientation. The splash PNG is read on the JS thread at
registration and decoded on its own thread while OpenXR starts (13-22 ms on device). The app's first projection
layer starts the hand-over: that frame still carries the loading layers opaque over the app's layer at colour scale
0, then both cross-fade over 250 ms (XR_KHR_composition_layer_color_scale_bias; without it the switch is one frame):
from the background colour, or over a passthrough background the app's opaque frame at once under the fading quads
(a fade from black would dim the room to black first), and an immersive-ar frame blends in over its passthrough
(colour and alpha scaled).
After a loading period shorter than the fade (the page ended its session and entered the next one at once) the app
comes back in one frame. A pause is not a loss of content (no loading flash on resume); a page end or reload is.
The card and spinner swapchains (about 2 MB) stay allocated after the hand-over so a reload can show them again; no
loading layers are submitted then. Config: `xr.loading` (`enabled`, `image`, `background`, `distance`, `heightDeg`,
`maxWidthDeg`, `spinner`, `fadeMs`, `followDeg`), written by the packer from `native.splash`.

**Session lifecycle (XR-LIFE-1..7, XR-IDLE-\*).** `xrBeginSession` on READY (colour space, refresh rate, performance
levels before the first frame). `offerSession` is granted as soon as it is made (IWER `autoGrantOfferedSession`)
unless the config (`xr.grant: "explicit"`) or the launch extra (`am start --es iwn.xrGrant explicit`, debuggable
builds) holds it until `__iwnXR.grantSession()`. Between sessions and before the first one the runtime keeps
submitting frames (the loading screen, or no layers when it is off) and drives window rAF at the display rate. **Pause** (sleep, the system
taking over the display: OpenXR STOPPING) keeps the page's WebXR session: it turns `hidden`, its swapchain stays,
`xrEndSession` is called, and frames resume on READY with the same session (XR-LIFE-4). **System end** (EXITING,
LOSS_PENDING) fires `end` and exits. **Page end**: the swapchain is freed, the idle presentation follows, and with
no new session requested within `xr.endGraceMs` (2 s) the runtime asks OpenXR to exit (XR-LIFE-5). A
`requestSession`/`offerSession` within it starts a new session at once and stops the clock while it is pending (a
re-offer held in explicit-grant mode waits for the grant); if every such request is rejected, the grace period runs
again from the rejection. **Reload** (`location.reload()`, DevTools `Page.reload`; PROC-8): the old page's session
ends with it and the timers start over for the new page: no end grace period while it boots (IWSDK apps take ~5 s
to offer again), XR-LIFE-7 from its own `load`, so a debug build stays reachable even when the new page throws
(PROC-9). **Never offered**: an error line 10 s after `load`, exit at 30 s unless the inspector or debug endpoint is served
(XR-LIFE-7). A pending request or offer counts as offered; when every one the page made was rejected (a required
feature this release does not grant, `immersive-ar` without the opt-in) and no session exists, the same timers
apply, counted from `load`, with an error line that names the rejection. The activity's **onDestroy** stops the XR
thread and tears OpenXR down in the shutdown hook; an activity relaunched in the same process gets a new XR thread,
instance and session. If an OpenXR call blocks the XR thread past the 3 s stop timeout, the thread is left behind
cut off from the Runtime and the JS loop, and XR stays off until the process restarts.

**Input (IN-1..7).** One action set bound for the Touch, Touch Plus and Touch Pro profiles: grip/aim poses, trigger
value + click (OpenXR's own threshold with hysteresis decides `pressed`: IN-3), squeeze, thumbstick (+y flipped to
WebXR's toward-the-user), clicks and touches, thumbrest, left menu, haptics; and for the hand interaction profile
(XR_EXT_hand_interaction): aim/grip poses and, with XR_META_hand_tracking_microgestures, the five microgesture clicks
(the startup line `xr: hands: ... bound` says which). Hands or controllers follow the interaction profile Horizon OS
reports per hand, as in Quest Browser (IN-4): a Touch profile with active pose actions is a held controller and wins;
otherwise a tracked hand (XR_EXT_hand_tracking `isActive` with a valid wrist position; a hand without one is not
listed, as in Quest Browser) is a hand when the session enabled `hand-tracking`, and a pointer when it did not
(controller mode: the hand's aim as the target ray, the palm as grip, the pinch as trigger, no joints).
khr/simple_controller is not suggested: Horizon OS binds tracked hands to it when no hand profile is
suggested, which listed hands as controllers. Hands: OpenXR joint i+1 -> WebXR joint i, palm separate,
XR_FB_hand_tracking_aim for the target ray, pinch (index-pinch -> button 0), the system gesture (menu -> button 4) and
the microgestures on buttons 5-9 (swipe left, right, forward, backward, thumb tap; pressed for the frames the runtime
reports the gesture, about 35 ms); without the aim extension a thumb-index distance with hysteresis (press < 1.5 cm,
release > 3 cm) and a knuckle-based ray. Each change of what a hand shows is logged (`xr: left input: controller ->
hand (profile ...)`). Haptics: amplitude, duration, unspecified frequency for 0; a new pulse replaces the running one;
`pulse()` resolves true after the duration. Numbers from JS reach the natives range-checked (NaN or out of range
falls back to the default; no undefined float-to-integer conversions).

**Depth sensing** (XR-DEPTH-2): when the system has XR_META_environment_depth, `depth-sensing` is granted
(`gpu-optimized`; `unsigned-short` or `float32`). A session that enables it starts one depth provider (hand removal
off, as in Quest Browser; it needs `com.oculus.permission.USE_SCENE`, granted, or the provider is refused and frames
carry no depth); each WebXR frame acquires the newest image for its predicted display time in the base space (about
0.25 ms on Quest 3) and writes its swapchain name, size, near/far and both depth views into the depth record; web/xr
hands it to IWER as `XRHostBackend.getDepth()`, one session-long texture re-pointed at each image, and for
`matchDepthView` (the default) lays it out in the frame's render views with a pass on the page's context
(`XRHostBackend.reprojectDepth`, web/xr `depth-reproject.ts`), as Quest Browser 156 does. The provider stops with the
session, once a JS frame in flight is collected. While depth sensing runs, web/xr also clears the framebuffers holding
the frame's image (projection layer or XRWebGLLayer) before the frame's callbacks (three.js skips its own clear then).
Log: `xr: depth: ...` lines and a periodic `xr-depth` line (images, frames without one, acquire cost); stats: the
`depth` section.

**What this release does not offer** (XR-LIFE-1 later features): `plane-detection`, `mesh-detection`, `hit-test`
and `anchors` are never granted (required -> `NotSupportedError`, optional -> dropped; the
anchor calls reject with `NotSupportedError`), `bounded-floor` is withdrawn when the headset has no boundary,
`immersive-ar` (passthrough under the projection layer, XR_FB_passthrough) exists behind `xr.immersiveAr: true`
only and is not device-validated, equirect and cube layers are absent (quad and cylinder layers exist,
XR-LAYER-1), no dom-overlay/secondary views/camera (XR-SEC-1).

## Config (`assets/iwn/config.json`, `xr` section)

```
"xr": { "frameRate": 90, "foveation": "medium" | 0..1 | {"level": "medium", "dynamic": false},
        "grant": "auto" | "explicit", "endGraceMs": 2000, "neverOffered": {"errorMs": 10000, "exitMs": 30000},
        "perf": {"cpu": "sustained-low", "gpu": "default", "cpuMax": "sustained-high", "gpuMax": "sustained-high",
                 "adaptive": true},
        "eyeBufferScale": 1.0, "colorSpace": "rec709", "frameDeadlinePeriods": 1.0, "disableExtensions": [],
        "immersiveAr": false, "features": {...},
        "loading": {"enabled": true, "image": "vr_splash.png", "background": "contextual" | "black" | "#000000",
                    "distance": 6, "heightDeg": 20, "maxWidthDeg": 80, "spinner": true, "fadeMs": 250,
                    "followDeg": 35} }
"stats": { "logIntervalMs": 2000 }      // the periodic xr-stats logcat line
```

The packer writes `frameRate`, `foveation`, `features` and `loading` (`enabled`, `image`, `background`, from
`native.splash`) from `iwsdk.config.json`; the rest are runtime defaults.

## Debug surface

`stats` has an `xr` section: OpenXR state and visibility, swapchain, foveation, performance levels (raises, lowers,
runtime notifications), frame counters (XR frames, JS frames, ticks, frames JS never began (`cancelled`), frames a
command took back (`withdrawn`), frames with no valid pose yet (`untracked`), late frames, stale re-submits, a
session's frames without an app frame that carried the opaque background (`covered`), missed periods), wait/JS/end
timings, boot marks (OpenXR ready, session running, first idle frame, first loading frame and
first visible one, session granted, first XR frame,
longest gap between submitted frames before it while the app is visible: `maxIdleGapMs`, XR-IDLE-1), the latest
session's grant -> first frame time (XR-IDLE-3), input profiles and modes, and a `loading` section (phase
`loading`/`handover`/`app`/`off`, card size, `background` (`colour` or `passthrough`), `contextual`,
`passthroughAvailable` (the app can show passthrough: XR_FB_passthrough with the system's capability), the system's
`passthroughRecommended` at launch (true/false, null when unknown or not asked), frames shown, hand-overs, the last
loading period's length, and `anchor`: where the card was in the latest frame that showed it, `yawDeg`/`pitchDeg`,
with the head's `headPitchDeg`).
The log says where OpenXR's start went (`xr: OpenXR ready in N ms (context, loader, instance, system, EGL, session,
spaces, input)`) and when the loading screen came up, its background and why (`xr: loading screen background
(start): black (configured)`, `... (start): passthrough (contextual: the system recommends passthrough (the user's
home is passthrough))`, `... (content lost): black (contextual: the session that ended showed no passthrough)`),
when its passthrough started and stopped, where it was placed (`placed on the horizon ahead` or `placed along the
gaze`), became visible and handed over, and how many frames after a resume carried the opaque background. A boot gap above 2 display periods also
logs where it went (`xr: boot gap ...`, at most 5 lines). `shot {eye, scale}` returns the next finished eye buffer as
a PNG (DBG-SHOT). JS diagnostics: `globalThis.__iwnXR` (`grantSession()`, `device`, `record`, `capabilities()`,
`stats()` incl. `parks`, `gl()`) and `__iwn.xr.debugFoveation()` (reads the current image's QCOM foveation state
in the page's context without touching its GL error state).

## Build and test

```bash
# host (V8-free core) and the JS adapter
cmake -S runtime -B <host-build> -G Ninja -DIWN_TOOLCHAIN_DIR=<clean toolchain> -DIWN_THIRD_PARTY_DIR=<third-party trees> && ninja -C <host-build> iwn_xr_core_tests iwn_xr_record_dump
<host-build>/xr/iwn_xr_core_tests                        # 84 tests
node runtime/xr/gen/generate-layout.mjs --check
(cd web/xr && IWN_XR_RECORD_DUMP=<host-build>/xr/iwn_xr_record_dump npm run verify)   # typecheck + 35 tests

# device: libiwernative.so (release/build-release.sh flags, or the Android build of runtime/), then
node runtime/xr/tools/build-xr-test-apk.mjs --out apks/xr-test-default.apk --toolchain <clean toolchain>
node runtime/xr/tools/build-xr-test-apk.mjs --out apks/xr-test-webgllayer.apk --toolchain <...> --mode webgllayer
node runtime/xr/tools/build-xr-test-apk.mjs --out apks/xr-test-nooffer.apk --toolchain <...> --mode nooffer
node runtime/xr/tools/build-xr-test-apk.mjs --out apks/xr-test-noext.apk --toolchain <...> --package com.iwernative.xrtest.noext \
     --config runtime/xr/tools/noext-config.json          # every optional extension withheld (XR-INIT-1)
node runtime/xr/tools/build-showcase-apk.mjs --dist <proto-showcase-vr dist> --out apks/showcase.apk --toolchain <...>
node runtime/xr/tools/m3-check.mjs --adb "adb -s <serial>" --apks apks --out <dir>
# more reload / re-entry trials: --cases reload,reentry --repeat 3
# the showcase reloaded through the debug endpoint and DevTools: --cases showcasereload; per-frame allocation: --cases alloc
```

The toolchain root holds Android SDK build-tools 35 + platform 34 and NDK r30 from dl.google.com, and the V8 15.5
prebuilt.

## Device results (debug APKs, V8 15.5.35.25)

**Loading screen background (2026-10-21, revision 2)**: proto-showcase-vr packed with the default `native.splash`
(VR: black) and a variant that declares passthrough (contextual), each launch recorded with `screenrecord` and
classified per frame (the view outside the card: black, the passthrough view of the room, or bright), from the
passthrough home and from a virtual home, with and without a system setting that shows passthrough behind frames
without an opaque layer (the stand-in for a build that shows passthrough there), on three Quest 3S (one lying face
up) and a Quest 3.

- These builds show black behind a frame without an opaque layer; with the setting on they show passthrough there,
  which is how revision 1's "no layer" passthrough background showed the room and how the loading screen before it
  showed the room to a user who came from a virtual home.
- Showcase (VR, black): Horizon OS's black transition (no passthrough transition) and the card on black in every
  loading frame from both homes, with and without the setting (100 %, 190-461 frames per launch, both models); a
  reload brings it back on black (99.6-100 % with the setting on).
- Variant with passthrough declared (contextual), passthrough home: the system splash on passthrough (Horizon OS's
  passthrough transition) and the card on the runtime's own passthrough layer in every loading frame, also with the
  setting off (`xr: passthrough started (for the loading screen)`, stopped after the hand-over); the app's first frame
  replaces the room at once under the fading card (band luma room -> app in one frame, no dip). Virtual home: black
  (100 %, with and without the setting). A reload after the VR scene: black (99.6 %; `the session that ended showed no
passthrough`). On the Quest 3 the passthrough view of its dark surroundings sits at the noise floor, so 0.5-3.8 %
  of its passthrough frames classify as black.
- `splash: false` with the setting on: no card, black from both homes (100 %).
- Resume after the headset slept (proximity sensor far, then close), setting on: `xr: 5 frame(s) without an app frame
showed the opaque background` per resume (`frames.covered`); the recording shows the system's own wake sequence
  (black, the app's scene, ~0.3 s of passthrough while tracking resumes, the scene back) the same with the previous
  build, so on these builds the covered frames make no visible difference.
- Launch to the app's first frame 4.9-5.9 s warm, 9.1-10.1 s on the first launch after install, as before; virtual
  hands with the showcase APK are tracked as hands (`hand_interaction_ext`, 25 joints).

**Loading screen, revision 2 (2026-10-21)**: placement for a pitched head, one-frame return after a short loading
period, single-level swapchains. proto-showcase-vr, recorded with `screenrecord` and analysed per frame, on a Quest 3S
lying face up (head pitch 81 degrees: the unit where revision 1 showed only black) and a Quest 3 looking 29 degrees
up.

- Face-up Quest 3S: `placed along the gaze (pitch 81)`; the card fades in 1.02-1.09 s after `am start` (the
  runtime's first visible frame 0.93-0.99 s; full brightness 1.19-1.28 s) and stays on screen until the app's first
  frame (5.1-5.7 s warm, 9.0-9.3 s cold): no frame without it in 5 launches (2 cold, 3 warm). Before it, only
  Horizon OS's environment or black (the system splash is on the horizon, out of view). Revision 1 on the same unit:
  7.8 s of black before the app.
- Quest 3: `placed on the horizon ahead`; the system splash from 0.77-0.80 s, the runtime's card at the same place
  from 0.91-0.98 s, no frame without the card until the app (5.0-5.1 s warm, 9.0-9.1 s cold) in 5 launches. At the
  end of the transition Horizon OS hides the app's layers until its own splash has faded out: the card dims to
  0.61-0.67 of its brightness for 5-10 frames. With mipmapped swapchains (revision 1) the first launch on a unit also blinked the card out for
  ~3 frames while the compositor compiled a shader for them (`PSO : MISSING`, 96-144 log lines 1.05-1.44 s after
  launch, here and in an independent check's run); the first launch of the single-level build logged no such line on either
  unit, and the card stayed visible.
- Reload: the card for 4.3-4.9 s on both units, then the 250 ms cross-fade. The page ending its session and IWSDK
  entering again at once: 2-4 frames of the card, then the app at full brightness (revision 1: 4 frames of card or
  black, then a 0.16 s fade from black).
- After the hand-over (30 s, both units): 72.0 frames/s at 72 Hz, 0 missed, 0 late, no loading frames, JS 8.3-8.4 ms
  per frame (revision 1: 8.4 ms).

**Loading screen, revision 1 (2026-10-21)**, proto-showcase-vr packed with the default `native.splash`, against the
alpha APK on the same headsets, both mounted roughly level: a Quest 3S and a Quest 3. Each launch recorded with
`screenrecord` (the compositor's output) and classified per 100 ms.

- Alpha APK: after the system's launch transition ends (~1 s), 2.9-3.5 s of empty black frames on a warm launch and
  7.0-7.3 s on a cold one (data cleared), then the app.
- With the loading screen: the system splash (the app's card) during the launch transition, then the runtime's
  card + spinner from 0.87-1.02 s after `am start`, then a 250 ms cross-fade into the app; 0 empty frames in every
  launch on these level units (a face-up unit saw only black: fixed in revision 2). Launch to the app's first frame
  unchanged: 5.0-5.6 s warm, 8.8-9.3 s cold on both models (alpha: 5.0-5.6 / 8.9-9.1 s). OpenXR's start before the
  first loading frame: 450-640 ms (step times in the log line).
- The card stays where the system splash was (same distance and size), colours match it (sRGB swapchain),
  `splash: false` brings back the old black, a custom image and background colour work, a page reload shows the
  loading screen again until the new page's first frame, and a sleep/wake cycle does not (no loading frames on resume).
- M3 showcase check with the loading-screen build: 6/6 on the Quest 3S (72.0 fps, 1 missed period in 30 s; a first
  run had 7, the alpha APK 0 in its control run), XR-IDLE-1 longest boot gap 27.7 ms.

**Round 3 (2026-10-21)**: `M3-CHECK PASS 43/43`, every case once (incl. the new `alloc` and `showcasereload` cases
and the new checks in `grant` and `reload`), on a Quest 3S (on the OS build an earlier run saw the reload exit on);
then `--cases showcasereload,reload --repeat 3`: 8/8.

- **Reloading a real app** (round 2 closed it to home): proto-showcase-vr reloaded 10 times, 5 through
  `location.reload()` from the debug endpoint and 5 through DevTools `Page.reload`. Each new page started its session
  3.6-6.1 s after the reload, longer than the 2 s end grace period, and ran at 70-73 frames/s in the same process; no
  exit was requested. The pipeline app with its offer delayed 5 s after a reload: session frames 7.8 s after the
  reload. 24 quick reloads at random points of a frame: every new session at 72-73 frames/s.
- **Held re-offer** (explicit-grant mode): `end()`, then `offerSession()` again: 6 s later still in the idle
  presentation, no exit requested; `grantSession()` -> 72-73 frames/s.
- **Per-frame allocation** (pipeline app, its own loops stopped): 144 B per frame, median of 48 GC-free intervals
  (round 2: 576; 432 of it was `retargetTexture`, called twice per frame).
- The rest as in round 2: showcase in XR 4.0 s after launch, 30 s at 72.0 frames/s with 0 missed periods, VrApi CPU
  level 2 throughout, one render pass per frame (100 draws, 1 clear); XR-COL-1 (0,140,0); foveation 6.32 -> 3.68 ms.

**Round 2 (2026-10-21)**: `M3-CHECK PASS 38/38`, one run of every case, on each of two Quest 3S units on different OS
builds (unit 1, and unit 2 with the final APKs); on unit 1 an earlier full run with `--repeat 3`, before the `noext`
case and two pipeline checks were added, passed 35/35. Round 1 (2026-10-20): 30/30 on two other Quest 3S units.
Numbers below are from unit 1 unless noted.

- **Reload and re-entry** (the round-1 stall), both units: `location.reload()` at a random point of a frame, 54
  times: every new page's session ran at 71-73 frames/s; 18 of those reloads withdrew a posted frame (stats
  `withdrawn`), the path that left round 1 without frames. `end()` from a timer + immediate `requestSession`: 90/90
  new sessions at the display rate (two through the withdrawn path); `end()` in a frame callback + re-request from
  `end`: 45/45; the last session of each variant renders both eyes exactly; same process throughout.
- **proto-showcase-vr** (IWSDK 1.0.1, three r181; TEST-ONLY DOM scaffolding): in XR 3.7-3.8 s after launch with no
  user action (7.0 s on unit 2's first launch: cold shader compiles); 30 s at 72.0 JS frames/s, 0 missed periods,
  VrApi FPS 72-73/72, stale 0-3; VrApi CPU level 2 in every second (the GPU level is the system's choice: 4 in unit
  1's check runs, 2 on unit 2 and in other runs); both eyes render (1114-1626 distinct colours); 10/10 consecutive
  captures; one render pass per frame (67-103 draws, 1 clear, no blits).
  A/B against the round-1 APK on the same unit and pose: App GPU 10.44 vs 10.40/10.50 ms at GPU level 4, JS
  8.65 vs 8.38/8.40 ms per frame (one earlier round-1 run had 7.98 ms at level 2; the level, and with it App GPU,
  varied run to run for both builds). Foveation toggled in place: App GPU 9.0 -> 10.2 -> 7.8 ms (high, none, high).
- **Pipeline app** (layers, texture-array, MSAA multiview, attach once): left eye green / right eye blue exactly;
  72 frames/s; rAF `time` 16.7-18.3 ms ahead of `performance.now()` at entry, deltas 13.89 ms (XR-LOOP-5); 10/10
  consecutive captures (REG-6); a clear issued from a timer task between frames: no GL error, the next frames
  unchanged (XR-SC-3, images parked); `getError()` read 20 times between frames after ~670 parked frames: 0 every
  time, for the projection layer and the `XRWebGLLayer` (unit 2); compositor capture (0,140,0) for eye-buffer values (0,140,0) (XR-COL-1; Quest
  Browser 156 showed (0,141,0) for the same content in round 1); 90 Hz and back, 75 Hz rejected; foveation none ->
  high: fragment-bound GPU time 6.24-6.34 -> 3.66-3.68 ms (41-42 %); `fixedFoveation = 1` assigned in every frame for
  3 s: 0 profile updates on the XR thread, 72 frames/s; natives called with NaN/Infinity/out-of-range numbers:
  refused or ignored, frames unchanged; a GPU-bound load raises the GPU level; `end()` -> the activity finishes 2.7 s
  later (2 s grace + exit).
- **Explicit grant**: no session for 10 s with window rAF at 72-73/s, `grantSession()` -> first WebXR frame begun
  8.1-19.5 ms after the grant (XR-IDLE-3: <= 2 periods), a second call is a no-op.
- **Never offered**, and **only request rejected** (required `hit-test`): the XR-LIFE-7 error line once at ~10 s (the
  second names the rejection); the debug build keeps running.
- **XRWebGLLayer** (no `layers`): 3360x1760 side-by-side swapchain, both eyes right, 72 frames/s.
- **Every optional extension withheld** (`xr.disableExtensions`, 14 extensions): enters XR with only
  XR_KHR_opengl_es_enable + XR_KHR_android_create_instance, both eyes right, 72 frames/s (XR-INIT-1).
- **Lifecycle**: sleep -> OpenXR STOPPING/IDLE, session hidden, wake -> the same session renders again at 72 Hz;
  Home -> onDestroy, relaunch in the same process -> new OpenXR instance, session FOCUSED, frames running.
- **Debugger pause (CDP-7)**: JS paused in DevTools for 60 s during XR: the XR thread kept submitting at
  71.9-72.0 fps, no ANR or close, JS frames resumed after `Debugger.resume`.
- **Boot (XR-IDLE-1)**: frames submitted from ~620-690 ms after process start. The longest gap between visible
  submitted frames before the first XR frame: 0.7-13.4 ms for the pipeline app, 20.6-35.6 ms over six showcase
  boots with the final build (target <= 2 periods = 27.8 ms at 72 Hz, met in three). Nothing on the XR thread waits
  for JS there any more (round 1 also waited up to a full period for the session's first frame; it now waits 0.15).
  The gaps above target that were logged sat inside `xrWaitFrame` (23.9, 33.4 and, on unit 2, 35.3 ms; everything
  else ~0) or in the
  session's state change; in the boots with full logs they coincide with Horizon OS switching the display from 90
  back to 72 Hz as the session becomes FOCUSED (it moves to 90 Hz as the app launches), before any WebXR content, on
  the black idle presentation. Gaps before the app is visible (SYNCHRONIZED) are left out of the stat; the breakdown
  line still logs them. The MUST part (no unresponsive-app prompt, frames at the display rate between tasks) holds.

Hands on a device (2026-10-21, Quest 3S and Quest 3): with Horizon OS's virtual hands and controllers (development
builds of the OS; the test headsets have no real ones in view), tracked hands are listed as WebXR hands (25 joints,
`hand_interaction_ext`), pinch fires `select`, virtual controllers replace the hands and back with one
`inputsourceschange` per switch, and a session without `hand-tracking` gets hand pointers. Before the fix the same
virtual hands came through as `khr/simple_controller` controllers. Microgesture buttons were checked from the record
on (IWSDK's swipe turning); the runtime's virtual hands carry no microgestures or menu gesture. With real hands on a
Quest, microgestures turn the view through IWSDK's microgesture locomotion (a manual check).

Not device-checked here (the test headsets have no controllers and nobody wears them): IN-1..7 on real controllers and
hands (host and Node tests cover the mapping), recenter and boundary changes (XR-SPACE-\*, human checks), XR-LOOP-2
(shouldRender false), XR-AR-1, and foveation savings against Quest Browser's (its VrApi line does not carry the
WebXR content's GPU time; a follow-up).
