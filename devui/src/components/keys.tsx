/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { MouseLeft, MouseRight } from './icons.js';
import {
	faAngleUp,
	faArrowRightToBracket,
	faArrowTurnDown,
	faCaretDown,
	faCaretLeft,
	faCaretRight,
	faCaretUp,
	faDeleteLeft,
} from '@fortawesome/free-solid-svg-icons';

import { FAIcon } from './styled.js';

export const MappedKeyDisplay: {
	[keyCode: string]: string | JSX.Element;
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
	Tab: <FAIcon icon={faArrowRightToBracket} />,
	Backspace: <FAIcon icon={faDeleteLeft} />,
	Enter: (
		<FAIcon
			style={{
				transform: 'rotate(90deg)',
			}}
			icon={faArrowTurnDown}
		/>
	),
	ShiftLeft: <FAIcon icon={faAngleUp} />,
	ShiftRight: <FAIcon icon={faAngleUp} />,
	Space: ' ',
	ArrowUp: <FAIcon icon={faCaretUp} />,
	ArrowDown: <FAIcon icon={faCaretDown} />,
	ArrowLeft: <FAIcon icon={faCaretLeft} />,
	ArrowRight: <FAIcon icon={faCaretRight} />,
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
	MouseLeft: <MouseLeft />,
	MouseRight: <MouseRight />,
};
