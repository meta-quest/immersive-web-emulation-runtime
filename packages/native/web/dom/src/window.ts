/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The window members of DOM-3 that need the DOM: the fixed window size (no 2D panel, so it never changes and no
// `resize` fires), screen + orientation, visualViewport, scrolling no-ops, getComputedStyle, focus/blur, the modal
// dialogs (logged, default answers), getSelection, a minimal CSS namespace and `Window` for instanceof checks.

import { createStyle, type CSSStyleDeclaration } from './css.ts';
import {
  BaseEventTarget,
  G,
  defineHandler,
  domException,
  str,
  viewport,
  warn,
} from './env.ts';
import { getPageSelection } from './document.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export class ScreenOrientation extends BaseEventTarget {
  get type(): string {
    const v = viewport();
    return v.width >= v.height ? 'landscape-primary' : 'portrait-primary';
  }
  get angle(): number {
    return 0;
  }
  lock(_orientation: string): Promise<void> {
    return Promise.reject(
      domException(
        'ScreenOrientation.lock() is not supported by @iwer/native',
        'NotSupportedError',
      ),
    );
  }
  unlock(): void {}
  get [Symbol.toStringTag](): string {
    return 'ScreenOrientation';
  }
}
defineHandler(ScreenOrientation.prototype, 'change');

export class Screen extends BaseEventTarget {
  /** @internal */ _orientation: ScreenOrientation | null = null;
  get width(): number {
    return viewport().width;
  }
  get height(): number {
    return viewport().height;
  }
  get availWidth(): number {
    return viewport().width;
  }
  get availHeight(): number {
    return viewport().height;
  }
  get availLeft(): number {
    return 0;
  }
  get availTop(): number {
    return 0;
  }
  get colorDepth(): number {
    return 24;
  }
  get pixelDepth(): number {
    return 24;
  }
  get isExtended(): boolean {
    return false;
  }
  get orientation(): ScreenOrientation {
    return (this._orientation ??= new ScreenOrientation());
  }
  get [Symbol.toStringTag](): string {
    return 'Screen';
  }
}
defineHandler(Screen.prototype, 'change');

export class VisualViewport extends BaseEventTarget {
  get offsetLeft(): number {
    return 0;
  }
  get offsetTop(): number {
    return 0;
  }
  get pageLeft(): number {
    return 0;
  }
  get pageTop(): number {
    return 0;
  }
  get width(): number {
    return viewport().width;
  }
  get height(): number {
    return viewport().height;
  }
  get scale(): number {
    return 1;
  }
  get [Symbol.toStringTag](): string {
    return 'VisualViewport';
  }
}
for (const t of ['resize', 'scroll', 'scrollend'])
  defineHandler(VisualViewport.prototype, t);

/** `instanceof Window` is true for the page global only. */
export class Window {
  constructor() {
    throw new TypeError('Illegal constructor');
  }
  static [Symbol.hasInstance](v: unknown): boolean {
    return v === G;
  }
}

export const CSS = Object.freeze({
  supports(_a: string, _b?: string): boolean {
    return false;
  },
  escape(ident: string): string {
    return str(ident).replace(
      /([\0-\x1f\x7f]|^-?\d)|^-$|[^\x80-\uffff\w-]/g,
      (m, ctrl: string | undefined) => {
        if (m === '\0') return '\ufffd';
        if (ctrl) return `\\${m.charCodeAt(0).toString(16)} `;
        return `\\${m}`;
      },
    );
  },
  registerProperty(): void {},
});

/** getComputedStyle: a read-only copy of the element's inline declarations (there is no cascade or layout). */
export function getComputedStyle(
  el: unknown,
  _pseudo?: string | null,
): CSSStyleDeclaration {
  if (
    !el ||
    typeof el !== 'object' ||
    typeof (el as { nodeType?: unknown }).nodeType !== 'number'
  ) {
    throw new TypeError(
      "Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.",
    );
  }
  const inline = el as {
    _style?: CSSStyleDeclaration | null;
    getAttribute?: (n: string) => string | null;
  };
  const text = inline._style
    ? inline._style.cssText
    : (inline.getAttribute?.('style') ?? '');
  return createStyle(text, null, true);
}

/** Defines the DOM-3 window members on the page global (missing ones only unless mode is 'all'). */
export function installWindowMembers(
  g: any,
  mode: 'missing' | 'all',
): string[] {
  const installed: string[] = [];
  const defGet = (name: string, get: () => unknown, replaceable = true) => {
    if (mode === 'missing' && name in g) return;
    Object.defineProperty(g, name, {
      get,
      set: replaceable
        ? function (this: unknown, v: unknown) {
            Object.defineProperty(g, name, {
              value: v,
              writable: true,
              configurable: true,
              enumerable: true,
            });
          }
        : undefined,
      configurable: true,
      enumerable: true,
    });
    installed.push(name);
  };
  const defFn = (name: string, fn: (...a: any[]) => unknown) => {
    if (mode === 'missing' && typeof g[name] === 'function') return;
    Object.defineProperty(g, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    installed.push(name);
  };
  defGet('innerWidth', () => viewport().width);
  defGet('innerHeight', () => viewport().height);
  defGet('outerWidth', () => viewport().width);
  defGet('outerHeight', () => viewport().height);
  for (const k of [
    'screenX',
    'screenY',
    'screenLeft',
    'screenTop',
    'scrollX',
    'scrollY',
    'pageXOffset',
    'pageYOffset',
  ])
    defGet(k, () => 0);
  const screen = new Screen();
  defGet('screen', () => screen);
  const vv = new VisualViewport();
  defGet('visualViewport', () => vv);
  defGet('closed', () => false, false);
  defGet('length', () => 0);
  defGet('status', () => '');
  defGet('menubar', () => ({ visible: false }));
  defGet('toolbar', () => ({ visible: false }));
  defGet('locationbar', () => ({ visible: false }));
  defGet('personalbar', () => ({ visible: false }));
  defGet('scrollbars', () => ({ visible: false }));
  defGet('statusbar', () => ({ visible: false }));
  defFn('scroll', () => {});
  defFn('scrollTo', () => {});
  defFn('scrollBy', () => {});
  defFn('moveTo', () => {});
  defFn('moveBy', () => {});
  defFn('resizeTo', () => {});
  defFn('resizeBy', () => {});
  defFn('focus', () => {});
  defFn('blur', () => {});
  defFn('stop', () => {});
  defFn('print', () =>
    warn('window.print() ignored: a packaged app cannot print'),
  );
  defFn('alert', (message?: unknown) => {
    warn(
      `alert(): ${message === undefined ? '' : String(message)} (there is no dialog in a packaged app)`,
    );
  });
  defFn('confirm', (message?: unknown) => {
    warn(
      `confirm(): ${message === undefined ? '' : String(message)} -> false (there is no dialog in a packaged app)`,
    );
    return false;
  });
  defFn('prompt', (message?: unknown) => {
    warn(
      `prompt(): ${message === undefined ? '' : String(message)} -> null (there is no dialog in a packaged app)`,
    );
    return null;
  });
  defFn('open', (url?: unknown) => {
    warn(
      `window.open(${url === undefined ? '' : String(url)}) ignored: a packaged app has a single document`,
    );
    return null;
  });
  defFn('getComputedStyle', getComputedStyle);
  defFn('getSelection', () => getPageSelection());
  return installed;
}
