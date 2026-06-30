/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { styled } from 'styled-components';

export const Colors = {
  textWhite: '#EDEDED',
  textGrey: '#9C9C9C',
  textTertiary: '#6B6B6E',
  dangerRed: 'rgba(243, 151, 143, 1)',
  dangerRedPressed: 'rgba(240, 97, 84,1)',
  // Accent — the single interactive/brand blue (active states, joystick
  // knob, slider thumb, focus). Maps to the in-overlay live readout.
  accent: '#2D7FF9',
  accentInk: '#FFFFFF',
  accentGlow: 'rgba(45, 127, 249, 0.35)',
  panelBackground: 'rgba(38, 38, 38, 0.72)',
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
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;

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

export const HeaderButtonsContainer = styled.div`
  padding: 4px;
  display: flex;
  gap: 2px;
  background-color: ${Colors.panelBackground};
  border: 1px solid ${Colors.panelBorder};
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
  box-shadow:
    0 5px 10px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  justify-content: center;
  pointer-events: all;
  border-radius: 14px;
  align-items: center;
`;

export const HeaderButton = styled.button`
  background-color: transparent;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: ${Colors.textWhite};
  border-radius: 8px;
  height: 28px;
  min-width: 28px;
  padding: 0 6px;
  transition: all 0.15s ease-in-out;
  text-transform: none;
  box-shadow: none;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;

  &:hover {
    background-color: rgba(255, 255, 255, 0.06);
  }

  &:active {
    background-color: rgba(255, 255, 255, 0.1);
  }

  &:focus {
    outline: none;
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
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;
  height: 30px;
  width: 30px;
  transition: all 0.2s ease-in-out;
`;

// Collapsed (play-mode) keymap layout — the original's compact "icon + key"
// rows, restyled. GlyphCircle is the button identifier; MappedKeyBlock is the
// bound key. Both 30px so rows stay on the original grid.
export const CollapsedRow = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 3px;
  margin-bottom: 3px;

  &:last-child {
    margin-bottom: 0;
  }
`;

export const GlyphCircle = styled.div`
  flex: none;
  box-sizing: border-box;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid ${Colors.panelBorder};
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  font-weight: 600;
  color: ${Colors.textGrey};
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

export const ButtonGroup = styled.div<{ $reverse?: boolean }>`
  display: flex;
  flex-direction: ${({ $reverse }) => ($reverse ? 'row-reverse' : 'row')};
  height: 100%;
  justify-content: space-between;
  align-items: center;
  margin: ${({ $reverse }) => ($reverse ? '0 5px 0 0' : '0 0 0 5px')};
  gap: 3px;
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
  background-color: ${Colors.accent};
  box-shadow: 0 0 8px ${Colors.accentGlow};
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
    background-color: ${Colors.accent};
    border-radius: ${ControlButtonStyles.radiusMiddle};
  }

  &::-moz-range-thumb {
    width: 10px;
    height: 30px;
    background-color: ${Colors.accent};
    border-radius: ${ControlButtonStyles.radiusMiddle};
  }

  &::-ms-thumb {
    width: 8px;
    height: 24px;
    background-color: ${Colors.accent};
    border-radius: ${ControlButtonStyles.radiusMiddle};
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

// Control-row grid — shared widths so the value fields, scrub cells, and
// the stick's axis readouts line up in the same columns across every row.
export const Layout = {
  labelW: '40px',
  fieldW: '52px',
  gap: '4px',
  rowH: '26px',
  cellRadius: '8px',
  inset: 'rgba(0, 0, 0, 0.25)',
  accentSoft: 'rgba(45, 127, 249, 0.45)',
  accentTint: 'rgba(45, 127, 249, 0.18)',
};

// A small monospace label identifying a control row (Stick / Trig / Grip / X /
// Y / Rest / Pose / Pinch) — replaces the old per-button glyphs.
export const RowLabel = styled.span`
  flex: none;
  width: ${Layout.labelW};
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10px;
  color: ${Colors.textGrey};
`;

export const ControlPanel = styled.div`
  position: fixed;
  padding: 5px;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;
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
  width: ${({ $horizontal = true }) => ($horizontal ? 'unset' : '1px')};
  height: ${({ $horizontal = true }) => ($horizontal ? '1px' : 'unset')};
  background-color: ${Colors.panelBorder};
  margin: 5px 3px;
  border: none;
`;

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

export const ValuesContainer = styled.div`
  display: flex;
  flex-direction: row;
  gap: ${Layout.gap};
  height: ${Layout.rowH};
`;

export const ValueInput = styled.input.attrs({ type: 'text' })`
  width: ${Layout.fieldW};
  outline: none;
  background: ${Layout.inset};
  border: 1px solid ${Colors.panelBorder};
  border-radius: ${Layout.cellRadius};
  height: ${Layout.rowH};
  color: ${Colors.textWhite};
  padding: 0 10px 0 5px;
  box-sizing: border-box;
  font-size: 10px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;

  &:read-only {
    background: ${Layout.inset};
    cursor: default;
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
  color: ${Colors.textGrey};
  font-size: 10px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
`;
