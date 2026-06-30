/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { parse } from 'tldts';

export function extractDomain(urlString: string): string | null {
  const parsed = parse(urlString);
  return parsed.domain ?? parsed.hostname ?? null;
}

// IPv6 literals must be bracketed inside a URL/match-pattern host.
function bracketIPv6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function matchesForDomain(domain: string): string[] {
  const parsed = parse(
    domain.includes('://') ? domain : `http://${bracketIPv6(domain)}`,
  );
  // IP literals and single-label hosts (e.g. localhost) get NO subdomain
  // wildcard: Chrome rejects a wildcard host on an IP literal (which would make
  // registerContentScripts throw), and there are no subdomains to match anyway.
  if (parsed.isIp || domain === 'localhost' || !domain.includes('.')) {
    const host = bracketIPv6(domain);
    return [`http://${host}/*`, `https://${host}/*`];
  }
  return [
    `http://${domain}/*`,
    `https://${domain}/*`,
    `http://*.${domain}/*`,
    `https://*.${domain}/*`,
  ];
}
