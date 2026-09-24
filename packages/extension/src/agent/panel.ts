/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  DEFAULTS,
  DEVICE_CATALOG,
  ENABLED_DOMAINS_KEY,
  ENVIRONMENT_CATALOG,
  STORAGE_KEY,
  deviceSupportsVisibilityMask,
  isOverridden,
  resolveAll,
  type DeviceId,
  type EnvironmentId,
  type InputMode,
  type OriginPrefs,
  type PrefsBlob,
} from './prefs.js';
import { MSG } from './protocol.js';

interface StatusReply {
  emulationEnabled: boolean;
  connected: boolean;
  agentTabId: number | null;
  domain: string | null;
  version: string;
  url?: string;
}

interface PrefsReadReply {
  blob: PrefsBlob;
  resolved: OriginPrefs;
}

type Scope = 'origin' | 'global';

const app = document.getElementById('app')!;
let currentUrl = '';
let status: StatusReply | null = null;
let prefs: PrefsReadReply | null = null;
let scope: Scope = 'origin';
let dirty = false;
let suppressStorageRefresh = false;

function h(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function titleCase(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function send<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function acknowledgeMovedNotice(): void {
  if (prefs?.blob.ui?.seenWhatsNew === true) return;
  void send({
    type: MSG.PREFS_WRITE,
    scope: 'ui',
    patch: { seenWhatsNew: true },
  });
  void send({ type: MSG.CLEAR_NEW_BADGE });
  if (prefs) {
    prefs.blob.ui = { ...(prefs.blob.ui ?? {}), seenWhatsNew: true };
  }
}

function tabId(): number | null {
  return chrome.devtools?.inspectedWindow?.tabId ?? null;
}

async function inspectedTabUrl(): Promise<string> {
  const id = tabId();
  if (id == null) return '';
  try {
    const tab = await chrome.tabs.get(id);
    return tab.url ?? tab.pendingUrl ?? '';
  } catch {
    return '';
  }
}

async function inspectedUrl(): Promise<string> {
  if (!chrome.devtools?.inspectedWindow) return window.location.href;

  const evalUrl = await new Promise<string>((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      'location.href',
      (result: unknown, exceptionInfo?: { isException?: boolean }) => {
        resolve(exceptionInfo?.isException ? '' : String(result ?? ''));
      },
    );
  });
  return evalUrl || inspectedTabUrl();
}

async function loadState(): Promise<void> {
  const id = tabId();
  currentUrl = await inspectedUrl();
  status = await send<StatusReply>({
    type: MSG.STATUS,
    url: currentUrl,
    tabId: id,
  });
  currentUrl = currentUrl || status.url || '';
  prefs = await send<PrefsReadReply>({
    type: MSG.PREFS_READ,
    domain: scope === 'origin' ? status.domain : null,
  });
  render();
}

function effectiveDomain(): string | null {
  return scope === 'origin' ? (status?.domain ?? null) : null;
}

function value<K extends keyof OriginPrefs>(key: K): OriginPrefs[K] {
  if (!prefs) return DEFAULTS[key];
  return resolveAll(prefs.blob, effectiveDomain())[key];
}

function badge(key: keyof OriginPrefs): string {
  if (!status?.domain || scope === 'global') return 'All-sites default';
  return isOverridden(prefs?.blob, status.domain, key)
    ? 'Overridden for this site'
    : 'Default - from all-sites';
}

async function writePatch(patch: Partial<OriginPrefs>): Promise<void> {
  if (!status) return;
  acknowledgeMovedNotice();
  suppressStorageRefresh = true;
  const reply = await send<PrefsReadReply>({
    type: MSG.PREFS_WRITE,
    scope,
    domain: effectiveDomain(),
    patch,
  });
  prefs = reply;
  dirty = true;
  render();
  setTimeout(() => {
    suppressStorageRefresh = false;
  }, 100);
}

async function resetKey(key: keyof OriginPrefs): Promise<void> {
  if (!status) return;
  acknowledgeMovedNotice();
  prefs = await send<PrefsReadReply>({
    type: MSG.PREFS_WRITE,
    scope,
    domain: effectiveDomain(),
    resetKey: key,
  });
  dirty = true;
  render();
}

async function clear(clear: 'origin' | 'global' | 'all'): Promise<void> {
  if (clear === 'all' && !window.confirm('Clear all IWE emulator settings?')) {
    return;
  }
  acknowledgeMovedNotice();
  prefs = await send<PrefsReadReply>({
    type: MSG.PREFS_WRITE,
    scope,
    domain: effectiveDomain(),
    clear,
  });
  dirty = true;
  render();
}

async function reloadInspectedTab(): Promise<void> {
  const id = tabId();
  if (id == null) return;
  await chrome.tabs.reload(id, { bypassCache: true });
  dirty = false;
  render();
}

function row(
  key: keyof OriginPrefs,
  label: string,
  control: string,
  extra = '',
): string {
  return `<div class="row" data-key="${key}">
		<div><div class="label">${label}</div><div class="badge">${badge(key)}</div></div>
		<div>${control}${extra}</div>
		<div><button data-reset="${key}">Reset</button></div>
	</div>`;
}

function settingsHtml(): string {
  const domain = status?.domain ?? 'this site';
  const selectedDevice = value('device');
  const visibilityMaskSupported = deviceSupportsVisibilityMask(selectedDevice);
  return `<section>
		<h2>Persistent Settings</h2>
		<div class="segment" aria-label="Settings scope">
			<button data-scope="origin" aria-pressed="${scope === 'origin'}">This site: ${h(domain)}</button>
			<button data-scope="global" aria-pressed="${scope === 'global'}">All sites (default)</button>
		</div>
		${dirty ? '<div class="pending">Changes pending - reload page to apply.</div>' : ''}
		${row(
      'device',
      'Device',
      `<select id="device">${DEVICE_CATALOG.map(
        (id) =>
          `<option value="${id}" ${value('device') === id ? 'selected' : ''}>${titleCase(id)}</option>`,
      ).join('')}</select>`,
    )}
		${row(
      'environment',
      'Environment',
      `<select id="environment">${ENVIRONMENT_CATALOG.map(
        (id) =>
          `<option value="${id}" ${value('environment') === id ? 'selected' : ''}>${titleCase(id)}</option>`,
      ).join('')}</select>`,
    )}
			${row(
        'inputMode',
        'Input Mode',
        `<select id="inputMode">
				<option value="controller" ${value('inputMode') === 'controller' ? 'selected' : ''}>Controller</option>
				<option value="hand" ${value('inputMode') === 'hand' ? 'selected' : ''}>Hand tracking</option>
				</select>`,
      )}
			${row(
        'gazeMode',
        'Gaze Mode',
        `<select id="gazeMode">
					<option value="off" ${value('gazeMode') === 'off' ? 'selected' : ''}>Off</option>
					<option value="cursor" ${value('gazeMode') === 'cursor' ? 'selected' : ''}>Cursor</option>
					<option value="head-locked" ${value('gazeMode') === 'head-locked' ? 'selected' : ''}>Head-locked</option>
				</select><div class="muted">Requires a gaze-capable device profile.</div>`,
      )}
			${row(
        'gazeCommitHand',
        'Gaze Commit Hand',
        `<select id="gazeCommitHand">
					<option value="left" ${value('gazeCommitHand') === 'left' ? 'selected' : ''}>Left</option>
					<option value="right" ${value('gazeCommitHand') === 'right' ? 'selected' : ''}>Right</option>
				</select>`,
      )}
		${row(
      'stereoEnabled',
      'Stereo Rendering',
      `<label><input id="stereoEnabled" type="checkbox" ${value('stereoEnabled') ? 'checked' : ''}/> Enabled</label>`,
    )}
		${row(
      'ipd',
      'IPD',
      `<input id="ipd" type="range" min="0.04" max="0.08" step="0.001" value="${value('ipd')}"/><div class="muted">${value(
        'ipd',
      ).toFixed(3)} m</div>`,
    )}
		${row(
      'fovy',
      'FOV-Y',
      `<input id="fovy" type="range" min="${Math.PI / 6}" max="${Math.PI / 1.5}" step="${Math.PI / 48}" value="${value(
        'fovy',
      )}"/><div class="muted">${Math.round((value('fovy') / Math.PI) * 180)} deg</div>`,
    )}
		${row(
      'visibilityMaskEnabled',
      'FOV Mask',
      `<label class="${visibilityMaskSupported ? '' : 'disabled-control'}" title="${
        visibilityMaskSupported
          ? 'Toggle the selected device profile mask'
          : 'Unavailable for this device profile'
      }"><input id="visibilityMaskEnabled" type="checkbox" ${
        visibilityMaskSupported && value('visibilityMaskEnabled')
          ? 'checked'
          : ''
      } ${visibilityMaskSupported ? '' : 'disabled'}/> Enabled</label>`,
      visibilityMaskSupported
        ? ''
        : '<div class="muted">Unavailable for this device profile</div>',
    )}
		${row(
      'defaultPose',
      'Default Pose',
      value('defaultPose')
        ? '<span>Saved</span> <button data-reset="defaultPose">Clear</button>'
        : '<span class="muted">Not saved. Use the save button in the overlay.</span>',
    )}
		<div class="actions">
			<button class="primary" id="reload">Reload page to apply</button>
			<button id="copyOriginDefaults" ${scope === 'origin' ? '' : 'hidden'}>Use these as all-sites defaults</button>
			<button id="clearOrigin" ${scope === 'origin' ? '' : 'hidden'}>Reset this site</button>
			<button id="clearGlobal">Reset all-sites defaults</button>
			<button id="clearAll">Clear ALL emulator settings</button>
			<span class="muted">Extension v${h(status?.version ?? '')}</span>
		</div>
	</section>`;
}

function introHtml(): string {
  const showBanner = prefs?.blob.ui?.seenWhatsNew !== true;
  return `<section>
		<h1>Immersive Web Emulator</h1>
		<div class="pin-hint" role="note">
			<strong>Pin IWE to your toolbar.</strong>
			<div>Use the toolbar button to enable or disable WebXR emulation for the current site, open page-level controls, and connect AI agents. If you do not see it, open Chrome's Extensions menu and pin Immersive Web Emulator.</div>
		</div>
		<p>This panel is for persistent defaults that survive reloads: device, environment, input mode, gaze mode and commit hand, stereo rendering, IPD, FOV-Y, FOV mask, and saved default pose.</p>
		<div class="banner" id="movedBanner" role="status" ${showBanner ? '' : 'hidden'}>
			<strong>Where are the live controls?</strong>
			<div>The headset, controller, hand, and button-mapping controls are now in the floating overlay on the WebXR page itself. Coming from the old DevTools WebXR tab? Those live controls moved onto the page; this panel now focuses on persistent defaults like device, environment, IPD, and FOV-Y.</div>
			<div class="actions"><button id="ackMoved">Got it</button></div>
		</div>
	</section>`;
}

function enableGuideHtml(): string {
  return `<div class="enable-guide">
		<h3>Pin the toolbar button</h3>
		<p class="muted">IWE 2.0 is activated per site. Pin the toolbar button once, then use it whenever you need to turn emulation on for the current page.</p>
		<div class="guide-media" aria-label="Toolbar pin and activation guide">
			<img class="guide-gif" src="../icons/pin-toolbar-guide.gif" alt="Animated guide showing IWE being pinned to the Chrome toolbar, enabled for the current WebXR page, and opened from the toolbar menu." />
			<ol class="guide-points">
				<li><strong>Pin IWE</strong> from Chrome's Extensions menu.</li>
				<li><strong>Click the pinned button</strong> to turn blue inactive into green enabled.</li>
				<li><strong>Open the toolbar menu</strong> to stop emulation, reopen page controls, or connect AI agents.</li>
			</ol>
		</div>
		<p class="muted">After enabling the site, the page reloads and the live headset, controller, hand, and button-mapping controls appear in the page overlay.</p>
	</div>`;
}

function emptyHtml(): string {
  const isHttp = /^https?:/.test(currentUrl);
  return `<section>
		<h2>Current Tab</h2>
		<p class="muted">${h(currentUrl || 'No inspected URL')}</p>
		<p>${isHttp ? 'Emulation is off for this site. Use the toolbar button to enable it.' : 'IWE can run on http(s) WebXR pages. This tab cannot be emulated.'}</p>
		${isHttp ? enableGuideHtml() : ''}
	</section>`;
}

function render(): void {
  const supportsSettings =
    /^https?:/.test(currentUrl) && status?.emulationEnabled;
  app.innerHTML = `${introHtml()}${supportsSettings ? settingsHtml() : emptyHtml()}`;
  bind();
}

function bindRange(
  id: 'ipd' | 'fovy',
  labelText: (value: number) => string,
): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener('input', () => {
    const label = input.nextElementSibling;
    if (label instanceof HTMLElement) {
      label.textContent = labelText(Number(input.value));
    }
  });
  input.addEventListener('change', () => {
    void writePatch({ [id]: Number(input.value) } as Partial<OriginPrefs>);
  });
}

function bind(): void {
  document.getElementById('ackMoved')?.addEventListener('click', () => {
    void send({
      type: MSG.PREFS_WRITE,
      scope: 'ui',
      patch: { seenWhatsNew: true },
    });
    void send({ type: MSG.CLEAR_NEW_BADGE });
    const banner = document.getElementById('movedBanner');
    if (banner) banner.hidden = true;
  });
  for (const button of app.querySelectorAll<HTMLButtonElement>(
    '[data-scope]',
  )) {
    button.addEventListener('click', () => {
      scope = button.dataset.scope === 'global' ? 'global' : 'origin';
      void loadState();
    });
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>(
    '[data-reset]',
  )) {
    button.addEventListener('click', () => {
      void resetKey(button.dataset.reset as keyof OriginPrefs);
    });
  }
  document.getElementById('device')?.addEventListener('change', (event) => {
    void writePatch({
      device: (event.target as HTMLSelectElement).value as DeviceId,
    });
  });
  document
    .getElementById('environment')
    ?.addEventListener('change', (event) => {
      void writePatch({
        environment: (event.target as HTMLSelectElement).value as EnvironmentId,
      });
    });
  document.getElementById('inputMode')?.addEventListener('change', (event) => {
    void writePatch({
      inputMode: (event.target as HTMLSelectElement).value as InputMode,
    });
  });
  document.getElementById('gazeMode')?.addEventListener('change', (event) => {
    void writePatch({
      gazeMode: (event.target as HTMLSelectElement)
        .value as OriginPrefs['gazeMode'],
    });
  });
  document
    .getElementById('gazeCommitHand')
    ?.addEventListener('change', (event) => {
      void writePatch({
        gazeCommitHand: (event.target as HTMLSelectElement)
          .value as OriginPrefs['gazeCommitHand'],
      });
    });
  document
    .getElementById('stereoEnabled')
    ?.addEventListener('change', (event) => {
      void writePatch({
        stereoEnabled: (event.target as HTMLInputElement).checked,
      });
    });
  bindRange('ipd', (value) => `${value.toFixed(3)} m`);
  bindRange('fovy', (value) => `${Math.round((value / Math.PI) * 180)} deg`);
  document
    .getElementById('visibilityMaskEnabled')
    ?.addEventListener('change', (event) => {
      void writePatch({
        visibilityMaskEnabled: (event.target as HTMLInputElement).checked,
      });
    });
  document.getElementById('reload')?.addEventListener('click', () => {
    void reloadInspectedTab();
  });
  document.getElementById('clearOrigin')?.addEventListener('click', () => {
    void clear('origin');
  });
  document.getElementById('clearGlobal')?.addEventListener('click', () => {
    void clear('global');
  });
  document.getElementById('clearAll')?.addEventListener('click', () => {
    void clear('all');
  });
  document
    .getElementById('copyOriginDefaults')
    ?.addEventListener('click', () => {
      if (!prefs) return;
      void send({
        type: MSG.PREFS_WRITE,
        scope: 'global',
        patch: resolveAll(prefs.blob, status?.domain),
      }).then(() => {
        dirty = true;
        void loadState();
      });
    });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  const settingsChanged = Boolean(changes[STORAGE_KEY]);
  const enabledDomainsChanged = Boolean(changes[ENABLED_DOMAINS_KEY]);
  if (areaName !== 'local' || (!settingsChanged && !enabledDomainsChanged)) {
    return;
  }
  if (settingsChanged && !enabledDomainsChanged && suppressStorageRefresh) {
    return;
  }
  if (enabledDomainsChanged) dirty = false;
  void loadState();
});

chrome.devtools?.network?.onNavigated?.addListener(() => {
  dirty = false;
  void loadState();
});

void loadState();
