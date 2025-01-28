/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Button, ButtonGroup, Colors, ControlButtonStyles } from './styled.js';
import React, { useEffect, useState } from 'react';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { GamepadIcon } from './icons.js';
import { MappedKeyDisplay } from './keys.js';
import { create } from 'zustand';
import { faBan } from '@fortawesome/free-solid-svg-icons';
import { styled } from 'styled-components';

export type KeyMapType = Partial<
	Record<XRHandedness, { [key: string]: string }>
>;

export const DEFAULT_KEYMAP: KeyMapType = {
	left: {
		'thumbstick-up': 'KeyW',
		'thumbstick-down': 'KeyS',
		'thumbstick-left': 'KeyA',
		'thumbstick-right': 'KeyD',
		thumbstick: 'KeyR',
		'x-button': 'KeyX',
		'y-button': 'KeyZ',
		trigger: 'KeyQ',
		squeeze: 'KeyE',
	},
	right: {
		'thumbstick-up': 'ArrowUp',
		'thumbstick-down': 'ArrowDown',
		'thumbstick-left': 'ArrowLeft',
		'thumbstick-right': 'ArrowRight',
		thumbstick: 'Slash',
		'a-button': 'Enter',
		'b-button': 'ShiftRight',
		trigger: 'MouseLeft',
		squeeze: 'MouseRight',
	},
};

type KeyMapStore = {
	keyMap: KeyMapType;
	bindKey: (
		handedness: 'left' | 'right',
		action: string,
		keyCode?: string,
	) => void;
};

export const useKeyMapStore = create<KeyMapStore>((set) => ({
	keyMap: DEFAULT_KEYMAP,
	bindKey: (
		handedness: 'left' | 'right',
		action: string,
		keyCode = 'Unmapped',
	) =>
		set((state) => ({
			keyMap: {
				...state.keyMap,
				[handedness]: {
					...state.keyMap[handedness],
					[action]: keyCode,
				},
			},
		})),
}));

const Row = styled.div`
	display: flex;
	height: ${ControlButtonStyles.height};
	align-items: center;
	justify-content: space-between;
	margin-bottom: ${ControlButtonStyles.gap};

	&:last-child {
		margin-bottom: 0;
	}
`;

interface ControllerMapperProps {
	handedness: 'left' | 'right';
}

export const ControllerMapper: React.FC<ControllerMapperProps> = ({
	handedness,
}) => {
	const { keyMap, bindKey } = useKeyMapStore();

	const [currentMapping, setCurrentMapping] = useState<{
		action: string;
	} | null>(null);

	const startMapping = (action: string) => {
		setCurrentMapping({ action });
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (currentMapping && MappedKeyDisplay[event.code]) {
				bindKey(handedness, currentMapping.action, event.code);
				setCurrentMapping(null);
			}
		};

		const handleMouseDown = (event: MouseEvent) => {
			if (currentMapping) {
				const mouseButton =
					event.button === 0
						? 'MouseLeft'
						: event.button === 2
						? 'MouseRight'
						: null;
				if (mouseButton && MappedKeyDisplay[mouseButton]) {
					bindKey(handedness, currentMapping.action, mouseButton);
					setCurrentMapping(null);
				}
			}
		};

		const preventDefaultContextMenu = (event: MouseEvent) => {
			event.preventDefault();
		};

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('mousedown', handleMouseDown);
		window.addEventListener('contextmenu', preventDefaultContextMenu);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('mousedown', handleMouseDown);
			window.removeEventListener('contextmenu', preventDefaultContextMenu);
		};
	}, [currentMapping]);
	return Object.keys(keyMap[handedness]!).map((action) => (
		<Row key={action}>
			<GamepadIcon
				buttonName={action === 'up' ? 'thumbstick' : action}
				handedness={handedness}
			/>
			<ButtonGroup $reverse={false}>
				<Button
					$reverse={false}
					style={{
						width: '100px',
						background:
							currentMapping && currentMapping.action === action
								? Colors.gradientLightGreyTranslucent
								: Colors.gradientGreyTranslucent,
					}}
					onClick={() => startMapping(action)}
					onContextMenu={(e) => e.preventDefault()}
				>
					{(keyMap[handedness] as { [key: string]: any })[action]}
				</Button>
				<Button
					style={{ width: ControlButtonStyles.widthShort }}
					$reverse={false}
					onClick={() => bindKey(handedness, action)}
					onContextMenu={(e) => e.preventDefault()}
				>
					<FontAwesomeIcon icon={faBan} />
				</Button>
			</ButtonGroup>
		</Row>
	));
};
