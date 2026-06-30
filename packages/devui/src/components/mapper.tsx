/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Key-binding config (opened from a controller/hand panel's gear). Restyled to
 * the shared control grid: one row per action — [label · binding chip · clear] — where
 * the chip shows the bound key via MappedKeyDisplay (a glyph, not the raw code)
 * and clicking it listens for the next key / mouse-button press. Thumbstick
 * directions render as a flat ↑/↓/←/→ list under a section header; everything
 * else falls under "Buttons". A footer resets the whole hand to its defaults.
 */

import { Colors, Layout, SectionBreak } from './styled.js';
import React, { useEffect, useState } from 'react';

import { Icon } from './icon.js';
import { MappedKeyDisplay } from './keys.js';
import { create } from 'zustand';
import { emitPrefsPatch } from '../prefs.js';
import { styled } from 'styled-components';

const ACTION_LABELS: Record<string, string> = {
  thumbstick: 'Press',
  trigger: 'Trig',
  squeeze: 'Grip',
  'x-button': 'X',
  'y-button': 'Y',
  'a-button': 'A',
  'b-button': 'B',
  thumbrest: 'Rest',
  pose: 'Pose',
  pinch: 'Pinch',
};
const labelFor = (a: string) => ACTION_LABELS[a] ?? a;

// Thumbstick directions render as arrow glyphs rather than text labels.
const DIRECTION_ICONS: Record<string, string> = {
  'thumbstick-up': 'arrow-up',
  'thumbstick-down': 'arrow-down',
  'thumbstick-left': 'arrow-left',
  'thumbstick-right': 'arrow-right',
};

// Display order within each section (keymap insertion order isn't presentable).
const STICK_ORDER = [
  'thumbstick-up',
  'thumbstick-down',
  'thumbstick-left',
  'thumbstick-right',
  'thumbstick',
];
const BUTTON_ORDER = [
  'trigger',
  'squeeze',
  'a-button',
  'b-button',
  'x-button',
  'y-button',
  'thumbrest',
  'pose',
  'pinch',
];

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
    pinch: 'MouseLeft',
    pose: 'KeyF',
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
    pinch: 'MouseRight',
    pose: 'Backslash',
  },
};

type KeyMapStore = {
  keyMap: KeyMapType;
  bindKey: (
    handedness: 'left' | 'right',
    action: string,
    keyCode?: string,
  ) => void;
  resetKeyMap: (handedness: 'left' | 'right') => void;
};

export const useKeyMapStore = create<KeyMapStore>((set) => ({
  keyMap: DEFAULT_KEYMAP,
  bindKey: (
    handedness: 'left' | 'right',
    action: string,
    keyCode = 'Unmapped',
  ) => {
    emitPrefsPatch({ keymap: { [handedness]: { [action]: keyCode } } });
    set((state) => ({
      keyMap: {
        ...state.keyMap,
        [handedness]: {
          ...state.keyMap[handedness],
          [action]: keyCode,
        },
      },
    }));
  },
  resetKeyMap: (handedness: 'left' | 'right') => {
    const defaults = { ...DEFAULT_KEYMAP[handedness] };
    emitPrefsPatch({ keymap: { [handedness]: defaults } });
    set((state) => ({
      keyMap: { ...state.keyMap, [handedness]: defaults },
    }));
  },
}));

const Hint = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background-color: ${Layout.inset};
  border-radius: ${Layout.cellRadius};
  margin-bottom: ${Layout.gap};
  color: ${Colors.textTertiary};
  font-size: 10px;
  line-height: 1.3;
`;

const Eyebrow = styled.div`
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: ${Colors.textTertiary};
  margin: 4px 0 1px;
`;

const Row = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: ${Layout.gap};
  height: ${Layout.rowH};
  margin-bottom: ${Layout.gap};
`;

const Label = styled.div`
  flex: none;
  width: ${Layout.labelW};
  height: ${Layout.rowH};
  display: flex;
  align-items: center;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10px;
  color: ${Colors.textGrey};
`;

const Chip = styled.button<{ $listening: boolean }>`
  flex: 1 1 auto;
  height: ${Layout.rowH};
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-radius: ${Layout.cellRadius};
  border: 1px solid
    ${({ $listening }) => ($listening ? Colors.accent : Colors.panelBorder)};
  background-color: ${({ $listening }) =>
    $listening ? Layout.accentTint : Colors.buttonBackground};
  color: ${({ $listening }) => ($listening ? Colors.accent : Colors.textWhite)};
  cursor: pointer;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  transition: all 0.12s ease;

  &:hover {
    background-color: ${({ $listening }) =>
      $listening ? Layout.accentTint : Colors.buttonPressed};
  }
  &:focus {
    outline: none;
  }
`;

const Clear = styled.button`
  flex: none;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background-color: transparent;
  color: ${Colors.textGrey};
  cursor: pointer;
  transition: all 0.12s ease;

  &:hover {
    background-color: rgba(255, 255, 255, 0.06);
    color: ${Colors.textWhite};
  }
  &:focus {
    outline: none;
  }
`;

const Reset = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: ${Layout.rowH};
  border: none;
  border-radius: ${Layout.cellRadius};
  background-color: transparent;
  color: ${Colors.textGrey};
  cursor: pointer;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;
  font-size: 12px;
  transition: all 0.12s ease;

  &:hover {
    background-color: rgba(255, 255, 255, 0.06);
    color: ${Colors.textWhite};
  }
  &:focus {
    outline: none;
  }
`;

interface ControlsMapperProps {
  handedness: 'left' | 'right';
  actions: string[];
}

export const ControlsMapper: React.FC<ControlsMapperProps> = ({
  handedness,
  actions,
}) => {
  const { keyMap, bindKey, resetKeyMap } = useKeyMapStore();
  const [listening, setListening] = useState<string | null>(null);

  useEffect(() => {
    if (!listening) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (MappedKeyDisplay[event.code]) {
        bindKey(handedness, listening, event.code);
        setListening(null);
      }
    };
    const handleMouseDown = (event: MouseEvent) => {
      const mouseButton =
        event.button === 0
          ? 'MouseLeft'
          : event.button === 2
            ? 'MouseRight'
            : null;
      if (mouseButton && MappedKeyDisplay[mouseButton]) {
        bindKey(handedness, listening, mouseButton);
        setListening(null);
      }
    };
    const preventDefaultContextMenu = (event: MouseEvent) =>
      event.preventDefault();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('contextmenu', preventDefaultContextMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('contextmenu', preventDefaultContextMenu);
    };
  }, [listening, handedness, bindKey]);

  const map = (keyMap[handedness] ?? {}) as { [key: string]: string };
  const present = Object.keys(map).filter((a) => actions.includes(a));
  const stick = STICK_ORDER.filter((a) => present.includes(a));
  const others = present
    .filter((a) => !a.startsWith('thumbstick'))
    .sort((a, b) => BUTTON_ORDER.indexOf(a) - BUTTON_ORDER.indexOf(b));

  const renderRow = (action: string) => {
    const glyph = MappedKeyDisplay[map[action]];
    return (
      <Row key={action}>
        <Label>
          {DIRECTION_ICONS[action] ? (
            <Icon name={DIRECTION_ICONS[action]} size={14} />
          ) : (
            labelFor(action)
          )}
        </Label>
        <Chip
          type="button"
          $listening={listening === action}
          onClick={() => setListening(listening === action ? null : action)}
          onContextMenu={(e) => e.preventDefault()}
          title="Click, then press a key or mouse button"
        >
          {listening === action ? 'press a key…' : glyph != null ? glyph : '—'}
        </Chip>
        <Clear
          type="button"
          onClick={() => bindKey(handedness, action)}
          onContextMenu={(e) => e.preventDefault()}
          title="Clear binding"
        >
          <Icon name="ban" size={12} />
        </Clear>
      </Row>
    );
  };

  return (
    <>
      <SectionBreak />
      <Hint>
        <Icon name="keyboard" size={12} />
        Click a binding, then press a key or mouse button
      </Hint>
      {stick.length > 0 && <Eyebrow>Thumbstick</Eyebrow>}
      {stick.map(renderRow)}
      {others.length > 0 && stick.length > 0 && <Eyebrow>Buttons</Eyebrow>}
      {others.map(renderRow)}
      <SectionBreak />
      <Reset type="button" onClick={() => resetKeyMap(handedness)}>
        <Icon name="rotate-ccw" size={12} />
        Reset to defaults
      </Reset>
    </>
  );
};
