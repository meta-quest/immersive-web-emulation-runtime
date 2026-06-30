/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  XRDevice,
  metaQuest2,
  metaQuest3,
  metaQuestPro,
  oculusQuest1,
} from 'iwer';

import {
  DEFAULT_KEYMAP,
  DevUI,
  setEnvironmentLoader,
  useKeyMapStore,
} from '@iwer/devui';
import { SyntheticEnvironmentModule } from '@iwer/sem';
import { DEFAULTS, type DeviceId, type EnvironmentId } from './agent/prefs.js';
import { awaitPrefsSeed } from './agent/seed-client.js';
import { installAgentBridge } from './agent/bridge-page.js';
import livingRoom from '@iwer/sem/captures/living_room.json';
import meetingRoom from '@iwer/sem/captures/meeting_room.json';
import musicRoom from '@iwer/sem/captures/music_room.json';
import officeLarge from '@iwer/sem/captures/office_large.json';
import officeSmall from '@iwer/sem/captures/office_small.json';

const DEVICE_CONFIGS = {
  oculusQuest1,
  metaQuest2,
  metaQuestPro,
  metaQuest3,
};

const ENVIRONMENTS = {
  living_room: livingRoom,
  meeting_room: meetingRoom,
  music_room: musicRoom,
  office_large: officeLarge,
  office_small: officeSmall,
};

type SeededPrefs = Partial<typeof DEFAULTS>;

declare global {
  interface Window {
    CustomWebXRPolyfill?: boolean;
    __IWE_XR_DEVICE__?: XRDevice;
    __IWE_PREFS__?: SeededPrefs;
  }
}

function deviceConfig(device: DeviceId | undefined) {
  return DEVICE_CONFIGS[device ?? DEFAULTS.device] ?? metaQuest3;
}

function environmentJson(environment: EnvironmentId | undefined) {
  const id = environment ?? DEFAULTS.environment;
  if (id === 'none') return null;
  return ENVIRONMENTS[id] ?? livingRoom;
}

// Load an environment from the STATICALLY BUNDLED captures — used by both
// load-time hydration and the in-page dropdown (via setEnvironmentLoader), so a
// runtime environment switch never falls back to a CDN fetch in the UMD build.
function loadEnvironmentById(xrDevice: XRDevice, id: string): void {
  if (id === 'none') {
    (xrDevice.sem as unknown as { deleteAll(): void }).deleteAll();
    return;
  }
  const json = environmentJson(id as EnvironmentId);
  if (json) xrDevice.sem?.loadEnvironment(json);
}

// A real prefs seed that lands after the await-timeout fallback (cold storage on
// the first navigation after browser start). If it carries non-default settings,
// reload once so they take effect instead of being silently dropped.
function handleLateSeed(late: SeededPrefs): void {
  if (!late || Object.keys(late).length === 0) return;
  if (JSON.stringify({ ...DEFAULTS, ...late }) === JSON.stringify(DEFAULTS)) {
    return;
  }
  const FLAG = 'iwe-late-seed-reload';
  try {
    if (sessionStorage.getItem(FLAG)) return;
    sessionStorage.setItem(FLAG, '1');
  } catch {
    return; // sessionStorage unavailable (opaque-origin frame) — skip the reload
  }
  location.reload();
}

export const injectRuntime = async () => {
  window.CustomWebXRPolyfill = true;
  const prefs = {
    ...DEFAULTS,
    ...((await awaitPrefsSeed(handleLateSeed)) as SeededPrefs),
  };
  const xrDevice = new XRDevice(deviceConfig(prefs.device), {
    stereoEnabled: prefs.stereoEnabled ?? DEFAULTS.stereoEnabled,
    fovy: prefs.fovy ?? DEFAULTS.fovy,
  });
  xrDevice.primaryInputMode = prefs.inputMode ?? DEFAULTS.inputMode;
  // forceInstall: the extension must override native WebXR — modern Chrome
  // ships navigator.xr, and IWER >=2.3 otherwise skips the override.
  xrDevice.installRuntime({ forceInstall: true });
  useKeyMapStore.setState({
    keyMap: prefs.keymap ?? DEFAULT_KEYMAP,
  });
  xrDevice.installDevUI(DevUI);
  xrDevice.ipd = prefs.ipd ?? DEFAULTS.ipd;
  xrDevice.installSEM(SyntheticEnvironmentModule);
  const environment = environmentJson(prefs.environment);
  if (environment) xrDevice.sem?.loadEnvironment(environment);
  // The in-page environment dropdown loads through the bundled captures, not the
  // CDN-fetching SEM default loader.
  setEnvironmentLoader((id) => loadEnvironmentById(xrDevice, id));
  if (prefs.handPoses) {
    if (xrDevice.hands.left) {
      xrDevice.hands.left.poseId = prefs.handPoses.left;
    }
    if (xrDevice.hands.right) {
      xrDevice.hands.right.poseId = prefs.handPoses.right;
    }
  }
  if (prefs.defaultPose) {
    xrDevice.devui?.applyDefaultPose?.(prefs.defaultPose);
  }
  window.__IWE_XR_DEVICE__ = xrDevice;
  window.__IWE_PREFS__ = prefs;
  // MCP bridge: expose device.remote to the extension bridge so a paired
  // coding agent can drive this page over MCP. Hardened in bridge-page.ts.
  installAgentBridge(xrDevice);
};
