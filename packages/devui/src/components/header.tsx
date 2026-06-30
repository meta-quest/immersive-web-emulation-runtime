/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Button,
  Colors,
  ControlButtonStyles,
  ControlPanel,
  HeaderButton,
  HeaderButtonsContainer,
  PanelHeaderButton,
  SectionBreak,
} from './styled.js';

import { Icon } from './icon.js';
import { InputLayer } from '../scene.js';
import React from 'react';
import { Vector3Input } from './vec3.js';
import { XRDevice } from 'iwer';
import { create } from 'zustand';
import { emitPrefsPatch, getEnvironmentLoader } from '../prefs.js';
import { styled } from 'styled-components';
import { useInputModeStore } from './controls.js';

const VersionTableCol1 = styled.td`
  text-align: right;
  color: ${Colors.textWhite};
  padding: 0 8px 0 0;
  font-weight: bold;
`;

const VersionTableCol2 = styled.td`
  text-align: left;
  color: ${Colors.textGrey};
  padding: 0;
`;

const envNames = [
  'meeting_room',
  'living_room',
  'music_room',
  'office_large',
  'office_small',
  'none',
];

type HeaderStateStore = {
  infoPanelOpen: boolean;
  envDropDownOpen: boolean;
  headsetOpen: boolean;
  setInfoPanelOpen: (open: boolean) => void;
  setEnvDropDownOpen: (open: boolean) => void;
  setHeadsetOpen: (open: boolean) => void;
};

export const useHeaderStateStore = create<HeaderStateStore>((set) => ({
  infoPanelOpen: false,
  envDropDownOpen: false,
  headsetOpen: false,
  setInfoPanelOpen: (open: boolean) => set(() => ({ infoPanelOpen: open })),
  setEnvDropDownOpen: (open: boolean) => set(() => ({ envDropDownOpen: open })),
  setHeadsetOpen: (open: boolean) => set(() => ({ headsetOpen: open })),
}));

function underscoreToTitleCase(str: string): string {
  return str
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface HeaderUIProps {
  xrDevice: XRDevice;
  inputLayer: InputLayer;
}

export const HeaderUI: React.FC<HeaderUIProps> = ({ xrDevice, inputLayer }) => {
  const [planesVisible, setPlanesVisible] = React.useState(
    Boolean(xrDevice.sem?.planesVisible),
  );
  const [boxesVisible, setBoxesVisible] = React.useState(
    Boolean(xrDevice.sem?.boundingBoxesVisible),
  );
  const [meshesVisible, setMeshesVisible] = React.useState(
    Boolean(xrDevice.sem?.meshesVisible),
  );
  const { inputMode, setInputMode } = useInputModeStore();
  const {
    infoPanelOpen,
    setInfoPanelOpen,
    envDropDownOpen,
    setEnvDropDownOpen,
    headsetOpen,
    setHeadsetOpen,
  } = useHeaderStateStore();

  const semColor = (on: boolean) => (on ? Colors.accent : Colors.textGrey);

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '6px',
        padding: '8px',
      }}
    >
      <div style={{ position: 'relative' }}>
      <HeaderButtonsContainer>
        <HeaderButton
          title="Reset device transforms"
          onClick={() => inputLayer.resetDeviceTransforms()}
        >
          <Icon name="rotate-ccw" size={16} />
        </HeaderButton>
        <HeaderButton
          title="Play mode (lock pointer)"
          onClick={() => {
            inputLayer.lockPointer();
            setEnvDropDownOpen(false);
            setInfoPanelOpen(false);
          }}
        >
          <Icon name="circle-play" size={16} />
        </HeaderButton>
        <HeaderButton
          title="Toggle input mode"
          onClick={() => {
            const next = inputMode === 'controller' ? 'hand' : 'controller';
            setInputMode(next);
            xrDevice.primaryInputMode = next;
            emitPrefsPatch({ inputMode: next });
          }}
        >
          <Icon name={inputMode === 'controller' ? 'gamepad-2' : 'hand'} size={16} />
        </HeaderButton>
        <HeaderButton
          title="Headset position"
          onClick={() => {
            setHeadsetOpen(!headsetOpen);
            setEnvDropDownOpen(false);
            setInfoPanelOpen(false);
          }}
        >
          <Icon
            name="glasses"
            size={16}
            color={headsetOpen ? Colors.accent : Colors.textWhite}
          />
        </HeaderButton>
        {xrDevice.sem && (
          <>
            <SectionBreak $horizontal={false} />
            <HeaderButton
              title="Select emulated environment"
              onClick={() => setEnvDropDownOpen(!envDropDownOpen)}
            >
              <Icon name="armchair" size={16} />
            </HeaderButton>
            <HeaderButton
              title="Toggle plane visibility"
              onClick={() => {
                xrDevice.sem!.planesVisible = !planesVisible;
                setPlanesVisible(!planesVisible);
              }}
            >
              <Icon name="layers" size={16} color={semColor(planesVisible)} />
            </HeaderButton>
            <HeaderButton
              title="Toggle bounding-box visibility"
              onClick={() => {
                xrDevice.sem!.boundingBoxesVisible = !boxesVisible;
                setBoxesVisible(!boxesVisible);
              }}
            >
              <Icon name="box" size={16} color={semColor(boxesVisible)} />
            </HeaderButton>
            <HeaderButton
              title="Toggle mesh visibility"
              onClick={() => {
                xrDevice.sem!.meshesVisible = !meshesVisible;
                setMeshesVisible(!meshesVisible);
              }}
            >
              <Icon name="shapes" size={16} color={semColor(meshesVisible)} />
            </HeaderButton>
          </>
        )}
        <SectionBreak $horizontal={false} />
        <HeaderButton
          title="Save current device pose as the default for this site"
          onClick={() => {
            const defaultPose = inputLayer.captureDefaultPose();
            inputLayer.applyDefaultPose(defaultPose);
            emitPrefsPatch({ defaultPose });
          }}
        >
          <Icon name="save" size={16} />
        </HeaderButton>
        <SectionBreak $horizontal={false} />
        <HeaderButton
          title="Exit XR session"
          onClick={() => xrDevice.activeSession?.end()}
        >
          <Icon name="log-out" size={16} />
        </HeaderButton>
      </HeaderButtonsContainer>
      {headsetOpen && (
        <ControlPanel
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            gap: '6px',
            padding: '10px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              fontWeight: 600,
            }}
          >
            <Icon name="glasses" size={15} />
            {xrDevice.name}
          </div>
          <SectionBreak />
          <Vector3Input vector={inputLayer.combinedCameraPosition} label="Pos" />
        </ControlPanel>
      )}
      {envDropDownOpen && (
        <ControlPanel
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            gap: '2px',
          }}
        >
          {envNames.map((name) => (
            <HeaderButton
              key={name}
              style={{
                fontSize: '12px',
                width: '100%',
                justifyContent: 'start',
                borderRadius: '8px',
                padding: '6px 10px',
              }}
              onClick={() => {
                const loadEnvironment = getEnvironmentLoader();
                if (loadEnvironment) {
                  loadEnvironment(name);
                } else if (name === 'none') {
                  (xrDevice.sem as unknown as { deleteAll(): void }).deleteAll();
                } else {
                  // @ts-ignore
                  xrDevice.sem!.loadDefaultEnvironment(name);
                }
                emitPrefsPatch({ environment: name });
              }}
            >
              {underscoreToTitleCase(name)}
            </HeaderButton>
          ))}
        </ControlPanel>
      )}
      </div>
      <HeaderButtonsContainer>
        <HeaderButton title="About IWER" onClick={() => setInfoPanelOpen(!infoPanelOpen)}>
          <Icon name="iwer" size={16} />
        </HeaderButton>
        <HeaderButton
          title="Report issues"
          onClick={() =>
            window.open(
              'https://github.com/meta-quest/immersive-web-emulation-runtime/issues',
              '_blank',
            )
          }
        >
          <Icon name="bug" size={16} />
        </HeaderButton>
      </HeaderButtonsContainer>
      {infoPanelOpen && (
        <ControlPanel
          style={{
            top: '50vh',
            left: '50vw',
            transform: 'translate(-50%, -50%)',
            maxWidth: '240px',
            gap: '4px',
            padding: '16px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'end' }}>
            <PanelHeaderButton $isRed={true} onClick={() => setInfoPanelOpen(false)}>
              <Icon name="circle-x" size={14} />
            </PanelHeaderButton>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Icon name="iwer" size={72} />
          </div>
          <p style={{ textAlign: 'center', padding: '0 5px', margin: '0' }}>
            <b>Immersive Web Emulation Runtime</b> (IWER) is a free, open-source
            WebXR developer tool created by Meta Platforms, Inc.
          </p>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              display: 'flex',
              justifyContent: 'center',
              fontSize: '12px',
              padding: '8px',
            }}
          >
            <tbody>
              <tr>
                <VersionTableCol1>IWER</VersionTableCol1>
                <VersionTableCol2>v{xrDevice.version}</VersionTableCol2>
              </tr>
              <tr>
                <VersionTableCol1>DevUI</VersionTableCol1>
                <VersionTableCol2>v{xrDevice.devui!.version}</VersionTableCol2>
              </tr>
              {xrDevice.sem && (
                <tr>
                  <VersionTableCol1>SEM</VersionTableCol1>
                  <VersionTableCol2>v{xrDevice.sem.version}</VersionTableCol2>
                </tr>
              )}
            </tbody>
          </table>
          <Button
            style={{ borderRadius: ControlButtonStyles.radiusSolo }}
            onClick={() =>
              window.open(
                'https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/LICENSE',
                '_blank',
              )
            }
          >
            MIT License
          </Button>
          <Button
            style={{ borderRadius: ControlButtonStyles.radiusSolo }}
            onClick={() =>
              window.open(
                'https://github.com/meta-quest/immersive-web-emulation-runtime',
                '_blank',
              )
            }
          >
            View Source on GitHub
          </Button>
        </ControlPanel>
      )}
    </div>
  );
};
