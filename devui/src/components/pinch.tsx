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
	FAControlIcon,
	MappedKeyBlock,
	RangeSelector,
} from './styled.js';
import React, { useEffect, useState } from 'react';

import { MappedKeyDisplay } from './keys.js';
import { XRHandInput } from 'iwer/lib/device/XRHandInput.js';
import { faHandLizard } from '@fortawesome/free-solid-svg-icons';

interface PinchControlProps {
	hand: XRHandInput;
	pointerLocked: boolean;
	mappedKey: string;
}

const pinchSliderWidth = `calc(${ControlButtonStyles.widthLong} + ${ControlButtonStyles.widthShort} + ${ControlButtonStyles.gap})`;

export const PinchControl: React.FC<PinchControlProps> = ({
	hand,
	pointerLocked,
	mappedKey,
}) => {
	const [isPressed, setIsPressed] = useState(false);
	const [isKeyPressed, setIsKeyPressed] = useState(false);
	const [analogValue, setAnalogValue] = useState(0);

	const handedness = hand.inputSource.handedness;

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.code === mappedKey) {
				hand.updatePinchValue(1);
				setIsKeyPressed(true);
			}
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code === mappedKey) {
				hand.updatePinchValue(0);
				setIsKeyPressed(false);
			}
		};

		const handleMouseDown = (event: MouseEvent) => {
			if (
				(mappedKey === 'MouseLeft' && event.button === 0) ||
				(mappedKey === 'MouseRight' && event.button === 2)
			) {
				hand.updatePinchValue(1);
				setIsKeyPressed(true);
			}
		};

		const handleMouseUp = (event: MouseEvent) => {
			if (
				(mappedKey === 'MouseLeft' && event.button === 0) ||
				(mappedKey === 'MouseRight' && event.button === 2)
			) {
				hand.updatePinchValue(0);
				setIsKeyPressed(false);
			}
		};

		if (pointerLocked) {
			if (mappedKey === 'MouseLeft' || mappedKey === 'MouseRight') {
				window.addEventListener('mousedown', handleMouseDown);
				window.addEventListener('mouseup', handleMouseUp);
			} else {
				window.addEventListener('keydown', handleKeyDown);
				window.addEventListener('keyup', handleKeyUp);
			}
		} else {
			if (mappedKey === 'MouseLeft' || mappedKey === 'MouseRight') {
				window.removeEventListener('mousedown', handleMouseDown);
				window.removeEventListener('mouseup', handleMouseUp);
			} else {
				window.removeEventListener('keydown', handleKeyDown);
				window.removeEventListener('keyup', handleKeyUp);
			}
		}

		return () => {
			if (mappedKey === 'MouseLeft' || mappedKey === 'MouseRight') {
				window.removeEventListener('mousedown', handleMouseDown);
				window.removeEventListener('mouseup', handleMouseUp);
			} else {
				window.removeEventListener('keydown', handleKeyDown);
				window.removeEventListener('keyup', handleKeyUp);
			}
		};
	}, [mappedKey, pointerLocked, hand]);

	return (
		<ButtonContainer $reverse={handedness === 'right'}>
			<FAControlIcon icon={faHandLizard} $reverse={handedness === 'left'} />
			<ButtonGroup $reverse={handedness === 'right'}>
				{pointerLocked ? (
					<MappedKeyBlock $pressed={isKeyPressed}>
						{MappedKeyDisplay[mappedKey]}
					</MappedKeyBlock>
				) : (
					<>
						<Button
							$reverse={handedness === 'right'}
							style={{
								background: isPressed
									? Colors.gradientLightGreyTranslucent
									: Colors.gradientGreyTranslucent,
								width: ControlButtonStyles.widthLong,
							}}
							onClick={() => {
								setIsPressed(true);
								hand.updatePinchValue(1);
								setTimeout(() => {
									setIsPressed(false);
									hand.updatePinchValue(0);
								}, 250);
							}}
						>
							Pinch
						</Button>
						<RangeSelector
							$reverse={handedness === 'right'}
							value={analogValue}
							onChange={(e) => {
								const value = Number(e.target.value);
								setAnalogValue(value);
								hand.updatePinchValue(value / 100);
							}}
							style={{ width: pinchSliderWidth }}
							min="0"
							max="100"
						/>
					</>
				)}
			</ButtonGroup>
		</ButtonContainer>
	);
};
