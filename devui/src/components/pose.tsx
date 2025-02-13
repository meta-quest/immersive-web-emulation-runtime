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
	ControlButtonStyles,
	FAControlIcon,
	FAIcon,
	MappedKeyBlock,
} from './styled.js';
import React, { useEffect, useState } from 'react';
import {
	faChevronLeft,
	faChevronRight,
	faHandScissors,
} from '@fortawesome/free-solid-svg-icons';

import { MappedKeyDisplay } from './keys.js';
import { XRHandInput } from 'iwer/lib/device/XRHandInput.js';

interface PoseSelectorProps {
	hand: XRHandInput;
	pointerLocked: boolean;
	mappedKey: string;
}

const poses = ['default', 'point'];

const poseButtonWidth = `calc(2 * ${ControlButtonStyles.widthLong} - ${ControlButtonStyles.widthShort})`;

export const PoseSelector: React.FC<PoseSelectorProps> = ({
	hand,
	pointerLocked,
	mappedKey,
}) => {
	const [poseId, setPoseId] = useState(hand.poseId);
	const [isKeyPressed, setIsKeyPressed] = useState(false);

	const handedness = hand.inputSource.handedness;
	const cyclePose = (delta: number) => {
		const poseIdx = poses.indexOf(hand.poseId);
		const newPoseIdx = (poseIdx + poses.length + delta) % poses.length;
		setPoseId(poses[newPoseIdx]);
		hand.poseId = poses[newPoseIdx];
	};
	const layoutReverse = handedness === 'right';

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.code === mappedKey) {
				cyclePose(1);
				setIsKeyPressed(true);
			}
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code === mappedKey) {
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
	}, [mappedKey, pointerLocked, hand]);

	return (
		<ButtonContainer $reverse={layoutReverse}>
			<FAControlIcon icon={faHandScissors} $reverse={handedness === 'left'} />
			<ButtonGroup $reverse={layoutReverse}>
				{pointerLocked ? (
					<MappedKeyBlock $pressed={isKeyPressed}>
						{MappedKeyDisplay[mappedKey]}
					</MappedKeyBlock>
				) : (
					<>
						<Button
							$reverse={layoutReverse}
							style={{
								width: ControlButtonStyles.widthShort,
							}}
							onClick={() => {
								cyclePose(layoutReverse ? 1 : -1);
							}}
						>
							<FAIcon icon={layoutReverse ? faChevronRight : faChevronLeft} />
						</Button>
						<Button
							$reverse={layoutReverse}
							style={{
								width: poseButtonWidth,
							}}
							disabled
						>
							Pose: {poseId}
						</Button>
						<Button
							$reverse={layoutReverse}
							style={{
								width: ControlButtonStyles.widthShort,
							}}
							onClick={() => {
								cyclePose(layoutReverse ? -1 : 1);
							}}
						>
							<FAIcon icon={layoutReverse ? faChevronLeft : faChevronRight} />
						</Button>
					</>
				)}
			</ButtonGroup>
		</ButtonContainer>
	);
};
