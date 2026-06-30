/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Icon } from './icon.js';
import type { ReactElement } from 'react';

export const MappedKeyDisplay: {
  [keyCode: string]: string | ReactElement;
} = {
  KeyA: 'A',
  KeyB: 'B',
  KeyC: 'C',
  KeyD: 'D',
  KeyE: 'E',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyI: 'I',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  KeyM: 'M',
  KeyN: 'N',
  KeyO: 'O',
  KeyP: 'P',
  KeyQ: 'Q',
  KeyR: 'R',
  KeyS: 'S',
  KeyT: 'T',
  KeyU: 'U',
  KeyV: 'V',
  KeyW: 'W',
  KeyX: 'X',
  KeyY: 'Y',
  KeyZ: 'Z',
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Tab: <Icon name="arrow-right-to-line" size={15} />,
  Backspace: <Icon name="delete" size={15} />,
  Enter: <Icon name="corner-down-left" size={15} />,
  ShiftLeft: <Icon name="arrow-big-up" size={15} />,
  ShiftRight: <Icon name="arrow-big-up" size={15} />,
  Space: ' ',
  ArrowUp: <Icon name="arrow-up" size={15} />,
  ArrowDown: <Icon name="arrow-down" size={15} />,
  ArrowLeft: <Icon name="arrow-left" size={15} />,
  ArrowRight: <Icon name="arrow-right" size={15} />,
  Semicolon: ';',
  Equal: '=',
  Comma: ',',
  Minus: '-',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  Backslash: '\\',
  BracketRight: ']',
  Quote: "'",
  MouseLeft: <Icon name="mouse-left" size={15} />,
  MouseRight: <Icon name="mouse-right" size={15} />,
};
