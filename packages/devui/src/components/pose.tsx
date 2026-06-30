/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  CollapsedRow,
  Colors,
  GlyphCircle,
  Layout,
  MappedKeyBlock,
  RowLabel,
} from './styled.js';
import React, { useEffect, useState } from 'react';

import { Icon } from './icon.js';
import { MappedKeyDisplay } from './keys.js';
import { XRHandInput } from 'iwer/lib/device/XRHandInput.js';
import { emitPrefsPatch } from '../prefs.js';
import { styled } from 'styled-components';

interface PoseSelectorProps {
  hand: XRHandInput;
  pointerLocked: boolean;
  mappedKey: string;
}

const poses = ['default', 'pinch', 'point'];

const Row = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0;
  height: ${Layout.rowH};
  margin-bottom: ${Layout.gap};
`;

// Fills the space after the label exactly like the scrub Cell, so the left
// chevron lines up with the pinch field's left edge (and the Pos/Rot column)
// and the right chevron lines up with the pinch pin column on the right.
const Stepper = styled.div`
  flex: 1 1 auto;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: ${Layout.gap};
  height: ${Layout.rowH};
`;

const Step = styled.button`
  flex: none;
  width: 22px;
  height: ${Layout.rowH};
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  background-color: ${Layout.inset};
  color: ${Colors.textGrey};

  &:hover {
    color: ${Colors.textWhite};
  }
  &:focus {
    outline: none;
  }
`;

const Value = styled.div`
  flex: 1 1 auto;
  height: ${Layout.rowH};
  border-radius: ${Layout.cellRadius};
  background-color: ${Layout.inset};
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: ${Colors.textWhite};
`;

export const PoseSelector: React.FC<PoseSelectorProps> = ({
  hand,
  pointerLocked,
  mappedKey,
}) => {
  const [poseId, setPoseId] = useState(hand.poseId);
  const [isKeyPressed, setIsKeyPressed] = useState(false);

  const handedness = hand.inputSource.handedness;
  const cyclePose = (delta: number) => {
    const idx = poses.indexOf(hand.poseId);
    const next = (idx + poses.length + delta) % poses.length;
    setPoseId(poses[next]);
    hand.poseId = poses[next];
    emitPrefsPatch({ handPoses: { [handedness]: poses[next] } });
  };

  useEffect(() => {
    // The pose-cycle binding can be a keyboard code or a mouse button.
    const isMouseMatch = (event: MouseEvent) =>
      (mappedKey === 'MouseLeft' && event.button === 0) ||
      (mappedKey === 'MouseRight' && event.button === 2);
    const down = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.code === mappedKey) {
        cyclePose(1);
        setIsKeyPressed(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === mappedKey) setIsKeyPressed(false);
    };
    const mouseDown = (event: MouseEvent) => {
      if (isMouseMatch(event)) {
        cyclePose(1);
        setIsKeyPressed(true);
      }
    };
    const mouseUp = (event: MouseEvent) => {
      if (isMouseMatch(event)) setIsKeyPressed(false);
    };
    if (pointerLocked) {
      window.addEventListener('keydown', down);
      window.addEventListener('keyup', up);
      window.addEventListener('mousedown', mouseDown);
      window.addEventListener('mouseup', mouseUp);
    }
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', mouseDown);
      window.removeEventListener('mouseup', mouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappedKey, pointerLocked, hand]);

  if (pointerLocked) {
    return (
      <CollapsedRow>
        <GlyphCircle>Pose</GlyphCircle>
        <MappedKeyBlock $pressed={isKeyPressed}>
          {MappedKeyDisplay[mappedKey]}
        </MappedKeyBlock>
      </CollapsedRow>
    );
  }

  return (
    <Row>
      <RowLabel>Pose</RowLabel>
      <Stepper>
        <Step type="button" onClick={() => cyclePose(-1)} title="Previous pose">
          <Icon name="chevron-left" size={14} />
        </Step>
        <Value>{poseId}</Value>
        <Step type="button" onClick={() => cyclePose(1)} title="Next pose">
          <Icon name="chevron-right" size={14} />
        </Step>
      </Stepper>
    </Row>
  );
};
