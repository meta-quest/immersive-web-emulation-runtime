/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The UI event constructors of DOM-2 (UI Events, Pointer Events, HTML): UIEvent, MouseEvent, PointerEvent,
// WheelEvent, KeyboardEvent, FocusEvent, InputEvent, CompositionEvent, plus PageTransitionEvent (the core fires
// pagehide/pageshow), StorageEvent and BeforeUnloadEvent. They subclass the web glue's Event. Nothing dispatches
// pointer or keyboard input on this runtime (XR input comes through WebXR); apps construct them and listen.

import { BaseEvent } from './env.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Init = Record<string, any>;
const n = (v: unknown, d = 0): number => (v === undefined ? d : Number(v));
const b = (v: unknown): boolean => !!v;

export class UIEvent extends BaseEvent {
  readonly view: unknown;
  readonly detail: number;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.view = init.view ?? null;
    this.detail = n(init.detail);
  }
  get which(): number {
    return 0;
  }
  initUIEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
    (this as any).initEvent(type, bubbles, cancelable);
  }
  get [Symbol.toStringTag](): string {
    return 'UIEvent';
  }
}

const MODIFIERS = ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const;

function modifierState(e: any, key: string): boolean {
  switch (key) {
    case 'Control':
      return e.ctrlKey;
    case 'Shift':
      return e.shiftKey;
    case 'Alt':
      return e.altKey;
    case 'Meta':
      return e.metaKey;
    default:
      return false;
  }
}

export class MouseEvent extends UIEvent {
  readonly screenX: number;
  readonly screenY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly movementX: number;
  readonly movementY: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly button: number;
  readonly buttons: number;
  readonly relatedTarget: unknown;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.screenX = n(init.screenX);
    this.screenY = n(init.screenY);
    this.clientX = n(init.clientX);
    this.clientY = n(init.clientY);
    this.movementX = n(init.movementX);
    this.movementY = n(init.movementY);
    this.ctrlKey = b(init.ctrlKey);
    this.shiftKey = b(init.shiftKey);
    this.altKey = b(init.altKey);
    this.metaKey = b(init.metaKey);
    this.button = n(init.button);
    this.buttons = n(init.buttons);
    this.relatedTarget = init.relatedTarget ?? null;
  }
  get pageX(): number {
    return this.clientX;
  }
  get pageY(): number {
    return this.clientY;
  }
  get x(): number {
    return this.clientX;
  }
  get y(): number {
    return this.clientY;
  }
  get offsetX(): number {
    return this.clientX;
  }
  get offsetY(): number {
    return this.clientY;
  }
  override get which(): number {
    return this.button + 1;
  }
  getModifierState(key: string): boolean {
    return modifierState(this, String(key));
  }
  initMouseEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
    (this as any).initEvent(type, bubbles, cancelable);
  }
  override get [Symbol.toStringTag](): string {
    return 'MouseEvent';
  }
}

export class PointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
  readonly tangentialPressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly altitudeAngle: number;
  readonly azimuthAngle: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly persistentDeviceId: number;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.pointerId = n(init.pointerId);
    this.width = n(init.width, 1);
    this.height = n(init.height, 1);
    this.pressure = n(init.pressure);
    this.tangentialPressure = n(init.tangentialPressure);
    this.tiltX = n(init.tiltX);
    this.tiltY = n(init.tiltY);
    this.twist = n(init.twist);
    this.altitudeAngle = n(init.altitudeAngle, Math.PI / 2);
    this.azimuthAngle = n(init.azimuthAngle);
    this.pointerType = init.pointerType === undefined ? '' : String(init.pointerType);
    this.isPrimary = b(init.isPrimary);
    this.persistentDeviceId = n(init.persistentDeviceId);
  }
  getCoalescedEvents(): PointerEvent[] {
    return [];
  }
  getPredictedEvents(): PointerEvent[] {
    return [];
  }
  override get [Symbol.toStringTag](): string {
    return 'PointerEvent';
  }
}

export class WheelEvent extends MouseEvent {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly deltaMode: number;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.deltaX = n(init.deltaX);
    this.deltaY = n(init.deltaY);
    this.deltaZ = n(init.deltaZ);
    this.deltaMode = n(init.deltaMode);
  }
  override get [Symbol.toStringTag](): string {
    return 'WheelEvent';
  }
}

export class KeyboardEvent extends UIEvent {
  static readonly DOM_KEY_LOCATION_STANDARD = 0;
  static readonly DOM_KEY_LOCATION_LEFT = 1;
  static readonly DOM_KEY_LOCATION_RIGHT = 2;
  static readonly DOM_KEY_LOCATION_NUMPAD = 3;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly charCode: number;
  readonly keyCode: number;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.key = init.key === undefined ? '' : String(init.key);
    this.code = init.code === undefined ? '' : String(init.code);
    this.location = n(init.location);
    this.ctrlKey = b(init.ctrlKey);
    this.shiftKey = b(init.shiftKey);
    this.altKey = b(init.altKey);
    this.metaKey = b(init.metaKey);
    this.repeat = b(init.repeat);
    this.isComposing = b(init.isComposing);
    this.charCode = n(init.charCode);
    this.keyCode = n(init.keyCode);
  }
  override get which(): number {
    return this.keyCode || this.charCode;
  }
  getModifierState(key: string): boolean {
    return modifierState(this, String(key));
  }
  initKeyboardEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
    (this as any).initEvent(type, bubbles, cancelable);
  }
  override get [Symbol.toStringTag](): string {
    return 'KeyboardEvent';
  }
}
void MODIFIERS;

export class FocusEvent extends UIEvent {
  readonly relatedTarget: unknown;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.relatedTarget = init.relatedTarget ?? null;
  }
  override get [Symbol.toStringTag](): string {
    return 'FocusEvent';
  }
}

export class InputEvent extends UIEvent {
  readonly data: string | null;
  readonly inputType: string;
  readonly isComposing: boolean;
  readonly dataTransfer: null = null;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.data = init.data ?? null;
    this.inputType = init.inputType === undefined ? '' : String(init.inputType);
    this.isComposing = b(init.isComposing);
  }
  getTargetRanges(): unknown[] {
    return [];
  }
  override get [Symbol.toStringTag](): string {
    return 'InputEvent';
  }
}

export class CompositionEvent extends UIEvent {
  readonly data: string;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.data = init.data === undefined ? '' : String(init.data);
  }
  override get [Symbol.toStringTag](): string {
    return 'CompositionEvent';
  }
}

export class PageTransitionEvent extends BaseEvent {
  readonly persisted: boolean;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.persisted = b(init.persisted);
  }
  get [Symbol.toStringTag](): string {
    return 'PageTransitionEvent';
  }
}

export class StorageEvent extends BaseEvent {
  readonly key: string | null;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly url: string;
  readonly storageArea: unknown;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.key = init.key ?? null;
    this.oldValue = init.oldValue ?? null;
    this.newValue = init.newValue ?? null;
    this.url = init.url === undefined ? '' : String(init.url);
    this.storageArea = init.storageArea ?? null;
  }
  get [Symbol.toStringTag](): string {
    return 'StorageEvent';
  }
}

export class BeforeUnloadEvent extends BaseEvent {
  returnValue = '';
  get [Symbol.toStringTag](): string {
    return 'BeforeUnloadEvent';
  }
}

export const UI_EVENTS: Record<string, unknown> = {
  UIEvent, MouseEvent, PointerEvent, WheelEvent, KeyboardEvent, FocusEvent, InputEvent, CompositionEvent,
  PageTransitionEvent, StorageEvent, BeforeUnloadEvent,
};
