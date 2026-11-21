/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// getUserMedia over the passthrough cameras (XR-CAM-1, src/camera.ts) against fake camera natives that honour
// runtime/xr/src/v8/camera_binding.cc's contract; plus the shipped bundle installing it only for a declared camera.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installCamera, selectCameraSettings, type CameraDevice, type CameraNatives } from '../src/camera.ts';
import { createHarness } from './harness.ts';

// The Quest 3's two passthrough cameras as the binding lists them (dumpsys media.camera, 2026-10-25).
const SIZES: Array<[number, number]> = [
  [320, 240], [640, 360], [640, 480], [720, 480], [720, 576], [800, 600], [1024, 576], [1280, 720], [1280, 960],
  [1280, 1080], [1280, 1280], [1728, 1728],
];
const QUEST: CameraDevice[] = [
  { deviceId: '50', label: 'Left passthrough camera (id 50), facing back', position: 0, facing: 'environment', sizes: SIZES, frameRates: [[15, 15], [30, 30]] },
  { deviceId: '51', label: 'Right passthrough camera (id 51), facing back', position: 1, facing: 'environment', sizes: SIZES, frameRates: [[15, 15], [30, 30]] },
];

type Global = Record<string, unknown> & typeof globalThis;

function fakeCamera(
  opts: {
    declared?: boolean;
    devices?: CameraDevice[];
    openError?: { name: string; message: string };
    /** What natives.permitted answers at first (state.permitted); absent: natives without permitted(). */
    permitted?: boolean;
    /** Horizon OS: the camera list is read once per process, and a list read before the grant stays empty. */
    listOnce?: boolean;
  } = {},
) {
  const calls: unknown[][] = [];
  const closed: object[] = [];
  let handler: ((stream: number, ended: boolean) => void) | null = null;
  let nextStream = 1;
  const serials = new Map<number, number>();
  const state = { permitted: opts.permitted ?? true, openError: opts.openError, lists: 0, visibility: 'visible' };
  let list: CameraDevice[] | null = null;
  const natives: CameraNatives = {
    declared: opts.declared ?? true,
    devices: () => {
      state.lists++;
      if (!opts.listOnce) return opts.devices ?? QUEST;
      list ??= state.permitted ? (opts.devices ?? QUEST) : [];
      return list;
    },
    open: (id, w, h, fps) => {
      calls.push(['open', id, w, h, fps]);
      if (state.openError) return Promise.reject(state.openError);
      const stream = nextStream++;
      serials.set(stream, 0);
      return Promise.resolve({ stream, width: w, height: h, frameRate: fps });
    },
    frame: (stream) => {
      const serial = serials.get(stream) ?? 0;
      if (!serial) return null;
      return { handle: { stream, serial }, width: 1280, height: 1080, serial, timestampNs: 5e9 + serial * 33_333_333 };
    },
    close: (stream) => calls.push(['close', stream]),
    setFrameHandler: (fn) => {
      handler = fn;
    },
  };
  if (opts.permitted !== undefined) natives.permitted = () => state.permitted;
  // the page's document: visibilityState and its visibilitychange (the core's lifecycle)
  const document = Object.defineProperty(new EventTarget(), 'visibilityState', { get: () => state.visibility });
  const g = {
    EventTarget,
    Event,
    DOMException,
    performance,
    crypto,
    document,
    navigator: Object.create({ userAgent: 'test' }),
    reportError: (e: unknown) => {
      throw e;
    },
  } as unknown as Global;
  const push = (stream: number) => {
    serials.set(stream, (serials.get(stream) ?? 0) + 1);
    handler?.(stream, false);
  };
  const end = (stream: number) => handler?.(stream, true);
  const nudge = (stream: number) => handler?.(stream, false); // a notification without a newer frame
  const setVisibility = (v: 'visible' | 'hidden') => {
    state.visibility = v;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return { natives, g, calls, closed, push, end, nudge, closeHandle: (h: object) => closed.push(h), state, setVisibility };
}

const FEED = Symbol.for('iwn.media.feed');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const errorName = async (p: Promise<unknown>) =>
  p.then(() => 'resolved', (e: any) => `${e.name}${e.constraint ? ':' + e.constraint : ''}`);

test('XR-CAM-1: nothing is installed unless the app declares the camera (DOM-4: mediaDevices absent)', () => {
  const f = fakeCamera({ declared: false });
  assert.equal(installCamera(f.g, f.natives), false);
  assert.equal((f.g.navigator as unknown as Record<string, unknown>).mediaDevices, undefined);
  assert.equal('MediaStream' in f.g, false);
});

test('XR-CAM-1: enumerateDevices lists the passthrough cameras as videoinput, labelled with their facing', async () => {
  const f = fakeCamera();
  assert.equal(installCamera(f.g, f.natives), true);
  const md = (f.g.navigator as any).mediaDevices;
  assert.equal(Object.prototype.toString.call(md), '[object MediaDevices]');
  const list = await md.enumerateDevices();
  assert.deepEqual(list.map((d: any) => [d.kind, d.deviceId, d.label]), [
    ['videoinput', '50', 'Left passthrough camera (id 50), facing back'],
    ['videoinput', '51', 'Right passthrough camera (id 51), facing back'],
  ]);
  assert.equal(list[0] instanceof (f.g as any).InputDeviceInfo && list[0] instanceof (f.g as any).MediaDeviceInfo, true);
  assert.deepEqual(list[0].getCapabilities().width, { min: 320, max: 1728 });
  assert.deepEqual(JSON.parse(JSON.stringify(list[1])).groupId, list[0].groupId);
  assert.equal(md.getSupportedConstraints().deviceId, true);
});

test('XR-CAM-1: constraints pick the camera, size and rate (SelectSettings, resizeMode none)', () => {
  const pick = (v: unknown) => {
    const r = selectCameraSettings(QUEST, v);
    return 'constraint' in r ? r : `${r.device.deviceId} ${r.width}x${r.height}@${r.frameRate}`;
  };
  // video: true takes Chromium's default ideal 640x480 at 30 Hz, on the first (left) camera
  assert.equal(pick(true), '50 640x480@30');
  // IWSDK's CameraSource request: ideal 1920x1080 at 30 on an exact device
  assert.equal(pick({ deviceId: { exact: '51' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }), '51 1280x1080@30');
  assert.equal(pick({ width: 800, height: 600, frameRate: 15 }), '50 800x600@15');
  assert.equal(pick({ width: { min: 1300 } }), '50 1728x1728@30');
  assert.equal(pick({ aspectRatio: { exact: 16 / 9 }, height: { max: 400 } }), '50 640x360@30');
  assert.equal(pick({ deviceId: '51' }), '51 640x480@30'); // bare = ideal
  assert.equal(pick({ facingMode: 'user' }), '50 640x480@30'); // ideal facing: still a camera
  assert.deepEqual(pick({ deviceId: { exact: 'no-such-camera' } }), { constraint: 'deviceId' });
  assert.deepEqual(pick({ facingMode: { exact: 'user' } }), { constraint: 'facingMode' });
  assert.deepEqual(pick({ width: { exact: 1920 } }), { constraint: 'width' });
  assert.deepEqual(pick({ frameRate: { min: 60 } }), { constraint: 'frameRate' });
});

test('XR-CAM-1: getUserMedia opens the camera; frames feed a <video>; stop closes it once every clone stopped', async () => {
  const f = fakeCamera();
  installCamera(f.g, f.natives, { closeHandle: f.closeHandle });
  const md = (f.g.navigator as any).mediaDevices;
  const stream = await md.getUserMedia({ video: { deviceId: { exact: '50' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
  assert.deepEqual(f.calls, [['open', '50', 1280, 1080, 30]]);
  assert.equal(stream instanceof (f.g as any).MediaStream, true);
  assert.equal(stream.active, true);
  assert.equal(stream.getAudioTracks().length, 0);
  const [track] = stream.getTracks();
  assert.equal(track.kind, 'video');
  assert.equal(track.readyState, 'live');
  assert.equal(track.label, QUEST[0].label);
  assert.deepEqual(track.getSettings(), {
    deviceId: '50', groupId: 'iwer-native-camera-passthrough', width: 1280, height: 1080, frameRate: 30,
    aspectRatio: 1280 / 1080, facingMode: 'environment', resizeMode: 'none',
  });
  assert.deepEqual(track.getConstraints().width, { ideal: 1920 });
  // the feed a <video> plays (web/dom MEDIA_FEED)
  const feed = stream[FEED]();
  const heard: boolean[] = [];
  const unlisten = feed.listen((ended: boolean) => heard.push(ended));
  assert.equal(feed.frames, 0);
  assert.equal(feed.frame(), null);
  f.push(1);
  assert.equal(feed.frames, 1);
  assert.deepEqual(feed.frame(), { kind: 'handle', origin: 'video', handle: { stream: 1, serial: 1 }, width: 1280, height: 1080, premultiplied: false });
  f.push(1);
  assert.equal(feed.frames, 2);
  assert.ok(Math.abs(feed.mediaTime - 0.0333) < 1e-3);
  assert.deepEqual(f.closed, [{ stream: 1, serial: 1 }]); // the replaced frame's handle is closed
  assert.deepEqual(heard, [false, false]);
  f.nudge(1); // no newer frame: the second handle on the same pixels is closed at once, nobody hears of it
  assert.equal(feed.frames, 2);
  assert.deepEqual(f.closed, [{ stream: 1, serial: 1 }, { stream: 1, serial: 2 }]);
  f.closed.pop();
  assert.deepEqual(heard, [false, false]);
  // a clone shares the camera: stopping one track keeps it open, stopping both closes it once
  const copy = stream.clone();
  assert.notEqual(copy.id, stream.id);
  track.stop();
  assert.equal(track.readyState, 'ended');
  assert.equal(f.calls.filter((c) => c[0] === 'close').length, 0);
  assert.equal(stream.active, false);
  assert.equal(stream[FEED](), null);
  // each track has its own feed (black while that track is disabled), on the same frames
  assert.notEqual(copy[FEED](), feed);
  assert.deepEqual([copy[FEED]().frames, copy[FEED]().frame()], [2, feed.frame()]);
  copy.getTracks()[0].stop();
  assert.deepEqual(f.calls.at(-1), ['close', 1]);
  assert.deepEqual(heard, [false, false, true]);
  assert.equal(feed.ended, true);
  assert.deepEqual(f.closed, [{ stream: 1, serial: 1 }, { stream: 1, serial: 2 }]);
  f.push(1); // a late frame of a closed stream is ignored
  assert.equal(feed.frames, 2);
  unlisten();
});

test('XR-CAM-1: the system ending a stream ends its tracks with an ended event', async () => {
  const f = fakeCamera();
  installCamera(f.g, f.natives);
  const stream = await (f.g.navigator as any).mediaDevices.getUserMedia({ video: true });
  const [track] = stream.getVideoTracks();
  let ended = 0;
  track.onended = () => ended++;
  track.addEventListener('ended', () => ended++);
  f.end(1);
  assert.equal(ended, 2);
  assert.equal(track.readyState, 'ended');
  assert.equal(stream[FEED](), null);
  // The native stream is released even though the system ended it (Android still needs ACameraDevice_close).
  const closes = () => f.calls.filter((c) => c[0] === 'close');
  assert.deepEqual(closes(), [['close', 1]]);
  track.stop(); // already ended: no second close
  assert.deepEqual(closes(), [['close', 1]]);
});

test('XR-CAM-1: getUserMedia errors: no video, audio, overconstrained, denied, no camera', async () => {
  const name = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: any) => `${e.name}${e.constraint ? ':' + e.constraint : ''}`);
  let f = fakeCamera();
  installCamera(f.g, f.natives);
  let md = (f.g.navigator as any).mediaDevices;
  assert.equal(await name(md.getUserMedia({})), 'TypeError');
  assert.equal(await name(md.getUserMedia()), 'TypeError');
  assert.equal(await name(md.getUserMedia({ audio: true })), 'NotFoundError');
  assert.equal(await name(md.getUserMedia({ video: { deviceId: { exact: 'no-such-camera' } } })), 'OverconstrainedError:deviceId');
  assert.equal(f.calls.length, 0);
  // the native open's error (ACAMERA_ERROR_PERMISSION_DENIED) becomes its DOMException
  f = fakeCamera({ openError: { name: 'NotAllowedError', message: 'ACameraManager_openCamera: permission denied' } });
  installCamera(f.g, f.natives);
  md = (f.g.navigator as any).mediaDevices;
  const err = await md.getUserMedia({ video: true }).catch((e: unknown) => e);
  assert.equal(err instanceof DOMException && err.name === 'NotAllowedError', true);
  assert.match(err.message, /permission denied/);
  // the permission hook (perm's helper at integration) answers first
  f = fakeCamera();
  installCamera(f.g, f.natives, { requestPermission: async () => false });
  assert.equal(await name((f.g.navigator as any).mediaDevices.getUserMedia({ video: true })), 'NotAllowedError');
  assert.equal(f.calls.length, 0);
  f = fakeCamera({ devices: [] });
  installCamera(f.g, f.natives);
  assert.equal(await name((f.g.navigator as any).mediaDevices.getUserMedia({ video: true })), 'NotFoundError');
  // Horizon OS without the camera permissions withholds the passthrough cameras: NotAllowedError
  f = fakeCamera({ devices: [] });
  f.natives.hidden = () => true;
  installCamera(f.g, f.natives);
  assert.equal(await name((f.g.navigator as any).mediaDevices.getUserMedia({ video: true })), 'NotAllowedError');
});

test('XR-CAM-1: before the camera permissions, enumerateDevices gives one anonymous videoinput and reads no camera list', async () => {
  // Horizon OS keeps a camera list read before HEADSET_CAMERA is granted empty for the life of the process: an app
  // that enumerates first, then grants at getUserMedia, must still find the cameras.
  const f = fakeCamera({ permitted: false, listOnce: true });
  installCamera(f.g, f.natives, {
    requestPermission: async () => {
      f.state.permitted = true; // the user taps Allow
      return true;
    },
  });
  const md = (f.g.navigator as any).mediaDevices;
  const before = await md.enumerateDevices();
  assert.deepEqual(before.map((d: any) => [d.kind, d.deviceId, d.label, d.groupId]), [['videoinput', '', '', '']]);
  assert.deepEqual(before[0].getCapabilities(), {});
  assert.equal(f.state.lists, 0, 'the system list is not read before the grant');
  const stream = await md.getUserMedia({ video: { facingMode: 'environment' } });
  assert.equal(stream.getVideoTracks()[0].label, QUEST[0].label);
  assert.deepEqual((await md.enumerateDevices()).map((d: any) => d.deviceId), ['50', '51']);
  // without a permission request (no XR natives), a camera that is not permitted is NotAllowedError, list unread
  const g = fakeCamera({ permitted: false, listOnce: true });
  installCamera(g.g, g.natives);
  assert.equal(await errorName((g.g.navigator as any).mediaDevices.getUserMedia({ video: true })), 'NotAllowedError');
  assert.equal(g.state.lists, 0);
});

test('XR-CAM-1: getUserMedia for a camera that is open shares it in the mode it runs in (Android opens a camera once)', async () => {
  const f = fakeCamera();
  installCamera(f.g, f.natives, { closeHandle: f.closeHandle });
  const md = (f.g.navigator as any).mediaDevices;
  // two consumers at once (two IWSDK CameraSource entities facing back): one native open, two live tracks
  const [a, b] = await Promise.all([
    md.getUserMedia({ video: { deviceId: { exact: '50' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }),
    md.getUserMedia({ video: { deviceId: { exact: '50' }, width: { ideal: 640 }, height: { ideal: 480 } } }),
  ]);
  assert.deepEqual(f.calls, [['open', '50', 1280, 1080, 30]]);
  const [ta] = a.getVideoTracks();
  const [tb] = b.getVideoTracks();
  assert.notEqual(ta.id, tb.id);
  assert.deepEqual([tb.getSettings().width, tb.getSettings().height, tb.getConstraints().width], [1280, 1080, { ideal: 640 }]);
  f.push(1);
  assert.deepEqual([a[FEED]().frames, b[FEED]().frames], [1, 1]);
  // the other camera opens on its own; a request the open camera's mode cannot satisfy is refused, the camera kept
  await md.getUserMedia({ video: { deviceId: { exact: '51' } } });
  assert.deepEqual(f.calls.at(-1), ['open', '51', 640, 480, 30]);
  const refused = await md.getUserMedia({ video: { deviceId: { exact: '50' }, width: { exact: 640 } } }).catch((e: Error) => e);
  assert.equal(refused.name, 'OverconstrainedError');
  assert.match(refused.message, /open cameras run in one mode: 50 at 1280x1080@30, 51 at 640x480@30/);
  assert.equal(f.calls.length, 2);
  assert.equal(ta.readyState + tb.readyState, 'livelive');
  // the camera closes once its last track stops
  ta.stop();
  assert.equal(f.calls.length, 2);
  tb.stop();
  assert.deepEqual(f.calls.at(-1), ['close', 1]);
  // and the next request opens it again
  await md.getUserMedia({ video: { deviceId: { exact: '50' }, width: { exact: 640 } } });
  assert.deepEqual(f.calls.at(-1), ['open', '50', 640, 480, 30]);
});

test('XR-CAM-1: while the page is hidden the camera is closed and its tracks muted; visible again, it reopens', async () => {
  const f = fakeCamera();
  installCamera(f.g, f.natives, { closeHandle: f.closeHandle });
  const md = (f.g.navigator as any).mediaDevices;
  const stream = await md.getUserMedia({ video: { width: 1280, height: 1080 } });
  const [track] = stream.getVideoTracks();
  const events: string[] = [];
  track.onmute = () => events.push('mute');
  track.addEventListener('unmute', () => events.push('unmute'));
  track.onended = () => events.push('ended');
  const feed = stream[FEED]();
  f.push(1);
  f.push(1);
  f.setVisibility('hidden');
  assert.deepEqual(f.calls, [['open', '50', 1280, 1080, 30], ['close', 1]]);
  assert.deepEqual([track.readyState, track.muted, events, stream.active], ['live', true, ['mute'], true]);
  assert.deepEqual(feed.frame().handle, { stream: 1, serial: 2 }, 'the last frame stays');
  f.end(1); // the closed stream's late end changes nothing
  assert.equal(track.readyState, 'live');
  f.setVisibility('visible');
  await settle();
  assert.deepEqual(f.calls.slice(2), [['open', '50', 1280, 1080, 30]], 'the same camera and mode');
  assert.deepEqual([track.muted, events], [false, ['mute', 'unmute']]);
  f.push(2); // the reopened stream's first frame
  assert.deepEqual([feed.frames, feed.frame().handle], [3, { stream: 2, serial: 1 }]);
  // hidden again before the reopen ran: the camera it opened is closed, and the next visible opens it
  f.setVisibility('hidden');
  f.setVisibility('visible');
  f.setVisibility('hidden');
  await settle();
  assert.deepEqual(f.calls.slice(3), [['close', 2], ['open', '50', 1280, 1080, 30], ['close', 3]]);
  assert.equal(track.muted, true);
  // a getUserMedia that finishes while hidden: muted from the start, shares the muted source
  const second = await md.getUserMedia({ video: { deviceId: { exact: '50' } } });
  assert.deepEqual([second.getVideoTracks()[0].muted, f.calls.length], [true, 6]);
  second.getVideoTracks()[0].stop();
  // the camera cannot open again (the permission was revoked meanwhile): the track ends for good
  f.state.openError = { name: 'NotAllowedError', message: 'ACameraManager_openCamera: permission denied' };
  const warn = console.warn;
  console.warn = () => {};
  try {
    f.setVisibility('visible');
    await settle();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual([track.readyState, events.at(-1), feed.ended], ['ended', 'ended', true]);
  // a track stopped while its camera reopens: the camera that opened is closed at once
  f.state.openError = undefined;
  const third = await md.getUserMedia({ video: true });
  f.setVisibility('hidden');
  f.setVisibility('visible');
  third.getVideoTracks()[0].stop();
  await settle();
  assert.deepEqual(f.calls.slice(-4), [['open', '50', 640, 480, 30], ['close', 4], ['open', '50', 640, 480, 30], ['close', 5]]);
});

test('XR-CAM-1: a disabled track renders black frames; a feed keeps a frame of its own for a paused <video>', async () => {
  const f = fakeCamera();
  const copies: object[] = [];
  installCamera(f.g, f.natives, {
    closeHandle: f.closeHandle,
    shareHandle: (handle) => {
      const copy = { copyOf: handle };
      copies.push(copy);
      return copy;
    },
  });
  const stream = await (f.g.navigator as any).mediaDevices.getUserMedia({ video: true });
  const [track] = stream.getVideoTracks();
  const feed = stream[FEED]();
  assert.equal(feed.hold(), null, 'nothing to keep before the first frame');
  f.push(1);
  track.enabled = false;
  const black = feed.frame();
  assert.deepEqual([black.kind, black.width, black.height, black.data.length], ['pixels', 1280, 1080, 1280 * 1080 * 4]);
  assert.deepEqual([...black.data.subarray(0, 8)], [0, 0, 0, 255, 0, 0, 0, 255]);
  // per track: an enabled clone still shows the camera
  const clone = track.clone();
  clone.enabled = true;
  assert.equal(new (f.g as any).MediaStream([clone])[FEED]().frame().kind, 'handle');
  clone.stop();
  track.enabled = true;
  assert.deepEqual(feed.frame().handle, { stream: 1, serial: 1 });
  // hold: a copy of the newest frame that newer frames do not replace, closed once on release
  const held = feed.hold();
  f.push(1);
  assert.deepEqual([held.frame.kind, held.frame.handle], ['handle', { copyOf: { stream: 1, serial: 1 } }]);
  assert.deepEqual(feed.frame().handle, { stream: 1, serial: 2 });
  held.release();
  held.release();
  assert.deepEqual(f.closed.filter((h) => copies.includes(h)), [copies[0]]);
  // disabled, it keeps the black frame
  track.enabled = false;
  assert.equal(feed.hold().frame.kind, 'pixels');
});

test('XR-CAM-1 / DOM-4: permissions.query reports camera granted once the camera permissions are held', () => {
  const f = fakeCamera({ permitted: false });
  const sources: Array<() => readonly string[]> = [];
  (f.g as any)[Symbol.for('iwn.glue')] = { addPermissionSource: (s: () => readonly string[]) => sources.push(s) };
  installCamera(f.g, f.natives);
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0](), []);
  f.state.permitted = true;
  assert.deepEqual(sources[0](), ['camera']);
});

test('XR-CAM-1: the shipped bundle installs the camera from __iwn.camera when declared', () => {
  for (const declared of [true, false]) {
    const h = createHarness({ camera: fakeCamera({ declared }).natives });
    assert.equal(h.run(`typeof navigator.mediaDevices`), declared ? 'object' : 'undefined');
    assert.equal(h.run(`typeof MediaStream`), declared ? 'function' : 'undefined');
    if (declared) assert.equal(h.run(`MediaStreamTrack.name + ' ' + MediaDevices.name`), 'MediaStreamTrack MediaDevices');
  }
});

test('XR-CAM-1 / XR-PERM-1: the shipped bundle asks for the camera permissions before a camera opens', async () => {
  const CAMERA = ['android.permission.CAMERA', 'horizonos.permission.HEADSET_CAMERA'];
  const gum = `navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { globalThis.__r = s.getVideoTracks().length; }, (e) => { globalThis.__r = e.name; })`;
  // HEADSET_CAMERA denied: NotAllowedError, nothing opened
  const denied = fakeCamera();
  const h = createHarness({ camera: denied.natives, permissions: { [CAMERA[0]]: true, [CAMERA[1]]: false } });
  h.run(gum);
  await h.settle();
  assert.equal(h.run('globalThis.__r'), 'NotAllowedError');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'requestPermissions'), [['requestPermissions', CAMERA]]);
  assert.equal(denied.calls.filter((c) => c[0] === 'open').length, 0);
  // both granted: the camera opens
  const granted = fakeCamera();
  const ok = createHarness({ camera: granted.natives, permissions: { [CAMERA[0]]: true, [CAMERA[1]]: true } });
  ok.run(gum);
  await ok.settle();
  assert.equal(ok.run('globalThis.__r'), 1);
  assert.equal(granted.calls.filter((c) => c[0] === 'open').length, 1);
});
