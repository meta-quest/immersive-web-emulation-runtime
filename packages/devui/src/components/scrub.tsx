/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Shared dark UI scrub-cell: one compact row per gamepad input — a text label on the
 * left (Trig / Grip / X / Y / Rest / Pinch), then a cell where click = momentary
 * press and drag (analog) = set value 0..1, a pin that latches it (hold), and a
 * circle-dot pip that toggles the capacitive `touched` state. Laid out the same
 * way for both hands (no mirroring). The pointer-locked path shows the mapped
 * key instead.
 */

import {
  CollapsedRow,
  Colors,
  GlyphCircle,
  Layout,
  MappedKeyBlock,
  RowLabel,
} from './styled.js';
import React, { useEffect, useRef, useState } from 'react';

import { Icon } from './icon.js';
import { MappedKeyDisplay } from './keys.js';
import { styled } from 'styled-components';

const Row = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0;
  height: ${Layout.rowH};
  margin-bottom: ${Layout.gap};

  &:last-child {
    margin-bottom: 0;
  }
`;

const Pips = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  gap: ${Layout.gap};
  margin-left: ${Layout.gap};
`;

const Cell = styled.div<{ $active?: boolean }>`
  position: relative;
  flex: 1 1 auto;
  height: ${Layout.rowH};
  border-radius: ${Layout.cellRadius};
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  user-select: none;
  background-color: ${({ $active }) =>
    $active ? Layout.accentTint : Layout.inset};
  transition: background-color 0.12s ease;
`;

const Fill = styled.div`
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background-color: ${Layout.accentSoft};
  pointer-events: none;
`;

const CellLabel = styled.span`
  position: relative;
  z-index: 1;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  color: ${Colors.textWhite};
  pointer-events: none;
`;

const Pip = styled.button<{ $active?: boolean }>`
  flex: none;
  width: 22px;
  height: ${Layout.rowH};
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  background-color: ${({ $active }) =>
    $active ? Layout.accentTint : 'transparent'};
  color: ${({ $active }) => ($active ? Colors.accent : Colors.textGrey)};
  transition: all 0.12s ease;

  &:hover {
    background-color: rgba(255, 255, 255, 0.06);
  }
  &:focus {
    outline: none;
  }
`;

interface ScrubControlProps {
  label: string;
  /** Analog inputs support drag-to-set-value; binary inputs are click-only. */
  analog: boolean;
  /** Whether the input exposes a capacitive touch state. */
  supportsTouch: boolean;
  mappedKey: string;
  pointerLocked: boolean;
  onValue: (value: number) => void;
  onTouch?: (touched: boolean) => void;
}

export const ScrubControl: React.FC<ScrubControlProps> = ({
  label,
  analog,
  supportsTouch,
  mappedKey,
  pointerLocked,
  onValue,
  onTouch,
}) => {
  const [value, setValue] = useState(0);
  const [held, setHeld] = useState(false);
  const [touched, setTouched] = useState(false);
  const [isKeyPressed, setIsKeyPressed] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const heldRef = useRef(false);
  heldRef.current = held;

  const apply = (v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setValue(clamped);
    onValue(clamped);
  };

  useEffect(() => {
    if (!pointerLocked) return;
    // A binding can be a keyboard code or a mouse button. Trigger / squeeze /
    // pinch default to MouseLeft / MouseRight, so play mode must listen on the
    // mouse as well as the keyboard.
    const press = (down: boolean) => {
      onValue(down ? 1 : 0);
      setIsKeyPressed(down);
    };
    const isMouseMatch = (event: MouseEvent) =>
      (mappedKey === 'MouseLeft' && event.button === 0) ||
      (mappedKey === 'MouseRight' && event.button === 2);
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === mappedKey) press(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === mappedKey) press(false);
    };
    const mouseDown = (event: MouseEvent) => {
      if (isMouseMatch(event)) press(true);
    };
    const mouseUp = (event: MouseEvent) => {
      if (isMouseMatch(event)) press(false);
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('mousedown', mouseDown);
    window.addEventListener('mouseup', mouseUp);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('mousedown', mouseDown);
      window.removeEventListener('mouseup', mouseUp);
    };
  }, [mappedKey, pointerLocked, onValue]);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!draggingRef.current || !analog || !cellRef.current) return;
      const rect = cellRef.current.getBoundingClientRect();
      apply((event.clientX - rect.left) / rect.width);
    };
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (!heldRef.current) apply(0);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analog]);

  const onCellDown = () => {
    if (held) return;
    draggingRef.current = true;
    apply(1);
  };
  const togglePin = () => {
    const next = !held;
    setHeld(next);
    apply(next ? (value > 0 ? value : 1) : 0);
  };
  const toggleTouch = () => {
    const next = !touched;
    setTouched(next);
    onTouch?.(next);
  };

  if (pointerLocked) {
    return (
      <CollapsedRow>
        <GlyphCircle>{label}</GlyphCircle>
        <MappedKeyBlock $pressed={isKeyPressed}>
          {MappedKeyDisplay[mappedKey]}
        </MappedKeyBlock>
      </CollapsedRow>
    );
  }

  const cellLabel = analog ? value.toFixed(2) : held ? 'hold' : 'press';
  return (
    <Row>
      <RowLabel>{label}</RowLabel>
      <Cell
        ref={cellRef}
        $active={!analog && value > 0}
        onMouseDown={onCellDown}
        title="Click to press; drag to set value"
      >
        {analog && <Fill style={{ width: `${value * 100}%` }} />}
        <CellLabel>{cellLabel}</CellLabel>
      </Cell>
      <Pips>
        <Pip
          $active={held}
          onClick={togglePin}
          title="Hold (latch)"
          type="button"
        >
          <Icon name="pin" size={12} />
        </Pip>
        {supportsTouch && (
          <Pip
            $active={touched}
            onClick={toggleTouch}
            title="Toggle touch state"
            type="button"
          >
            <Icon name="circle-dot" size={12} />
          </Pip>
        )}
      </Pips>
    </Row>
  );
};
