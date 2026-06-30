/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  ControlPanel,
  Layout,
  PanelHeaderButton,
  SectionBreak,
} from './styled.js';
import { ControlsMapper, useKeyMapStore } from './mapper.js';

import { Icon } from './icon.js';
import { PoseSelector } from './pose.js';
import React from 'react';
import { ScrubControl } from './scrub.js';
import { TransformHandles } from '@pmndrs/handle';
import { Vector3Input } from './vec3.js';
import type { XRHandInput } from 'iwer/lib/device/XRHandInput.js';

interface HandProps {
  hand: XRHandInput;
  handle: TransformHandles;
  handedness: string;
  pointerLocked: boolean;
}

export const HandUI: React.FC<HandProps> = ({
  hand,
  handle,
  handedness,
  pointerLocked,
}) => {
  const { keyMap } = useKeyMapStore();
  const [connected, setConnected] = React.useState(hand.connected);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  React.useEffect(() => {
    if (pointerLocked) setSettingsOpen(false);
  }, [pointerLocked]);

  return (
    <ControlPanel
      key={handedness}
      style={
        handedness === 'left'
          ? { left: '8px', bottom: '8px' }
          : { right: '8px', bottom: '8px' }
      }
    >
      {!pointerLocked && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              fontSize: '14px',
              fontWeight: 600,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Icon name="hand" size={15} />
            Hand [{handedness === 'left' ? 'L' : 'R'}]
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', gap: '1px' }}>
            {connected ? (
              <>
                <PanelHeaderButton
                  title={`Click to ${settingsOpen ? 'close' : 'change'} key bindings`}
                  onClick={() => setSettingsOpen(!settingsOpen)}
                >
                  <Icon name="settings" size={14} />
                </PanelHeaderButton>
                <PanelHeaderButton
                  title={`Click to disconnect ${handedness} hand`}
                  $isRed={true}
                  onClick={() => {
                    hand.connected = false;
                    setConnected(false);
                  }}
                >
                  <Icon name="circle-x" size={14} />
                </PanelHeaderButton>
              </>
            ) : (
              <PanelHeaderButton
                title={`Click to reconnect ${handedness} hand`}
                onClick={() => {
                  hand.connected = true;
                  setConnected(true);
                }}
                style={{ marginLeft: '5px' }}
              >
                <Icon name="plug" size={14} />
              </PanelHeaderButton>
            )}
          </div>
        </div>
      )}
      {connected && !pointerLocked && (
        <>
          {!settingsOpen && (
            <>
              <SectionBreak />
              <Vector3Input
                vector={handle.position}
                label="Pos"
                marginBottom={Layout.gap}
              />
              <Vector3Input vector={handle.rotation} label="Rot" />
            </>
          )}
          <SectionBreak />
        </>
      )}
      {connected &&
        (settingsOpen ? (
          <ControlsMapper
            handedness={handedness as any}
            actions={['pose', 'pinch']}
          />
        ) : (
          <>
            <PoseSelector
              hand={hand}
              pointerLocked={pointerLocked}
              mappedKey={keyMap[handedness as XRHandedness]!.pose}
            />
            <ScrubControl
              label="Pinch"
              analog
              supportsTouch={false}
              mappedKey={keyMap[handedness as XRHandedness]!.pinch}
              pointerLocked={pointerLocked}
              onValue={(v) => hand.updatePinchValue(v)}
            />
          </>
        ))}
    </ControlPanel>
  );
};
