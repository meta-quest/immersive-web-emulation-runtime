/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// JS mirror of the native origin allowlist (runtime/net/src/url.cc, NET-5). The native check is the
// gate; this copy lets fetch/WebSocket fail fast and log the one-line hint per blocked origin.

export interface AllowEntry {
  scheme: string;
  host: string;
  wildcard: boolean;
  port: number;
}

const DEFAULT_PORT: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
};

export function parseAllowlist(entries: readonly string[]): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const raw of entries) {
    let s = String(raw).trim().toLowerCase().replace(/\/+$/, '');
    const m = /^(https?):\/\/(\*\.)?([^/?#@]+)$/.exec(s);
    if (!m) continue;
    const wildcard = !!m[2];
    s = `${m[1]}://${m[3]}`;
    let u: URL;
    try {
      u = new URL(s + '/');
    } catch {
      continue;
    }
    if (wildcard && (!u.hostname.includes('.') || u.hostname.startsWith('[')))
      continue;
    out.push({
      scheme: m[1],
      host: u.hostname,
      wildcard,
      port: u.port ? Number(u.port) : DEFAULT_PORT[u.protocol],
    });
  }
  return out;
}

export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export type Verdict = 'allowed' | 'not-listed' | 'cleartext';

export function checkOrigin(
  list: readonly AllowEntry[],
  url: URL,
  debug: boolean,
): Verdict {
  const scheme =
    url.protocol === 'ws:'
      ? 'http'
      : url.protocol === 'wss:'
        ? 'https'
        : url.protocol.slice(0, -1);
  if (scheme === 'http' && !(debug && isLoopbackHost(url.hostname)))
    return 'cleartext';
  const port = url.port ? Number(url.port) : DEFAULT_PORT[url.protocol];
  for (const e of list) {
    if (e.scheme !== scheme || e.port !== port) continue;
    if (
      !e.wildcard
        ? url.hostname === e.host
        : url.hostname.endsWith('.' + e.host)
    )
      return 'allowed';
  }
  return 'not-listed';
}

/** "https://host[:port]" (ws/wss reported as their HTTP origin). */
export function httpOrigin(url: URL): string {
  const proto =
    url.protocol === 'ws:'
      ? 'http:'
      : url.protocol === 'wss:'
        ? 'https:'
        : url.protocol;
  const port =
    url.port && Number(url.port) !== DEFAULT_PORT[proto] ? ':' + url.port : '';
  return `${proto}//${url.hostname}${port}`;
}

/** Logs one line per blocked origin per session (NET-5). */
export class BlockedOriginLog {
  #seen = new Set<string>();
  readonly warn: (m: string) => void;
  constructor(warn: (m: string) => void) {
    this.warn = warn;
  }
  report(url: URL, verdict: Verdict): void {
    const origin = httpOrigin(url);
    if (this.#seen.has(origin)) return;
    this.#seen.add(origin);
    if (verdict === 'cleartext') {
      this.warn(
        `[iwer-native] network: blocked ${origin}: cleartext http/ws is allowed only to loopback hosts in debug builds; use https`,
      );
    } else {
      this.warn(
        `[iwer-native] network: blocked ${origin}: add "${origin}" to native.network.allow in iwsdk.config.json`,
      );
    }
  }
  get blocked(): string[] {
    return [...this.#seen];
  }
}
