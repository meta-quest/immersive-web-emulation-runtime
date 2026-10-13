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
  Layout,
  PanelHeaderButton,
  SectionBreak,
} from './styled.js';

import { Icon } from './icon.js';
import { InputLayer } from '../scene.js';
import React from 'react';
import { Vector3Input } from './vec3.js';
import { XRDevice, supportsGazeTracking } from 'iwer';
import { create } from 'zustand';
import { emitPrefsPatch, getEnvironmentLoader } from '../prefs.js';
import { styled } from 'styled-components';
import { useInputModeStore } from './controls.js';
import {
  useGazeSettingsStore,
  type GazeCommitHand,
  type GazeMode,
} from '../gaze.js';

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

const POPOVER_WIDTH = 248;

const Popover = styled(ControlPanel)<{ $left: number }>`
  position: absolute;
  top: calc(100% + 8px);
  left: ${({ $left }) => `${$left}px`};
  width: ${POPOVER_WIDTH}px;
  box-sizing: border-box;
  gap: ${ControlButtonStyles.gap};
  padding: 8px;
  overflow: visible;
  z-index: 10;
`;

const PopoverHeader = styled.div`
  min-height: 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 4px;

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 2px solid ${Colors.accent};
    outline-offset: 1px;
    border-radius: ${Layout.cellRadius};
  }
`;

const PopoverTitle = styled.strong`
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
`;

const MenuRow = styled.button<{ $selected?: boolean; $unavailable?: boolean }>`
  width: 100%;
  min-height: 42px;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid
    ${({ $selected }) =>
      $selected ? Layout.accentSoft : 'rgba(255, 255, 255, 0.04)'};
  border-radius: ${Layout.cellRadius};
  background: ${({ $selected }) =>
    $selected ? Layout.accentTint : 'transparent'};
  color: ${({ $selected, $unavailable }) =>
    $unavailable
      ? Colors.textGrey
      : $selected
        ? Colors.accent
        : Colors.textWhite};
  cursor: ${({ $unavailable }) => ($unavailable ? 'default' : 'pointer')};
  text-align: left;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;
  &:hover {
    background: ${({ $selected, $unavailable }) =>
      $unavailable
        ? $selected
          ? Layout.accentTint
          : 'transparent'
        : $selected
          ? 'rgba(45, 127, 249, 0.24)'
          : 'rgba(255, 255, 255, 0.07)'};
  }

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 2px solid ${Colors.accent};
    outline-offset: 1px;
  }
`;

const MenuRowCopy = styled.span`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
`;

const MenuRowTitle = styled.span`
  font-size: 12px;
  font-weight: 600;
  line-height: 15px;
`;

const MenuRowHint = styled.span`
  color: ${Colors.textGrey};
  font-size: 10px;
  font-weight: 400;
  line-height: 13px;
`;

const SectionLabel = styled.div`
  padding: 5px 2px 3px;
  color: ${Colors.textGrey};
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
`;

const SegmentedControl = styled.div<{ $unavailable?: boolean }>`
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  padding: 2px;
  border-radius: ${Layout.cellRadius};
  background: ${({ $unavailable }) =>
    $unavailable ? 'rgba(20, 20, 22, 0.42)' : Layout.inset};
`;

const SegmentButton = styled.button<{
  $selected?: boolean;
  $unavailable?: boolean;
}>`
  height: ${Layout.rowH};
  min-width: 0;
  padding: 0 6px;
  overflow: hidden;
  border: 1px solid
    ${({ $selected, $unavailable }) =>
      $selected
        ? $unavailable
          ? 'rgba(255, 255, 255, 0.08)'
          : Layout.accentSoft
        : 'transparent'};
  border-radius: 6px;
  background: ${({ $selected, $unavailable }) =>
    $selected
      ? $unavailable
        ? 'rgba(255, 255, 255, 0.04)'
        : Layout.accentTint
      : 'transparent'};
  color: ${({ $selected, $unavailable }) =>
    $unavailable
      ? Colors.textGrey
      : $selected
        ? Colors.accent
        : Colors.textGrey};
  cursor: ${({ $unavailable }) => ($unavailable ? 'not-allowed' : 'pointer')};
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;

  &:hover {
    color: ${({ $unavailable }) =>
      $unavailable ? Colors.textGrey : Colors.textWhite};
    background: ${({ $selected, $unavailable }) =>
      $unavailable
        ? $selected
          ? 'rgba(255, 255, 255, 0.04)'
          : 'transparent'
        : $selected
          ? 'rgba(45, 127, 249, 0.24)'
          : 'rgba(255, 255, 255, 0.06)'};
  }

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 2px solid ${Colors.accent};
    outline-offset: 1px;
  }
`;

const StatusCard = styled.div`
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  align-items: start;
  gap: 7px;
  padding: 7px 8px;
  border-radius: ${Layout.cellRadius};
  background: ${Layout.inset};
  color: ${Colors.textGrey};
  font-size: 10px;
  line-height: 14px;
`;

const StatusDot = styled.span<{ $tone: 'active' | 'error' | 'idle' }>`
  width: 6px;
  height: 6px;
  margin-top: 4px;
  border-radius: 50%;
  background: ${({ $tone }) =>
    $tone === 'active'
      ? Colors.accent
      : $tone === 'error'
        ? Colors.dangerRed
        : Colors.textGrey};
  box-shadow: ${({ $tone }) =>
    $tone === 'active' ? `0 0 6px ${Colors.accentGlow}` : 'none'};
`;

const ShortcutList = styled.div`
  display: grid;
  gap: 4px;
  padding: 2px;
`;

const ShortcutRow = styled.div`
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  color: ${Colors.textGrey};
  font-size: 10px;
  line-height: 13px;

  > :first-child {
    justify-self: center;
  }
`;

const ShortcutKey = styled.span`
  min-width: 20px;
  box-sizing: border-box;
  padding: 2px 4px;
  border: 1px solid ${Colors.panelBorder};
  border-radius: 5px;
  color: ${Colors.textWhite};
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10px;
  text-align: center;
`;

interface GazeStatus {
  supported: boolean;
  sessionActive: boolean;
  negotiated: boolean;
  connected: boolean;
}

function readGazeStatus(xrDevice: XRDevice): GazeStatus {
  const activeSession = xrDevice.activeSession;
  return {
    supported: supportsGazeTracking(xrDevice.supportedFeatures),
    sessionActive: activeSession != null,
    negotiated: Boolean(
      activeSession?.enabledFeatures.some(
        (feature) => feature === 'gaze-tracking' || feature === 'eye-tracking',
      ),
    ),
    connected: Boolean(xrDevice.gaze?.connected),
  };
}

function useGazeStatus(xrDevice: XRDevice): GazeStatus {
  const [status, setStatus] = React.useState(() => readGazeStatus(xrDevice));
  React.useEffect(() => {
    const refresh = () => {
      const next = readGazeStatus(xrDevice);
      setStatus((previous) =>
        previous.supported === next.supported &&
        previous.sessionActive === next.sessionActive &&
        previous.negotiated === next.negotiated &&
        previous.connected === next.connected
          ? previous
          : next,
      );
    };
    refresh();
    const interval = window.setInterval(refresh, 500);
    return () => window.clearInterval(interval);
  }, [xrDevice]);
  return status;
}

function useAnchoredPopover(
  open: boolean,
  triggerRef: React.RefObject<HTMLElement | null>,
): number {
  const [left, setLeft] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const host = trigger?.offsetParent as HTMLElement | null;
      if (!trigger || !host) return;
      const triggerBounds = trigger.getBoundingClientRect();
      const hostBounds = host.getBoundingClientRect();
      const viewportLeft = Math.max(
        8,
        Math.min(
          triggerBounds.left + triggerBounds.width / 2 - POPOVER_WIDTH / 2,
          window.innerWidth - POPOVER_WIDTH - 8,
        ),
      );
      setLeft(viewportLeft - hostBounds.left);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, triggerRef]);
  return left;
}

function usePopoverFocus(
  open: boolean,
  popoverRef: React.RefObject<HTMLElement | null>,
): void {
  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const popover = popoverRef.current;
      const preferred = popover?.querySelector<HTMLElement>(
        '[data-autofocus="true"]',
      );
      const first = popover?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      );
      (preferred ?? first)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, popoverRef]);
}

// Environments of SEM versions that do not list their own.
const legacyEnvironments = [
  'meeting_room',
  'living_room',
  'music_room',
  'office_large',
  'office_small',
];

type HeaderStateStore = {
  infoPanelOpen: boolean;
  envDropDownOpen: boolean;
  headsetOpen: boolean;
  inputMenuOpen: boolean;
  gazePanelOpen: boolean;
  setInfoPanelOpen: (open: boolean) => void;
  setEnvDropDownOpen: (open: boolean) => void;
  setHeadsetOpen: (open: boolean) => void;
  setInputMenuOpen: (open: boolean) => void;
  setGazePanelOpen: (open: boolean) => void;
};

export const useHeaderStateStore = create<HeaderStateStore>((set) => ({
  infoPanelOpen: false,
  envDropDownOpen: false,
  headsetOpen: false,
  inputMenuOpen: false,
  gazePanelOpen: false,
  setInfoPanelOpen: (open: boolean) => set(() => ({ infoPanelOpen: open })),
  setEnvDropDownOpen: (open: boolean) => set(() => ({ envDropDownOpen: open })),
  setHeadsetOpen: (open: boolean) => set(() => ({ headsetOpen: open })),
  setInputMenuOpen: (open: boolean) => set(() => ({ inputMenuOpen: open })),
  setGazePanelOpen: (open: boolean) => set(() => ({ gazePanelOpen: open })),
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

type InputPreset = 'controller' | 'hand' | 'gaze-hands';

const GAZE_MODES: Array<{ value: GazeMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'head-locked', label: 'Head' },
];

const COMMIT_HANDS: Array<{ value: GazeCommitHand; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

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
  const visibilityMaskSupported = xrDevice.visibilityMask !== undefined;
  const [visibilityMaskEnabled, setVisibilityMaskEnabled] = React.useState(
    xrDevice.visibilityMaskEnabled,
  );
  const { inputMode, setInputMode } = useInputModeStore();
  const gazeMode = useGazeSettingsStore((state) => state.mode);
  const setGazeMode = useGazeSettingsStore((state) => state.setMode);
  const gazeCommitHand = useGazeSettingsStore((state) => state.commitHand);
  const setGazeCommitHand = useGazeSettingsStore(
    (state) => state.setCommitHand,
  );
  const gazeStatus = useGazeStatus(xrDevice);
  const controlsRegionRef = React.useRef<HTMLDivElement>(null);
  const inputTriggerRef = React.useRef<HTMLButtonElement>(null);
  const gazeTriggerRef = React.useRef<HTMLButtonElement>(null);
  const headsetTriggerRef = React.useRef<HTMLButtonElement>(null);
  const environmentTriggerRef = React.useRef<HTMLButtonElement>(null);
  const inputPopoverRef = React.useRef<HTMLDivElement>(null);
  const gazePopoverRef = React.useRef<HTMLDivElement>(null);
  const headsetPopoverRef = React.useRef<HTMLDivElement>(null);
  const environmentPopoverRef = React.useRef<HTMLDivElement>(null);
  const {
    infoPanelOpen,
    setInfoPanelOpen,
    envDropDownOpen,
    setEnvDropDownOpen,
    headsetOpen,
    setHeadsetOpen,
    inputMenuOpen,
    setInputMenuOpen,
    gazePanelOpen,
    setGazePanelOpen,
  } = useHeaderStateStore();
  const inputPopoverLeft = useAnchoredPopover(inputMenuOpen, inputTriggerRef);
  const gazePopoverLeft = useAnchoredPopover(gazePanelOpen, gazeTriggerRef);
  const headsetPopoverLeft = useAnchoredPopover(headsetOpen, headsetTriggerRef);
  const environmentPopoverLeft = useAnchoredPopover(
    envDropDownOpen,
    environmentTriggerRef,
  );
  usePopoverFocus(inputMenuOpen, inputPopoverRef);
  usePopoverFocus(gazePanelOpen, gazePopoverRef);
  usePopoverFocus(headsetOpen, headsetPopoverRef);
  usePopoverFocus(envDropDownOpen, environmentPopoverRef);

  React.useEffect(() => {
    const anyPopoverOpen =
      inputMenuOpen || gazePanelOpen || headsetOpen || envDropDownOpen;
    if (!anyPopoverOpen) return;

    const closePopovers = () => {
      setInputMenuOpen(false);
      setGazePanelOpen(false);
      setHeadsetOpen(false);
      setEnvDropDownOpen(false);
    };
    const handleOutsidePointer = (event: PointerEvent) => {
      const region = controlsRegionRef.current;
      if (region && event.composedPath().includes(region)) return;
      closePopovers();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const eventStartedInControls = Boolean(
        controlsRegionRef.current &&
        event.composedPath().includes(controlsRegionRef.current),
      );
      const trigger = inputMenuOpen
        ? inputTriggerRef.current
        : gazePanelOpen
          ? gazeTriggerRef.current
          : headsetOpen
            ? headsetTriggerRef.current
            : environmentTriggerRef.current;
      closePopovers();
      if (eventStartedInControls) trigger?.focus();
    };
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [
    envDropDownOpen,
    gazePanelOpen,
    headsetOpen,
    inputMenuOpen,
    setEnvDropDownOpen,
    setGazePanelOpen,
    setHeadsetOpen,
    setInputMenuOpen,
  ]);

  const activePreset: InputPreset | null =
    gazeMode === 'off'
      ? inputMode
      : inputMode === 'hand' && gazeMode === 'cursor'
        ? 'gaze-hands'
        : null;
  const gazeEffective =
    gazeMode !== 'off' &&
    gazeStatus.sessionActive &&
    gazeStatus.negotiated &&
    gazeStatus.connected;
  const gazeStatusTone: 'active' | 'error' | 'idle' = gazeEffective
    ? 'active'
    : gazeMode !== 'off' &&
        gazeStatus.sessionActive &&
        gazeStatus.negotiated &&
        !gazeStatus.connected
      ? 'error'
      : 'idle';
  const gazeStatusText = !gazeStatus.supported
    ? 'No eye tracking on this profile · choose a gaze-capable device'
    : gazeMode === 'off'
      ? 'Off · the app receives no gaze input'
      : !gazeStatus.sessionActive
        ? 'Ready · enter XR to publish gaze'
        : !gazeStatus.negotiated
          ? "Session didn't request gaze-tracking"
          : !gazeStatus.connected
            ? 'Source disconnected · far rays are active'
            : 'Streaming to the XR session';

  const applyGazeMode = (mode: GazeMode) => {
    inputLayer.setGazeMode(mode);
    setGazeMode(inputLayer.currentGazeMode);
    emitPrefsPatch({ gazeMode: mode });
  };

  const applyCommitHand = (handedness: GazeCommitHand) => {
    inputLayer.setGazeCommitHand(handedness);
    setGazeCommitHand(handedness);
    emitPrefsPatch({ gazeCommitHand: handedness });
  };

  const selectInputPreset = (
    preset: InputPreset,
    restoreKeyboardFocus: boolean,
  ) => {
    const nextInputMode = preset === 'controller' ? 'controller' : 'hand';
    const nextGazeMode = preset === 'gaze-hands' ? 'cursor' : 'off';
    setInputMode(nextInputMode);
    xrDevice.primaryInputMode = nextInputMode;
    inputLayer.setGazeMode(nextGazeMode);
    setGazeMode(inputLayer.currentGazeMode);
    emitPrefsPatch({
      inputMode: nextInputMode,
      gazeMode: nextGazeMode,
    });
    setInputMenuOpen(false);
    if (restoreKeyboardFocus) {
      window.requestAnimationFrame(() => inputTriggerRef.current?.focus());
    }
  };

  const selectGazeMode = (mode: GazeMode) => {
    if (!gazeStatus.supported) return;
    applyGazeMode(mode);
  };

  const handleGazeModeKey = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    mode: GazeMode,
  ) => {
    if (!gazeStatus.supported) return;
    const direction =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const index = GAZE_MODES.findIndex((entry) => entry.value === mode);
    const next =
      GAZE_MODES[(index + direction + GAZE_MODES.length) % GAZE_MODES.length];
    selectGazeMode(next.value);
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll('[role="radio"]');
    (
      buttons?.[next.value === 'off' ? 0 : next.value === 'cursor' ? 1 : 2] as
        | HTMLButtonElement
        | undefined
    )?.focus();
  };

  const handleCommitHandKey = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    handedness: GazeCommitHand,
  ) => {
    if (gazeMode === 'off' || !gazeStatus.supported) return;
    const direction =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const index = COMMIT_HANDS.findIndex((entry) => entry.value === handedness);
    const next =
      COMMIT_HANDS[
        (index + direction + COMMIT_HANDS.length) % COMMIT_HANDS.length
      ];
    applyCommitHand(next.value);
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll('[role="radio"]');
    (
      buttons?.[next.value === 'left' ? 0 : 1] as HTMLButtonElement | undefined
    )?.focus();
  };

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
      <div ref={controlsRegionRef} style={{ position: 'relative' }}>
        <HeaderButtonsContainer>
          <HeaderButton
            title="Reset device transforms"
            onClick={() => inputLayer.resetDeviceTransforms()}
          >
            <Icon name="rotate-ccw" size={16} />
          </HeaderButton>
          <HeaderButton
            title={
              gazeMode === 'cursor'
                ? 'Pointer lock is unavailable while cursor gaze is active'
                : 'Play mode (lock pointer)'
            }
            disabled={gazeMode === 'cursor'}
            onClick={() => {
              inputLayer.lockPointer();
              setEnvDropDownOpen(false);
              setInfoPanelOpen(false);
            }}
          >
            <Icon name="circle-play" size={16} />
          </HeaderButton>
          <HeaderButton
            ref={inputTriggerRef}
            title="Select input mode"
            aria-expanded={inputMenuOpen}
            aria-controls={inputMenuOpen ? 'iwer-input-mode-menu' : undefined}
            $open={inputMenuOpen}
            onClick={() => {
              setInputMenuOpen(!inputMenuOpen);
              setHeadsetOpen(false);
              setGazePanelOpen(false);
              setEnvDropDownOpen(false);
              setInfoPanelOpen(false);
            }}
          >
            <Icon
              name={
                inputMode === 'hand' && gazeMode === 'cursor'
                  ? 'eye'
                  : inputMode === 'controller'
                    ? 'gamepad-2'
                    : 'hand'
              }
              size={16}
            />
          </HeaderButton>
          <HeaderButton
            ref={gazeTriggerRef}
            title="Configure gaze emulation"
            aria-expanded={gazePanelOpen}
            aria-controls={gazePanelOpen ? 'iwer-gaze-settings' : undefined}
            $active={gazeMode !== 'off'}
            $open={gazePanelOpen}
            onClick={() => {
              setGazePanelOpen(!gazePanelOpen);
              setHeadsetOpen(false);
              setInputMenuOpen(false);
              setEnvDropDownOpen(false);
              setInfoPanelOpen(false);
            }}
          >
            <Icon
              name="scan-eye"
              size={16}
              color={gazeStatusTone === 'error' ? Colors.dangerRed : undefined}
            />
          </HeaderButton>
          <HeaderButton
            ref={headsetTriggerRef}
            title="Headset position"
            aria-expanded={headsetOpen}
            aria-controls={headsetOpen ? 'iwer-headset-settings' : undefined}
            $open={headsetOpen}
            onClick={() => {
              setHeadsetOpen(!headsetOpen);
              setInputMenuOpen(false);
              setGazePanelOpen(false);
              setEnvDropDownOpen(false);
              setInfoPanelOpen(false);
            }}
          >
            <Icon name="glasses" size={16} />
          </HeaderButton>
          <HeaderButton
            aria-label="Field-of-view mask"
            aria-pressed={visibilityMaskEnabled}
            disabled={!visibilityMaskSupported}
            title={
              visibilityMaskSupported
                ? (visibilityMaskEnabled ? 'Disable' : 'Enable') +
                  ' field-of-view mask'
                : 'Field-of-view mask unavailable for this device profile'
            }
            onClick={() => {
              xrDevice.visibilityMaskEnabled = !xrDevice.visibilityMaskEnabled;
              setVisibilityMaskEnabled(xrDevice.visibilityMaskEnabled);
              emitPrefsPatch({
                visibilityMaskEnabled: xrDevice.visibilityMaskEnabled,
              });
            }}
          >
            <Icon
              name="scan"
              size={16}
              color={
                visibilityMaskSupported
                  ? visibilityMaskEnabled
                    ? Colors.accent
                    : Colors.textGrey
                  : Colors.textTertiary
              }
            />
          </HeaderButton>
          {xrDevice.sem && (
            <>
              <SectionBreak $horizontal={false} />
              <HeaderButton
                ref={environmentTriggerRef}
                title="Select emulated environment"
                aria-expanded={envDropDownOpen}
                aria-controls={
                  envDropDownOpen ? 'iwer-environment-menu' : undefined
                }
                $open={envDropDownOpen}
                onClick={() => {
                  setEnvDropDownOpen(!envDropDownOpen);
                  setInputMenuOpen(false);
                  setGazePanelOpen(false);
                  setHeadsetOpen(false);
                  setInfoPanelOpen(false);
                }}
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
        {inputMenuOpen && (
          <Popover
            ref={inputPopoverRef}
            id="iwer-input-mode-menu"
            role="group"
            aria-label="Input mode"
            $left={inputPopoverLeft}
          >
            <PopoverHeader>
              <Icon name="gamepad-2" size={15} />
              <PopoverTitle>Input setup</PopoverTitle>
            </PopoverHeader>
            <MenuRow
              type="button"
              aria-pressed={activePreset === 'controller'}
              data-autofocus={activePreset === 'controller'}
              $selected={activePreset === 'controller'}
              onClick={(event) =>
                selectInputPreset('controller', event.detail === 0)
              }
            >
              <Icon name="gamepad-2" size={15} />
              <MenuRowCopy>
                <MenuRowTitle>Controllers</MenuRowTitle>
                <MenuRowHint>Ray + trigger</MenuRowHint>
              </MenuRowCopy>
              {activePreset === 'controller' ? (
                <Icon name="circle-dot" size={14} color={Colors.accent} />
              ) : (
                <span aria-hidden="true" />
              )}
            </MenuRow>
            <MenuRow
              type="button"
              aria-pressed={activePreset === 'hand'}
              data-autofocus={activePreset === 'hand'}
              $selected={activePreset === 'hand'}
              onClick={(event) => selectInputPreset('hand', event.detail === 0)}
            >
              <Icon name="hand" size={15} />
              <MenuRowCopy>
                <MenuRowTitle>Hands</MenuRowTitle>
                <MenuRowHint>Ray, poke + grab</MenuRowHint>
              </MenuRowCopy>
              {activePreset === 'hand' ? (
                <Icon name="circle-dot" size={14} color={Colors.accent} />
              ) : (
                <span aria-hidden="true" />
              )}
            </MenuRow>
            <MenuRow
              type="button"
              aria-pressed={activePreset === 'gaze-hands'}
              data-autofocus={activePreset === 'gaze-hands'}
              aria-disabled={!gazeStatus.supported}
              aria-describedby={
                gazeStatus.supported ? undefined : 'iwer-gaze-preset-hint'
              }
              $selected={activePreset === 'gaze-hands'}
              $unavailable={!gazeStatus.supported}
              title={
                gazeStatus.supported
                  ? 'Use cursor gaze with hand pinch'
                  : 'Select a gaze-capable device profile first'
              }
              onClick={(event) => {
                if (gazeStatus.supported) {
                  selectInputPreset('gaze-hands', event.detail === 0);
                }
              }}
            >
              <Icon name="eye" size={15} />
              <MenuRowCopy>
                <MenuRowTitle>Gaze + Hands</MenuRowTitle>
                <MenuRowHint>Look, then pinch</MenuRowHint>
              </MenuRowCopy>
              {activePreset === 'gaze-hands' ? (
                <Icon name="circle-dot" size={14} color={Colors.accent} />
              ) : (
                <span aria-hidden="true" />
              )}
            </MenuRow>
            {!gazeStatus.supported && (
              <MenuRowHint
                id="iwer-gaze-preset-hint"
                style={{ padding: '4px' }}
              >
                Needs an eye-tracking profile, such as Meta Quest Pro.
              </MenuRowHint>
            )}
            {activePreset == null && (
              <MenuRowHint style={{ padding: '5px 4px 2px' }}>
                Custom · {inputMode === 'controller' ? 'Controllers' : 'Hands'}
                {' + '}
                {gazeMode === 'head-locked' ? 'head gaze' : 'cursor gaze'}
              </MenuRowHint>
            )}
          </Popover>
        )}
        {gazePanelOpen && (
          <Popover
            ref={gazePopoverRef}
            id="iwer-gaze-settings"
            role="group"
            aria-label="Gaze emulation settings"
            $left={gazePopoverLeft}
          >
            <PopoverHeader>
              <Icon name="eye" size={15} />
              <PopoverTitle>Gaze emulation</PopoverTitle>
              <PanelHeaderButton
                title="Close gaze settings"
                onClick={(event) => {
                  setGazePanelOpen(false);
                  if (event.detail === 0) gazeTriggerRef.current?.focus();
                }}
              >
                <Icon name="circle-x" size={14} />
              </PanelHeaderButton>
            </PopoverHeader>
            <StatusCard aria-live="polite">
              <StatusDot $tone={gazeStatusTone} />
              <span>{gazeStatusText}</span>
            </StatusCard>
            <SectionLabel id="iwer-gaze-mode-label">Gaze mode</SectionLabel>
            <SegmentedControl
              role="radiogroup"
              aria-label="Gaze mode"
              aria-labelledby="iwer-gaze-mode-label"
              aria-disabled={!gazeStatus.supported}
              $unavailable={!gazeStatus.supported}
            >
              {GAZE_MODES.map(({ value, label }) => (
                <SegmentButton
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={gazeMode === value}
                  aria-disabled={!gazeStatus.supported}
                  tabIndex={gazeMode === value ? 0 : -1}
                  data-autofocus={gazeMode === value}
                  $selected={gazeMode === value}
                  $unavailable={!gazeStatus.supported}
                  onClick={() => selectGazeMode(value)}
                  onKeyDown={(event) => handleGazeModeKey(event, value)}
                >
                  {label}
                </SegmentButton>
              ))}
            </SegmentedControl>
            <SectionLabel id="iwer-gaze-hand-label">Commit hand</SectionLabel>
            <SegmentedControl
              role="radiogroup"
              aria-label="Gaze commit hand"
              aria-labelledby="iwer-gaze-hand-label"
              aria-disabled={gazeMode === 'off' || !gazeStatus.supported}
              $unavailable={gazeMode === 'off' || !gazeStatus.supported}
            >
              {COMMIT_HANDS.map(({ value, label }) => (
                <SegmentButton
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={gazeCommitHand === value}
                  aria-disabled={gazeMode === 'off' || !gazeStatus.supported}
                  tabIndex={gazeCommitHand === value ? 0 : -1}
                  $selected={gazeCommitHand === value}
                  $unavailable={gazeMode === 'off' || !gazeStatus.supported}
                  onClick={() => {
                    if (gazeMode !== 'off' && gazeStatus.supported) {
                      applyCommitHand(value);
                    }
                  }}
                  onKeyDown={(event) => handleCommitHandKey(event, value)}
                >
                  {label}
                </SegmentButton>
              ))}
            </SegmentedControl>
            <MenuRowHint style={{ padding: '3px 2px 1px' }}>
              {inputMode === 'hand' ? 'Pinch' : 'Trigger'} confirms the gaze
              target.
            </MenuRowHint>
            {gazeMode === 'cursor' &&
              gazeStatus.sessionActive &&
              gazeStatus.connected && (
                <>
                  <SectionBreak />
                  <SectionLabel>Cursor controls</SectionLabel>
                  <ShortcutList>
                    <ShortcutRow>
                      <Icon name="mouse-left" size={14} />
                      <span>
                        Aim + commit · drag to move{' '}
                        {inputMode === 'hand' ? 'hand' : 'controller'}
                      </span>
                    </ShortcutRow>
                    <ShortcutRow>
                      <Icon name="mouse-right" size={14} />
                      <span>Drag to look around</span>
                    </ShortcutRow>
                    <ShortcutRow>
                      <Icon name="mouse" size={14} />
                      <span>While held, wheel to adjust depth</span>
                    </ShortcutRow>
                    <ShortcutRow>
                      <ShortcutKey>Space</ShortcutKey>
                      <span>Reset commit-hand pose</span>
                    </ShortcutRow>
                  </ShortcutList>
                  <MenuRowHint style={{ padding: '3px 2px 1px' }}>
                    Play mode is unavailable while cursor gaze is on.
                  </MenuRowHint>
                </>
              )}
          </Popover>
        )}
        {headsetOpen && (
          <Popover
            ref={headsetPopoverRef}
            id="iwer-headset-settings"
            role="group"
            aria-label="Headset position"
            $left={headsetPopoverLeft}
          >
            <PopoverHeader
              tabIndex={-1}
              data-autofocus="true"
              style={{
                fontSize: '13px',
                fontWeight: 600,
              }}
            >
              <Icon name="glasses" size={15} />
              {xrDevice.name}
            </PopoverHeader>
            <SectionBreak />
            <Vector3Input
              vector={inputLayer.combinedCameraPosition}
              label="Pos"
            />
          </Popover>
        )}
        {envDropDownOpen && (
          <Popover
            ref={environmentPopoverRef}
            id="iwer-environment-menu"
            role="group"
            aria-label="Emulated environment"
            $left={environmentPopoverLeft}
          >
            {[
              ...(xrDevice.sem?.environments ?? legacyEnvironments),
              'none',
            ].map((name) => (
              <HeaderButton
                key={name}
                style={{
                  fontSize: '12px',
                  width: '100%',
                  justifyContent: 'start',
                  borderRadius: '8px',
                  padding: '6px 10px',
                }}
                onClick={(event) => {
                  const loadEnvironment = getEnvironmentLoader();
                  if (loadEnvironment) {
                    loadEnvironment(name);
                  } else if (name === 'none') {
                    (
                      xrDevice.sem as unknown as { deleteAll(): void }
                    ).deleteAll();
                  } else {
                    xrDevice
                      .sem!.loadDefaultEnvironment(name)
                      ?.catch((error) =>
                        console.error(
                          `Could not load environment ${name}`,
                          error,
                        ),
                      );
                  }
                  emitPrefsPatch({ environment: name });
                  setEnvDropDownOpen(false);
                  if (event.detail === 0) {
                    window.requestAnimationFrame(() =>
                      environmentTriggerRef.current?.focus(),
                    );
                  }
                }}
              >
                {underscoreToTitleCase(name)}
              </HeaderButton>
            ))}
          </Popover>
        )}
      </div>
      <HeaderButtonsContainer>
        <HeaderButton
          title="About IWER"
          onClick={() => {
            setInfoPanelOpen(!infoPanelOpen);
            setInputMenuOpen(false);
            setGazePanelOpen(false);
            setHeadsetOpen(false);
            setEnvDropDownOpen(false);
          }}
        >
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
            <PanelHeaderButton
              $isRed={true}
              onClick={() => setInfoPanelOpen(false)}
            >
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
