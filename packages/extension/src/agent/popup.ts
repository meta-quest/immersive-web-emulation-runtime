/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Toolbar popup. The action only opens this popup once emulation is ON for the
 * tab (a click on a non-emulated tab enables emulation in one step via the
 * service worker's onClicked handler). So this is the "now what?" surface: stop
 * emulating, see whether an agent is connected/controlling this tab, and copy
 * the MCP config snippet. There is no pairing — control is granted per tab by
 * the in-page Allow prompt.
 */

import { MSG } from './protocol.js';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

interface StatusReply {
  emulationEnabled: boolean;
  connected: boolean;
  agentTabId: number | null;
  domain: string | null;
}

let activeTab: chrome.tabs.Tab | null = null;

function showError(message: string): void {
  const err = $('err');
  err.textContent = message;
  err.hidden = !message;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function refresh(): Promise<void> {
  showError('');
  activeTab = await getActiveTab();
  const url = activeTab?.url ?? '';
  $('tab').textContent = url || 'No active tab';

  const status = (await chrome.runtime.sendMessage({
    type: MSG.STATUS,
    url,
  })) as StatusReply;

  const dot = $('dot');
  const agentState = $('agentState');
  if (!status.connected) {
    dot.classList.remove('on');
    agentState.textContent = 'Bridge not connected';
  } else if (status.agentTabId != null && status.agentTabId === activeTab?.id) {
    dot.classList.add('on');
    agentState.textContent = 'Agent controlling this tab';
  } else if (status.agentTabId != null) {
    dot.classList.remove('on');
    agentState.textContent = 'Bridge connected (controlling another tab)';
  } else {
    dot.classList.add('on');
    agentState.textContent = 'Bridge connected — awaiting first request';
  }
}

async function onStop(): Promise<void> {
  if (!activeTab?.id || !activeTab.url) return;
  const res = (await chrome.runtime.sendMessage({
    type: MSG.TOGGLE_EMULATION,
    enable: false,
    url: activeTab.url,
    tabId: activeTab.id,
  })) as { ok: boolean; error?: string };
  if (!res?.ok) {
    showError(res?.error ?? 'Could not stop emulation on this page.');
    return;
  }
  // The tab reloads; close the popup so the user sees the result.
  window.close();
}

const COPY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';

async function onCopy(): Promise<void> {
  try {
    await navigator.clipboard.writeText($('snippet').textContent ?? '');
    const btn = $('copyBtn');
    btn.classList.add('copied');
    btn.innerHTML = CHECK_SVG;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = COPY_SVG;
    }, 1200);
  } catch {
    showError('Could not copy — select the config text manually.');
  }
}

$('stopBtn').addEventListener('click', () => void onStop());
$('copyBtn').addEventListener('click', () => void onCopy());

void refresh();
