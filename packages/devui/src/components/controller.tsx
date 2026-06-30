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
import {
  Button as GamepadButton,
  GamepadConfig,
} from 'iwer/lib/gamepad/Gamepad.js';

import { Icon } from './icon.js';
import { Joystick } from './joystick.js';
import React from 'react';
import { ScrubControl } from './scrub.js';
import { TransformHandles } from '@pmndrs/handle';
import { Vector3Input } from './vec3.js';
import type { XRController } from 'iwer/lib/device/XRController.js';

type TransformedConfig = {
  id: string;
  type: 'analog' | 'binary' | 'manual';
  hasAxes: boolean;
};

const BUTTON_LABELS: Record<string, string> = {
  thumbstick: 'Stick',
  trigger: 'Trig',
  squeeze: 'Grip',
  'a-button': 'A',
  'b-button': 'B',
  'x-button': 'X',
  'y-button': 'Y',
  thumbrest: 'Rest',
  menu: 'Menu',
};

function labelFor(id: string): string {
  if (BUTTON_LABELS[id]) return BUTTON_LABELS[id];
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/-button$/, '');
}

function transformGamepadConfig(
  gamepadConfig: GamepadConfig,
): TransformedConfig[] {
  const axesSet = new Set<string>();
  for (const axis of gamepadConfig.axes) {
    if (axis && axis.id) axesSet.add(axis.id);
  }
  const transformed = gamepadConfig.buttons
    .filter((button): button is GamepadButton => button !== null)
    .map((button) => ({
      id: button.id,
      type: button.type,
      hasAxes: axesSet.has(button.id),
    }));
  transformed.sort((a, b) => {
    if (a.hasAxes && !b.hasAxes) return -1;
    if (!a.hasAxes && b.hasAxes) return 1;
    return 0;
  });
  return transformed;
}

interface ControllerProps {
  controller: XRController;
  handle: TransformHandles;
  handedness: string;
  pointerLocked: boolean;
}

export const ControllerUI: React.FC<ControllerProps> = ({
  controller,
  handle,
  handedness,
  pointerLocked,
}) => {
  const { keyMap } = useKeyMapStore();
  const [connected, setConnected] = React.useState(controller.connected);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const transformedConfig = transformGamepadConfig(controller.gamepadConfig);
  const actions = transformedConfig.flatMap((config) =>
    config.hasAxes
      ? [
          `${config.id}-left`,
          `${config.id}-right`,
          `${config.id}-up`,
          `${config.id}-down`,
          config.id,
        ]
      : config.id,
  );
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
            <Icon name="gamepad-2" size={15} />
            Controller [{handedness === 'left' ? 'L' : 'R'}]
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
                  title={`Click to disconnect ${handedness} controller`}
                  $isRed={true}
                  onClick={() => {
                    controller.connected = false;
                    setConnected(false);
                  }}
                >
                  <Icon name="circle-x" size={14} />
                </PanelHeaderButton>
              </>
            ) : (
              <PanelHeaderButton
                title={`Click to reconnect ${handedness} controller`}
                onClick={() => {
                  controller.connected = true;
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
          <ControlsMapper handedness={handedness as any} actions={actions} />
        ) : (
          transformedConfig.map((buttonConfig) => {
            const mapping = keyMap[handedness as XRHandedness]!;
            if (buttonConfig.hasAxes) {
              return (
                <Joystick
                  xrController={controller}
                  pointerLocked={pointerLocked}
                  buttonId={buttonConfig.id}
                  mappedKeyUp={mapping[`${buttonConfig.id}-up`]}
                  mappedKeyDown={mapping[`${buttonConfig.id}-down`]}
                  mappedKeyLeft={mapping[`${buttonConfig.id}-left`]}
                  mappedKeyRight={mapping[`${buttonConfig.id}-right`]}
                  mappedKeyPressed={mapping[buttonConfig.id]}
                  key={buttonConfig.id}
                />
              );
            }
            return (
              <ScrubControl
                key={buttonConfig.id}
                label={labelFor(buttonConfig.id)}
                analog={buttonConfig.type === 'analog'}
                supportsTouch
                mappedKey={mapping[buttonConfig.id]}
                pointerLocked={pointerLocked}
                onValue={(v) => controller.updateButtonValue(buttonConfig.id, v)}
                onTouch={(t) => controller.updateButtonTouch(buttonConfig.id, t)}
              />
            );
          })
        ))}
    </ControlPanel>
  );
};
