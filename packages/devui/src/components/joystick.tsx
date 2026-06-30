/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Shared dark UI thumbstick — the 2-row "special" entry. Row 1: the draggable knob (→
 * axes) sits in the first column, and live X/Y value fields sit in columns 2 & 3
 * so they line up exactly with the Position/Rotation fields above. Row 2: a
 * click scrub-cell (the stick button) + pin (hold) + touch pip. Both hands use
 * the same layout. Pointer-locked mode shows the WASD-style mapped keys.
 */

import {
  CollapsedRow,
  Colors,
  GlyphCircle,
  InputSuffix,
  Layout,
  MappedKeyBlock,
  RowLabel,
  ValueInput,
} from './styled.js';
import React, { useEffect, useRef, useState } from 'react';

import { Icon } from './icon.js';
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

const MAX_DISTANCE = 16;

const Group = styled.div`
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 0;
  margin-bottom: ${Layout.gap};
`;

const Well = styled.div`
  position: relative;
  flex: none;
  width: ${Layout.fieldW};
  height: ${Layout.fieldW};
  border-radius: 50%;
  background-color: ${Layout.inset};
  box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const Knob = styled.div`
  position: absolute;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background-color: ${Colors.accent};
  box-shadow: 0 0 8px ${Colors.accentGlow};
  cursor: grab;
  pointer-events: auto;
`;

const Col = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${Layout.gap};
  flex: 1 1 auto;
  /* Joystick occupies column 1 (= label-width's first field). Offset the X/Y
     stack by one grid gap so the fields land exactly in columns 2 and 3,
     lining up with the Position/Rotation fields above. */
  margin-left: ${Layout.gap};
`;

const Line = styled.div`
  display: flex;
  gap: ${Layout.gap};
  align-items: center;
`;

const Field = styled.div`
  position: relative;
  display: inline-block;
  height: ${Layout.rowH};
`;

const Cell = styled.div<{ $active?: boolean }>`
  flex: 1 1 auto;
  height: ${Layout.rowH};
  border-radius: ${Layout.cellRadius};
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  color: ${Colors.textWhite};
  background-color: ${({ $active }) =>
    $active ? Layout.accentTint : Layout.inset};
  transition: background-color 0.12s ease;
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

  &:hover {
    background-color: rgba(255, 255, 255, 0.06);
  }
  &:focus {
    outline: none;
  }
`;

const Pips = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  gap: ${Layout.gap};
  margin-left: ${Layout.gap};
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
  const knobRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const [axes, setAxes] = useState({ x: 0, y: 0 });
  const [pressed, setPressed] = useState(false);
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  heldRef.current = held;
  const [touched, setTouched] = useState(false);
  const [keyStates, setKeyStates] = useState({
    up: false,
    down: false,
    left: false,
    right: false,
    pressed: false,
  });
  const keyStatesRef = useRef(keyStates);
  keyStatesRef.current = keyStates;

  const handleKnobDown = (event: React.MouseEvent) => {
    const knob = knobRef.current;
    if (!knob) return;
    const rect = knob.getBoundingClientRect();
    centerRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    draggingRef.current = true;
    event.preventDefault();
  };

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!draggingRef.current || !knobRef.current) return;
      const dx = event.clientX - centerRef.current.x;
      const dy = event.clientY - centerRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let lx = dx;
      let ly = dy;
      if (dist > MAX_DISTANCE) {
        const angle = Math.atan2(dy, dx);
        lx = Math.cos(angle) * MAX_DISTANCE;
        ly = Math.sin(angle) * MAX_DISTANCE;
      }
      knobRef.current.style.transform = `translate(${lx}px, ${ly}px)`;
      const nx = lx / MAX_DISTANCE;
      const ny = ly / MAX_DISTANCE;
      xrController.updateAxes(buttonId, nx, ny);
      setAxes({ x: nx, y: ny });
    };
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (knobRef.current) knobRef.current.style.transform = 'translate(0, 0)';
      xrController.updateAxes(buttonId, 0, 0);
      setAxes({ x: 0, y: 0 });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }, [buttonId, xrController]);

  useEffect(() => {
    const up = () => {
      if (pressed && !heldRef.current) {
        setPressed(false);
        xrController.updateButtonValue(buttonId, 0);
      }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [pressed, buttonId, xrController]);

  useEffect(() => {
    if (!pointerLocked) return;
    const applyAxes = (s: typeof keyStates) => {
      const dx = (s.right ? 1 : 0) - (s.left ? 1 : 0);
      const dy = (s.down ? 1 : 0) - (s.up ? 1 : 0);
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag === 0) xrController.updateAxes(buttonId, 0, 0);
      else xrController.updateAxes(buttonId, dx / mag, dy / mag);
    };
    // A binding is a keyboard code or a mouse button (MouseLeft / MouseRight);
    // the stick press in particular can be remapped to the mouse, so accept
    // either source.
    const setBinding = (code: string | null, isDown: boolean) => {
      if (!code) return;
      const s = { ...keyStatesRef.current };
      let matched = false;
      if (code === mappedKeyUp) {
        s.up = isDown;
        matched = true;
      }
      if (code === mappedKeyDown) {
        s.down = isDown;
        matched = true;
      }
      if (code === mappedKeyLeft) {
        s.left = isDown;
        matched = true;
      }
      if (code === mappedKeyRight) {
        s.right = isDown;
        matched = true;
      }
      if (code === mappedKeyPressed) {
        s.pressed = isDown;
        matched = true;
        xrController.updateButtonValue(buttonId, isDown ? 1 : 0);
      }
      if (!matched) return;
      setKeyStates(s);
      applyAxes(s);
    };
    const mouseCode = (event: MouseEvent) =>
      event.button === 0
        ? 'MouseLeft'
        : event.button === 2
          ? 'MouseRight'
          : null;
    const keyDown = (event: KeyboardEvent) => setBinding(event.code, true);
    const keyUp = (event: KeyboardEvent) => setBinding(event.code, false);
    const mouseDown = (event: MouseEvent) => setBinding(mouseCode(event), true);
    const mouseUp = (event: MouseEvent) => setBinding(mouseCode(event), false);
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
  }, [
    pointerLocked,
    mappedKeyUp,
    mappedKeyDown,
    mappedKeyLeft,
    mappedKeyRight,
    mappedKeyPressed,
    buttonId,
    xrController,
  ]);

  const clickDown = () => {
    if (held) return;
    setPressed(true);
    xrController.updateButtonValue(buttonId, 1);
  };
  const togglePin = () => {
    const next = !held;
    setHeld(next);
    setPressed(next);
    xrController.updateButtonValue(buttonId, next ? 1 : 0);
  };
  const toggleTouch = () => {
    const next = !touched;
    setTouched(next);
    xrController.updateButtonTouch(buttonId, next);
  };

  if (pointerLocked) {
    // Original compact cross: row 1 = [icon][up][press], row 2 = [left][down]
    // [right] — so the up key (W) is indented next to the glyph and A/S/D sit
    // directly beneath the glyph / up / press columns.
    return (
      <>
        <CollapsedRow>
          <GlyphCircle>Stick</GlyphCircle>
          <MappedKeyBlock $pressed={keyStates.up}>
            {MappedKeyDisplay[mappedKeyUp]}
          </MappedKeyBlock>
          <MappedKeyBlock $pressed={keyStates.pressed}>
            {MappedKeyDisplay[mappedKeyPressed]}
          </MappedKeyBlock>
        </CollapsedRow>
        <CollapsedRow>
          <MappedKeyBlock $pressed={keyStates.left}>
            {MappedKeyDisplay[mappedKeyLeft]}
          </MappedKeyBlock>
          <MappedKeyBlock $pressed={keyStates.down}>
            {MappedKeyDisplay[mappedKeyDown]}
          </MappedKeyBlock>
          <MappedKeyBlock $pressed={keyStates.right}>
            {MappedKeyDisplay[mappedKeyRight]}
          </MappedKeyBlock>
        </CollapsedRow>
      </>
    );
  }

  return (
    <Group>
      <RowLabel>Stick</RowLabel>
      <Well>
        <Knob ref={knobRef} onMouseDown={handleKnobDown} />
      </Well>
      <Col>
        <Line>
          <Field>
            <ValueInput readOnly value={axes.x.toFixed(2)} />
            <InputSuffix>X</InputSuffix>
          </Field>
          <Field>
            <ValueInput readOnly value={axes.y.toFixed(2)} />
            <InputSuffix>Y</InputSuffix>
          </Field>
        </Line>
        <Line style={{ gap: 0 }}>
          <Cell $active={pressed || held} onMouseDown={clickDown}>
            click
          </Cell>
          <Pips>
            <Pip
              $active={held}
              onClick={togglePin}
              type="button"
              title="Hold (latch)"
            >
              <Icon name="pin" size={12} />
            </Pip>
            <Pip
              $active={touched}
              onClick={toggleTouch}
              type="button"
              title="Toggle touch state"
            >
              <Icon name="circle-dot" size={12} />
            </Pip>
          </Pips>
        </Line>
      </Col>
    </Group>
  );
};
