import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import styled from 'styled-components';

export const Button = styled.button<{ $reverse: boolean }>`
	background-color: rgba(255, 255, 255, 0.3);
	border: none;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	color: white;
	border-radius: 2px;
	font-size: 14px;
	height: 24px;
	min-width: 24px;
	transition: all 0.2s ease-in-out;
	margin: 0 1px;
	text-transform: none;
	box-shadow: none;
	font-family: Arial, sans-serif;

	&:hover {
		background-color: rgba(255, 255, 255, 0.5);
	}

	&:active {
		background-color: rgba(255, 255, 255, 0.6);
	}

	&:first-child {
		border-radius: ${({ $reverse }) =>
			$reverse ? '2px 8px 8px 2px' : '8px 2px 2px 8px'};
	}

	&:last-child {
		border-radius: ${({ $reverse }) =>
			$reverse ? '8px 2px 2px 8px' : '2px 8px 8px 2px'};
	}
`;

export const MappedKeyBlock = styled.div<{ $pressed: boolean }>`
	background-color: ${({ $pressed }) =>
		$pressed ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.3)'};
	border: none;
	display: flex;
	align-items: center;
	justify-content: center;
	color: white;
	border-radius: 5px;
	font-size: 14px;
	font-family: Arial, sans-serif;
	height: 20px;
	width: 20px;
	transition: all 0.2s ease-in-out;
`;

export const ButtonContainer = styled.div<{ $reverse: boolean }>`
	display: flex;
	align-items: center;
	height: 24px;
	margin-bottom: 2px;
	justify-content: flex-start;
	flex-direction: ${({ $reverse }) => ($reverse ? 'row-reverse' : 'row')};
`;

export const ButtonGroup = styled.div<{ $reverse: boolean }>`
	display: flex;
	flex-direction: ${({ $reverse }) => ($reverse ? 'row-reverse' : 'row')};
	height: 100%;
	justify-content: space-between;
	align-items: center;
`;

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
	background-color: white;
	border-radius: 50%;
	width: 36px;
	height: 36px;
	cursor: pointer;
	pointer-events: auto;
`;

export const RangeSelector = styled.input.attrs({ type: 'range' })<{
	$reverse: boolean;
}>`
	-webkit-appearance: none;
	appearance: none;
	background-color: rgba(255, 255, 255, 0.3);
	border: none;
	height: 100%;
	width: 49px;
	cursor: pointer;
	margin: 0 1px;
	transition: all 0.2s ease-in-out;
	border-radius: ${({ $reverse }) =>
		$reverse ? '8px 2px 2px 8px' : '2px 8px 8px 2px'};

	&::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 8px;
		height: 24px;
		background-color: white;
		border-radius: 3px;
	}

	&::-moz-range-thumb {
		width: 8px;
		height: 24px;
		background-color: white;
		border-radius: 3px;
	}

	&::-ms-thumb {
		width: 8px;
		height: 24px;
		background-color: white;
		border-radius: 3px;
	}
`;

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

export const FAIcon = styled(FontAwesomeIcon)`
	height: 14px;
	min-height: 14px;
	max-height: 14px;
	width: 14px;
	min-width: 14px;
	max-width: 14px;
`;
