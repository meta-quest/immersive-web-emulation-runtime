/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import catalog from './tool-catalog.generated.json';
import {
  DEFAULTS,
  DEVICE_CATALOG,
  ENVIRONMENT_CATALOG,
  STORAGE_KEY,
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
}

const MCP_CONFIG_SNIPPET = `{
  "mcpServers": {
    "iwer": {
      "command": "npx",
      "args": ["-y", "@iwer/extension-bridge"]
    }
  }
}`;

const COPY_CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';

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

function inspectedUrl(): Promise<string> {
  return new Promise((resolve) => {
    if (!chrome.devtools?.inspectedWindow) {
      resolve(window.location.href);
      return;
    }
    chrome.devtools.inspectedWindow.eval(
      'location.href',
      (result: unknown, exceptionInfo?: { isException?: boolean }) => {
        resolve(exceptionInfo?.isException ? '' : String(result ?? ''));
      },
    );
  });
}

function tabId(): number | null {
  return chrome.devtools?.inspectedWindow?.tabId ?? null;
}

async function loadState(): Promise<void> {
  currentUrl = await inspectedUrl();
  status = await send<StatusReply>({ type: MSG.STATUS, url: currentUrl });
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
  const currentKeymap = JSON.stringify(value('keymap'), null, 2);
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
      'keymap',
      'Key Bindings',
      `<pre>${h(currentKeymap)}</pre><div class="muted">Edit bindings in the page overlay. They persist here when changed.</div>`,
    )}
		${row(
      'defaultPose',
      'Default Pose',
      value('defaultPose')
        ? '<span>Saved</span> <button data-reset="defaultPose">Clear</button>'
        : '<span class="muted">Not saved. Use the save button in the overlay.</span>',
    )}
		<div class="row">
			<div><div class="label">Coming Soon</div><div class="badge">Stored shape reserved</div></div>
			<div class="muted">Trigger mode, joystick sticky, and room dimensions are reserved for future engine support.</div>
			<div></div>
		</div>
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
		<h1>WebXR</h1>
		<p>The headset, controller, and hand controls appear as a floating overlay on emulated WebXR pages. This panel is for defaults that survive reloads: device, environment, input mode, key bindings, and AI-agent setup.</p>
		<div class="banner" id="movedBanner" role="status" ${showBanner ? '' : 'hidden'}>
			<strong>Where are the live controls?</strong>
			<div>The headset, controller, and hand controls are now a floating overlay on the WebXR page itself. This panel is for defaults that survive reloads: device, environment, input mode, key bindings, and AI-agent setup. Settings reset in 2.0; set them once here and they persist.</div>
			<div class="actions"><button id="ackMoved">Got it</button></div>
		</div>
		<details>
			<summary>Coming from the old version?</summary>
			<p>Older IWE builds put live controls in a DevTools tab named "WebXR". Those controls moved into the page overlay. The DevTools panel now edits persistent defaults.</p>
		</details>
	</section>`;
}

function agentHtml(): string {
  const tools = catalog.tools
    .map(
      (tool) =>
        `<div class="tool"><code>${h(tool.name)}</code><span>${tool.readOnly ? 'read-only' : 'mutates'}</span><span>${h(tool.description)}</span></div>`,
    )
    .join('');
  return `<section>
		<h2>AI Agent Setup</h2>
		<p>Drive this WebXR page from Claude Code, Cursor, Codex, Copilot, Windsurf, or any MCP client.</p>
		<h3>1. Add the MCP server</h3>
		<p class="muted">Paste this into your agent's MCP config, then restart it:</p>
		<div class="codeblock"><button id="copySnippet" class="copy-icon" title="Copy config" aria-label="Copy config"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button><pre id="mcpSnippet">${h(MCP_CONFIG_SNIPPET)}</pre></div>
				<p class="muted">Codex uses TOML — adapt the command/args accordingly. Consult your agent's MCP docs for where the config lives.</p>
		<h3>2. Connect this tab</h3>
		<p>Enable IWE on this page, then ask your agent to act on it. The first time it does, an <strong>Allow</strong> prompt appears on the page — approve it to let the agent control this tab.</p>
		<p>Status: ${
      status?.connected ? 'Bridge connected' : 'Bridge not connected'
    }</p>
		<h3>Try it</h3>
		<pre>Get the XR session status, enter XR, look at {x:0,y:1,z:-1}, select with the right controller, then screenshot what you see.</pre>
		<details>
			<summary>Tools for @iwer/extension-bridge v${h(catalog.mcpVersion)}</summary>
			${tools}
		</details>
	</section>`;
}

function emptyHtml(): string {
  return `<section>
		<h2>Current Tab</h2>
		<p class="muted">${h(currentUrl || 'No inspected URL')}</p>
		<p>${/^https?:/.test(currentUrl) ? 'Emulation is off for this site. Use the toolbar icon to enable it, then reload.' : 'IWE can run on http(s) WebXR pages. This tab cannot be emulated.'}</p>
	</section>`;
}

function render(): void {
  const supportsSettings =
    /^https?:/.test(currentUrl) && status?.emulationEnabled;
  app.innerHTML = `${introHtml()}${supportsSettings ? settingsHtml() : emptyHtml()}${agentHtml()}`;
  bind();
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
  document
    .getElementById('stereoEnabled')
    ?.addEventListener('change', (event) => {
      void writePatch({
        stereoEnabled: (event.target as HTMLInputElement).checked,
      });
    });
  document.getElementById('ipd')?.addEventListener('input', (event) => {
    void writePatch({ ipd: Number((event.target as HTMLInputElement).value) });
  });
  document.getElementById('fovy')?.addEventListener('input', (event) => {
    void writePatch({ fovy: Number((event.target as HTMLInputElement).value) });
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
  document.getElementById('copySnippet')?.addEventListener('click', () => {
    void navigator.clipboard
      ?.writeText(MCP_CONFIG_SNIPPET)
      .then(() => {
        const btn = document.getElementById('copySnippet');
        if (!btn) return;
        const prev = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = COPY_CHECK_SVG;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = prev;
        }, 1200);
      })
      .catch(() => {
        /* clipboard unavailable — the snippet is selectable */
      });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY] || suppressStorageRefresh) {
    return;
  }
  void loadState();
});

chrome.devtools?.network?.onNavigated?.addListener(() => {
  dirty = false;
  void loadState();
});

void loadState();
