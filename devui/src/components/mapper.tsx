/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Button, ButtonGroup } from './styled.js';
import React, { useEffect, useState } from 'react';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { GamepadIcon } from './icons.js';
import { MappedKeyDisplay } from './keys.js';
import { faBan } from '@fortawesome/free-solid-svg-icons';
import styled from 'styled-components';

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

interface KeyMapMenuProps {
	keyMap: KeyMapType;
	setKeyMap: React.Dispatch<React.SetStateAction<KeyMapType>>;
}

const KeyMapContainer = styled.div`
	display: flex;
	justify-content: space-between;
	pointer-events: all;
	position: fixed;
	display: flex;
	top: 40px;
	left: calc(50vw - 156px);
	width: 312px;
`;

const Column = styled.div`
	display: flex;
	flex-direction: column;
	width: 50%;
`;

const Row = styled.div`
	display: flex;
	height: 24px;
	align-items: center;
	margin-bottom: 2px;
`;

export const KeyMapMenu: React.FC<KeyMapMenuProps> = ({
	keyMap,
	setKeyMap,
}) => {
	const [currentMapping, setCurrentMapping] = useState<{
		controller: 'left' | 'right';
		action: string;
	} | null>(null);

	const startMapping = (controller: 'left' | 'right', action: string) => {
		setCurrentMapping({ controller, action });
	};

	const unmapKey = (controller: 'left' | 'right', action: string) => {
		setKeyMap((prevKeyMap) => ({
			...prevKeyMap,
			[controller]: {
				...prevKeyMap[controller],
				[action]: 'Unmapped',
			},
		}));
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (currentMapping && MappedKeyDisplay[event.code]) {
				setKeyMap((prevKeyMap) => ({
					...prevKeyMap,
					[currentMapping.controller]: {
						...prevKeyMap[currentMapping.controller],
						[currentMapping.action]: event.code,
					},
				}));
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
					setKeyMap((prevKeyMap) => ({
						...prevKeyMap,
						[currentMapping.controller]: {
							...prevKeyMap[currentMapping.controller],
							[currentMapping.action]: mouseButton,
						},
					}));
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
	}, [currentMapping, setKeyMap]);

	return (
		<KeyMapContainer>
			<Column>
				{Object.keys(keyMap.left!).map((action) => (
					<Row key={action}>
						<GamepadIcon
							buttonName={action === 'up' ? 'thumbstick' : action}
							handedness="left"
						/>
						<ButtonGroup $reverse={false}>
							<Button
								$reverse={false}
								style={{
									width: '100px',
									backgroundColor:
										currentMapping &&
										currentMapping.controller === 'left' &&
										currentMapping.action === action
											? 'rgba(255, 255, 255, 0.6)'
											: 'rgba(255, 255, 255, 0.3)',
								}}
								onClick={() => startMapping('left', action)}
								onContextMenu={(e) => e.preventDefault()}
							>
								{(keyMap.left as { [key: string]: any })[action]}
							</Button>
							<Button
								style={{ width: '24px' }}
								$reverse={false}
								onClick={() => unmapKey('left', action)}
								onContextMenu={(e) => e.preventDefault()}
							>
								<FontAwesomeIcon icon={faBan} />
							</Button>
						</ButtonGroup>
					</Row>
				))}
			</Column>
			<Column>
				{Object.keys(keyMap.right!).map((action) => (
					<Row key={action}>
						<GamepadIcon
							buttonName={action === 'up' ? 'thumbstick' : action}
							handedness="right"
						/>
						<ButtonGroup $reverse={false}>
							<Button
								$reverse={false}
								style={{
									width: '100px',
									backgroundColor:
										currentMapping &&
										currentMapping.controller === 'right' &&
										currentMapping.action === action
											? 'rgba(255, 255, 255, 0.6)'
											: 'rgba(255, 255, 255, 0.3)',
								}}
								onClick={() => startMapping('right', action)}
								onContextMenu={(e) => e.preventDefault()}
							>
								{(keyMap.right as { [key: string]: any })[action]}
							</Button>
							<Button
								$reverse={false}
								style={{ width: '24px' }}
								onClick={() => unmapKey('right', action)}
								onContextMenu={(e) => e.preventDefault()}
							>
								<FontAwesomeIcon icon={faBan} />
							</Button>
						</ButtonGroup>
					</Row>
				))}
			</Column>
		</KeyMapContainer>
	);
};
