/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// getUserMedia over the headset's passthrough cameras (XR-CAM-1), for apps that declare the camera
// (native.features.camera, or IWSDK's world.features.camera; the packer writes it into the runtime config).
// Without the declaration nothing here is installed: navigator.mediaDevices stays absent (DOM-4).
//
// navigator.mediaDevices.enumerateDevices() lists the passthrough cameras (videoinput; left, then right, labelled
// with their facing so pages can pick by label), getUserMedia({ video }) opens one through the native camera
// (runtime/xr xr_camera.cc, globalThis.__iwn.camera) and resolves a MediaStream with one MediaStreamTrack. A
// <video> plays that stream (web/dom's MEDIA_FEED protocol): texImage2D / drawImage of the video upload its newest
// frame, which arrives here as an image-module handle (runtime/image INTEROP.md). Audio is not offered (no
// microphone capture): a request for it rejects with NotFoundError, as in a browser without a microphone.
//
// Constraints follow Media Capture and Streams §4.3.8 (SelectSettings) on the cameras' native sizes and rates, with
// resizeMode 'none': exact/min/max filter, ideal values (and Chromium's default 640x480 at 30 Hz) rank by fitness
// distance.
//
// Until the camera permissions are held, enumerateDevices gives §9.2's one anonymous videoinput and the system's
// camera list is not read (Horizon OS would keep a list read before the grant empty after it). Android opens a camera
// once per app, so a request for a camera that is open shares its source, in the mode it runs in (Chromium does the
// same). While the page is hidden the cameras are closed and their tracks muted; they open again, unmuted, when it
// is visible (Quest Browser releases capture devices in the background too, and Horizon OS would take a camera away
// for good after about a minute). A disabled track renders black frames; a paused <video> keeps its frame.

/** One camera of globalThis.__iwn.camera.devices(). */
export interface CameraDevice {
  deviceId: string;
  label: string;
  /** 0 left, 1 right passthrough camera; -1 another camera. */
  position: number;
  /** MediaTrackSettings.facingMode ('environment' for the passthrough cameras), '' unknown. */
  facing: string;
  sizes: Array<[number, number]>;
  frameRates: Array<[number, number]>;
}

export interface CameraFrameInfo {
  handle: object;
  width: number;
  height: number;
  serial: number;
  timestampNs: number;
}

/** globalThis.__iwn.camera (runtime/xr/src/v8/camera_binding.cc). */
export interface CameraNatives {
  readonly declared: boolean;
  /**
   * The camera permissions are held (CAMERA, and HEADSET_CAMERA on Horizon OS); no dialog. Until then devices() is
   * empty and open() rejects with NotAllowedError.
   */
  permitted?(): boolean;
  devices(): CameraDevice[];
  /** The cameras are withheld: the camera permissions are not granted. */
  hidden?(): boolean;
  open(
    deviceId: string,
    width: number,
    height: number,
    frameRate: number,
  ): Promise<{ stream: number; width: number; height: number; frameRate: number }>;
  frame(stream: number): CameraFrameInfo | null;
  close(stream: number): void;
  setFrameHandler(handler: ((stream: number, ended: boolean) => void) | null): void;
}

export interface CameraOptions {
  /** Closes a frame's image handle once a newer frame replaced it (globalThis.__iwn.image.close). */
  closeHandle?: (handle: object) => void;
  /**
   * A handle of its own on a frame's pixels (globalThis.__iwn.image.share, which copies a camera frame): what a paused
   * <video> keeps showing. Without it a paused <video> shows the newest frame.
   */
  shareHandle?: (handle: object) => object;
  /**
   * Asks for the camera permissions before a camera opens (§3.2's permission helper at integration); false
   * rejects with NotAllowedError. Without it the native open decides (ACAMERA_ERROR_PERMISSION_DENIED).
   */
  requestPermission?: () => Promise<boolean>;
}

type Global = Record<string, unknown> & typeof globalThis;

const MEDIA_FEED: unique symbol = Symbol.for('iwn.media.feed') as never;

// --- constraints ----------------------------------------------------------------------------------------------------

export interface CameraSettings {
  device: CameraDevice;
  width: number;
  height: number;
  frameRate: number;
}

type Range = { exact?: number; ideal?: number; min?: number; max?: number };
type Choice = { exact?: string[]; ideal?: string[] };

/** Chromium's defaults when a page gives no ideal size or rate. */
const DEFAULT_IDEAL = { width: 640, height: 480, frameRate: 30 };

function numberConstraint(v: unknown): Range | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return { ideal: v };
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out: Range = {};
  for (const k of ['exact', 'ideal', 'min', 'max'] as const) if (typeof o[k] === 'number') out[k] = o[k] as number;
  return out;
}

function stringConstraint(v: unknown): Choice | null {
  const list = (x: unknown): string[] | undefined =>
    typeof x === 'string' ? [x] : Array.isArray(x) ? x.map(String) : undefined;
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || Array.isArray(v)) return { ideal: list(v) };
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { exact: list(o.exact), ideal: list(o.ideal) };
}

function inRange(value: number, c: Range | null): boolean {
  if (!c) return true;
  if (c.exact !== undefined && value !== c.exact) return false;
  if (c.min !== undefined && value < c.min) return false;
  if (c.max !== undefined && value > c.max) return false;
  return true;
}

function distance(value: number, ideal: number | undefined): number {
  if (ideal === undefined) return 0;
  if (value === ideal) return 0;
  return Math.abs(value - ideal) / Math.max(Math.abs(value), Math.abs(ideal));
}

/**
 * Picks the camera, size and frame rate for `video` (true or MediaTrackConstraints). Returns the settings, or the
 * name of a required constraint no camera satisfies (OverconstrainedError.constraint).
 */
export function selectCameraSettings(devices: CameraDevice[], video: unknown): CameraSettings | { constraint: string } {
  const c = (video && typeof video === 'object' ? video : {}) as Record<string, unknown>;
  const width = numberConstraint(c.width);
  const height = numberConstraint(c.height);
  const frameRate = numberConstraint(c.frameRate);
  const aspectRatio = numberConstraint(c.aspectRatio);
  const deviceId = stringConstraint(c.deviceId);
  const facingMode = stringConstraint(c.facingMode);
  let best: CameraSettings | null = null;
  let bestDistance = Infinity;
  // the first required constraint that removed the last candidate, for the error
  const failed = new Set<string>();
  for (const device of devices) {
    if (deviceId?.exact && !deviceId.exact.includes(device.deviceId)) {
      failed.add('deviceId');
      continue;
    }
    if (facingMode?.exact && !facingMode.exact.includes(device.facing)) {
      failed.add('facingMode');
      continue;
    }
    const rates = [...new Set(device.frameRates.map(([, max]) => max))];
    for (const [w, h] of device.sizes) {
      if (!inRange(w, width)) {
        failed.add('width');
        continue;
      }
      if (!inRange(h, height)) {
        failed.add('height');
        continue;
      }
      if (!inRange(w / h, aspectRatio)) {
        failed.add('aspectRatio');
        continue;
      }
      for (const fps of rates.length ? rates : [30]) {
        if (!inRange(fps, frameRate)) {
          failed.add('frameRate');
          continue;
        }
        const d =
          distance(w, width?.ideal ?? DEFAULT_IDEAL.width) +
          distance(h, height?.ideal ?? DEFAULT_IDEAL.height) +
          distance(fps, frameRate?.ideal ?? DEFAULT_IDEAL.frameRate) +
          distance(w / h, aspectRatio?.ideal) +
          (deviceId?.ideal && !deviceId.ideal.includes(device.deviceId) ? 1 : 0) +
          (facingMode?.ideal && !facingMode.ideal.includes(device.facing) ? 1 : 0);
        // ties keep the earlier camera (left), size and rate
        if (d < bestDistance) {
          bestDistance = d;
          best = { device, width: w, height: h, frameRate: fps };
        }
      }
    }
  }
  if (best) return best;
  for (const k of ['deviceId', 'facingMode', 'width', 'height', 'aspectRatio', 'frameRate']) {
    if (failed.has(k)) return { constraint: k };
  }
  return { constraint: '' };
}

// --- install --------------------------------------------------------------------------------------------------------

function domException(g: Global, message: string, name: string): Error {
  const D = g.DOMException as (new (m: string, n: string) => Error) | undefined;
  if (typeof D === 'function') return new D(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

const INTERNAL = Symbol('iwn.camera.internal');

/** Installs navigator.mediaDevices and the MediaStream classes when the app declared the camera; false otherwise. */
export function installCamera(g: Global, natives: CameraNatives, options: CameraOptions = {}): boolean {
  // strictly true: a stand-in whose every property is truthy (the compat inventory's) must not count as a declaration
  if (natives.declared !== true) return false;
  const EventTargetBase = g.EventTarget as typeof EventTarget;
  const EventCtor = g.Event as typeof Event;
  const nav = g.navigator as object | undefined;
  if (typeof EventTargetBase !== 'function' || typeof EventCtor !== 'function' || !nav) return false;
  const uuid = (): string => {
    const c = g.crypto as { randomUUID?: () => string } | undefined;
    if (typeof c?.randomUUID === 'function') return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 3) | 8).toString(16);
    });
  };
  const report = (e: unknown) => {
    const r = g.reportError as ((e: unknown) => void) | undefined;
    if (typeof r === 'function') r(e);
  };
  const now = (): number => (g.performance as { now?: () => number } | undefined)?.now?.() ?? Date.now();

  /** Event handler IDL attributes (onended, ...) over addEventListener. */
  const handlers = (proto: object, names: string[]) => {
    for (const name of names) {
      const key = Symbol(`on${name}`);
      Object.defineProperty(proto, `on${name}`, {
        configurable: true,
        enumerable: true,
        get(this: Record<symbol, unknown>) {
          return (this[key] as { fn: unknown } | undefined)?.fn ?? null;
        },
        set(this: EventTarget & Record<symbol, unknown>, fn: unknown) {
          const old = this[key] as { fn: unknown; wrapper: (e: Event) => void } | undefined;
          if (old) this.removeEventListener(name, old.wrapper);
          this[key] = undefined;
          if (typeof fn !== 'function') return;
          const wrapper = (e: Event) => (fn as (e: Event) => void).call(this, e);
          this[key] = { fn, wrapper };
          this.addEventListener(name, wrapper);
        },
      });
    }
  };

  /** The camera permissions are held (true), not held (false), or the natives cannot tell (null). */
  const permission = (): boolean | null => {
    if (typeof natives.permitted !== 'function') return null;
    try {
      return natives.permitted() === true;
    } catch {
      return false;
    }
  };
  // The core folds the activity's lifecycle and the XR session's into document.visibilityState.
  const doc = g.document as (EventTarget & { visibilityState?: unknown }) | undefined;
  const hidden = (): boolean => doc?.visibilityState === 'hidden';

  // ---- one open camera, shared by its tracks (clones, and every getUserMedia for that camera) ----

  type HandleFrame = { kind: 'handle'; origin: 'video'; handle: object; width: number; height: number; premultiplied: false };
  type PixelsFrame = { kind: 'pixels'; origin: 'video'; width: number; height: number; premultiplied: false; data: Uint8Array };

  class CameraSource {
    refs = 1;
    ended = false;
    /** Closed while the page is hidden: its tracks stay live, muted (Media Capture and Streams §4.3.1.1). */
    muted = false;
    /** The native stream; 0 while muted. */
    stream: number;
    frames = 0;
    width = 0;
    height = 0;
    mediaTime = 0;
    private serial = 0; // the native stream's newest frame taken
    private firstNs = 0;
    private reopening = false;
    private current: HandleFrame | null = null;
    private black: PixelsFrame | null = null;
    private listeners = new Set<(ended: boolean) => void>();
    readonly tracks = new Set<MediaStreamTrackImpl>();
    readonly device: CameraDevice;
    readonly settings: { width: number; height: number; frameRate: number };
    constructor(stream: number, device: CameraDevice, settings: { width: number; height: number; frameRate: number }) {
      this.stream = stream;
      this.device = device;
      this.settings = settings;
      sources.set(stream, this);
      live.add(this);
    }
    /** The newest frame, or for a disabled track a black one of its size (§4.3.1); null before the first. */
    frame(enabled: boolean): HandleFrame | PixelsFrame | null {
      const f = this.current;
      if (enabled || !f) return f;
      if (this.black?.width !== f.width || this.black.height !== f.height) {
        const data = new Uint8Array(f.width * f.height * 4);
        for (let i = 3; i < data.length; i += 4) data[i] = 255;
        this.black = { kind: 'pixels', origin: 'video', width: f.width, height: f.height, premultiplied: false, data };
      }
      return this.black;
    }
    /** frame(enabled), kept as it is until release() (a paused <video>); null when it cannot be kept. */
    hold(enabled: boolean): { frame: object; release(): void } | null {
      const f = this.frame(enabled);
      if (!f) return null;
      if (f.kind === 'pixels') return { frame: f, release: () => {} };
      if (!options.shareHandle) return null;
      let handle: object | null = null;
      try {
        handle = options.shareHandle(f.handle);
      } catch (e) {
        report(e); // out of memory for the copy: the <video> shows the newest frame instead
      }
      if (!handle) return null;
      return {
        frame: { ...f, handle },
        release: () => {
          if (handle) options.closeHandle?.(handle);
          handle = null;
        },
      };
    }
    listen(fn: (ended: boolean) => void): () => void {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    /** A new native frame: take its handle, drop the previous one. */
    onFrame(): void {
      if (this.ended || !this.stream) return;
      const f = natives.frame(this.stream);
      if (!f) return;
      if (f.serial <= this.serial) {
        options.closeHandle?.(f.handle); // no newer frame: this handle is a second one on the current pixels
        return;
      }
      const previous = this.current;
      if (!this.firstNs) this.firstNs = f.timestampNs;
      const { handle, width, height } = f;
      this.current = { kind: 'handle', origin: 'video', handle, width, height, premultiplied: false };
      this.serial = f.serial;
      this.frames++;
      this.width = f.width;
      this.height = f.height;
      this.mediaTime = Math.max(0, (f.timestampNs - this.firstNs) / 1e9);
      if (previous) options.closeHandle?.(previous.handle);
      this.emit(false);
    }
    /** The page went hidden: the camera closes, the tracks stay (muted) with the last frame. */
    suspend(): void {
      if (this.ended || this.muted) return;
      this.muted = true;
      this.closeStream();
      for (const t of [...this.tracks]) t._muted(true);
    }
    /** Visible again: the camera opens in the same mode, its tracks unmute once it runs; one that cannot open ends. */
    resume(): void {
      if (this.ended || !this.muted || this.reopening) return;
      this.reopening = true;
      const { width, height, frameRate } = this.settings;
      natives.open(this.device.deviceId, width, height, frameRate).then(
        (opened) => {
          this.reopening = false;
          if (this.ended || hidden()) {
            natives.close(opened.stream); // stopped, or hidden again meanwhile (the next visibilitychange reopens)
            return;
          }
          this.stream = opened.stream;
          this.serial = 0;
          sources.set(opened.stream, this);
          this.muted = false;
          for (const t of [...this.tracks]) t._muted(false);
        },
        (e: { message?: string } | undefined) => {
          this.reopening = false;
          if (this.ended) return;
          console.warn(`@iwer/native: camera ${this.device.deviceId} could not open again: ${e?.message ?? String(e)}`);
          this.end(true);
        },
      );
    }
    /** The camera stopped (the last track stopped, or the system took it away). */
    end(fromSystem: boolean): void {
      if (this.ended) return;
      this.ended = true;
      live.delete(this);
      this.closeStream(); // also after the system ended it: the device, reader and stores stay open until then
      if (this.current) options.closeHandle?.(this.current.handle);
      this.current = null;
      this.black = null;
      if (fromSystem) {
        for (const t of [...this.tracks]) t._ended(true);
      }
      this.emit(true);
    }
    release(): void {
      if (--this.refs <= 0) this.end(false);
    }
    private closeStream(): void {
      if (!this.stream) return;
      sources.delete(this.stream);
      natives.close(this.stream);
      this.stream = 0;
    }
    private emit(ended: boolean): void {
      for (const fn of [...this.listeners]) {
        try {
          fn(ended);
        } catch (e) {
          report(e);
        }
      }
    }
  }
  /** By native stream. */
  const sources = new Map<number, CameraSource>();
  /** Every source not ended, muted ones included. */
  const live = new Set<CameraSource>();
  natives.setFrameHandler((stream, ended) => {
    const s = sources.get(stream);
    if (!s) return;
    if (ended) s.end(true);
    else s.onFrame();
  });
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', () => {
      for (const s of [...live]) {
        if (hidden()) s.suspend();
        else s.resume();
      }
    });
  }

  // ---- MediaStreamTrack ----

  class MediaStreamTrackImpl extends EventTargetBase {
    #source: CameraSource;
    #id = uuid();
    #enabled = true;
    #state: 'live' | 'ended' = 'live';
    #constraints: object;
    #feed: object | null = null;
    constructor(token: unknown, source: CameraSource, constraints: object) {
      if (token !== INTERNAL) throw new TypeError('Illegal constructor');
      super();
      this.#source = source;
      this.#constraints = constraints;
      source.tracks.add(this);
    }
    get kind(): string {
      return 'video';
    }
    get id(): string {
      return this.#id;
    }
    get label(): string {
      return this.#source.device.label;
    }
    get enabled(): boolean {
      return this.#enabled;
    }
    set enabled(v: boolean) {
      this.#enabled = !!v;
    }
    get muted(): boolean {
      return this.#source.muted;
    }
    get readyState(): string {
      return this.#state;
    }
    get contentHint(): string {
      return '';
    }
    set contentHint(_v: string) {}
    stop(): void {
      if (this.#state === 'ended') return;
      this.#state = 'ended'; // no 'ended' event for stop() (Media Capture and Streams §4.3.1)
      this.#source.tracks.delete(this);
      this.#source.release();
    }
    clone(): MediaStreamTrackImpl {
      const s = this.#source;
      if (this.#state === 'live') s.refs++;
      const t = new MediaStreamTrackImpl(INTERNAL, s, this.#constraints);
      if (this.#state === 'ended') t._ended(false);
      t.enabled = this.#enabled;
      return t;
    }
    getSettings(): Record<string, unknown> {
      const s = this.#source;
      const { width, height, frameRate } = s.settings;
      return {
        deviceId: s.device.deviceId,
        groupId: groupIdOf(s.device),
        width,
        height,
        frameRate,
        aspectRatio: width / height,
        ...(s.device.facing ? { facingMode: s.device.facing } : {}),
        resizeMode: 'none',
      };
    }
    getConstraints(): object {
      return { ...this.#constraints };
    }
    getCapabilities(): Record<string, unknown> {
      return capabilitiesOf(this.#source.device);
    }
    applyConstraints(constraints?: object): Promise<void> {
      // The camera keeps running as opened: settings that need another native mode are not applied.
      this.#constraints = { ...(constraints ?? {}) };
      return Promise.resolve();
    }
    /** @internal */
    _ended(fire: boolean): void {
      if (this.#state === 'ended') return;
      this.#state = 'ended';
      this.#source.tracks.delete(this);
      if (fire) this.dispatchEvent(new EventCtor('ended'));
    }
    /** @internal: the source was muted or unmuted (the page's visibility). */
    _muted(muted: boolean): void {
      if (this.#state === 'live') this.dispatchEvent(new EventCtor(muted ? 'mute' : 'unmute'));
    }
    /** @internal: the feed a <video> plays (MEDIA_FEED via MediaStream): the source's frames, black while disabled. */
    _feed(): object | null {
      if (this.#state !== 'live') return null;
      if (!this.#feed) {
        const s = this.#source;
        const enabled = (): boolean => this.#enabled;
        this.#feed = {
          get width() {
            return s.width;
          },
          get height() {
            return s.height;
          },
          get frames() {
            return s.frames;
          },
          get mediaTime() {
            return s.mediaTime;
          },
          get ended() {
            return s.ended;
          },
          frame: () => s.frame(enabled()),
          hold: () => s.hold(enabled()),
          listen: (fn: (ended: boolean) => void) => s.listen(fn),
        };
      }
      return this.#feed;
    }
    get [Symbol.toStringTag](): string {
      return 'MediaStreamTrack';
    }
  }
  handlers(MediaStreamTrackImpl.prototype, ['ended', 'mute', 'unmute']);

  // ---- MediaStream ----

  class MediaStreamImpl extends EventTargetBase {
    #id = uuid();
    #tracks: MediaStreamTrackImpl[] = [];
    constructor(init?: unknown) {
      super();
      const list = init instanceof MediaStreamImpl ? init.getTracks() : Array.isArray(init) ? init : [];
      for (const t of list) {
        if (!(t instanceof MediaStreamTrackImpl)) {
          throw new TypeError("Failed to construct 'MediaStream': parameter 1 is not a sequence of MediaStreamTrack.");
        }
        if (!this.#tracks.includes(t)) this.#tracks.push(t);
      }
    }
    get id(): string {
      return this.#id;
    }
    get active(): boolean {
      return this.#tracks.some((t) => t.readyState === 'live');
    }
    getTracks(): MediaStreamTrackImpl[] {
      return this.#tracks.slice();
    }
    getVideoTracks(): MediaStreamTrackImpl[] {
      return this.#tracks.slice();
    }
    getAudioTracks(): MediaStreamTrackImpl[] {
      return [];
    }
    getTrackById(id: string): MediaStreamTrackImpl | null {
      return this.#tracks.find((t) => t.id === String(id)) ?? null;
    }
    addTrack(track: MediaStreamTrackImpl): void {
      if (!(track instanceof MediaStreamTrackImpl)) {
        throw new TypeError(
          "Failed to execute 'addTrack' on 'MediaStream': parameter 1 is not of type 'MediaStreamTrack'.",
        );
      }
      if (!this.#tracks.includes(track)) this.#tracks.push(track);
    }
    removeTrack(track: MediaStreamTrackImpl): void {
      const i = this.#tracks.indexOf(track);
      if (i >= 0) this.#tracks.splice(i, 1);
    }
    clone(): MediaStreamImpl {
      return new MediaStreamImpl(this.#tracks.map((t) => t.clone()));
    }
    [MEDIA_FEED](): object | null {
      for (const t of this.#tracks) {
        const f = t._feed();
        if (f) return f;
      }
      return null;
    }
    get [Symbol.toStringTag](): string {
      return 'MediaStream';
    }
  }
  handlers(MediaStreamImpl.prototype, ['addtrack', 'removetrack']);

  // ---- devices ----

  const groupIdOf = (d: CameraDevice): string => `iwer-native-camera-${d.position >= 0 ? 'passthrough' : d.deviceId}`;
  const capabilitiesOf = (d: CameraDevice): Record<string, unknown> => {
    const ws = d.sizes.map(([w]) => w);
    const hs = d.sizes.map(([, h]) => h);
    const rs = d.frameRates.flat();
    const ratios = d.sizes.map(([w, h]) => w / h);
    return {
      deviceId: d.deviceId,
      groupId: groupIdOf(d),
      width: { min: Math.min(...ws), max: Math.max(...ws) },
      height: { min: Math.min(...hs), max: Math.max(...hs) },
      aspectRatio: { min: Math.min(...ratios), max: Math.max(...ratios) },
      frameRate: { min: rs.length ? Math.min(...rs) : 30, max: rs.length ? Math.max(...rs) : 30 },
      facingMode: d.facing ? [d.facing] : [],
      resizeMode: ['none'],
    };
  };

  /** A camera, or null: §9.2's anonymous entry before the camera permissions (empty deviceId, label, groupId). */
  class MediaDeviceInfoImpl {
    #d: CameraDevice | null;
    constructor(token: unknown, d: CameraDevice | null) {
      if (token !== INTERNAL) throw new TypeError('Illegal constructor');
      this.#d = d;
    }
    get deviceId(): string {
      return this.#d?.deviceId ?? '';
    }
    get kind(): string {
      return 'videoinput';
    }
    get label(): string {
      return this.#d?.label ?? '';
    }
    get groupId(): string {
      return this.#d ? groupIdOf(this.#d) : '';
    }
    toJSON(): object {
      return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId };
    }
    get [Symbol.toStringTag](): string {
      return 'MediaDeviceInfo';
    }
  }
  class InputDeviceInfoImpl extends MediaDeviceInfoImpl {
    #d: CameraDevice | null;
    constructor(token: unknown, d: CameraDevice | null) {
      super(token, d);
      this.#d = d;
    }
    getCapabilities(): Record<string, unknown> {
      return this.#d ? capabilitiesOf(this.#d) : {};
    }
    override get [Symbol.toStringTag](): string {
      return 'InputDeviceInfo';
    }
  }

  class OverconstrainedErrorImpl extends (g.DOMException as typeof DOMException) {
    #constraint: string;
    constructor(constraint: string, message = '') {
      super(message, 'OverconstrainedError');
      this.#constraint = String(constraint);
    }
    get constraint(): string {
      return this.#constraint;
    }
  }

  const listDevices = (): CameraDevice[] => {
    try {
      return natives.devices();
    } catch {
      return [];
    }
  };

  // Opens the camera for one getUserMedia, or shares the open one. One request at a time, so a request for a camera
  // that another is opening shares it once it runs.
  let queue: Promise<unknown> = Promise.resolve();
  const openStream = async (video: unknown): Promise<MediaStreamImpl> => {
    const devices = listDevices();
    if (devices.length === 0) {
      // Horizon OS lists no passthrough camera to an app without its camera permissions
      if (natives.hidden?.()) {
        throw domException(g, 'Permission denied (the camera permissions are not granted)', 'NotAllowedError');
      }
      throw domException(g, 'Requested device not found', 'NotFoundError');
    }
    // An open camera offers only the mode it runs in: Android opens a camera once per app (opening it again
    // disconnects the first stream), so a request for it shares its source.
    const running = new Map<string, CameraSource>();
    for (const s of live) running.set(s.device.deviceId, s);
    const candidates = devices.map((d): CameraDevice => {
      const s = running.get(d.deviceId);
      if (!s) return d;
      const { width, height, frameRate } = s.settings;
      return { ...d, sizes: [[width, height]], frameRates: [[frameRate, frameRate]] };
    });
    const picked = selectCameraSettings(candidates, video);
    if ('constraint' in picked) {
      const open = [...running.values()].map((s) => {
        const { width, height, frameRate } = s.settings;
        return `${s.device.deviceId} at ${width}x${height}@${frameRate}`;
      });
      throw new OverconstrainedErrorImpl(
        picked.constraint,
        'No camera satisfies the constraints' + (open.length ? ` (open cameras run in one mode: ${open.join(', ')})` : ''),
      );
    }
    const constraints = video && typeof video === 'object' ? { ...(video as object) } : {};
    const shared = running.get(picked.device.deviceId);
    if (shared) {
      shared.refs++;
      const { width, height, frameRate } = shared.settings;
      console.info(`@iwer/native: camera ${shared.device.deviceId} is open: shared at ${width}x${height}@${frameRate}`);
      return new MediaStreamImpl([new MediaStreamTrackImpl(INTERNAL, shared, constraints)]);
    }
    const t0 = now();
    let opened: { stream: number; width: number; height: number; frameRate: number };
    try {
      opened = await natives.open(picked.device.deviceId, picked.width, picked.height, picked.frameRate);
    } catch (e) {
      const err = e as { name?: string; message?: string };
      throw domException(g, err?.message ?? String(e), err?.name ?? 'NotReadableError');
    }
    const { width, height, frameRate } = opened;
    const source = new CameraSource(opened.stream, picked.device, { width, height, frameRate });
    console.info(
      `@iwer/native: camera ${picked.device.deviceId} (${picked.device.label}) ` +
        `${opened.width}x${opened.height}@${opened.frameRate} ` +
        `opened in ${Math.round(now() - t0)} ms`,
    );
    const stream = new MediaStreamImpl([new MediaStreamTrackImpl(INTERNAL, source, constraints)]);
    if (hidden()) source.suspend(); // the page went hidden while it opened: muted until it is visible
    return stream;
  };

  class MediaDevicesImpl extends EventTargetBase {
    constructor(token: unknown) {
      if (token !== INTERNAL) throw new TypeError('Illegal constructor');
      super();
    }
    enumerateDevices(): Promise<MediaDeviceInfoImpl[]> {
      // §9.2 (device information exposure): before the camera permissions, one anonymous videoinput, and the
      // system's camera list is not read (CameraNatives.permitted)
      if (permission() === false) return Promise.resolve([new InputDeviceInfoImpl(INTERNAL, null)]);
      return Promise.resolve(listDevices().map((d) => new InputDeviceInfoImpl(INTERNAL, d)));
    }
    getSupportedConstraints(): Record<string, boolean> {
      return {
        width: true,
        height: true,
        aspectRatio: true,
        frameRate: true,
        facingMode: true,
        resizeMode: true,
        deviceId: true,
        groupId: true,
      };
    }
    async getUserMedia(constraints?: { video?: unknown; audio?: unknown }): Promise<MediaStreamImpl> {
      const c = constraints ?? {};
      if (typeof c !== 'object') {
        throw new TypeError(
          "Failed to execute 'getUserMedia' on 'MediaDevices': " +
            "The provided value is not of type 'MediaStreamConstraints'.",
        );
      }
      if (!c.video && !c.audio) {
        throw new TypeError(
          "Failed to execute 'getUserMedia' on 'MediaDevices': At least one of audio and video must be requested",
        );
      }
      if (c.audio) {
        throw domException(g, 'Requested device not found (no microphone capture in @iwer/native)', 'NotFoundError');
      }
      if (options.requestPermission && !(await options.requestPermission())) {
        throw domException(g, 'Permission denied', 'NotAllowedError');
      }
      if (permission() === false) {
        throw domException(g, 'Permission denied (the camera permissions are not granted)', 'NotAllowedError');
      }
      const run = queue.then(() => openStream(c.video));
      queue = run.catch(() => undefined);
      return run;
    }
    get [Symbol.toStringTag](): string {
      return 'MediaDevices';
    }
  }
  handlers(MediaDevicesImpl.prototype, ['devicechange']);

  const named = (name: string, C: object) => {
    Object.defineProperty(C, 'name', { value: name });
    Object.defineProperty(g, name, { configurable: true, writable: true, enumerable: false, value: C });
  };
  named('MediaStream', MediaStreamImpl);
  named('MediaStreamTrack', MediaStreamTrackImpl);
  named('MediaDevices', MediaDevicesImpl);
  named('MediaDeviceInfo', MediaDeviceInfoImpl);
  named('InputDeviceInfo', InputDeviceInfoImpl);
  named('OverconstrainedError', OverconstrainedErrorImpl);

  const mediaDevices = new MediaDevicesImpl(INTERNAL);
  // On Navigator.prototype, as browsers define it; on the object itself when it is a plain object (any realm's
  // Object.prototype has a null prototype).
  const proto = Object.getPrototypeOf(nav) as object | null;
  const target = proto && Object.getPrototypeOf(proto) !== null ? proto : nav;
  Object.defineProperty(target, 'mediaDevices', {
    configurable: true,
    enumerable: true,
    get: () => mediaDevices,
  });
  // DOM-4: navigator.permissions.query({ name: 'camera' }) answers 'granted' once both camera permissions are held.
  const glue = (g as unknown as Record<symbol, unknown>)[Symbol.for('iwn.glue')] as
    | { addPermissionSource?: (source: () => readonly string[]) => void }
    | undefined;
  glue?.addPermissionSource?.(() => (permission() === true ? ['camera'] : []));
  return true;
}
