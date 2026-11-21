/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// HTMLElement and the element interfaces apps create (DOM-6, DOM-8, DOM-9), plus SVGElement for parsed SVG assets.
// No rendering: these keep attributes, reflect them as properties and fire the events an app waits for.
// - HTMLCanvasElement: the canvas2d prelude adds width/height/getContext/toDataURL/toBlob to this prototype;
//   without it (or for 'webgl'/'webgl2' it does not create) getContext asks the WebGL prelude.
// - HTMLImageElement is the image prelude's (it subclasses this HTMLElement).
// - <script src> runs (classic through fetch + global eval, module through import()) and fires load/error;
//   <link> and <style> are accepted and fire load (no styling).
// - <video>/<audio> decode nothing: canPlayType() is '', play() rejects with NotSupportedError naming the API, and a
//   src fires `error` (MEDIA_ERR_SRC_NOT_SUPPORTED), so apps can feature-detect and fall back. The one exception is
//   a camera MediaStream as srcObject (XR-CAM-1), which plays (see the media section).

import {
  BaseEvent,
  G,
  HTML_NS,
  SVG_NS,
  defineHandler,
  documentURL,
  domException,
  lower,
  queueTask,
  reportException,
  str,
  warn,
} from './env.ts';
import { DOMMatrix, DOMRect } from './geometry.ts';
import { ALREADY_STARTED, DOMTokenList, DocumentFragment, Element, canvasConnected, type Node } from './nodes.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Event handler IDL attributes on HTMLElement, Document and Window (GlobalEventHandlers, the common ones). */
export const GLOBAL_HANDLERS = [
  'abort', 'auxclick', 'beforeinput', 'blur', 'cancel', 'change', 'click', 'close', 'contextmenu', 'copy', 'cut',
  'dblclick', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'dragstart', 'drop', 'error', 'focus',
  'focusin', 'focusout', 'input', 'invalid', 'keydown', 'keypress', 'keyup', 'load', 'loadeddata', 'loadedmetadata',
  'loadstart', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout', 'mouseover', 'mouseup', 'paste',
  'pause', 'play', 'playing', 'pointercancel', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove',
  'pointerout', 'pointerover', 'pointerup', 'gotpointercapture', 'lostpointercapture', 'progress', 'reset', 'resize',
  'scroll', 'scrollend', 'select', 'selectionchange', 'submit', 'toggle', 'touchcancel', 'touchend', 'touchmove',
  'touchstart', 'wheel', 'animationstart', 'animationend', 'animationiteration', 'transitionend', 'transitionstart',
  'canplay', 'canplaythrough', 'durationchange', 'emptied', 'ended', 'ratechange', 'seeked', 'seeking', 'stalled',
  'suspend', 'timeupdate', 'volumechange', 'waiting',
];

function fire(target: any, type: string, init: Record<string, unknown> = {}): boolean {
  const E = BaseEvent;
  return target.dispatchEvent(new E(type, init));
}

function resolveURL(value: string): string {
  try {
    return new G.URL(value, documentURL()).href;
  } catch {
    return value;
  }
}

/** Defines reflected string / boolean / number / URL properties for attributes (HTML §2.6.1). */
function reflect(proto: object, props: Array<[prop: string, kind: 's' | 'b' | 'n' | 'u' | 'l', attr?: string, def?: unknown]>): void {
  for (const [prop, kind, attrName, def] of props) {
    const attr = attrName ?? lower(prop);
    Object.defineProperty(proto, prop, {
      get(this: Element) {
        const v = this.getAttribute(attr);
        switch (kind) {
          case 'b':
            return v !== null;
          case 'n': {
            const n = v === null ? NaN : parseInt(v, 10);
            return Number.isFinite(n) ? n : (def as number) ?? 0;
          }
          case 'u':
            return v === null ? '' : resolveURL(v);
          case 'l':
            return v === null ? ((def as string) ?? '') : lower(v);
          default:
            return v ?? ((def as string) ?? '');
        }
      },
      set(this: Element, v: unknown) {
        if (kind === 'b') {
          if (v) this.setAttribute(attr, '');
          else this.removeAttribute(attr);
        } else if (kind === 'n') this.setAttribute(attr, String(Math.trunc(Number(v)) || 0));
        else this.setAttribute(attr, str(v));
      },
      configurable: true,
      enumerable: true,
    });
  }
}

// --- HTMLElement --------------------------------------------------------------------------------------------------

export class HTMLElement extends Element {
  constructor(localName?: string, doc?: unknown) {
    super(localName, HTML_NS, null);
    if (doc) this._doc = doc;
  }
  get tabIndex(): number {
    const v = this.getAttribute('tabindex');
    const n = v === null ? NaN : parseInt(v, 10);
    if (Number.isFinite(n)) return n;
    return /^(a|button|input|select|textarea|iframe|area)$/.test(this.localName) ? 0 : -1;
  }
  set tabIndex(v: number) {
    this.setAttribute('tabindex', String(Math.trunc(Number(v)) || 0));
  }
  get isContentEditable(): boolean {
    return false;
  }
  get contentEditable(): string {
    const v = this.getAttribute('contenteditable');
    return v === null ? 'inherit' : v === '' ? 'true' : lower(v);
  }
  set contentEditable(v: string) {
    this.setAttribute('contenteditable', str(v));
  }
  get offsetWidth(): number {
    return this.clientWidth;
  }
  get offsetHeight(): number {
    return this.clientHeight;
  }
  get offsetTop(): number {
    return 0;
  }
  get offsetLeft(): number {
    return 0;
  }
  get offsetParent(): Element | null {
    if (!this.isConnected || this.localName === 'body' || this.localName === 'html') return null;
    return this._doc?.body ?? null;
  }
  focus(_options?: unknown): void {
    const doc = this._doc;
    if (!doc || !this.isConnected || doc._active === this) return;
    const prev = doc._active as HTMLElement | null;
    doc._active = this;
    const FE = G.FocusEvent ?? BaseEvent;
    if (prev && prev !== this) {
      prev.dispatchEvent(new FE('blur', { relatedTarget: this }));
      prev.dispatchEvent(new FE('focusout', { bubbles: true, relatedTarget: this }));
    }
    this.dispatchEvent(new FE('focus', { relatedTarget: prev }));
    this.dispatchEvent(new FE('focusin', { bubbles: true, relatedTarget: prev }));
  }
  blur(): void {
    const doc = this._doc;
    if (!doc || doc._active !== this) return;
    doc._active = null;
    const FE = G.FocusEvent ?? BaseEvent;
    this.dispatchEvent(new FE('blur', {}));
    this.dispatchEvent(new FE('focusout', { bubbles: true }));
  }
  click(): void {
    if (this.hasAttribute('disabled')) return;
    const ME = G.MouseEvent ?? BaseEvent;
    this.dispatchEvent(new ME('click', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
  }
  showPopover(): void {}
  hidePopover(): void {}
  togglePopover(): boolean {
    return false;
  }
  attachInternals(): never {
    throw domException('ElementInternals is not supported.', 'NotSupportedError');
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLElement';
  }
}
reflect(HTMLElement.prototype, [
  ['title', 's'], ['lang', 's'], ['dir', 's'], ['hidden', 'b'], ['accessKey', 's', 'accesskey'], ['autofocus', 'b'],
  ['inert', 'b'], ['nonce', 's'], ['inputMode', 's', 'inputmode'], ['enterKeyHint', 's', 'enterkeyhint'],
  ['autocapitalize', 's'], ['popover', 's'],
]);
for (const [prop, attr, def] of [['draggable', 'draggable', false], ['spellcheck', 'spellcheck', true], ['translate', 'translate', true]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    get(this: Element) {
      const v = this.getAttribute(attr);
      return v === null ? def : v !== 'false';
    },
    set(this: Element, v: unknown) {
      this.setAttribute(attr, v ? 'true' : 'false');
    },
    configurable: true,
    enumerable: true,
  });
}
for (const t of GLOBAL_HANDLERS) defineHandler(HTMLElement.prototype, t);

function simple(name: string, props?: Parameters<typeof reflect>[1]): typeof HTMLElement {
  const C = { [name]: class extends HTMLElement {} }[name]!;
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  if (props) reflect(C.prototype, props);
  return C;
}

export const HTMLHtmlElement = simple('HTMLHtmlElement', [['version', 's']]);
export const HTMLHeadElement = simple('HTMLHeadElement');
export const HTMLBodyElement = simple('HTMLBodyElement', [['text', 's'], ['link', 's'], ['vLink', 's', 'vlink'], ['aLink', 's', 'alink'], ['bgColor', 's', 'bgcolor'], ['background', 's']]);
export const HTMLDivElement = simple('HTMLDivElement', [['align', 's']]);
export const HTMLSpanElement = simple('HTMLSpanElement');
export const HTMLParagraphElement = simple('HTMLParagraphElement', [['align', 's']]);
export const HTMLHeadingElement = simple('HTMLHeadingElement', [['align', 's']]);
export const HTMLPreElement = simple('HTMLPreElement');
export const HTMLBRElement = simple('HTMLBRElement');
export const HTMLHRElement = simple('HTMLHRElement');
export const HTMLUListElement = simple('HTMLUListElement');
export const HTMLOListElement = simple('HTMLOListElement', [['reversed', 'b'], ['start', 'n', 'start', 1], ['type', 's']]);
export const HTMLLIElement = simple('HTMLLIElement', [['value', 'n']]);
export const HTMLLabelElement = simple('HTMLLabelElement', [['htmlFor', 's', 'for']]);
export const HTMLMetaElement = simple('HTMLMetaElement', [['name', 's'], ['content', 's'], ['httpEquiv', 's', 'http-equiv'], ['media', 's']]);
export const HTMLBaseElement = simple('HTMLBaseElement', [['href', 'u'], ['target', 's']]);
export const HTMLTableElement = simple('HTMLTableElement');
export const HTMLTableRowElement = simple('HTMLTableRowElement');
export const HTMLTableCellElement = simple('HTMLTableCellElement', [['colSpan', 'n', 'colspan', 1], ['rowSpan', 'n', 'rowspan', 1]]);
export const HTMLTableSectionElement = simple('HTMLTableSectionElement');
export const HTMLFieldSetElement = simple('HTMLFieldSetElement', [['disabled', 'b'], ['name', 's']]);
export const HTMLLegendElement = simple('HTMLLegendElement');
export const HTMLSourceElement = simple('HTMLSourceElement', [['src', 'u'], ['type', 's'], ['srcset', 's'], ['sizes', 's'], ['media', 's']]);
export const HTMLTrackElement = simple('HTMLTrackElement', [['src', 'u'], ['kind', 's'], ['srclang', 's'], ['label', 's'], ['default', 'b']]);
export const HTMLPictureElement = simple('HTMLPictureElement');
export const HTMLSlotElement = simple('HTMLSlotElement', [['name', 's']]);
export const HTMLDataElement = simple('HTMLDataElement', [['value', 's']]);
export const HTMLTimeElement = simple('HTMLTimeElement', [['dateTime', 's', 'datetime']]);
export const HTMLProgressElement = simple('HTMLProgressElement');
export const HTMLUnknownElement = simple('HTMLUnknownElement');

export class HTMLTitleElement extends HTMLElement {
  get text(): string {
    return this.textContent ?? '';
  }
  set text(v: string) {
    this.textContent = v;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLTitleElement';
  }
}

export class HTMLAnchorElement extends HTMLElement {
  get relList(): DOMTokenList {
    return ((this as any)._relList ??= new DOMTokenList(this, 'rel', ['noreferrer', 'noopener', 'opener']));
  }
  get text(): string {
    return this.textContent ?? '';
  }
  set text(v: string) {
    this.textContent = v;
  }
  /** @internal */ _url(): URL | null {
    const v = this.getAttribute('href');
    if (v === null) return null;
    try {
      return new G.URL(v, documentURL());
    } catch {
      return null;
    }
  }
  override toString(): string {
    return (this as any).href;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLAnchorElement';
  }
}
reflect(HTMLAnchorElement.prototype, [['href', 'u'], ['target', 's'], ['download', 's'], ['rel', 's'], ['hreflang', 's'], ['type', 's'], ['referrerPolicy', 's', 'referrerpolicy'], ['ping', 's']]);
for (const part of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'username', 'password', 'origin'] as const) {
  Object.defineProperty(HTMLAnchorElement.prototype, part, {
    get(this: HTMLAnchorElement) {
      const u = this._url();
      return u ? String((u as any)[part]) : part === 'origin' ? '' : '';
    },
    set(this: HTMLAnchorElement, v: string) {
      if (part === 'origin') return;
      const u = this._url();
      if (!u) return;
      (u as any)[part] = str(v);
      this.setAttribute('href', u.href);
    },
    configurable: true,
    enumerable: true,
  });
}

// --- canvas ----------------------------------------------------------------------------------------------------------

const CANVAS_CTX = Symbol('iwn.dom.canvasContext');

export class HTMLCanvasElement extends HTMLElement {
  declare [CANVAS_CTX]: { type: string; ctx: object } | undefined;
  get width(): number {
    const n = parseInt(this.getAttribute('width') ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 300;
  }
  set width(v: number) {
    this.setAttribute('width', String(Number(v) >>> 0));
  }
  get height(): number {
    const n = parseInt(this.getAttribute('height') ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 150;
  }
  set height(v: number) {
    this.setAttribute('height', String(Number(v) >>> 0));
  }
  getContext(type: string, attributes?: unknown): object | null {
    const t = str(type);
    const have = this[CANVAS_CTX];
    if (have) return have.type === t || (have.type === 'webgl' && t === 'experimental-webgl') ? have.ctx : null;
    if (t !== 'webgl' && t !== 'webgl2' && t !== 'experimental-webgl') return null;
    const gl = G.__iwnWebGL;
    if (!gl || typeof gl.createContext !== 'function') return null;
    const ctx = gl.createContext(this, t === 'webgl2' ? 'webgl2' : 'webgl', attributes);
    if (ctx) this[CANVAS_CTX] = { type: t === 'experimental-webgl' ? 'webgl' : t, ctx };
    return ctx ?? null;
  }
  toDataURL(_type?: string, _quality?: number): string {
    return 'data:,';
  }
  toBlob(callback: (b: unknown) => void, _type?: string, _quality?: number): void {
    queueTask(() => callback(null));
  }
  override _connectedChanged(connected: boolean): void {
    canvasConnected(this, connected);
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLCanvasElement';
  }
}
defineHandler(HTMLCanvasElement.prototype, 'webglcontextlost');
defineHandler(HTMLCanvasElement.prototype, 'webglcontextrestored');
defineHandler(HTMLCanvasElement.prototype, 'webglcontextcreationerror');

// --- media -----------------------------------------------------------------------------------------------------------
// No decoder: a `src` (or a srcObject that is not a camera stream) fails as an unplayable source. A camera
// MediaStream (web/xr camera.ts, XR-CAM-1) plays: it hands the element its video through MEDIA_FEED, and the element
// runs HTML's readyState steps on its frames, resolves play(), calls requestVideoFrameCallback callbacks per frame,
// and is a TexImageSource / CanvasImageSource of its newest frame (runtime/image INTEROP.md's IMAGE_SOURCE).

class TimeRanges {
  get length(): number {
    return 0;
  }
  start(_i: number): number {
    throw domException('The index provided is greater than or equal to the number of ranges.', 'IndexSizeError');
  }
  end(_i: number): number {
    throw domException('The index provided is greater than or equal to the number of ranges.', 'IndexSizeError');
  }
  get [Symbol.toStringTag](): string {
    return 'TimeRanges';
  }
}

/** The protocol a playable srcObject implements: `srcObject[MEDIA_FEED]()` returns its video, or null. */
export const MEDIA_FEED: unique symbol = Symbol.for('iwn.media.feed') as never;
/** runtime/image's source protocol (web/image/source.ts IMAGE_SOURCE). */
const IMAGE_SOURCE: unique symbol = Symbol.for('iwn.image.source') as never;

export interface MediaFeed {
  /** Size of the newest frame (0 before the first). */
  readonly width: number;
  readonly height: number;
  /** Frames delivered so far. */
  readonly frames: number;
  /** Seconds from the first frame to the newest (the frame's media time). */
  readonly mediaTime: number;
  /** The stream has no live video any more. */
  readonly ended: boolean;
  /** The newest frame as an image-source descriptor, null before the first. Read it during the call only. */
  frame(): object | null;
  /**
   * The newest frame, kept as it is until release() (what a paused element shows); null when the feed cannot keep
   * one (the element then shows the newest frame).
   */
  hold?(): { frame: object; release(): void } | null;
  /** `fn` runs after every new frame (ended = false) and once when the feed ends; returns the unsubscribe. */
  listen(fn: (ended: boolean) => void): () => void;
}

function feedOf(value: unknown): MediaFeed | null {
  if (value === null || typeof value !== 'object') return null;
  const f = (value as { [MEDIA_FEED]?: unknown })[MEDIA_FEED];
  return typeof f === 'function' ? ((f as () => MediaFeed | null).call(value) ?? null) : null;
}

const MEDIA = Symbol('iwn.dom.media');
interface MediaState {
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  error: { code: number; message: string } | null;
  srcObject: unknown;
  generation: number;
  // a playing feed
  feed: MediaFeed | null;
  unlisten: (() => void) | null;
  /** The frame a paused element shows (HTML: the frame at the current playback position, which a pause stops). */
  held: { frame: object; release(): void } | null;
  ready: number;
  network: number;
  paused: boolean;
  ended: boolean;
  presented: number;
  width: number;
  height: number;
  plays: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  callbacks: Map<number, (now: number, metadata: object) => void>;
  nextCallback: number;
}

const now = (): number => (typeof G.performance?.now === 'function' ? G.performance.now() : Date.now());

export class HTMLMediaElement extends HTMLElement {
  static readonly NETWORK_EMPTY = 0;
  static readonly NETWORK_IDLE = 1;
  static readonly NETWORK_LOADING = 2;
  static readonly NETWORK_NO_SOURCE = 3;
  static readonly HAVE_NOTHING = 0;
  static readonly HAVE_METADATA = 1;
  static readonly HAVE_CURRENT_DATA = 2;
  static readonly HAVE_FUTURE_DATA = 3;
  static readonly HAVE_ENOUGH_DATA = 4;
  /** @internal */ get _m(): MediaState {
    return ((this as any)[MEDIA] ??= {
      volume: 1, muted: false, playbackRate: 1, defaultPlaybackRate: 1, error: null, srcObject: null, generation: 0,
      feed: null, unlisten: null, held: null, ready: 0, network: 0, paused: true, ended: false, presented: 0, width: 0,
      height: 0, plays: [], callbacks: new Map(), nextCallback: 0,
    });
  }
  get currentSrc(): string {
    return '';
  }
  get currentTime(): number {
    const m = this._m;
    return m.feed && m.ready > 0 ? m.feed.mediaTime : 0;
  }
  set currentTime(_v: number) {}
  get duration(): number {
    // a MediaStream is live: Infinity once its metadata is known (Media Capture and Streams §6.1)
    const m = this._m;
    return m.feed && m.ready > 0 ? Infinity : NaN;
  }
  get paused(): boolean {
    return this._m.paused;
  }
  get ended(): boolean {
    return this._m.ended;
  }
  get seeking(): boolean {
    return false;
  }
  get readyState(): number {
    return this._m.ready;
  }
  get networkState(): number {
    const m = this._m;
    return m.feed ? m.network : m.error ? 3 : 0;
  }
  get error(): { code: number; message: string } | null {
    return this._m.error;
  }
  get volume(): number {
    return this._m.volume;
  }
  set volume(v: number) {
    const n = Number(v);
    if (!(n >= 0 && n <= 1)) throw domException(`The volume provided (${v}) is outside the range [0, 1].`, 'IndexSizeError');
    this._m.volume = n;
  }
  get muted(): boolean {
    return this._m.muted;
  }
  set muted(v: boolean) {
    this._m.muted = !!v;
  }
  get playbackRate(): number {
    return this._m.playbackRate;
  }
  set playbackRate(v: number) {
    this._m.playbackRate = Number(v);
  }
  get defaultPlaybackRate(): number {
    return this._m.defaultPlaybackRate;
  }
  set defaultPlaybackRate(v: number) {
    this._m.defaultPlaybackRate = Number(v);
  }
  get srcObject(): unknown {
    return this._m.srcObject;
  }
  set srcObject(v: unknown) {
    const m = this._m;
    this._detachFeed();
    m.srcObject = v ?? null;
    m.error = null;
    if (!v) return;
    const feed = feedOf(v);
    if (feed) this._attachFeed(feed);
    else this._unsupported();
  }
  get buffered(): TimeRanges {
    return new TimeRanges();
  }
  get played(): TimeRanges {
    return new TimeRanges();
  }
  get seekable(): TimeRanges {
    return new TimeRanges();
  }
  get textTracks(): unknown[] {
    return [];
  }
  canPlayType(_type: string): string {
    return '';
  }
  play(): Promise<void> {
    const m = this._m;
    if (!m.feed) {
      return Promise.reject(
        domException(`${this[Symbol.toStringTag] === 'HTMLVideoElement' ? 'HTMLVideoElement' : 'HTMLMediaElement'}.play(): media playback is not supported by @iwer/native in this alpha (a camera MediaStream as srcObject plays)`, 'NotSupportedError'),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const gen = m.generation;
      if (m.paused) {
        m.paused = false;
        this._hold(false);
        queueTask(() => {
          if (m.generation !== gen) return;
          fire(this, 'play');
          if (m.ready >= 3 && !m.paused) fire(this, 'playing');
        });
      }
      // HTML: the promise resolves once playback can start (the 'playing' notification).
      if (m.ready >= 3) queueTask(() => resolve());
      else m.plays.push({ resolve, reject });
    });
  }
  pause(): void {
    const m = this._m;
    if (!m.feed || m.paused) return;
    m.paused = true;
    if (m.ready >= 2) this._hold(true);
    const gen = m.generation;
    this._settlePlays(domException('The play() request was interrupted by a call to pause().', 'AbortError'));
    queueTask(() => {
      if (m.generation === gen) fire(this, 'pause');
    });
  }
  load(): void {
    const m = this._m;
    if (m.feed) {
      const feed = m.feed;
      this._detachFeed();
      this._attachFeed(feed);
    } else if (this.getAttribute('src')) this._unsupported();
  }
  fastSeek(_t: number): void {}
  addTextTrack(): never {
    throw domException('HTMLMediaElement.addTextTrack(): text tracks are not supported by @iwer/native in this alpha', 'NotSupportedError');
  }
  setSinkId(): Promise<void> {
    return Promise.reject(domException('HTMLMediaElement.setSinkId() is not supported by @iwer/native', 'NotSupportedError'));
  }
  /** @internal: a source was given: report MEDIA_ERR_SRC_NOT_SUPPORTED (4) at a task, as for an unplayable source. */
  _unsupported(): void {
    const m = this._m;
    const gen = ++m.generation;
    queueTask(() => {
      if (m.generation !== gen) return;
      m.error = { code: 4, message: 'Media playback is not supported by @iwer/native in this alpha' };
      fire(this, 'error');
    });
  }
  /** @internal: start playing a camera stream (HTML's resource selection for a MediaProvider). */
  _attachFeed(feed: MediaFeed): void {
    const m = this._m;
    const gen = ++m.generation;
    m.feed = feed;
    m.network = 2;
    m.unlisten = feed.listen((ended) => this._feedChanged(gen, ended));
    queueTask(() => {
      if (m.generation !== gen) return;
      fire(this, 'loadstart');
      this._feedChanged(gen, false);
    });
  }
  /** @internal */
  _detachFeed(): void {
    const m = this._m;
    if (!m.feed) return;
    const gen = ++m.generation;
    const hadData = m.ready > 0;
    m.unlisten?.();
    m.unlisten = null;
    this._hold(false);
    m.feed = null;
    m.ready = 0;
    m.network = 0;
    m.ended = false;
    m.presented = 0;
    m.width = m.height = 0;
    // Pending requestVideoFrameCallback callbacks stay for the next presented frame, whatever its source (as in
    // Chromium): three's VideoTexture registers one and re-registers it only from inside it.
    this._settlePlays(domException('The play() request was interrupted by a new load request.', 'AbortError'));
    m.paused = true;
    if (hadData) {
      queueTask(() => {
        if (m.generation === gen) fire(this, 'emptied');
      });
    }
  }
  /** @internal: the feed has a new frame or ended. */
  _feedChanged(gen: number, ended: boolean): void {
    const m = this._m;
    const f = m.feed;
    if (m.generation !== gen || !f) return;
    if (ended || f.ended) {
      if (m.ended) return;
      m.ended = true;
      m.network = 1;
      fire(this, 'ended');
      return;
    }
    if (f.frames === 0 || f.frames === m.presented) return;
    m.presented = f.frames;
    if (m.ready === 0) {
      // HAVE_METADATA, then (a live stream has its data with its first frame) HAVE_ENOUGH_DATA
      m.network = 1;
      m.width = f.width;
      m.height = f.height;
      m.ready = 1;
      fire(this, 'durationchange');
      if (this instanceof HTMLVideoElement) fire(this, 'resize');
      fire(this, 'loadedmetadata');
      m.ready = 4;
      fire(this, 'loadeddata');
      fire(this, 'canplay');
      if (m.paused && this.hasAttribute('autoplay')) {
        m.paused = false;
        fire(this, 'play');
      }
      if (!m.paused) fire(this, 'playing');
      else this._hold(true); // not playing: it shows its first frame
      fire(this, 'canplaythrough');
      this._settlePlays(null);
    } else if (f.width !== m.width || f.height !== m.height) {
      m.width = f.width;
      m.height = f.height;
      if (this instanceof HTMLVideoElement) fire(this, 'resize');
    }
    if (!m.paused && m.callbacks.size > 0) this._runFrameCallbacks(f);
  }
  /** @internal: keep the current frame (paused) or let it go. */
  _hold(keep: boolean): void {
    const m = this._m;
    m.held?.release();
    m.held = null;
    if (!keep || !m.feed?.hold) return;
    try {
      m.held = m.feed.hold() ?? null;
    } catch (e) {
      reportException(e);
    }
  }
  /** @internal: requestVideoFrameCallback callbacks, once each, for the frame just presented. */
  _runFrameCallbacks(f: MediaFeed): void {
    const m = this._m;
    const list = [...m.callbacks.values()];
    m.callbacks.clear();
    const t = now();
    const metadata = {
      presentationTime: t, expectedDisplayTime: t, width: f.width, height: f.height, mediaTime: f.mediaTime,
      presentedFrames: f.frames, processingDuration: 0,
    };
    for (const cb of list) {
      try {
        cb.call(this, t, metadata);
      } catch (e) {
        reportException(e);
      }
    }
  }
  /** @internal: resolve (error null) or reject the pending play() promises. */
  _settlePlays(error: unknown): void {
    const m = this._m;
    const plays = m.plays;
    m.plays = [];
    for (const p of plays) {
      if (error) p.reject(error);
      else p.resolve();
    }
  }
  override _reflect(local: string, ns: string | null, _old: string | null, value: string | null): void {
    // srcObject wins over src (HTML resource selection)
    if (local === 'src' && ns === null && !this._m.feed) {
      if (value) this._unsupported();
      else {
        this._m.generation++;
        this._m.error = null;
      }
    }
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLMediaElement';
  }
}
reflect(HTMLMediaElement.prototype, [
  ['src', 'u'], ['crossOrigin', 's', 'crossorigin'], ['preload', 's', 'preload', 'auto'], ['autoplay', 'b'],
  ['loop', 'b'], ['controls', 'b'], ['defaultMuted', 'b', 'muted'],
]);
for (const [k, v] of Object.entries({ NETWORK_EMPTY: 0, NETWORK_IDLE: 1, NETWORK_LOADING: 2, NETWORK_NO_SOURCE: 3, HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4 })) {
  Object.defineProperty(HTMLMediaElement.prototype, k, { value: v, enumerable: true });
}

const NO_FRAME = { kind: 'pixels', origin: 'video', width: 0, height: 0, premultiplied: false, data: new Uint8Array(0) };

export class HTMLVideoElement extends HTMLMediaElement {
  get videoWidth(): number {
    const m = this._m;
    return m.ready > 0 ? m.width : 0;
  }
  get videoHeight(): number {
    const m = this._m;
    return m.ready > 0 ? m.height : 0;
  }
  getVideoPlaybackQuality(): Record<string, number> {
    return { creationTime: now(), droppedVideoFrames: 0, totalVideoFrames: this._m.presented, corruptedVideoFrames: 0 };
  }
  /** Calls `callback(now, metadata)` once, when the next frame is presented (Video Frame Callback draft). */
  requestVideoFrameCallback(callback: (now: number, metadata: object) => void): number {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'requestVideoFrameCallback' on 'HTMLVideoElement': parameter 1 is not of type 'Function'.");
    }
    const m = this._m;
    const id = ++m.nextCallback;
    m.callbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(handle: number): void {
    this._m.callbacks.delete(Number(handle));
  }
  /**
   * TexImageSource / CanvasImageSource: the newest frame of a playing camera stream, the frame a paused one stopped at
   * (0x0 before its first).
   */
  [IMAGE_SOURCE](): object {
    const m = this._m;
    if (!m.feed) throw new TypeError('video sources are not supported by this runtime (only a camera MediaStream plays in a <video>)');
    if (m.ready < 2) return NO_FRAME;
    return (m.paused && m.held ? m.held.frame : m.feed.frame()) ?? NO_FRAME;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLVideoElement';
  }
}
reflect(HTMLVideoElement.prototype, [['width', 'n'], ['height', 'n'], ['poster', 'u'], ['playsInline', 'b', 'playsinline']]);

export class HTMLAudioElement extends HTMLMediaElement {
  override get [Symbol.toStringTag](): string {
    return 'HTMLAudioElement';
  }
}

// --- forms -----------------------------------------------------------------------------------------------------------

const INPUT_TYPES = new Set([
  'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local',
  'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button',
]);
const VALUE = Symbol('iwn.dom.value');
const CHECKED = Symbol('iwn.dom.checked');

class FormControl extends HTMLElement {
  get form(): Element | null {
    return this.closest('form');
  }
  get labels(): unknown[] {
    return [];
  }
  get validity(): Record<string, boolean> {
    return { valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false };
  }
  get validationMessage(): string {
    return '';
  }
  get willValidate(): boolean {
    return false;
  }
  checkValidity(): boolean {
    return true;
  }
  reportValidity(): boolean {
    return true;
  }
  setCustomValidity(_m: string): void {}
}
reflect(FormControl.prototype, [['name', 's'], ['disabled', 'b'], ['autofocus', 'b']]);

export class HTMLInputElement extends FormControl {
  declare [VALUE]: string | undefined;
  declare [CHECKED]: boolean | undefined;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection: string | null = 'none';
  get type(): string {
    const t = lower(this.getAttribute('type') ?? '');
    return INPUT_TYPES.has(t) ? t : 'text';
  }
  set type(v: string) {
    this.setAttribute('type', str(v));
  }
  get value(): string {
    return this[VALUE] ?? this.getAttribute('value') ?? (this.type === 'checkbox' || this.type === 'radio' ? 'on' : '');
  }
  set value(v: string) {
    this[VALUE] = v === null ? '' : str(v);
  }
  get defaultValue(): string {
    return this.getAttribute('value') ?? '';
  }
  set defaultValue(v: string) {
    this.setAttribute('value', str(v));
  }
  get valueAsNumber(): number {
    const n = parseFloat(this.value);
    return Number.isFinite(n) ? n : NaN;
  }
  set valueAsNumber(v: number) {
    this.value = String(v);
  }
  get checked(): boolean {
    return this[CHECKED] ?? this.hasAttribute('checked');
  }
  set checked(v: boolean) {
    this[CHECKED] = !!v;
  }
  get defaultChecked(): boolean {
    return this.hasAttribute('checked');
  }
  set defaultChecked(v: boolean) {
    this.toggleAttribute('checked', !!v);
  }
  get files(): null {
    return null;
  }
  select(): void {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
  setSelectionRange(start: number, end: number, direction = 'none'): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  setRangeText(text: string): void {
    this.value = str(text);
  }
  showPicker(): void {
    throw domException('HTMLInputElement.showPicker(): pickers are not supported by @iwer/native in this alpha', 'NotSupportedError');
  }
  stepUp(): void {}
  stepDown(): void {}
  override get [Symbol.toStringTag](): string {
    return 'HTMLInputElement';
  }
}
reflect(HTMLInputElement.prototype, [
  ['placeholder', 's'], ['readOnly', 'b', 'readonly'], ['required', 'b'], ['min', 's'], ['max', 's'], ['step', 's'],
  ['maxLength', 'n', 'maxlength', -1], ['minLength', 'n', 'minlength', -1], ['pattern', 's'], ['multiple', 'b'],
  ['accept', 's'], ['autocomplete', 's'], ['size', 'n', 'size', 20], ['src', 'u'], ['alt', 's'], ['list', 's'],
]);

export class HTMLTextAreaElement extends FormControl {
  declare [VALUE]: string | undefined;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = 'none';
  get type(): string {
    return 'textarea';
  }
  get value(): string {
    return this[VALUE] ?? this.textContent ?? '';
  }
  set value(v: string) {
    this[VALUE] = v === null ? '' : str(v);
  }
  get defaultValue(): string {
    return this.textContent ?? '';
  }
  set defaultValue(v: string) {
    this.textContent = v;
  }
  get textLength(): number {
    return this.value.length;
  }
  select(): void {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
  setSelectionRange(start: number, end: number, direction = 'none'): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLTextAreaElement';
  }
}
reflect(HTMLTextAreaElement.prototype, [['placeholder', 's'], ['readOnly', 'b', 'readonly'], ['required', 'b'], ['rows', 'n', 'rows', 2], ['cols', 'n', 'cols', 20], ['maxLength', 'n', 'maxlength', -1], ['wrap', 's']]);

export class HTMLButtonElement extends FormControl {
  get type(): string {
    const t = lower(this.getAttribute('type') ?? '');
    return t === 'reset' || t === 'button' ? t : 'submit';
  }
  set type(v: string) {
    this.setAttribute('type', str(v));
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLButtonElement';
  }
}
reflect(HTMLButtonElement.prototype, [['value', 's']]);

export class HTMLOptionElement extends HTMLElement {
  get value(): string {
    return this.getAttribute('value') ?? (this.textContent ?? '').trim();
  }
  set value(v: string) {
    this.setAttribute('value', str(v));
  }
  get text(): string {
    return this.textContent ?? '';
  }
  set text(v: string) {
    this.textContent = v;
  }
  get index(): number {
    const sel = this.closest('select') as HTMLSelectElement | null;
    return sel ? [...sel.options].indexOf(this) : 0;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLOptionElement';
  }
}
reflect(HTMLOptionElement.prototype, [['selected', 'b'], ['disabled', 'b'], ['label', 's'], ['defaultSelected', 'b', 'selected']]);

export class HTMLSelectElement extends FormControl {
  get options(): HTMLOptionElement[] {
    return [...this.querySelectorAll('option')] as HTMLOptionElement[];
  }
  get length(): number {
    return this.options.length;
  }
  get selectedIndex(): number {
    const opts = this.options;
    const i = opts.findIndex((o) => o.hasAttribute('selected'));
    return i >= 0 ? i : opts.length ? 0 : -1;
  }
  set selectedIndex(i: number) {
    this.options.forEach((o, k) => o.toggleAttribute('selected', k === i));
  }
  get value(): string {
    return this.options[this.selectedIndex]?.value ?? '';
  }
  set value(v: string) {
    this.selectedIndex = this.options.findIndex((o) => o.value === str(v));
  }
  get type(): string {
    return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
  }
  add(el: HTMLOptionElement, before?: Element | null): void {
    this.insertBefore(el, before ?? null);
  }
  item(i: number): HTMLOptionElement | null {
    return this.options[i] ?? null;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLSelectElement';
  }
}
reflect(HTMLSelectElement.prototype, [['multiple', 'b'], ['required', 'b'], ['size', 'n']]);

export class HTMLFormElement extends HTMLElement {
  get elements(): Element[] {
    return [...this.querySelectorAll('input,select,textarea,button,fieldset,output,object')] as Element[];
  }
  get length(): number {
    return this.elements.length;
  }
  submit(): void {
    warn('HTMLFormElement.submit() ignored: a packaged app has no form navigation');
  }
  requestSubmit(): void {
    if (fire(this, 'submit', { bubbles: true, cancelable: true })) warn('form submission ignored: a packaged app has no form navigation');
  }
  reset(): void {
    fire(this, 'reset', { bubbles: true, cancelable: true });
  }
  checkValidity(): boolean {
    return true;
  }
  reportValidity(): boolean {
    return true;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLFormElement';
  }
}
reflect(HTMLFormElement.prototype, [['action', 'u'], ['method', 'l', 'method', 'get'], ['target', 's'], ['name', 's'], ['enctype', 's'], ['noValidate', 'b', 'novalidate'], ['autocomplete', 's']]);

// --- iframe / template ------------------------------------------------------------------------------------------------

export class HTMLIFrameElement extends HTMLElement {
  get contentWindow(): null {
    return null;
  }
  get contentDocument(): null {
    return null;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLIFrameElement';
  }
}
reflect(HTMLIFrameElement.prototype, [['src', 'u'], ['srcdoc', 's'], ['name', 's'], ['allow', 's'], ['allowFullscreen', 'b', 'allowfullscreen'], ['width', 's'], ['height', 's'], ['loading', 's']]);

export class HTMLTemplateElement extends HTMLElement {
  /** @internal */ _content: DocumentFragment | null = null;
  get content(): DocumentFragment {
    if (!this._content) {
      const f = new DocumentFragment();
      f._doc = this._doc;
      this._content = f;
    }
    return this._content;
  }
  /** HTML template cloning steps: a deep clone copies the template contents too (document.importNode does the same). */
  override cloneNode(deep = false): Node {
    const c = super.cloneNode(deep) as HTMLTemplateElement;
    if (deep && this._content) for (const k of this._content.childNodes) c.content.appendChild(k.cloneNode(true));
    return c;
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLTemplateElement';
  }
}

// --- script / link / style (DOM-9) ------------------------------------------------------------------------------------

const JS_TYPES = /^(|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|application\/x-javascript|text\/x-javascript|text\/jscript|text\/livescript|module)$/;
const SCRIPT_STARTED = ALREADY_STARTED;

/** Runs classic script text in the global scope (indirect eval: `this` is the window, top-level declarations global). */
function runClassic(source: string, url: string): void {
  const globalEval = G.eval as (s: string) => unknown;
  globalEval(`${source}\n//# sourceURL=${url}`);
}

export class HTMLScriptElement extends HTMLElement {
  declare [SCRIPT_STARTED]: boolean | undefined;
  /** @internal */ _forceAsync = true;
  get text(): string {
    return this.textContent ?? '';
  }
  set text(v: string) {
    this.textContent = v;
  }
  get async(): boolean {
    return this._forceAsync || this.hasAttribute('async');
  }
  set async(v: boolean) {
    this._forceAsync = false;
    this.toggleAttribute('async', !!v);
  }
  static supports(type: string): boolean {
    return type === 'classic' || type === 'module';
  }
  /** HTML script cloning steps: the copy keeps "already started" (a DOMParser or innerHTML script never runs). */
  override _clone(doc: any): Node {
    const c = super._clone(doc) as HTMLScriptElement;
    if (this[SCRIPT_STARTED]) c[SCRIPT_STARTED] = true;
    return c;
  }
  override _connectedChanged(connected: boolean): void {
    if (connected) this._prepare();
  }
  override _reflect(local: string, ns: string | null, _old: string | null, value: string | null): void {
    if (local === 'src' && ns === null && value !== null && this.isConnected) this._prepare();
  }
  /** @internal: HTML "prepare the script element", simplified. */
  _prepare(): void {
    if (this[SCRIPT_STARTED]) return;
    const owner = this._doc;
    if (!owner || owner._inert) return; // DOMParser / createHTMLDocument documents never run scripts
    if (owner._parsing) {
      this[SCRIPT_STARTED] = true; // the entry document's scripts: the core already ran them
      return;
    }
    const src = this.getAttribute('src');
    const text = this.textContent ?? '';
    if (src === null && text === '') return;
    const type = lower((this.getAttribute('type') ?? this.getAttribute('language') ?? '').trim());
    if (!JS_TYPES.test(type)) return; // data blocks (JSON, templates) never run
    const isModule = type === 'module';
    if (!isModule && this.hasAttribute('nomodule')) return;
    this[SCRIPT_STARTED] = true;
    const doc = this._doc;
    if (src !== null) {
      const url = resolveURL(src);
      if (src === '') {
        queueTask(() => fire(this, 'error'));
        return;
      }
      if (isModule) {
        import(/* @vite-ignore */ url).then(
          () => fire(this, 'load'),
          (e) => {
            reportException(e);
            fire(this, 'error');
          },
        );
        return;
      }
      const fetchFn = G.fetch;
      if (typeof fetchFn !== 'function') {
        queueTask(() => fire(this, 'error'));
        return;
      }
      Promise.resolve()
        .then(() => fetchFn(url))
        .then((res: any) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then(
          (source: string) => {
            const prev = doc?._currentScript ?? null;
            if (doc) doc._currentScript = this;
            try {
              runClassic(source, url);
            } catch (e) {
              reportException(e);
            } finally {
              if (doc) doc._currentScript = prev;
            }
            fire(this, 'load');
          },
          (e: unknown) => {
            warn(`script ${url} failed to load: ${e instanceof Error ? e.message : String(e)}`);
            fire(this, 'error');
          },
        );
      return;
    }
    // Inline script inserted by the app: runs now (classic) or as a data: module.
    if (isModule) {
      import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(text)}`).catch((e) => reportException(e));
      return;
    }
    const prev = doc?._currentScript ?? null;
    if (doc) doc._currentScript = this;
    try {
      runClassic(text, `${documentURL()}#inline-script`);
    } catch (e) {
      reportException(e);
    } finally {
      if (doc) doc._currentScript = prev;
    }
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLScriptElement';
  }
}
reflect(HTMLScriptElement.prototype, [
  ['src', 'u'], ['type', 's'], ['defer', 'b'], ['crossOrigin', 's', 'crossorigin'], ['integrity', 's'],
  ['noModule', 'b', 'nomodule'], ['charset', 's'], ['referrerPolicy', 's', 'referrerpolicy'], ['event', 's'],
  ['htmlFor', 's', 'for'], ['fetchPriority', 's', 'fetchpriority'],
]);

const LINK_LOADED = Symbol('iwn.dom.linkLoaded');
const LOAD_RELS = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch', 'icon', 'manifest', 'apple-touch-icon']);

export class HTMLLinkElement extends HTMLElement {
  declare [LINK_LOADED]: string | undefined;
  get relList(): DOMTokenList {
    return ((this as any)._relList ??= new DOMTokenList(this, 'rel', [
      'alternate', 'dns-prefetch', 'expect', 'icon', 'manifest', 'modulepreload', 'next', 'preconnect', 'prefetch',
      'preload', 'prerender', 'stylesheet',
    ]));
  }
  get sheet(): null {
    return null;
  }
  override _connectedChanged(connected: boolean): void {
    if (connected) this._maybeLoad();
  }
  override _reflect(local: string, ns: string | null): void {
    if ((local === 'href' || local === 'rel') && ns === null && this.isConnected) this._maybeLoad();
  }
  /** @internal: `load` for the resource kinds browsers fetch, at a task (DOM-9: accepted, nothing is applied). */
  _maybeLoad(): void {
    if ((this as any)[ALREADY_STARTED]) return; // from the entry document: its loads happened before boot
    const owner = this._doc;
    if (!owner || owner._inert || owner._parsing) return;
    const href = this.getAttribute('href');
    if (!href) return;
    const rels = (this.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rels.some((r) => LOAD_RELS.has(r))) return;
    const key = `${rels.join(' ')}|${href}`;
    if (this[LINK_LOADED] === key) return;
    this[LINK_LOADED] = key;
    queueTask(() => fire(this, 'load'));
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLLinkElement';
  }
}
reflect(HTMLLinkElement.prototype, [
  ['href', 'u'], ['rel', 's'], ['as', 's'], ['crossOrigin', 's', 'crossorigin'], ['type', 's'], ['media', 's'],
  ['sizes', 's'], ['integrity', 's'], ['hreflang', 's'], ['disabled', 'b'], ['referrerPolicy', 's', 'referrerpolicy'],
  ['fetchPriority', 's', 'fetchpriority'], ['imageSrcset', 's', 'imagesrcset'], ['imageSizes', 's', 'imagesizes'],
]);

export class HTMLStyleElement extends HTMLElement {
  get sheet(): null {
    return null;
  }
  override _connectedChanged(connected: boolean): void {
    const owner = this._doc;
    if (connected && !(this as any)[ALREADY_STARTED] && owner && !owner._inert && !owner._parsing) queueTask(() => fire(this, 'load'));
  }
  override get [Symbol.toStringTag](): string {
    return 'HTMLStyleElement';
  }
}
reflect(HTMLStyleElement.prototype, [['media', 's'], ['type', 's'], ['disabled', 'b']]);

// --- SVG ------------------------------------------------------------------------------------------------------------

export class SVGElement extends Element {
  constructor(localName?: string, doc?: unknown) {
    super(localName ?? 'svg', SVG_NS, null);
    if (doc) this._doc = doc;
  }
  get ownerSVGElement(): Element | null {
    for (let p = this.parentElement; p; p = p.parentElement) if (p.localName === 'svg' && p.namespaceURI === SVG_NS) return p;
    return null;
  }
  get viewportElement(): Element | null {
    return this.ownerSVGElement;
  }
  get dataset(): Record<string, string> {
    return super.dataset;
  }
  getBBox(): DOMRect {
    return new DOMRect(0, 0, 0, 0);
  }
  getCTM(): DOMMatrix {
    return new DOMMatrix();
  }
  getScreenCTM(): DOMMatrix {
    return new DOMMatrix();
  }
  focus(): void {}
  blur(): void {}
  override get [Symbol.toStringTag](): string {
    return 'SVGElement';
  }
}
for (const t of GLOBAL_HANDLERS) defineHandler(SVGElement.prototype, t);
export class SVGSVGElement extends SVGElement {
  createSVGMatrix(): DOMMatrix {
    return new DOMMatrix();
  }
  override get [Symbol.toStringTag](): string {
    return 'SVGSVGElement';
  }
}

/** Tag -> interface for HTML elements (`img` is the image prelude's, through the registry). */
export const HTML_TAGS: Record<string, new (localName?: string, doc?: unknown) => HTMLElement> = {
  html: HTMLHtmlElement, head: HTMLHeadElement, body: HTMLBodyElement, title: HTMLTitleElement, meta: HTMLMetaElement,
  base: HTMLBaseElement, link: HTMLLinkElement, style: HTMLStyleElement, script: HTMLScriptElement,
  div: HTMLDivElement, span: HTMLSpanElement, p: HTMLParagraphElement, pre: HTMLPreElement, br: HTMLBRElement,
  hr: HTMLHRElement, ul: HTMLUListElement, ol: HTMLOListElement, li: HTMLLIElement, a: HTMLAnchorElement,
  label: HTMLLabelElement, canvas: HTMLCanvasElement, video: HTMLVideoElement, audio: HTMLAudioElement,
  source: HTMLSourceElement, track: HTMLTrackElement, picture: HTMLPictureElement, input: HTMLInputElement,
  textarea: HTMLTextAreaElement, button: HTMLButtonElement, select: HTMLSelectElement, option: HTMLOptionElement,
  form: HTMLFormElement, fieldset: HTMLFieldSetElement, legend: HTMLLegendElement, iframe: HTMLIFrameElement,
  template: HTMLTemplateElement, table: HTMLTableElement, tr: HTMLTableRowElement, td: HTMLTableCellElement,
  th: HTMLTableCellElement, thead: HTMLTableSectionElement, tbody: HTMLTableSectionElement,
  tfoot: HTMLTableSectionElement, slot: HTMLSlotElement, data: HTMLDataElement, time: HTMLTimeElement,
  progress: HTMLProgressElement, h1: HTMLHeadingElement, h2: HTMLHeadingElement, h3: HTMLHeadingElement,
  h4: HTMLHeadingElement, h5: HTMLHeadingElement, h6: HTMLHeadingElement,
};
/** Tags that are HTMLElement itself (HTML §3.2.5 "HTMLElement" elements), not HTMLUnknownElement. */
export const PLAIN_HTML_ELEMENT_TAGS = new Set([
  'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'cite', 'code', 'dd', 'dfn', 'dt', 'em', 'figcaption',
  'figure', 'footer', 'header', 'hgroup', 'i', 'kbd', 'main', 'mark', 'nav', 'noscript', 'rp', 'rt', 'ruby', 's',
  'samp', 'search', 'section', 'small', 'strong', 'sub', 'summary', 'sup', 'u', 'var', 'wbr', 'center', 'nobr',
]);

/** All HTML element interfaces this module defines (for the global install). */
export const HTML_INTERFACES: Record<string, unknown> = {
  HTMLElement, HTMLHtmlElement, HTMLHeadElement, HTMLBodyElement, HTMLTitleElement, HTMLMetaElement, HTMLBaseElement,
  HTMLLinkElement, HTMLStyleElement, HTMLScriptElement, HTMLDivElement, HTMLSpanElement, HTMLParagraphElement,
  HTMLHeadingElement, HTMLPreElement, HTMLBRElement, HTMLHRElement, HTMLUListElement, HTMLOListElement, HTMLLIElement,
  HTMLAnchorElement, HTMLLabelElement, HTMLCanvasElement, HTMLMediaElement, HTMLVideoElement, HTMLAudioElement,
  HTMLSourceElement, HTMLTrackElement, HTMLPictureElement, HTMLInputElement, HTMLTextAreaElement, HTMLButtonElement,
  HTMLSelectElement, HTMLOptionElement, HTMLFormElement, HTMLFieldSetElement, HTMLLegendElement, HTMLIFrameElement,
  HTMLTemplateElement, HTMLTableElement, HTMLTableRowElement, HTMLTableCellElement, HTMLTableSectionElement,
  HTMLSlotElement, HTMLDataElement, HTMLTimeElement, HTMLProgressElement, HTMLUnknownElement, SVGElement,
  SVGSVGElement, TimeRanges,
};
