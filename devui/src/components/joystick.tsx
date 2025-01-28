/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	Button,
	ButtonContainer,
	ButtonGroup,
	Colors,
	ControlButtonStyles,
	FAIcon,
	MappedKeyBlock,
} from './styled.js';
import React, { useEffect, useRef, useState } from 'react';
import {
	faCircleXmark,
	faFingerprint,
} from '@fortawesome/free-solid-svg-icons';

import { GamepadIcon } from './icons.js';
import { MappedKeyDisplay } from './keys.js';
import { XRController } from 'iwer/lib/device/XRController';
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
	margin-bottom: ${ControlButtonStyles.gap};
`;

const joystickSize = `calc(2 * ${ControlButtonStyles.height} + ${ControlButtonStyles.gap})`;

const JoystickButton = styled.button`
	background: ${Colors.gradientGreyTranslucent};
	border: none;
	display: flex;
	justify-content: center;
	align-items: center;
	padding: 0;
	pointer-events: none;
	width: ${joystickSize};
	height: ${joystickSize};
	border-radius: 50%;
	position: relative;
	margin: 0 5px;
`;

const JoystickInner = styled.div`
	position: absolute;
	font-size: 50px;
	display: flex;
	align-items: center;
	justify-content: center;
	color: ${Colors.textWhite};
	cursor: pointer;
	pointer-events: auto;
`;

const SmallButton = styled(Button)<{ $reverse: boolean }>`
	width: ${ControlButtonStyles.widthLong};
	font-size: ${ControlButtonStyles.fontSize};

	${({ $reverse }) =>
		$reverse
			? `
    &:first-child {
      border-radius: ${ControlButtonStyles.radiusLast};
    }

    &:last-child {
      border-radius: ${ControlButtonStyles.radiusFirst};
    }
  `
			: `
    &:first-child {
      border-radius: ${ControlButtonStyles.radiusFirst};
    }

    &:last-child {
      border-radius: ${ControlButtonStyles.radiusLast};
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

	return pointerLocked ? (
		<>
			<ButtonContainer $reverse={handedness === 'right'}>
				<GamepadIcon
					buttonName="thumbstick"
					handedness={xrController.inputSource.handedness}
				/>
				<ButtonGroup $reverse={handedness === 'right'}>
					<MappedKeyBlock $pressed={keyStates.up}>
						{MappedKeyDisplay[mappedKeyUp]}
					</MappedKeyBlock>
					<MappedKeyBlock $pressed={keyStates.pressed}>
						{MappedKeyDisplay[mappedKeyPressed]}
					</MappedKeyBlock>
				</ButtonGroup>
			</ButtonContainer>
			<ButtonContainer
				$reverse={handedness === 'right'}
				style={
					handedness === 'right'
						? { marginRight: '2px' }
						: { marginLeft: '2px' }
				}
			>
				<ButtonGroup $reverse={false} style={{ margin: 0 }}>
					<MappedKeyBlock $pressed={keyStates.left}>
						{MappedKeyDisplay[mappedKeyLeft]}
					</MappedKeyBlock>
					<MappedKeyBlock $pressed={keyStates.down}>
						{MappedKeyDisplay[mappedKeyDown]}
					</MappedKeyBlock>
					<MappedKeyBlock $pressed={keyStates.right}>
						{MappedKeyDisplay[mappedKeyRight]}
					</MappedKeyBlock>
				</ButtonGroup>
			</ButtonContainer>
		</>
	) : (
		<JoystickContainer
			style={{
				flexDirection:
					xrController.inputSource.handedness === 'left'
						? 'row'
						: 'row-reverse',
				alignItems: 'flex-start',
			}}
		>
			<>
				<GamepadIcon
					buttonName="thumbstick"
					handedness={xrController.inputSource.handedness}
				/>
				<JoystickButton style={{ margin: '0 5px' }}>
					<JoystickInner ref={joystickRef} onMouseDown={handleMouseDown}>
						<FAIcon icon={faCircleXmark} $size={50} />
					</JoystickInner>
				</JoystickButton>
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						alignItems: handedness === 'right' ? 'start' : 'end',
					}}
				>
					<Button
						$reverse={handedness === 'right'}
						style={{
							background: isPressed
								? Colors.gradientLightGreyTranslucent
								: Colors.gradientGreyTranslucent,
							width: `calc(${ControlButtonStyles.widthLong} + ${ControlButtonStyles.widthShort} + ${ControlButtonStyles.gap})`,
							marginBottom: ControlButtonStyles.gap,
							borderRadius: ControlButtonStyles.radiusSolo,
						}}
						onClick={() => {
							setIsPressed(true);
							xrController.updateButtonValue(buttonId, 1);
							setTimeout(() => {
								setIsPressed(false);
								xrController.updateButtonValue(buttonId, 0);
							}, 250);
						}}
					>
						Press
					</Button>
					<ButtonGroup $reverse={handedness === 'right'}>
						<SmallButton
							title="Click to toggle touch state"
							$reverse={xrController.inputSource.handedness !== 'left'}
							style={{
								background: isTouched
									? Colors.gradientLightGreyTranslucent
									: Colors.gradientGreyTranslucent,
								width: ControlButtonStyles.widthShort,
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
								background: isOnHold
									? Colors.gradientLightGreyTranslucent
									: Colors.gradientGreyTranslucent,
								width: ControlButtonStyles.widthLong,
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
		</JoystickContainer>
	);
};
