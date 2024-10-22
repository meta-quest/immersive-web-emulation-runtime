/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	Button,
	ButtonGroup,
	FAIcon,
	KeyBlockContainer,
	KeyRow,
	MappedKeyBlock,
} from './styled.js';
import React, { useEffect, useRef, useState } from 'react';

import { GamepadIcon } from './icons.js';
import { MappedKeyDisplay } from './keys.js';
import { XRController } from '../../../lib/device/XRController';
import { faFingerprint } from '@fortawesome/free-solid-svg-icons';
import { styled } from 'styled-components';

interface JoystickProps {
	xrController: XRController;
	pointerLocked: boolean;
	buttonId: string;
	mappedKeyUp: string;
	mappedKeyDown: string;
	mappedKeyLeft: string;
	mappedKeyRight: string;
	mappedKeyPressed: string;
}

const JoystickContainer = styled.div`
	display: flex;
	align-items: center;
	margin-bottom: 2px;
`;

const JoystickButton = styled.button`
	background-color: rgba(255, 255, 255, 0.3);
	border: none;
	display: flex;
	justify-content: center;
	align-items: center;
	padding: 0;
	pointer-events: none;
	width: 50px;
	height: 50px;
	border-radius: 50%;
	position: relative;
	margin: 0 5px;
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
`;

const JoystickInner = styled.div`
	position: absolute;
	background-color: white;
	border-radius: 50%;
	width: 36px;
	height: 36px;
	cursor: pointer;
	pointer-events: auto;
`;

const SmallButton = styled(Button)<{ $reverse: boolean }>`
	width: 49px;
	font-size: 14px;

	${({ $reverse }) =>
		$reverse
			? `
    &:first-child {
      margin-left: 1px;
      border-radius: 2px 8px 8px 2px;
    }

    &:last-child {
      margin-right: 1px;
      border-radius: 8px 2px 2px 8px;
    }
  `
			: `
    &:first-child {
      margin-right: 1px;
      border-radius: 8px 2px 2px 8px;
    }

    &:last-child {
      margin-left: 1px;
      border-radius: 2px 8px 8px 2px;
    }
  `}
`;

export const Joystick: React.FC<JoystickProps> = ({
	xrController,
	pointerLocked,
	buttonId,
	mappedKeyUp,
	mappedKeyDown,
	mappedKeyLeft,
	mappedKeyRight,
	mappedKeyPressed,
}) => {
	const joystickRef = useRef<HTMLDivElement>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [isTouched, setIsTouched] = useState(false);
	const [isOnHold, setIsOnHold] = useState(false);
	const [isPressed, setIsPressed] = useState(false);
	const [initialPosition, setInitialPosition] = useState({ x: 0, y: 0 });
	const [keyStates, setKeyStates] = useState({
		up: false,
		down: false,
		left: false,
		right: false,
		pressed: false,
	});

	const handedness = xrController.inputSource.handedness;

	const handleMouseDown = () => {
		if (joystickRef.current) {
			const rect = joystickRef.current.getBoundingClientRect();
			setInitialPosition({
				x: rect.left + rect.width / 2,
				y: rect.top + rect.height / 2,
			});
			setIsDragging(true);
		}
	};

	const handleMouseMove = (event: MouseEvent) => {
		if (isDragging && joystickRef.current) {
			const dx = event.clientX - initialPosition.x;
			const dy = event.clientY - initialPosition.y;
			const distance = Math.sqrt(dx * dx + dy * dy);
			const maxDistance = 12;

			let limitedX, limitedY;
			if (distance < maxDistance) {
				limitedX = dx;
				limitedY = dy;
			} else {
				const angle = Math.atan2(dy, dx);
				limitedX = Math.cos(angle) * maxDistance;
				limitedY = Math.sin(angle) * maxDistance;
			}

			joystickRef.current.style.transform = `translate(${limitedX}px, ${limitedY}px)`;

			// Calculate normalized values between -1 and 1
			const normalizedX = limitedX / maxDistance;
			const normalizedY = limitedY / maxDistance;

			// Set window.movement
			xrController.updateAxes(buttonId, normalizedX, normalizedY);
		}
	};

	const handleMouseUp = () => {
		setIsDragging(false);
		if (joystickRef.current) {
			joystickRef.current.style.transform = 'translate(0, 0)';
			xrController.updateAxes(buttonId, 0, 0);
		}
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const newKeyStates = { ...keyStates };

			if (event.code === mappedKeyUp) newKeyStates.up = true;
			if (event.code === mappedKeyDown) newKeyStates.down = true;
			if (event.code === mappedKeyLeft) newKeyStates.left = true;
			if (event.code === mappedKeyRight) newKeyStates.right = true;
			if (event.code === mappedKeyPressed) {
				newKeyStates.pressed = true;
				xrController.updateButtonValue(buttonId, 1);
			}
			setKeyStates(newKeyStates);
			updateAxes(newKeyStates);
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			const newKeyStates = { ...keyStates };

			if (event.code === mappedKeyUp) newKeyStates.up = false;
			if (event.code === mappedKeyDown) newKeyStates.down = false;
			if (event.code === mappedKeyLeft) newKeyStates.left = false;
			if (event.code === mappedKeyRight) newKeyStates.right = false;
			if (event.code === mappedKeyPressed) {
				newKeyStates.pressed = false;
				xrController.updateButtonValue(buttonId, 0);
			}

			setKeyStates(newKeyStates);
			updateAxes(newKeyStates);
		};

		const updateAxes = (keyStates: any) => {
			const deltaX = (keyStates.right ? 1 : 0) - (keyStates.left ? 1 : 0);
			const deltaY = (keyStates.down ? 1 : 0) - (keyStates.up ? 1 : 0);
			const magnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
			if (magnitude === 0) {
				xrController.updateAxes(buttonId, 0, 0);
				return;
			}
			const normalizedX = deltaX / magnitude;
			const normalizedY = deltaY / magnitude;
			xrController.updateAxes(buttonId, normalizedX, normalizedY);
		};

		if (pointerLocked) {
			window.addEventListener('keydown', handleKeyDown);
			window.addEventListener('keyup', handleKeyUp);
		} else {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
		}

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
		};
	}, [
		mappedKeyUp,
		mappedKeyDown,
		mappedKeyLeft,
		mappedKeyRight,
		pointerLocked,
		keyStates,
	]);

	useEffect(() => {
		document.addEventListener('mousemove', handleMouseMove);
		document.addEventListener('mouseup', handleMouseUp);

		return () => {
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);
		};
	}, [isDragging, initialPosition]);

	return (
		<JoystickContainer
			style={{
				flexDirection:
					xrController.inputSource.handedness === 'left'
						? 'row'
						: 'row-reverse',
				alignItems: 'flex-start',
			}}
		>
			<GamepadIcon
				buttonName="thumbstick"
				handedness={xrController.inputSource.handedness}
			/>
			{pointerLocked ? (
				<KeyBlockContainer $reverse={handedness === 'right'}>
					<KeyRow $reverse={handedness === 'right'}>
						<MappedKeyBlock $pressed={keyStates.up} style={{ margin: '2px' }}>
							{MappedKeyDisplay[mappedKeyUp]}
						</MappedKeyBlock>
						<MappedKeyBlock
							$pressed={keyStates.pressed}
							style={{ margin: '2px' }}
						>
							{MappedKeyDisplay[mappedKeyPressed]}
						</MappedKeyBlock>
					</KeyRow>
					<KeyRow $reverse={false}>
						<MappedKeyBlock $pressed={keyStates.left} style={{ margin: '2px' }}>
							{MappedKeyDisplay[mappedKeyLeft]}
						</MappedKeyBlock>
						<MappedKeyBlock $pressed={keyStates.down} style={{ margin: '2px' }}>
							{MappedKeyDisplay[mappedKeyDown]}
						</MappedKeyBlock>
						<MappedKeyBlock
							$pressed={keyStates.right}
							style={{ margin: '2px' }}
						>
							{MappedKeyDisplay[mappedKeyRight]}
						</MappedKeyBlock>
					</KeyRow>
				</KeyBlockContainer>
			) : (
				<>
					<JoystickButton
						style={{
							margin:
								xrController.inputSource.handedness === 'left'
									? '0 5px 0 -3px'
									: '0 -3px 0 5px',
						}}
					>
						<JoystickInner
							ref={joystickRef}
							onMouseDown={handleMouseDown}
						></JoystickInner>
					</JoystickButton>
					<div style={{ display: 'flex', flexDirection: 'column' }}>
						<Button
							$reverse={handedness === 'right'}
							style={{
								backgroundColor: isPressed
									? 'rgba(255, 255, 255, 0.6)'
									: 'rgba(255, 255, 255, 0.3)',
								width: '80px',
								marginBottom: '2px',
								borderRadius: '8px',
							}}
							onClick={() => {
								setIsPressed(true);
								xrController.updateButtonValue(buttonId, 1);
								setTimeout(() => {
									setIsPressed(false);
									xrController.updateButtonValue(buttonId, 0);
								}, 500);
							}}
						>
							Press
						</Button>
						<ButtonGroup $reverse={handedness === 'right'}>
							<SmallButton
								$reverse={xrController.inputSource.handedness !== 'left'}
								style={{
									backgroundColor: isTouched
										? 'rgba(255, 255, 255, 0.6)'
										: 'rgba(255, 255, 255, 0.3)',
									width: '29px',
								}}
								onClick={() => {
									setIsTouched(!isTouched);
									xrController.updateButtonTouch(buttonId, !isTouched);
								}}
							>
								<FAIcon icon={faFingerprint} />
							</SmallButton>
							<SmallButton
								$reverse={xrController.inputSource.handedness !== 'left'}
								style={{
									backgroundColor: isOnHold
										? 'rgba(255, 255, 255, 0.6)'
										: 'rgba(255, 255, 255, 0.3)',
									width: '49px',
								}}
								onClick={() => {
									setIsOnHold(!isOnHold);
									xrController.updateButtonValue(buttonId, isOnHold ? 0 : 1);
								}}
							>
								Hold
							</SmallButton>
						</ButtonGroup>
					</div>
				</>
			)}
		</JoystickContainer>
	);
};
