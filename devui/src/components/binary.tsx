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
import React, { useEffect, useState } from 'react';

import { GamepadIcon } from './icons.js';
import { MappedKeyDisplay } from './keys.js';
import { XRController } from 'iwer/lib/device/XRController';
import { faFingerprint } from '@fortawesome/free-solid-svg-icons';

interface BinaryButtonProps {
	xrController: XRController;
	buttonId: string;
	pointerLocked: boolean;
	mappedKey: string;
}

export const BinaryButton: React.FC<BinaryButtonProps> = ({
	xrController,
	buttonId,
	pointerLocked,
	mappedKey,
}) => {
	const [isTouched, setIsTouched] = useState(false);
	const [isOnHold, setIsOnHold] = useState(false);
	const [isPressed, setIsPressed] = useState(false);
	const [isKeyPressed, setIsKeyPressed] = useState(false);

	const handedness = xrController.inputSource.handedness;

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.code === mappedKey) {
				xrController.updateButtonValue(buttonId, 1);
				setIsKeyPressed(true);
			}
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code === mappedKey) {
				xrController.updateButtonValue(buttonId, 0);
				setIsKeyPressed(false);
			}
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
	}, [mappedKey, pointerLocked, buttonId, xrController]);

	return (
		<ButtonContainer $reverse={handedness === 'right'}>
			<GamepadIcon buttonName={buttonId} handedness={handedness} />
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
								xrController.updateButtonValue(buttonId, 1);
								setTimeout(() => {
									setIsPressed(false);
									xrController.updateButtonValue(buttonId, 0);
								}, 250);
							}}
						>
							Press
						</Button>
						<Button
							title="Click to toggle touch state"
							$reverse={handedness === 'right'}
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
						</Button>
						<Button
							$reverse={handedness === 'right'}
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
						</Button>
					</>
				)}
			</ButtonGroup>
		</ButtonContainer>
	);
};
