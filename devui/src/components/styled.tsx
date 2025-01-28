/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { styled } from 'styled-components';

export const Colors = {
	textWhite: 'rgba(223, 223, 223, 1)',
	textGrey: 'rgba(156, 156, 156, 1)',
	dangerRed: 'rgba(243, 151, 143, 1)',
	dangerRedPressed: 'rgba(240, 97, 84,1)',
	panelBackground: 'rgba(38, 38, 38, 0.7)',
	panelBorder: 'rgba(61, 61, 63, 0.7)',
	buttonBackground: 'rgba(61, 61, 63, 0.6)',
	buttonHovered: 'rgba(61, 61, 63, 0.8)',
	buttonPressed: 'rgba(61, 61, 63, 1)',
	gradientGrey: 'linear-gradient(to bottom, #343434, #393939)',
	gradientGreyTranslucent:
		'linear-gradient(to bottom, rgba(52, 52, 52, 0.75), rgba(57, 57, 57, 0.75))',
	gradientLightGreyTranslucent:
		'linear-gradient(to bottom, rgba(75, 75, 75, 0.75), rgba(80, 80, 80, 0.75))',
};

export const ControlButtonStyles = {
	height: '30px',
	minWidth: '30px',
	fontSize: '14px',
	radiusMiddle: '3px',
	radiusSolo: '10px',
	radiusFirst: '10px 3px 3px 10px',
	radiusLast: '3px 10px 10px 3px',
	widthLong: '70px',
	widthShort: '30px',
	gap: '3px',
};

export const Button = styled.button<{ $reverse?: boolean }>`
	background: ${Colors.gradientGreyTranslucent};
	border: none;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	color: ${Colors.textWhite};
	border: 1px solid transparent;
	border-radius: ${ControlButtonStyles.radiusMiddle};
	font-size: ${ControlButtonStyles.fontSize};
	height: ${ControlButtonStyles.height};
	min-width: ${ControlButtonStyles.minWidth};
	transition: all 0.2s ease-in-out;
	text-transform: none;
	box-shadow: none;
	font-family: Arial, sans-serif;

	&:first-child {
		border-radius: ${({ $reverse }) =>
			$reverse
				? ControlButtonStyles.radiusLast
				: ControlButtonStyles.radiusFirst};
	}

	&:last-child {
		border-radius: ${({ $reverse }) =>
			$reverse
				? ControlButtonStyles.radiusFirst
				: ControlButtonStyles.radiusLast};
	}

	&:first-child:last-child {
		border-radius: ${ControlButtonStyles.radiusSolo};
	}
`;
Button.defaultProps = { $reverse: false };

export const HeaderButtonsContainer = styled.div`
	padding: 2px;
	display: flex;
	background-color: ${Colors.panelBackground};
	border: 1px solid ${Colors.panelBorder};
	backdrop-filter: blur(40px);
	-webkit-backdrop-filter: blur(40px);
	justify-content: center;
	pointer-events: all;
	border-radius: 14px;
	align-items: center;
	height: 24px;
`;

export const HeaderButton = styled.button`
	background-color: transparent;
	border: none;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	color: ${Colors.textWhite};
	border-radius: 4px;
	font-size: 16px;
	height: 24px;
	min-width: 24px;
	transition: all 0.2s ease-in-out;
	text-transform: none;
	box-shadow: none;
	padding: 1px 5px;
	font-family: Arial, sans-serif;

	&:hover {
		background-color: ${Colors.buttonPressed};
	}

	&:active {
		background-color: ${Colors.buttonPressed};
	}

	&:focus {
		outline: none;
	}

	&:first-child {
		border-radius: 12px 4px 4px 12px;
	}

	&:last-child {
		border-radius: 4px 12px 12px 4px;
	}

	&:first-child:last-child {
		border-radius: 12px;
	}
`;

export const MappedKeyBlock = styled.div<{ $pressed: boolean }>`
	background-color: ${({ $pressed }) =>
		$pressed ? Colors.buttonPressed : Colors.buttonBackground};
	border: none;
	display: flex;
	align-items: center;
	justify-content: center;
	color: ${Colors.textWhite};
	border-radius: 8px;
	font-size: 14px;
	font-family: Arial, sans-serif;
	height: 30px;
	width: 30px;
	transition: all 0.2s ease-in-out;
`;

export const ButtonContainer = styled.div<{ $reverse?: boolean }>`
	display: flex;
	align-items: center;
	height: 30px;
	margin-bottom: 3px;
	justify-content: flex-start;
	flex-direction: ${({ $reverse }) => ($reverse ? 'row-reverse' : 'row')};

	&:last-child {
		margin-bottom: 0;
	}
`;
ButtonContainer.defaultProps = { $reverse: false };

export const ButtonGroup = styled.div<{ $reverse?: boolean }>`
	display: flex;
	flex-direction: ${({ $reverse }) => ($reverse ? 'row-reverse' : 'row')};
	height: 100%;
	justify-content: space-between;
	align-items: center;
	margin: ${({ $reverse }) => ($reverse ? '0 5px 0 0' : '0 0 0 5px')};
	gap: 3px;
`;
ButtonGroup.defaultProps = { $reverse: false };

export const JoystickButton = styled.button`
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

export const JoystickInner = styled.div`
	position: absolute;
	background-color: ${Colors.textWhite};
	border-radius: 50%;
	width: 36px;
	height: 36px;
	cursor: pointer;
	pointer-events: auto;
`;

export const RangeSelector = styled.input.attrs({ type: 'range' })<{
	$reverse?: boolean;
}>`
	-webkit-appearance: none;
	appearance: none;
	background: ${Colors.gradientGreyTranslucent};
	border: none;
	height: 100%;
	width: ${ControlButtonStyles.widthLong};
	cursor: pointer;
	margin: 0;
	transition: all 0.2s ease-in-out;
	border-radius: ${({ $reverse }) =>
		$reverse
			? ControlButtonStyles.radiusFirst
			: ControlButtonStyles.radiusLast};

	&::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 8px;
		height: 30px;
		background-color: ${Colors.textWhite};
		border-radius: ${ControlButtonStyles.radiusMiddle};
	}

	&::-moz-range-thumb {
		width: 10px;
		height: 30px;
		background-color: ${Colors.textWhite};
		border-radius: ${ControlButtonStyles.radiusMiddle};
	}

	&::-ms-thumb {
		width: 8px;
		height: 24px;
		background-color: ${Colors.textWhite};
		border-radius: ${ControlButtonStyles.radiusMiddle};
	}
`;
RangeSelector.defaultProps = { $reverse: false };

export const KeyBlockContainer = styled.div<{ $reverse: boolean }>`
	display: flex;
	flex-direction: column;
	align-items: ${({ $reverse }) => ($reverse ? 'flex-start' : 'flex-end')};
	justify-content: center;
	margin: ${({ $reverse }) => ($reverse ? '2px -26px 0 0' : '2px 0 0 -26px')};
`;

export const KeyRow = styled.div<{ $reverse: boolean }>`
	display: flex;
	flex-direction: ${({ $reverse }) => ($reverse ? 'row-reverse' : 'row')};
	align-items: center;
	justify-content: center;
`;

export const ButtonGroupColumn = styled.div`
	display: flex;
	flex-direction: column;
	height: 50px;
	justify-content: space-between;
`;

export const FAIcon = styled(FontAwesomeIcon)<{ $size?: number }>`
	height: ${({ $size }) => `${$size}px`};
	min-height: ${({ $size }) => `${$size}px`};
	max-height: ${({ $size }) => `${$size}px`};
	width: ${({ $size }) => `${$size}px`};
	min-width: ${({ $size }) => `${$size}px`};
	max-width: ${({ $size }) => `${$size}px`};
`;
FAIcon.defaultProps = { $size: 14 };

export const ControlPanel = styled.div`
	position: fixed;
	padding: 5px;
	font-family: Arial, sans-serif;
	color: ${Colors.textWhite};
	pointer-events: all;
	background-color: ${Colors.panelBackground};
	border: 1px solid ${Colors.panelBorder};
	backdrop-filter: blur(40px);
	-webkit-backdrop-filter: blur(40px);
	border-radius: 12px;
	box-shadow: 0 5px 10px rgba(0, 0, 0, 0.3);
	overflow: hidden;
	display: flex;
	flex-direction: column;
`;

export const SectionBreak = styled.hr<{ $horizontal?: boolean }>`
	width: ${({ $horizontal }) => ($horizontal ? 'unset' : '1px')};
	height: ${({ $horizontal }) => ($horizontal ? '1px' : 'unset')};
	background-color: ${Colors.panelBorder};
	margin: 5px 3px;
	border: none;
`;
SectionBreak.defaultProps = { $horizontal: true };

export const PanelHeaderButton = styled.button<{ $isRed?: boolean }>`
	background-color: transparent;
	border: none;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	color: ${({ $isRed }) => ($isRed ? Colors.dangerRed : Colors.textWhite)};
	font-size: 12px;
	padding: 3px;
	text-transform: none;
	box-shadow: none;

	&:hover {
		color: ${({ $isRed }) => ($isRed ? Colors.dangerRedPressed : '#ffffff')};
	}

	&:active {
		color: ${({ $isRed }) => ($isRed ? Colors.dangerRedPressed : '#ffffff')};
	}

	&:focus {
		outline: none;
	}
`;
PanelHeaderButton.defaultProps = { $isRed: false };

export const ValuesContainer = styled.div`
	display: flex;
	flex-direction: row;
	gap: ${ControlButtonStyles.gap};
	height: 25px;
`;

export const ValueInput = styled.input.attrs({ type: 'text' })`
	width: 50px;
	outline: none;
	background: ${Colors.gradientGrey};
	border: 1px solid transparent;
	border-radius: 5px;
	height: 25px;
	color: ${Colors.textWhite};
	padding: 0 10px 0 5px;
	box-sizing: border-box;
	font-size: 10px;

	&:read-only {
		background: ${Colors.gradientGreyTranslucent};
	}

	&:invalid {
		background-color: ${Colors.dangerRed};
	}
`;

export const InputSuffix = styled.span`
	position: absolute;
	right: 5px;
	top: 50%;
	transform: translateY(-50%);
	pointer-events: none;
	color: var(--panel-light-grey);
	font-size: 10px;
`;
