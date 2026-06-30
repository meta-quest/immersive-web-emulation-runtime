/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Service worker: per-domain emulation registration PLUS the agent-control
 * router. When emulation is enabled it spawns the offscreen WS client (which
 * auto-connects to the local daemon on a fixed loopback port); the first agent
 * request to a tab raises a per-tab consent prompt; once allowed, requests are
 * routed between the offscreen document and the consented tab's content script.
 * It holds no long-lived socket itself (it is a thin router).
 */

import {
  type AgentRequest,
  type AgentResponse,
  BROWSER_HOST_METHODS,
  MSG,
} from './agent/protocol.js';
import {
  ENABLED_DOMAINS_KEY,
  STORAGE_KEY,
  WELCOME_FLAG,
  WHATS_NEW_FLAG,
  mergePrefs,
  normalizePrefsBlob,
  resolveAll,
  shouldShowMovedNotice,
  type OriginPrefs,
  type PrefsPatch,
  type PrefsScope,
} from './agent/prefs.js';
import { extractDomain, matchesForDomain } from './agent/domain.js';

const getScriptId = (domain: string) => `iwe-injection-${domain}`;
const getSeederScriptId = (domain: string) => `iwe-prefs-seeder-${domain}`;
const getBridgeScriptId = (domain: string) => `iwe-bridge-${domain}`;

/**
 * The single agent-controlled tab, designated by the user's Allow gesture. Lives
 * in chrome.storage.session: survives SW eviction, clears on browser restart
 * (so consent lasts exactly the browser session).
 */
interface AgentTab {
  tabId: number;
  domain: string;
}

// Last tab identity seen on a device response, used to stamp browser-host
// (screenshot) responses so the daemon's tab tracker stays consistent with
// device responses. Resets on SW eviction (then screenshots omit it, which the
// tracker safely ignores rather than emitting a false tab-change warning).
let lastPageTab: { tabId?: string; tabGeneration?: number } = {};

// In-flight requests held while the consent overlay is shown on a candidate
// tab. In-memory only: if the SW is evicted mid-prompt these are dropped, the
// daemon times out, and the agent retries — by which point consent is recorded.
let pendingConsent: {
  tabId: number;
  domain: string;
  requests: AgentRequest[];
} | null = null;

// Serializes read-modify-write of the shared chrome.storage keys (the prefs
// blob, the enabled-domains mirror) so concurrent message handlers — the in-page
// overlay and the DevTools panel writing at once, or two windows toggling
// emulation — can't read the same value and clobber each other's update.
let storageLock: Promise<unknown> = Promise.resolve();
function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storageLock.then(fn, fn);
  storageLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- Emulation registration (per domain) -----------------------------------

async function getEnabledDomains(): Promise<string[]> {
  const stored = await chrome.storage.local.get(ENABLED_DOMAINS_KEY);
  return Array.isArray(stored[ENABLED_DOMAINS_KEY])
    ? stored[ENABLED_DOMAINS_KEY]
    : [];
}

async function setDomainEnabled(
  domain: string,
  enabled: boolean,
): Promise<void> {
  await withStorageLock(async () => {
    const domains = new Set(await getEnabledDomains());
    if (enabled) {
      domains.add(domain);
    } else {
      domains.delete(domain);
    }
    await chrome.storage.local.set({
      [ENABLED_DOMAINS_KEY]: [...domains].sort(),
    });
  });
}

async function unregisterDomainScripts(domain: string) {
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [
        getSeederScriptId(domain),
        getScriptId(domain),
        getBridgeScriptId(domain),
      ],
    });
  } catch {
    /* one or more scripts were not registered */
  }
}

async function registerDomainContentScript(domain: string) {
  const matches = matchesForDomain(domain);
  await unregisterDomainScripts(domain);
  await chrome.scripting.registerContentScripts([
    {
      id: getSeederScriptId(domain),
      matches,
      js: ['build/prefs-seeder.min.js'],
      allFrames: true,
      runAt: 'document_start',
      persistAcrossSessions: false,
    },
    {
      id: getScriptId(domain),
      matches,
      js: ['build/iwe.min.js'],
      allFrames: true,
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: false,
    },
    {
      id: getBridgeScriptId(domain),
      matches,
      js: ['build/content-bridge.min.js'],
      allFrames: true,
      runAt: 'document_start',
      persistAcrossSessions: false,
    },
  ]);
}

async function unregisterDomainContentScript(domain: string) {
  await unregisterDomainScripts(domain);
}

async function hasRegisteredScript(domain: string) {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    return registered.some((s) => s.id === getScriptId(domain));
  } catch (error) {
    console.error('[IWE] Error checking registered scripts:', error);
    return false;
  }
}

function updateIcon(tabId: number, isActive: boolean) {
  const iconPath = isActive ? '../icons/active' : '../icons/default';
  chrome.action.setIcon({
    tabId,
    path: {
      16: `${iconPath}16.png`,
      48: `${iconPath}48.png`,
      128: `${iconPath}128.png`,
    },
  });
}

/**
 * Keep the toolbar icon + click behavior in sync with a tab's emulation state.
 * Emulated → clicking opens the popup. Not emulated → no popup, so a click fires
 * chrome.action.onClicked and enables emulation in a single step.
 */
function setActionForTab(tabId: number, isEmulated: boolean) {
  updateIcon(tabId, isEmulated);
  chrome.action.setPopup({
    tabId,
    popup: isEmulated ? 'build/popup.html' : '',
  });
}

async function setEmulation(enable: boolean, url: string, tabId: number) {
  const domain = extractDomain(url);
  if (!domain)
    return { ok: false, error: 'Could not determine the domain for this tab.' };
  const exists = await hasRegisteredScript(domain);
  if (enable && !exists) {
    try {
      await registerDomainContentScript(domain);
    } catch (error) {
      // e.g. an invalid match pattern — surface it to the popup instead of an
      // unhandled rejection that leaves the toggle hanging.
      return {
        ok: false,
        error: `Could not enable emulation here: ${
          (error as Error)?.message ?? String(error)
        }`,
      };
    }
  } else if (!enable && exists) {
    await unregisterDomainContentScript(domain);
  }
  await setDomainEnabled(domain, enable);
  if (enable) {
    // Spawn the offscreen WS client; it auto-connects to the local daemon.
    await ensureOffscreen();
  } else if ((await getEnabledDomains()).length === 0) {
    // Nothing emulated anymore — drop the bridge.
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* no doc */
    }
    await setConnected(false);
  }
  chrome.tabs.reload(tabId, { bypassCache: true });
  return { ok: true };
}

// --- Connection state ------------------------------------------------------
// Lives in session storage (not a module global) so it survives service-worker
// eviction while the offscreen WebSocket stays open.

async function getConnected(): Promise<boolean> {
  const r = await chrome.storage.session.get('connected');
  return !!r.connected;
}
async function setConnected(connected: boolean): Promise<void> {
  await chrome.storage.session.set({ connected });
}

// --- Consent state (the agent-controlled tab) ------------------------------

async function getAgentTab(): Promise<AgentTab | null> {
  const r = await chrome.storage.session.get('agentTab');
  return (r.agentTab as AgentTab | undefined) ?? null;
}
async function setAgentTab(tabId: number, domain: string): Promise<void> {
  await chrome.storage.session.set({ agentTab: { tabId, domain } });
}
async function clearAgentTab(): Promise<void> {
  await chrome.storage.session.remove('agentTab');
}

// --- Offscreen lifecycle ---------------------------------------------------

async function ensureOffscreen(): Promise<void> {
  const has = (await chrome.offscreen.hasDocument?.()) ?? false;
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'build/offscreen.html',
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification:
      "Maintain a persistent local WebSocket to the developer's coding-agent bridge.",
  });
}

// --- Browser-host tools: screenshot ---------------------------------------
//
// Screenshotting is a *browser* capability, not an IWER device capability
// (mirrors IWSDK, where the managed browser owns it). The SW captures the
// composited tab via chrome.tabs.captureVisibleTab — so it works on any page
// regardless of WebGL preserveDrawingBuffer — then downscales/re-encodes with
// OffscreenCanvas. This never touches the page or device.remote.

interface ScreenshotParams {
  maxWidth?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function encodeImage(
  dataUrl: string,
  params: ScreenshotParams,
): Promise<{
  imageData: string;
  format: string;
  width: number;
  height: number;
}> {
  const format = params.format ?? 'jpeg';
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const maxWidth = params.maxWidth;
  const scale =
    maxWidth && bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const mimeType =
    format === 'png'
      ? 'image/png'
      : format === 'webp'
        ? 'image/webp'
        : 'image/jpeg';
  const outBlob = await canvas.convertToBlob({
    type: mimeType,
    quality: params.quality ?? 0.7,
  });
  return {
    imageData: toBase64(await outBlob.arrayBuffer()),
    format,
    width,
    height,
  };
}

async function captureScreenshot(
  tabId: number,
  req: AgentRequest,
): Promise<AgentResponse> {
  // Stamp the last-known page tab identity so the daemon's tab tracker treats
  // screenshots consistently with device responses.
  const tag = {
    _tabId: lastPageTab.tabId,
    _tabGeneration: lastPageTab.tabGeneration,
  };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      return {
        id: req.id,
        error:
          'The agent-controlled tab is not the active tab in its window; the browser can only screenshot the focused tab. Switch to the tab and retry.',
        ...tag,
      };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    });
    const result = await encodeImage(
      dataUrl,
      (req.params ?? {}) as ScreenshotParams,
    );
    return { id: req.id, result, ...tag };
  } catch (error) {
    return {
      id: req.id,
      error: `captureVisibleTab failed: ${(error as Error)?.message ?? String(error)}`,
      ...tag,
    };
  }
}

// --- Agent request routing + per-tab consent -------------------------------

function respondToDaemon(data: AgentResponse): void {
  chrome.runtime.sendMessage({ type: MSG.AGENT_RESPONSE_TO_DAEMON, data });
}

/** The active tab in the focused window, if it's an emulated http(s) page. */
async function activeEmulatedTab(): Promise<AgentTab | null> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) return null;
  const domain = extractDomain(tab.url);
  if (!domain || !(await hasRegisteredScript(domain))) return null;
  return { tabId: tab.id, domain };
}

type AgentTarget =
  | { tabId: number; domain: string; consented: boolean }
  | { error: string };

/** Resolve which tab an agent request targets + whether it's already consented. */
async function resolveAgentTarget(): Promise<AgentTarget> {
  const agentTab = await getAgentTab();
  if (agentTab) {
    let tab: chrome.tabs.Tab | null = null;
    try {
      tab = await chrome.tabs.get(agentTab.tabId);
    } catch {
      // The consented tab was closed — consent dies with the tab.
      await clearAgentTab();
    }
    if (tab) {
      // Consent lives with the TAB, not the page session: it survives reloads
      // and emulation off->on, and is only dropped when the tab closes (above)
      // or the browser restarts (chrome.storage.session). If emulation is off
      // right now, keep consent and just report it — re-enabling resumes control
      // with no new prompt.
      const domain = tab.url ? extractDomain(tab.url) : null;
      if (domain && (await hasRegisteredScript(domain))) {
        return { tabId: agentTab.tabId, domain, consented: true };
      }
      return {
        error:
          'The agent-controlled tab is open but the Immersive Web Emulator is off on it. Click the IWE toolbar icon on that tab to re-enable, then retry.',
      };
    }
  }
  const candidate = await activeEmulatedTab();
  return candidate
    ? { ...candidate, consented: false }
    : {
        error:
          'No Immersive Web Emulator is ready. Open a WebXR page, enable IWE on it (toolbar icon), make it the active tab, then retry.',
      };
}

/** Forward a consented request to the tab (device tool) or service it (screenshot). */
async function forwardToTab(tabId: number, req: AgentRequest): Promise<void> {
  if (BROWSER_HOST_METHODS.has(req.method)) {
    respondToDaemon(await captureScreenshot(tabId, req));
    return;
  }
  chrome.tabs
    .sendMessage(tabId, { type: MSG.AGENT_REQUEST_TO_PAGE, data: req })
    .catch(() =>
      respondToDaemon({
        id: req.id,
        error:
          'The agent-controlled tab is unavailable (closed or navigated away). Re-open the WebXR page and Allow again.',
      }),
    );
}

function flushPendingConsent(
  allowed: boolean,
  denyMessage = 'Agent control was denied for this tab.',
): void {
  const pending = pendingConsent;
  pendingConsent = null;
  if (!pending) return;
  if (allowed) {
    for (const req of pending.requests) void forwardToTab(pending.tabId, req);
  } else {
    for (const req of pending.requests)
      respondToDaemon({ id: req.id, error: denyMessage });
  }
}

// --- Preferences -----------------------------------------------------------

async function readPrefsBlob() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizePrefsBlob(stored[STORAGE_KEY]);
}

async function writePrefsBlob(blob: ReturnType<typeof normalizePrefsBlob>) {
  await chrome.storage.local.set({ [STORAGE_KEY]: blob });
}

async function prefsRead(domain: string | null) {
  const blob = await readPrefsBlob();
  return {
    blob,
    resolved: domain ? resolveAll(blob, domain) : resolveAll(blob, null),
  };
}

async function prefsWrite(
  message: {
    scope?: PrefsScope;
    domain?: string | null;
    patch?: PrefsPatch;
    resetKey?: keyof OriginPrefs;
    clear?: 'origin' | 'global' | 'all';
    reload?: boolean;
    tabId?: number;
  },
  sender: chrome.runtime.MessageSender,
) {
  // A write from a content script (sender.tab set) is page-originated and must
  // be confined to its OWN origin: clamp the scope to 'origin', derive the
  // domain from the trusted sender URL (ignore any page-supplied domain), and
  // drop privileged operations (global writes, clear/reset, cross-tab reload).
  // Otherwise a hostile page could poison the global/all-sites prefs layer.
  const fromPage = sender.tab != null;
  const domain = fromPage
    ? sender.tab?.url
      ? extractDomain(sender.tab.url)
      : null
    : (message.domain ?? null);
  const scope: PrefsScope = fromPage ? 'origin' : (message.scope ?? 'origin');
  const resetKey = fromPage ? undefined : message.resetKey;
  const clear = fromPage ? undefined : message.clear;
  const reload = fromPage ? false : message.reload;
  const tabId = fromPage ? undefined : message.tabId;

  const next = await withStorageLock(async () => {
    const blob = await readPrefsBlob();
    const merged = mergePrefs(blob, scope, domain, message.patch ?? {}, {
      resetKey,
      clear,
    });
    await writePrefsBlob(merged);
    return merged;
  });
  if (reload && tabId != null) {
    await chrome.tabs.reload(tabId, { bypassCache: true });
  }
  return {
    ok: true,
    blob: next,
    resolved: domain ? resolveAll(next, domain) : resolveAll(next, null),
  };
}

// --- Message routing -------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = (message as { type?: string })?.type;
  switch (type) {
    case MSG.STATUS: {
      (async () => {
        const url = (message as { url?: string }).url ?? '';
        const domain = url ? extractDomain(url) : null;
        const agentTab = await getAgentTab();
        sendResponse({
          emulationEnabled: domain ? await hasRegisteredScript(domain) : false,
          connected: await getConnected(),
          agentTabId: agentTab?.tabId ?? null,
          domain,
          version: chrome.runtime.getManifest().version,
        });
      })();
      return true; // async response
    }
    case MSG.PREFS_READ: {
      (async () => {
        const domain =
          (message as { domain?: string | null }).domain ??
          ((message as { url?: string }).url
            ? extractDomain((message as { url: string }).url)
            : null);
        sendResponse(await prefsRead(domain));
      })();
      return true;
    }
    case MSG.PREFS_WRITE: {
      (async () => {
        sendResponse(await prefsWrite(message as never, sender));
      })();
      return true;
    }
    case MSG.CLEAR_NEW_BADGE: {
      void chrome.action.setBadgeText({ text: '' });
      return false;
    }
    case MSG.TOGGLE_EMULATION: {
      const { enable, url, tabId } = message as {
        enable: boolean;
        url: string;
        tabId: number;
      };
      (async () => sendResponse(await setEmulation(enable, url, tabId)))();
      return true;
    }
    case MSG.CONSENT_RESULT: {
      // The user clicked Allow/Deny in the in-page consent overlay.
      (async () => {
        const tabId = sender.tab?.id;
        const allowed = !!(message as { allowed?: boolean }).allowed;
        if (tabId == null) return;
        if (allowed) {
          const domain = sender.tab?.url
            ? (extractDomain(sender.tab.url) ?? '')
            : '';
          await setAgentTab(tabId, domain);
        }
        if (pendingConsent?.tabId === tabId) flushPendingConsent(allowed);
      })();
      return false;
    }
    case MSG.OFFSCREEN_STATUS: {
      void setConnected(!!(message as { connected?: boolean }).connected);
      return false;
    }
    case MSG.AGENT_REQUEST_FROM_DAEMON: {
      // offscreen -> SW -> (consent gate) -> screenshot | consented tab
      (async () => {
        const req = (message as { data: AgentRequest }).data;
        const target = await resolveAgentTarget();
        if ('error' in target) {
          respondToDaemon({ id: req.id, error: target.error });
          return;
        }
        if (target.consented) {
          await forwardToTab(target.tabId, req);
          return;
        }
        // Not yet consented: hold the request and show the overlay once.
        if (pendingConsent?.tabId === target.tabId) {
          pendingConsent.requests.push(req);
          return;
        }
        pendingConsent = {
          tabId: target.tabId,
          domain: target.domain,
          requests: [req],
        };
        chrome.tabs
          .sendMessage(target.tabId, { type: MSG.REQUEST_CONSENT })
          .catch(() =>
            flushPendingConsent(
              false,
              'Could not show the consent prompt on the page. Reload the WebXR tab and retry.',
            ),
          );
      })();
      return false;
    }
    case MSG.AGENT_RESPONSE_FROM_PAGE: {
      // content script -> SW -> offscreen -> daemon
      (async () => {
        const data = (message as { data: AgentResponse }).data;
        const agentTab = await getAgentTab();
        // Only accept responses from the consented agent tab. The content bridge
        // is registered domain-wide, so another same-domain tab could otherwise
        // forge a response (request ids are guessable) and spoof/race results.
        if (!agentTab || sender.tab?.id !== agentTab.tabId) return;
        if (data?._tabId) {
          lastPageTab = {
            tabId: data._tabId,
            tabGeneration: data._tabGeneration,
          };
        }
        respondToDaemon(data);
      })();
      return false;
    }
    default:
      return false;
  }
});

// --- Icon + click upkeep ----------------------------------------------------

async function handleTabUpdate(tabId: number, urlString: string | undefined) {
  if (!urlString) return;
  const domain = extractDomain(urlString);
  setActionForTab(
    tabId,
    domain ? await hasRegisteredScript(domain) : false,
  );
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await handleTabUpdate(tabId, tab.url);
  } catch (error) {
    console.error(
      `[IWE] Error handling tab activation for tabId ${tabId}:`,
      error,
    );
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status) await handleTabUpdate(tabId, tab.url);
});

// One-click enable: the action has no popup on non-emulated tabs, so a click
// lands here. Enable emulation (the tab reloads; handleTabUpdate then switches
// the action to open the popup on later clicks). No-op on non-http pages.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return;
  void setEmulation(true, tab.url, tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const agentTab = await getAgentTab();
    if (agentTab?.tabId === tabId) await clearAgentTab();
    if (pendingConsent?.tabId === tabId) pendingConsent = null;
  })();
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    const domains = await getEnabledDomains();
    for (const domain of domains) {
      try {
        await registerDomainContentScript(domain);
      } catch (error) {
        // One bad domain (e.g. a stale/invalid stored entry) must not starve
        // re-registration of the rest of the previously-enabled domains.
        console.error(
          '[IWE] Failed to re-register content script for',
          domain,
          error,
        );
      }
    }
    if (domains.length > 0) await ensureOffscreen();
  })();
});

function setNewBadge(): void {
  chrome.action.setBadgeText({ text: 'NEW' });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    const manifest = chrome.runtime.getManifest();
    const current = manifest.version;
    const stored = await chrome.storage.local.get([
      WHATS_NEW_FLAG,
      WELCOME_FLAG,
    ]);
    if (details.reason === 'install') {
      if (stored[WELCOME_FLAG] !== true) {
        await chrome.storage.local.set({ [WELCOME_FLAG]: true });
        setNewBadge();
        await chrome.tabs.create({
          url: chrome.runtime.getURL('build/whats-new.html?mode=welcome'),
        });
      }
      return;
    }
    if (
      details.reason === 'update' &&
      shouldShowMovedNotice(
        details.previousVersion,
        current,
        stored[WHATS_NEW_FLAG] === true,
      )
    ) {
      await chrome.storage.local.set({ [WHATS_NEW_FLAG]: true });
      setNewBadge();
      await chrome.tabs.create({
        url: chrome.runtime.getURL(
          `build/whats-new.html?from=${encodeURIComponent(
            details.previousVersion ?? '',
          )}&to=${encodeURIComponent(current)}`,
        ),
      });
    }
  })();
});
